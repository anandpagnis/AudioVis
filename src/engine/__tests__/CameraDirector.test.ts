import { beforeEach, describe, expect, it } from 'vitest'
import { audioEngine } from '../../audio/AudioEngine'
import { createEmptyFeatures } from '../../audio/types'
import { computeDesired, desired, lookAt, type CameraAnchor } from '../CameraDirector'
import { SCENES } from '../../scenes'

/**
 * Camera framing is the part of the director refactor that can regress
 * invisibly — a scene still renders, it is just composed wrong, and nothing
 * throws. These pin each mode against the framing the scenes were authored
 * with before the camera moved out of them.
 */

/** Silent, still audio: isolates the anchor geometry from musical motion. */
function quietFeatures() {
  const f = createEmptyFeatures()
  f.bpm = 120
  f.confidence = 0
  f.energy = 0
  f.bass = 0
  f.beatStrength = 0
  return f
}

/** Run a mode to convergence so the eased distance settles on its target. */
function settle(mode: Parameters<typeof computeDesired>[0], anchor: CameraAnchor, frames = 600) {
  for (let i = 0; i < frames; i++) computeDesired(mode, anchor, i / 60, 1 / 60)
}

describe('CameraDirector framing', () => {
  beforeEach(() => {
    Object.assign(audioEngine.features, quietFeatures())
  })

  it('hover holds a fixed offset from an anchor, looking at the subject', () => {
    // Framing equivalence used to be pinned against SchematicScene's authored
    // hover (eye [0, 1.4, 9], look [0, 0.3, 0]); that scene has since been
    // removed, so the same arithmetic is asserted against its anchor directly.
    const anchor: CameraAnchor = { target: [0, 0.3, 0], distance: 9, height: 1.1 }
    settle('hover', anchor)
    expect(desired.x).toBeCloseTo(0, 3)
    expect(desired.y).toBeCloseTo(1.4, 2)
    expect(desired.z).toBeCloseTo(9, 2)
    expect(lookAt.y).toBeCloseTo(0.3, 3)
  })

  it('orbit holds each scene’s authored radius and elevation', () => {
    // Pre-refactor radii: wireframe 9.5, plasma 17, chrome 8.2.
    for (const [id, radius, elev] of [
      ['wireframe', 9.5, 1.6],
      ['plasma', 17, 2.4],
      ['chrome', 8.2, 1.2],
    ] as const) {
      const anchor = SCENES.find((s) => s.id === id)!.metadata.cameraAnchor!
      settle('orbit', anchor)
      const horizontal = Math.hypot(desired.x, desired.z)
      expect(horizontal).toBeCloseTo(radius, 1)
      // Elevation swings over bars; at rest it sits within the swing of nominal.
      expect(Math.abs(desired.y - elev)).toBeLessThan(1.7)
    }
  })

  it('always looks at the declared subject, not the world origin', () => {
    const offset: CameraAnchor = { target: [3, 2, -1], distance: 10, height: 1 }
    settle('orbit', offset)
    expect(lookAt.x).toBeCloseTo(3, 5)
    expect(lookAt.y).toBeCloseTo(2, 5)
    expect(lookAt.z).toBeCloseTo(-1, 5)
  })

  it('orbits around the subject when the anchor is off-origin', () => {
    const offset: CameraAnchor = { target: [5, 0, 5], distance: 8, height: 0 }
    settle('orbit', offset)
    const r = Math.hypot(desired.x - 5, desired.z - 5)
    expect(r).toBeCloseTo(8, 1)
  })

  it('push moves closer over time and pull moves further away', () => {
    const anchor: CameraAnchor = { target: [0, 0, 0], distance: 10, height: 1 }
    settle('push', anchor, 300)
    const pushed = desired.z
    settle('pull', anchor, 300)
    const pulled = desired.z
    expect(pushed).toBeLessThan(10)
    expect(pulled).toBeGreaterThan(10)
  })

  it('topdown looks down from well above the subject', () => {
    const anchor: CameraAnchor = { target: [0, 0, 0], distance: 10, height: 1 }
    settle('topdown', anchor)
    expect(desired.y).toBeGreaterThan(Math.hypot(desired.x, desired.z))
  })

  it('every declared mode produces finite coordinates for every registered scene', () => {
    // Guards the swap-any-camera-onto-any-scene promise: a mode/anchor pair that
    // produced NaN would silently blank the view rather than throw.
    //
    // Only PRIMARY-capable scenes need an anchor. A pure accent/overlay layer is
    // a fullscreen composite with no subject to frame and no camera dependency,
    // so requiring one of those would be requiring a meaningless number.
    for (const scene of SCENES) {
      if (!scene.metadata.roles.includes('primary')) continue
      const anchor = scene.metadata.cameraAnchor
      expect(anchor, `primary-capable scene ${scene.id} must declare a camera anchor`).toBeTruthy()
      for (const mode of scene.metadata.cameraModes ?? []) {
        settle(mode, anchor!, 120)
        expect(Number.isFinite(desired.x), `${scene.id}/${mode}`).toBe(true)
        expect(Number.isFinite(desired.y), `${scene.id}/${mode}`).toBe(true)
        expect(Number.isFinite(desired.z), `${scene.id}/${mode}`).toBe(true)
      }
    }
  })
})
