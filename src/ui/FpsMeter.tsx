import { useEffect, useRef } from 'react'
import { perf } from '../engine/PerfMonitor'
import { committedMs, frameLoad } from '../engine/frameLoad'
import { quality } from '../engine/quality'

/**
 * Standalone frame-time readout: fps, mean ms, p95 ms, quality tier.
 *
 * Separate from `DebugPanel` (which also prints fps) on purpose. That panel is
 * a 280×154 canvas redrawn every frame with a spectrum, band meters, beat
 * markers and mood telemetry — opening all of it to watch the frame rate
 * measurably changes the thing you are trying to measure. This is four numbers
 * of text.
 *
 * ## Why p95 is here and not just fps
 *
 * `perf.fps` is derived from an EMA, and an EMA structurally cannot show a
 * stall: with α = 0.05 a single 200 ms hitch lifts the mean by about 9 ms and
 * decays out within a second. A show can read a steady "60 fps" while visibly
 * stuttering once a second. `perf.p95` is the 95th percentile of raw frame
 * times over the last 10 s — the number that catches exactly that, and the
 * second axis the quality governor now steps on (see quality.ts).
 *
 * So the pair is the point: **fps tells you how fast it is, p95 tells you
 * whether it is smooth**, and this project's standing rule is that the second
 * one matters more.
 *
 * `tier` is shown alongside because a good-looking frame time at tier 4 means
 * something very different from the same number at tier 0 — the governor may
 * simply have already thrown away most of the visual quality to get there.
 *
 * Follows the same DOM discipline as `BpmReadout`: throttled, and every write
 * diffed against the last one. It would be absurd for the frame-cost meter to
 * be a frame-cost problem.
 */

/** Refresh rate. Fast enough to feel live, slow enough to be readable. */
const HZ = 5
const INTERVAL_MS = 1000 / HZ

/**
 * p95 thresholds for the colour band, in ms. These mirror quality.ts's
 * `P95_STEP_UP_MS` / `P95_STEP_DOWN_MS`, so the readout turns amber at the
 * point the governor stops being willing to climb, and red at the point it
 * actively sheds load. The colour is telling you what the governor is about
 * to do.
 */
const P95_GOOD_MS = 22
const P95_BAD_MS = 34

export function FpsMeter() {
  const fpsRef = useRef<HTMLSpanElement>(null)
  const msRef = useRef<HTMLSpanElement>(null)
  const p95Ref = useRef<HTMLSpanElement>(null)
  const tierRef = useRef<HTMLSpanElement>(null)
  const loadRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    let raf = 0
    let lastAt = 0
    let lastFps = ''
    let lastMs = ''
    let lastP95 = ''
    let lastTier = ''
    let lastBand = ''
    let lastLoad = ''

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      if (now - lastAt < INTERVAL_MS) return
      lastAt = now

      const fps = perf.fps.toFixed(0)
      if (fps !== lastFps && fpsRef.current) {
        lastFps = fps
        fpsRef.current.textContent = fps
      }

      const ms = perf.ms.toFixed(1)
      if (ms !== lastMs && msRef.current) {
        lastMs = ms
        msRef.current.textContent = `${ms}ms`
      }

      const p95 = perf.p95.toFixed(1)
      const band = perf.p95 > P95_BAD_MS ? 'bad' : perf.p95 > P95_GOOD_MS ? 'warn' : 'good'
      if (p95Ref.current) {
        if (p95 !== lastP95) {
          lastP95 = p95
          p95Ref.current.textContent = `p95 ${p95}`
        }
        // className is a style invalidation too, so it gets the same diff.
        if (band !== lastBand) {
          lastBand = band
          p95Ref.current.className = `fps-p95 ${band}`
        }
      }

      // `T2` normally; `T3›2` while the render scale is still trailing the
      // logical tier. The complexity knobs change the instant the tier does —
      // only the DPR resize waits, deliberately (see RENDER_SCALE_HOLD_SEC in
      // PerfMonitor), and without this the meter would look stuck on the old
      // tier for three seconds while the frame was already getting cheaper.
      const tier =
        perf.appliedTier === perf.tier
          ? `T${perf.tier}`
          : `T${perf.appliedTier}›${perf.tier}`
      if (tier !== lastTier && tierRef.current) {
        lastTier = tier
        tierRef.current.textContent = tier
      }

      // Budget breakdown: subject + crossfade overlap + layers + effects +
      // fixed, against the tier's total capacity. This is the readout that
      // shows whether the budget is seeing the WHOLE frame — for a long time it
      // was not, and each claimant reserved against its own partial view of it
      // (see frameLoad.ts). Red once committed exceeds capacity.
      //
      // Milliseconds, one decimal. The currency used to be an abstract unit and
      // printed as an integer; now every term is a measured cost and floats
      // would otherwise render as `0.30000000000000004`.
      const budget = quality.knobs.frameBudgetMs
      const used = committedMs()
      const d = (n: number) => n.toFixed(1)
      const load =
        `${d(frameLoad.primary)}+${d(frameLoad.incoming)}+${d(frameLoad.layers)}` +
        `+${d(frameLoad.effects)}+${d(frameLoad.fixed)} = ${d(used)}/${d(budget)}ms`
      if (load !== lastLoad && loadRef.current) {
        lastLoad = load
        loadRef.current.textContent = load
        loadRef.current.className = `fps-load ${used > budget ? 'bad' : ''}`
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div
      className="fps-meter glass"
      title="fps · mean frame time · p95 frame time (unfiltered — includes scene transitions) · quality tier (applied›logical while the render scale catches up)"
    >
      <span ref={fpsRef} className="fps-value">
        —
      </span>
      <span className="fps-unit">fps</span>
      <span ref={msRef} className="fps-ms">
        —
      </span>
      <span ref={p95Ref} className="fps-p95 good">
        p95 —
      </span>
      <span ref={tierRef} className="fps-tier">
        T—
      </span>
      <span
        ref={loadRef}
        className="fps-load"
        title="frame budget: primary + crossfade overlap + layers + effects + fixed (post chain, AI overlay) = committed / tier capacity"
      >
        —
      </span>
    </div>
  )
}
