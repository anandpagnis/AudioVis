/**
 * What is actually rendering right now, in budget units.
 *
 * ## Why this exists
 *
 * The frame budget had three independent claimants, each reserving against a
 * different partial view of the same frame:
 *
 *   - `composeLayers` reserved the primary and admitted layers — blind to
 *     effects, the post chain and the generative overlay.
 *   - `EffectDirector` reserved the primary and any live effects — blind to the
 *     **layers**, so an effect could fire on top of a full three-slot
 *     composition while believing the frame held one scene.
 *   - `canFundOverlap` reserved the two primaries — blind to effects.
 *
 * And nothing at all accounted for the two costs that are present in *every*
 * frame: the post chain (a bloom mip pyramid plus chromatic aberration and
 * vignette) and `GenerativeLayer`, which `Stage` keeps mounted for the session
 * once it has ever been enabled — and `generative` defaults to true.
 *
 * Three partial views of one resource is how a budget confidently overcommits:
 * each claimant is individually correct and the sum is not. This module is the
 * single place that knows the whole frame, so a claimant asks "what is already
 * committed?" instead of assembling its own guess.
 *
 * ## Units, and their honesty
 *
 * Same scale as slotBudget.ts — low 1 / medium 2 / high 4, calibrated per
 * `ScenePerformanceCost`. Scene costs are now measured (see `/bench`); the two
 * fixed costs below are NOT, and are flagged as estimates. They are reasoned
 * rather than invented — a bloom mip chain is roughly a fullscreen pass and a
 * half, the generative overlay is one fullscreen fbm quad — but reserving a
 * reasoned estimate is strictly better than the previous reservation of zero,
 * which is what let a full composition plus post plus generative present itself
 * to the budget as a single scene.
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
 * frame is the one number never measured. Treated as `medium`. Measuring it is
 * the obvious next benchmark task; see F43 in docs/ISSUES.md.
 */
export const POST_CHAIN_UNITS = 2

/**
 * `FeedbackPass`, mounted permanently in the post chain (see EffectsDirector).
 *
 * Two fullscreen draws every frame regardless of the `trails` value — the
 * blend (a warp + two texture samples) and the copy (one texture sample) — so
 * unlike `POST_CHAIN_UNITS` this is a REAL reserved cost, not folded into that
 * estimate, because it is present whether or not `trails` is doing anything
 * visible. **Still an ESTIMATE**, not a `/bench` measurement — `/bench`
 * excludes the whole post chain today (see the caveat above), and this pass
 * did not exist when that decision was made. Treated as `low`: a warp-sample
 * fullscreen pass is lighter than bloom's nine-tap mip pyramid, and the copy
 * draw is close to free.
 */
export const FEEDBACK_UNITS = 1

/**
 * The optical racks (`MirrorPass`, `LensPass`) — deliberately **zero**.
 *
 * Not an oversight and not an estimate. Both racks default to inert and set
 * their own `enabled` flag from their settings, and `EffectComposer` skips a
 * disabled pass before it ever renders, so at rest they cost exactly nothing —
 * there is no draw to reserve against.
 *
 * When one IS switched on it costs roughly a fullscreen pass (the mirror is a
 * single UV remap plus one tap; the lens is three taps for the prismatic split,
 * and `anamorphic` adds 24 more for its streak gather). That cost is real and
 * currently unreserved, which is defensible only while nothing autonomous turns
 * them on — a human moving a slider is a human who can see the frame rate.
 * **Before any director drives these, give them a real non-zero reservation**
 * and fold them into the F44 bench task, or the budget will admit a layer on
 * top of a rack it did not know was running.
 */
export const OPTICAL_RACK_UNITS = 0

/**
 * The AI-texture overlay, when enabled.
 *
 * One fullscreen additive quad with an fbm-based warp — cheaper than a
 * raymarcher, comparable to a simple procedural scene. **ESTIMATE**, same
 * caveat as above. Treated as `low`.
 *
 * Worth knowing: `Stage` mounts this permanently once `generative` has ever
 * been true in a session (so toggling off fades gracefully), and the store
 * defaults it to true — so for most users this cost is always present, and it
 * was never in the budget at all.
 */
export const GENERATIVE_UNITS = 1

/**
 * Live breakdown of the frame's committed cost. Mutated in place once per frame
 * by `SceneManager`, which is the only component that knows every mounted
 * entry; read by everything that wants to spend budget.
 *
 * A plain mutable singleton, matching `performanceState`'s contract: one writer,
 * many readers, no allocation in the render loop.
 */
export const frameLoad = {
  /** The committed primary subject. */
  primary: 0,
  /** A second primary during a crossfade, or a warming candidate still drawing. */
  incoming: 0,
  /** Background + accent + overlay, as actually mounted (not as desired). */
  layers: 0,
  /** Effect scenes currently firing. */
  effects: 0,
  /** Post chain, the feedback pass, plus the generative overlay when mounted. */
  fixed: POST_CHAIN_UNITS + FEEDBACK_UNITS,
}

/**
 * Everything already committed this frame.
 *
 * What a new claimant must reserve against. Deliberately includes `incoming`:
 * during a crossfade the frame really is carrying two subjects, and that is
 * exactly the moment an extra layer or effect must not be admitted.
 */
export function committedUnits(): number {
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
export function remainingUnits(budget: number): number {
  return Math.max(0, budget - committedUnits())
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
  /** Already resolved through `slotCost` for this entry's role. */
  units: number
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
      if (e.dir === 1) primary += e.units
      else incoming += e.units
    } else if (e.role === 'effect') {
      effects += e.units
    } else {
      layers += e.units
    }
  }
  frameLoad.primary = primary
  frameLoad.incoming = incoming
  frameLoad.layers = layers
  frameLoad.effects = effects
  frameLoad.fixed = fixed
}
