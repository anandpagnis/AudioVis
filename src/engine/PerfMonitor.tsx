import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { quality } from './quality'
import { frameSampler } from './frameSampler'
import { useStore } from '../store'

/** How often the frame-time percentiles are recomputed. See the call site. */
const P95_INTERVAL_SEC = 0.25

/**
 * How long the tier must hold before its render-scale is actually applied.
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
 * A user-pinned quality change bypasses this entirely: that is an explicit
 * instruction, not a guess, and it should look immediate.
 */
const RENDER_SCALE_HOLD_SEC = 3

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
 * Drives the central {@link quality} governor from the measured frame time and
 * applies its render-scale to the canvas DPR. The governor also exposes
 * complexity knobs (raymarch steps, noise octaves, fluid iterations, particle
 * count) that heavy scenes read directly — so under load the *expensive work*
 * shrinks, not just the resolution. This component only owns the DPR side and
 * the telemetry; the tier logic lives in quality.ts.
 */
export function PerfMonitor() {
  const setDpr = useThree((s) => s.setDpr)
  const gl = useThree((s) => s.gl)
  const storeQuality = useStore((s) => s.quality)
  const ema = useRef(16.7)
  const appliedTier = useRef(-1)
  const p95 = useRef(0)
  const lastP95At = useRef(0)
  /** Tier waiting out {@link RENDER_SCALE_HOLD_SEC} before its DPR is applied. */
  const heldTier = useRef(-1)
  const heldSince = useRef(0)

  /**
   * Push the current tier's render scale to the canvas.
   *
   * Suspends the governor's sampling first, because this call is the stall: the
   * resize it triggers reallocates the post chain, and letting the governor see
   * that cost is precisely the feedback loop frameSampler.ts describes.
   */
  const applyRenderScale = () => {
    const base = Math.min(2, window.devicePixelRatio || 1)
    const dpr = base * quality.knobs.renderScale
    perf.dpr = dpr
    perf.appliedTier = quality.tier
    appliedTier.current = quality.tier
    heldTier.current = -1
    frameSampler.suspend()
    setDpr(dpr)
  }

  // Re-pin the governor whenever the user changes the quality control. An
  // explicit choice applies its render scale immediately — the hold exists to
  // damp the governor's own guessing, not to delay the user.
  useEffect(() => {
    quality.setMode(storeQuality)
    applyRenderScale()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeQuality])

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

    // GPU memory + draw-call telemetry (renderer.info reflects the last
    // rendered frame — close enough for a live readout).
    const info = gl.info
    perf.drawCalls = info.render.calls
    perf.triangles = info.render.triangles
    perf.geometries = info.memory.geometries
    perf.textures = info.memory.textures
    perf.programs = info.programs?.length ?? 0

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

    // Render scale trails the tier (see RENDER_SCALE_HOLD_SEC). Complexity
    // knobs have already taken effect — scenes read them live — so the frame is
    // getting cheaper this instant either way; only the resize waits.
    if (quality.tier !== appliedTier.current) {
      if (quality.tier !== heldTier.current) {
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
