import { useEffect, useLayoutEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Vector2 } from 'three'
import { quality } from './quality'
import { createGpuTimer, type GpuTimer } from './gpuTimer'
import { renderScale } from './renderScale'
import { maxResolutionMP } from './maxResolution'
import { frameSampler } from './frameSampler'
import { performanceState } from './performanceState'
import { resourceCache } from './streaming/resourceCache'
import { ceilingForTier, evaluateLedger, type LedgerEntry } from './streaming/budgetLedger'
import {
  feedbackMsFor,
  frameLoad,
  isfFilterMsFor,
  lensRackMs,
  mirrorRackMs,
  observePostChainSample,
} from './frameLoad'
import { useStore } from '../store'

/**
 * `useFrame` priorities every other director/pass in this engine uses today
 * (SceneManager's audio tick through ExposureSampler) span -100..2. The GPU
 * timer's begin/end have to bracket the ENTIRE frame's GPU submission, so
 * they sit far outside that range on both ends rather than guessing at "one
 * more than the latest priority" — a future pass added at, say, priority 3
 * then still falls inside the bracket without this having to change.
 */
const GPU_TIMER_BEGIN_PRIORITY = -1000
const GPU_TIMER_END_PRIORITY = 1000

/** How often the frame-time percentiles are recomputed. See the call site. */
const P95_INTERVAL_SEC = 0.25

/** How often the VRAM ledger (F16) is re-evaluated. Coarser than
 *  P95_INTERVAL_SEC — real GPU memory only moves on a resource grow, which
 *  is rare (post-F147, at most once per render-target's session peak),
 *  so there is nothing to gain from checking it every frame. */
const LEDGER_INTERVAL_SEC = 2

/**
 * Consecutive gated-clean frames required before a GPU-timer poll result is
 * trusted for the post-chain calibration (F238).
 *
 * `perf.gpuMs`'s own doc comment states the timer's result is "available 1-3
 * frames after it closes" — so whatever `timer.poll()` returns on frame N is
 * really reporting frame N-1..N-3's GPU submission, not frame N's. Checking
 * `frameLoad`/`performanceState` (frame N's own, freshly-written state) against
 * that lagging result would risk crediting the chain with a composition it was
 * never actually drawn against — a layer admitted one frame after a clean
 * reading closed, attributed to the clean frame's residual instead.
 *
 * Requiring the gate to have held for several consecutive frames before a
 * sample is accepted sidesteps computing which exact past frame a result
 * belongs to: if the gate has been true for at least this many frames running,
 * every frame within the timer's documented lag window was ALSO gated-clean,
 * whichever one of them the current result actually reports on. 6 comfortably
 * covers the documented 1-3 frame lag with margin, the same "cover the
 * measurement's own latency with a frame-count cushion" reasoning
 * `DEFAULT_SUSPEND_FRAMES` already uses in frameSampler.ts for a (much larger)
 * reallocation stall.
 */
const POST_CHAIN_CLEAN_STREAK_FRAMES = 6

/** Live render stats, readable from anywhere (debug panel, fps meter). */
export const perf = {
  fps: 60,
  ms: 16.7,
  /**
   * 95th-percentile raw frame time over the last 10 s, refreshed 4×/s.
   *
   * The hitch metric, and **unfiltered** — it includes scene transitions,
   * display resizes and compiles, because the meter's job is to report what the frame
   * budget actually did. The governor deliberately reads a different, filtered
   * number; see frameSampler.ts for why those must not be the same value.
   */
  p95: 16.7,
  /** The canvas's pixel ratio — pinned at base DPR since F272 stage 5 (`renderScale.baseDpr`). */
  dpr: 1,
  /** Logical tier. */
  tier: 1,
  /**
   * Tier the frame's render scale was last solved at. Since F272 stage 5 the
   * scale is applied at the start of every frame, so this trails `tier` by at
   * most the one frame between the governor moving and the next solve.
   */
  appliedTier: 1,
  /** Linear render scale of this frame's sub-rect (1 = native). `renderScale.applied`. */
  renderScale: 1,
  /** Combined pixel budget the live composition declared, in megapixels. */
  pixelBudget: 16,
  /** Megapixels the frame is actually rendering — the budget as delivered. */
  internalMP: 0,
  /** GPU telemetry, copied from renderer.info each frame. */
  drawCalls: 0,
  triangles: 0,
  geometries: 0,
  textures: 0,
  programs: 0,
  /**
   * Real, measured GPU memory (F16) — everything `resourceCache` currently
   * knows the size of: the shared PMREM env map plus every budgeted scene's
   * render target (createShaderScene.tsx, reported on grow). NOT a total of
   * every GPU allocation in the app — geometries/plain textures/the post
   * chain's own buffers aren't routed through `resourceCache` and aren't
   * counted here. Read as a floor on real usage, not the whole picture.
   */
  vramMB: 0,
  /** `budgetLedger.ceilingForTier(tier)` for the CURRENT tier — a tuning
   *  guess (see that function's own doc comment), not a measured ceiling. */
  vramCeilingMB: 0,
  /**
   * Real GPU execution time for a recent frame, in milliseconds (c11b) — 0
   * until the first result lands. NOT necessarily THIS frame's: a timer
   * query's result is available 1-3 frames after it closes (see
   * gpuTiming.ts), so this always lags `perf.ms` slightly. Read it as "how
   * GPU-bound is the show right now", not as a same-frame breakdown of
   * `perf.ms` — the gap between the two is everything ELSE a frame pays for
   * (JS, driver dispatch, vsync wait), which `perf.ms` alone cannot separate
   * out and this cannot either on its own, only by comparison.
   */
  gpuMs: 0,
  /** Whether `EXT_disjoint_timer_query_webgl2` was available on this GPU/
   *  browser — `gpuMs` stays frozen at its last value (0, if never measured)
   *  when this is false, same degrade-quietly posture as every other
   *  optional-extension feature in this codebase. */
  gpuTimerAvailable: false,
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
 * applies the internal-resolution solve to the frame.
 *
 * Two separate mechanisms meet here, and keeping them separate is the point:
 *
 *  - The governor picks a TIER from frame time, exposing complexity knobs
 *    (raymarch steps, noise octaves, fluid iterations, particle fraction) that
 *    heavy scenes read directly — so under load the expensive work shrinks, not
 *    just the resolution.
 *  - `renderScale` solves the frame's scale from the pixel budget the live
 *    composition declared and the display that is actually attached, with the
 *    tier as one multiplier on that budget rather than as the answer.
 *
 * Since F272 stage 5 the scale is not a canvas DPR. The canvas is pinned at base
 * DPR (Stage.tsx), the post chain renders into a sub-rect of full-size buffers
 * (frameRect.ts) and `GradePass` upscales it, so applying a scale is a number
 * written once per frame — no resize, no reallocation, no React re-render, and
 * nothing for the governor to be shielded from.
 *
 * This component owns only that application and the telemetry. Tier logic lives
 * in quality.ts, the solve in renderScale.ts, and the budget is published by
 * SceneManager.
 */
export function PerfMonitor() {
  const gl = useThree((s) => s.gl)
  // CSS size and pixel ratio of the canvas. R3F re-renders this component when
  // either changes, which is exactly when the governor's rung memory has to be
  // cleared: a resized window, a window moved to another monitor, a browser zoom.
  const size = useThree((s) => s.size)
  const dpr = useThree((s) => s.viewport.dpr)
  const storeQuality = useStore((s) => s.quality)
  const storeMaxRes = useStore((s) => s.maxResolution)
  const ema = useRef(16.7)
  /**
   * F198: a second EMA, filtered the same way `frameSampler`'s governor
   * window already is, for the governor's mean-axis input specifically.
   *
   * `ema` above is the FPS meter's number, and `perf.p95`'s own doc comment
   * already states the intended split: "the governor deliberately reads a
   * different, filtered number" than the display metric, because the
   * display metric's job is to report a real stall (a scene commit's
   * compile, a display resize) unfiltered, while `frameSampler.suspend()` exists
   * so the governor does not mistake that SAME known one-off for steady-state
   * load. That split was real for the p95 axis (`frameSampler.governorP95()`
   * vs `frameSampler.display.percentile()`) and never existed for the mean
   * axis — `ema` fed both `perf.ms` and `quality.tick()` from one unguarded
   * number, so every suspension that protected the p95 window left the mean
   * gate wide open.
   *
   * A live session (`audiovis-session-2026-09-05-19-18-53`) caught this
   * directly: a 158.4 ms warm-mount compile stall moved the shared EMA from
   * 16.7 to 23.8 ms in one frame (`0.05 * (158.4 - 16.7) = +7.1`), crossing
   * `STEP_DOWN_MEAN_RATIO`'s 18.3 ms gate, and the governor demoted from its
   * best rung of the session one `SETTLE_SEC` later — on a machine whose GPU
   * measured 9% of frame time that whole session. The warm-mount path
   * (`SceneManager.tsx`'s `prewarmShaders` call) suspends nothing at all,
   * so a candidate that compiles and is withdrawn without ever committing is
   * unprotected on both axes at once.
   *
   * Kept as a genuinely separate ref rather than reusing `ema` under a
   * suspend guard, because `perf.ms`/`perf.fps`'s own doc explicitly wants
   * the unfiltered number for display ("a frame genuinely costing 150-300ms
   * ... is exactly what this monitor exists to catch") — gating that ref
   * would make the FPS meter silently lie about a real stall it is supposed
   * to surface. Only the governor's copy should go blind during a known
   * one-off; the display copy never should.
   */
  const governorEma = useRef(16.7)
  const p95 = useRef(0)
  const lastP95At = useRef(0)
  /** F16: coarser than P95_INTERVAL_SEC — VRAM only moves on a resource
   *  grow, not every frame or even every fourth of a second. */
  const lastLedgerAt = useRef(0)
  /** Scratch for the canvas CSS size read every frame — never allocated in the loop. */
  const cssSize = useRef(new Vector2())
  /** c11b: null on WebGL1 or a GPU/browser without the extension — every use
   *  below already treats that as "no measurement available", not an error. */
  const gpuTimer = useRef<GpuTimer | null>(null)
  /** F238: consecutive frames the post-chain calibration's gate has held. See
   *  {@link POST_CHAIN_CLEAN_STREAK_FRAMES} for why a streak, not a single check. */
  const postChainCleanStreak = useRef(0)
  /** The render scale the previous frame was drawn at, for the calibration gate. */
  const prevApplied = useRef(-1)

  // Created once per renderer, disposed on unmount or if the renderer itself
  // ever changes (a context loss and recreate, in practice) — the same
  // lifecycle every other GL-owning ref in this file follows.
  useEffect(() => {
    const ctx = gl.getContext()
    const timer =
      typeof WebGL2RenderingContext !== 'undefined' && ctx instanceof WebGL2RenderingContext
        ? createGpuTimer(ctx)
        : null
    gpuTimer.current = timer
    perf.gpuTimerAvailable = timer !== null
    return () => {
      timer?.dispose()
      if (gpuTimer.current === timer) gpuTimer.current = null
    }
  }, [gl])

  /**
   * Solve this frame's render scale and apply it: the frame's sub-rect for
   * every scene, director and pass that runs after it.
   *
   * The display is re-read from the renderer first, so the rect can never
   * describe a canvas R3F has already resized (the wrapper resizes the
   * composer from the same numbers). Cheap enough to run every frame: a few
   * assignments and a square root.
   */
  const applyRenderScale = () => {
    gl.getSize(cssSize.current)
    renderScale.setDisplay(cssSize.current.x, cssSize.current.y, gl.getPixelRatio())
    // Instant, in both directions (the user's call for F272's first version).
    // F273: the 1-2 s glide on a CLIMB goes here, once the steps are confirmed.
    const scale = renderScale.solve()
    renderScale.applied = scale
    perf.dpr = renderScale.baseDpr
    perf.renderScale = scale
    perf.pixelBudget = renderScale.budgetMP
    perf.internalMP = renderScale.internalMP(scale)
    perf.appliedTier = quality.tier
  }

  // Re-pin the governor whenever the user changes the quality control, or the
  // display changes — a display change is a fact, not a guess, and re-solving
  // against the new full-resolution megapixel count is the whole point of a
  // budget expressed in megapixels rather than in a scale.
  //
  // The max-resolution cap (F272 stage 6) rides the same effect, and so its
  // change also clears the governor's rung memory through `setMode`. That is
  // wanted, not incidental: every "this tier cannot hold" record is a claim
  // about a pixel count, which the cap has just changed exactly as a resize
  // would.
  //
  // A LAYOUT effect so the display is known before the first frame renders:
  // scenes size their buffers from `renderScale.internalW/H`, which is 1x1
  // until `setDisplay` has run (F272).
  useLayoutEffect(() => {
    // See the F123 note in the frame loop: the counters have to survive the
    // post chain's many render() calls to mean anything.
    gl.info.autoReset = false
    quality.setMode(storeQuality)
    renderScale.setMaxMP(maxResolutionMP(storeMaxRes))
    applyRenderScale()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeQuality, storeMaxRes, size.width, size.height, dpr])

  // Opens this frame's GPU timer query before anything else in the frame has
  // had a chance to issue a draw call — see GPU_TIMER_BEGIN_PRIORITY's doc.
  // The render scale is applied in the same hook for the same reason: it is
  // the first thing in the frame, so every reader of `renderScale.applied` /
  // `internalW/H` this frame — the budget walk at -100, the scenes, the post
  // chain's rect — sees one value. The tier the solve reads is the one the
  // governor settled on last frame (`quality.tick` runs below, at 0).
  useFrame(() => {
    gpuTimer.current?.begin()
    applyRenderScale()
  }, GPU_TIMER_BEGIN_PRIORITY)

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
    // F198: the governor's own copy stays blind for exactly the frames
    // `frameSampler` is suspended for — the same "known one-off, not
    // steady-state load" evidence the p95 window already respects. See
    // `governorEma`'s own doc above for why this has to be a second ref
    // rather than a guard on `ema` itself, and `stepGovernorEma`'s own doc
    // in frameSampler.ts for why the arithmetic lives there, not here.
    governorEma.current = frameSampler.stepGovernorEma(governorEma.current, ms)
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

    // F16: budgetLedger.ts was tested-but-unreached scaffolding — nothing
    // fed it real data and nothing read its verdict. `resourceCache` now
    // carries real, measured byte sizes for the resources that actually
    // matter here (the shared env map, every budgeted scene's render
    // target — see envMap.ts and createShaderScene.tsx). This closes the
    // "no data in" half honestly.
    //
    // Deliberately NOT closing the "no action taken" half: `evaluateLedger`
    // is run and its verdict is published (`perf.vramMB`/`vramCeilingMB`,
    // and a console.warn when over), but nothing here actually tears a
    // scene down. Two reasons, not one: (1) nothing in today's roster is
    // remotely close to `ceilingForTier`'s guessed numbers (that function's
    // own doc comment says so — it's untuned against real content), so
    // there is no live case to verify eviction against; (2) forcing a
    // resident scene's render target to rebuild mid-show is exactly the
    // reallocation stall F147 just spent this session eliminating for
    // maze specifically — automating that trigger without a live browser
    // to confirm it lands safely would be trading one hazard for another.
    // A visible, honest number beats a confident action nobody has verified.
    if (clock.elapsedTime - lastLedgerAt.current >= LEDGER_INTERVAL_SEC) {
      lastLedgerAt.current = clock.elapsedTime
      const activeId = performanceState.activeScene
      const entries: LedgerEntry[] = resourceCache.snapshot().map((e) => {
        // `rt:<sceneId>` (createShaderScene.tsx) maps back to a real scene
        // id; anything else (e.g. `envMap:room`) is a shared, non-scene
        // resource — never the current primary, so BACKGROUND is the
        // honest status for it too (resident, not on screen).
        const sceneId = e.key.startsWith('rt:') ? e.key.slice(3) : e.key
        return {
          sceneId,
          status: sceneId === activeId ? 'ACTIVE' : 'BACKGROUND',
          vramMB: e.byteSize / (1024 * 1024),
          measured: true,
          priority: 0,
          lastActiveAtSec: 0,
        }
      })
      const verdict = evaluateLedger(entries, ceilingForTier(quality.tier))
      perf.vramMB = verdict.totalMB
      perf.vramCeilingMB = verdict.ceilingMB
      if (verdict.overBy > 0) {
        console.warn(
          `[AudioVis] VRAM ledger: ${verdict.totalMB.toFixed(1)}MB over ` +
            `${verdict.ceilingMB}MB ceiling (tier ${quality.tier}) — eviction ` +
            `candidates: ${verdict.evictionCandidates.join(', ') || '(none evictable)'}. ` +
            'Not acted on automatically; see F16 in docs/ISSUES.md.',
        )
      }
    }

    // `ms` (this frame's own raw, unsmoothed time) feeds the governor's
    // consecutive-overbudget emergency path — see quality.ts's own doc on
    // why the smoothed EMA above cannot substitute for it. That path is
    // unaffected by F198: it needs CONSECUTIVE_OVERBUDGET_FRAMES (5) frames
    // in a row over the ratio, which a single warm-mount stall among
    // otherwise-steady neighbours does not produce.
    //
    // `governorEma`, not the display `ema`, is the mean-axis input — see its
    // own doc above.
    quality.tick(governorEma.current, clock.elapsedTime, p95.current, ms)
  })

  // Closes this frame's GPU timer query after every other priority in the
  // frame has run — see GPU_TIMER_BEGIN_PRIORITY's doc for why this sits at
  // the opposite extreme rather than at some specific "last" priority.
  // `poll()` is cheap on the common not-ready-yet path (a couple of GL
  // parameter reads), so checking it every frame alongside `end()` costs
  // nothing extra rather than needing its own cadence.
  useFrame(() => {
    const timer = gpuTimer.current
    if (!timer) return
    timer.end()
    const ms = timer.poll()

    // Feed the live post-chain calibration (F238) — see observePostChainSample's
    // doc in frameLoad.ts for the full reasoning. Every other claimant on the
    // frame must be provably zero before a GPU reading can stand in for the
    // chain alone: no crossfade/warming overlap, no layers, no effects, trails
    // at rest, both optical racks and the ISF slot off, no compile stall in
    // flight (frameSampler.suspended covers the same "known one-off" frames the
    // tier governor already refuses to learn from), and the render scale the
    // same as last frame's — a scale step no longer suspends the sampler (F272
    // stage 5), and the timer's result lags the frame it describes, so the
    // streak is what keeps a reading from one scale being divided by another.
    // This is the default steady-state frame, not a rare one, so the streak
    // below fills through almost any ordinary session.
    //
    // Tracked every frame regardless of whether `ms` resolved this time —
    // see POST_CHAIN_CLEAN_STREAK_FRAMES for why the streak, not this frame's
    // gate alone, is what a poll result is checked against.
    const settled = renderScale.applied === prevApplied.current
    prevApplied.current = renderScale.applied
    const gated =
      settled &&
      !frameSampler.suspended &&
      frameLoad.incoming === 0 &&
      frameLoad.layers === 0 &&
      frameLoad.effects === 0 &&
      feedbackMsFor(performanceState.trails) === 0 &&
      mirrorRackMs(performanceState.mirror) === 0 &&
      lensRackMs(performanceState.lens) === 0 &&
      isfFilterMsFor(performanceState.filter) === 0
    postChainCleanStreak.current = gated ? postChainCleanStreak.current + 1 : 0

    if (ms === null) return
    perf.gpuMs = ms
    if (postChainCleanStreak.current >= POST_CHAIN_CLEAN_STREAK_FRAMES) {
      observePostChainSample(
        ms,
        frameLoad.primary,
        renderScale.internalMP(renderScale.applied),
        renderScale.fullMP,
      )
    }
  }, GPU_TIMER_END_PRIORITY)

  return null
}
