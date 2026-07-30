import type * as THREE from 'three'
import type { AudioFeatures } from '../audio/types'
import { beatPulse } from '../audio/AudioEngine'

/**
 * Reusable audio-reactive camera moves. A scene owns one rig and calls one
 * mode per frame; all motion is derived from musical timing (beats pull the
 * camera, bars sway it, section changes can hard-cut).
 */
export class CameraRig {
  angle = Math.random() * Math.PI * 2

  /** Slow orbit around the origin. Beats pull the camera in, bars sway elevation. */
  orbit(
    camera: THREE.Camera,
    f: AudioFeatures,
    opts: {
      radius?: number
      elev?: number
      elevSwing?: number
      speed?: number
      react?: number
    } = {},
  ) {
    const { radius = 13, elev = 4.5, elevSwing = 1.6, speed = 0.05, react = 1 } = opts
    this.angle += f.delta * speed * (1 + f.energy * 0.6)
    // Camera cut on section changes — a VJ-style jump that lands on a downbeat.
    if (f.sectionChange) this.cut()
    const pulse = beatPulse(f)
    const dist = radius - (f.energy * 2.2 + pulse * 1.2) * react
    const barPhase = ((f.bar % 2) + (f.beatInBar + f.beatProgress) / 4) / 2 // 0..1 over 2 bars
    const y = elev + Math.sin(barPhase * Math.PI * 2) * elevSwing
    camera.position.set(Math.cos(this.angle) * dist, y, Math.sin(this.angle) * dist)
    camera.lookAt(0, 0, 0)
  }

  /** Fixed hover with subwoofer dips on beats. */
  hover(
    camera: THREE.Camera,
    f: AudioFeatures,
    opts: { pos?: [number, number, number]; look?: [number, number, number]; bob?: number } = {},
  ) {
    const { pos = [0, 6.5, 26], look = [0, 3.5, 0], bob = 1 } = opts
    const pulse = beatPulse(f)
    camera.position.set(pos[0], pos[1] - (pulse * 0.5 - f.bass * 0.6) * bob, pos[2])
    camera.lookAt(look[0], look[1], look[2])
  }

  /** Instant angle jump (used on section changes). */
  cut(delta = Math.PI / 2) {
    this.angle += delta
  }
}
