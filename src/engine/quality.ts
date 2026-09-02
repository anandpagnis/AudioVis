import type { IUniform } from 'three'
import { TIER_BUDGET_MS } from './slotBudget'

/**
 * Central runtime quality governor — the single source of truth for how hard
 * every heavy scene is allowed to push each frame.
 *
 * The key idea: it scales COMPLEXITY, not just canvas resolution. Fixed-cost
 * GPU work — the fluid sim's Jacobi passes, the particle count, a raymarcher's
 * per-pixel step count and noise octaves — is invisible to plain DPR scaling
 * (those targets/buffers/loops don't shrink when the framebuffer does). The
 * governor exposes those knobs directly so an overloaded frame actually makes
 * the expensive scenes lighter, which is the only thing that keeps butter-smooth
 * playback once the visuals get genuinely heavy (fractals, liquids, stacks).
 *
 * A tier is a coherent bundle of knobs. `auto` walks the tiers from measured
 * frame time with hysteresis; fixed qualities pin a tier. Scenes never read the
 * store or FPS themselves — they read `quality.knobs`.
 */
export interface QualityKnobs {
  /**
   * Fraction of a scene's DECLARED `pixelBudget` this tier will fund.
   *
   * Not a device-pixel-ratio multiplier — that was the old shape, and it made
   * one number stand for every scene on every display. The engine now solves
   * the actual canvas scale from the budget the live composition declares (see
   * engine/renderScale.ts); this is the tier's hand on that solve.
   *
   * It scales the BUDGET rather than the resulting scale because budget is in
   * megapixels and per-pixel cost is linear in megapixels, so 0.49 here means
   * "this frame may do 49% of the pixel work" — which is what a tier is
   * actually trying to say. The linear scale that follows is its square root.
   */
  pixelBudgetScale: number
  /** Max raymarch iterations (uMaxSteps early-break in RAYMARCH_GLSL). */
  raymarchSteps: number
  /** fbm octaves (uOctaves early-break in NOISE3D_GLSL). */
  noiseOctaves: number
  /** Jacobi pressure iterations for the fluid solver. */
  fluidJacobi: number
  /** Fraction of the full particle budget to draw (setDrawRange). */
  particleFraction: number
  /**
   * TOTAL frame capacity in MILLISECONDS, including the fixed per-frame costs
   * tracked in frameLoad.ts.
   *
   * Taken from `TIER_BUDGET_MS`, which is the single definition. This used to
   * declare its own copy of the ladder, so the numbers the code enforced and
   * the numbers the calibration comments described were two separate arrays
   * that only happened to match.
   *
   * It was `layerBudget`, in an abstract unit priced from a hand-written
   * `low`/`medium`/`high` label. Both halves of that were wrong: the name said
   * "layers" for a figure that has always covered the primary, the crossfade
   * overlap, effects and the post chain too, and the unit was unrelated to cost
   * (see engine/sceneCost.ts). Renamed with the currency in it so the next
   * reader cannot mistake 11 for a count of anything.
   */
  frameBudgetMs: number
}

/**
 * Tier ladder, richest (0) → survival (4). Chosen so each step roughly halves
 * the marginal cost of the dominant term while staying visually close: step
 * count and octaves fall first (raymarch dominates), then fluid/particles.
 *
 * `pixelBudgetScale` is the square of the linear resolution ladder this tier
 * used to name directly (1.0 / 0.85 / 0.7 / 0.58 / 0.48), because cost is linear
 * in pixel COUNT and the old numbers were linear in pixel WIDTH. Keeping the
 * squares means the ladder still steps the frame's pixel work by exactly the
 * same ratios it always did — the calibration survives the change of units, and
 * only the way that ratio reaches the canvas is new (engine/renderScale.ts).
 */
const TIERS: QualityKnobs[] = [
  {
    pixelBudgetScale: 1.0,
    raymarchSteps: 96,
    noiseOctaves: 4,
    fluidJacobi: 20,
    particleFraction: 1.0,
    frameBudgetMs: TIER_BUDGET_MS[0],
  },
  {
    pixelBudgetScale: 0.72,
    raymarchSteps: 72,
    noiseOctaves: 4,
    fluidJacobi: 16,
    particleFraction: 0.8,
    frameBudgetMs: TIER_BUDGET_MS[1],
  },
  {
    pixelBudgetScale: 0.49,
    raymarchSteps: 54,
    noiseOctaves: 3,
    fluidJacobi: 12,
    particleFraction: 0.6,
    frameBudgetMs: TIER_BUDGET_MS[2],
  },
  {
    pixelBudgetScale: 0.34,
    raymarchSteps: 40,
    noiseOctaves: 3,
    fluidJacobi: 10,
    particleFraction: 0.45,
    frameBudgetMs: TIER_BUDGET_MS[3],
  },
  {
    pixelBudgetScale: 0.23,
    raymarchSteps: 28,
    noiseOctaves: 2,
    fluidJacobi: 8,
    particleFraction: 0.33,
    frameBudgetMs: TIER_BUDGET_MS[4],
  },
]

/** Fixed store qualities map onto a pinned tier. */
/**
 * The tier a fixed quality setting pins to — now a CEILING rather than a pin.
 * See {@link QualityGovernor.setMode} for why that distinction was a bug.
 */
const FIXED_TIER: Record<'low' | 'medium' | 'high', number> = { low: 4, medium: 2, high: 0 }

/**
 * Tiers of complexity given up while two primary scenes share the frame.
 *
 * A crossfade renders BOTH scenes at full cost for its whole duration (~1 s at
 * 120 BPM), and a warming candidate renders alongside the current scene too. So
 * for about a second per transition the frame carries twice the scene work it
 * was tiered for — which is why transitions stuttered even when the steady
 * state was fine, and why it happened on essentially every switch rather than
 * randomly.
 *
 * The existing `bothHeavy && !fundsOverlap` hard-cut does not cover it: at tier
 * 0 the budget is 8 and two `high` scenes cost 4 each, so `canFundOverlap`
 * passes and even the heaviest pair crossfades. Every medium/low pair always
 * crossfades. Cutting more aggressively would trade the problem for a worse
 * one — the dissolve is the feature.
 *
 * Two tiers roughly halves each scene's shader work, so two discounted scenes
 * cost about what one undiscounted scene did. The frame stays inside its budget
 * without the transition losing its shape.
 *
 * This is affordable ONLY because a tier's knobs split into two kinds (see
 * RENDER_SCALE_HOLD_SEC in PerfMonitor): complexity is free to change because
 * scenes read `quality.knobs` every frame, while `pixelBudgetScale` costs a
 * renderer resize. The discount therefore touches complexity only — resizing the
 * canvas at the start of every crossfade would cost far more than it saved.
 *
 * Nobody can resolve fine raymarch detail through a one-second dissolve, which
 * is what makes this the cheapest quality in the frame to sell.
 */
const TRANSITION_DISCOUNT_TIERS = 2

/**
 * Frame-time thresholds, as MULTIPLES OF THE DISPLAY REFRESH INTERVAL.
 *
 * They used to be absolute milliseconds (step down above 20 ms mean or 34 ms
 * p95) and that was measurably wrong, in a way that made the governor inert on
 * exactly the machines that needed it.
 *
 * `requestAnimationFrame` is vsync-locked, so frame time is QUANTISED to
 * multiples of the refresh interval. At 60 Hz there is no such thing as a
 * 22 ms frame — you get 16.7, 33.3, 50.0. That gives a show which is steadily
 * dropping about one frame in eight a signature of roughly `mean 18.7`,
 * `p95 33.3`... and the old gates were 20 and 34. Both sat just ABOVE the
 * failure they existed to catch, so the governor watched the frame rate fall
 * over and did nothing. (Observed in the field before it was understood: a
 * panel reading exactly `mean 18.7ms p95 32.3ms` with the tier pinned.)
 *
 * Absolute numbers were also wrong for any display that is not 60 Hz. On a
 * 144 Hz panel the interval is 6.9 ms, so a p95 of 20 ms is three dropped
 * frames and the old thresholds called it healthy.
 *
 * Expressed as ratios, the intent is legible and refresh-independent:
 *   - step DOWN when the mean is consistently late (>10% over one interval),
 *     or when the tail is reaching a second interval (>1.5x).
 *   - climb only when the mean is essentially at the interval and the tail has
 *     not started to stretch.
 */
const STEP_DOWN_MEAN_RATIO = 1.1 // ~18.3 ms at 60 Hz — consistently late
const STEP_DOWN_P95_RATIO = 1.5 // ~25.0 ms at 60 Hz — the tail hits 2 frames
const STEP_UP_MEAN_RATIO = 1.05 // ~17.5 ms at 60 Hz — riding the interval
const STEP_UP_P95_RATIO = 1.25 // ~20.8 ms at 60 Hz — tail still tight

/** Assumed refresh until PerfMonitor measures the real one. */
const DEFAULT_REFRESH_MS = 1000 / 60

const SETTLE_SEC = 2 // min seconds between any change (avoid oscillation)
/**
 * Display intervals a real monitor actually runs at, in milliseconds.
 *
 * 240, 165, 144, 120, 90, 75 and 60 Hz. Not exhaustive, and it does not need to
 * be — {@link snapToRefreshInterval} falls through to the raw estimate for
 * anything that does not match.
 */
const STANDARD_INTERVALS_MS = [1000 / 240, 1000 / 165, 1000 / 144, 1000 / 120, 1000 / 90, 1000 / 75, 1000 / 60]

/** How far a measurement may sit from a standard interval and still snap to it. */
const SNAP_TOLERANCE = 0.12

/**
 * Round a measured frame interval to the display rate it is obviously trying to
 * be (F119).
 *
 * ## The measurement runs LOW, and the thresholds are tighter than the error
 *
 * `PerfMonitor` estimates the interval from the 10th percentile of frame times,
 * on the stated reasoning that "rAF is vsync-locked, so a frame can be LATE (a
 * multiple of the interval) but essentially never early — the fast tail is
 * therefore the interval".
 *
 * **The second half of that is false**, and a session recording measured how
 * false: on a locked 60 Hz display, 13.3% of frames came in under 16.0 ms, and
 * 76% of those immediately followed a LATE frame. That is the compositor
 * catching up — a long frame is followed by a short one, so the fast tail sits
 * BELOW the interval rather than on it. The p10 came out at 15.70 ms against a
 * true 16.67.
 *
 * A 6% underestimate would not matter if the governor's gates were loose. They
 * are not: it demotes above `1.1x` and only calls a frame steady below `1.05x`.
 * At `refreshMs = 15.70` that puts the demote line at 17.27 ms and the STEADY
 * line at 16.48 — **below the vsync interval itself**. A machine hitting a
 * flawless 60 fps could therefore never be judged steady, and sat 0.6 ms under
 * the demote line all night. The same recording shows exactly that: a demotion
 * at `ema 16.67`, and 69% of the session spent at the survival tier on hardware
 * that was never once late.
 *
 * Snapping fixes the shape of the error rather than the ratios. The p10 is still
 * the right ESTIMATOR — it is what resists a machine that is dropping most of
 * its frames, where a median would report the achieved rate instead of the
 * interval — it just needs rounding to the grid of rates a display can actually
 * run at. 15.70 snaps to 16.67; a 144 Hz panel's ~6.5 snaps to 6.94.
 *
 * Anything not within {@link SNAP_TOLERANCE} of a known rate is passed through
 * untouched, so an unusual display degrades to the old behaviour rather than
 * being snapped to a rate it is not running at.
 */
export function snapToRefreshInterval(ms: number): number {
  if (!isFinite(ms) || ms <= 0) return ms
  let best = ms
  let bestErr = SNAP_TOLERANCE
  for (const candidate of STANDARD_INTERVALS_MS) {
    const err = Math.abs(ms - candidate) / candidate
    if (err < bestErr) {
      bestErr = err
      best = candidate
    }
  }
  return best
}

const CLIMB_HOLD_SEC = 4 // sustained headroom required before climbing back

/**
 * How long a rung must survive after a climb before the climb counts as a
 * SUCCESS rather than a failed probe (F149).
 *
 * ## The governor had no memory, and one machine's ladder had no top
 *
 * `tick()` climbs whenever the frame has been steady for {@link CLIMB_HOLD_SEC}
 * and the tier is above the ceiling. Nothing recorded that a rung had already
 * been tried and lost, so on hardware that cannot hold its top rung the
 * controller has no fixed point: it climbs, overloads, demotes, waits out the
 * hold, and climbs into the identical failure again, forever.
 *
 * Session `audiovis-session-2026-08-29-16-29-40` is 320 s of exactly that.
 * Store quality `high`, so `FIXED_TIER.high = 0` puts the ceiling at the top
 * rung; the machine (RTX 4060 laptop, ANGLE/D3D11, 2560x1440 at `baseDpr` 1.5)
 * cannot hold tier 0, because tier 0 there means a 4K internal frame:
 *
 *     7.80 MP   p50 16.80 ms   38% of samples over 16.9 ms
 *     8.29 MP   p50 20.88 ms   95% of samples over 16.9 ms
 *
 * 20.88 is 16.67 x 1.25 — the frame has stopped riding vsync and settled into
 * dropping one in four. The governor climbed into it **13 times**, held it
 * 2.0-8.0 s each time, and was demoted out of it 13 times. 0 successes.
 *
 * The cost is not the wasted rung. It is that every one of those 26 tier moves
 * forces a render-scale change, and a render-scale change reallocates the whole
 * `EffectComposer` (F140): 97 of the session's 105 scale changes follow a tier
 * change within 3.6 s, and 100% of its 213 frames over 33 ms land within 2 s of
 * a tier/scale/scene event. Away from those events the same session holds a
 * flat 16.66-16.70 ms at every resolution up to 7.8 MP. The controller was the
 * entire load.
 *
 * ## Why a probe window rather than "demoted at all"
 *
 * A demote shortly after a climb is evidence the rung is unaffordable. A demote
 * a minute later is evidence the WORKLOAD changed — a heavier scene, a layer
 * admitted, a window resized — and blaming the rung for that would ratchet the
 * ladder down over a long show and never let it back up.
 *
 * 10 s is chosen against the observed failures rather than in the abstract: all
 * 13 of that session's tier-0 tenancies ended inside 8.0 s, and the shortest
 * legitimate reason to demote from a rung that genuinely fits is a scene change,
 * which `SETTLE_SEC` and the transition discount already absorb.
 */
const RUNG_PROOF_SEC = 10

/**
 * First back-off after a rung fails its probe, in seconds, doubling per
 * consecutive failure up to {@link MAX_RUNG_BACKOFF_SEC}.
 *
 * Back-off rather than a permanent latch, because "this rung is unaffordable"
 * is a statement about a moment, not about the machine: the cliff moves when the
 * window is resized, when a cheap scene replaces an expensive one, when layers
 * are shed. A latch would be right more often than the old behaviour and wrong
 * forever when it was wrong. Doubling keeps the cost of being wrong bounded —
 * a rung that really is affordable is re-probed within 20 s and then held, and
 * its failure count resets the moment it survives.
 *
 * Against the session above: attempts land at roughly t, +20, +60, +140, +300
 * instead of every ~25 s — 4 or 5 probes over 320 s instead of 13, and 12 of the
 * 13 demote cascades never happen.
 */
const RUNG_BACKOFF_SEC = 20
const MAX_RUNG_BACKOFF_SEC = 240

/**
 * Consecutive-overbudget emergency path (audit c11, "the move" item 3).
 *
 * ## The gap this closes
 *
 * `overloaded` above is computed from `emaMs` (a 0.05-alpha smoothed average
 * in PerfMonitor.tsx) and a 10 s-windowed p95. Both are deliberately slow —
 * that is what makes them resistant to a single stray frame — but slow
 * cuts both ways: a 0.05-alpha EMA takes on the order of a SECOND to react
 * to a genuine step change in load, and it does so while every one of those
 * frames is still being dropped. Unreal's dynamic-resolution heuristic
 * (`MaxConsecutiveOverbudgetGPUFrameCount`) exists for exactly this reason:
 * a small run of consecutive bad RAW frames is evidence a smoothed estimator
 * cannot afford to wait out.
 *
 * `CONSECUTIVE_OVERBUDGET_RATIO` reuses {@link STEP_DOWN_MEAN_RATIO} rather
 * than inventing a second threshold with its own justification — "one frame
 * this late" means the same thing here as it does to the smoothed gate, only
 * counted instead of averaged. `CONSECUTIVE_OVERBUDGET_FRAMES` is chosen, not
 * measured (this codebase has no session log with raw per-frame data captured
 * this way yet — see F162's own `sceneCost.ts` caveats on the difference
 * between the two): long enough that one compile hitch or GC pause cannot
 * trigger it, short enough (5 frames is ~83 ms at 60 Hz) to react roughly an
 * order of magnitude faster than the EMA path above. Revisit against a real
 * corpus once one exists that captures raw frame times alongside tier events
 * at this resolution.
 */
const CONSECUTIVE_OVERBUDGET_RATIO = STEP_DOWN_MEAN_RATIO
const CONSECUTIVE_OVERBUDGET_FRAMES = 5

/**
 * Exported for tests only — production code uses the {@link quality} singleton.
 *
 * The governor is deliberately stateful (two hysteresis timers and a tier), so
 * a test that drives the singleton inherits whatever the previous test left
 * behind and asserts against the wrong starting conditions. A fresh instance
 * per test is the only way to pin the step-up/step-down logic honestly.
 */
export class QualityGovernor {
  /** Current tier index; starts one rung down so we boot into headroom, not the fire. */
  tier = 1
  knobs: QualityKnobs = TIERS[1]

  private auto = true
  private lastChangeAt = 0
  private goodSince = 0
  /** 0..1 — how far into the transition discount we are. Eased by the caller
   *  so complexity slides rather than snapping; see TRANSITION_DISCOUNT_TIERS. */
  private discount = 0
  /** Mutated in place while discounting, so the ease allocates nothing. */
  private readonly discounted: QualityKnobs = { ...TIERS[0] }
  /** Measured display refresh interval; thresholds are relative to it. */
  /**
   * Richest tier the ladder may climb to, from the store's quality setting.
   *
   * 0 means "no ceiling" — which is also tier 0, the richest rung, so `auto`
   * and `high` differ only in that `high` re-asserts it on selection. The
   * ceiling never blocks a DEMOTION: shedding load is the governor's job and a
   * quality preference is not permission to drop frames instead.
   */
  private ceiling = 0
  private refreshMs = DEFAULT_REFRESH_MS

  /**
   * Per-rung probe state for {@link RUNG_PROOF_SEC} (F149).
   *
   * `blockedUntil[t]` is the elapsed time before which the ladder may not climb
   * INTO tier `t`; `failures[t]` is the consecutive-failure count that sets the
   * back-off. Indexed by tier, so the memory is per-rung rather than global — a
   * machine that cannot hold tier 0 can still climb freely to tier 1.
   *
   * Demotion is never blocked. This gates the climb only; shedding load stays
   * unconditional, which is the same contract the quality ceiling has.
   */
  private readonly blockedUntil = new Array<number>(TIERS.length).fill(0)
  private readonly failures = new Array<number>(TIERS.length).fill(0)
  /** Rung the last climb entered, and when — the probe being timed. */
  private probeTier = -1
  private probeAt = 0
  /** Consecutive raw frames over {@link CONSECUTIVE_OVERBUDGET_RATIO} — see
   *  that constant's doc. Reset on any frame that clears the ratio, and while
   *  a transition discount is active (a crossfade's own expected extra cost
   *  must not read as an emergency). */
  private consecutiveOverbudget = 0

  /**
   * Richest tier each scene has actually been observed HOLDING, and the scene
   * currently on screen (F164).
   *
   * ## The gap this closes
   *
   * The tier is one global number and the fill cost is per-scene. In
   * `audiovis-session-2026-08-31-16-47-12` the ladder climbed to tier 0 at
   * 98.43 s on `wingfold`, which had been sitting flat at 16.7 ms, and 0.32 s
   * later handed that setting to `maze` — which cannot hold it. Maze then spent
   * 2.6 s over budget and the ladder conceded four rungs and four resizes in
   * six seconds getting back out. The rung was proven, but it was proven
   * against a scene that was no longer on screen.
   *
   * ## Why this is measured rather than priced
   *
   * `sceneCost.ts` exists and is the obvious place to look, and it cannot
   * answer this question: it prices a scene per TIER with no megapixel
   * denominator, so `maze` reads as the cheapest scene in the roster (0.42 ms)
   * on the strength of a sweep taken at its own low `pixelBudget` solve. Its
   * own header says so — "these rows are a floor for those, not a ceiling".
   * Using it here would have predicted exactly the wrong thing for exactly the
   * scene that failed. So this learns the same way {@link blockedUntil} does:
   * from what the machine has actually been seen doing.
   *
   * Lower index = richer. `undefined` means "never measured on this display",
   * which is treated as one rung of caution rather than as a verdict.
   */
  private readonly provenTier = new Map<string, number>()
  private sceneId = ''
  private sceneTierSince = 0

  /**
   * Tell the governor the display's actual refresh interval in milliseconds.
   *
   * Clamped to a sane range so a bad measurement (a backgrounded tab throttling
   * rAF to 1 Hz, a burst of stalls early in the session) cannot move the
   * thresholds somewhere absurd and either pin the tier at 0 forever or walk it
   * to the floor. 4 ms covers 240 Hz; 21 ms covers 48 Hz.
   */
  /** The display interval the thresholds are ratios of. Read-only to callers. */
  get refreshIntervalMs(): number {
    return this.refreshMs
  }

  setRefreshInterval(ms: number): void {
    ms = snapToRefreshInterval(ms)
    if (!Number.isFinite(ms)) return
    this.refreshMs = Math.min(21, Math.max(4, ms))
  }

  /**
   * Tell the governor that two primary scenes are on screen at once (a
   * crossfade, or a warming candidate rendering beside the current scene).
   *
   * Complexity drops by {@link TRANSITION_DISCOUNT_TIERS} while set; the render
   * scale and the composition budget deliberately do not move. Idempotent, so
   * SceneManager can call it every frame with the current state.
   */
  setTransitionDiscount(amount: number): void {
    const next = Math.min(1, Math.max(0, amount))
    // Quantised so a continuously-easing caller does not rebuild the knobs on
    // every single frame for a change nobody can see.
    if (Math.abs(next - this.discount) < 0.02 && next !== 0 && this.discount !== 0) return
    this.discount = next
    this.applyKnobs()
  }

  /**
   * Pin an exact tier index, bypassing the auto walker.
   *
   * `setMode` only reaches tiers 4/2/0 (the three store qualities), which is
   * right for a user-facing control but not for the benchmark harness — it has
   * to sweep every rung to show how a scene's cost actually scales, and tiers 1
   * and 3 are unreachable otherwise. Clamped by `setTier`.
   */
  pinTier(t: number): void {
    this.auto = false
    this.clearRungMemory()
    this.setTier(t)
  }

/**
   * Apply a store quality setting.
   *
   * ## `high` used to mean "turn the governor off" (F116)
   *
   * A fixed mode set `auto = false`, and `tick()` returns on its first line
   * when that is false — so choosing a quality did not bias the ladder, it
   * DELETED it. With `FIXED_TIER.high = 0` that made "high" mean "pin tier 0
   * and never adapt again", which is not what anyone picking a quality
   * preference is asking for.
   *
   * Caught by the first session recording (F115), and it is the whole
   * explanation for the 4K lag: 77 seconds at a p95 of 80-96 ms with
   * **zero tier changes**. The demote threshold was `ema > 8.9 ms` against a
   * measured ema of 20-45 ms, so the governor was not merely slow to react, it
   * was never consulted. Every previous theory about that lag — post-chain
   * cost, the hold in PerfMonitor (F114), scenes that ignore the knobs (F111) —
   * was real but secondary; none of them mattered while the ladder was inert.
   *
   * A fixed mode is now a CEILING. `auto` stays on, the governor keeps
   * measuring and keeps its authority to shed load, and the setting caps how
   * far back UP it may climb. `high` therefore means "give me tier 0 when the
   * machine can hold it", which is what it always claimed to mean, and a
   * machine that cannot hold it still gets rescued.
   *
   * `auto` clears the ceiling entirely.
   */
  setMode(q: 'auto' | 'low' | 'medium' | 'high'): void {
    this.auto = true
    this.clearRungMemory()
    if (q === 'auto') {
      this.ceiling = 0
      return
    }
    this.ceiling = FIXED_TIER[q]
    // Start AT the ceiling rather than wherever the ladder happens to be: the
    // setting is an explicit instruction and should look immediate, which is
    // the same argument PerfMonitor's hold makes for a user-pinned change.
    if (this.tier < this.ceiling) this.setTier(this.ceiling)
  }

  /**
   * Auto tick — call once per frame with the smoothed frame time and the p95 of
   * the raw frame times over the recent window.
   *
   * `p95Ms` defaults to 0, which makes the variance axis inert. That keeps the
   * two-argument call valid for callers (and tests) that only have a mean, and
   * a caller with no percentile data reproduces exactly the previous behaviour
   * rather than being silently held at a low tier by a missing signal.
   *
   * `rawMs`, if given, is THIS frame's own unsmoothed time — see
   * {@link CONSECUTIVE_OVERBUDGET_FRAMES}'s doc for why the smoothed axes
   * above cannot substitute for it. Optional and additive: omitted, the
   * emergency path below never fires and every existing caller/test keeps
   * its exact previous behaviour.
   */
  tick(emaMs: number, elapsedSec: number, p95Ms = 0, rawMs?: number): void {
    if (!this.auto) return
    const r = this.refreshMs
    // Steady means BOTH axes clear: riding the refresh interval on average, and
    // free of hitches.
    const steady = emaMs < r * STEP_UP_MEAN_RATIO && p95Ms < r * STEP_UP_P95_RATIO
    // Overloaded if EITHER axis is bad — a spiky frame budget needs relief just
    // as much as a uniformly slow one, and only the p95 can see it.
    const overloaded = emaMs > r * STEP_DOWN_MEAN_RATIO || p95Ms > r * STEP_DOWN_P95_RATIO

    // Consecutive-overbudget emergency (see the constants' own doc). Tracked
    // and actable BEFORE the SETTLE_SEC gate below, on purpose — the whole
    // point is reacting faster than the normal hysteresis allows, the same
    // "a crisis earns an escape hatch" argument PerfMonitor's own
    // SCALE_EMERGENCY_RATIO makes for the render-scale hold. A transition
    // discount means the frame is EXPECTED to run heavier for about a
    // second, so the streak is suspended (not merely paused mid-count) for
    // its duration rather than let a normal crossfade read as a crisis.
    if (this.discount > 0) {
      this.consecutiveOverbudget = 0
    } else if (rawMs !== undefined && Number.isFinite(rawMs)) {
      if (rawMs > r * CONSECUTIVE_OVERBUDGET_RATIO) {
        this.consecutiveOverbudget += 1
      } else {
        this.consecutiveOverbudget = 0
      }
      if (this.consecutiveOverbudget >= CONSECUTIVE_OVERBUDGET_FRAMES && this.tier < TIERS.length - 1) {
        this.consecutiveOverbudget = 0
        // A rung failing this fast is failing its probe just as surely as
        // the smoothed path's own demote does — same back-off bookkeeping.
        if (this.probeTier === this.tier && elapsedSec - this.probeAt < RUNG_PROOF_SEC) {
          const n = (this.failures[this.tier] += 1)
          const wait = Math.min(MAX_RUNG_BACKOFF_SEC, RUNG_BACKOFF_SEC * Math.pow(2, n - 1))
          this.blockedUntil[this.tier] = elapsedSec + wait
        }
        this.probeTier = -1
        this.setTier(this.tier + 1)
        this.lastChangeAt = elapsedSec
        this.goodSince = elapsedSec
        return
      }
    }

    // A rung that has survived {@link RUNG_PROOF_SEC} is affordable after all:
    // forgive its failure history rather than letting one bad minute compound
    // into a back-off it no longer deserves. Checked before the SETTLE gate and
    // before the blocked-climb return below, so it runs on every tick whatever
    // the ladder does next.
    if (this.probeTier === this.tier && elapsedSec - this.probeAt >= RUNG_PROOF_SEC) {
      this.failures[this.tier] = 0
      this.probeTier = -1
    }
    // F164: the live scene has now held this rung for the same proof window,
    // steadily. Record it, so the next commit of this scene may enter here
    // directly instead of paying a rung of caution. Tenure runs from whichever
    // came last, the scene arriving or the tier moving — both restart the
    // claim, because the pair is what is being proven.
    if (this.sceneId && steady) {
      const tenureFrom = Math.max(this.sceneTierSince, this.lastChangeAt)
      if (elapsedSec - tenureFrom >= RUNG_PROOF_SEC) {
        const best = this.provenTier.get(this.sceneId)
        if (best === undefined || this.tier < best) this.provenTier.set(this.sceneId, this.tier)
      }
    }
    if (elapsedSec - this.lastChangeAt < SETTLE_SEC) {
      if (steady) this.goodSince = Math.max(this.goodSince, this.lastChangeAt)
      return
    }
    if (overloaded && this.tier < TIERS.length - 1) {
      // A demote soon after climbing INTO this rung is the rung failing its
      // probe, not the workload changing — record it and back off (F149).
      if (this.probeTier === this.tier && elapsedSec - this.probeAt < RUNG_PROOF_SEC) {
        const n = (this.failures[this.tier] += 1)
        const wait = Math.min(MAX_RUNG_BACKOFF_SEC, RUNG_BACKOFF_SEC * Math.pow(2, n - 1))
        this.blockedUntil[this.tier] = elapsedSec + wait
      }
      this.probeTier = -1
      this.setTier(this.tier + 1)
      this.lastChangeAt = elapsedSec
      this.goodSince = elapsedSec
    } else if (steady && this.tier > this.ceiling) {
      if (elapsedSec - this.goodSince > CLIMB_HOLD_SEC) {
        const target = this.tier - 1
        if (elapsedSec < this.blockedUntil[target]) {
          // Rung is serving a back-off. Hold here and keep the steady credit,
          // so the climb happens on the frame the block expires rather than
          // CLIMB_HOLD_SEC after it.
          return
        }
        this.probeTier = target
        this.probeAt = elapsedSec
        this.setTier(target)
        this.lastChangeAt = elapsedSec
        this.goodSince = elapsedSec
      }
    } else if (this.discount <= 0) {
      this.goodSince = elapsedSec
    }
    // While `this.discount > 0` this tick falls into neither branch above —
    // hold `goodSince` exactly where it was rather than resetting it (F182).
    //
    // ## A commit's own transition was silently disqualifying every climb
    //
    // `frameSampler.ts` exists specifically so the governor "never measures a
    // known one-off" — a scene commit's crossfade is real load and the display
    // still reports it, but it is not evidence about STEADY-STATE cost, which
    // is the only thing this axis should respond to. That rule was wired into
    // the p95 input (`FrameSampler.suspend`) and into the raw-frame emergency
    // path above (`if (this.discount > 0) { this.consecutiveOverbudget = 0 }`)
    // — but never into this smoothed path. `emaMs` is computed in
    // `PerfMonitor.tsx` as a plain EMA over every frame with no knowledge of
    // `frameSampler`'s suspension at all, so a crossfade's doubled fill cost
    // (TRANSITION_DISCOUNT_TIERS only halves the shader-complexity half of
    // that, not the fact that two primaries are drawing) reliably lands `emaMs`
    // in the dead zone between `STEP_UP_MEAN_RATIO` and `STEP_DOWN_MEAN_RATIO`
    // for roughly `crossfadeDuration` (0.7-2 s) around every single commit —
    // which used to fall straight into the `else` above and reset `goodSince`.
    //
    // A session recording (`audiovis-session-2026-08-31-*`, 123 s, all
    // `appliedTier: 4`, **zero climbs the entire session**) is exactly this: it
    // measured `mean 16.7 ms / p95 18.0 ms / effective fps 59.8` — genuinely
    // steady, comfortably inside `STEP_UP_MEAN_RATIO`'s ~17.5 ms line — and
    // `mean gpuMs 1.45 / p95 3.12`, a GPU share of only 9% of the frame. There
    // was nothing overloaded to shed and nothing forcing it back to the floor;
    // it simply never accumulated `CLIMB_HOLD_SEC` (4 s) of uninterrupted
    // "steady" between scene changes, because every commit's own transition
    // re-armed the clock before it got there. The demote branch above is left
    // untouched on purpose — `quality governor — transition discount ›
    // "survives a tier change while discounting"` pins that a genuinely bad
    // reading must still shed load even mid-crossfade; only the false-negative
    // that blocked CLIMBING is closed here.
  }

  /**
   * A new primary scene has committed (F164).
   *
   * Called by `SceneManager` on the commit, not on the request: a warming
   * candidate is not yet the thing the frame is paying for, and clamping on a
   * request would penalise a scene that never arrives (see F163 for one that
   * did not).
   *
   * The rule is deliberately the smallest one that removes the observed
   * failure: **do not enter a scene at a tier that scene has never held.** A
   * scene with a proven rung enters at it; a scene with no record enters one
   * rung down from wherever the ladder happens to be and re-probes from there.
   * It is never a ratchet — `tick` climbs back out of the caution on its normal
   * hysteresis, and the first time the scene holds a richer rung for
   * {@link RUNG_PROOF_SEC} that becomes the new record.
   *
   * Only ever moves the tier CHEAPER. Entering a scene richer than the ladder
   * currently sits is what the climb is for, and it has its own evidence.
   *
   * Idempotent per scene id, so a caller may invoke it on every commit without
   * checking whether the id actually changed.
   */
  enterScene(id: string, elapsedSec: number): void {
    if (!id || id === this.sceneId) return
    this.sceneId = id
    this.sceneTierSince = elapsedSec
    if (!this.auto) return
    const proven = this.provenTier.get(id)
    const cap = proven ?? Math.min(TIERS.length - 1, this.tier + 1)
    if (cap <= this.tier) return
    this.setTier(cap)
    // The scene changed, so the steady credit the old one earned is stale, and
    // the rung this just entered is not a probe the ladder chose — it must not
    // be charged to `blockedUntil` if the new scene turns out to be expensive.
    this.probeTier = -1
    this.lastChangeAt = elapsedSec
    this.goodSince = elapsedSec
  }

  /**
   * Forget which rungs have failed their probe (F149).
   *
   * Called from {@link setMode} and {@link pinTier}, which between them cover
   * both events that invalidate the memory: a change of quality preference, and
   * a change of DISPLAY — `PerfMonitor` re-runs `setMode` in the same effect
   * that calls `renderScale.setDisplay`, so resizing the window or dragging it
   * to another monitor clears the record. That matters because "this rung is
   * unaffordable" is a claim about a pixel count: shrink the window and the top
   * rung may become affordable, and waiting out a 240 s back-off to discover
   * that would be its own bug.
   */
  private clearRungMemory(): void {
    this.blockedUntil.fill(0)
    this.failures.fill(0)
    this.probeTier = -1
    this.consecutiveOverbudget = 0
    // F164's record is a claim about a pixel count too — a resized window or a
    // different monitor invalidates "maze cannot hold tier 0" exactly as it
    // invalidates "tier 0 is unaffordable". Cleared on the same signal, for the
    // same reason.
    this.provenTier.clear()
    // The scene on screen is forgotten along with it, which suspends PROVING
    // until the next commit re-arms it. That is the conservative reading and
    // the right one: immediately after a resize the current tier has not been
    // demonstrated at the new pixel count either, and re-proving it from a
    // tenure clock that started on the old display would write down a claim
    // nothing has tested.
    this.sceneId = ''
    this.sceneTierSince = 0
  }

  private setTier(t: number): void {
    this.tier = Math.max(0, Math.min(TIERS.length - 1, t))
    this.applyKnobs()
  }

  /** Rebuild `knobs` from the current tier and discount amount. */
  private applyKnobs(): void {
    const base = TIERS[this.tier]
    if (this.discount <= 0) {
      this.knobs = base
      return
    }
    const cheaper = TIERS[Math.min(TIERS.length - 1, this.tier + TRANSITION_DISCOUNT_TIERS)]
    const a = this.discount
    const mix = (from: number, to: number) => from + (to - from) * a
    const d = this.discounted

    // Resizing the canvas at the start of every crossfade would cost a renderer
    // reallocation — far more than the discount saves.
    d.pixelBudgetScale = base.pixelBudgetScale
    // Composition is decided at phrase boundaries and must not flip because a
    // transition happens to be in flight; that would drop layers mid-fade.
    d.frameBudgetMs = base.frameBudgetMs
    // NOT discounted, despite being the cheapest win available. It drives
    // `setDrawRange`, so cutting it makes points literally VANISH — at tier 1
    // the discount would remove 44% of `plasma`'s 70k cloud, which reads as a
    // glitch rather than as a quality change. The whole premise of discounting
    // through a dissolve is that nobody can see it; this one they can.
    d.particleFraction = base.particleFraction

    // Loop bounds: they change fine detail, not the existence of anything, so
    // they slide invisibly.
    d.raymarchSteps = Math.round(mix(base.raymarchSteps, cheaper.raymarchSteps))
    d.noiseOctaves = Math.max(1, Math.round(mix(base.noiseOctaves, cheaper.noiseOctaves)))
    d.fluidJacobi = Math.max(1, Math.round(mix(base.fluidJacobi, cheaper.fluidJacobi)))

    this.knobs = d
  }
}

export const quality = new QualityGovernor()

/**
 * Fresh uniform bundle for the raymarch/noise complexity knobs. Spread into a
 * ShaderMaterial's `uniforms` so `uMaxSteps` / `uOctaves` (declared inside
 * RAYMARCH_GLSL / NOISE3D_GLSL) resolve; then call {@link applyQualityUniforms}
 * each frame to track the governor.
 */
export function qualityUniforms(): Record<string, IUniform> {
  return {
    uMaxSteps: { value: TIERS[0].raymarchSteps },
    uOctaves: { value: TIERS[0].noiseOctaves },
  }
}

/** Push the governor's current complexity knobs into a scene's uniforms. */
export function applyQualityUniforms(u: Record<string, IUniform>): void {
  if (u.uMaxSteps) u.uMaxSteps.value = quality.knobs.raymarchSteps
  if (u.uOctaves) u.uOctaves.value = quality.knobs.noiseOctaves
}
