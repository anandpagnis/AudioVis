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
 * **ESTIMATE — not measured.** `/bench` deliberately excludes the post chain so
 * that scene costs compare cleanly, which means the one constant cost in every
 * frame is the one number never measured. Measuring it is the obvious next
 * benchmark task; see F43 and F90 in docs/ISSUES.md.
 *
 * 2 ms is the old `medium` unit reading carried across at the exchange rate the
 * rest of the ladder now uses (tier 0 was 11 units and is 11 ms). Sanity check
 * against the sweep: `plasma` renders a full particle field for 0.87 ms on this
 * GPU, so 2 ms buys roughly two fullscreen-equivalents — about right for a
 * nine-level mip pyramid plus two cheap passes, and deliberately not generous.
 */
export const POST_CHAIN_MS = 2

/**
 * `FeedbackPass`, mounted permanently in the post chain (see EffectsDirector).
 *
 * Two fullscreen draws every frame regardless of the `trails` value — the
 * blend (a warp + two texture samples) and the copy (one texture sample) — so
 * unlike `POST_CHAIN_UNITS` this is a REAL reserved cost, not folded into that
 * estimate, because it is present whether or not `trails` is doing anything
 * visible. **Still an ESTIMATE**, not a `/bench` measurement — `/bench`
 * excludes the whole post chain today (see the caveat above), and this pass
 * did not exist when that decision was made. A warp-sample fullscreen pass is
 * lighter than bloom's nine-tap mip pyramid, and the copy draw is close to
 * free — hence half the post chain's reservation.
 */
export const FEEDBACK_MS = 1

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
  /** Post chain, plus the feedback pass while trails are actually running. */
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
