import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SCENES, preloadScene } from '../scenes'
import { FILL_REFERENCE_MP } from '../engine/frameLoad'
import {
  BenchRunner,
  buildPlan,
  formatResults,
  formatPostChainDelta,
  postChainDelta,
  type BenchResult,
} from '../bench/benchHarness'
import { BenchStage } from '../bench/BenchStage'

/**
 * Scene cost benchmark — a developer tool, not part of the show.
 *
 * Sweeps every registered scene across every quality tier, in isolation, and
 * reports GPU milliseconds per frame. That is the table `performanceCost`
 * should have been set from: today `juliawings`, `torusfold`, `foldpath`,
 * `synthgrid` and `plasma` all carry `high` and are certainly not within 4x of
 * each other, so slotBudget.ts has been allocating against a number assigned by
 * eye.
 *
 * Three columns, and the pairing is the point:
 *
 *   GPU  what the draw actually cost on the card.
 *   JS   time inside the scene's own per-frame callback.
 *   CPU  whole-frame wall clock. Vsync-locked, so a scene that keeps up reads
 *        ~16.7 ms whatever it cost — useful only as "did it keep up".
 *
 * A high CPU with a LOW JS is a scene waiting on the GPU. A high CPU with a
 * HIGH JS is a scene doing too much on the main thread. Reading CPU alone as
 * the second is how F87 concluded `ribbons` burned 68 ms of JavaScript per
 * frame — a scene that builds its geometry once and loops ~1,300 times.
 */

/**
 * Tiers swept, and the one-tier escape hatch.
 *
 * `?profile` sweeps tier 0 only. The role profile is about what a scene LOOKS
 * like, and five tiers of that is four fifths waste — the cost table is what
 * needs the whole ladder. It also makes the sweep short enough to drive from a
 * test harness on software GL, which is what validating the profiler against
 * the roster's hand-made role calls requires.
 */
const PROFILE_ONLY =
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('profile')
const TIERS = PROFILE_ONLY ? [0] : [0, 1, 2, 3, 4]

/**
 * Is this the post-chain pass (F156)? Mirrors BenchStage's own flag.
 *
 * Sweeps the same plan as the cost pass — same scenes, same five tiers, same
 * frame counts — because the two are only subtractable if they are the same
 * measurement twice.
 */
const POSTCHAIN_PASS =
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('postchain')

/**
 * Where a finished sweep is parked so the other pass can find it.
 *
 * The post-chain number is a difference between two runs, and two runs cannot
 * be in flight at once — the chain is either mounted for the whole page or it
 * is not. So the first pass has to survive a reload. localStorage rather than
 * asking the operator to paste JSON back in: the failure mode of a manual
 * round-trip is pasting the wrong pass, and nothing downstream could detect it.
 */
const RUN_STORE_KEY = (pass: string) => `audiovis:bench:${pass}`

function saveRun(pass: string, results: readonly BenchResult[]): void {
  try {
    localStorage.setItem(RUN_STORE_KEY(pass), JSON.stringify(results))
  } catch {
    // Private mode, quota, or storage disabled. The sweep still ran and both
    // copy buttons still work; only the automatic diff is lost.
  }
}

function loadRun(pass: string): BenchResult[] | null {
  try {
    const raw = localStorage.getItem(RUN_STORE_KEY(pass))
    return raw ? (JSON.parse(raw) as BenchResult[]) : null
  } catch {
    return null
  }
}


/**
 * The profile pass needs a longer warmup than the cost pass, for a reason the
 * cost pass does not have.
 *
 * It mounts the post chain, which means the adaptive exposure servo is running
 * — and the servo samples every 0.18 s with a ~2.3 s time constant. Profiling
 * before it settles measures a gain that is still travelling, so the same scene
 * would profile differently depending on what the PREVIOUS cell left the servo
 * holding. 240 frames is ~4 s at 60 Hz, comfortably past settling.
 *
 * Fewer measured frames to pay for it: the profile is a whole-field average
 * over a static camera, which converges far faster than a p95 frame time does.
 */
const PROFILE_OPTIONS = { warmupFrames: 240, measureFrames: 60, drainFrames: 0 }

/** Roughly how long a full sweep takes, for the pre-run warning. */
// Profile cells warm up for 240 frames rather than 60, so they take longer
// despite measuring fewer.
const SECONDS_PER_CELL = PROFILE_ONLY ? 5.5 : 3.3

export function Bench() {
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState<BenchResult[]>([])
  const [progress, setProgress] = useState(0)
  const [label, setLabel] = useState('')
  const [copied, setCopied] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  const runnerRef = useRef<BenchRunner | null>(null)

  const plan = useMemo(
    () =>
      buildPlan(
        SCENES.map((s) => s.id),
        TIERS,
      ),
    [],
  )

  // Every chunk fetched up front. A cold dynamic import mid-run would land
  // inside a cell's warmup and push the compile into its measured frames.
  useEffect(() => {
    for (const s of SCENES) preloadScene(s.id)
  }, [])

  const start = useCallback(() => {
    const runner = new BenchRunner(plan, PROFILE_ONLY ? PROFILE_OPTIONS : undefined)
    runnerRef.current = runner
    setResults([])
    setProgress(0)
    setRunning(true)
    setVersion((v) => v + 1)
  }, [plan])

  const stop = useCallback(() => {
    runnerRef.current?.stop()
    setRunning(false)
    if (runnerRef.current) setResults([...runnerRef.current.results])
  }, [])

  // Poll the runner for UI state. Deliberately not driven from useFrame — the
  // benchmark's render loop should not also be paying for React re-renders.
  useEffect(() => {
    if (!running) return
    const id = window.setInterval(() => {
      const r = runnerRef.current
      if (!r) return
      setProgress(r.progress)
      setResults([...r.results])
      const cell = r.current
      setLabel(cell ? `${cell.sceneId} · tier ${cell.tier} · ${r.currentPhase}` : 'done')
      if (r.done) {
        setRunning(false)
        // Park the completed sweep for the other pass to difference against
        // (F156). Only a COMPLETE run: a stopped one has whatever cells it
        // reached, and half a plan silently matching half of another is exactly
        // the confidently-wrong number this is trying to avoid.
        saveRun(POSTCHAIN_PASS ? 'postchain' : PROFILE_ONLY ? 'profile' : 'cost', r.results)
      }
    }, 250)
    return () => window.clearInterval(id)
  }, [running])

  const copy = useCallback((text: string, what: string) => {
    void navigator.clipboard.writeText(text).then(
      () => {
        setCopied(what)
        window.setTimeout(() => setCopied(null), 1500)
      },
      () => setCopied('clipboard blocked'),
    )
  }, [])

  /**
   * The post-chain measurement, if both halves of it exist (F156).
   *
   * Available from either side: finish the cost pass with a stored post-chain
   * run and it appears, and vice versa. The pairing is by (scene, tier) inside
   * `postChainDelta`, which also refuses any pair drawn at different
   * resolutions or missing a GPU number, so a stale stored run cannot quietly
   * contaminate the answer.
   */
  const chainDelta = useMemo(() => {
    if (PROFILE_ONLY || results.length === 0) return null
    const other = loadRun(POSTCHAIN_PASS ? 'cost' : 'postchain')
    if (!other || other.length === 0) return null
    const [off, on] = POSTCHAIN_PASS ? [other, results] : [results, other]
    const d = postChainDelta(off, on)
    return d.cells.length > 0 ? d : null
  }, [results])

  const gpuMissing = results.length > 0 && results.every((r) => r.gpu === null)
  const mins = Math.ceil((plan.length * SECONDS_PER_CELL) / 60)

  return (
    <div className="bench">
      {running && runnerRef.current && (
        <div className="bench-stage">
          <BenchStage runner={runnerRef.current} version={version} />
        </div>
      )}

      <div className="bench-panel">
        <h1>Scene cost benchmark</h1>
        <p className="bench-note">
          {SCENES.length} scenes × {TIERS.length} tiers = {plan.length} cells, about {mins} min.
          Keep this tab focused and in the foreground — a backgrounded tab throttles rAF and
          every number here becomes meaningless.
        </p>

        <div className="bench-controls">
          {running ? (
            <button onClick={stop}>Stop</button>
          ) : (
            <button onClick={start}>Run benchmark</button>
          )}
          <button disabled={results.length === 0} onClick={() => copy(formatResults(results), 'md')}>
            Copy markdown
          </button>
          <button
            disabled={results.length === 0}
            onClick={() => copy(JSON.stringify(results, null, 2), 'json')}
          >
            Copy JSON
          </button>
          {chainDelta && (
            <button onClick={() => copy(formatPostChainDelta(chainDelta, FILL_REFERENCE_MP), 'chain')}>
              Copy post-chain cost ({chainDelta.atReferenceMs(FILL_REFERENCE_MP).toFixed(2)} ms @{' '}
              {FILL_REFERENCE_MP} MP)
            </button>
          )}
          {copied && <span className="bench-copied">{copied === 'md' || copied === 'json' ? 'copied' : copied}</span>}
        </div>

        {running && (
          <div className="bench-progress">
            <div className="bench-bar">
              <div style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
            <span>{label}</span>
          </div>
        )}

        {gpuMissing && (
          <p className="bench-warn">
            No GPU timer on this device (<code>EXT_disjoint_timer_query_webgl2</code> unavailable,
            or every query came back disjoint). The GPU columns are empty and the CPU columns are
            vsync-locked, so these results can only tell you whether a scene kept up — not what it
            cost. Chrome on desktop is the reliable place to run this.
          </p>
        )}

        {results.length > 0 && (
          <div className="bench-scroll">
            <table className="bench-table">
              <thead>
                <tr>
                  <th>scene</th>
                  <th>tier</th>
                  <th className="num">GPU mean</th>
                  <th className="num">GPU p95</th>
                  <th className="num">GPU max</th>
                  <th className="num">JS mean</th>
                  <th className="num">JS p95</th>
                  <th className="num">CPU mean</th>
                  <th className="num">CPU p95</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r) => (
                  <tr key={`${r.sceneId}-${r.tier}`}>
                    <td>{r.sceneId}</td>
                    <td className="num">{r.tier}</td>
                    <td className="num">{r.gpu ? r.gpu.meanMs.toFixed(2) : '—'}</td>
                    <td className="num">{r.gpu ? r.gpu.p95Ms.toFixed(2) : '—'}</td>
                    <td className="num">{r.gpu ? r.gpu.maxMs.toFixed(2) : '—'}</td>
                    <td className="num">{r.js.meanMs.toFixed(2)}</td>
                    <td className="num">{r.js.p95Ms.toFixed(2)}</td>
                    <td className="num">{r.cpu.meanMs.toFixed(2)}</td>
                    <td className="num">{r.cpu.p95Ms.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
