/**
 * The mood-read quality gate AutoPilot applies before a committed mood change
 * may move the SCENE or palette.
 *
 * Extracted into its own leaf module so the session recorder can grade a
 * recording against the SAME thresholds the live gate uses, without importing
 * `AutoPilot.tsx` (which pulls in React and the whole scene registry).
 */

/**
 * Confidence a mood read needs before it may move the SCENE (F118 → F121).
 *
 * ## History
 *
 * F118: a recording showed `AutoPilot` had never once driven a scene change —
 * across 155 s of real music `mood.confidence` peaked at **0.392** and averaged
 * 0.259, and the gate was **0.4**, so nothing ever cleared it. Lowered to 0.25
 * ("just under the observed mean") as a stopgap, with the real cause flagged:
 * "a confidence that never exceeds 0.39 suggests the estimator's scale is
 * itself suspect".
 *
 * F121 fixed that scale. `MoodEstimator` built `confidence` from the RAW score
 * margin while the `ambiguity` line right above it used the NORMALIZED one; the
 * rebuild derives `confidence` from `1 - ambiguity` (plus dwell + winner-held
 * terms), so a genuinely decisive read now reaches ~0.9 and a near-tie stays
 * low — the range the gate was always meant to sit in.
 *
 * **0.5 is an interim value** — mid-range of the rebuilt formula, so a
 * moderately-clear-or-better read passes and a contested one does not. It is
 * NOT calibrated against a recording yet; `corpus/eval-report.md`
 * (`npm run calibrate`) is where the final value gets set once the harness has
 * run over real audio. The blast radius stays bounded meanwhile:
 * `MIN_SUBJECT_DWELL_BEATS` (32 beats) throttles the rate and `pendingSceneId`
 * stops a second request evicting a warming one.
 *
 * `MOOD_CHANGE_MAX_AMBIGUITY` stays at 0.6 — the `score()` checklist rewrite
 * (F121 phase 5) shifts the ambiguity distribution, so it is re-checked after
 * that, not now.
 */
export const MOOD_CHANGE_MIN_CONFIDENCE = 0.5
export const MOOD_CHANGE_MAX_AMBIGUITY = 0.6
/** Confidence for the *predictive* prefetch path (aim at `predictedState`
 * before it commits) — a clearer read than a reactive switch, since a wrong
 * guess prefetches the wrong scene. */
export const MOOD_PREDICT_MIN_CONFIDENCE = 0.65
