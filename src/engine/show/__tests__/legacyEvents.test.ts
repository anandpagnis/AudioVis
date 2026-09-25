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
  it('maps the measured novelty percentiles into 0..1', () => {
    expect(sectionStrength(0.4)).toBe(0)
    expect(sectionStrength(0.45)).toBeCloseTo(0.0625)
    expect(sectionStrength(0.48)).toBeCloseTo(0.1) // p10
    expect(sectionStrength(0.64)).toBeCloseTo(0.3) // p50: a tweak, not a scene change
    expect(sectionStrength(1.11)).toBeCloseTo(0.8875) // p90: a real change
    expect(sectionStrength(1.2)).toBe(1)
    expect(sectionStrength(5)).toBe(1)
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

  it('a lone drop is less trusted than one with a build behind it', () => {
    const [lone] = frame(createLegacyEventState(), 60, { drop: true })
    expect(lone.type).toBe('drop')
    expect(lone.strength).toBe(LEGACY.dropStrength)
    expect(lone.confidence).toBe(LEGACY.dropConfidence)
    // a build running
    const running = createLegacyEventState()
    frame(running, 50, { structureValid: true, isSustain: true })
    expect(frame(running, 60, { drop: true, structureValid: true, isSustain: true })[0].confidence).toBe(
      LEGACY.dropBuildConfidence,
    )
    // a build that ended just before the drop still counts, a stale one does not
    const st = createLegacyEventState()
    frame(st, 50, { structureValid: true, isSustain: true })
    expect(frame(st, 55, { drop: true })[0].confidence).toBe(LEGACY.dropBuildConfidence)
    const old = createLegacyEventState()
    frame(old, 30, { structureValid: true, isSustain: true })
    expect(frame(old, 55, { drop: true })[0].confidence).toBe(LEGACY.dropConfidence)
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
  it('a drop and the analyser\'s drop boundary within 2 beats are ONE event: re-delivered with the same id, merged', () => {
    const st = createLegacyEventState()
    const first = frame(st, 100, { drop: true })
    expect(first).toHaveLength(1)
    const merged = frame(st, 101, {
      drop: true,
      structureValid: true,
      boundaryChanged: true,
      section: 'drop',
      previousSection: 'build',
      sectionConfidence: 0.6,
      beatsInSection: 1,
    })
    expect(merged).toHaveLength(1)
    expect(merged[0].id).toBe(first[0].id)
    expect(merged[0].type).toBe('drop')
    expect(merged[0].strength).toBe(1)
    expect(merged[0].corroborated).toBe(true)
    // confidence: the stronger of the two, lifted by the corroboration bonus, capped at 1
    expect(merged[0].confidence).toBeCloseTo(Math.min(1, LEGACY.dropConfidence + LEGACY.corroborationBonus))
    expect(merged[0].detectedAtBeat).toBe(100) // the first detection stays the detection
    expect(merged[0].boundaryBeat).toBe(100) // the earliest boundary
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
