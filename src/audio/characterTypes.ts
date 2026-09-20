/**
 * The shared contract of the mood engine's CHARACTER layer.
 *
 * The old engine reduced everything to one 7-way label (`MoodState`), mixing two
 * different questions: how INTENSE is this moment (ambient..peak), and what is
 * its CHARACTER (dark? tender? euphoric?). This layer answers only the second,
 * slowly (seconds, not frames), as a point in a continuous space plus a
 * probability distribution over named moods. Intensity stays with the existing
 * `MoodEstimator` / `SectionTracker`.
 *
 * Coordinates (all 0..1, already calibrated so the corpus spreads across the
 * range instead of piling up in the middle):
 *   valence   0 = dark / sad / hostile      1 = bright / joyful / warm
 *   arousal   0 = near-still                1 = frantic / very intense
 *   tension   0 = relaxed, consonant        1 = anxious, dissonant, suspenseful
 *   pulse     0 = beatless / free time      1 = locked, regular groove
 *
 * The mood ids are the SAME taxonomy the offline Gemini labeller uses
 * (scripts/mood-labels/lib.mjs MOODS), so engine output can be compared to those
 * labels directly.
 */
export const CHARACTER_MOODS = [
  'serene',
  'tender',
  'dreamy',
  'melancholic',
  'brooding',
  'mysterious',
  'groove',
  'playful',
  'uplifting',
  'euphoric',
  'driving',
  'tense',
  'aggressive',
  'epic',
] as const

export type CharacterMood = (typeof CHARACTER_MOODS)[number]

/** A point in the character space. Every field is 0..1. */
export interface CharacterPoint {
  valence: number
  arousal: number
  tension: number
  pulse: number
}

/** What the classifier is fed each update (from the dimension estimator). */
export interface CharacterInput extends CharacterPoint {
  /** False until the estimators have enough signal (warm-up, silence). */
  valid: boolean
  /** 0..1 confidence in valence specifically (it is the weakest axis). Default 1. */
  valenceConfidence?: number
}

/** What the rest of the app reads. */
export interface CharacterState extends CharacterPoint {
  /** Probability of each named mood; sums to 1 (all zeros while `!valid`). */
  dist: Record<CharacterMood, number>
  /** Committed, hysteresis-held primary mood; null until first valid read. */
  primary: CharacterMood | null
  /** Runner-up mood, or null when it is negligible. */
  secondary: CharacterMood | null
  /** Blend weight of `secondary` relative to `primary`, 0..0.5. */
  secondaryWeight: number
  /** 0..1: how decisive the read is (margin and entropy of `dist`). */
  confidence: number
  /** Normalised Shannon entropy of `dist`, 0 = certain .. 1 = uniform. */
  entropy: number
  /** True for exactly the update on which `primary` changed. */
  changed: boolean
  /** Seconds since `primary` was last committed. */
  heldFor: number
  /** True once the estimators have produced a usable read. */
  valid: boolean
}

export function createEmptyCharacterState(): CharacterState {
  const dist = {} as Record<CharacterMood, number>
  for (const m of CHARACTER_MOODS) dist[m] = 0
  return {
    valence: 0.5,
    arousal: 0.5,
    tension: 0.5,
    pulse: 0,
    dist,
    primary: null,
    secondary: null,
    secondaryWeight: 0,
    confidence: 0,
    entropy: 1,
    changed: false,
    heldFor: 0,
    valid: false,
  }
}
