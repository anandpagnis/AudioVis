import type { ScenePerformanceCost } from '../scenes'
import { quality } from './quality'

/**
 * Internal-resolution governor: solves the frame's render scale from a DECLARED
 * PIXEL BUDGET instead of handing every scene the same fixed multiplier.
 *
 * Since F272 stage 5 the scale is not a canvas size. The canvas is pinned at
 * base DPR and every post-chain buffer is allocated once at that size; the
 * frame is drawn into their bottom-left `internalW x internalH` and `GradePass`
 * upscales it to the canvas (see frameRect.ts). A scale change is therefore a
 * number PerfMonitor writes each frame, not a reallocation, which is what let
 * the resize machinery that used to live here (a hold, a coalesce cooldown, a
 * climb ratchet, a climb-worth-it gate) be deleted: all of it existed only
 * because moving the scale used to cost 20-200 ms.
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
 *    ONE resolution. Only the committed primary and the post chain claim that
 *    resolution ({@link claimsResolution}, F272 — layers are admitted by the
 *    millisecond budget instead), and those claims combine by reciprocal sum,
 *    not by taking the smallest ({@link combinePixelBudgets}).
 *  - **The tier ladder.** The five tiers still scale the frame, but they now do
 *    it by scaling the BUDGET (`quality.knobs.pixelBudgetScale`) rather than by
 *    naming a resolution. Budget is in megapixels and cost is linear in
 *    megapixels, so multiplying budgets is the operation that means "let this
 *    frame do 49% of the work" — which is what a tier is trying to say.
 *
 * ## The user's ceiling (F272 stage 6)
 *
 * The "max render resolution" setting (maxResolution.ts) caps the frame's
 * megapixels on top of all of the above: the scale is the smaller of the
 * solve and `sqrt(cap / fullResMegapixels)` ({@link capScaleFor}). It is the
 * one input allowed below {@link RENDER_SCALE_FLOOR} — the floor protects the
 * picture from the solver, not from an explicit choice. Only PerfMonitor sets
 * it, from the store; `/bench` measures uncapped.
 *
 * ## Determinism
 *
 * The result is a pure function of (combined budget, display, tier, cap). There
 * is no feedback from measured frame time into the scale — that path runs
 * through the tier ladder, which has its own hysteresis. So the scale settles to
 * one value per (scene, display, tier) triple and stays there instead of
 * hunting, which is what stops the sharpness from pulsing while the picture
 * holds still.
 */

/**
 * Lowest linear scale the solver will ever ask for.
 *
 * 0.4 linear is 16% of the pixels — past that the picture is mush, and the
 * honest response to a machine that still cannot hold the frame is to drop
 * complexity (which the tier ladder is already doing) rather than resolution.
 *
 * A floor on the SOLVE only: the user's max-resolution cap may go below it
 * (1280x720 on a 5K panel is 0.25), since that is a choice, not a guess.
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
 * governor; a large budget still combines with the post chain's in
 * {@link combinePixelBudgets} and still shrinks with the tier, so a scene that
 * claims it never escapes the governor.
 */
export const NATIVE_PIXEL_BUDGET = 32

/**
 * The post chain's OWN pixel budget — bloom + chromatic aberration +
 * vignette (`BloomFinishPass`), plus `FeedbackPass`.
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
 *
 * The arithmetic above holds for any set, and `/bench` composes arbitrary sets
 * through it. The live frame, though, hands it only the committed primary and
 * the post chain since F272 — see {@link claimsResolution} for why layers no
 * longer claim resolution.
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
 * Does this mounted entry claim the frame's resolution? (F272)
 *
 * Only the committed primary does. The post chain joins it separately, see
 * `POST_CHAIN_PIXEL_BUDGET`.
 *
 * Layers (background / accent / overlay) used to claim it too, so every layer
 * the director added or dropped re-solved the canvas scale — a resize, a
 * reallocation of the whole post chain, and a visible sharpness jump, several
 * times a minute on a 4K panel. They do not need it: layer admission already
 * prices every layer in milliseconds at the resolution actually applied
 * (`slotCostMs` against `renderScale.internalMP`), so a layer that does not fit
 * is refused rather than paid for with resolution. The tier ladder, which
 * measures real frame time, is what takes resolution away when the frame
 * cannot hold it. Three of the backgrounds also cap their own resolution
 * offscreen (`createShaderScene`'s `pixelBudget`), so their canvas claim was
 * counted twice.
 *
 * Outgoing/warming primaries (`dir !== 1`) and effects never claimed it; see
 * SceneManager's budget walk for why.
 */
export function claimsResolution(e: { role: string; dir: number }): boolean {
  return e.dir === 1 && e.role === 'primary'
}

/**
 * The solve itself. Pure, so tests pin the arithmetic rather than a singleton's
 * accumulated state.
 *
 * Quantised to 1/100. Moving the scale no longer reallocates anything (F272
 * stage 5), but it is still a visible change of sharpness, and PerfMonitor
 * applies the solve every frame: a display measured one CSS pixel differently
 * must not step the picture, and the session log records every change, so a
 * rounding wobble would be noise in both. A real change of scene or tier moves
 * it. 0.01 linear is ~2% of the pixels — below anything a viewer can see and
 * above anything a rounding wobble produces.
 */
export function solveRenderScale(
  budgetMP: number,
  fullMP: number,
  tierScale = 1,
  maxMP = Infinity,
): number {
  if (!(fullMP > 0) || !isFinite(fullMP)) return 1
  const cap = capScaleFor(maxMP, fullMP)
  const tier = isFinite(tierScale) && tierScale > 0 ? tierScale : 1
  const budget = budgetMP * tier
  // An unusable budget falls back to full resolution — but still under the
  // user's cap, which is a statement about this machine, not about the scene.
  if (!(budget > 0) || !isFinite(budget)) return cap
  const raw = Math.sqrt(budget / fullMP)
  const clamped = Math.min(1, Math.max(RENDER_SCALE_FLOOR, raw))
  // The cap is applied AFTER the floor, so an explicit cap can go below it.
  return Math.min(cap, Math.round(clamped * 100) / 100)
}

/**
 * The linear scale the user's max-resolution cap allows on a display of
 * `fullMP` (F272 stage 6): `sqrt(maxMP / fullMP)`, on the same 1/100 grid as
 * the solve and rounded DOWN, so the frame never renders more pixels than the
 * setting names. 1 when there is no cap (`Infinity`), no usable cap, or a cap
 * at or above the display; never below 0.01.
 */
export function capScaleFor(maxMP: number, fullMP: number): number {
  if (!(maxMP > 0) || !isFinite(maxMP) || !(fullMP > 0) || !isFinite(fullMP)) return 1
  if (maxMP >= fullMP) return 1
  // The epsilon keeps a cap that lands exactly on the grid (0.75 * 0.75 of the
  // display) from flooring to the step below on a float that came out a hair
  // under it.
  const stepped = Math.floor(Math.sqrt(maxMP / fullMP) * 100 + 1e-6) / 100
  return Math.max(0.01, stepped)
}

/**
 * The live (scene, display) pair, and the scale that follows from it.
 *
 * A mutable singleton in the same shape as `performanceState` and `frameLoad`:
 * one writer per input, many readers, nothing allocated in the render loop.
 * `SceneManager` owns the budget (it is the only component that knows every
 * mounted entry); `PerfMonitor` owns the display and applies the result, once
 * per frame, before anything else in the frame reads it.
 */
export class RenderScaleSolver {
  /** Combined budget of everything currently drawing, in megapixels. */
  budgetMP = NATIVE_PIXEL_BUDGET
  /**
   * The user's max-resolution cap in megapixels, `Infinity` for none (F272
   * stage 6, maxResolution.ts). Written by PerfMonitor from the store; left
   * alone, and so uncapped, everywhere else.
   */
  maxMP = Infinity
  /** Full-resolution megapixels of the live display at base DPR. */
  fullMP = 1
  /** Base device pixel ratio before any scaling — what scale 1 would mean. */
  baseDpr = 1
  /** CSS size of the live display, from the last {@link setDisplay}. 0 before the first. */
  cssW = 0
  cssH = 0

  /**
   * The scale this frame is rendered at: the linear size of the sub-rect the
   * frame is drawn into, as a fraction of the pinned canvas (F272 stage 5).
   *
   * Written once per frame by `PerfMonitor` at the very start of the frame
   * (priority -1000), so every director, scene and pass in the frame sees the
   * same rect. It equals `solve()` from then on — steps are instant, by the
   * user's choice (F273 logs the glide-up for later) — but it is a separate
   * field because it is the value the frame was actually drawn at, and the
   * budget `solve()` reads can move mid-frame (SceneManager publishes it at
   * -100). `/bench` writes it too, pinning each cell's scale.
   */
  applied = 1

  /** Tell the solver what the live display is. CSS pixels plus base DPR. */
  setDisplay(cssWidth: number, cssHeight: number, baseDpr: number): void {
    if (!(cssWidth > 0) || !(cssHeight > 0) || !(baseDpr > 0)) return
    this.baseDpr = baseDpr
    this.cssW = cssWidth
    this.cssH = cssHeight
    this.fullMP = (cssWidth * baseDpr * cssHeight * baseDpr) / 1e6 || 1
  }

  /**
   * Pixel size of the frame the scenes are drawn into, at the {@link applied}
   * scale: the sub-rect of the full-size buffers the whole chain renders in
   * (F272 stage 5; `frameRect.ts` aims the composer's buffers at exactly this).
   *
   * The ratio is multiplied out first, `floor(css * (baseDpr * applied))`,
   * which is how three floors a canvas for the same pixel ratio — at
   * `applied = 1` this is exactly the pinned canvas's drawing buffer, integer
   * for integer. Anything that sizes a buffer "to the frame" reads it from
   * here rather than from `size * viewport.dpr`, which describes the canvas,
   * not the frame. At least 1, so a display not yet laid out cannot size a
   * zero-pixel target.
   */
  get internalW(): number {
    return Math.max(1, Math.floor(this.cssW * (this.baseDpr * this.applied)))
  }

  /** See {@link internalW}. */
  get internalH(): number {
    return Math.max(1, Math.floor(this.cssH * (this.baseDpr * this.applied)))
  }

  /**
   * The frame at scale 1 — the pinned canvas's drawing buffer, and the largest
   * {@link internalW} any scale can produce on this display. What a grow-only
   * buffer sizes its capacity from, so a later climb of the scale finds the
   * room already there instead of reallocating mid-show.
   */
  get fullW(): number {
    return Math.max(1, Math.floor(this.cssW * this.baseDpr))
  }

  /** See {@link fullW}. */
  get fullH(): number {
    return Math.max(1, Math.floor(this.cssH * this.baseDpr))
  }

  /** Tell the solver what is drawing. See {@link combinePixelBudgets}. */
  setSceneBudget(mp: number): void {
    if (!isFinite(mp) || mp <= 0) return
    this.budgetMP = mp
  }

  /** Set the user's cap, in megapixels. Anything unusable means no cap. */
  setMaxMP(mp: number): void {
    this.maxMP = mp > 0 ? mp : Infinity
  }

  /**
   * Scale for the live pair at a given tier multiplier; defaults to the
   * governor's current one.
   */
  solve(tierScale = quality.knobs.pixelBudgetScale): number {
    return solveRenderScale(this.budgetMP, this.fullMP, tierScale, this.maxMP)
  }

  /** Internal megapixels the current scale actually buys — for the debug panel. */
  internalMP(scale = this.solve()): number {
    return this.fullMP * scale * scale
  }
}

export const renderScale = new RenderScaleSolver()

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
 * The governor still governs in both directions. The tier ladder, which
 * measures real frame time, pulls resolution down when the frame cannot hold
 * it, and a display genuinely past what the GPU can carry still gets scaled
 * hard (a 5K panel runs 0.75 / 0.63 / 0.52 / 0.44 / 0.40). Layering no longer
 * does on its own (F272, {@link claimsResolution}): a layer that does not fit
 * the millisecond budget is refused rather than paid for with resolution.
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
