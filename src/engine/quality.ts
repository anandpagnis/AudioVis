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
const CLIMB_HOLD_SEC = 4 // sustained headroom required before climbing back

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
  private refreshMs = DEFAULT_REFRESH_MS

  /**
   * Tell the governor the display's actual refresh interval in milliseconds.
   *
   * Clamped to a sane range so a bad measurement (a backgrounded tab throttling
   * rAF to 1 Hz, a burst of stalls early in the session) cannot move the
   * thresholds somewhere absurd and either pin the tier at 0 forever or walk it
   * to the floor. 4 ms covers 240 Hz; 21 ms covers 48 Hz.
   */
  setRefreshInterval(ms: number): void {
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
    this.setTier(t)
  }

  /** Pin to a fixed store quality, or hand control back to the auto walker. */
  setMode(q: 'auto' | 'low' | 'medium' | 'high'): void {
    if (q === 'auto') {
      this.auto = true
      return
    }
    this.auto = false
    this.setTier(FIXED_TIER[q])
  }

  /**
   * Auto tick — call once per frame with the smoothed frame time and the p95 of
   * the raw frame times over the recent window.
   *
   * `p95Ms` defaults to 0, which makes the variance axis inert. That keeps the
   * two-argument call valid for callers (and tests) that only have a mean, and
   * a caller with no percentile data reproduces exactly the previous behaviour
   * rather than being silently held at a low tier by a missing signal.
   */
  tick(emaMs: number, elapsedSec: number, p95Ms = 0): void {
    if (!this.auto) return
    const r = this.refreshMs
    // Steady means BOTH axes clear: riding the refresh interval on average, and
    // free of hitches.
    const steady = emaMs < r * STEP_UP_MEAN_RATIO && p95Ms < r * STEP_UP_P95_RATIO
    // Overloaded if EITHER axis is bad — a spiky frame budget needs relief just
    // as much as a uniformly slow one, and only the p95 can see it.
    const overloaded = emaMs > r * STEP_DOWN_MEAN_RATIO || p95Ms > r * STEP_DOWN_P95_RATIO

    if (elapsedSec - this.lastChangeAt < SETTLE_SEC) {
      if (steady) this.goodSince = Math.max(this.goodSince, this.lastChangeAt)
      return
    }
    if (overloaded && this.tier < TIERS.length - 1) {
      this.setTier(this.tier + 1)
      this.lastChangeAt = elapsedSec
      this.goodSince = elapsedSec
    } else if (steady && this.tier > 0) {
      if (elapsedSec - this.goodSince > CLIMB_HOLD_SEC) {
        this.setTier(this.tier - 1)
        this.lastChangeAt = elapsedSec
        this.goodSince = elapsedSec
      }
    } else {
      this.goodSince = elapsedSec
    }
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
