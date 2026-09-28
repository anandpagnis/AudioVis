import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { audioEngine, beatPulse } from '../audio/AudioEngine'
import type { MoodState } from '../audio/types'
import { getScene } from '../scenes'
import { LOOK_CAMERA_MODES, type LookProfile } from './look/lookRow'
import { approach, performanceState, type CameraMode } from './performanceState'
import { currentTempoRate } from './tempoRate'
import { rotationUnit } from './transitions'

/**
 * Owns camera motion for every scene.
 *
 * Previously each scene instantiated its own `CameraRig` and drove the camera
 * from inside its `useFrame`, which meant camera behaviour was permanently
 * welded to geometry: you could not view the wireframe hero from a spiral, or
 * reuse "slow push" anywhere else, without editing the scene. Here the scene
 * only declares WHERE it can be looked at (its anchor — subject position and a
 * comfortable viewing distance) and this decides HOW.
 *
 * Every mode is expressed relative to the anchor, so a mode works on any scene
 * that supplies one. Motion stays musical: beats pull the lens, bars sway
 * elevation, section changes can cut the angle.
 */

/** Where a scene can be looked at. Scenes declare this; they never move the camera. */
export interface CameraAnchor {
  /** Subject centre in world space. */
  target: [number, number, number]
  /** Comfortable viewing distance from the subject. */
  distance: number
  /** Nominal eye height relative to the target. */
  height: number
}

export const DEFAULT_ANCHOR: CameraAnchor = { target: [0, 0, 0], distance: 12, height: 3 }

/** Per-frame scratch — the camera path allocates nothing. Exported for tests. */
export const desired = new THREE.Vector3()
export const lookAt = new THREE.Vector3()

class CameraState {
  angle = 0
  /** Smoothed distance, so mode switches ease rather than teleport. */
  dist = 12
  height = 3
  /** Handheld noise phases — offset so the axes never move in lockstep. */
  shakeX = Math.random() * 100
  shakeY = Math.random() * 100
  /** Set when a mode change should be eased rather than cut. */
  blend = 1
}

const state = new CameraState()

/** Instant angle jump — a VJ-style cut, used on section changes. */
export function cutCamera(delta = Math.PI / 2) {
  state.angle += delta
}

/**
 * Whether a mood-authored `look.cameraCutRate` (see its doc on `LookRow`) earns an extra hard cut this counter.
 *
 * Sampled with the SAME deterministic Weyl-sequence sampler {@link rotationUnit} that `pickLookCameraMode` below
 * already uses to turn a blended weight into a statistical frequency, imported from `transitions.ts` (which
 * imports only from `./look/lookRow`, so this file importing FROM it — already done, for the same function, a
 * few lines up — is one-way and cycle-free) rather than a second, invented sampler or `Math.random()`: a
 * recorded set has to replay identically, and this reuses the exact guarantee the mode rotation already relies
 * on rather than adding a second statistical mechanism to reason about.
 *
 * `cutRate` is clamped to 0..1; non-finite (including NaN) is treated as 0 — "never cut" is the safe default for
 * a corrupt profile, matching {@link lookGain}'s own "never freeze or fling" reasoning even though the clamp
 * target differs (there the identity is 1, here it is "off"). `rotationUnit(counter) < cutRate` means the hit
 * rate converges to `cutRate` itself as `counter` advances: 0 never fires, 1 always fires, 0.5 fires close to
 * half the time — the same guarantee {@link pickLookCameraMode}'s own weighted rotation already provides.
 *
 * Exported for `PerformanceStateBridge`'s phrase-boundary hard-cut check (the camera cut-rate fix) and for direct
 * unit testing. Pure: no per-frame reseed, so the same counter always returns the same answer.
 */
export function shouldHardCut(cutRate: number, counter: number): boolean {
  const rate = !Number.isFinite(cutRate) ? 0 : cutRate < 0 ? 0 : cutRate > 1 ? 1 : cutRate
  return rotationUnit(counter) < rate
}

/**
 * Camera behaviour each mood wants, best fit first.
 *
 * Only modes a scene actually declares are eligible, so this is a *preference*
 * order rather than a mapping — a scene never gets framing it wasn't authored
 * for. The lists are deliberately long enough that every registered scene
 * resolves to a real preference for every mood instead of falling through.
 *
 * Note `handheld` appears only under `peak`/`aggressive`. That is an invariant,
 * not an accident: a shaky lens over an ambient passage reads as a mistake, and
 * the tension override below deliberately cannot introduce it.
 */
const MODE_PREFERENCE: Record<MoodState, CameraMode[]> = {
  silence: ['locked', 'hover', 'cinematic', 'orbit'],
  // `pull` sits high here: retreating from the subject is what gives an ambient
  // passage its air, and it is the one mode that reads as the show exhaling.
  ambient: ['hover', 'pull', 'cinematic', 'locked', 'orbit'],
  mellow: ['cinematic', 'orbit', 'hover', 'spiral', 'pull'],
  groove: ['orbit', 'spiral', 'cinematic', 'hover', 'topdown'],
  building: ['push', 'spiral', 'orbit', 'cinematic', 'hover'],
  peak: ['handheld', 'spiral', 'push', 'orbit', 'topdown'],
  aggressive: ['handheld', 'topdown', 'spiral', 'push', 'orbit'],
}

/** Above this dramatic pressure, anticipation framing outranks the mood's own. */
const TENSION_THRESHOLD = 0.55

/**
 * Framing that reads as anticipation, promoted while tension is high.
 *
 * `push` and `spiral` only — closing on the subject is what a build looks like.
 * `handheld` is excluded on purpose so the calm-mood invariant above holds at
 * every tension value, including the quiet bar before a drop.
 */
const TENSION_MODES: CameraMode[] = ['push', 'spiral']

/**
 * Above this share of recent segments carrying a vocal, framing leans intimate.
 *
 * Deliberately high: `vocalPresence` is a fraction over ~48s of audio, so 0.5
 * means the voice is a defining feature of the section rather than a passing
 * sample. A lower bar would pull the lens in on tracks with one vocal hook.
 */
const VOICE_FOCUS_THRESHOLD = 0.5

/**
 * Framing for a vocal section: get closer to the subject.
 *
 * A voice is the human element in a track, and closing distance is how film
 * shoots one. `locked` and `push` only — both hold the subject centred and
 * near. Orbiting modes are excluded because circling a singer reads as
 * restless, and `handheld` stays out for the same calm-mood invariant as above.
 *
 * Ranked BELOW tension: a build that happens to be sung should still be shot
 * as a build. Intimacy is the resting preference, not an override.
 */
const VOICE_MODES: CameraMode[] = ['locked', 'push']

/**
 * Moods the tension override does NOT apply to.
 *
 * Tension is highest during a build and on the drop that releases it. If the
 * override applied everywhere, both would be shot the same way and the release
 * would look like more of the build — so at full energy the mood's own framing
 * wins and `handheld` still reads as the arrival.
 */
const TENSION_EXEMPT: MoodState[] = ['peak', 'aggressive']

/**
 * Moods where a shaky lens reads as a mistake — the calm-mood invariant documented on `MODE_PREFERENCE`.
 *
 * The legacy lists hold `handheld` only under `peak`/`aggressive`, so that path cannot pick it here. The
 * look-driven path ranks by blended weights instead, and a tense SONG carries real `handheld` weight, so it has to
 * enforce the invariant explicitly: the quiet passage of a tense track (the character read says handheld, the
 * fast intensity layer says ambient) is still not shot handheld.
 */
const CALM_MOODS: MoodState[] = ['silence', 'ambient', 'mellow']

/**
 * How hard tension leans on {@link TENSION_MODES} when the look profile ranks the modes.
 *
 * The legacy path PROMOTES them (they outrank the mood's own list outright). Under the look profile that would
 * override the very weights that make one mood's camera differ from another's, and the profile already carries
 * the build (`applyBuild` moves camera mass onto `push`), so tension is softened to a multiplier on the weights
 * of `push` / `spiral`: x1 at the threshold, ramping to x(1 + LOOK_TENSION_BONUS) at tension 1. It can still
 * carry them to the front on a mood that sits near them, but it cannot make a mood shoot a mode its row never
 * uses. The peak / aggressive exemption is unchanged and for the same reason: the drop that releases a build
 * must not be shot like the build.
 */
const LOOK_TENSION_BONUS = 1.5

/**
 * Shot taxonomy — what a mode LOOKS like, independent of which mood picked it.
 *
 * ## Why this exists
 *
 * `pickCameraMode` already varies its pick across repeat visits to the same
 * (scene, mood) pair (see its own doc), but that rotation is blind to what the
 * modes it is rotating between actually look like. `orbit`, `hover` and
 * `locked` are three different mechanisms and land in nearly the same place on
 * screen — a medium shot at eye level — so "varied" by mode identity is not
 * the same thing as "varied" by what a viewer sees. This makes that
 * distinction machine-legible, the same idea 2025 cinematography-understanding
 * work (ShotBench/ShotVL) is built on: a shot has a size and an angle, and a
 * system that can name them can reason about repetition a mode-identity check
 * cannot.
 *
 * ## How each mode was classified
 *
 * Read off `computeDesired`'s own target distance/height for each mode, not
 * guessed:
 *
 *  - **size** — nominal target distance relative to `anchor.distance`. `close`
 *    at or below ~0.55x (`push`, `spiral`, `topdown` all close in), `wide` at
 *    or above ~1.3x (`pull` alone retreats that far), `medium` otherwise.
 *  - **angle** — nominal target height relative to `anchor.height`. `high`
 *    when the target sits at multiple times the anchor's own distance above
 *    it (`topdown` alone — `anchor.distance * 1.15` is not a gentle lift, it
 *    is looking straight down); `eye` otherwise. No mode's DEFINING trait is a
 *    low angle today, so `low` is declared but currently unreached — same
 *    pattern as a retired-but-typed enum value elsewhere in this codebase
 *    (see `MirrorMode`'s `wallpaper`/`shear`).
 *
 * A few modes (`spiral`, `cinematic`) continuously vary their height rather
 * than holding one — their tag is the mode's NOMINAL/mean framing, not a
 * constraint `computeDesired` is checked against. The taxonomy exists to
 * compare modes to each other at the moment one is CHOSEN, not to describe
 * their motion frame-by-frame.
 */
export type CameraShotSize = 'wide' | 'medium' | 'close'
export type CameraShotAngle = 'high' | 'eye' | 'low'

export interface CameraShotTag {
  size: CameraShotSize
  angle: CameraShotAngle
}

export const CAMERA_MODE_SHOT: Record<CameraMode, CameraShotTag> = {
  orbit: { size: 'medium', angle: 'eye' },
  hover: { size: 'medium', angle: 'eye' },
  push: { size: 'close', angle: 'eye' },
  pull: { size: 'wide', angle: 'eye' },
  spiral: { size: 'close', angle: 'eye' },
  handheld: { size: 'medium', angle: 'eye' },
  locked: { size: 'medium', angle: 'eye' },
  topdown: { size: 'close', angle: 'high' },
  cinematic: { size: 'medium', angle: 'eye' },
}

/** Two shot tags describe the same framing. */
export function sameShot(a: CameraShotTag | null | undefined, b: CameraShotTag | null | undefined): boolean {
  if (!a || !b) return false
  return a.size === b.size && a.angle === b.angle
}

/** Fallback for a scene that declares no modes — matches the old hardcoded default. */
const DEFAULT_MODES: CameraMode[] = ['hover']

/**
 * Beats between a mode-rotation re-pick at zero/unreadable danceability —
 * one phrase, and the value this file used unconditionally before this
 * constant existed. Every existing caller (every test in
 * CameraDirector.test.ts/moodSignals.test.ts, and PerformanceStateBridge's
 * live call, none of which pass `danceability`) is therefore bit-for-bit
 * unaffected by the parameter below.
 */
const MODE_ROTATION_PERIOD_BEATS = 16
/** Narrowest the rotation window may go, at the top of the observed
 *  danceability range — half a phrase, so a highly danceable passage still
 *  reads as a rotation, not a strobe. */
const MODE_ROTATION_PERIOD_BEATS_MIN = 8

/**
 * Degenerate-read guard and empirical normalization range for the RAW
 * Essentia `danceability` read (`AudioFeatures.danceability` — its own doc:
 * "raw Essentia DFA, NOT renormalized"). Mirrors MoodEstimator.ts's own
 * `DANCE_*` block value-for-value, which derived these numbers from the same
 * measured corpus (~7.8 for a four-on-the-floor beat with bass, ~0.6 for a
 * beatless pad, ~97 on white noise / near-silence) — duplicated here rather
 * than imported because those constants are private to that module's own
 * `groove` mood bonus, and exporting them solely to share three numbers would
 * imply a coupling between "biases a mood score" and "narrows a camera
 * rotation cadence" that doesn't actually exist.
 */
const DANCE_DEGENERATE_CEILING = 12
const DANCE_LO = 1.0
const DANCE_SPAN = 5.0

/** Raw danceability -> 0..1, 0 for unreadable/degenerate input. See the
 *  constants' own doc above. */
function normalizedDanceability(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0 || raw >= DANCE_DEGENERATE_CEILING) return 0
  return Math.min(1, Math.max(0, (raw - DANCE_LO) / DANCE_SPAN))
}

/** Beats per rotation window at this (raw) danceability. Shared by the legacy and look-driven picks. */
function modeRotationPeriod(danceability: number): number {
  const danceNorm = normalizedDanceability(danceability)
  return Math.round(
    MODE_ROTATION_PERIOD_BEATS -
      danceNorm * (MODE_ROTATION_PERIOD_BEATS - MODE_ROTATION_PERIOD_BEATS_MIN),
  )
}

/**
 * The look-profile half of {@link pickCameraMode}: rank the declared modes by the blended `look.cameraWeights`
 * (`LOOK_CAMERA_MODES` order), keep the hard rules, and choose between the top two with the weights deciding how
 * often each is on. Undefined when the profile gives no usable weight to any declared mode (a sung section
 * still counts its promoted modes, weight or not), so the caller falls back to the legacy per-mood lists.
 *
 * The rules, and what became of each:
 *  - **Declared only.** A mode the scene does not declare is never eligible (unchanged).
 *  - **Weights rank, the rotation still alternates two.** As in the legacy pick, only the top two fits are ever
 *    on screen for a mood and the rotation-window index (`beatIndex` over the danceability-narrowed period)
 *    chooses between them, deterministically. What changed is that the choice is proportional to the two blended
 *    weights ({@link rotationUnit}) instead of a strict 50/50 flip, so `aggressive` (handheld .6, push .2) is
 *    mostly handheld while a mood with two near-equal fits still alternates. Modes with no weight are not ranked.
 *  - **Sung sections (`voiceFocus`) are still a hard promotion**: `locked`/`push` are moved ahead of the ranked
 *    modes (ordered among themselves by weight), and the two on screen rotate evenly, as before. Tension does
 *    not apply while a section is sung, as before.
 *  - **Tension is a bonus, not an override** (see {@link LOOK_TENSION_BONUS}); peak / aggressive stay exempt.
 *  - **Calm moods never get `handheld`** (see {@link CALM_MOODS}).
 *  - **Anti-repeat of the on-screen shot** (`avoidShot`): if the pick has the same size + angle, the first ranked
 *    mode that looks different is taken instead, exactly as in the legacy pick.
 */
function pickLookCameraMode(
  declared: CameraMode[],
  mood: MoodState,
  tension: number,
  beatIndex: number,
  voiceFocus: number,
  avoidShot: CameraShotTag | null | undefined,
  danceability: number,
  look: LookProfile,
): CameraMode | undefined {
  const tense = tension > TENSION_THRESHOLD && !TENSION_EXEMPT.includes(mood)
  const vocal = !tense && voiceFocus > VOICE_FOCUS_THRESHOLD
  const calm = CALM_MOODS.includes(mood)
  const bonus = tense
    ? 1 + LOOK_TENSION_BONUS * Math.min(1, (tension - TENSION_THRESHOLD) / (1 - TENSION_THRESHOLD))
    : 1

  const entries: { mode: CameraMode; w: number; order: number }[] = []
  for (let i = 0; i < LOOK_CAMERA_MODES.length; i++) {
    const mode = LOOK_CAMERA_MODES[i]
    if (!declared.includes(mode) || (calm && mode === 'handheld')) continue
    const raw = look.cameraWeights[i]
    let w = raw > 0 && Number.isFinite(raw) ? raw : 0
    if (tense && TENSION_MODES.includes(mode)) w *= bonus
    entries.push({ mode, w, order: i })
  }
  entries.sort((a, b) => b.w - a.w || a.order - b.order)

  let ordered = entries.filter((e) => e.w > 0)
  if (vocal) {
    // Promoted regardless of weight: closing on a singer is an editorial rule, not a taste the row can veto.
    const promoted = entries.filter((e) => VOICE_MODES.includes(e.mode))
    ordered = [...promoted, ...ordered.filter((e) => !VOICE_MODES.includes(e.mode))]
  }
  if (ordered.length === 0) return undefined

  const window = Math.floor(Math.max(0, beatIndex) / modeRotationPeriod(danceability))
  let rotated = ordered[0]
  if (ordered.length > 1) {
    const wa = vocal ? 1 : ordered[0].w
    const wb = vocal ? 1 : ordered[1].w
    if (rotationUnit(window) >= wa / (wa + wb)) rotated = ordered[1]
  }
  if (!avoidShot || !sameShot(CAMERA_MODE_SHOT[rotated.mode], avoidShot)) return rotated.mode
  const different = ordered.find((e) => !sameShot(CAMERA_MODE_SHOT[e.mode], avoidShot))
  return (different ?? rotated).mode
}

/**
 * Choose how to shoot the current scene.
 *
 * Pure and exported for tests: this decides the whole look of a section and,
 * like the framing math itself, would regress invisibly — a wrong-but-valid
 * mode still renders.
 *
 * `beatIndex` varies the pick between the top two fits so a track that returns
 * to the same mood on the same scene is not shot identically each time.
 */
export function pickCameraMode(
  modes: CameraMode[] | undefined,
  mood: MoodState,
  tension: number,
  beatIndex: number,
  voiceFocus = 0,
  /**
   * The shot tag of whatever is ON SCREEN right now, if known. When the
   * pick this call would otherwise make has the SAME size+angle (see
   * {@link sameShot}), the next-ranked eligible mode with a DIFFERENT tag is
   * preferred instead — so consecutive picks read as a different shot rather
   * than a different mode that happens to look the same (`orbit` -> `hover`
   * is a real repeat: both are a medium shot at eye level). `null`/`undefined`
   * disables the check entirely — the caller has no history yet, or does not
   * want one enforced (every existing call site and every existing test is
   * unaffected by leaving this unset).
   */
  avoidShot?: CameraShotTag | null,
  /**
   * RAW `AudioFeatures.danceability`. Narrows the `beatIndex` rotation window
   * below — see {@link MODE_ROTATION_PERIOD_BEATS} — so a highly danceable
   * passage re-samples its top two framing fits more often than a calm one
   * holding the same mood for a whole section, the same "more motion for more
   * energy" idea PerformanceStateBridge.tsx's own `AROUSAL_CUT_THRESHOLD`
   * already applies to WHETHER a re-pick happens at all. That gate lives on
   * the other side of the seam (PerformanceStateBridge.tsx decides WHEN to
   * call this function; this parameter only changes what a call does once it
   * fires) — PerformanceStateBridge.tsx's own call site now passes
   * `f.danceability` through. Normalized locally via
   * {@link normalizedDanceability} rather than trusted raw. Defaults to 0, so
   * any OTHER caller that doesn't pass it stays a no-op.
   */
  danceability = 0,
  /**
   * The mood look profile (`performanceState.look`). Passed ONLY while it is valid and the camera family is
   * enabled; when given, the modes are ranked by its blended `cameraWeights` instead of the per-mood lists
   * above — see {@link pickLookCameraMode} for which rules survive. Omitted (or when the profile has no weight
   * on any declared mode), this is exactly the pick it always was.
   */
  look?: LookProfile,
): CameraMode {
  const declared = modes && modes.length > 0 ? modes : DEFAULT_MODES
  if (look) {
    const weighted = pickLookCameraMode(
      declared,
      mood,
      tension,
      beatIndex,
      voiceFocus,
      avoidShot,
      danceability,
      look,
    )
    if (weighted) return weighted
  }
  const tense = tension > TENSION_THRESHOLD && !TENSION_EXEMPT.includes(mood)
  // Tension outranks intimacy: a sung build is still shot as a build.
  const vocal = !tense && voiceFocus > VOICE_FOCUS_THRESHOLD
  let preference = MODE_PREFERENCE[mood]
  if (tense) preference = [...new Set([...TENSION_MODES, ...preference])]
  else if (vocal) preference = [...new Set([...VOICE_MODES, ...preference])]

  const ranked = preference.filter((mode) => declared.includes(mode))
  if (ranked.length === 0) return declared[0]
  const rotationPeriod = modeRotationPeriod(danceability)
  const rotated = ranked[Math.floor(Math.max(0, beatIndex) / rotationPeriod) % Math.min(2, ranked.length)]
  if (!avoidShot || !sameShot(CAMERA_MODE_SHOT[rotated], avoidShot)) return rotated
  // The natural pick would repeat the on-screen framing. Take the first
  // ranked candidate (in the mood's own preference order, not the rotation)
  // that looks different — mood preference still decides WHICH mode wins
  // among the ones that qualify, this only removes the one that does not.
  const different = ranked.find((mode) => !sameShot(CAMERA_MODE_SHOT[mode], avoidShot))
  return different ?? rotated
}

/** A look-profile gain clamped to [lo, hi]; a non-finite value is the identity (1) rather than a freeze or a fling. */
function lookGain(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? (v < lo ? lo : v > hi ? hi : v) : 1
}

/**
 * Where the camera wants to be this frame, in `desired` / `lookAt`.
 *
 * Exported for tests: camera framing is the one part of this refactor that can
 * regress invisibly (a scene still renders, just composed wrong), so the modes
 * are asserted against the exact positions the scenes were authored with.
 * Reads `audioEngine.features`, which is a plain mutable object a test can set. Also reads
 * `performanceState.look` for the mood look's motion gains (`cameraSpeed`, `cameraShake`), which are the
 * identity unless the profile is valid with its camera family on.
 */
export function computeDesired(mode: CameraMode, anchor: CameraAnchor, time: number, dt: number) {
  const f = audioEngine.features
  const pulse = beatPulse(f)
  const [tx, ty, tz] = anchor.target
  // Beats pull the camera in; energy sits it slightly closer overall.
  const pull = (f.energy * 0.14 + pulse * 0.08) * anchor.distance
  const baseDist = anchor.distance - pull
  const barPhase = ((f.bar % 2) + (f.beatInBar + f.beatProgress) / 4) / 2

  // The mood look's motion gains. Both are exactly 1 (an IEEE-exact multiply, so the legacy motion is
  // bit-identical) unless the profile is valid and its camera family is on. `speed` scales the rate of every
  // moving mode (angular drift of orbit / spiral / topdown / cinematic, the approach rate of push / pull, the
  // phase rate of handheld); `shake` scales the handheld jitter amplitude. Blended values are clamped so a
  // corrupt profile can never freeze or fling the lens.
  const look = performanceState.look
  const lookOn = look.valid && look.families.camera
  // The tempo rate is independent of the mood look's OWN gains (the song's measured tempo, scaled by the mood's
  // `tempoCoupling`) and multiplies in regardless of `lookOn`, same as it does in moodParams.ts. Already
  // confidence-gated and eased (tempoSpeed.ts), so this is 1 (no-op) until the tempo read is trustworthy.
  const speed = (lookOn ? lookGain(look.cameraSpeed, 0.25, 2) : 1) * currentTempoRate()
  const shake = lookOn ? lookGain(look.cameraShake, 0, 2) : 1

  switch (mode) {
    case 'orbit':
      state.angle += dt * 0.05 * (1 + f.energy * 0.6) * speed
      state.dist = approach(state.dist, baseDist, 3, dt)
      state.height = approach(
        state.height,
        anchor.height + Math.sin(barPhase * Math.PI * 2) * 1.6,
        3,
        dt,
      )
      desired.set(
        tx + Math.cos(state.angle) * state.dist,
        ty + state.height,
        tz + Math.sin(state.angle) * state.dist,
      )
      break

    case 'spiral':
      state.angle += dt * 0.12 * (1 + f.energy) * speed
      state.dist = approach(state.dist, baseDist * (0.7 + Math.sin(time * 0.09) * 0.3), 2, dt)
      state.height = approach(
        state.height,
        anchor.height + Math.sin(time * 0.13) * anchor.distance * 0.35,
        2,
        dt,
      )
      desired.set(
        tx + Math.cos(state.angle) * state.dist,
        ty + state.height,
        tz + Math.sin(state.angle) * state.dist,
      )
      break

    case 'push':
      // Slow continuous approach that resets on section boundaries.
      state.dist = approach(state.dist, baseDist * 0.45, 0.25 * speed, dt)
      if (f.sectionChange) state.dist = anchor.distance
      state.height = approach(state.height, anchor.height, 2, dt)
      desired.set(tx, ty + state.height, tz + state.dist)
      break

    case 'pull':
      state.dist = approach(state.dist, anchor.distance * 1.8, 0.22 * speed, dt)
      if (f.sectionChange) state.dist = anchor.distance * 0.6
      state.height = approach(state.height, anchor.height, 2, dt)
      desired.set(tx, ty + state.height, tz + state.dist)
      break

    case 'handheld': {
      // Organic drift: two out-of-phase sine stacks read as a human operator,
      // and beats add a small kick without ever becoming a strobe.
      state.shakeX += dt * 0.9 * speed
      state.shakeY += dt * 1.13 * speed
      const jitter = (0.06 + pulse * 0.05 + f.percussion.kick.env * 0.06) * shake
      state.dist = approach(state.dist, baseDist, 2.5, dt)
      desired.set(
        tx +
          (Math.sin(state.shakeX) + Math.sin(state.shakeX * 2.3) * 0.4) *
            jitter *
            anchor.distance *
            0.25,
        ty +
          anchor.height +
          (Math.sin(state.shakeY) + Math.sin(state.shakeY * 1.7) * 0.4) *
            jitter *
            anchor.distance *
            0.18,
        tz + state.dist,
      )
      break
    }

    case 'topdown':
      state.angle += dt * 0.04 * speed
      state.dist = approach(state.dist, baseDist * 0.35, 2, dt)
      desired.set(
        tx + Math.cos(state.angle) * state.dist,
        ty + anchor.distance * 1.15,
        tz + Math.sin(state.angle) * state.dist,
      )
      break

    case 'cinematic': {
      // Long lazy arc with an eased dolly — deliberately slower than orbit so
      // it reads as composed rather than mechanical.
      state.angle += dt * 0.022 * speed
      const dolly = 0.85 + Math.sin(time * 0.05) * 0.18
      state.dist = approach(state.dist, baseDist * dolly, 1.2, dt)
      state.height = approach(state.height, anchor.height + Math.sin(time * 0.037) * 1.1, 1.2, dt)
      desired.set(
        tx + Math.cos(state.angle) * state.dist,
        ty + state.height,
        tz + Math.sin(state.angle) * state.dist,
      )
      break
    }

    case 'locked':
      state.dist = approach(state.dist, anchor.distance, 3, dt)
      desired.set(tx, ty + anchor.height, tz + state.dist)
      break

    case 'hover':
    default: {
      // Fixed framing with a subwoofer dip — the closest match to the old
      // per-scene default, so scenes migrating to the director keep their look.
      state.dist = approach(state.dist, anchor.distance, 3, dt)
      const dip = pulse * 0.5 - f.bass * 0.6
      desired.set(tx, ty + anchor.height - dip * 0.6, tz + state.dist)
      break
    }
  }

  lookAt.set(tx, ty, tz)
}

/**
 * Applies the active camera mode to the shared camera.
 *
 * Runs at −80: after the creative directors have settled `cameraMode` for this
 * frame (−90 … −85), before scenes render (0) so they see a final camera.
 *
 * Only drives scenes that have opted in by declaring a camera anchor. A scene
 * that still moves its own camera is left completely alone, which is what makes
 * the migration incremental and safe.
 */
export function CameraDirector() {
  useFrame(({ camera, clock }, delta) => {
    const p = performanceState
    // Follow the VISIBLE scene, not a queued one — otherwise the lens swings to
    // the next scene's framing while the current one is still on screen.
    const scene = getScene(p.activeScene)
    const anchor = scene.metadata.cameraAnchor
    // Scene still owns its camera — do nothing at all.
    if (!anchor) return

    const dt = Math.min(0.1, delta)
    computeDesired(p.cameraMode, anchor, clock.elapsedTime, dt)

    // Ease into position so a mode or scene change never teleports the lens.
    const k = Math.min(1, dt * 6 * state.blend)
    camera.position.lerp(desired, k)
    camera.lookAt(lookAt)
  }, -80)

  return null
}
