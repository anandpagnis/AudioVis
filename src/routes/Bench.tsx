import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SCENES, preloadScene } from '../scenes'
import { BenchRunner, buildPlan, formatResults, type BenchResult } from '../bench/benchHarness'
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

const TIERS = [0, 1, 2, 3, 4]

/** Roughly how long a full sweep takes, for the pre-run warning. */
const SECONDS_PER_CELL = 3.3

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
    const runner = new BenchRunner(plan)
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
      if (r.done) setRunning(false)
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
