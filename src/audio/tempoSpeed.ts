/**
 * Tempo -> visual speed, with a MOOD-controlled coupling strength.
 *
 * A 160 BPM track should read as faster than an 80 BPM one, but by how much depends on the music's character: a
 * driving or aggressive track should lock its motion to the tempo, while a serene or dreamy one should stay slow
 * and floaty even at 140 BPM. So the mapping has two independent parts:
 *
 *  1. {@link tempoOctaves}: the song's tempo as a signed, confidence-gated distance from 120 BPM in OCTAVES
 *     (`log2(bpm / 120)`; +1 = double time, -1 = half time). Published on `AudioFeatures.tempoOctaves`, eased.
 *  2. {@link tempoRate}: `rate = 2 ** (coupling * octaves)`, i.e. `(bpm / 120) ** coupling`. `coupling` is the
 *     per-mood exponent (`LookRow.tempoCoupling`): 0 ignores tempo entirely, 1 makes motion exactly proportional to
 *     tempo (160 BPM = 1.33x, 80 BPM = 0.67x), values in between soften the effect and values above 1 exaggerate
 *     it slightly (up to 1.2: 160 BPM = 1.41x). The result is clamped to [RATE_MIN, RATE_MAX]. The rate is 1 at 120 BPM for
 *     every coupling, so mood only changes how far the tempo pulls, never where the neutral point sits.
 *
 * ## Why a power law
 *
 * Tempo is perceived logarithmically (doubling and halving are equal steps), and motion "speed" is a
 * multiplicative quantity, so `speed ~ tempo ** coupling` is the natural form: it is linear in log-space, exactly
 * symmetric (a 2x faster and a 2x slower song sit at reciprocal rates), and the exponent is a single, readable dial
 * for "how much does this mood care about tempo".
 *
 * ## Why this takes `bpm` directly
 *
 * `f.bpm` is already `BpmEstimator`'s OCTAVE-CORRECTED read (its `gridFit`/`octaveLock` machinery reconciles e.g. a
 * detected-80 and a detected-160 candidate onto one metrical level before publishing). This module imports nothing
 * from it, so octave correction cannot be double-applied here.
 *
 * ## Confidence gating
 *
 * A rough BPM appears within a second or two of onsets, but `BpmEstimator.confidence` needs several seconds to ramp
 * (~3.3 s time constant). The octave distance is blended toward 0 (neutral) below `CONFIDENCE_FLOOR` and reaches
 * full effect only above `CONFIDENCE_CEIL` — the same "ease in as the read firms up" shape the mood system's own
 * confidence-sharpened blending uses.
 *
 * ## Reaching scenes that have no global speed
 *
 * Most shader scenes read only their own 0..1 dial through `drastic(P.speed)` (`sceneParams.ts`), never the global
 * speed. {@link speedDialBias} converts a rate into the exact offset that makes `drastic(P.speed + bias)` equal
 * `drastic(P.speed) * rate`, so the rate can be folded into that dial at one place without editing every scene.
 */

/** BPM at which the rate is exactly 1 for every coupling. */
export const REF_BPM = 120
/** Octave distance is clamped to +-this (60..240 BPM). A misread beyond it must not fling motion around. */
export const OCTAVES_MAX = 1
/** Coupling used when there is no valid mood look (warm-up, `?look=off`): the neutral row's value. */
export const DEFAULT_COUPLING = 0.68
export const RATE_MIN = 0.6
export const RATE_MAX = 1.7
/** The global speed folded into a shader scene's dial is clamped to this range: the raw product (user Speed x mood
 *  x tempo) spans 0.15..2.2, which read as too much on scenes that never had it. */
export const FOLD_SPEED_MIN = 0.6
export const FOLD_SPEED_MAX = 1.5
/** Below this beat-tracking confidence, the tempo has no effect (octaves = 0). */
export const CONFIDENCE_FLOOR = 0.15
/** Above this confidence, the tempo has its full effect. */
export const CONFIDENCE_CEIL = 0.5

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * The song's tempo as signed octaves from {@link REF_BPM}, gated by beat-tracking confidence. Pure, no allocation,
 * safe on any input: a non-finite or non-positive `bpm`, or a non-finite `confidence`, reads as 0 (neutral).
 */
export function tempoOctaves(bpm: number, confidence: number): number {
  if (!Number.isFinite(bpm) || bpm <= 0) return 0
  const oct = clamp(Math.log2(bpm / REF_BPM), -OCTAVES_MAX, OCTAVES_MAX)
  const c = Number.isFinite(confidence) ? confidence : 0
  const blend = clamp((c - CONFIDENCE_FLOOR) / (CONFIDENCE_CEIL - CONFIDENCE_FLOOR), 0, 1)
  return blend === 0 ? 0 : oct * blend // not `oct * 0`, which is -0 for a slow track
}

/**
 * Motion-rate multiplier from tempo octaves and a mood's coupling exponent. Pure, no allocation. A non-finite
 * `octaves` or `coupling` reads as 1 (neutral); a negative coupling is treated as 0 (tempo never slows a scene
 * that should speed up).
 */
export function tempoRate(octaves: number, coupling: number): number {
  if (!Number.isFinite(octaves) || !Number.isFinite(coupling)) return 1
  return clamp(2 ** (Math.max(0, coupling) * octaves), RATE_MIN, RATE_MAX)
}

/**
 * Offset to ADD to a 0..1 scene speed dial so `drastic(dial + bias) === drastic(dial) * rate`, where
 * `drastic(p) = 4 ** ((p - 0.5) * 2) = 2 ** (4 * (p - 0.5))` (`sceneParams.ts`). Exact, not an approximation.
 */
export function speedDialBias(rate: number): number {
  return Number.isFinite(rate) && rate > 0 ? Math.log2(rate) / 4 : 0
}

/**
 * A scene's 0..1 speed dial with the GLOBAL speed folded in (`getEffectiveParams().speed`: user dial x mood x
 * tempo rate), so `drastic(result) = drastic(dial) * clamp(globalSpeed)`, the global speed clamped to
 * [FOLD_SPEED_MIN, FOLD_SPEED_MAX]. A `tempoLocked` scene (its own motion already follows the beat grid, so any
 * extra multiplier pulls it OFF the beat) gets NO fold at all: its dial is returned untouched. Pure, no allocation.
 */
export function foldedSpeedDial(dial: number, globalSpeed: number, tempoLocked: boolean): number {
  if (tempoLocked) return dial
  const g = Number.isFinite(globalSpeed) ? clamp(globalSpeed, FOLD_SPEED_MIN, FOLD_SPEED_MAX) : 1
  return dial + speedDialBias(g)
}
