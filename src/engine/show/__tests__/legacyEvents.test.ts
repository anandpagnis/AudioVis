import { describe, expect, it } from 'vitest'
import {
  LEGACY,
  createLegacyEventState,
  sectionStrength,
  stepLegacyEvents,
  type LegacyInput,
} from '../../../audio/events/legacyEvents'
import type { SectionEvent } from '../../../audio/events/types'

const QUIET: LegacyInput = {
  time: 0,
  beat: 0,
  bpm: 120,
  sectionChange: false,
  sectionChangeStrength: 0,
  drop: false,
  buildUp: false,
  structureValid: false,
  boundaryChanged: false,
  section: '',
  previousSection: '',
  sectionConfidence: 0,
  beatsInSection: 0,
  isSustain: false,
}

/** Step one frame and return the events delivered (0 or 1). `beat` also sets `time` at 120 BPM. */
function frame(st: ReturnType<typeof createLegacyEventState>, beat: number, over: Partial<LegacyInput> = {}): SectionEvent[] {
  const out: SectionEvent[] = []
  stepLegacyEvents(st, { ...QUIET, beat, time: beat * 0.5, ...over }, out)
  return out
}

describe('sectionStrength', () => {
  // Re-anchored on the 98 real tracks (1362 sectionChange edges): p10 0.47, p50 0.58, p90 0.89, p99 1.46. The first
  // mapping (0.40..1.20) had been fitted to an earlier sample (p50 0.64, p90 1.11) and put the real p90 at 0.61.
  it('maps the measured novelty percentiles of the real tracks into 0..1: median a tweak, p90 a real change', () => {
    expect(sectionStrength(0.425)).toBe(0)
    expect(sectionStrength(0.4)).toBe(0)
    expect(sectionStrength(0.45)).toBeCloseTo(0.0485, 3) // the firing floor
    expect(sectionStrength(0.47)).toBeCloseTo(0.087, 2) // p10
    expect(sectionStrength(0.58)).toBeCloseTo(0.301, 2) // p50: a tweak, not a scene change
    expect(sectionStrength(0.89)).toBeCloseTo(0.903, 2) // p90: a real change
    expect(sectionStrength(0.94)).toBe(1)
    expect(sectionStrength(1.46)).toBe(1) // p99
    expect(sectionStrength(5)).toBe(1)
  })

  it('most edges are noise-like: the median edge scores below the MICRO floor and the p75 below any early threshold', () => {
    const S = (novelty: number) => sectionStrength(novelty) * LEGACY.sectionConfidence // x the change weight 1.0
    expect(S(0.58)).toBeLessThan(0.3) // p50
    expect(S(0.71)).toBeLessThan(0.6) // p75: waits for a scene of ~8 bars
    expect(S(0.89)).toBeGreaterThan(0.8) // p90: a strong change
  })

  it('is total: non-finite and negative read as 0', () => {
    expect(sectionStrength(NaN)).toBe(0)
    expect(sectionStrength(-Infinity)).toBe(0)
    expect(sectionStrength(-3)).toBe(0)
  })
})

describe('legacy -> SectionEvent mapping', () => {
  it('a quiet frame delivers nothing (and allocates no event)', () => {
    expect(frame(createLegacyEventState(), 10)).toEqual([])
  })

  it('f.sectionChange -> a `change` with strength from the novelty and the documented constant confidence', () => {
    const [e, ...rest] = frame(createLegacyEventState(), 40, { sectionChange: true, sectionChangeStrength: 0.8 })
    expect(rest).toHaveLength(0)
    expect(e.type).toBe('change')
    expect(e.source).toBe('legacy')
    expect(e.strength).toBeCloseTo(sectionStrength(0.8))
    expect(e.confidence).toBe(LEGACY.sectionConfidence)
    expect(e.boundaryBeat).toBe(40)
    expect(e.detectedAtBeat).toBe(40)
    expect(e.boundaryTime).toBeCloseTo(20)
    expect(e.phase).toBe(0)
    expect(e.feats).toEqual({ level: 0, low: 0, timbre: 0, harmony: 0, rhythm: 0 }) // no per-channel evidence yet
    expect(e.corroborated).toBe(false)
  })

  it('a section-change flag whose novelty is below the mapping floor is not an event', () => {
    expect(frame(createLegacyEventState(), 40, { sectionChange: true, sectionChangeStrength: 0.3 })).toEqual([])
    expect(frame(createLegacyEventState(), 40, { sectionChange: true, sectionChangeStrength: NaN })).toEqual([])
  })

  it('songSection.boundaryChanged -> change / breakdown / drop / buildStart by the section committed', () => {
    const type = (section: string, previousSection = 'section') => {
      const [e] = frame(createLegacyEventState(), 100, {
        structureValid: true,
        boundaryChanged: true,
        section,
        previousSection,
        sectionConfidence: 0.75,
        beatsInSection: 4,
      })
      return e
    }
    const change = type('section')
    expect(change.type).toBe('change')
    expect(change.strength).toBe(LEGACY.boundaryChange)
    expect(change.confidence).toBeCloseTo(0.75) // the tracker's own sectionConfidence
    expect(change.boundaryBeat).toBe(96) // recovered: beat - beatsInSection
    expect(type('intro').type).toBe('change')
    expect(type('outro').type).toBe('change')
    expect(type('breakdown').type).toBe('breakdown')
    expect(type('drop').type).toBe('drop')
    expect(type('build').type).toBe('buildStart') // a riser beginning is not a scene change
  })

  it('ignores the boundary without a valid structure read, and the post-drop settle', () => {
    expect(frame(createLegacyEventState(), 100, { boundaryChanged: true, section: 'section', sectionConfidence: 0.9 })).toEqual([])
    expect(
      frame(createLegacyEventState(), 100, {
        structureValid: true,
        boundaryChanged: true,
        section: 'section',
        previousSection: 'drop',
        sectionConfidence: 0.9,
      }),
    ).toEqual([])
  })

  it('bounds the recovered boundary beat (a wild beatsInSection cannot date it far into the past)', () => {
    const [e] = frame(createLegacyEventState(), 500, {
      structureValid: true,
      boundaryChanged: true,
      section: 'section',
      sectionConfidence: 0.6,
      beatsInSection: 400,
    })
    expect(e.boundaryBeat).toBe(484)
    const [n] = frame(createLegacyEventState(), 500, {
      structureValid: true,
      boundaryChanged: true,
      section: 'section',
      sectionConfidence: 0.6,
      beatsInSection: NaN,
    })
    expect(n.boundaryBeat).toBe(500)
  })

  it('f.drop -> ONE drop event on the rising edge only', () => {
    const st = createLegacyEventState()
    expect(frame(st, 60, { drop: true })).toHaveLength(1)
    for (let b = 61; b < 70; b++) expect(frame(st, b, { drop: true })).toHaveLength(0) // the 0.6 s latch is a level
    expect(frame(st, 70, { drop: false })).toHaveLength(0)
    expect(frame(st, 80, { drop: true })).toHaveLength(1) // a new drop is a new edge
  })

  it('a lone drop is far less trusted than one with a build behind it (graded by the evidence: lone < mid < release)', () => {
    const [lone] = frame(createLegacyEventState(), 60, { drop: true })
    expect(lone.type).toBe('drop')
    expect(lone.strength).toBe(LEGACY.dropStrength)
    expect(lone.confidence).toBe(LEGACY.dropConfidence)
    // Changed with the false-drop lane: a lone drop's S = 1.25 * 0.35 = 0.44 (was 0.875). It can no longer reach the
    // director's fast lane (S >= 1.0) or clear the age threshold before the scene is ~10 bars old.
    expect(1.25 * lone.strength * lone.confidence).toBeLessThan(0.5)
    expect(LEGACY.dropConfidence).toBeLessThan(LEGACY.dropMidConfidence)
    expect(LEGACY.dropMidConfidence).toBeLessThan(LEGACY.dropBuildConfidence)
    // a build running
    const running = createLegacyEventState()
    frame(running, 50, { structureValid: true, isSustain: true })
    expect(frame(running, 60, { drop: true, structureValid: true, isSustain: true })[0].confidence).toBe(
      LEGACY.dropBuildConfidence,
    )
    // a build that ended within 4 bars of the drop still counts (a release)...
    const st = createLegacyEventState()
    frame(st, 50, { structureValid: true, isSustain: true })
    expect(frame(st, 55, { drop: true })[0].confidence).toBe(LEGACY.dropBuildConfidence)
    const edge = createLegacyEventState()
    frame(edge, 50, { structureValid: true, isSustain: true })
    expect(frame(edge, 50 + LEGACY.buildLookbackBeats, { drop: true })[0].confidence).toBe(LEGACY.dropBuildConfidence)
    // ...one that ended within 32 bars is the middle tier, an older one (or none) leaves the drop lone
    const mid = createLegacyEventState()
    frame(mid, 30, { structureValid: true, isSustain: true })
    expect(frame(mid, 55, { drop: true })[0].confidence).toBe(LEGACY.dropMidConfidence)
    const old = createLegacyEventState()
    frame(old, 30, { structureValid: true, isSustain: true })
    expect(frame(old, 30 + LEGACY.buildMemoryBeats + 4, { drop: true })[0].confidence).toBe(LEGACY.dropConfidence)
  })

  it('a drop right after a breakdown (the bass return) is a release; without the flag the drop is graded on builds alone', () => {
    const st = createLegacyEventState()
    frame(st, 50, { structureValid: true, inBreakdown: true })
    expect(frame(st, 58, { drop: true })[0].confidence).toBe(LEGACY.dropReleaseConfidence)
    expect(1.25 * LEGACY.dropStrength * LEGACY.dropReleaseConfidence).toBeGreaterThanOrEqual(1) // the fast lane
    const old = createLegacyEventState()
    frame(old, 50, { structureValid: true, inBreakdown: true })
    expect(frame(old, 50 + LEGACY.buildLookbackBeats + 2, { drop: true })[0].confidence).toBe(LEGACY.dropConfidence)
    // (an adapter that does not pass the optional flag simply gets the lone grade)
    expect(frame(createLegacyEventState(), 58, { drop: true })[0].confidence).toBe(LEGACY.dropConfidence)
  })

  it('the rising edge of a confirmed build (or the fast buildUp flag) -> a buildStart, once per build', () => {
    const st = createLegacyEventState()
    const start = frame(st, 20, { structureValid: true, isSustain: true })
    expect(start).toHaveLength(1)
    expect(start[0].type).toBe('buildStart')
    for (let b = 21; b < 40; b++) expect(frame(st, b, { structureValid: true, isSustain: true })).toHaveLength(0)
    expect(frame(st, 41, { structureValid: true, isSustain: false })).toHaveLength(0)
    expect(frame(st, 50, { buildUp: true })).toHaveLength(1)
    // an unvalidated structure read does not count as a confirmed build
    expect(frame(createLegacyEventState(), 5, { isSustain: true })).toHaveLength(0)
  })

  it('ids increase, one per physical change', () => {
    const st = createLegacyEventState()
    const a = frame(st, 40, { sectionChange: true, sectionChangeStrength: 1 })[0]
    const b = frame(st, 80, { sectionChange: true, sectionChangeStrength: 1 })[0]
    expect(b.id).toBeGreaterThan(a.id)
  })
})

describe('legacy events: no double counting', () => {
  it('a drop and the tracker\'s drop boundary are ONE event, and the boundary is an ECHO, not a corroboration', () => {
    // SectionTracker commits its drop section from the very same f.drop edge (same frame): on the real tracks that
    // echo appeared on 571 of 1505 drop edges and used to lift a lone drop into the director's fast lane.
    const boundary = {
      structureValid: true,
      boundaryChanged: true,
      section: 'drop',
      previousSection: 'section',
      sectionConfidence: 0.9,
      beatsInSection: 1,
    }
    // (a) on the same frame as the edge
    const same = frame(createLegacyEventState(), 100, { drop: true, ...boundary })
    expect(same).toHaveLength(1)
    expect(same[0].type).toBe('drop')
    expect(same[0].corroborated).toBe(false)
    expect(same[0].confidence).toBe(LEGACY.dropConfidence) // not the tracker's 0.9, no +0.1
    // (b) a frame or two later: the open drop event is not re-delivered, amended or corroborated
    const st = createLegacyEventState()
    const first = frame(st, 100, { drop: true })
    expect(first).toHaveLength(1)
    expect(frame(st, 101, { drop: true, ...boundary })).toHaveLength(0)
    expect(frame(st, 102, { drop: true, ...boundary })).toHaveLength(0)
    // (c) the old behaviour is still one switch away (this is what the "before" replay uses)
    const legacyConstants = LEGACY as unknown as { echoCorroborates: boolean }
    legacyConstants.echoCorroborates = true
    try {
      const st2 = createLegacyEventState()
      const a = frame(st2, 100, { drop: true })
      const merged = frame(st2, 101, { drop: true, ...boundary })
      expect(merged).toHaveLength(1)
      expect(merged[0].id).toBe(a[0].id)
      expect(merged[0].corroborated).toBe(true)
      expect(merged[0].confidence).toBeCloseTo(Math.min(1, 0.9 + LEGACY.corroborationBonus))
    } finally {
      legacyConstants.echoCorroborates = false
    }
  })

  it('a drop boundary with no edge of its own (the tracker resolving a build at an analyser boundary) is a real, build-backed drop', () => {
    const [e] = frame(createLegacyEventState(), 100, {
      structureValid: true,
      boundaryChanged: true,
      section: 'drop',
      previousSection: 'build',
      sectionConfidence: 0.6,
      beatsInSection: 2,
    })
    expect(e.type).toBe('drop')
    expect(e.strength).toBe(LEGACY.boundaryDrop)
    expect(e.confidence).toBe(LEGACY.dropBuildConfidence) // max(section confidence, build confidence)
    expect(e.boundaryBeat).toBe(98)
  })

  it('a section change beside a drop still corroborates it (a real second detector), lifting a lone drop by +0.1 only', () => {
    const st = createLegacyEventState()
    const first = frame(st, 100, { drop: true })[0]
    const merged = frame(st, 101, { sectionChange: true, sectionChangeStrength: 0.7 })[0]
    expect(merged.id).toBe(first.id)
    expect(merged.corroborated).toBe(true)
    expect(merged.confidence).toBeCloseTo(LEGACY.dropConfidence + LEGACY.corroborationBonus)
    expect(1.25 * merged.strength * merged.confidence).toBeLessThan(1) // still not the fast lane
  })

  it('keeps the strongest strength and the dominant type whichever signal came first', () => {
    const st = createLegacyEventState()
    const a = frame(st, 40, { sectionChange: true, sectionChangeStrength: 0.7 })[0]
    const b = frame(st, 41, { drop: true })[0]
    expect(b.id).toBe(a.id)
    expect(b.type).toBe('drop') // drop > change
    expect(b.strength).toBe(1) // max(change 0.375, drop 1)
    const st2 = createLegacyEventState()
    const d = frame(st2, 40, { drop: true })[0]
    const c = frame(st2, 42, { sectionChange: true, sectionChangeStrength: 0.7 })[0]
    expect(c.id).toBe(d.id)
    expect(c.type).toBe('drop') // stays a drop
    expect(c.strength).toBe(1)
  })

  it('two signals on the SAME frame deliver a single event', () => {
    const st = createLegacyEventState()
    const out = frame(st, 40, {
      sectionChange: true,
      sectionChangeStrength: 0.9,
      structureValid: true,
      boundaryChanged: true,
      section: 'section',
      sectionConfidence: 0.75,
    })
    expect(out).toHaveLength(1)
    expect(out[0].corroborated).toBe(true)
    expect(out[0].strength).toBeCloseTo(Math.max(sectionStrength(0.9), LEGACY.boundaryChange))
  })

  it('signals more than 2 beats apart are separate events', () => {
    const st = createLegacyEventState()
    const a = frame(st, 40, { drop: true })[0]
    const b = frame(st, 43, { sectionChange: true, sectionChangeStrength: 1 })[0]
    expect(b.id).not.toBe(a.id)
    expect(b.type).toBe('change')
    expect(b.corroborated).toBe(false)
  })

  it('a build start does not swallow a nearby change, but is folded into it', () => {
    const st = createLegacyEventState()
    const a = frame(st, 40, { structureValid: true, isSustain: true })[0]
    expect(a.type).toBe('buildStart')
    const b = frame(st, 41, { sectionChange: true, sectionChangeStrength: 1.2 })[0]
    expect(b.id).toBe(a.id)
    expect(b.type).toBe('change')
    expect(b.strength).toBe(1)
  })

  it('caps the merged confidence at 1', () => {
    const st = createLegacyEventState()
    frame(st, 40, { sectionChange: true, sectionChangeStrength: 1 })
    expect(frame(st, 41, { drop: true, structureValid: true, isSustain: true })[0].confidence).toBe(1)
  })
})

describe('legacy events: robustness', () => {
  it('a new source (the beat counter restarts) forgets the open event and the edge state', () => {
    const st = createLegacyEventState()
    const a = frame(st, 500, { drop: true })[0]
    // the new track: beat 0, drop flag high again -> a fresh edge, a fresh id, NOT merged into the old event
    const b = frame(st, 0, { drop: true })[0]
    expect(b).toBeDefined()
    expect(b.id).not.toBe(a.id)
    expect(b.corroborated).toBe(false)
    expect(b.detectedAtBeat).toBe(0)
  })

  it('never throws and never delivers a non-finite field, whatever the inputs hold', () => {
    const st = createLegacyEventState()
    const nan = NaN
    const cases: Partial<LegacyInput>[] = [
      { beat: nan, time: nan, bpm: nan, drop: true },
      { sectionChange: true, sectionChangeStrength: Infinity, bpm: 0 },
      { structureValid: true, boundaryChanged: true, section: 'drop', sectionConfidence: nan, beatsInSection: -Infinity, bpm: -5 },
      { structureValid: true, boundaryChanged: true, section: 'breakdown', sectionConfidence: Infinity, beatsInSection: Infinity },
      { buildUp: true, structureValid: true, isSustain: true, bpm: Infinity, time: Infinity },
    ]
    let delivered = 0
    for (let k = 0; k < cases.length; k++) {
      const out: SectionEvent[] = []
      stepLegacyEvents(st, { ...QUIET, beat: 100 + k * 10, time: 50 + k * 5, ...cases[k] }, out)
      for (const e of out) {
        delivered++
        for (const v of [e.strength, e.confidence, e.boundaryBeat, e.boundaryTime, e.detectedAtBeat, e.detectedAtTime, e.phase]) {
          expect(Number.isFinite(v), JSON.stringify(e)).toBe(true)
        }
        expect(e.strength).toBeGreaterThanOrEqual(0)
        expect(e.strength).toBeLessThanOrEqual(1)
        expect(e.confidence).toBeGreaterThanOrEqual(0)
        expect(e.confidence).toBeLessThanOrEqual(1)
      }
    }
    expect(delivered).toBeGreaterThan(0)
  })

  it('every event carries the plan\'s SectionEvent shape', () => {
    const [e] = frame(createLegacyEventState(), 12, { drop: true })
    expect(Object.keys(e).sort()).toEqual(
      [
        'boundaryBeat',
        'boundaryTime',
        'confidence',
        'corroborated',
        'detectedAtBeat',
        'detectedAtTime',
        'feats',
        'id',
        'phase',
        'source',
        'strength',
        'type',
      ].sort(),
    )
    expect(Object.keys(e.feats).sort()).toEqual(['harmony', 'level', 'low', 'rhythm', 'timbre'])
  })
})
