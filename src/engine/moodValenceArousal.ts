import type { MoodState } from '../audio/types'
import type { ValenceArousal } from './valenceArousal'

/**
 * Where each of the 7 discrete mood labels sits in continuous valence/arousal
 * space — the bridge between `mood.state` (what most of this engine still
 * routes decisions through) and `computeValenceArousal`'s continuous read
 * (what the live music is actually doing right now).
 *
 * ## Why this table, not per-item hand annotation
 *
 * The audit this responds to suggested hand-placing every scene and every
 * palette in valence/arousal space individually — "a two-number annotation
 * per palette, an afternoon of work". That asks for new authored content
 * across ~15 scenes and 30 palettes. This engine already HAS the equivalent
 * information, encoded differently: every scene declares a `moodFit` table
 * (how well it suits each mood) and every palette sits in one or more
 * `MOOD_PALETTES` pools. Placing the 7 MOODS in VA space once, here, and then
 * DERIVING each scene's or palette's position as the `moodFit`- or
 * pool-membership-weighted average of the moods it already associates with
 * ({@link deriveVA}) gets the same continuous placement with zero new
 * authoring — it reuses judgment this codebase's own authors already spent.
 *
 * ## How the seven points were placed
 *
 * Standard circumplex-model quadrant descriptions (Russell), cross-referenced
 * against what each mood already means operationally in this codebase (see
 * `MoodEstimator.ts`'s own calibration notes):
 *
 *  - `silence` / `ambient` — near-zero arousal, the low end of the axis this
 *    whole engine measures by. Valence mildly positive for ambient (open,
 *    spacious material reads as calm-pleasant, not calm-unpleasant); silence
 *    itself has no material to have a valence about, so it sits at 0.
 *  - `mellow` / `groove` — the low-to-mid arousal band, both positive
 *    valence: relaxed-pleasant and engaged-pleasant respectively, the
 *    classic "having a good time" region of the plane.
 *  - `building` — high arousal, valence tipped slightly NEGATIVE. This is
 *    deliberate and is the one placement worth defending explicitly: a
 *    build-up is anticipation, which the circumplex model places nearer
 *    tension than pleasure — harmonically unresolved, energy rising toward a
 *    release that has not arrived yet. Matches `visualTension`'s own doc
 *    ("dramatic pressure... anticipation") describing the same passages.
 *  - `peak` / `aggressive` — both near-maximum arousal, opposite valence.
 *    This split is the reason the roster has two hot moods rather than one:
 *    `peak` is the euphoric release (high arousal, positive valence — the
 *    drop landing), `aggressive` is hostile intensity (high arousal, negative
 *    valence — distortion, harshness). Collapsing them to one VA point would
 *    erase the distinction the mood estimator works to draw between them.
 *
 * Judgment calls, not fitted parameters — same caveat `valenceArousal.ts`
 * states for its own weights. The tests pin quadrant/ordering relationships
 * (peak is more aroused than groove; peak and aggressive share arousal but
 * oppose in valence) rather than the exact coordinates.
 */
export const MOOD_VA: Record<MoodState, ValenceArousal> = {
  silence: { valence: 0, arousal: 0.02 },
  ambient: { valence: 0.3, arousal: 0.12 },
  mellow: { valence: 0.45, arousal: 0.3 },
  groove: { valence: 0.4, arousal: 0.55 },
  building: { valence: -0.15, arousal: 0.75 },
  peak: { valence: 0.5, arousal: 0.92 },
  aggressive: { valence: -0.5, arousal: 0.95 },
}

/**
 * Derive a continuous valence/arousal position from a set of per-mood
 * weights — a scene's `moodFit`, or an equal-weight map built from which
 * `MOOD_PALETTES` pools a palette sits in.
 *
 * Weighted average of {@link MOOD_VA} over whichever moods have a positive
 * weight. Pure and total: an empty or all-zero weight map returns the
 * "silence" point (arousal ~0, valence 0) rather than throwing or returning
 * NaN — the honest answer for "derive a position from no information" is the
 * centre of the plane's low-arousal corner, not a crash.
 */
export function deriveVA(weights: Partial<Record<MoodState, number>>): ValenceArousal {
  let sumW = 0
  let sumV = 0
  let sumA = 0
  for (const [mood, w] of Object.entries(weights) as [MoodState, number | undefined][]) {
    if (!w || !Number.isFinite(w) || w <= 0) continue
    const point = MOOD_VA[mood]
    if (!point) continue
    sumW += w
    sumV += point.valence * w
    sumA += point.arousal * w
  }
  if (sumW <= 0) return { valence: 0, arousal: 0 }
  return { valence: sumV / sumW, arousal: sumA / sumW }
}

/**
 * {@link deriveVA} from a plain list of moods (equal weight each) rather than
 * a weighted map — for palettes, which associate with moods by POOL
 * MEMBERSHIP (`MOOD_PALETTES`) rather than a graded fit.
 */
export function deriveVAFromList(moods: readonly MoodState[]): ValenceArousal {
  const weights: Partial<Record<MoodState, number>> = {}
  for (const m of moods) weights[m] = (weights[m] ?? 0) + 1
  return deriveVA(weights)
}
