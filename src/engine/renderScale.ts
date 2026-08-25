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
export const MAX_PIXEL_BUDGET = 32

/**
 * What a scene declares when its cost is NOT per-pixel: line art, a handful of
 * meshes, anything geometry- or CPU-bound.
 *
 * 16 MP is a 5K panel fullscreen (5120x2880 = 14.7 MP), so this resolves to
 * scale 1 on every display anyone will plausibly run a show on — the scene
 * renders pixel-perfect, which is the honest answer for work that downscaling
 * would not make cheaper.
 *
 * It is a real number rather than a sentinel on purpose. A sentinel would mean
 * "exempt", and an exemption is exactly the thing that lets one scene ignore the
 * governor; a large budget still combines with its neighbours' in
 * {@link combinePixelBudgets} and still shrinks with the tier, so a cheap scene
 * layered under two expensive ones contributes its (small) share of the
 * pressure instead of vanishing from the arithmetic.
 */
export const NATIVE_PIXEL_BUDGET = 16

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
 * **ESTIMATE — not measured on real hardware.** Same caveat, and the same
 * reasoning, as `POST_CHAIN_UNITS` in frameLoad.ts: `/bench` deliberately
 * excludes the post chain, so the one constant cost in every frame is the one
 * never measured. 2.5 MP is a ~1080p-class internal frame, chosen as the
 * resolution at which an eighteen-pass fullscreen chain is affordable on a
 * mid-range GPU. Raise it for a sharper picture, lower it if the post chain
 * proves heavier than this assumes.
 */
export const POST_CHAIN_PIXEL_BUDGET = 2.5

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
 * Anchored on a 1080p internal frame (2.07 MP), which is the resolution a show
 * has to be able to fall back to:
 *
 *   high    1.6 MP   below 1080p — a heavy scene must give up real pixels
 *   medium  2.5 MP   a little above 1080p
 *   low     4.0 MP   1440p-class; cheap, but still bounded
 *
 * These are the ENGINE's opinion, not any scene's, which is what makes them
 * safe to apply to a scene nobody has looked at. A scene that genuinely knows
 * better overrides with an explicit `pixelBudget` — and is then validated and,
 * if untrusted, clamped.
 */
export const BUDGET_BY_COST: Record<ScenePerformanceCost, number> = {
  low: 4.0,
  medium: 2.5,
  high: 1.6,
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
 * So an untrusted scene's claim is capped rather than trusted: 4 MP is 1440p
 * class — generous for any scene that is honestly not fill-bound, and bounded
 * to 0.52 linear on a 5K panel for one that is not. Untrusted scenes are not
 * REJECTED for claiming more; a clamp degrades their picture, where a rejection
 * would remove them from the show for being optimistic.
 *
 * This is the crude version of the guarantee on purpose. The real one measures
 * a scene's GPU time and clamps from what it actually costs rather than from
 * who registered it; until that exists, provenance is the only signal available
 * and a fixed ceiling is the honest way to use it.
 */
export const UNTRUSTED_MAX_BUDGET = 4.0

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
