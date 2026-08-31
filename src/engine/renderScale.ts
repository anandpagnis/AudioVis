import type { ScenePerformanceCost } from '../scenes'
import { quality } from './quality'

/**
 * Internal-resolution governor: solves the canvas scale from a DECLARED PIXEL
 * BUDGET instead of handing every scene the same fixed multiplier.
 *
 * ## Why the multiplier was the wrong dial
 *
 * A fullscreen raymarcher, an additive particle field, a feedback accumulator —
 * all three cost roughly one unit of work per PHYSICAL pixel, so their frame
 * time tracks the backing store's pixel count and nothing else. A Retina 16"
 * pushes ~2x the fragments of a 1080p monitor off the same GPU, and a 5K panel
 * ~4x. One number cannot serve all three: tuned for the monitor the Retina
 * panel stays slow, tuned for the panel the monitor goes soft.
 *
 * The tier ladder's old `renderScale` was exactly that one number. It was also
 * uniform across the roster, which is the second half of the problem: `orbs`
 * draws three glow blobs and `foldpath` marches a distance estimator, and tier 3
 * told both of them 0.58.
 *
 * ## The dial that replaces it
 *
 * A scene declares `pixelBudget` — the internal megapixels its per-pixel work
 * can afford — and the engine solves the scale that holds that budget on
 * whatever display is actually live:
 *
 *     scale = sqrt(budget / fullResMegapixels)
 *
 * capped at 1 (never supersample past native) and floored at
 * {@link RENDER_SCALE_FLOOR} so a 5K panel cannot mush the picture to nothing.
 *
 * Ported from lilim's `updateRenderScale`, with two additions this codebase
 * needs and that one did not:
 *
 *  - **Composition.** lilim renders one scene; AudioVis stacks a primary, up to
 *    three layers, live effects and a crossfade partner into ONE framebuffer at
 *    ONE resolution. See {@link combinePixelBudgets} — the budgets combine by
 *    reciprocal sum, not by taking the smallest.
 *  - **The tier ladder.** The five tiers still scale the frame, but they now do
 *    it by scaling the BUDGET (`quality.knobs.pixelBudgetScale`) rather than by
 *    naming a resolution. Budget is in megapixels and cost is linear in
 *    megapixels, so multiplying budgets is the operation that means "let this
 *    frame do 49% of the work" — which is what a tier is trying to say.
 *
 * ## Determinism
 *
 * The result is a pure function of (combined budget, display, tier). There is
 * no feedback from measured frame time into the scale — that path runs through
 * the tier ladder, which has its own hysteresis. So the scale settles to one
 * value per (scene, display, tier) triple and stays there instead of hunting,
 * which is what stops the sharpness from pulsing while the picture holds still.
 */

/**
 * Lowest linear scale the solver will ever ask for.
 *
 * 0.4 linear is 16% of the pixels — past that the picture is mush, and the
 * honest response to a machine that still cannot hold the frame is to drop
 * complexity (which the tier ladder is already doing) rather than resolution.
 */
export const RENDER_SCALE_FLOOR = 0.4

/**
 * Budget bounds a declaration has to sit inside, enforced by `validateSceneDef`.
 *
 * The floor exists because a scene declaring 0.05 MP would pin every display to
 * the scale floor and look broken; the ceiling because "no limit" is not
 * something the engine can schedule around — see {@link NATIVE_PIXEL_BUDGET}.
 */
export const MIN_PIXEL_BUDGET = 0.25
export const MAX_PIXEL_BUDGET = 64

/**
 * What a scene declares when its cost is NOT per-pixel: line art, a handful of
 * meshes, anything geometry- or CPU-bound.
 *
 * 32 MP is comfortably past a 5K panel fullscreen (5120x2880 = 14.7 MP) even
 * after the post chain joins the reciprocal sum, so this resolves to scale 1 on
 * every display anyone will plausibly run a show on — the scene renders
 * pixel-perfect, which is the honest answer for work that downscaling would not
 * make cheaper. Raised 16 -> 32 with the rest of the table (F107): it has to
 * stay the LARGEST budget in the module, or "my cost is not per-pixel" would ask
 * for fewer pixels than `low` does.
 *
 * It is a real number rather than a sentinel on purpose. A sentinel would mean
 * "exempt", and an exemption is exactly the thing that lets one scene ignore the
 * governor; a large budget still combines with its neighbours' in
 * {@link combinePixelBudgets} and still shrinks with the tier, so a cheap scene
 * layered under two expensive ones contributes its (small) share of the
 * pressure instead of vanishing from the arithmetic.
 */
export const NATIVE_PIXEL_BUDGET = 32

/**
 * The post chain's OWN pixel budget — `Bloom({ mipmapBlur })` +
 * `ChromaticAberration` + `Vignette`, plus `FeedbackPass`.
 *
 * ## Why the fixed cost needs a budget too
 *
 * Every other budget in this module describes a SCENE. That was the hole: the
 * combine summed the scenes and stopped, so a composition of scenes that are
 * all cheap-per-pixel resolved to `renderScale = 1` — and the post chain, which
 * is the single most fill-bound thing in the frame, then ran at full native
 * resolution behind them.
 *
 * That is not a hypothetical. The boot scene is `wireframe`, which declares
 * `fillBound: false` (correctly — it is edge geometry, downscaling it buys
 * nothing), so it asks for {@link NATIVE_PIXEL_BUDGET} and the solve handed the
 * whole frame full resolution. On a DPR-2 display that is ~5.2 MP through a
 * roughly eighteen-pass mip pyramid, measured at **2 fps / 512 ms per frame**,
 * against 131 ms for the same build at 1.26 MP — a clean 4x, which is what
 * "fill-bound" means. A scene declaring it is not fill-bound was silently
 * speaking for the post chain, which always is.
 *
 * So the chain declares its own budget and joins the reciprocal sum like any
 * other claimant. The effect is exactly where it should be: a 1080p display
 * (2.07 MP) still solves to scale 1 and is untouched, while a high-DPI panel
 * gets scaled down to something its GPU can actually carry.
 *
 * ## Raised 2.5 -> 24 (F107)
 *
 * The 2.5 came from the 512 ms / 5.2 MP figure quoted above, and that figure is
 * SwiftShader. 512 ms across an eighteen-pass chain is ~28 ms per fullscreen
 * pass at 5.2 MP; a real GPU does that in well under a millisecond. The ratio
 * the paragraph draws from it (4x for 4x the pixels) is sound — fill cost is
 * linear in pixels on any rasteriser — but the ABSOLUTE it was calibrated
 * against was a software renderer's, and a budget is an absolute.
 *
 * The consequence was measurable and roster-wide. Because the reciprocal sum is
 * always smaller than its smallest term, a 2.5 MP post chain capped every frame
 * below 2.5 MP no matter what the scene asked for, and a `high` scene at 1.6
 * landed on 0.98 MP — sub-720p. The claim three paragraphs up, that "a 1080p
 * display still solves to scale 1 and is untouched", was false for all eleven
 * scenes in the roster: the best any of them scored on a 1080p panel at the top
 * tier was 0.86, and `pointcloud` and `plasma` got 0.69, which is 47% of the
 * pixels stretched back over the panel with a bilinear filter.
 *
 * 24 MP is chosen so a solo fill-bound scene plus this chain resolves to native
 * on a **4K panel** at tier 0 — see {@link BUDGET_BY_COST} for why the anchor is
 * 4K and not 1440p. The chain is still a claimant and still binds: on a 5K panel
 * it is part of what holds a `high` scene to 0.75 linear, and every tier below
 * the top scales from here. It just no longer binds on displays whose GPUs were
 * never the problem.
 *
 * Still an ESTIMATE: `/bench` continues to exclude the post chain, so this is
 * the one cost in every frame that is never measured. The tier ladder is the
 * safety net, and it measures real frame time.
 */
export const POST_CHAIN_PIXEL_BUDGET = 24

/**
 * Combine the budgets of everything sharing the frame.
 *
 * All mounted scenes render into the same framebuffer at the same internal
 * resolution, so the question is not "whose budget wins" but "how many pixels
 * can we afford to hand to all of them at once".
 *
 * Take a scene's cost as proportional to `pixels / budget_i` — that is what
 * declaring a budget MEANS: this scene affords its share of the frame at exactly
 * `budget_i` megapixels. The frame is affordable when the costs sum to one
 * share:
 *
 *     pixels * SUM(1 / budget_i) <= 1   =>   pixels <= 1 / SUM(1 / budget_i)
 *
 * So budgets combine by reciprocal sum, and the result is always smaller than
 * the smallest input — which is right, and is the part `Math.min` would get
 * wrong. Two scenes that each want 2 MP cannot both have 2 MP; together they get
 * 1. A 1.5 MP raymarcher under a 16 MP wireframe gets 1.37, so the cheap layer
 * costs a little resolution rather than nothing at all.
 *
 * Degenerates correctly: one scene gets exactly its own budget (lilim's case),
 * and an empty frame gets {@link NATIVE_PIXEL_BUDGET}.
 */
export function combinePixelBudgets(budgets: Iterable<number>): number {
  let reciprocal = 0
  for (const b of budgets) {
    if (!isFinite(b) || b <= 0) continue
    reciprocal += 1 / b
  }
  if (reciprocal <= 0) return NATIVE_PIXEL_BUDGET
  return 1 / reciprocal
}

/**
 * The solve itself. Pure, so tests pin the arithmetic rather than a singleton's
 * accumulated state.
 *
 * Quantised to 1/100 because the value's only consumer is a renderer resize, and
 * a resize costs a full reallocation of the post chain's mip pyramid. A display
 * measured one CSS pixel differently must not buy that; a real change of scene
 * or tier must. 0.01 linear is ~2% of the pixels — below anything a viewer can
 * see and above anything a rounding wobble produces.
 */
export function solveRenderScale(budgetMP: number, fullMP: number, tierScale = 1): number {
  if (!(fullMP > 0) || !isFinite(fullMP)) return 1
  const tier = isFinite(tierScale) && tierScale > 0 ? tierScale : 1
  const budget = budgetMP * tier
  if (!(budget > 0) || !isFinite(budget)) return 1
  const raw = Math.sqrt(budget / fullMP)
  const clamped = Math.min(1, Math.max(RENDER_SCALE_FLOOR, raw))
  return Math.round(clamped * 100) / 100
}

/**
 * The live (scene, display) pair, and the scale that follows from it.
 *
 * A mutable singleton in the same shape as `performanceState` and `frameLoad`:
 * one writer per input, many readers, nothing allocated in the render loop.
 * `SceneManager` owns the budget (it is the only component that knows every
 * mounted entry); `PerfMonitor` owns the display and applies the result.
 */
class RenderScaleSolver {
  /** Combined budget of everything currently drawing, in megapixels. */
  budgetMP = NATIVE_PIXEL_BUDGET
  /** Full-resolution megapixels of the live display at base DPR. */
  fullMP = 1
  /** Base device pixel ratio before any scaling — what scale 1 would mean. */
  baseDpr = 1

  /**
   * The scale actually on the canvas right now, written by `PerfMonitor` when
   * it applies one.
   *
   * Distinct from `solve()`, which is the scale the current inputs ASK for —
   * the two differ while a tier-driven change is waiting out its hold. Scenes
   * that own offscreen render targets (`trail`'s accumulator, `panic`'s four
   * feedback passes) size those buffers from this, which is the only way their
   * offscreen half is inside the budget at all: those targets are allocated in
   * CSS pixels and are therefore invisible to the canvas DPR the solve moves.
   *
   * Read it, do not write it — the one writer is `applyRenderScale`.
   */
  applied = 1

  /**
   * Identity of the current (scene, display) pair.
   *
   * PerfMonitor applies a change to this IMMEDIATELY — a scene switch hides its
   * resize under the crossfade, and a window dragged to another monitor has
   * already stalled — while a change that comes only from the tier waits out the
   * hold. Without the distinction the two causes are indistinguishable at the
   * call site and both would have to wait.
   */
  get pairKey(): string {
    return `${this.budgetMP.toFixed(3)}|${this.fullMP.toFixed(3)}`
  }

  /** Tell the solver what the live display is. CSS pixels plus base DPR. */
  setDisplay(cssWidth: number, cssHeight: number, baseDpr: number): void {
    if (!(cssWidth > 0) || !(cssHeight > 0) || !(baseDpr > 0)) return
    this.baseDpr = baseDpr
    this.fullMP = (cssWidth * baseDpr * cssHeight * baseDpr) / 1e6 || 1
  }

  /** Tell the solver what is drawing. See {@link combinePixelBudgets}. */
  setSceneBudget(mp: number): void {
    if (!isFinite(mp) || mp <= 0) return
    this.budgetMP = mp
  }

  /**
   * Scale for the live pair at a given tier multiplier; defaults to the
   * governor's current one.
   */
  solve(tierScale = quality.knobs.pixelBudgetScale): number {
    return solveRenderScale(this.budgetMP, this.fullMP, tierScale)
  }

  /** Internal megapixels the current scale actually buys — for the debug panel. */
  internalMP(scale = this.solve()): number {
    return this.fullMP * scale * scale
  }
}

export const renderScale = new RenderScaleSolver()

/**
 * Quantise {@link RenderScaleSolver.applied} for a scene sizing its OWN
 * offscreen buffers.
 *
 * Reallocating a feedback target discards its contents — a trail loses its
 * smear, a reaction-diffusion buffer restarts from noise — so a scene must not
 * chase every 0.01 the canvas moves by. Rounding to quarters means the buffers
 * move at most three times between full resolution and the floor, and only when
 * the budget has really changed by something worth paying for.
 *
 * The floor is the solver's own, so a scene buffer never shrinks past what the
 * canvas would.
 */
export function bufferScale(applied = renderScale.applied): number {
  const q = Math.round(applied * 4) / 4
  return Math.min(1, Math.max(RENDER_SCALE_FLOOR, q))
}

/**
 * Default budget per declared `performanceCost`, for a scene whose cost is
 * per-pixel.
 *
 * ## Why this is derived rather than declared
 *
 * A pixel budget hand-authored per scene is a number that has to be re-derived
 * every time the roster changes, and it asks a scene author for something they
 * usually cannot answer better than the engine can. `performanceCost` is
 * already required, already MEASURED from `/bench`, and already the roster's
 * statement of how expensive a scene is — so the budget follows from it.
 *
 * ## What these are anchored on (F107)
 *
 * The previous table (1.6 / 2.5 / 4.0) was anchored on "a 1080p internal frame
 * is the fallback a show must be able to reach". The anchor was right and the
 * arithmetic around it was not: each budget was picked as the resolution at
 * which that scene ALONE is affordable, and then
 * {@link combinePixelBudgets} sums it with the post chain's — so the number
 * that actually reached the canvas was roughly half the one in this table, and
 * 1080p-as-a-FALLBACK became 720p-as-the-CEILING. Nothing in the roster ever
 * rendered a native pixel on any display.
 *
 * So the table is anchored on what a scene gets AFTER the combine, which is the
 * only number anyone sees. Paired with a 24 MP post chain:
 *
 *   high    12.5 MP ->  8.22 MP combined
 *   medium  16.0 MP ->  9.60 MP combined
 *   low     20.0 MP -> 10.91 MP combined
 *
 * ## Why the anchor is a 4K frame, and why tier 0 means native
 *
 * The first pass at this anchored on 1440p, which fixed a 1080p machine and left
 * a 4K one at 0.67 — reported immediately, and correctly, as still blurry. The
 * deeper problem was the shape of the decision rather than the constant: the
 * solve is a pure function of (budget, display, tier) with NO feedback from
 * measured frame time, so a static table was deciding up front that a machine
 * could not have full resolution, and nothing downstream could ever revisit it.
 * A 4K user was permanently soft whether or not their GPU had the headroom.
 *
 * The anchor is therefore what the top of the ladder MEANS: **tier 0 renders a
 * 4K panel natively**, and the tier ladder — which does measure frame time, and
 * has hysteresis — is what takes resolution away when the machine cannot hold
 * it. Predict-then-commit becomes start-high-and-measure. On a 4K panel a
 * `high` scene now runs 1.00 / 0.84 / 0.70 / 0.58 / 0.48 across the five tiers,
 * so the descent is smooth rather than a single cliff, and on 1080p it is
 * 1.00 / 1.00 / 1.00 / 1.00 / 0.96 — native almost all the way down.
 *
 * The governor still governs in both directions. Layering pulls resolution down
 * (two `high` scenes plus the chain resolve to 4.96 MP, so a 4K panel drops to
 * 0.77), and a display genuinely past what the GPU can carry still gets scaled
 * hard (a 5K panel runs 0.75 / 0.63 / 0.52 / 0.44 / 0.40).
 *
 * The cost of this is real and worth stating: a weak machine on a large panel
 * now spends its first second or two at native before the ladder demotes it,
 * where the old table would have started it soft. That is the trade — a brief
 * wrong guess that corrects itself, instead of a permanent one that cannot.
 *
 * These are the ENGINE's opinion, not any scene's, which is what makes them
 * safe to apply to a scene nobody has looked at. A scene that genuinely knows
 * better overrides with an explicit `pixelBudget` — and is then validated and,
 * if untrusted, clamped.
 */
export const BUDGET_BY_COST: Record<ScenePerformanceCost, number> = {
  low: 20.0,
  medium: 16.0,
  high: 12.5,
}

/**
 * The most an EXTERNALLY REGISTERED scene may render, whatever it claims.
 *
 * A budget is a claim about a scene's own cost, and the engine cannot verify it
 * before running the scene. In-repo that is fine — the claim and the shader are
 * reviewed together. It is not fine for a stranger's upload, where
 * `fillBound: false` or `pixelBudget: 16` is exactly what a scene that is about
 * to take down a venue would say, whether it is lying or merely wrong.
 *
 * So an untrusted scene's claim is capped rather than trusted: 16 MP is generous
 * for any scene that is honestly not fill-bound, and bounded for one that is
 * not. Untrusted scenes are not REJECTED for claiming more; a clamp degrades
 * their picture, where a rejection would remove them from the show for being
 * optimistic.
 *
 * Raised 4 -> 16 alongside {@link BUDGET_BY_COST} (F107). It has to move with
 * that table or it stops being a ceiling and becomes a penalty: against the old
 * 1.6/2.5/4.0 defaults a 4 MP cap was the most generous budget in the engine,
 * while against the new ones it would have been LOWER than what every in-repo
 * scene gets by default, so every third-party scene would have been the
 * blurriest thing on the bill regardless of what it cost.
 *
 * This is the crude version of the guarantee on purpose. The real one measures
 * a scene's GPU time and clamps from what it actually costs rather than from
 * who registered it; until that exists, provenance is the only signal available
 * and a fixed ceiling is the honest way to use it.
 */
export const UNTRUSTED_MAX_BUDGET = 16.0

/** What {@link resolvePixelBudget} needs from a scene. A subset of `SceneMetadata`. */
export interface PixelBudgetInputs {
  performanceCost: ScenePerformanceCost
  /**
   * Is this scene's cost per-pixel? **Defaults to true**, and the default is the
   * load-bearing part: a scene that says nothing is assumed fill-bound and is
   * scaled accordingly, so silence is the SAFE answer rather than the permissive
   * one. Claiming `false` — "downscaling me would not help" — is the assertion
   * that needs stating, because it is the one that buys full resolution.
   */
  fillBound?: boolean
  /** Explicit override, in megapixels. Validated, and clamped when untrusted. */
  pixelBudget?: number
}

/**
 * The budget a scene actually gets: its own claim if it made a valid one, else
 * the engine's default for its cost class — capped for an untrusted scene.
 *
 * Pure and total. Every path returns a usable number, including the paths a
 * malformed third-party registration takes, because the alternative to a number
 * here is a canvas that renders at whatever the display happens to be.
 */
export function resolvePixelBudget(meta: PixelBudgetInputs, trusted = true): number {
  const declared = meta.pixelBudget
  const valid =
    typeof declared === 'number' &&
    isFinite(declared) &&
    declared >= MIN_PIXEL_BUDGET &&
    declared <= MAX_PIXEL_BUDGET
  const fillBound = meta.fillBound !== false
  const base = valid
    ? (declared as number)
    : fillBound
      ? (BUDGET_BY_COST[meta.performanceCost] ?? BUDGET_BY_COST.high)
      : NATIVE_PIXEL_BUDGET
  return trusted ? base : Math.min(base, UNTRUSTED_MAX_BUDGET)
}

/** What the frame loop should do about a tier change. See {@link decideTierResize}. */
export type TierResizeAction =
  /** Reallocate now (still subject to the caller's coalesce cooldown). */
  | 'apply'
  /** (Re)start the hold clock for this tier. */
  | 'restart-hold'
  /** Keep waiting out the hold. */
  | 'wait'

export interface TierResizeInput {
  /** Scale the live tier asks for — `renderScale.solve()`. */
  solved: number
  /** Scale currently on the canvas — `renderScale.applied`. */
  applied: number
  /** Rolling p95 frame time, ms. */
  p95Ms: number
  /** Measured display refresh interval, ms. */
  refreshMs: number
  /** Is a crossfade in flight? */
  txActive: boolean
  /** Is the hold clock already running for THIS tier? */
  heldForThisTier: boolean
  /** Seconds the hold clock has been running. */
  heldForSec: number
  /** {@link TierResizeInput.p95Ms} multiple past which the hold is abandoned. */
  emergencyRatio: number
  /** Seconds a scale-RAISING tier change waits before it is applied. */
  holdSec: number
}

/**
 * Should a pending tier change resize the canvas now, or wait? (F153)
 *
 * ## The asymmetry this encodes
 *
 * The hold exists so a tier change that might reverse does not pay a post-chain
 * reallocation for nothing. Every word of that is about a change making the
 * frame MORE expensive. A demote is not a guess about future load — it is the
 * governor having already decided, and holding it means rendering at a
 * resolution the controller has just declared unaffordable. The sibling
 * constant `MAX_RENDER_SCALE_STEP_UP` already states the rule for its own case:
 * *"Downward is never capped: shedding load must land the instant it is asked
 * for."* The hold did not follow it, and this is where it now does.
 *
 * Measured before the change, across three sessions and two window sizes: 22 of
 * 26, then 35 of 41, of the frames over 33 ms fell between a demote and the
 * resize that relieved it — 11% and 21% of session wall-clock. Observed lags
 * 0.43 s to 7.03 s.
 *
 * The 7.03 s case was this decision compounding. Three demotes about 2 s apart,
 * each one failing `heldForThisTier` and restarting the clock, so the ladder
 * conceded three whole rungs while the frame kept paying 4.67 MP throughout.
 * Applying a shed on sight removes that case by construction rather than by
 * tuning: a demote never reaches the hold branch at all.
 *
 * The clearest single sequence, from `audiovis-session-2026-08-30-09-47-58`:
 *
 *     67.42  promote 1 -> 0
 *     72.98  scale 0.91 -> 1.00     5.56 s later, the resize lands
 *     73.10  DEMOTE 0 -> 1          0.12 s after that, the frame collapses
 *     73.4-75.3                     75.6, 67.4, 64.7, 58.3, 50.1 ms
 *     75.55  scale 1.00 -> 0.75     relief, 2.45 s after the demote
 *
 * Five and a half seconds spent climbing to a resolution the machine held for
 * one tenth of a second. Slow up is the hold working; slow down is this bug.
 *
 * ## Why a crossfade still defers a shed
 *
 * The one case where waiting beats shedding. A commit has already reallocated
 * through its own budget change, and stacking a second reallocation on top of
 * it was the biggest cluster of 50-250 ms frames in the older logs. The caller
 * re-evaluates every frame, so this resolves on the first frame after the fade
 * rather than restarting any clock — bounded by the longest transition, under a
 * second, against the 3-7 s the hold was costing.
 *
 * Pure so it can be tested without a GPU or a React tree; the frame loop owns
 * the clock and the refs, this owns the policy.
 */
export function decideTierResize(i: TierResizeInput): TierResizeAction {
  // 0.005 is half the 0.01 grid `solveRenderScale` quantises to, so this is
  // "the solve moved at all", not a tolerance.
  const shedding = i.solved < i.applied - 0.005
  const emergency = i.p95Ms > i.refreshMs * i.emergencyRatio
  if ((shedding && !i.txActive) || emergency) return 'apply'
  if (!i.heldForThisTier || i.txActive) return 'restart-hold'
  return i.heldForSec >= i.holdSec ? 'apply' : 'wait'
}
