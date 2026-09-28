import { describe, expect, it } from 'vitest'
import { STRUCTURE_LOG_EVENT_KINDS, StructureLog, formatStructureLogHud, type StructureLogFrame } from '../structureLog'

/**
 * The ADDITIVE hook of phase 2: `noteSectionEvent` records the `SectionEvent`s the show director was fed (or, in
 * `?events=legacy`, the v2 events as shadow records) with the director's S / T / decision, next to the taps and every
 * other detector edge, so a tap log can score v2.
 */
function makeLog(): StructureLog {
  let wall = 1000
  return new StructureLog({ now: () => (wall += 7), isoNow: () => '2026-05-06T07:08:09.123Z', userAgent: 'vitest' })
}

function frame(t: number): StructureLogFrame {
  const beat = Math.floor(t * 2)
  return {
    time: t,
    beatIndex: beat,
    beatInBar: beat % 4,
    beatProgress: (t * 2) % 1,
    bpm: 120,
    confidence: 0.8,
    tempoOctaves: 0,
    energy: 0.5,
    loudness: 0.4,
    lufsShortTerm: -14,
    silence: false,
    drop: false,
    buildUp: false,
    sectionChange: false,
    sectionChangeStrength: 0,
    downbeatLocked: false,
    downbeatConfidence: 0.1,
    structureValid: true,
    songSection: {
      section: 'section',
      previousSection: '',
      sectionConfidence: 0.6,
      beatsInSection: 8,
      boundaryChanged: false,
      changeCount: 0,
      isBuild: false,
      isDrop: false,
      isBreakdown: false,
      dropExpected: false,
      buildProgress: 0,
      beatsTillDrop: -1,
      repetitionLabel: '',
    },
    mood: { changed: false, state: 'groove', predictedState: 'groove', confidence: 0.7 },
    character: { primary: 'groove', confidence: 0.5, valence: 0.6, arousal: 0.7 },
  }
}

const EV = {
  id: 3,
  type: 'change',
  strength: 0.8123456,
  confidence: 0.91,
  boundaryBeat: 96,
  boundaryTime: 48.0004,
  detectedAtBeat: 102,
  detectedAtTime: 51.0,
  source: 'live',
  phase: 2,
}

describe('StructureLog.noteSectionEvent', () => {
  it('records type, calibrated strength/confidence, boundary vs detection (so the lag is in the log) and the director decision', () => {
    const log = makeLog()
    log.observe(frame(0), { sceneId: 'a', status: 'running', sourceType: 'file' })
    log.observe(frame(51), { sceneId: 'a', status: 'running', sourceType: 'file' })
    log.noteSectionEvent({ ...EV, sim: { boundaryBeat: 32, similarity: 0.9123 } }, { S: 0.6543, T: 0.4321, decision: 'CUT:event' })
    const j = log.toJSON()
    const evs = j.events.filter((e) => e.kind === 'sectionEvent')
    expect(evs).toHaveLength(1)
    const d = evs[0].data
    expect(d.type).toBe('change')
    expect(d.source).toBe('live')
    expect(d.strength).toBeCloseTo(0.812, 3)
    expect(d.boundaryBeat).toBe(96)
    expect(d.boundaryT).toBeCloseTo(48.0, 3)
    expect(d.detectedBeat).toBe(102)
    expect(d.lagBeats).toBe(6)
    expect(d.phase).toBe(2)
    expect(d.simBeat).toBe(32)
    expect(d.simSimilarity).toBeCloseTo(0.912, 3)
    expect(d.S).toBeCloseTo(0.654, 3)
    expect(d.T).toBeCloseTo(0.432, 3)
    expect(d.decision).toBe('CUT:event')
    expect(d.shadow).toBeUndefined()
    expect(j.counters.events.sectionEvent).toBe(1)
  })

  it('a shadow event (?events=legacy) is flagged and carries no decision', () => {
    const log = makeLog()
    log.observe(frame(0), { sceneId: 'a', status: 'running', sourceType: 'file' })
    log.noteSectionEvent({ ...EV, type: 'fill' }, { shadow: true })
    const d = log.toJSON().events.find((e) => e.kind === 'sectionEvent')!.data
    expect(d.shadow).toBe(true)
    expect(d.type).toBe('fill')
    expect(d.S).toBeUndefined()
    expect(d.decision).toBeUndefined()
  })

  it('is free when the log is disabled, and non-finite numbers never reach the file', () => {
    const off = new StructureLog({ enabled: false })
    off.noteSectionEvent(EV)
    expect(off.toJSON().events).toHaveLength(0)
    const log = makeLog()
    log.observe(frame(0), { sceneId: 'a', status: 'running', sourceType: 'file' })
    log.noteSectionEvent({ ...EV, strength: Number.NaN, boundaryTime: Number.POSITIVE_INFINITY, detectedAtBeat: Number.NaN }, { S: Number.NaN })
    const d = log.toJSON().events.find((e) => e.kind === 'sectionEvent')!.data
    for (const v of Object.values(d)) if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true)
  })

  it('the new kind is part of the schema and shown on the overlay counter line', () => {
    expect(STRUCTURE_LOG_EVENT_KINDS).toContain('sectionEvent')
    const log = makeLog()
    log.observe(frame(0), { sceneId: 'a', status: 'running', sourceType: 'file' })
    log.noteSectionEvent(EV)
    const lines = formatStructureLogHud(log.summary())
    expect(lines.some((l) => /\bev 1\b/.test(l))).toBe(true)
  })
})
