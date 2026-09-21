import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { audioEngine } from '../../audio/AudioEngine'
import { createEmptyFeatures, type MoodState } from '../../audio/types'
import {
  CAMERA_MODE_SHOT,
  computeDesired,
  desired,
  pickCameraMode,
  sameShot,
  type CameraAnchor,
} from '../CameraDirector'
import { createLookProfile, LOOK_CAMERA_MODES, type LookProfile } from '../look/lookRow'
import { performanceState, type CameraMode } from '../performanceState'
import { SCENES } from '../../scenes'

/**
 * The mood look profile reaching the camera: `pickCameraMode(..., look)` ranks by the blended camera weights while
 * the hard rules hold, and `computeDesired` scales its motion by `cameraSpeed` / `cameraShake` only while the
 * profile is valid with the camera family on. The legacy behaviour (look omitted) is pinned by CameraDirector.test.ts.
 */

const MOODS: MoodState[] = ['silence', 'ambient', 'mellow', 'groove', 'building', 'peak', 'aggressive']

/** A profile whose camera weights are exactly `w` (everything else neutral). NOT marked valid: the pick functions gate on the argument. */
function lookWith(w: Partial<Record<CameraMode, number>>, over: Partial<LookProfile> = {}): LookProfile {
  const look = createLookProfile()
  look.cameraWeights = LOOK_CAMERA_MODES.map((m) => w[m] ?? 0)
  return Object.assign(look, over)
}

/** Picks over `n` consecutive rotation windows (beat = 16k, the default period). */
function picks(
  modes: CameraMode[],
  mood: MoodState,
  look: LookProfile,
  n: number,
  o: { tension?: number; voice?: number; avoid?: Parameters<typeof pickCameraMode>[5]; dance?: number } = {},
): CameraMode[] {
  return Array.from({ length: n }, (_, k) =>
    pickCameraMode(modes, mood, o.tension ?? 0, 16 * k, o.voice ?? 0, o.avoid ?? null, o.dance ?? 0, look),
  )
}

const share = (xs: CameraMode[], m: CameraMode) => xs.filter((x) => x === m).length / xs.length

describe('pickCameraMode with a look profile', () => {
  it('is exactly the legacy pick when look is omitted or undefined — over the whole roster', () => {
    for (const scene of SCENES) {
      for (const mood of MOODS) {
        for (const tension of [0, 0.9]) {
          for (const beat of [0, 8, 16, 33, 64, 129]) {
            const modes = scene.metadata.cameraModes
            const bare = pickCameraMode(modes, mood, tension, beat, 0.7, null, 3)
            expect(pickCameraMode(modes, mood, tension, beat, 0.7, null, 3, undefined), `${scene.id}/${mood}`).toBe(bare)
          }
        }
      }
    }
  })

  it('only ever returns a mode the scene declared, whatever the weights', () => {
    const weightSets: Partial<Record<CameraMode, number>>[] = [
      { handheld: 1 },
      { push: 0.5, spiral: 0.5 },
      { locked: 1 },
      Object.fromEntries(LOOK_CAMERA_MODES.map((m) => [m, 1 / 9])),
    ]
    for (const scene of SCENES) {
      const modes = scene.metadata.cameraModes
      for (const w of weightSets) {
        for (const mood of MOODS) {
          for (const tension of [0, 0.9]) {
            for (const voice of [0, 0.9]) {
              for (const pick of picks(modes ?? [], mood, lookWith(w), 6, { tension, voice })) {
                expect(modes ?? ['hover'], `${scene.id}/${mood}`).toContain(pick)
              }
            }
          }
        }
      }
    }
  })

  it('biases the picks toward the heavier weights over many rotations', () => {
    // Two heavy modes and a light one, plus a declared mode the row never uses. Only the top two fits are
    // ever on screen (the 2-mode rotation), and the weights decide how often each is.
    const modes: CameraMode[] = ['orbit', 'spiral', 'hover', 'handheld']
    const look = lookWith({ handheld: 0.6, orbit: 0.3, spiral: 0.1 })
    const xs = picks(modes, 'peak', look, 1000)
    expect(share(xs, 'handheld')).toBeCloseTo(0.6 / 0.9, 1)
    expect(share(xs, 'handheld')).toBeGreaterThan(share(xs, 'orbit'))
    expect(share(xs, 'orbit')).toBeGreaterThan(0.2)
    // The third-ranked mode is outside the two-mode rotation, and a zero-weight mode is never ranked.
    expect(share(xs, 'spiral')).toBe(0)
    expect(share(xs, 'hover')).toBe(0)
  })

  it('still alternates between two near-equal fits, as the legacy rotation did', () => {
    const xs = picks(['orbit', 'hover', 'push'], 'groove', lookWith({ orbit: 0.5, hover: 0.5 }), 400)
    expect(share(xs, 'orbit')).toBeGreaterThan(0.4)
    expect(share(xs, 'hover')).toBeGreaterThan(0.4)
    // ...and the first window is the top fit, like rotation 0 always was.
    expect(xs[0]).toBe('orbit')
  })

  it('different moods weight the same scene differently', () => {
    const modes: CameraMode[] = ['orbit', 'hover', 'push', 'handheld', 'spiral']
    const calm = picks(modes, 'groove', lookWith({ hover: 0.8, orbit: 0.2 }), 200)
    const hard = picks(modes, 'groove', lookWith({ handheld: 0.8, push: 0.2 }), 200)
    expect(share(calm, 'hover')).toBeGreaterThan(0.6)
    expect(share(hard, 'handheld')).toBeGreaterThan(0.6)
    expect(new Set([...calm, ...hard]).has('handheld')).toBe(true)
    expect(calm.includes('handheld')).toBe(false)
  })

  it('uses the danceability-narrowed window like the legacy rotation', () => {
    const modes: CameraMode[] = ['orbit', 'hover']
    const look = lookWith({ orbit: 0.5, hover: 0.5 })
    // Period 16: beat 8 is still window 0. Highly danceable: period 8, so beat 8 is window 1.
    expect(pickCameraMode(modes, 'groove', 0, 8, 0, null, 0, look)).toBe('orbit')
    expect(pickCameraMode(modes, 'groove', 0, 8, 0, null, 6, look)).toBe('hover')
  })

  it('is deterministic, so a recorded set replays identically', () => {
    const modes: CameraMode[] = ['orbit', 'spiral', 'push', 'handheld']
    const look = lookWith({ orbit: 0.4, spiral: 0.3, push: 0.2, handheld: 0.1 })
    expect(picks(modes, 'groove', look, 50)).toEqual(picks(modes, 'groove', look, 50))
  })

  it('falls back to the legacy per-mood pick when no declared mode carries weight', () => {
    const modes: CameraMode[] = ['orbit', 'hover']
    const look = lookWith({ handheld: 1 }) // a mode this scene does not declare
    for (const beat of [0, 16, 32]) {
      expect(pickCameraMode(modes, 'groove', 0, beat, 0, null, 0, look)).toBe(
        pickCameraMode(modes, 'groove', 0, beat),
      )
    }
    // Garbage weights are not a crash either.
    const bad = lookWith({}, { cameraWeights: LOOK_CAMERA_MODES.map(() => NaN) })
    expect(pickCameraMode(modes, 'groove', 0, 0, 0, null, 0, bad)).toBe(pickCameraMode(modes, 'groove', 0, 0))
  })

  describe('the hard rules that survive', () => {
    it('never shoots a calm mood handheld, even when handheld is the mood profile’s top weight', () => {
      // A tense SONG in a quiet passage: the row says handheld, the fast layer says ambient.
      const modes: CameraMode[] = ['handheld', 'orbit', 'hover']
      const look = lookWith({ handheld: 0.8, orbit: 0.2 })
      for (const mood of ['silence', 'ambient', 'mellow'] as MoodState[]) {
        for (const tension of [0, 0.6, 1]) {
          for (const pick of picks(modes, mood, look, 20, { tension })) expect(pick).not.toBe('handheld')
        }
      }
      // Weighted ONLY on handheld: the look has nothing else to offer, so the legacy calm list decides.
      const onlyHandheld = lookWith({ handheld: 1 })
      for (const pick of picks(['handheld', 'hover'], 'ambient', onlyHandheld, 10)) expect(pick).toBe('hover')
      // The same profile is free to use it in a loud passage.
      expect(picks(modes, 'peak', look, 50)).toContain('handheld')
    })

    it('makes tension a bonus, not an override: it cannot introduce a mode the mood never uses', () => {
      const modes: CameraMode[] = ['orbit', 'hover', 'push']
      // Legacy: tension .9 promotes push for a groove.
      expect(pickCameraMode(modes, 'groove', 0.9, 0)).toBe('push')
      // Look: the row gives push no weight at all, so no tension can bring it in.
      const noPush = lookWith({ orbit: 0.6, hover: 0.4 })
      for (const tension of [0, 0.56, 0.9, 1]) expect(picks(modes, 'groove', noPush, 60, { tension })).not.toContain('push')
    })

    it('lets tension carry push / spiral up a row that already weights them', () => {
      const modes: CameraMode[] = ['orbit', 'hover', 'push']
      const look = lookWith({ hover: 0.4, orbit: 0.3, push: 0.2 })
      expect(picks(modes, 'groove', look, 60, { tension: 0 })).not.toContain('push')
      // x(1 + 1.5 * (0.9 - 0.55) / 0.45) = x2.17: .2 -> .43, ahead of hover's .4.
      const tense = picks(modes, 'groove', look, 200, { tension: 0.9 })
      expect(share(tense, 'push')).toBeGreaterThan(0.4)
      // Right at the threshold the bonus is still x1: nothing changes.
      expect(picks(modes, 'groove', look, 60, { tension: 0.55 })).toEqual(picks(modes, 'groove', look, 60, { tension: 0 }))
    })

    it('keeps the peak / aggressive exemption: tension does not reshape the release', () => {
      const modes: CameraMode[] = ['orbit', 'hover', 'push']
      const look = lookWith({ hover: 0.4, orbit: 0.3, push: 0.2 })
      for (const mood of ['peak', 'aggressive'] as MoodState[]) {
        expect(picks(modes, mood, look, 60, { tension: 0.95 })).toEqual(picks(modes, mood, look, 60, { tension: 0 }))
      }
    })

    it('keeps the voice promotion: a sung section is shot close and still, whatever the row weights', () => {
      const modes: CameraMode[] = ['orbit', 'hover', 'locked', 'push']
      const look = lookWith({ orbit: 0.7, hover: 0.3 }) // the row never uses locked / push
      const sung = picks(modes, 'groove', look, 100, { voice: 0.8 })
      expect(new Set(sung)).toEqual(new Set(['locked', 'push']))
      // Below the threshold it is the row's own choice again.
      expect(new Set(picks(modes, 'groove', look, 100, { voice: 0.3 }))).toEqual(new Set(['orbit', 'hover']))
    })

    it('ranks tension above voice: a sung build is still shot as a build', () => {
      const modes: CameraMode[] = ['orbit', 'hover', 'locked', 'push']
      const look = lookWith({ orbit: 0.7, push: 0.3 })
      const xs = picks(modes, 'groove', look, 100, { tension: 0.9, voice: 0.9 })
      expect(xs).not.toContain('locked')
    })

    it('avoids repeating the on-screen shot when a differently framed ranked mode exists', () => {
      const modes: CameraMode[] = ['orbit', 'hover', 'push']
      const look = lookWith({ orbit: 0.6, hover: 0.3, push: 0.1 })
      const onScreen = CAMERA_MODE_SHOT.orbit // medium / eye: orbit AND hover both repeat it
      for (const pick of picks(modes, 'groove', look, 40, { avoid: onScreen })) {
        expect(sameShot(CAMERA_MODE_SHOT[pick], onScreen)).toBe(false)
      }
    })

    it('keeps the natural pick when every weighted mode looks the same as the on-screen shot', () => {
      const modes: CameraMode[] = ['orbit', 'hover', 'push']
      const look = lookWith({ orbit: 0.6, hover: 0.4 }) // push has no weight, so it is not a candidate
      for (const pick of picks(modes, 'groove', look, 40, { avoid: CAMERA_MODE_SHOT.orbit })) {
        expect(['orbit', 'hover']).toContain(pick)
      }
    })
  })
})

// ---------------------------------------------------------------------------------------------------------
// Motion gains
// ---------------------------------------------------------------------------------------------------------

const ANCHOR: CameraAnchor = { target: [0, 0, 0], distance: 10, height: 1 }
const DT = 1 / 60

/** Silent, still audio: the motion is then purely the mode's own. */
function quietFeatures() {
  const f = createEmptyFeatures()
  f.bpm = 120
  f.confidence = 0
  f.energy = 0
  f.bass = 0
  f.beatStrength = 0
  return f
}

function setLook(over: Partial<Pick<LookProfile, 'valid' | 'cameraSpeed' | 'cameraShake'>> & { camera?: boolean }) {
  const { camera, ...rest } = over
  Object.assign(performanceState.look, rest)
  if (camera !== undefined) performanceState.look.families.camera = camera
}

/** Unwrapped change of bearing around the subject over `frames` frames of `mode`. */
function bearingChange(mode: CameraMode, frames: number): number {
  computeDesired(mode, ANCHOR, 0, DT)
  let prev = Math.atan2(desired.z, desired.x)
  let total = 0
  for (let i = 0; i < frames; i++) {
    computeDesired(mode, ANCHOR, 0, DT)
    const a = Math.atan2(desired.z, desired.x)
    let d = a - prev
    if (d > Math.PI) d -= 2 * Math.PI
    if (d < -Math.PI) d += 2 * Math.PI
    total += d
    prev = a
  }
  return total
}

describe('computeDesired with a look profile', () => {
  beforeEach(() => {
    Object.assign(audioEngine.features, quietFeatures())
    Object.assign(performanceState.look, createLookProfile())
  })
  afterEach(() => {
    Object.assign(performanceState.look, createLookProfile())
  })

  it('scales the angular drift of the orbiting modes by cameraSpeed', () => {
    for (const mode of ['orbit', 'spiral', 'topdown', 'cinematic'] as CameraMode[]) {
      const base = bearingChange(mode, 300)
      expect(base, mode).toBeGreaterThan(0)
      setLook({ valid: true, camera: true, cameraSpeed: 1.5 })
      expect(bearingChange(mode, 300) / base, mode).toBeCloseTo(1.5, 6)
      setLook({ cameraSpeed: 0.6 })
      expect(bearingChange(mode, 300) / base, mode).toBeCloseTo(0.6, 6)
      setLook({ valid: false, cameraSpeed: 1 })
    }
  })

  it('scales the approach rate of push and pull by cameraSpeed', () => {
    const rate = (mode: 'push' | 'pull', speed: number): number => {
      // Restart from the anchor distance, run one second, and read the exponent the eased distance closed by.
      for (let i = 0; i < 600; i++) computeDesired('locked', ANCHOR, 0, DT)
      const z0 = desired.z
      setLook({ valid: true, camera: true, cameraSpeed: speed })
      for (let i = 0; i < 60; i++) computeDesired(mode, ANCHOR, 0, DT)
      const z1 = desired.z
      setLook({ valid: false, cameraSpeed: 1 })
      // Where the mode is headed, from a long converged run at speed 1.
      for (let i = 0; i < 6000; i++) computeDesired(mode, ANCHOR, 0, DT)
      const target = desired.z
      return -Math.log((z1 - target) / (z0 - target))
    }
    for (const mode of ['push', 'pull'] as const) {
      expect(rate(mode, 1.5) / rate(mode, 1), mode).toBeCloseTo(1.5, 1)
    }
  })

  it('scales the handheld jitter amplitude by cameraShake, and only that mode’s jitter', () => {
    // dt = 0 freezes the phase, so the same instant is measured under different gains.
    const offset = (): [number, number] => {
      computeDesired('handheld', ANCHOR, 0, 0)
      return [desired.x - ANCHOR.target[0], desired.y - (ANCHOR.target[1] + ANCHOR.height)]
    }
    let largest = 0
    for (let i = 0; i < 25; i++) {
      computeDesired('handheld', ANCHOR, 0, 0.37) // move to a new phase, look off
      const [x1, y1] = offset()
      largest = Math.max(largest, Math.abs(x1), Math.abs(y1))
      setLook({ valid: true, camera: true, cameraShake: 1.5 })
      const [x2, y2] = offset()
      setLook({ cameraShake: 0 })
      const [x0, y0] = offset()
      setLook({ valid: false, cameraShake: 1 })
      expect(x2).toBeCloseTo(1.5 * x1, 9)
      expect(y2).toBeCloseTo(1.5 * y1, 9)
      expect(x0).toBeCloseTo(0, 9)
      expect(y0).toBeCloseTo(0, 9)
    }
    // The check above is not vacuous: the jitter actually moved the lens somewhere in those 25 phases.
    expect(largest).toBeGreaterThan(1e-3)
  })

  it('is the identity when the profile is invalid, its camera family is off, or the gains are 1', () => {
    const conditions: [string, Parameters<typeof setLook>[0]][] = [
      ['invalid', { valid: false, camera: true, cameraSpeed: 1.6, cameraShake: 1.5 }],
      ['family off', { valid: true, camera: false, cameraSpeed: 1.6, cameraShake: 1.5 }],
      ['unity gains', { valid: true, camera: true, cameraSpeed: 1, cameraShake: 1 }],
    ]
    const restore = () => setLook({ valid: false, camera: true, cameraSpeed: 1, cameraShake: 1 })

    // Angular modes: the bearing swept over the same number of frames.
    for (const mode of ['orbit', 'spiral', 'topdown', 'cinematic'] as CameraMode[]) {
      const legacy = bearingChange(mode, 200)
      for (const [name, cond] of conditions) {
        setLook(cond)
        expect(bearingChange(mode, 200), `${mode}/${name}`).toBeCloseTo(legacy, 12)
        restore()
      }
    }

    // Distance modes (and handheld's distance): restart from the anchor distance, run, read where the lens sits.
    const settled = (mode: CameraMode): number => {
      for (let i = 0; i < 600; i++) computeDesired('locked', ANCHOR, 0, DT)
      for (let i = 0; i < 120; i++) computeDesired(mode, ANCHOR, 0, DT)
      return desired.z
    }
    for (const mode of ['push', 'pull', 'handheld'] as CameraMode[]) {
      const legacy = settled(mode)
      for (const [name, cond] of conditions) {
        setLook(cond)
        expect(settled(mode), `${mode}/${name}`).toBeCloseTo(legacy, 9)
        restore()
      }
    }

    // Handheld jitter at a frozen phase.
    const offset = (): [number, number] => {
      computeDesired('handheld', ANCHOR, 0, 0)
      return [desired.x, desired.y]
    }
    for (let i = 0; i < 10; i++) {
      computeDesired('handheld', ANCHOR, 0, 0.37)
      const [lx, ly] = offset()
      for (const [name, cond] of conditions) {
        setLook(cond)
        const [x, y] = offset()
        restore()
        expect(x, `handheld x/${name}`).toBeCloseTo(lx, 12)
        expect(y, `handheld y/${name}`).toBeCloseTo(ly, 12)
      }
    }
  })

  it('treats a corrupt profile as the identity rather than freezing or flinging the lens', () => {
    const base = bearingChange('orbit', 120)
    setLook({ valid: true, camera: true, cameraSpeed: NaN })
    expect(bearingChange('orbit', 120)).toBeCloseTo(base, 9)
    setLook({ cameraSpeed: 1e9 })
    // Clamped to 2x, not 1e9x.
    expect(bearingChange('orbit', 120) / base).toBeCloseTo(2, 6)
    setLook({ cameraSpeed: -5 })
    expect(bearingChange('orbit', 120) / base).toBeCloseTo(0.25, 6)
  })
})
