import { describe, expect, it } from 'vitest'
import AUTOPILOT_SRC from '../AutoPilot.tsx?raw'
import DIRECTOR_SRC from '../PerformanceDirector.tsx?raw'
import { createEmptyCharacterState, type CharacterState } from '../../audio/characterTypes'
import { createLookProfile, type LookProfile } from '../look/lookRow'
import { getCharacterCandidates, type SceneDef } from '../../scenes'
import { getSceneTraits, sceneBoost } from '../../scenes/sceneTraits'
import { canAutoSwitch, MIN_SUBJECT_DWELL_BEATS } from '../../store'
import {
  BUILD_SWITCH,
  beatsTillDropUnknown,
  buildSwitchRng,
  createBuildSwitchState,
  observeBuild,
  pickAndRequest,
  shouldSwitchOnBuild,
  type BuildSwitchInput,
} from '../buildSwitch'
import { pickByCharacter } from '../characterPick'

/** Every rule satisfied: a fresh confirmed build, dwell elapsed, long way to the drop, calm scene on screen. */
const GO: BuildSwitchInput = {
  lookActive: true,
  risingEdge: true,
  fired: false,
  canSwitch: true,
  beatsTillDrop: 24,
  currentBuildFit: 0.2,
  hasPending: false,
}

describe('observeBuild: rising edge and once-per-build latch', () => {
  it('reports true only on the frame sustain goes false -> true', () => {
    const s = createBuildSwitchState()
    const seq = [false, false, true, true, true, false, false, true, true]
    const edges = seq.map((x) => observeBuild(s, x))
    expect(edges).toEqual([false, false, true, false, false, false, false, true, false])
  })

  it('a build already in progress on the first frame counts as a rising edge (prev starts false)', () => {
    expect(observeBuild(createBuildSwitchState(), true)).toBe(true)
  })

  it('re-arms the once-per-build latch only when the build ends', () => {
    const s = createBuildSwitchState()
    observeBuild(s, true)
    s.fired = true // AutoPilot marks the attempt
    observeBuild(s, true)
    observeBuild(s, true)
    expect(s.fired).toBe(true) // still the same build
    observeBuild(s, false)
    expect(s.fired).toBe(false) // next build gets its own attempt
  })

  it('a build that starts while automation is suppressed is consumed, not fired late', () => {
    // AutoPilot calls observeBuild before its early returns, so the edge frame is spent even if it returned right
    // after; later frames of the same build are then not edges.
    const s = createBuildSwitchState()
    expect(observeBuild(s, true)).toBe(true) // suppressed frame: edge lost by design
    expect(observeBuild(s, true)).toBe(false) // hold lifts mid-build: no late firing
    expect(shouldSwitchOnBuild({ ...GO, risingEdge: false })).toBe(false)
  })
})

describe('shouldSwitchOnBuild', () => {
  it('fires when every rule holds', () => {
    expect(shouldSwitchOnBuild(GO)).toBe(true)
  })

  it('needs the look profile to be active (otherwise the show behaves exactly as before)', () => {
    expect(shouldSwitchOnBuild({ ...GO, lookActive: false })).toBe(false)
  })

  it('rising edge only: no edge, no switch', () => {
    expect(shouldSwitchOnBuild({ ...GO, risingEdge: false })).toBe(false)
  })

  it('once per build: a build that already had its attempt does not fire again', () => {
    expect(shouldSwitchOnBuild({ ...GO, fired: true })).toBe(false)
  })

  it('dwell: only when the subject dwell has elapsed', () => {
    const at = (lastCommit: number, now: number) => canAutoSwitch(lastCommit, now)
    expect(shouldSwitchOnBuild({ ...GO, canSwitch: at(100, 100 + MIN_SUBJECT_DWELL_BEATS - 1) })).toBe(false)
    expect(shouldSwitchOnBuild({ ...GO, canSwitch: at(100, 100 + MIN_SUBJECT_DWELL_BEATS) })).toBe(true)
    expect(shouldSwitchOnBuild({ ...GO, canSwitch: at(-Infinity, 0) })).toBe(true) // the very first switch
  })

  it('beatsTillDrop: unknown or at least 12 fires, a known shorter build does not', () => {
    for (const unknown of [-1, 0, Number.NaN, Infinity, -Infinity]) {
      expect(beatsTillDropUnknown(unknown), String(unknown)).toBe(true)
      expect(shouldSwitchOnBuild({ ...GO, beatsTillDrop: unknown }), String(unknown)).toBe(true)
    }
    expect(BUILD_SWITCH.minBeatsTillDrop).toBe(12)
    expect(shouldSwitchOnBuild({ ...GO, beatsTillDrop: 12 })).toBe(true)
    expect(shouldSwitchOnBuild({ ...GO, beatsTillDrop: 48 })).toBe(true)
    for (const soon of [1, 3, 8, 11.9]) expect(shouldSwitchOnBuild({ ...GO, beatsTillDrop: soon }), String(soon)).toBe(false)
  })

  it('buildFit: only when the scene on screen is a poor build scene (< 0.5)', () => {
    expect(shouldSwitchOnBuild({ ...GO, currentBuildFit: 0.49 })).toBe(true)
    expect(shouldSwitchOnBuild({ ...GO, currentBuildFit: 0.5 })).toBe(false)
    expect(shouldSwitchOnBuild({ ...GO, currentBuildFit: 0.9 })).toBe(false)
    // With the real table: leave a calm scene, stay on a build scene, never chase a cutaway.
    for (const calm of ['snowflake', 'chrome', 'wireframe', 'dissolve', 'butterfly', 'travelling']) {
      expect(shouldSwitchOnBuild({ ...GO, currentBuildFit: getSceneTraits(calm).buildFit }), calm).toBe(true)
    }
    for (const fast of ['beats', 'javazone', 'maze', 'web', 'plasma', 'kifs', 'wingfold', 'lattesfold', 'limitless', 'djcam']) {
      expect(shouldSwitchOnBuild({ ...GO, currentBuildFit: getSceneTraits(fast).buildFit }), fast).toBe(false)
    }
  })

  it('nothing pending: a switch already in flight blocks it', () => {
    expect(shouldSwitchOnBuild({ ...GO, hasPending: true })).toBe(false)
  })

  it('every rule is necessary: breaking any single one is enough to refuse', () => {
    const breakers: Partial<BuildSwitchInput>[] = [
      { lookActive: false },
      { risingEdge: false },
      { fired: true },
      { canSwitch: false },
      { beatsTillDrop: 5 },
      { currentBuildFit: 0.8 },
      { hasPending: true },
    ]
    for (const b of breakers) expect(shouldSwitchOnBuild({ ...GO, ...b }), JSON.stringify(b)).toBe(false)
  })
})

describe('pickAndRequest: bounded re-pick on refusal', () => {
  const scene = (id: string) => ({ id })

  it('requests the first pick and stops when it is accepted', () => {
    const asked: string[] = []
    const r = pickAndRequest(
      ['now'],
      () => scene('a'),
      (s) => {
        asked.push(s.id)
        return true
      },
    )
    expect(r.scene?.id).toBe('a')
    expect(r.requests).toBe(1)
    expect(asked).toEqual(['a'])
  })

  it('excludes a refused id and re-picks (the base exclusion is kept, refusals accumulate)', () => {
    const excludes: string[][] = []
    const ids = ['a', 'b', 'c']
    const r = pickAndRequest(
      ['now'],
      (exclude, attempt) => {
        excludes.push([...exclude])
        return scene(ids[attempt])
      },
      (s) => s.id === 'c',
    )
    expect(r.scene?.id).toBe('c')
    expect(r.requests).toBe(3)
    expect(excludes).toEqual([['now'], ['now', 'a'], ['now', 'a', 'b']])
  })

  it('is bounded: the first pick plus maxRepicks re-picks, then it gives up (never loops)', () => {
    let picks = 0
    let requests = 0
    const r = pickAndRequest(
      [],
      () => scene(`s${picks++}`),
      () => {
        requests++
        return false
      },
    )
    expect(r.scene).toBeNull()
    expect(r.requests).toBe(1 + BUILD_SWITCH.maxRepicks)
    expect(requests).toBe(1 + BUILD_SWITCH.maxRepicks)
    expect(picks).toBe(1 + BUILD_SWITCH.maxRepicks)
    expect(BUILD_SWITCH.maxRepicks).toBeLessThanOrEqual(3)
  })

  it('honours a smaller explicit bound, including none', () => {
    let n = 0
    pickAndRequest([], () => scene(`x${n++}`), () => false, 1)
    expect(n).toBe(2)
    n = 0
    pickAndRequest([], () => scene(`x${n++}`), () => false, 0)
    expect(n).toBe(1)
  })

  it('stops at once when the picker has nothing to offer (null) or offers an excluded id (exhausted pool)', () => {
    expect(pickAndRequest([], () => null, () => true)).toEqual({ scene: null, requests: 0 })
    // pickSceneForCharacter ignores `exclude` when it would remove everything: the same excluded id comes back.
    expect(pickAndRequest(['cur'], () => scene('cur'), () => true)).toEqual({ scene: null, requests: 0 })
    const again = pickAndRequest([], () => scene('same'), () => false)
    expect(again.requests).toBe(1) // 'same' refused once, then the picker repeats it: stop
    expect(again.scene).toBeNull()
  })
})

describe('buildSwitchRng', () => {
  it('is deterministic per (beat, attempt), in [0, 1), and differs across beats and attempts', () => {
    const draw = (beat: number, attempt: number) => {
      const r = buildSwitchRng(beat, attempt)
      return [r(), r(), r()]
    }
    expect(draw(100, 0)).toEqual(draw(100, 0))
    expect(draw(100, 0)).not.toEqual(draw(100, 1))
    expect(draw(100, 0)).not.toEqual(draw(101, 0))
    for (const v of draw(7, 2)) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})

// ---------------------------------------------------------------------------------------------------------
// The whole pick as AutoPilot performs it: real picker, real candidates, real trait table.
// ---------------------------------------------------------------------------------------------------------

function character(over: Partial<CharacterState> = {}): CharacterState {
  return {
    ...createEmptyCharacterState(),
    valid: true,
    primary: 'serene',
    valence: 0.7,
    arousal: 0.12,
    tension: 0.1,
    pulse: 0.2,
    confidence: 0.7,
    ...over,
  }
}

/** A groove-level passage, the kind a real riser sits in: rhythmic, mid arousal, low tension. */
const GROOVE = character({ primary: 'groove', valence: 0.6, arousal: 0.5, tension: 0.2, pulse: 0.7 })

function buildLook(): LookProfile {
  const p = createLookProfile()
  p.valid = true
  p.source = 'character'
  p.buildIntent = 0.3 // the ramp has barely started at the rising edge
  return p
}

/** What AutoPilot's block does, minus the store. `refuse` simulates `requestScene` returning false for an id. */
function buildSwitchPick(opts: {
  current: string
  beat: number
  cs?: CharacterState
  refuse?: (id: string) => boolean
  look?: LookProfile
}): { scene: SceneDef | null; requests: string[] } {
  const look = opts.look ?? buildLook()
  const cs = opts.cs ?? GROOVE
  const requests: string[] = []
  const { scene } = pickAndRequest(
    [opts.current],
    (exclude, attempt) =>
      pickByCharacter(getCharacterCandidates(), {
        character: cs,
        key: 'C',
        now: 100,
        recentIds: [],
        exclude,
        minArousal: BUILD_SWITCH.minArousal,
        minTension: BUILD_SWITCH.minTension,
        liftSecondary: true,
        boost: (s) => sceneBoost(s, look, 'build'),
        rng: buildSwitchRng(opts.beat, attempt),
      }),
    (s) => {
      requests.push(s.id)
      return !(opts.refuse?.(s.id) ?? false)
    },
  )
  return { scene, requests }
}

describe('the one-shot build pick (real picker, lifted point, build boost)', () => {
  const resetSeed = () =>
    // A new source restarts the per-song seed tracker, so the cast is a function of each test alone.
    pickByCharacter(getCharacterCandidates(), { character: character({ valid: false }), key: 'C', now: 100, recentIds: [] })
  const tallyOf = (make: (beat: number) => SceneDef | null, n = 300) => {
    const tally = new Map<string, number>()
    for (let beat = 0; beat < n; beat++) {
      const scene = make(beat)
      if (scene) tally.set(scene.id, (tally.get(scene.id) ?? 0) + 1)
    }
    const total = [...tally.values()].reduce((a, b) => a + b, 0)
    const meanBuildFit = [...tally.entries()].reduce((sum, [id, k]) => sum + k * getSceneTraits(id).buildFit, 0) / total
    return { tally, total, meanBuildFit }
  }

  it('from a groove-level passage on a calm scene it lands on a fast build scene, never the one showing', () => {
    resetSeed()
    const r = tallyOf((beat) => {
      const { scene } = buildSwitchPick({ current: 'chrome', beat })
      expect(scene).not.toBeNull()
      expect(scene!.id).not.toBe('chrome')
      return scene
    })
    expect(r.meanBuildFit).toBeGreaterThan(0.6)
    // 4D Beats is among the scenes a build gets (about one pick in six here) and no calm scene is.
    expect(r.tally.get('beats') ?? 0).toBeGreaterThan(20)
    for (const calm of ['snowflake', 'hold', 'chrome']) expect(r.tally.get(calm) ?? 0, calm).toBe(0)
  })

  it('the lift, not the boost, does the work: a boost alone cannot reach a fast scene from a calm point', () => {
    const calm = character() // serene: arousal .12, tension .1
    const look = buildLook()
    resetSeed()
    const boostOnly = tallyOf((beat) =>
      pickByCharacter(getCharacterCandidates(), {
        character: calm,
        key: 'C',
        now: 100,
        recentIds: [],
        exclude: ['snowflake'],
        boost: (s) => sceneBoost(s, look, 'build'),
        rng: buildSwitchRng(beat, 0),
      }),
    )
    resetSeed()
    const lifted = tallyOf((beat) => buildSwitchPick({ current: 'snowflake', beat, cs: calm }).scene)
    const fast = (t: Map<string, number>) =>
      [...t.entries()].filter(([id]) => getSceneTraits(id).buildFit >= 0.7).reduce((a, [, n]) => a + n, 0)
    expect(fast(boostOnly.tally)).toBeLessThan(15) // under 5% of 300
    expect(fast(lifted.tally)).toBeGreaterThan(fast(boostOnly.tally) + 40)
    expect(lifted.meanBuildFit).toBeGreaterThan(boostOnly.meanBuildFit + 0.15)
  })

  it('the build boost adds to the lift: 4D Beats and the other fast scenes come up more often with it', () => {
    resetSeed()
    const withBoost = tallyOf((beat) => buildSwitchPick({ current: 'chrome', beat }).scene)
    // Same lift, no boost: ask the picker directly.
    resetSeed()
    const noBoost = tallyOf((beat) =>
      pickByCharacter(getCharacterCandidates(), {
        character: GROOVE,
        key: 'C',
        now: 100,
        recentIds: [],
        exclude: ['chrome'],
        minArousal: BUILD_SWITCH.minArousal,
        minTension: BUILD_SWITCH.minTension,
        liftSecondary: true,
        rng: buildSwitchRng(beat, 0),
      }),
    )
    expect(withBoost.meanBuildFit).toBeGreaterThan(noBoost.meanBuildFit)
    expect(withBoost.tally.get('beats') ?? 0).toBeGreaterThan(noBoost.tally.get('beats') ?? 0)
  })

  it('copes when 4D Beats cannot be held: a refused id is excluded and another fast scene is requested', () => {
    pickByCharacter(getCharacterCandidates(), { character: character({ valid: false }), key: 'C', now: 100, recentIds: [] })
    let refusedOnce = 0
    for (let beat = 0; beat < 200; beat++) {
      const r = buildSwitchPick({ current: 'snowflake', beat, refuse: (id) => id === 'beats' })
      // Bounded: never more than the first pick plus maxRepicks, and beats is never the accepted scene.
      expect(r.requests.length).toBeLessThanOrEqual(1 + BUILD_SWITCH.maxRepicks)
      expect(r.scene?.id).not.toBe('beats')
      // Once refused, it is never requested again in the same attempt.
      expect(r.requests.filter((id) => id === 'beats').length).toBeLessThanOrEqual(1)
      if (r.requests.includes('beats')) {
        refusedOnce++
        expect(r.scene).not.toBeNull() // re-picked to something else
      }
    }
    expect(refusedOnce).toBeGreaterThan(0) // beats really is a favourite, so the refusal path was exercised
  })

  it('gives up cleanly (null, bounded requests) when every request is refused', () => {
    pickByCharacter(getCharacterCandidates(), { character: character({ valid: false }), key: 'C', now: 100, recentIds: [] })
    const r = buildSwitchPick({ current: 'snowflake', beat: 5, refuse: () => true })
    expect(r.scene).toBeNull()
    expect(r.requests.length).toBe(1 + BUILD_SWITCH.maxRepicks)
    expect(new Set(r.requests).size).toBe(r.requests.length) // each refused id excluded from the next pick
  })

  it('returns nothing (so AutoPilot does nothing) while the character read is not valid', () => {
    const r = buildSwitchPick({ current: 'snowflake', beat: 3, cs: character({ valid: false }) })
    expect(r).toEqual({ scene: null, requests: [] })
  })

  it('is deterministic: the same beat picks the same scene', () => {
    pickByCharacter(getCharacterCandidates(), { character: character({ valid: false }), key: 'C', now: 100, recentIds: [] })
    const a = buildSwitchPick({ current: 'snowflake', beat: 64 }).scene?.id
    const b = buildSwitchPick({ current: 'snowflake', beat: 64 }).scene?.id
    expect(a).toBeDefined()
    expect(a).toBe(b)
  })
})

/**
 * Source checks on the call sites, labelled as such (rendering AutoPilot needs a canvas, a store and a live audio
 * engine, none of which this suite should stand up to assert wiring). They pin the two rules the consumers must
 * keep: the look is used ONLY behind `sceneLookActive` (so a legacy / invalid profile behaves exactly as before),
 * and the mood-label fallback keeps its original boost.
 */
describe('call-site wiring (source checks)', () => {
  it('AutoPilot: every pickVariedMode call passes the gated look, and the look is gated by sceneLookActive', () => {
    const calls = AUTOPILOT_SRC.match(/pickVariedMode\([^)]*\)/g) ?? []
    expect(calls.length).toBe(4) // mode vary, build switch, drop pre-arm, main pick
    for (const c of calls) expect(c, c).toMatch(/,\s*sceneLook\)$/)
    expect(AUTOPILOT_SRC).toContain('sceneLookActive(performanceState.look) ? performanceState.look : undefined')
  })

  it('AutoPilot: the drop pre-arm and the drop pick use the drop flavour; the mood-label fallback keeps voiceBoost', () => {
    expect(AUTOPILOT_SRC).toMatch(/sceneBoost\(scene, sceneLook, 'drop'\)/)
    expect(AUTOPILOT_SRC).toMatch(/sceneBoost\(scene, sceneLook, dropEdge \? 'drop' : 'auto'\)/)
    expect(AUTOPILOT_SRC).toContain('pickVariedScene(candidates, target, s.recentSceneIds, voiceBoost,')
  })

  it('AutoPilot: the build switch is gated by the look, consumes the edge before the early returns, and is lifted', () => {
    expect(AUTOPILOT_SRC).toMatch(/sceneLook !== undefined &&\s*shouldSwitchOnBuild\(/)
    expect(AUTOPILOT_SRC.indexOf('observeBuild(buildState.current')).toBeLessThan(
      AUTOPILOT_SRC.indexOf("if (!s.autoPilot || s.status !== 'running' || f.silence) return"),
    )
    expect(AUTOPILOT_SRC).toContain('minArousal: BUILD_SWITCH.minArousal')
    expect(AUTOPILOT_SRC).toContain('minTension: BUILD_SWITCH.minTension')
    expect(AUTOPILOT_SRC).toContain("s.requestScene(scene.id, { auto: true, immediate: false })")
  })

  it('PerformanceDirector: the character pick gets sceneBoost only behind sceneLookActive; the fallback keeps bandBoost', () => {
    expect(DIRECTOR_SRC).toMatch(/sceneLookActive\(look\)\s*\?[\s\S]*?bandBoost\(scene\) \* sceneBoost\(scene, look\)\s*:\s*bandBoost\b/)
    expect(DIRECTOR_SRC).toContain('boost: characterBoost,')
    expect(DIRECTOR_SRC).toContain('pickVariedScene(primaryCandidates, mood, s.recentSceneIds, bandBoost,')
  })
})
