import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { audioEngine, beatPulse } from '../audio/AudioEngine'
import type { MoodState } from '../audio/types'
import { getScene } from '../scenes'
import { approach, performanceState, type CameraMode } from './performanceState'

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
 * Moods the tension override does NOT apply to.
 *
 * Tension is highest during a build and on the drop that releases it. If the
 * override applied everywhere, both would be shot the same way and the release
 * would look like more of the build — so at full energy the mood's own framing
 * wins and `handheld` still reads as the arrival.
 */
const TENSION_EXEMPT: MoodState[] = ['peak', 'aggressive']

/** Fallback for a scene that declares no modes — matches the old hardcoded default. */
const DEFAULT_MODES: CameraMode[] = ['hover']

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
): CameraMode {
  const declared = modes && modes.length > 0 ? modes : DEFAULT_MODES
  const tense = tension > TENSION_THRESHOLD && !TENSION_EXEMPT.includes(mood)
  const preference = tense
    ? [...new Set([...TENSION_MODES, ...MODE_PREFERENCE[mood]])]
    : MODE_PREFERENCE[mood]

  const ranked = preference.filter((mode) => declared.includes(mode))
  if (ranked.length === 0) return declared[0]
  return ranked[Math.floor(Math.max(0, beatIndex) / 16) % Math.min(2, ranked.length)]
}

/**
 * Where the camera wants to be this frame, in `desired` / `lookAt`.
 *
 * Exported for tests: camera framing is the one part of this refactor that can
 * regress invisibly (a scene still renders, just composed wrong), so the modes
 * are asserted against the exact positions the scenes were authored with.
 * Reads `audioEngine.features`, which is a plain mutable object a test can set.
 */
export function computeDesired(mode: CameraMode, anchor: CameraAnchor, time: number, dt: number) {
  const f = audioEngine.features
  const pulse = beatPulse(f)
  const [tx, ty, tz] = anchor.target
  // Beats pull the camera in; energy sits it slightly closer overall.
  const pull = (f.energy * 0.14 + pulse * 0.08) * anchor.distance
  const baseDist = anchor.distance - pull
  const barPhase = ((f.bar % 2) + (f.beatInBar + f.beatProgress) / 4) / 2

  switch (mode) {
    case 'orbit':
      state.angle += dt * 0.05 * (1 + f.energy * 0.6)
      state.dist = approach(state.dist, baseDist, 3, dt)
      state.height = approach(state.height, anchor.height + Math.sin(barPhase * Math.PI * 2) * 1.6, 3, dt)
      desired.set(
        tx + Math.cos(state.angle) * state.dist,
        ty + state.height,
        tz + Math.sin(state.angle) * state.dist,
      )
      break

    case 'spiral':
      state.angle += dt * 0.12 * (1 + f.energy)
      state.dist = approach(state.dist, baseDist * (0.7 + Math.sin(time * 0.09) * 0.3), 2, dt)
      state.height = approach(state.height, anchor.height + Math.sin(time * 0.13) * anchor.distance * 0.35, 2, dt)
      desired.set(
        tx + Math.cos(state.angle) * state.dist,
        ty + state.height,
        tz + Math.sin(state.angle) * state.dist,
      )
      break

    case 'push':
      // Slow continuous approach that resets on section boundaries.
      state.dist = approach(state.dist, baseDist * 0.45, 0.25, dt)
      if (f.sectionChange) state.dist = anchor.distance
      state.height = approach(state.height, anchor.height, 2, dt)
      desired.set(tx, ty + state.height, tz + state.dist)
      break

    case 'pull':
      state.dist = approach(state.dist, anchor.distance * 1.8, 0.22, dt)
      if (f.sectionChange) state.dist = anchor.distance * 0.6
      state.height = approach(state.height, anchor.height, 2, dt)
      desired.set(tx, ty + state.height, tz + state.dist)
      break

    case 'handheld': {
      // Organic drift: two out-of-phase sine stacks read as a human operator,
      // and beats add a small kick without ever becoming a strobe.
      state.shakeX += dt * 0.9
      state.shakeY += dt * 1.13
      const jitter = 0.06 + pulse * 0.05 + f.percussion.kick.env * 0.06
      state.dist = approach(state.dist, baseDist, 2.5, dt)
      desired.set(
        tx + (Math.sin(state.shakeX) + Math.sin(state.shakeX * 2.3) * 0.4) * jitter * anchor.distance * 0.25,
        ty + anchor.height + (Math.sin(state.shakeY) + Math.sin(state.shakeY * 1.7) * 0.4) * jitter * anchor.distance * 0.18,
        tz + state.dist,
      )
      break
    }

    case 'topdown':
      state.angle += dt * 0.04
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
      state.angle += dt * 0.022
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
