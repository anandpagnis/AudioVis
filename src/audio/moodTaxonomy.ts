import type { CharacterMood, CharacterPoint } from './characterTypes'
import type { MoodState } from './types'

/**
 * The CHARACTER taxonomy as geometry: one prototype (centre + per-axis spread)
 * per named mood, in the 4-D space of {@link CharacterPoint}.
 *
 * ## Where the centres come from
 *
 * Valence x arousal is Russell's circumplex (1980), the standard 2-D map of
 * affect; music-emotion work (Juslin & Laukka 2003; Eerola & Vuoskoski 2011)
 * adds TENSION as the axis that separates the two "dark" quadrants (sad and
 * still versus anxious and simmering) and the two "bright" ones (relaxed versus
 * exhilarated). PULSE (regular groove versus free time) is the fourth axis: it
 * is what separates a laid-back groove from a floating pad at the same arousal,
 * and a driving track from a merely loud one.
 *
 * The axes are calibrated 0..1 (see characterTypes.ts); the labeller's 1..9
 * anchors map as (x - 1) / 8: valence 1 = bleak .. 9 = joyful, arousal 1 =
 * near-still .. 9 = frantic, tension 1 = relaxed .. 9 = anxious.
 *
 * ## Design rules
 *
 *  - Every mood owns a distinct region: no two centres are closer than ~0.25
 *    in the (valence, arousal, tension) Euclidean sense unless pulse separates
 *    them (pinned by the taxonomy test in CharacterClassifier.test.ts).
 *  - `spread` is a per-axis sigma. Valence is the least reliable estimated
 *    axis, so it carries the widest sigma; pulse is the weakest discriminator,
 *    so it is wide everywhere except where it IS the defining trait (groove,
 *    driving, euphoric, serene, dreamy).
 *  - Spreads were tuned (with the classifier's softmax temperature) so a
 *    uniform sweep of the cube gives every mood a share between 2 % and 15 %;
 *    the measured split is pinned by the classifier tests.
 */

/** The MoodState values a character mood can stand in for (no 'silence'). */
export type LegacyMood = Extract<
  MoodState,
  'ambient' | 'mellow' | 'groove' | 'building' | 'peak' | 'aggressive'
>

export interface MoodPrototype {
  /** Most typical point of this mood. */
  center: CharacterPoint
  /** Per-axis sigma of the diagonal Gaussian around `center`. */
  spread: CharacterPoint
  /** The old 7-way MoodState this character most closely stands in for. */
  legacy: LegacyMood
  /** Short display name. */
  label: string
  /** Why the centre sits where it does. */
  blurb: string
}

const p = (valence: number, arousal: number, tension: number, pulse: number): CharacterPoint => ({
  valence,
  arousal,
  tension,
  pulse,
})

export const MOOD_PROTOTYPES: Record<CharacterMood, MoodPrototype> = {
  serene: {
    center: p(0.7, 0.1, 0.08, 0.15),
    spread: p(0.24, 0.11, 0.13, 0.28),
    legacy: 'ambient',
    label: 'Serene',
    blurb:
      'Bottom of the circumplex on the pleasant side: calm, spacious, still. The lowest arousal and tension of any mood; free time (low pulse) because a locked groove would make it something else.',
  },
  tender: {
    center: p(0.72, 0.30, 0.20, 0.35),
    spread: p(0.17, 0.11, 0.12, 0.3),
    legacy: 'mellow',
    label: 'Tender',
    blurb:
      'Warm, intimate, close. High valence like serene but a touch more arousal (a voice, a pulse of touch) and a gentle, loosely felt pulse. Separated from serene mainly by arousal.',
  },
  dreamy: {
    center: p(0.52, 0.22, 0.32, 0.15),
    spread: p(0.2, 0.11, 0.13, 0.25),
    legacy: 'ambient',
    label: 'Dreamy',
    blurb:
      'Hazy, floating, reverb-washed. Neutral-ambiguous valence, low arousal, a little unresolved harmony (tension low-to-mid) and almost no pulse: drifting rather than moving.',
  },
  melancholic: {
    center: p(0.22, 0.25, 0.36, 0.3),
    spread: p(0.15, 0.11, 0.13, 0.3),
    legacy: 'mellow',
    label: 'Melancholic',
    blurb:
      'Sad, wistful, bittersweet: the low-valence, low-arousal quadrant of the circumplex. Tension is low-to-mid, since longing is unresolved but not anxious; pulse is a slow, loose one.',
  },
  brooding: {
    center: p(0.22, 0.45, 0.7, 0.35),
    spread: p(0.16, 0.12, 0.12, 0.3),
    legacy: 'mellow',
    label: 'Brooding',
    blurb:
      'Dark, heavy, simmering. Same low valence as melancholic but more arousal and a lot more tension: weight without release. What separates it from melancholic is tension, from tense is the lower arousal.',
  },
  mysterious: {
    center: p(0.4, 0.25, 0.62, 0.15),
    spread: p(0.17, 0.11, 0.10, 0.25),
    legacy: 'ambient',
    label: 'Mysterious',
    blurb:
      'Eerie, suspended, enigmatic. Low arousal and almost no pulse, like dreamy, but with clearly raised tension and ambiguous, slightly-dark valence.',
  },
  groove: {
    center: p(0.58, 0.5, 0.22, 0.85),
    spread: p(0.2, 0.14, 0.15, 0.2),
    legacy: 'groove',
    label: 'Groove',
    blurb:
      'A locked, laid-back pocket. Mid valence, mid arousal, low tension; defined by high pulse. The centre of the "head-nodding" region and the fall-back for steady, unremarkable rhythm.',
  },
  playful: {
    center: p(0.86, 0.46, 0.10, 0.6),
    spread: p(0.22, 0.17, 0.17, 0.3),
    legacy: 'groove',
    label: 'Playful',
    blurb:
      'Light, bouncy, quirky. Very high valence with moderate arousal and almost no tension; a mid-high pulse. Sits above groove on valence.',
  },
  uplifting: {
    center: p(0.74, 0.68, 0.18, 0.55),
    spread: p(0.14, 0.11, 0.12, 0.3),
    legacy: 'building',
    label: 'Uplifting',
    blurb:
      'Hopeful, rising, inspiring. High valence with a mid-high arousal; released tension. The upper-right of the circumplex short of full euphoria.',
  },
  euphoric: {
    center: p(0.93, 0.88, 0.15, 0.85),
    spread: p(0.2, 0.17, 0.2, 0.28),
    legacy: 'peak',
    label: 'Euphoric',
    blurb:
      'Ecstatic, festival-like peak joy: the extreme top-right of the circumplex with low tension and a strong, locked pulse. Separated from uplifting by higher arousal and pulse.',
  },
  driving: {
    center: p(0.5, 0.82, 0.48, 0.95),
    spread: p(0.22, 0.12, 0.15, 0.15),
    legacy: 'peak',
    label: 'Driving',
    blurb:
      'Propulsive, relentless, urgent. High arousal and the highest pulse of any mood, with valence neutral (determined rather than joyful or hostile) and moderate tension.',
  },
  tense: {
    center: p(0.3, 0.65, 0.9, 0.4),
    spread: p(0.19, 0.13, 0.10, 0.3),
    legacy: 'building',
    label: 'Tense',
    blurb:
      'Anxious, suspenseful, on edge. The highest tension of any mood with mid-high arousal and low-mid valence; pulse is irregular. Separated from brooding by higher arousal, from aggressive by lower arousal and less hostility.',
  },
  aggressive: {
    center: p(0.15, 0.92, 0.75, 0.65),
    spread: p(0.17, 0.09, 0.15, 0.3),
    legacy: 'aggressive',
    label: 'Aggressive',
    blurb:
      'Angry, harsh, violent. The lowest valence and highest arousal, with high tension. The bottom-right (negative valence, high arousal) corner of the circumplex.',
  },
  epic: {
    center: p(0.7, 0.78, 0.58, 0.55),
    spread: p(0.14, 0.11, 0.12, 0.3),
    legacy: 'peak',
    label: 'Epic',
    blurb:
      'Grand, cinematic, triumphant. Positive valence and high arousal like uplifting/euphoric, but with substantial tension (scale, struggle, unresolved swells) and only a middling pulse.',
  },
}

/** character mood -> the old 7-way MoodState it stands in for (compat layer). */
export const LEGACY_MAP: Record<CharacterMood, LegacyMood> = {
  serene: MOOD_PROTOTYPES.serene.legacy,
  tender: MOOD_PROTOTYPES.tender.legacy,
  dreamy: MOOD_PROTOTYPES.dreamy.legacy,
  melancholic: MOOD_PROTOTYPES.melancholic.legacy,
  brooding: MOOD_PROTOTYPES.brooding.legacy,
  mysterious: MOOD_PROTOTYPES.mysterious.legacy,
  groove: MOOD_PROTOTYPES.groove.legacy,
  playful: MOOD_PROTOTYPES.playful.legacy,
  uplifting: MOOD_PROTOTYPES.uplifting.legacy,
  euphoric: MOOD_PROTOTYPES.euphoric.legacy,
  driving: MOOD_PROTOTYPES.driving.legacy,
  tense: MOOD_PROTOTYPES.tense.legacy,
  aggressive: MOOD_PROTOTYPES.aggressive.legacy,
  epic: MOOD_PROTOTYPES.epic.legacy,
}
