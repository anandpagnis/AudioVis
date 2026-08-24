import type { MoodState } from '../audio/types'
import { NEUTRAL, clamp01, type SceneParams } from '../scenes/contract'
import { approach } from './performanceState'

/**
 * The AI Performance Director's continuous hand on the scene dials.
 *
 * Scene selection was the whole of the director's vocabulary before this: it
 * could choose WHICH scene, and after that the scene played itself. Between two
 * section boundaries the picture had no idea whether it was in a build or a
 * breakdown — the bands moved, but the art direction did not. Choosing a scene
 * for a mood and then leaving it alone is a slideshow with reactive frames, not
 * a performance.
 *
 * Scene Contract v1 makes the missing half expressible. Because `complexity`
 * means the same thing in every scene, the director can steer it without
 * knowing which scene is mounted — including scenes that did not exist when
 * this file was written, and scenes shipped by somebody else. That is the
 * difference between an auto-VJ that switches clips and one that PERFORMS a
 * clip it has never seen.
 *
 * ## What this deliberately does not steer
 *
 * Two of the seven are left alone, and not for want of a mapping:
 *
 *  - **`shape`** picks WHICH silhouette a scene wears inside its own family.
 *    That is an art-direction choice with no musical quantity behind it — a
 *    tunnel is not "more bent" at 128 BPM than at 124 — so steering it would be
 *    the director redecorating on a timer. It stays the user's.
 *  - **`tilt`** is a viewpoint offset, and viewpoint already has an owner: the
 *    CameraDirector, which picks a camera mode per scene per section. Two
 *    systems easing the same axis toward different targets do not average, they
 *    fight, and the visible result is a frame that drifts and never settles.
 *
 * Declining them is the point rather than an omission. A director that writes
 * every field it CAN write is how the seam in performanceState.ts acquired four
 * inert fields; a dial nobody is fighting over is a dial a human can still own.
 *
 * ## Why it eases rather than sets
 *
 * A mood commit is a step change, and stepping five dials at once on a section
 * boundary reads as a glitch — every scene would visibly reshape on the same
 * frame the crossfade starts. So the targets below are targets, and the state
 * approaches them over seconds. This is the "directors decide, executors
 * interpolate" half of the performanceState contract, applied to the director's
 * own output.
 */

/**
 * The dials the director drives. The other two are documented above.
 *
 * `as const` rather than `SceneParamKey[]`, so {@link SteerTarget} below is the
 * exact five-key record: adding a key here without adding its mood row and its
 * tension gain is then a type error instead of a dial the director silently
 * never moves.
 */
export const STEERED_KEYS = ['speed', 'complexity', 'density', 'fill', 'contrast'] as const

/** A steer target, one entry per {@link STEERED_KEYS} member. */
type SteerTarget = Record<(typeof STEERED_KEYS)[number], number>

/**
 * Resting dial positions per mood — the art direction of the auto-VJ.
 *
 * Read down a column to see what the director believes a mood looks like: a
 * quiet passage is slow, sparse and soft; a peak is fast, dense, hard-edged and
 * fills the frame. Read across a row to see the journey the show performs
 * across a track, which is the thing legacy visualizers cannot do at all —
 * these numbers are a function of musical STRUCTURE, not of the last 20 ms of
 * audio.
 *
 * `groove` is deliberately near-neutral on every axis. It is the most common
 * mood by a distance, so parking it at ~0.5 means the steer spends most of a
 * track close to each scene's authored look and reserves its range for the
 * moments that earn a change. A groove that already sat at 0.7 would have
 * nowhere left to go at the drop.
 *
 * `aggressive` is NOT simply "more peak". It is harder (contrast 0.84, the
 * table's highest) but slightly less dense than `peak`, because the two are
 * different pictures: a peak is everything at once, aggression is fewer, harder
 * elements. Making it a strict superset of peak is what would leave the show
 * with one loud look instead of two.
 */
const MOOD_TARGETS: Record<MoodState, SteerTarget> = {
  silence: { speed: 0.3, complexity: 0.25, density: 0.2, fill: 0.3, contrast: 0.35 },
  ambient: { speed: 0.34, complexity: 0.32, density: 0.28, fill: 0.38, contrast: 0.38 },
  mellow: { speed: 0.42, complexity: 0.4, density: 0.38, fill: 0.45, contrast: 0.45 },
  groove: { speed: 0.52, complexity: 0.52, density: 0.52, fill: 0.52, contrast: 0.55 },
  building: { speed: 0.58, complexity: 0.64, density: 0.6, fill: 0.58, contrast: 0.62 },
  peak: { speed: 0.7, complexity: 0.8, density: 0.78, fill: 0.72, contrast: 0.78 },
  aggressive: { speed: 0.74, complexity: 0.78, density: 0.74, fill: 0.7, contrast: 0.84 },
}

/**
 * How much dramatic pressure adds on top of the mood's resting position.
 *
 * Tension is anticipation, not loudness (see `PerformanceState.visualTension`),
 * so this is what makes the bar BEFORE a drop look different from the same mood
 * without one — the phrase-level response that the mood table alone, refreshed
 * only on a commit, cannot express.
 *
 * Weighted toward `contrast` and `complexity` because those read as pressure:
 * detail crowding in and edges hardening. `speed` gets the smallest share on
 * purpose — a build that mostly speeds up reads as a tempo change, which is a
 * lie about the music, and beat-locked motion would not follow it anyway.
 */
const TENSION_GAIN: SteerTarget = {
  speed: 0.06,
  complexity: 0.12,
  density: 0.08,
  fill: 0.1,
  contrast: 0.14,
}

/**
 * How fast the steer closes on its target, as a fraction of the gap per second.
 *
 * ~0.35 puts a full-range move at roughly three seconds, which is around a bar
 * at 90 BPM. Slow enough that a mood commit reads as the picture *developing*
 * rather than snapping; fast enough that the change has landed before the
 * section it belongs to is over.
 *
 * A drop overrides this — see {@link advanceSteer}.
 */
const STEER_RATE = 0.35

/**
 * How fast the steer moves on a drop.
 *
 * A drop is the one musical event where a slow ease is WRONG: the whole point of
 * the moment is that it is instant, and a picture that takes three seconds to
 * arrive at its peak look has missed it. Fast enough to land inside a beat,
 * still an ease rather than a set so nothing pops.
 */
const DROP_RATE = 6

/**
 * Where the dials should sit for this mood and this much dramatic pressure.
 *
 * Pure, so the whole art direction above is testable without a render loop.
 */
export function steerTargets(mood: MoodState, tension: number): SteerTarget {
  const base = MOOD_TARGETS[mood] ?? MOOD_TARGETS.groove
  const t = clamp01(tension)
  const out = {} as SteerTarget
  for (const k of STEERED_KEYS) out[k] = clamp01(base[k] + TENSION_GAIN[k] * t)
  return out
}

/**
 * Ease `state` one frame toward the steer target for this mood.
 *
 * Mutates in place — `state` is `performanceState.sceneParams`, and the render
 * loop allocates nothing. Sparse by construction: only {@link STEERED_KEYS} are
 * ever written, so `shape` and `tilt` are absent rather than present-and-neutral
 * and the resolver can tell "the director has no opinion" from "the director
 * wants 0.5".
 */
export function advanceSteer(
  state: SceneParams,
  opts: { mood: MoodState; tension: number; delta: number; drop?: boolean },
): void {
  const targets = steerTargets(opts.mood, opts.tension)
  const rate = opts.drop ? DROP_RATE : STEER_RATE
  for (const k of STEERED_KEYS) {
    // First frame starts from the target rather than easing up from a
    // hardcoded neutral: at boot there is no previous position to preserve, and
    // easing from 0.5 would make every scene visibly settle for three seconds
    // after the first note.
    const from = state[k]
    state[k] = from === undefined ? targets[k] : approach(from, targets[k], rate, opts.delta)
  }
}

/**
 * Drop the director's opinion entirely.
 *
 * Called when mood-driven automation is switched off, so the scenes fall back to
 * their authored defaults (and whatever the user has dialled) instead of being
 * frozen at whatever the steer happened to be holding when it was disabled.
 */
export function clearSteer(state: SceneParams): void {
  for (const k of STEERED_KEYS) delete state[k]
}

/** Neutral steer, for tests and for a first frame with no mood yet. */
export function neutralSteer(): SceneParams {
  const out: SceneParams = {}
  for (const k of STEERED_KEYS) out[k] = NEUTRAL
  return out
}
