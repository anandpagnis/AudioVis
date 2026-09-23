/**
 * Tempo -> visual speed. A 160 BPM track should read as visibly faster than an 80 BPM one; nothing in the
 * engine did that before this (see `docs/ISSUES.md`, the structure/tempo plan: every "overall speed" dial —
 * `moodParams.ts`'s global reactivity multiplier, `CameraDirector.tsx`'s motion rate — was mood/energy-only).
 *
 * ## The formula
 *
 * `1 + K * log2(bpm / REF_BPM)`, clamped. Log-scaled because tempo is *perceived* logarithmically — doubling or
 * halving a tempo are roughly equal perceptual steps, not additive ones (a linear `bpm/refBpm` ratio would make
 * a 200 BPM track look absurdly frantic next to a 60 BPM one, out of proportion to how much faster it actually
 * feels). `REF_BPM = 120` is the pivot (multiplier exactly 1 there): both the median of `BpmEstimator`'s own
 * detectable range (60-200) and the well-documented "preferred tempo" / tapping-tempo center in tempo-perception
 * research (roughly 85-120 BPM). The clamp mainly protects the LOW end (60 BPM computes a raw 0.4, which would
 * read as sluggish rather than merely slow) and caps the damage of an octave-double misread on the high end
 * (a 160 track misread as 320 computes ~1.85 pre-clamp) — `BpmEstimator`'s own octave correction is what should
 * actually prevent that misread; this clamp is a second, cheap line of defence, not the primary fix.
 *
 * ## Why this takes `bpm` directly, not raw estimator internals
 *
 * `f.bpm` is already `BpmEstimator`'s OCTAVE-CORRECTED read (`evaluate()`'s `gridFit`/`octaveLock` machinery
 * reconciles e.g. a detected-80 and a detected-160 candidate for the same track onto one metrical level before
 * publishing `f.bpm`). This function takes only `(bpm, confidence)` — two scalars, nothing from `BpmEstimator`
 * imported — so there is no way to double-apply octave correction here even by accident.
 *
 * ## Confidence gating
 *
 * A rough BPM number appears within a second or two of onsets, but `BpmEstimator`'s own `confidence` needs
 * several seconds to ramp (its own update is `confidence += (target - confidence) * 0.3`, a ~3.3 s time
 * constant) — so the raw formula is blended toward neutral (1, no effect) below `CONFIDENCE_FLOOR` and reaches
 * full effect only above `CONFIDENCE_CEIL`, the same "ease in as the read firms up" shape the mood system's own
 * confidence-sharpened blending already uses (`characterLook.ts`'s `relax`, `LookProfileTracker`'s entropy ramp).
 */

/** Multiplier at `bpm === REF_BPM`. */
export const REF_BPM = 120
/** Slope in log2(bpm/REF_BPM)-space. */
export const TEMPO_SPEED_K = 0.6
export const TEMPO_SPEED_MIN = 0.6
export const TEMPO_SPEED_MAX = 1.6
/** Below this beat-tracking confidence, the multiplier is fully neutral (1). */
export const CONFIDENCE_FLOOR = 0.15
/** Above this confidence, the multiplier reaches its full, unblended value. */
export const CONFIDENCE_CEIL = 0.5

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * The tempo-driven speed multiplier for one frame. Pure, no allocation, safe on any input (non-finite or
 * non-positive `bpm` reads as neutral — a bad read should never yank visual speed around).
 */
export function tempoSpeedMultiplier(bpm: number, confidence: number): number {
  if (!Number.isFinite(bpm) || bpm <= 0) return 1
  const raw = 1 + TEMPO_SPEED_K * Math.log2(bpm / REF_BPM)
  const clamped = clamp(raw, TEMPO_SPEED_MIN, TEMPO_SPEED_MAX)
  const c = Number.isFinite(confidence) ? confidence : 0
  const blend = clamp((c - CONFIDENCE_FLOOR) / (CONFIDENCE_CEIL - CONFIDENCE_FLOOR), 0, 1)
  return 1 + (clamped - 1) * blend
}
