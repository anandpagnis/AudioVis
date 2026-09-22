import type { MoodState } from '../audio/types'
import { getSceneContract } from '../scenes'
import { NEUTRAL, clamp01, type SceneParams } from '../scenes/contract'
import type { LookProfile } from './look/lookRow'
import { approach, performanceState } from './performanceState'

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
 * ## The one exception: a scene that opts in
 *
 * Both reasons above are about scenes whose `shape` / `tilt` are camera-relative or arbitrary. A scene that
 * ignores the camera (a full-screen raymarcher) and gives one of them a meaning a director can safely drive — a
 * 4D rotation angle, a symmetry count — says so with `contract.directorSteers`, and ONLY then, and ONLY while the
 * mood look profile is in charge (`advanceSteer`'s `look`), does the director write it: `shape` follows the
 * profile's complexity (more complex, more symmetry / segments) and `tilt` follows the build (a sweep that
 * winds up as a build rises). A scene that did not opt in never has either key in the steer block.
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

/** Which profile field is the resting position of each steered dial. */
const LOOK_STEER_FIELDS = {
  speed: 'steerSpeed',
  complexity: 'steerComplexity',
  density: 'steerDensity',
  fill: 'steerFill',
  contrast: 'steerContrast',
} as const satisfies Record<(typeof STEERED_KEYS)[number], keyof LookProfile>

/**
 * {@link steerTargets}, from the mood look profile instead of the 7-row table: the resting position of each dial is
 * the profile's blended `steer*` (already carrying the descriptor and build / breakdown modifiers) and the
 * SAME tension terms are added on top, so the bar before a drop still hardens the picture.
 */
export function steerTargetsFromLook(look: LookProfile, tension: number): SteerTarget {
  const t = clamp01(tension)
  const out = {} as SteerTarget
  for (const k of STEERED_KEYS) out[k] = clamp01(look[LOOK_STEER_FIELDS[k]] + TENSION_GAIN[k] * t)
  return out
}

/**
 * Where a director-steered `shape` should sit for this profile (only ever applied to a scene that opted in):
 * 0.35 at the simplest look, 0.85 at the most complex — more complex reads as more symmetry / segments.
 */
export function shapeTarget(look: LookProfile): number {
  return clamp01(0.35 + 0.5 * look.steerComplexity)
}

/**
 * Where a director-steered `tilt` should sit for this profile (only ever applied to a scene that opted in):
 * level (0.5) at rest, wound up by the build (+0.4 at full build intent) with a small lean with the speed dial
 * (+-0.075), so it sweeps as a build rises and relaxes with it.
 */
export function tiltTarget(look: LookProfile): number {
  return clamp01(0.5 + 0.4 * look.buildIntent + 0.15 * (look.steerSpeed - 0.5))
}

type DirectorSteer = 'shape' | 'tilt'
const DIRECTOR_STEER_KEYS: readonly DirectorSteer[] = ['shape', 'tilt']
const NO_STEERS: readonly DirectorSteer[] = []

/** The dials a scene has opted into steering beyond the five; none for a scene without the flag or a contract. */
function directorSteersOf(sceneId: string): readonly DirectorSteer[] {
  return getSceneContract(sceneId)?.directorSteers ?? NO_STEERS
}

/**
 * Ease `state` one frame toward the steer target for this mood.
 *
 * Mutates in place — `state` is `performanceState.sceneParams`, and the render
 * loop allocates nothing. Sparse by construction: only {@link STEERED_KEYS} are
 * ever written — plus `shape` / `tilt` for a scene that opted in, see below — so
 * they are absent rather than present-and-neutral and the resolver can tell "the
 * director has no opinion" from "the director wants 0.5".
 *
 * ## `look` — the mood look profile (optional)
 *
 * When given (the caller passes it only while the profile is valid and its `scene` family is on), the five
 * resting targets come from the profile's `steer*` fields ({@link steerTargetsFromLook}) instead of `mood`'s row;
 * the tension terms, the {@link STEER_RATE} easing and the {@link DROP_RATE} drop rate are unchanged.
 *
 * It also steers `shape` and `tilt` ({@link shapeTarget}, {@link tiltTarget}) — but only for the ACTIVE scene, and only if its
 * contract lists the dial in `directorSteers`. `state` is one block shared by every mounted scene and the
 * resolver hands a steered value to any scene that declares that dial, so the opt-in is enforced here too: a
 * `shape` / `tilt` left in `state` by a scene that opted in is REMOVED as soon as the active scene has not
 * (otherwise the next scene would inherit its symmetry). `directorSteers` overrides which dials the active scene
 * has opted into (default: read from `performanceState.activeScene`'s contract; a test seam).
 *
 * Omitted, this is the original behaviour: the five dials from `mood`, and `shape` / `tilt` never written.
 */
export function advanceSteer(
  state: SceneParams,
  opts: {
    mood: MoodState
    tension: number
    delta: number
    drop?: boolean
    look?: LookProfile
    directorSteers?: readonly DirectorSteer[]
  },
): void {
  const look = opts.look
  const targets = look ? steerTargetsFromLook(look, opts.tension) : steerTargets(opts.mood, opts.tension)
  const rate = opts.drop ? DROP_RATE : STEER_RATE
  for (const k of STEERED_KEYS) {
    // First frame starts from the target rather than easing up from a
    // hardcoded neutral: at boot there is no previous position to preserve, and
    // easing from 0.5 would make every scene visibly settle for three seconds
    // after the first note.
    const from = state[k]
    state[k] = from === undefined ? targets[k] : approach(from, targets[k], rate, opts.delta)
  }

  // shape / tilt: only ever present while the active scene has opted in. The contract is looked up only when
  // there is something to steer or to clean up, so the ordinary legacy frame does no lookup at all.
  if (look || state.shape !== undefined || state.tilt !== undefined) {
    const optedIn = opts.directorSteers ?? directorSteersOf(performanceState.activeScene)
    for (const k of DIRECTOR_STEER_KEYS) {
      if (!optedIn.includes(k)) {
        if (state[k] !== undefined) delete state[k]
      } else if (look) {
        const goal = k === 'shape' ? shapeTarget(look) : tiltTarget(look)
        const from = state[k]
        state[k] = from === undefined ? goal : approach(from, goal, rate, opts.delta)
      }
    }
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
  // Also the two an opted-in scene may have had steered (see advanceSteer): "no opinion" means no key at all.
  for (const k of DIRECTOR_STEER_KEYS) delete state[k]
}

/** Neutral steer, for tests and for a first frame with no mood yet. */
export function neutralSteer(): SceneParams {
  const out: SceneParams = {}
  for (const k of STEERED_KEYS) out[k] = NEUTRAL
  return out
}
