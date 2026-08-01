import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { audioEngine, beatPulse } from '../audio/AudioEngine'
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
