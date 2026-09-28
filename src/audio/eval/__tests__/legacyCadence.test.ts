import { describe, expect, it } from 'vitest'
import { createEmptyTrace, packTrace, unpackTrace, type CadenceTrace } from '../cadenceTrace'
import { LEGACY, simulateLegacy, type LegacyOptions } from '../legacyCadence'
import ARMED_SRC from '../../../engine/armedChange.ts?raw'
import AUTOPILOT_SRC from '../../../engine/AutoPilot.tsx?raw'
import BUILD_SWITCH_SRC from '../../../engine/buildSwitch.ts?raw'
import CHARACTER_SHIFT_SRC from '../../../engine/characterShift.ts?raw'
import GATES_SRC from '../../../engine/autoPilotGates.ts?raw'
import DIRECTOR_SRC from '../../../engine/PerformanceDirector.tsx?raw'
import SCENE_MANAGER_SRC from '../../../engine/SceneManager.tsx?raw'
import STORE_SRC from '../../../store.ts?raw'

/**
 * `simulateLegacy` is a MODEL of the legacy trigger logic (see its header). These tests pin the properties the
 * baseline report rests on, on hand-made traces where every frame is known.
 */

const FPS = 60

interface MakeOpts {
  seconds: number
  bpm?: number
  /** Grid trusted (confidence 0.9) or not (0). */
  trusted?: boolean
  structureValid?: boolean
}

/** A steady 4/4 grid: `beat` on every beat crossing, beatIndex / beatInBar / bar stepping with it. */
function makeTrace(o: MakeOpts): CadenceTrace {
  const n = Math.round(o.seconds * FPS)
  const t = createEmptyTrace(n, FPS)
  const bpm = o.bpm ?? 120
  const framesPerBeat = Math.round((60 / bpm) * FPS)
  const c = t.cols
  let beatIndex = 0
  for (let i = 0; i < n; i++) {
    if (i > 0 && i % framesPerBeat === 0) {
      beatIndex++
      c.beat[i] = 1
    }
    c.beatIndex[i] = beatIndex
    c.beatInBar[i] = beatIndex % 4
    c.bar[i] = Math.floor(beatIndex / 4)
    c.bpm10[i] = bpm * 10
    c.confidence[i] = o.trusted === false ? 0 : 230
    c.structureValid[i] = o.structureValid ? 1 : 0
  }
  return t
}

const at = (beat: number, bpm = 120): number => Math.round(beat * (60 / bpm) * FPS)

/** A one-frame event in a 0/1 column. */
function pulse(t: CadenceTrace, col: 'sectionChange' | 'boundaryChanged' | 'moodChanged', frame: number): void {
  t.cols[col][frame] = 1
  if (col === 'sectionChange') t.cols.sectionChangeStrength[frame] = 100
}

function setRange(t: CadenceTrace, col: 'drop' | 'isSustain' | 'isBuild' | 'silence', from: number, to: number): void {
  for (let i = from; i < to; i++) t.cols[col][i] = 1
}

/** Options that isolate the trigger under test: no armed scene, no build one-shot, no character, no stale timer. */
const ISOLATED: LegacyOptions = { armed: false, buildSwitch: false, characterShift: false, staleSec: 1e9 }

describe('legacyCadence: the dwell', () => {
  it('a second request inside the 32-beat dwell is refused, and the edge is recorded as discarded', () => {
    const t = makeTrace({ seconds: 30, structureValid: true })
    pulse(t, 'sectionChange', at(8))
    pulse(t, 'sectionChange', at(12))
    pulse(t, 'sectionChange', at(40))
    const r = simulateLegacy(t, ISOLATED)
    expect(r.requests.map((q) => q.outcome)).toEqual(['accepted', 'refusedDwell', 'accepted'])
    expect(r.commits.map((c) => c.beat)).toEqual([8, 40])
    expect(r.edges.map((e) => e.outcome)).toEqual(['requested', 'dwell', 'requested'])
    expect(r.edges[1].inDwell).toBe(true)
    expect(r.edges[2].inDwell).toBe(false)
  })

  it('an edge during the dwell is lost: the scene changes at the next LEVEL-type trigger, not at the edge', () => {
    // No structure read -> the blind phrase fallback is live. Phrase edges are every 16 beats (from beat 16).
    const t = makeTrace({ seconds: 32, structureValid: false })
    pulse(t, 'sectionChange', at(24)) // a real change 8 beats after the first commit
    const r = simulateLegacy(t, ISOLATED)
    expect(r.commits.map((c) => c.beat)).toEqual([16, 48])
    expect(r.commits[0].trigger).toBe('phraseFallback')
    // The lost edge at beat 24 did NOT cause a change; the phrase timer did, at the first opportunity after the dwell.
    expect(r.commits[1].trigger).toBe('phraseFallback')
    expect(r.commits[1].kind).toBe('level')
    expect(r.edges).toHaveLength(1)
    expect(r.edges[0]).toMatchObject({ kind: 'sectionChange', beat: 24, inDwell: true, outcome: 'dwell' })
    // The fallback's own 16-beat spacing is measured from the discarded edge too (lastSwitchBeat is stamped on refusal).
    expect(r.requests.filter((q) => q.trigger === 'phraseFallback' && q.beat === 32)).toHaveLength(0)
  })

  it('first opportunity after the dwell: every accepted request lands at or after commit + 32 beats (random edges)', () => {
    for (let seed = 1; seed <= 25; seed++) {
      let a = seed * 7919
      const rnd = () => {
        a = (a * 1103515245 + 12345) & 0x7fffffff
        return a / 0x7fffffff
      }
      const t = makeTrace({ seconds: 90, structureValid: seed % 2 === 0 })
      for (let k = 0; k < 40; k++) pulse(t, 'sectionChange', Math.floor(rnd() * (t.n - 1)))
      const r = simulateLegacy(t, ISOLATED)
      for (const q of r.requests) {
        const lastCommit = [...r.commits].reverse().find((c) => c.frame < q.frame)
        const elapsed = lastCommit ? q.beat - lastCommit.beat : Infinity
        // requestScene refuses exactly when the dwell has not elapsed (no drops in this trace).
        expect(q.outcome === 'refusedDwell').toBe(elapsed < LEGACY.dwellBeats)
      }
      for (let k = 1; k < r.commits.length; k++) {
        expect(r.commits[k].beat - r.commits[k - 1].beat).toBeGreaterThanOrEqual(LEGACY.dwellBeats)
      }
    }
  })

  it('the dwell can be changed (option) and is counted from the last COMMIT, not the last request', () => {
    const t = makeTrace({ seconds: 20, structureValid: true })
    pulse(t, 'sectionChange', at(8))
    pulse(t, 'sectionChange', at(20))
    const r = simulateLegacy(t, { ...ISOLATED, dwellBeats: 8 })
    expect(r.commits.map((c) => c.beat)).toEqual([8, 20])
  })
})

describe('legacyCadence: drops bypass the dwell', () => {
  it('a drop inside the dwell requests immediately and commits on the same frame', () => {
    const t = makeTrace({ seconds: 20, structureValid: true })
    pulse(t, 'sectionChange', at(8))
    const dropFrame = at(10) + 7 // mid-beat, 2 beats after the first commit
    setRange(t, 'drop', dropFrame, dropFrame + 36)
    const r = simulateLegacy(t, ISOLATED)
    expect(r.commits).toHaveLength(2)
    expect(r.commits[1]).toMatchObject({ trigger: 'drop', immediate: true, frame: dropFrame, waitSec: 0 })
    expect(r.commits[1].beat - r.commits[0].beat).toBeLessThan(LEGACY.dwellBeats)
  })

  it('the drop path can be removed (sensitivity option): the same drop then changes nothing', () => {
    const t = makeTrace({ seconds: 20, structureValid: true })
    setRange(t, 'drop', at(10), at(10) + 36)
    expect(simulateLegacy(t, ISOLATED).commits).toHaveLength(1)
    expect(simulateLegacy(t, { ...ISOLATED, drops: false }).commits).toHaveLength(0)
  })

  it('a drop that lands while the armed scene is held cuts to it immediately', () => {
    const t = makeTrace({ seconds: 20, structureValid: true })
    const dropFrame = at(9) + 5
    setRange(t, 'drop', dropFrame, dropFrame + 36)
    const r = simulateLegacy(t, { buildSwitch: false, characterShift: false, staleSec: 1e9 })
    expect(r.arms).toBeGreaterThanOrEqual(1)
    expect(r.commits[0]).toMatchObject({ trigger: 'armed:drop', via: 'armed', immediate: true, frame: dropFrame })
  })
})

describe('legacyCadence: the phrase fallback only exists without a structure read', () => {
  it('structureValid=false: the 16-beat phrase timer changes scenes; structureValid=true: nothing does', () => {
    const blind = simulateLegacy(makeTrace({ seconds: 22, structureValid: false }), ISOLATED)
    expect(blind.commits.map((c) => [c.beat, c.trigger])).toEqual([[16, 'phraseFallback']])
    const sighted = simulateLegacy(makeTrace({ seconds: 22, structureValid: true }), ISOLATED)
    expect(sighted.commits).toHaveLength(0)
    expect(sighted.requests).toHaveLength(0)
  })

  it('the fallback respects the 16-beat spacing; sectionChange does not', () => {
    const t = makeTrace({ seconds: 20, structureValid: false })
    pulse(t, 'sectionChange', at(10)) // 6 beats before the first phrase edge
    const r = simulateLegacy(t, { ...ISOLATED, dwellBeats: 0 })
    // beat 10: sectionChange cuts at once (no spacing); the beat-16 phrase edge is 6 beats later: skipped by the
    // 16-beat spacing; the beat-32 phrase edge is 22 beats later: fires.
    expect(r.requests.map((q) => [q.beat, q.trigger])).toEqual([
      [10, 'sectionChange'],
      [32, 'phraseFallback'],
    ])
    expect(r.commits.map((c) => [c.beat, c.trigger])).toEqual([
      [12, 'sectionChange'],
      [32, 'phraseFallback'],
    ])
  })
})

describe('legacyCadence: the build hold', () => {
  it('a sectionChange during a confirmed build is held; a latched boundary is not; nothing is retried afterwards', () => {
    const t = makeTrace({ seconds: 30, structureValid: true })
    setRange(t, 'isSustain', at(8), at(24))
    setRange(t, 'isBuild', at(8), at(24))
    pulse(t, 'sectionChange', at(12))
    const held = simulateLegacy(t, ISOLATED)
    expect(held.commits).toHaveLength(0)
    expect(held.edges[0].outcome).toBe('buildHold')

    pulse(t, 'boundaryChanged', at(16))
    const latched = simulateLegacy(t, ISOLATED)
    expect(latched.commits.map((c) => c.trigger)).toEqual(['latchedBoundary'])
    // the sectionChange edge at beat 12 stayed lost
    expect(latched.edges.find((e) => e.kind === 'sectionChange')?.outcome).toBe('buildHold')
  })

  it('a mood change during the build stays latched and fires the frame the build releases', () => {
    const t = makeTrace({ seconds: 30, structureValid: true })
    setRange(t, 'isSustain', at(8), at(24))
    t.cols.moodChanged[at(10)] = 1
    t.cols.moodChangeCount.fill(1, at(10))
    t.cols.moodConfidence.fill(200)
    t.cols.moodAmbiguity.fill(50)
    const r = simulateLegacy(t, ISOLATED)
    expect(r.commits).toHaveLength(1)
    expect(r.commits[0]).toMatchObject({ trigger: 'mood', kind: 'latched', beat: 24 })
  })

  it('the build one-shot fires once on the rising edge of a confirmed build', () => {
    const t = makeTrace({ seconds: 30, structureValid: true })
    setRange(t, 'isSustain', at(8), at(20))
    t.cols.beatsTillDrop10.fill(-10)
    const r = simulateLegacy(t, { ...ISOLATED, buildSwitch: true })
    expect(r.commits.map((c) => [c.trigger, c.beat])).toEqual([['buildSwitch', 8]])
    // ...and is off when not assumed
    expect(simulateLegacy(t, ISOLATED).commits).toHaveLength(0)
  })
})

describe('legacyCadence: the other triggers', () => {
  it('the 25 s stale timer fires at 25 s and waits for the next downbeat', () => {
    const t = makeTrace({ seconds: 30, structureValid: true })
    const r = simulateLegacy(t, { armed: false, buildSwitch: false, characterShift: false })
    expect(r.requests).toHaveLength(1)
    expect(r.requests[0]).toMatchObject({ trigger: 'stale', kind: 'level', frame: 25 * FPS })
    // frame 1500 is beat 50 (beatInBar 2): the commit waits for beat 52.
    expect(r.commits[0]).toMatchObject({ trigger: 'stale', beat: 52 })
  })

  it('a committed mood change needs confidence >= 0.5 and ambiguity <= 0.6, then fires when they clear (latched)', () => {
    const t = makeTrace({ seconds: 20, structureValid: true })
    t.cols.moodChanged[at(4)] = 1
    t.cols.moodChangeCount.fill(1, at(4))
    t.cols.moodConfidence.fill(100) // 0.39: too low
    t.cols.moodAmbiguity.fill(50)
    t.cols.moodConfidence.fill(200, at(10)) // clears at beat 10
    const r = simulateLegacy(t, ISOLATED)
    expect(r.requests).toHaveLength(1)
    expect(r.requests[0]).toMatchObject({ trigger: 'mood', kind: 'latched', beat: 10 })
    expect(r.commits[0].beat).toBe(12) // next downbeat
  })

  it('a character shift triggers after the 12 s gap, once', () => {
    const t = makeTrace({ seconds: 30, structureValid: true })
    t.cols.charPrimary.fill(3)
    t.cols.charPrimary.fill(5, 15 * FPS)
    const r = simulateLegacy(t, { armed: false, buildSwitch: false, staleSec: 1e9 })
    expect(r.requests).toHaveLength(1)
    expect(r.requests[0]).toMatchObject({ trigger: 'character', kind: 'latched', frame: 15 * FPS })
    expect(simulateLegacy(t, { armed: false, buildSwitch: false, characterShift: false, staleSec: 1e9 }).requests).toHaveLength(0)
  })
})

describe('legacyCadence: SceneManager commit alignment', () => {
  it('a request mid-bar waits for the next downbeat', () => {
    const t = makeTrace({ seconds: 12, structureValid: true })
    const f = at(9) + 5
    pulse(t, 'sectionChange', f)
    const r = simulateLegacy(t, ISOLATED)
    expect(r.commits[0].beat).toBe(12)
    expect(r.commits[0].waitSec).toBeCloseTo((at(12) - f) / FPS, 5)
  })

  it('an untrusted grid commits on the request frame', () => {
    const t = makeTrace({ seconds: 12, structureValid: true, trusted: false })
    const f = at(9) + 5
    pulse(t, 'sectionChange', f)
    const r = simulateLegacy(t, ISOLATED)
    expect(r.commits[0]).toMatchObject({ frame: f, waitSec: 0 })
    // ...unless the sensitivity option forces the downbeat wait
    expect(simulateLegacy(t, { ...ISOLATED, gridTrust: 'always' }).commits[0].beat).toBe(12)
  })

  it('the 2.5 s backstop commits when the next downbeat is further away (slow tempo)', () => {
    const t = makeTrace({ seconds: 16, bpm: 60, structureValid: true })
    const f = at(1, 60) + 5 // beatInBar 1: the downbeat is 3 s away
    pulse(t, 'sectionChange', f)
    const r = simulateLegacy(t, ISOLATED)
    expect(r.commits[0].frame - f).toBe(151)
    expect(r.commits[0].waitSec).toBeGreaterThan(2.5)
  })
})

describe('legacyCadence: the armed scene', () => {
  const ARMED: LegacyOptions = { buildSwitch: false, characterShift: false, staleSec: 1e9 }

  it('is armed at once, and a latched section boundary releases it (armed:section, next downbeat)', () => {
    const t = makeTrace({ seconds: 20, structureValid: true })
    pulse(t, 'boundaryChanged', at(10))
    const r = simulateLegacy(t, ARMED)
    expect(r.arms).toBeGreaterThanOrEqual(1)
    expect(r.commits[0]).toMatchObject({ trigger: 'armed:section', via: 'armed', kind: 'event', beat: 12 })
  })

  it('a director boundary releases the armed scene instead of picking cold', () => {
    const t = makeTrace({ seconds: 20, structureValid: true })
    pulse(t, 'sectionChange', at(10)) // weak: below the armed scene's own phrase threshold? strength 1.0 -> strong
    t.cols.sectionChangeStrength[at(10)] = 50 // 0.5: below phraseMinStrength 0.6, so only PerformanceDirector reacts
    const r = simulateLegacy(t, ARMED)
    expect(r.commits[0]).toMatchObject({ trigger: 'sectionChange', via: 'armed' })
  })

  it('the age trigger changes the scene at a phrase edge once it has run 48 beats: level-type', () => {
    const t = makeTrace({ seconds: 45, structureValid: true })
    const r = simulateLegacy(t, ARMED)
    expect(r.commits.map((c) => [c.trigger, c.beat, c.kind])).toEqual([
      ['armed:age', 16, 'level'],
      ['armed:age', 64, 'level'],
    ])
  })

  it('confirm triggers are dwell-gated: a section edge inside the dwell does nothing', () => {
    const t = makeTrace({ seconds: 30, structureValid: true })
    pulse(t, 'boundaryChanged', at(8))
    pulse(t, 'boundaryChanged', at(14)) // 6 beats after the first commit: dwell not elapsed
    const r = simulateLegacy(t, ARMED)
    expect(r.commits).toHaveLength(1)
    expect(r.edges.map((e) => e.outcome)).toEqual(['armedConfirm', 'dwell'])
  })
})

describe('legacyCadence: determinism and the cache round trip', () => {
  it('the same trace and options give the same result, before and after pack/unpack', () => {
    const t = makeTrace({ seconds: 60, structureValid: false })
    for (let k = 1; k < 8; k++) pulse(t, 'sectionChange', at(5 + k * 9) + k)
    setRange(t, 'drop', at(30), at(30) + 20)
    const a = simulateLegacy(t)
    const b = simulateLegacy(t)
    const c = simulateLegacy(unpackTrace(JSON.parse(JSON.stringify(packTrace(t)))))
    expect(b).toEqual(a)
    expect(c).toEqual(a)
    expect(a.commits.length).toBeGreaterThan(0)
  })
})

describe('legacyCadence: frozen constants match the legacy source while it exists', () => {
  const num = (src: string, re: RegExp): number => {
    const m = re.exec(src)
    if (!m) throw new Error(`pattern not found: ${re} (the legacy trigger blocks moved: update LEGACY in legacyCadence.ts if the change is intentional)`)
    return Number(m[1])
  }

  it('store / director / autopilot constants', () => {
    expect(num(STORE_SRC, /export const MIN_SUBJECT_DWELL_BEATS\s*=\s*([\d.]+)/)).toBe(LEGACY.dwellBeats)
    expect(num(AUTOPILOT_SRC, /const STALE_TARGET_SEC\s*=\s*([\d.]+)/)).toBe(LEGACY.staleSec)
    expect(num(DIRECTOR_SRC, /const PHRASE_HOLD_BEATS\s*=\s*([\d.]+)/)).toBe(LEGACY.phraseHoldBeats)
    expect(num(GATES_SRC, /MOOD_CHANGE_MIN_CONFIDENCE\s*=\s*([\d.]+)/)).toBe(LEGACY.moodChangeMinConfidence)
    expect(num(GATES_SRC, /MOOD_CHANGE_MAX_AMBIGUITY\s*=\s*([\d.]+)/)).toBe(LEGACY.moodChangeMaxAmbiguity)
    expect(num(GATES_SRC, /MOOD_PREDICT_MIN_CONFIDENCE\s*=\s*([\d.]+)/)).toBe(LEGACY.moodPredictMinConfidence)
    expect(num(CHARACTER_SHIFT_SRC, /CHARACTER_SHIFT_MIN_GAP_SEC\s*=\s*([\d.]+)/)).toBe(LEGACY.characterShiftMinGapSec)
    expect(num(BUILD_SWITCH_SRC, /minBeatsTillDrop:\s*([\d.]+)/)).toBe(LEGACY.buildMinBeatsTillDrop)
    expect(num(AUTOPILOT_SRC, /f\.beatIndex - preArmBeat\.current > ([\d.]+)/)).toBe(LEGACY.preArmAbandonBeats)
    expect(num(SCENE_MANAGER_SRC, /waited > ([\d.]+)/)).toBe(LEGACY.commitBackstopSec)
    expect(num(SCENE_MANAGER_SRC, /f\.confidence > ([\d.]+) && !f\.silence/)).toBe(LEGACY.gridTrustConfidence)
  })

  it('the armed scene ARM table', () => {
    for (const [key, value] of Object.entries(LEGACY.ARM)) {
      expect(num(ARMED_SRC, new RegExp(`\\b${key}:\\s*([\\d.]+)`)), key).toBe(value)
    }
  })
})
