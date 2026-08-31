import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { quality } from './quality'
import { decideTierResize, renderScale } from './renderScale'
import { frameSampler } from './frameSampler'
import { performanceState } from './performanceState'
import { resourceCache } from './streaming/resourceCache'
import { ceilingForTier, evaluateLedger, type LedgerEntry } from './streaming/budgetLedger'
import { useStore } from '../store'

/** How often the frame-time percentiles are recomputed. See the call site. */
const P95_INTERVAL_SEC = 0.25

/** How often the VRAM ledger (F16) is re-evaluated. Coarser than
 *  P95_INTERVAL_SEC — real GPU memory only moves on a resource grow, which
 *  is rare (post-F147, at most once per render-target's session peak),
 *  so there is nothing to gain from checking it every frame. */
const LEDGER_INTERVAL_SEC = 2

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
 *
 * ## Climbs only (F153)
 *
 * This delays a tier change that RAISES the solved scale. A change that lowers
 * it applies on the next coalesce tick, because every word of the justification
 * above is about a change that might reverse and cost a reallocation for
 * nothing — and a demote is not a guess about load, it is the governor having
 * already decided. Holding it means rendering at a resolution the controller
 * has just declared unaffordable, which is the state the ladder exists to leave.
 *
 * Three sessions put 22 of 26, then 35 of 41, of their frames over 33 ms inside
 * that gap. See the direction check at the call site for the measurements and
 * for the compounding case this removes.
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

/**
 * Minimum gap between two actual `applyRenderScale()` calls, regardless of
 * which of the three inputs asked for the second one (F132).
 *
 * The composition-triggered path above is deliberately immediate — a scene
 * commit hides its resize under the crossfade — but "immediate" was reading
 * `renderScale.pairKey` fresh on every frame a transition ran, and a
 * transition's own layer add/remove events (an overlay swapping in, an accent
 * dropping out) each change the combined pixel budget and therefore the pair
 * key. A session log showed the actual cost of that: the worst single frames
 * of a whole set (60-136 ms, several times the 16.7 ms budget) all landed
 * within about a second of a scene commit, next to 2-4 separate `renderScale`
 * changes stacked in that same second — each one a full render-target
 * reallocation, paid on top of the commit's own cost rather than instead of
 * it.
 *
 * This does not change WHEN the hold/emergency logic below decides a resize
 * is warranted, only how often the expensive part of actually doing it may
 * run. The first call in a burst still lands immediately (nothing here delays
 * it), and `applyRenderScale()` always re-reads live state rather than a
 * captured snapshot, so a call that lands after being coalesced still applies
 * whatever the composition's CURRENT budget is, not a stale one — no change
 * is lost, only the redundant intermediate reallocations are.
 *
 * Raised 0.2 -> 0.5: a crossfade's own layer add/drop events fire several
 * `pairKey` changes across the ~1 s it runs, and at 0.2 the session logs still
 * showed 2-3 stacked reallocations landing inside one commit. 0.5 keeps the
 * first one immediate and folds the rest into a single later apply against
 * whatever budget the composition settled on. The tier-driven path is
 * additionally frozen outright while a transition runs — see the frame loop.
 */
const RESIZE_COALESCE_SEC = 0.5

/**
 * Largest upward jump in render scale one resize may make, as a multiple of the
 * scale currently on the canvas.
 *
 * `renderScale.solve()` has no memory — it is a pure function of (budget,
 * display, tier) — so when the combined pixel budget rises sharply (layers
 * dropping out, a cheap scene committing) it returns the new target in full and
 * `applyRenderScale` would leap straight there in one reallocation. On a
 * machine that cannot actually hold that target the tier ladder then demotes,
 * the solve climbs again on the next budget change, and the show cascades — a
 * session log caught exactly this (`0.75 -> 1.00`, then tier 0 walked to 4
 * over ~6 s). Capping the per-resize climb at 1.25x lets the ladder catch an
 * over-reach on the first rung instead of the fifth. Downward is never capped:
 * shedding load must land the instant it is asked for.
 */
const MAX_RENDER_SCALE_STEP_UP = 1.25

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
  /** F16: coarser than P95_INTERVAL_SEC — VRAM only moves on a resource
   *  grow, not every frame or even every fourth of a second. */
  const lastLedgerAt = useRef(0)
  /** Tier waiting out {@link RENDER_SCALE_HOLD_SEC} before its DPR is applied. */
  const heldTier = useRef(-1)
  const heldSince = useRef(0)
  /** (budget, display) pair the applied scale was solved for. See the hold doc. */
  const appliedPair = useRef('')
  /** Clock time of the last actual reallocation. See {@link RESIZE_COALESCE_SEC}. */
  const lastResizeAt = useRef(-Infinity)

  /**
   * Push the current tier's render scale to the canvas.
   *
   * Suspends the governor's sampling first, because this call is the stall: the
   * resize it triggers reallocates the post chain, and letting the governor see
   * that cost is precisely the feedback loop frameSampler.ts describes.
   */
  const applyRenderScale = () => {
    const solved = renderScale.solve()
    const prev = renderScale.applied
    // Ratchet the climb (see MAX_RENDER_SCALE_STEP_UP). A big budget jump can
    // otherwise leap straight back to native in one resize and overshoot into a
    // demote cascade; capping the step lets the tier ladder catch it early.
    // Downward is never clamped. Re-quantised to the 0.01 grid the solve uses so
    // the convergence walk in the frame loop terminates cleanly.
    const climbCap = Math.round(prev * MAX_RENDER_SCALE_STEP_UP * 100) / 100
    const scale = solved > prev ? Math.min(solved, climbCap) : solved
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

    quality.tick(ema.current, clock.elapsedTime, p95.current)

    // The scale has three inputs and two urgencies (see RENDER_SCALE_HOLD_SEC).
    //
    // A change to the live composition's budget — SceneManager publishes it at
    // priority -100, so it is already this frame's truth — applies now. A change
    // that comes only from the tier trails it: complexity knobs have already
    // taken effect, since scenes read them live, so the frame is getting cheaper
    // this instant either way and only the resize waits.
    // Gates every actual reallocation, on top of (not instead of) the
    // hold/emergency logic below — see RESIZE_COALESCE_SEC. A blocked call
    // simply leaves its trigger condition true, so the next frame that clears
    // the cooldown picks it back up against whatever is live by then.
    const coalesceReady = clock.elapsedTime - lastResizeAt.current >= RESIZE_COALESCE_SEC
    const applyRenderScaleCoalesced = () => {
      if (!coalesceReady) return
      lastResizeAt.current = clock.elapsedTime
      applyRenderScale()
    }
    // One frame stale — SceneManager's compositor writes this at priority 1,
    // after this component. Irrelevant against a gate that spans a ~1 s fade.
    const txActive = performanceState.transition.active
    if (renderScale.pairKey !== appliedPair.current) {
      // The live composition's own budget moved (a commit, a layer add/drop).
      // Already-committed event, applies now; RESIZE_COALESCE_SEC is what stops
      // a burst of these inside one transition from each paying a realloc.
      applyRenderScaleCoalesced()
    } else if (quality.tier !== appliedTier.current) {
      // Direction-aware since F153: a tier change that SHEDS load applies on
      // sight, one that raises it waits out the hold. The reasoning, the
      // measurements behind it and the crossfade carve-out all live with the
      // decision in `decideTierResize`. Still gated by RESIZE_COALESCE_SEC, so
      // "apply" means "within half a second of deciding to", not "every frame".
      const action = decideTierResize({
        solved: renderScale.solve(),
        applied: renderScale.applied,
        p95Ms: p95.current,
        refreshMs: quality.refreshIntervalMs,
        txActive,
        heldForThisTier: quality.tier === heldTier.current,
        heldForSec: clock.elapsedTime - heldSince.current,
        emergencyRatio: SCALE_EMERGENCY_RATIO,
        holdSec: RENDER_SCALE_HOLD_SEC,
      })
      if (action === 'apply') {
        applyRenderScaleCoalesced()
      } else if (action === 'restart-hold') {
        heldTier.current = quality.tier
        heldSince.current = clock.elapsedTime
      }
    } else {
      heldTier.current = -1
      // A ratcheted climb (MAX_RENDER_SCALE_STEP_UP) lands short of what the
      // live inputs now ask for; walk it the rest of the way on the coalesce
      // cadence. Only when nothing structural is pending — a tier change and a
      // crossfade both have their own gates above — and never past the
      // emergency line.
      if (
        !txActive &&
        renderScale.applied < renderScale.solve() - 0.005 &&
        p95.current <= quality.refreshIntervalMs * SCALE_EMERGENCY_RATIO
      ) {
        applyRenderScaleCoalesced()
      }
    }
  })

  return null
}
