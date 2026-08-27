import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { quality } from './quality'
import { renderScale } from './renderScale'
import { frameSampler } from './frameSampler'
import { useStore } from '../store'

/** How often the frame-time percentiles are recomputed. See the call site. */
const P95_INTERVAL_SEC = 0.25

/**
 * How long a TIER change must hold before its share of the render scale is
 * actually applied.
 *
 * A tier bundles two very different kinds of knob. The complexity knobs
 * (raymarch steps, iteration counts, particle fraction) are **free** to change:
 * scenes read `quality.knobs` every frame, so a new value costs nothing beyond
 * the cheaper work it asks for. Device pixel ratio is **expensive** to change:
 * it resizes the renderer and reallocates the post chain's mip pyramid, a
 * multi-hundred-millisecond stall.
 *
 * Applying both together meant every tier step paid the expensive one, and that
 * stall was the single biggest source of the spikes the governor was reacting
 * to. Splitting them lets the cheap relief land immediately — which for the
 * raymarch-heavy roster is the larger lever anyway — while the resize waits for
 * the tier to prove it is not about to move again. A show oscillating between
 * two tiers now pays nothing for it instead of a resize per step.
 *
 * The hold covers the tier ONLY. The other two inputs to the scale — the live
 * composition's combined pixel budget and the display itself — are applied the
 * instant they move, because both are already-committed events rather than
 * guesses about load: a scene switch hides its resize under the crossfade that
 * is running anyway, and a window dragged to another monitor has already
 * stalled. Making those wait three seconds would mean the first three seconds
 * of every scene are rendered at the previous scene's budget.
 *
 * A user-pinned quality change bypasses this entirely: that is an explicit
 * instruction, not a guess, and it should look immediate.
 */
const RENDER_SCALE_HOLD_SEC = 3

/**
 * Frame time, as a multiple of the refresh interval, past which the hold above
 * is abandoned and the scale applies on the spot.
 *
 * ## Why the hold needed an escape hatch
 *
 * `RENDER_SCALE_HOLD_SEC` is justified by an argument that is true at the
 * margin and false in a crisis: a resize reallocates the post chain, so it
 * should not be paid for a tier change that might reverse. But the hold is per
 * STEP, and the ladder has five rungs — so a machine that needs to fall all the
 * way to the bottom waits out `SETTLE_SEC + 3` five times over, on the order of
 * twenty seconds, while rendering at a resolution it has already been told it
 * cannot afford.
 *
 * The comment on the apply path makes that survivable by asserting the frame is
 * "getting cheaper this instant either way, since scenes read the complexity
 * knobs live". **That is false for six of the eleven live scenes** (F111): four
 * of them read no quality knob at all, so between the tier changing and the
 * resize landing, absolutely nothing happens. Twenty seconds of an unchanged
 * frame, reported as "it looks great but lags".
 *
 * 3x the refresh interval is 50 ms at 60 Hz — three dropped frames in a row,
 * which no amount of hysteresis should sit through. At that point one
 * reallocation is unarguably cheaper than what the frame is already paying.
 */
const SCALE_EMERGENCY_RATIO = 3

/** Live render stats, readable from anywhere (debug panel, fps meter). */
export const perf = {
  fps: 60,
  ms: 16.7,
  /**
   * 95th-percentile raw frame time over the last 10 s, refreshed 4×/s.
   *
   * The hitch metric, and **unfiltered** — it includes scene transitions, DPR
   * resizes and compiles, because the meter's job is to report what the frame
   * budget actually did. The governor deliberately reads a different, filtered
   * number; see frameSampler.ts for why those must not be the same value.
   */
  p95: 16.7,
  dpr: 1,
  /** Logical tier. Complexity already reflects this; DPR may still be catching up. */
  tier: 1,
  /** DPR tier currently applied to the canvas. Lags `tier` by up to the hold. */
  appliedTier: 1,
  /** Linear internal-resolution scale currently on the canvas (1 = native). */
  renderScale: 1,
  /** Combined pixel budget the live composition declared, in megapixels. */
  pixelBudget: 16,
  /** Megapixels the canvas is actually rendering — the budget as delivered. */
  internalMP: 0,
  /** GPU telemetry, copied from renderer.info each frame. */
  drawCalls: 0,
  triangles: 0,
  geometries: 0,
  textures: 0,
  programs: 0,
}

/**
 * Raw (unsmoothed) per-frame time, last 10s — for percentile readouts. `perf.ms`
 * above is a scalar EMA, which is exactly what can't show a hitch buried in an
 * otherwise-good average; this keeps the samples a p95/max can be read from.
 */
export const frameTimeWindow = frameSampler.display

/**
 * Tell the frame sampler that the next few frames are a known one-off — a scene
 * commit's compile and crossfade, a context restore — and must not be taken as
 * evidence of steady-state load.
 *
 * Re-exported here because callers already import `perf` from this module and
 * the two belong to the same concern; the policy itself lives in frameSampler.ts.
 */
export function suspendFrameSampling(frames?: number): void {
  frameSampler.suspend(frames)
}

/**
 * Drives the central {@link quality} governor from the measured frame time, and
 * applies the internal-resolution solve to the canvas DPR.
 *
 * Two separate mechanisms meet here, and keeping them separate is the point:
 *
 *  - The governor picks a TIER from frame time, exposing complexity knobs
 *    (raymarch steps, noise octaves, fluid iterations, particle fraction) that
 *    heavy scenes read directly — so under load the expensive work shrinks, not
 *    just the resolution.
 *  - `renderScale` solves the canvas scale from the pixel budget the live
 *    composition declared and the display that is actually attached, with the
 *    tier as one multiplier on that budget rather than as the answer.
 *
 * This component owns only the DPR side and the telemetry. Tier logic lives in
 * quality.ts, the solve in renderScale.ts, and the budget is published by
 * SceneManager.
 */
export function PerfMonitor() {
  const setDpr = useThree((s) => s.setDpr)
  const gl = useThree((s) => s.gl)
  // CSS size of the canvas. R3F re-renders this component when it changes, which
  // is exactly when the display half of the solve needs re-feeding: a resized
  // window, a window moved to another monitor, a browser zoom.
  const size = useThree((s) => s.size)
  const storeQuality = useStore((s) => s.quality)
  const ema = useRef(16.7)
  const appliedTier = useRef(-1)
  const p95 = useRef(0)
  const lastP95At = useRef(0)
  /** Tier waiting out {@link RENDER_SCALE_HOLD_SEC} before its DPR is applied. */
  const heldTier = useRef(-1)
  const heldSince = useRef(0)
  /** (budget, display) pair the applied scale was solved for. See the hold doc. */
  const appliedPair = useRef('')

  /**
   * Push the current tier's render scale to the canvas.
   *
   * Suspends the governor's sampling first, because this call is the stall: the
   * resize it triggers reallocates the post chain, and letting the governor see
   * that cost is precisely the feedback loop frameSampler.ts describes.
   */
  const applyRenderScale = () => {
    const scale = renderScale.solve()
    const dpr = renderScale.baseDpr * scale
    // Published before `setDpr` so a scene that sizes its own offscreen targets
    // from `renderScale.applied` sees the new value on the same frame the canvas
    // does, rather than one frame behind it.
    renderScale.applied = scale
    perf.dpr = dpr
    perf.renderScale = scale
    perf.pixelBudget = renderScale.budgetMP
    perf.internalMP = renderScale.internalMP(scale)
    perf.appliedTier = quality.tier
    appliedTier.current = quality.tier
    appliedPair.current = renderScale.pairKey
    heldTier.current = -1
    frameSampler.suspend()
    setDpr(dpr)
  }

  // Re-pin the governor whenever the user changes the quality control. An
  // explicit choice applies its render scale immediately — the hold exists to
  // damp the governor's own guessing, not to delay the user.
  //
  // `size` is in the deps for the same reason: a display change is a fact, not
  // a guess, and re-solving against the new full-resolution megapixel count is
  // the whole point of a budget expressed in megapixels rather than in a scale.
  useEffect(() => {
    // See the F123 note in the frame loop: the counters have to survive the
    // post chain's many render() calls to mean anything.
    gl.info.autoReset = false
    quality.setMode(storeQuality)
    renderScale.setDisplay(size.width, size.height, Math.min(2, window.devicePixelRatio || 1))
    applyRenderScale()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeQuality, size.width, size.height])

  useFrame(({ clock }, delta) => {
    // No ceiling: a frame genuinely costing 150-300ms (two heavy raymarch
    // scenes stacked mid-crossfade, a synchronous shader compile) is exactly
    // what this monitor exists to catch, and a `Math.min(100, ...)` here used
    // to erase it before it ever reached the EMA, `frameTimeWindow`'s p95/max,
    // or the quality governor — a real stall would silently read as "100ms"
    // everywhere. The remaining risk is a huge one-off gap from a backgrounded
    // tab (rAF throttles/stops while hidden) spiking the EMA on resume; that
    // self-corrects within the governor's own SETTLE_SEC/CLIMB_HOLD_SEC
    // hysteresis, and the windows prune the sample as it ages out — no separate
    // guard needed for a transient that already ages itself out.
    const ms = delta * 1000
    ema.current += (ms - ema.current) * 0.05
    perf.ms = ema.current
    perf.fps = 1000 / ema.current
    // Feeds both windows: the display one unconditionally, the governor's only
    // when the frame is steady-state evidence. See frameSampler.ts.
    frameSampler.push(clock.elapsedTime, ms)
    perf.tier = quality.tier

    // GPU memory + draw-call telemetry.
    //
    // `info.render` is ACCUMULATED here rather than read raw, because raw was
    // measuring the wrong thing entirely (F123). `renderer.info` resets itself
    // on every `render()` call, and the post chain makes many of them per
    // frame — so whatever this read last was the composer's final fullscreen
    // quad, not the show. A session recording made that unmissable: all 600
    // samples reported `drawCalls: 1, triangles: 2`, identically, for a
    // raymarched shader, an instanced wireframe and a 200-segment torus knot
    // alike. Two triangles is a fullscreen quad.
    //
    // With `autoReset` off the counters accumulate across every render in the
    // frame, so this reads the whole frame's true cost; resetting immediately
    // after means the next frame starts clean. This component runs at the
    // default priority 0, ahead of the composer at 1, so what is read here is
    // the PREVIOUS frame complete — one frame stale, which for a draw-call
    // readout is not a distinction anyone can perceive.
    const info = gl.info
    perf.drawCalls = info.render.calls
    perf.triangles = info.render.triangles
    perf.geometries = info.memory.geometries
    perf.textures = info.memory.textures
    perf.programs = info.programs?.length ?? 0
    info.reset()

    // Percentiles recomputed a few times a second rather than every frame:
    // `percentile()` sorts its window, and the statistic moves far too slowly
    // to justify paying that inside the render loop. The governor's own
    // SETTLE_SEC is 2 s, so a 250 ms refresh is finer than anything it can act
    // on. Note the two different sources — see `perf.p95`.
    if (clock.elapsedTime - lastP95At.current >= P95_INTERVAL_SEC) {
      lastP95At.current = clock.elapsedTime
      perf.p95 = frameSampler.display.percentile(0.95)
      p95.current = frameSampler.governorP95()

      // Measure the display's refresh interval from the FASTEST frames.
      //
      // The governor's thresholds are ratios of this, so it has to be the
      // interval itself and not an average of what we achieved. The 10th
      // percentile is the right estimator: rAF is vsync-locked, so a frame can
      // be LATE (a multiple of the interval) but essentially never early — the
      // fast tail is therefore the interval, even on a machine that is dropping
      // most of its frames. A median would drift upward exactly when the
      // measurement matters most.
      if (frameSampler.display.count() > 30) {
        quality.setRefreshInterval(frameSampler.display.percentile(0.1))
      }
    }

    quality.tick(ema.current, clock.elapsedTime, p95.current)

    // The scale has three inputs and two urgencies (see RENDER_SCALE_HOLD_SEC).
    //
    // A change to the live composition's budget — SceneManager publishes it at
    // priority -100, so it is already this frame's truth — applies now. A change
    // that comes only from the tier trails it: complexity knobs have already
    // taken effect, since scenes read them live, so the frame is getting cheaper
    // this instant either way and only the resize waits.
    if (renderScale.pairKey !== appliedPair.current) {
      applyRenderScale()
    } else if (quality.tier !== appliedTier.current) {
      // A frame this late has stopped being a candidate for hysteresis — see
      // SCALE_EMERGENCY_RATIO. Measured off the p95 rather than the EMA because
      // the EMA is smoothed over seconds and this is the case where seconds are
      // the whole problem.
      if (p95.current > quality.refreshIntervalMs * SCALE_EMERGENCY_RATIO) {
        applyRenderScale()
      } else if (quality.tier !== heldTier.current) {
        heldTier.current = quality.tier
        heldSince.current = clock.elapsedTime
      } else if (clock.elapsedTime - heldSince.current >= RENDER_SCALE_HOLD_SEC) {
        applyRenderScale()
      }
    } else {
      heldTier.current = -1
    }
  })

  return null
}
