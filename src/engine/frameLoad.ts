import { isFeedbackActive } from './feedbackParams'

/**
 * What is actually rendering right now, in budget units.
 *
 * ## Why this exists
 *
 * The frame budget had three independent claimants, each reserving against a
 * different partial view of the same frame:
 *
 *   - `composeLayers` reserved the primary and admitted layers — blind to
 *     effects and to the post chain.
 *   - `EffectDirector` reserved the primary and any live effects — blind to the
 *     **layers**, so an effect could fire on top of a full three-slot
 *     composition while believing the frame held one scene.
 *   - `canFundOverlap` reserved the two primaries — blind to effects.
 *
 * And nothing at all accounted for the cost that is present in *every* frame:
 * the post chain — a bloom mip pyramid plus chromatic aberration and vignette.
 *
 * Three partial views of one resource is how a budget confidently overcommits:
 * each claimant is individually correct and the sum is not. This module is the
 * single place that knows the whole frame, so a claimant asks "what is already
 * committed?" instead of assembling its own guess.
 *
 * ## Milliseconds, and their honesty
 *
 * Same currency as slotBudget.ts: frame-time milliseconds. Scene costs are
 * measured per tier (engine/sceneCost.ts, from the `/bench` sweep). **The two
 * fixed costs below are still estimates**, and they are now the only invented
 * numbers left in the budget — `/bench` deliberately excludes the post chain so
 * scene costs compare cleanly, which means the one cost present in every single
 * frame is the one nobody has weighed. They are reasoned rather than guessed —
 * a bloom mip chain is roughly a fullscreen pass and a half, the feedback pass
 * is two fullscreen draws — and reserving a reasoned estimate beats the
 * previous reservation of zero, which is what let a full composition plus post
 * present itself to the budget as a single scene. Measuring them is F90.
 */

/**
 * Post-processing chain, present in every frame.
 *
 * `EffectComposer` with `Bloom({ mipmapBlur })` + `ChromaticAberration` +
 * `Vignette`. The mip pyramid is roughly nine downsamples and nine upsamples;
 * each is cheap individually but they are all fullscreen-derived, and the chain
 * runs whatever else is on screen.
 *
 * **ESTIMATE — still not a `/bench` measurement.** `/bench` deliberately
 * excludes the post chain so that scene costs compare cleanly; see F43 and F90
 * in docs/ISSUES.md for actually measuring it.
 *
 * ## Recalibrated downward (F182), against two real session-log GPU traces
 *
 * The old value (2 ms) was the pre-F90 `medium` unit reading carried across
 * unchanged — reasoned from a single scene's GPU cost (`plasma` at 0.87 ms),
 * never checked against a measured POST CHAIN cost because none existed. Two
 * session recordings now give one: the GPU timer brackets the *entire* frame
 * (`GPU_TIMER_BEGIN/END_PRIORITY` in PerfMonitor.tsx span every pass, scene
 * included), and across both sessions that whole-frame GPU cost — scene, post
 * chain, feedback and any live racks together — never averaged more than
 * 1.70 ms:
 *
 *     session A (123 s, tier 4 throughout): mean gpuMs 1.45, p95 3.12, GPU
 *       share of frame time 9% (wall-clock mean 16.7 ms, almost entirely CPU)
 *     session B (154 s, climbed to tier 3): mean gpuMs 1.70, GPU share 10%
 *
 * The old reservation for the fixed chain ALONE (`POST_CHAIN_MS + FEEDBACK_MS
 * = 3`) already exceeded the ENTIRE measured frame's GPU cost, scene included,
 * in both sessions — which is what let `frameLoad.fixed` alone (4.7 ms after
 * `fillScale`) consume most of tier 4's 6.5 ms wallet before a scene was even
 * considered. `POST_CHAIN_MS` is set here so the fixed chain claims roughly
 * half of session B's mean whole-frame GPU cost (the higher and more recent of
 * the two figures, so the estimate stays conservative rather than optimistic),
 * leaving the other half-plus for the scene itself and any optical racks — the
 * things this reservation is not supposed to be pricing. Still deliberately
 * not generous: real measurement (F90) may yet show it should be lower still.
 */
export const POST_CHAIN_MS = 0.6

/**
 * Internal megapixels every fixed-cost constant in this file is quoted at.
 *
 * 2.07 MP is a 1080p frame, which is the resolution `POST_CHAIN_MS = 2` was
 * reasoned about even though it never said so — see {@link fillScale} for why
 * that omission mattered.
 */
export const FILL_REFERENCE_MP = 2.07

/**
 * Scale a fullscreen-pass reservation from the reference frame to the frame
 * actually being drawn (F110).
 *
 * ## Why the constants could not stay flat
 *
 * Every fixed cost in this file — the post chain, the feedback pass, both
 * optical racks — is a fullscreen draw, and a fullscreen draw costs one unit of
 * work per pixel. So all four are linear in the internal resolution, and a flat
 * millisecond reservation is only correct at one resolution.
 *
 * That was survivable while the pixel budgets held every display near 1080p. It
 * stopped being survivable with F107: a 4K panel at the top tier now renders
 * 8.29 MP, four times the frame these numbers were reasoned about, so the chain
 * reserved 2 ms for something costing nearer 8. The budget then cheerfully
 * admitted layers into a frame that was already over, which is the precise
 * failure `remainingMs` exists to prevent.
 *
 * It is still an ESTIMATE — `/bench` excludes the post chain, so the one cost in
 * every frame remains the one never measured (F43, F90). But an estimate with
 * the right SHAPE degrades correctly at both ends: it charges a 4K frame four
 * times what it charges a 1080p one, and it gets cheaper the moment the tier
 * ladder takes resolution away, which is exactly when the budget needs to
 * loosen again.
 *
 * Total, and safe on a frame with no resolution yet: returns 1 rather than 0, so
 * an uninitialised solver reserves the reference cost instead of nothing.
 */
export function fillScale(internalMP: number): number {
  if (!isFinite(internalMP) || internalMP <= 0) return 1
  return internalMP / FILL_REFERENCE_MP
}

/**
 * `FeedbackPass`, mounted permanently in the post chain (see PostFXChain).
 *
 * Two fullscreen draws every frame regardless of the `trails` value — the
 * blend (a warp + two texture samples) and the copy (one texture sample) — so
 * unlike `POST_CHAIN_UNITS` this is a REAL reserved cost, not folded into that
 * estimate, because it is present whether or not `trails` is doing anything
 * visible. **Still an ESTIMATE**, not a `/bench` measurement — `/bench`
 * excludes the whole post chain today (see the caveat above), and this pass
 * did not exist when that decision was made. A warp-sample fullscreen pass is
 * lighter than bloom's nine-tap mip pyramid, and the copy draw is close to
 * free — hence half {@link POST_CHAIN_MS}'s reservation, same ratio kept
 * across F182's recalibration of the pair against the two sessions' measured
 * GPU traces documented on that constant.
 */
export const FEEDBACK_MS = 0.3

/**
 * The feedback pass's reservation for a given `trails` value.
 *
 * **Conditional, and that matters more than it looks.** `FeedbackPass` disables
 * itself whenever `trails` is at rest — the default, and the overwhelmingly
 * common case — and `EffectComposer` skips a disabled pass entirely, so it
 * genuinely costs nothing. Reserving for it anyway held 1 of only 5 units at the
 * survival tier under the old currency: 20% of the frame's whole capacity, for
 * work that was not happening, and precisely the unit that decided whether ANY
 * crossfade overlap was possible. That is why three of the six transition styles
 * were unreachable (F84).
 *
 * This is the same reasoning already written into the optical racks' reservations, which are 0
 * because those racks bypass themselves at rest. It simply had not been applied
 * here.
 */
export function feedbackMsFor(trails: number): number {
  return isFeedbackActive(trails) ? FEEDBACK_MS : 0
}

/**
 * The optical racks (`MirrorPass`, `LensPass`).
 *
 * Zero at rest, and that part is not an estimate: both racks set their own
 * `enabled` from their settings and `EffectComposer` skips a disabled pass
 * before it ever renders, so there is no draw to reserve against.
 *
 * Switched ON they are no longer free, and this stopped being an academic point
 * the moment a director started moving them (F56). While the sole thing that
 * turned a rack on was a human dragging a slider, an unreserved cost was
 * defensible — a human can see the frame rate. An autonomous director cannot,
 * and `composeLayers` would happily admit a layer on top of a rack it did not
 * know was running, which is the class of bug F43 exists to record.
 *
 * **ESTIMATES**, in the same family as POST_CHAIN_MS and for the same reason:
 * `/bench` excludes the post chain, so nothing in it has been weighed. Reasoned
 * from what the shaders do — the mirror is a UV remap plus one tap, so about
 * half a fullscreen pass; the lens is three taps for the prismatic split, which
 * is a little more. `anamorphic` gathers 24 further samples for its streaks and
 * is charged double for it, because a rack style that costs four times its
 * siblings should not be priced as though it did not. Measuring all three is
 * folded into F90.
 */
export const MIRROR_RACK_MS = 0.5
export const LENS_RACK_MS = 0.8
/** `anamorphic` — index 2 in LENS_STYLES — gathers 24 extra taps per pixel. */
export const LENS_STREAK_EXTRA_MS = 0.8

/** What the mirror rack is actually costing, from its live settings. */
export function mirrorRackMs(m: {
  segments: number
  tiles: number
  twist: number
  slice: number
}): number {
  const active = m.segments >= 1 || m.tiles >= 2 || Math.abs(m.twist) > 0.001 || m.slice > 0.001
  return active ? MIRROR_RACK_MS : 0
}

/** What the lens rack is actually costing, from its live settings. */
export function lensRackMs(l: { amount: number; style: number }): number {
  if (!(l.amount > 0.001)) return 0
  return LENS_RACK_MS + (Math.round(l.style) === 2 ? LENS_STREAK_EXTRA_MS : 0)
}

/**
 * `IsfFilterPass` — the permanently-mounted ISF post-processing filter slot.
 *
 * Zero at rest, same shape as the optical racks above and for the same
 * reason: `enabled` is derived straight from whether `IsfFilterPass.setFilter`
 * has been handed a real filter (see that class's header) — `null` skips the
 * pass in `EffectComposer` before it ever draws, so there is nothing to
 * reserve against.
 *
 * Switched ON it is one fullscreen draw, same as every other pass in this
 * file, but the five vendored filters (`src/assets/isf/filters/*.fs`) are not
 * uniformly cheap ones. Reading the shader bodies: Color Invert and Bump
 * Distortion are one texture tap (`IMG_THIS_PIXEL`/`IMG_NORM_PIXEL`) plus
 * light closed-form math; Bad TV is one tap plus two Simplex-noise (`snoise`)
 * evaluations; CMYK Halftone has a genuine `for (i=0;i<4;++i)` loop, one
 * `IMG_PIXEL` tap per CMYK channel, four unconditional taps every pixel.
 * Broken LCD is the outlier by a wide margin: it unrolls up to three separate
 * 4-octave value-noise `fbm` sequences per pixel (the glitch mask and the
 * tint mask always, plus a third inside `patternForType` for the default
 * noise-style pattern selections), each octave a `noise()` call built from
 * four bilinearly-blended `hash()` lookups — on the order of a hundred
 * procedural ALU evaluations per pixel worst case — on top of its own one
 * unconditional texture tap plus two or three more conditional ones
 * (row-glitch and pattern-flicker branches).
 *
 * `isfFilterMsFor` below only knows "a filter is selected", not which one —
 * the whole point of this pass is that swapping filters is a material
 * assignment, not a pass rebuild (see `IsfFilterPass`'s header on why), and
 * that design has no cheap way to hand this file an id to key a per-filter
 * surcharge on, unlike `lensRackMs` above, which receives `style` for exactly
 * that reason. So this is ONE flat reservation rather than a base-plus-
 * surcharge pair, and it is sized to the heaviest of the roster (Broken LCD),
 * not the group's typical case — a flat number calibrated to Color Invert
 * would undercharge the instant a director picks Broken LCD instead, which is
 * the shape of mistake F182 exists to warn against.
 *
 * Rechecked, not just assumed, against the four filters added in the second
 * vendoring wave (`isfFilterRoster.ts`, `NOTICE`'s "WHY THE NEXT FOUR"):
 * `Dither-Bayer`'s worst case is a chain of up to 64 integer `if`-comparisons
 * with a single texture tap, `JPEG Block Corruption` samples twice plus one
 * cheap 2D hash, `Pixel Shifter` and `Ripples` each sample once plus a
 * handful of `sin`/`cos`/`rand` calls — all four clearly lighter than Broken
 * LCD's unrolled triple-`fbm`, so the existing reservation still covers the
 * roster's worst case without moving.
 *
 * **ESTIMATE — not a `/bench` measurement.** Same family as `POST_CHAIN_MS`,
 * `MIRROR_RACK_MS` and `LENS_RACK_MS` above, and for the same reason: `/bench`
 * deliberately excludes the whole post chain, and this pass did not exist
 * when that exclusion was decided either. Reasoned from the shader bodies
 * above, not measured against a GPU trace; real measurement is future work in
 * the same family as F90.
 */
export const ISF_FILTER_MS = 1.0

/**
 * What the ISF filter slot is actually costing, from the live selection.
 *
 * Conditional, mirroring `feedbackMsFor`'s shape: `IsfFilterPass` disables
 * itself whenever no filter is selected — the default, and the overwhelming
 * common case until a picker exists at all — and a disabled pass costs
 * nothing, so reserving for it unconditionally would hold budget against work
 * that is not happening, the exact mistake `feedbackMsFor`'s own doc comment
 * already covers for `trails`.
 */
export function isfFilterMsFor(filter: { id: string | null }): number {
  return filter.id !== null ? ISF_FILTER_MS : 0
}

/**
 * Live breakdown of the frame's committed cost. Mutated in place once per frame
 * by `SceneManager`, which is the only component that knows every mounted
 * entry; read by everything that wants to spend budget.
 *
 * A plain mutable singleton, matching `performanceState`'s contract: one writer,
 * many readers, no allocation in the render loop.
 */
export const frameLoad = {
  /** The committed primary subject, in milliseconds. */
  primary: 0,
  /** A second primary during a crossfade, or a warming candidate still drawing. */
  incoming: 0,
  /** Background + accent + overlay, as actually mounted (not as desired). */
  layers: 0,
  /** Effect scenes currently firing. */
  effects: 0,
  /**
   * Post chain, plus the feedback pass while trails are actually running, plus
   * whichever optical racks are live — all four scaled to the frame's real
   * internal resolution by {@link fillScale}.
   */
  fixed: POST_CHAIN_MS + FEEDBACK_MS,
}

/**
 * Everything already committed this frame.
 *
 * What a new claimant must reserve against. Deliberately includes `incoming`:
 * during a crossfade the frame really is carrying two subjects, and that is
 * exactly the moment an extra layer or effect must not be admitted.
 */
export function committedMs(): number {
  return (
    frameLoad.primary + frameLoad.incoming + frameLoad.layers + frameLoad.effects + frameLoad.fixed
  )
}

/**
 * Budget left for a new claimant, given the tier's total.
 *
 * Floors at 0 rather than going negative: an overcommitted frame should admit
 * nothing more, not wrap around into apparent headroom.
 */
export function remainingMs(budgetMs: number): number {
  return Math.max(0, budgetMs - committedMs())
}

/** The minimum a mounted entry has to expose for its cost to be attributed. */
export interface FrameLoadEntry {
  role: 'primary' | 'background' | 'accent' | 'overlay' | 'effect'
  /** 1 = fading in, -1 = fading out, 0 = warming. */
  dir: 1 | -1 | 0
  /**
   * Is this entry actually drawing this frame? A warm candidate that has
   * finished compiling is hidden and costs nothing; one still warming is
   * genuinely on screen. The caller owns that distinction because it depends on
   * SceneManager's warm bookkeeping.
   */
  drawing: boolean
  /** Milliseconds, already resolved through `slotCostMs` for this entry's role. */
  ms: number
}

/**
 * Attribute every mounted entry to its bucket and publish the result.
 *
 * Pure apart from writing {@link frameLoad}, and separated from SceneManager's
 * `useFrame` so the attribution can be tested — the bucketing is where the
 * interesting mistakes live (counting a hidden warm entry, filing the outgoing
 * primary as the subject, or missing layers entirely, which was the original
 * bug this whole module exists to fix).
 */
export function applyFrameLoad(entries: readonly FrameLoadEntry[], fixed: number): void {
  let primary = 0
  let incoming = 0
  let layers = 0
  let effects = 0
  for (const e of entries) {
    if (!e.drawing) continue
    if (e.role === 'primary') {
      // The entry fading IN is the committed subject; any other live primary is
      // the outgoing one, or a candidate still warming — both are overlap.
      if (e.dir === 1) primary += e.ms
      else incoming += e.ms
    } else if (e.role === 'effect') {
      effects += e.ms
    } else {
      layers += e.ms
    }
  }
  frameLoad.primary = primary
  frameLoad.incoming = incoming
  frameLoad.layers = layers
  frameLoad.effects = effects
  frameLoad.fixed = fixed
}
