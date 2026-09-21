import { afterEach, describe, expect, it } from 'vitest'
import { MOOD_STATES } from '../../audio/types'
import { registerScene, type SceneDef } from '../../scenes'
import { SCENE_PARAM_KEYS, type SceneParams } from '../../scenes/contract'
import { createLookProfile, type LookProfile } from '../look/lookRow'
import { approach, performanceState } from '../performanceState'
import {
  STEERED_KEYS,
  advanceSteer,
  clearSteer,
  shapeTarget,
  steerTargets,
  steerTargetsFromLook,
  tiltTarget,
} from '../sceneSteer'

/**
 * The mood look profile reaching the scene steer: the five resting targets come from the profile's `steer*`
 * fields, `shape` / `tilt` are steered ONLY for a scene that opted in via `contract.directorSteers`, and with no
 * profile the steer is exactly what it was. The legacy behaviour is pinned by sceneSteer.test.ts.
 */

const DT = 1 / 60
const STEER_RATE = 0.35
const DROP_RATE = 6

function lookWith(over: Partial<LookProfile> = {}): LookProfile {
  return Object.assign(createLookProfile(), over)
}

/** All five resting dials at `v`. */
const flat = (v: number, over: Partial<LookProfile> = {}): LookProfile =>
  lookWith({ steerSpeed: v, steerComplexity: v, steerDensity: v, steerFill: v, steerContrast: v, ...over })

const LOOK_FIELD = {
  speed: 'steerSpeed',
  complexity: 'steerComplexity',
  density: 'steerDensity',
  fill: 'steerFill',
  contrast: 'steerContrast',
} as const

/** Frames of `advanceSteer` with a profile, no scene opt-in unless given. */
function run(state: SceneParams, look: LookProfile | undefined, frames: number, o: { drop?: boolean; tension?: number; steers?: readonly ('shape' | 'tilt')[] } = {}) {
  for (let i = 0; i < frames; i++) {
    advanceSteer(state, { mood: 'groove', tension: o.tension ?? 0, delta: DT, drop: o.drop, look, directorSteers: o.steers })
  }
}

afterEach(() => {
  performanceState.activeScene = 'wireframe'
})

describe('steerTargetsFromLook', () => {
  it('rests each dial at the profile’s steer field, plus the same tension terms as the legacy table', () => {
    const look = lookWith({ steerSpeed: 0.2, steerComplexity: 0.3, steerDensity: 0.4, steerFill: 0.5, steerContrast: 0.6 })
    const rest = steerTargetsFromLook(look, 0)
    for (const k of STEERED_KEYS) expect(rest[k]).toBeCloseTo(look[LOOK_FIELD[k]], 12)
    // The tension gain is whatever the legacy table adds (groove is far from the clamp), per dial.
    const under = steerTargetsFromLook(look, 1)
    for (const k of STEERED_KEYS) {
      const gain = steerTargets('groove', 1)[k] - steerTargets('groove', 0)[k]
      expect(under[k] - rest[k], k).toBeCloseTo(gain, 12)
    }
  })

  it('is the legacy result when the profile carries the legacy row — every mood, every tension', () => {
    for (const mood of MOOD_STATES) {
      const row = steerTargets(mood, 0)
      const look = lookWith({
        steerSpeed: row.speed,
        steerComplexity: row.complexity,
        steerDensity: row.density,
        steerFill: row.fill,
        steerContrast: row.contrast,
      })
      for (const tension of [0, 0.3, 0.7, 1, 5, -2]) {
        const want = steerTargets(mood, tension)
        const got = steerTargetsFromLook(look, tension)
        for (const k of STEERED_KEYS) expect(got[k], `${mood}/${tension}/${k}`).toBeCloseTo(want[k], 12)
      }
    }
  })

  it('stays inside 0..1 whatever the profile holds', () => {
    for (const v of [-5, 0, 1, 7, NaN, Infinity]) {
      for (const tension of [-3, 0, 1, 40]) {
        const t = steerTargetsFromLook(flat(v), tension)
        for (const k of STEERED_KEYS) {
          expect(t[k], `${v}/${tension}/${k}`).toBeGreaterThanOrEqual(0)
          expect(t[k], `${v}/${tension}/${k}`).toBeLessThanOrEqual(1)
        }
      }
    }
  })
})

describe('advanceSteer with a look profile', () => {
  it('is bit-identical to the legacy steer when look is omitted or undefined', () => {
    const ref: SceneParams = {}
    const omitted: SceneParams = {}
    const explicit: SceneParams = {}
    const seq = [
      { mood: 'silence', tension: 0, delta: DT, drop: false },
      { mood: 'ambient', tension: 0.2, delta: 0.05, drop: false },
      { mood: 'building', tension: 0.9, delta: DT, drop: false },
      { mood: 'peak', tension: 1, delta: DT, drop: true },
      { mood: 'peak', tension: 1, delta: 0.5, drop: true },
      { mood: 'aggressive', tension: 0.4, delta: 4, drop: false },
      { mood: 'groove', tension: 0, delta: NaN, drop: false },
    ] as const
    for (let rep = 0; rep < 40; rep++) {
      for (const f of seq) {
        // The legacy formula, spelled out.
        const tg = steerTargets(f.mood, f.tension)
        const rate = f.drop ? DROP_RATE : STEER_RATE
        for (const k of STEERED_KEYS) ref[k] = ref[k] === undefined ? tg[k] : approach(ref[k]!, tg[k], rate, f.delta)
        advanceSteer(omitted, f)
        advanceSteer(explicit, { ...f, look: undefined })
        expect(omitted).toEqual(ref)
        expect(explicit).toEqual(ref)
      }
    }
    expect(Object.keys(omitted).sort()).toEqual([...STEERED_KEYS].sort())
  })

  it('seeds the first frame at the profile’s target rather than easing up from neutral', () => {
    const s: SceneParams = {}
    run(s, flat(0.8), 1)
    const want = steerTargetsFromLook(flat(0.8), 0)
    for (const k of STEERED_KEYS) expect(s[k], k).toBeCloseTo(want[k], 12)
  })

  it('approaches the profile’s targets at the documented 0.35 / s', () => {
    const s: SceneParams = {}
    for (const k of STEERED_KEYS) s[k] = 0
    run(s, flat(0.8), 60) // one second
    for (const k of STEERED_KEYS) expect(s[k], k).toBeCloseTo(0.8 * (1 - Math.exp(-STEER_RATE)), 9)
    run(s, flat(0.8), 60 * 30)
    for (const k of STEERED_KEYS) expect(s[k], k).toBeCloseTo(0.8, 3)
  })

  it('moves at the 6 / s drop rate on a drop', () => {
    const s: SceneParams = {}
    for (const k of STEERED_KEYS) s[k] = 0
    run(s, flat(0.8), 1, { drop: true })
    for (const k of STEERED_KEYS) expect(s[k], k).toBeCloseTo(0.8 * (1 - Math.exp(-DROP_RATE * DT)), 12)
    const slow: SceneParams = {}
    for (const k of STEERED_KEYS) slow[k] = 0
    run(slow, flat(0.8), 1)
    expect(s.complexity!).toBeGreaterThan(slow.complexity! * 4)
  })

  it('eases to a changed profile instead of snapping to it', () => {
    const s: SceneParams = {}
    run(s, flat(0.2), 120)
    const before = s.speed!
    run(s, flat(0.9), 1)
    expect(s.speed!).toBeGreaterThan(before)
    expect(s.speed!).toBeLessThan(before + (0.9 - before) * 0.2)
  })

  it('adds the tension terms on top of the profile’s resting position', () => {
    const calm: SceneParams = {}
    const tense: SceneParams = {}
    run(calm, flat(0.4), 1, { tension: 0 })
    run(tense, flat(0.4), 1, { tension: 1 })
    for (const k of STEERED_KEYS) expect(tense[k]!, k).toBeGreaterThan(calm[k]!)
  })

  it('never leaves a dial outside 0..1', () => {
    const s: SceneParams = {}
    for (const v of [9, -9, NaN]) {
      for (const delta of [DT, 0.5, 4]) {
        run(s, flat(v, { buildIntent: 9 }), 1, { drop: true, tension: 1, steers: ['shape', 'tilt'] })
        advanceSteer(s, { mood: 'peak', tension: 1, delta, drop: true, look: flat(v), directorSteers: ['shape', 'tilt'] })
        for (const k of [...STEERED_KEYS, 'shape', 'tilt'] as const) {
          expect(s[k]!, `${v}/${delta}/${k}`).toBeGreaterThanOrEqual(0)
          expect(s[k]!, `${v}/${delta}/${k}`).toBeLessThanOrEqual(1)
        }
      }
    }
  })
})

describe('shape and tilt: steered only for a scene that opted in', () => {
  it('has the documented targets', () => {
    expect(shapeTarget(lookWith({ steerComplexity: 0 }))).toBeCloseTo(0.35, 12)
    expect(shapeTarget(lookWith({ steerComplexity: 0.6 }))).toBeCloseTo(0.65, 12)
    expect(shapeTarget(lookWith({ steerComplexity: 1 }))).toBeCloseTo(0.85, 12)
    expect(tiltTarget(lookWith({ buildIntent: 0, steerSpeed: 0.5 }))).toBeCloseTo(0.5, 12)
    expect(tiltTarget(lookWith({ buildIntent: 0.5, steerSpeed: 0.8 }))).toBeCloseTo(0.5 + 0.2 + 0.045, 12)
    expect(tiltTarget(lookWith({ buildIntent: 1, steerSpeed: 1 }))).toBeCloseTo(0.5 + 0.4 + 0.075, 12)
    // A build winds it up, and the speed dial leans it either way.
    expect(tiltTarget(lookWith({ buildIntent: 1 }))).toBeGreaterThan(tiltTarget(lookWith({ buildIntent: 0 })))
    expect(tiltTarget(lookWith({ steerSpeed: 0.1 }))).toBeLessThan(0.5)
    for (const v of [-9, 0.5, 9, NaN]) {
      for (const t of [shapeTarget(lookWith({ steerComplexity: v })), tiltTarget(lookWith({ buildIntent: v, steerSpeed: v }))]) {
        expect(t).toBeGreaterThanOrEqual(0)
        expect(t).toBeLessThanOrEqual(1)
      }
    }
  })

  it('steers exactly the dials the scene opted into', () => {
    const look = lookWith({ steerComplexity: 0.6, buildIntent: 0.5, steerSpeed: 0.8 })
    const shapeOnly: SceneParams = {}
    run(shapeOnly, look, 1, { steers: ['shape'] })
    expect(shapeOnly.shape).toBeCloseTo(shapeTarget(look), 12)
    expect(shapeOnly.tilt).toBeUndefined()

    const tiltOnly: SceneParams = {}
    run(tiltOnly, look, 1, { steers: ['tilt'] })
    expect(tiltOnly.tilt).toBeCloseTo(tiltTarget(look), 12)
    expect(tiltOnly.shape).toBeUndefined()

    const both: SceneParams = {}
    run(both, look, 1, { steers: ['shape', 'tilt'] })
    expect(both.shape).toBeCloseTo(shapeTarget(look), 12)
    expect(both.tilt).toBeCloseTo(tiltTarget(look), 12)
  })

  it('eases them at the same rate as the other dials, faster on a drop', () => {
    const look = lookWith({ steerComplexity: 1, buildIntent: 1, steerSpeed: 0.5 })
    const s: SceneParams = { shape: 0.35, tilt: 0.5 }
    run(s, look, 60, { steers: ['shape', 'tilt'] })
    expect(s.shape).toBeCloseTo(0.35 + (0.85 - 0.35) * (1 - Math.exp(-STEER_RATE)), 9)
    expect(s.tilt).toBeCloseTo(0.5 + (0.9 - 0.5) * (1 - Math.exp(-STEER_RATE)), 9)

    const d: SceneParams = { shape: 0.35, tilt: 0.5 }
    run(d, look, 1, { steers: ['shape', 'tilt'], drop: true })
    expect(d.shape).toBeCloseTo(0.35 + (0.85 - 0.35) * (1 - Math.exp(-DROP_RATE * DT)), 12)
    expect(d.tilt).toBeCloseTo(0.5 + (0.9 - 0.5) * (1 - Math.exp(-DROP_RATE * DT)), 12)
  })

  it('never writes them for a scene that did not opt in — the existing global rule', () => {
    const look = lookWith({ steerComplexity: 1, buildIntent: 1, steerSpeed: 1 })
    const s: SceneParams = {}
    run(s, look, 120, { steers: [], tension: 1 })
    run(s, look, 30, { steers: [], tension: 1, drop: true })
    expect(s.shape).toBeUndefined()
    expect(s.tilt).toBeUndefined()
    for (const k of SCENE_PARAM_KEYS) {
      if (k === 'shape' || k === 'tilt') continue
      expect(s[k], k).toBeDefined()
    }
    // And by default the active scene's own contract decides: wireframe declares no `directorSteers`.
    const byContract: SceneParams = {}
    performanceState.activeScene = 'wireframe'
    run(byContract, look, 30)
    expect(byContract.shape).toBeUndefined()
    expect(byContract.tilt).toBeUndefined()
  })

  it('takes them back out as soon as the active scene has not opted in, so the next scene cannot inherit them', () => {
    const look = lookWith({ steerComplexity: 0.9 })
    const s: SceneParams = {}
    run(s, look, 30, { steers: ['shape', 'tilt'] })
    expect(s.shape).toBeDefined()
    expect(s.tilt).toBeDefined()
    // Next scene keeps `shape` only.
    run(s, look, 1, { steers: ['shape'] })
    expect(s.shape).toBeDefined()
    expect(s.tilt).toBeUndefined()
    // Next scene keeps neither.
    run(s, look, 1, { steers: [] })
    expect(s.shape).toBeUndefined()
    expect(Object.keys(s).sort()).toEqual([...STEERED_KEYS].sort())
  })

  it('also cleans up on the legacy path (no profile) once the active scene is not an opt-in', () => {
    const stale: SceneParams = { speed: 0.5, shape: 0.7, tilt: 0.2 }
    performanceState.activeScene = 'wireframe'
    advanceSteer(stale, { mood: 'groove', tension: 0, delta: DT })
    expect(stale.shape).toBeUndefined()
    expect(stale.tilt).toBeUndefined()
  })

  it('leaves an opted-in scene’s value where it was when the profile goes away, rather than jumping it', () => {
    const s: SceneParams = { shape: 0.7, tilt: 0.2 }
    advanceSteer(s, { mood: 'groove', tension: 0, delta: DT, directorSteers: ['shape', 'tilt'] })
    expect(s.shape).toBe(0.7)
    expect(s.tilt).toBe(0.2)
  })

  it('reads the ACTIVE scene’s contract when nothing is passed', () => {
    registerScene({
      id: 'test-steer-optin',
      name: 'Test steer opt-in',
      component: (() => null) as unknown as SceneDef['component'],
      metadata: {
        roles: ['primary'],
        moods: ['groove'],
        bands: ['energy'],
        intensity: 'medium',
        performanceCost: 'low',
        compatibleWith: [],
        contract: { version: 1, params: { speed: 0.5, shape: 0.5, tilt: 0.5 }, directorSteers: ['tilt'] },
      },
    } as SceneDef)
    const look = lookWith({ buildIntent: 1, steerSpeed: 0.5, steerComplexity: 0.5 })
    const s: SceneParams = {}

    performanceState.activeScene = 'test-steer-optin'
    advanceSteer(s, { mood: 'groove', tension: 0, delta: DT, look })
    expect(s.tilt).toBeCloseTo(tiltTarget(look), 12)
    expect(s.shape).toBeUndefined() // the scene opted into tilt only

    // The show moves on to a scene that did not opt in: the tilt is gone the same frame.
    performanceState.activeScene = 'wireframe'
    advanceSteer(s, { mood: 'groove', tension: 0, delta: DT, look })
    expect(s.tilt).toBeUndefined()
  })
})

describe('clearSteer', () => {
  it('also removes an opted-in scene’s shape and tilt, leaving no opinion at all', () => {
    const s: SceneParams = {}
    run(s, lookWith(), 5, { steers: ['shape', 'tilt'] })
    expect(s.shape).toBeDefined()
    clearSteer(s)
    expect(Object.keys(s)).toEqual([])
  })
})
