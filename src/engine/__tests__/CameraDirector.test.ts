import { beforeEach, describe, expect, it } from 'vitest'
import { audioEngine } from '../../audio/AudioEngine'
import { createEmptyFeatures, type MoodState } from '../../audio/types'
import {
  CAMERA_MODE_SHOT,
  computeDesired,
  cutCamera,
  desired,
  lookAt,
  pickCameraMode,
  sameShot,
  type CameraAnchor,
} from '../CameraDirector'
import { CAMERA_MODES, type CameraMode } from '../performanceState'
import { SCENES } from '../../scenes'

const MOODS: MoodState[] = [
  'silence',
  'ambient',
  'mellow',
  'groove',
  'building',
  'peak',
  'aggressive',
]

/** Moods where a shaky lens would read as a mistake rather than as energy. */
const CALM_MOODS: MoodState[] = ['silence', 'ambient', 'mellow']

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

/**
 * Mode SELECTION regresses as invisibly as framing does — a wrong-but-valid mode
 * still renders a perfectly fine picture, just the wrong one for the music. These
 * pin the properties that make the choice trustworthy rather than the exact picks,
 * so the preference tables stay tunable by ear.
 */
describe('pickCameraMode', () => {
  it('only ever returns a mode the scene declared', () => {
    for (const scene of SCENES) {
      const modes = scene.metadata.cameraModes
      for (const mood of MOODS) {
        for (const tension of [0, 0.9]) {
          for (const beat of [0, 16, 64, 129]) {
            const pick = pickCameraMode(modes, mood, tension, beat)
            expect(modes, `${scene.id}/${mood}/t${tension}/b${beat}`).toContain(pick)
          }
        }
      }
    }
  })

  it('never shoots a calm mood handheld, at any tension', () => {
    // The tension override promotes push/spiral precisely so it cannot introduce
    // a shaky lens over an ambient passage — including the tense quiet bar
    // before a drop, which is the case that motivated excluding it.
    for (const scene of SCENES) {
      for (const mood of CALM_MOODS) {
        for (const tension of [0, 0.5, 0.6, 1]) {
          expect(pickCameraMode(scene.metadata.cameraModes, mood, tension, 0)).not.toBe('handheld')
        }
      }
    }
  })

  it('gives every scene a range of framing across the moods', () => {
    // If a mood's preference list missed every mode a scene declares, the pick
    // would degrade to that scene's first mode — i.e. back to the hardcoded
    // `cameraModes[0]` this function replaced, which is invisible unless you
    // look for it. A scene that answers every mood with the same mode is that
    // failure. This is what keeps the preference tables honest as the roster
    // changes.
    for (const scene of SCENES) {
      const picks = new Set(
        MOODS.map((mood) => pickCameraMode(scene.metadata.cameraModes, mood, 0, 0)),
      )
      expect(picks.size, `${scene.id} is shot identically in every mood`).toBeGreaterThan(2)
    }
  })

  it('promotes anticipation framing once tension crosses the threshold', () => {
    // Dissolve Cage declares push; at rest in a groove it should not be pushing,
    // and under pressure it should be.
    const modes = SCENES.find((s) => s.id === 'dissolve')!.metadata.cameraModes
    expect(pickCameraMode(modes, 'groove', 0, 0)).not.toBe('push')
    expect(pickCameraMode(modes, 'groove', 0.9, 0)).toBe('push')
  })

  it('leaves peak and aggressive framing alone under tension', () => {
    // Tension peaks on the drop that RELEASES a build. If the override applied
    // here too, the release would be shot like the build that preceded it — so
    // full-energy moods keep their own framing and stay distinguishable.
    for (const scene of SCENES) {
      for (const mood of ['peak', 'aggressive'] as MoodState[]) {
        const modes = scene.metadata.cameraModes
        expect(pickCameraMode(modes, mood, 0.95, 0), `${scene.id}/${mood}`).toBe(
          pickCameraMode(modes, mood, 0, 0),
        )
      }
    }
  })

  it('keeps a build and the drop it resolves into visually distinct', () => {
    // The regression this guards: an earlier tension override applied to every
    // mood, which collapsed building and peak onto the same mode for every
    // scene in the roster.
    const distinct = SCENES.filter((scene) => {
      const modes = scene.metadata.cameraModes
      return pickCameraMode(modes, 'building', 0.9, 0) !== pickCameraMode(modes, 'peak', 0.9, 0)
    })
    expect(distinct.length).toBeGreaterThan(SCENES.length / 2)
  })

  it('varies the pick across sections so a repeated mood is not shot identically', () => {
    const modes = SCENES.find((s) => s.id === 'wireframe')!.metadata.cameraModes
    const picks = new Set([0, 16, 32, 48].map((beat) => pickCameraMode(modes, 'groove', 0, beat)))
    expect(picks.size).toBeGreaterThan(1)
  })

  it('falls back to hover when a scene declares no modes at all', () => {
    expect(pickCameraMode(undefined, 'peak', 0, 0)).toBe('hover')
    expect(pickCameraMode([], 'peak', 0, 0)).toBe('hover')
  })

  it('cutCamera actually moves the framing on an orbiting mode', () => {
    // The section-change cut had no caller before this, so nothing had ever
    // asserted it does anything. A cut that quietly no-ops would look exactly
    // like a track with no section boundaries.
    const anchor: CameraAnchor = { target: [0, 0, 0], distance: 10, height: 1 }
    settle('orbit', anchor, 200)
    const before = { x: desired.x, z: desired.z }
    cutCamera()
    computeDesired('orbit', anchor, 200 / 60, 1 / 60)
    expect(Math.hypot(desired.x - before.x, desired.z - before.z)).toBeGreaterThan(anchor.distance)
    // Still on the orbit circle — a cut changes the angle, not the framing.
    expect(Math.hypot(desired.x, desired.z)).toBeCloseTo(anchor.distance, 0)
  })

  it('leaves no camera mode unreachable across the roster', () => {
    // The bug this whole change fixes: the mode was pinned to `cameraModes[0]`,
    // so six of the nine modes never ran outside this test file. A mode nothing
    // can select is dead code that still has to be maintained — if a future
    // roster edit strands one again, this fails rather than going quiet.
    const reachable = new Set<CameraMode>()
    for (const scene of SCENES) {
      for (const mood of MOODS) {
        for (const tension of [0, 0.9]) {
          for (const beat of [0, 16]) {
            reachable.add(pickCameraMode(scene.metadata.cameraModes, mood, tension, beat))
          }
        }
      }
    }
    const unreachable = CAMERA_MODES.filter((mode) => !reachable.has(mode))
    expect(unreachable, `no scene/mood combination can select: ${unreachable.join(', ')}`).toEqual(
      [],
    )
  })
})

describe('CAMERA_MODE_SHOT — the shot taxonomy (audit c5)', () => {
  it('tags every camera mode', () => {
    for (const mode of CAMERA_MODES) {
      expect(CAMERA_MODE_SHOT[mode], mode).toBeDefined()
      expect(['wide', 'medium', 'close']).toContain(CAMERA_MODE_SHOT[mode].size)
      expect(['high', 'eye', 'low']).toContain(CAMERA_MODE_SHOT[mode].angle)
    }
  })

  it('tags pull as the roster’s one wide shot', () => {
    // pull is the only mode whose target distance exceeds anchor.distance —
    // see computeDesired's own `anchor.distance * 1.8`.
    expect(CAMERA_MODE_SHOT.pull.size).toBe('wide')
  })

  it('tags topdown as the roster’s one high angle', () => {
    // The only mode whose target height is a multiple of anchor.distance
    // above the subject, not a gentle lift — computeDesired's own
    // `anchor.distance * 1.15`.
    expect(CAMERA_MODE_SHOT.topdown.angle).toBe('high')
  })

  it('declares low as a valid value with no mode currently reaching it', () => {
    // Matches this codebase's own pattern for a typed-but-unreached value
    // (MirrorMode's retired wallpaper/shear) — declared complete rather than
    // silently narrowed to only what happens to be used today.
    const anyLow = CAMERA_MODES.some((m) => CAMERA_MODE_SHOT[m].angle === 'low')
    expect(anyLow).toBe(false)
  })
})

describe('pickCameraMode — danceability-narrowed rotation cadence (Bundle C2)', () => {
  // 'groove' ranks orbit ahead of hover among these two declared modes (see
  // MODE_PREFERENCE.groove), so the rotation alternates between exactly them.
  const modes: CameraMode[] = ['orbit', 'hover']

  it('is unaffected when danceability is omitted or zero — every existing call site', () => {
    for (const beat of [0, 8, 16, 24, 32]) {
      expect(pickCameraMode(modes, 'groove', 0, beat)).toBe(
        pickCameraMode(modes, 'groove', 0, beat, 0, null, 0),
      )
    }
  })

  it('narrows the rotation period so beat 8 already flips at high danceability', () => {
    // At the default 16-beat period, beat 8 is still inside the FIRST window
    // (floor(8/16) === 0). A highly danceable read must narrow far enough
    // that beat 8 falls in the SECOND window instead — the two picks differ.
    const calm = pickCameraMode(modes, 'groove', 0, 8, 0, null, 0)
    const danceable = pickCameraMode(modes, 'groove', 0, 8, 0, null, 6)
    expect(calm).toBe('orbit')
    expect(danceable).toBe('hover')
  })

  it('never narrows the rotation past the eight-beat floor', () => {
    // Beyond raw 6.0 (DANCE_LO + DANCE_SPAN) the normalization is already
    // saturated at 1, so a much hotter reading must land on the exact same
    // pick as 6.0 rather than narrowing further.
    const atSaturation = pickCameraMode(modes, 'groove', 0, 8, 0, null, 6)
    const wellPastSaturation = pickCameraMode(modes, 'groove', 0, 8, 0, null, 11.9)
    expect(wellPastSaturation).toBe(atSaturation)
  })

  it('treats a degenerate or non-finite reading as unreadable — falls back to the default cadence', () => {
    // Matches AudioFeatures.danceability's own doc: white noise / near-silence
    // reads ~97, which must not be trusted as "extremely danceable".
    for (const bad of [97, -5, NaN, Infinity, 0]) {
      expect(pickCameraMode(modes, 'groove', 0, 8, 0, null, bad)).toBe('orbit')
    }
  })

  it('never returns a mode outside the declared list at any danceability reading', () => {
    for (const dance of [0, 1, 6, 12, 97, -3, NaN]) {
      for (const beat of [0, 8, 16, 24]) {
        expect(modes).toContain(pickCameraMode(modes, 'groove', 0, beat, 0, null, dance))
      }
    }
  })
})

describe('sameShot', () => {
  it('is true only when both size and angle match', () => {
    expect(sameShot({ size: 'medium', angle: 'eye' }, { size: 'medium', angle: 'eye' })).toBe(true)
    expect(sameShot({ size: 'medium', angle: 'eye' }, { size: 'close', angle: 'eye' })).toBe(false)
    expect(sameShot({ size: 'medium', angle: 'eye' }, { size: 'medium', angle: 'high' })).toBe(false)
  })

  it('is false against null or undefined', () => {
    const tag = { size: 'medium' as const, angle: 'eye' as const }
    expect(sameShot(tag, null)).toBe(false)
    expect(sameShot(tag, undefined)).toBe(false)
    expect(sameShot(null, tag)).toBe(false)
  })
})

describe('pickCameraMode — avoidShot anti-repetition (audit c5)', () => {
  it('is unaffected when avoidShot is omitted, null, or undefined — every existing call site', () => {
    const modes: CameraMode[] = ['orbit', 'hover', 'locked']
    const bare = pickCameraMode(modes, 'groove', 0, 0)
    expect(pickCameraMode(modes, 'groove', 0, 0, 0, null)).toBe(bare)
    expect(pickCameraMode(modes, 'groove', 0, 0, 0, undefined)).toBe(bare)
  })

  it('steers away from a candidate matching avoidShot when a differently-tagged one is eligible', () => {
    // orbit and hover are both { medium, eye } (the natural pick at beat 0 for
    // 'groove' is 'orbit' — see MODE_PREFERENCE). cinematic is also
    // { medium, eye }; topdown is { close, high }, the one mode here that
    // looks different. With orbit already on screen, the picker must not
    // return another medium/eye mode.
    const modes: CameraMode[] = ['orbit', 'hover', 'cinematic', 'topdown']
    const onScreen = CAMERA_MODE_SHOT.orbit // { medium, eye }
    const pick = pickCameraMode(modes, 'groove', 0, 0, 0, onScreen)
    expect(sameShot(CAMERA_MODE_SHOT[pick], onScreen)).toBe(false)
  })

  it('falls back to the natural pick when every eligible mode looks the same', () => {
    // Every mode this scene declares is a medium/eye shot — there is nothing
    // to steer TOWARD, so the natural (mood-preference) pick must still win
    // rather than the function returning nothing usable.
    const modes: CameraMode[] = ['orbit', 'hover', 'locked']
    const natural = pickCameraMode(modes, 'groove', 0, 0)
    const withAvoid = pickCameraMode(modes, 'groove', 0, 0, 0, CAMERA_MODE_SHOT.orbit)
    expect(withAvoid).toBe(natural)
  })

  it('never returns a mode outside the declared list, even while avoiding a shot', () => {
    const modes: CameraMode[] = ['push', 'pull']
    for (const avoid of [CAMERA_MODE_SHOT.push, CAMERA_MODE_SHOT.pull, null]) {
      const pick = pickCameraMode(modes, 'peak', 0, 0, 0, avoid)
      expect(modes).toContain(pick)
    }
  })

  it('does not need to steer when the natural pick already differs from avoidShot', () => {
    // topdown ({close, high}) is not the same shot as pull ({wide, eye}), so
    // avoiding pull must not perturb a pick that was never going to collide.
    const modes: CameraMode[] = ['topdown']
    expect(pickCameraMode(modes, 'aggressive', 0, 0, 0, CAMERA_MODE_SHOT.pull)).toBe('topdown')
  })
})
