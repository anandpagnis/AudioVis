import { describe, expect, it } from 'vitest'
import {
  StructureLog,
  STRUCTURE_LOG_SCHEMA,
  STRUCTURE_LOG_VERSION,
  stringifyStructureLog,
  type StructureLogFrame,
} from '../../../engine/structureLog'
import {
  DEFAULT_LAG_COMPENSATION_SEC,
  HUMAN_LAG_CAVEAT,
  HUMAN_TAP_LAG_RANGE_SEC,
  detectorEventTimes,
  nearestBeat,
  parseStructureLog,
  snapMarkToBeat,
  structureLogToTruth,
  truthBoundaryBeats,
  truthBoundaryTimes,
} from '../structureLogToTruth'

/** A hand-written log: a 120 bpm grid (a beat every 0.5 s from t = 10) and three taps. */
function rawLog(over: Record<string, unknown> = {}): Record<string, unknown> {
  const beats: Array<[number, number]> = []
  for (let i = 0; i < 100; i++) beats.push([i, 10 + i * 0.5])
  return {
    schema: STRUCTURE_LOG_SCHEMA,
    version: STRUCTURE_LOG_VERSION,
    startedAtIso: '2026-05-06T07:08:09.123Z',
    source: 'file',
    trackHint: 'Song',
    firstT: 10,
    lastT: 60,
    durationSec: 50,
    bpmSummary: { start: 120, last: 120, min: 120, max: 120, mean: 120, median: 120, readings: 5 },
    marks: [
      { id: 1, t: 30.6, beat: 41, beatInBar: 1, beatProgress: 0.2, bpm: 120, wallMs: 1 },
      { id: 2, t: 20.55, beat: 21, beatInBar: 1, beatProgress: 0.1, bpm: 120, wallMs: 2 },
      { id: 3, t: 45.05, beat: 70, beatInBar: 2, beatProgress: 0.1, bpm: 120, wallMs: 3 },
    ],
    events: [
      { kind: 'sectionChange', t: 31, beat: 42, beatInBar: 2, wallMs: 4, data: { strength: 0.7 } },
      { kind: 'buildUp', t: 25, beat: 30, beatInBar: 2, wallMs: 5, data: { on: true } },
      { kind: 'buildUp', t: 28, beat: 36, beatInBar: 0, wallMs: 6, data: { on: false } },
      { kind: 'drop', t: 29, beat: 38, beatInBar: 2, wallMs: 7, data: {} },
    ],
    commits: [{ t: 32, beat: 44, to: 'b', from: 'a', trigger: 'unknown' }],
    samples: [{ t: 11, beat: 2, energy: 0.5, loudness: 0.4, lufs: -14, bpm: 120, confidence: 0.8 }],
    beats,
    counters: {},
    ...over,
  }
}

const r3 = (xs: number[]): number[] => xs.map((x) => Math.round(x * 1000) / 1000)

describe('lag compensation', () => {
  it('subtracts 0.5 s from every tap by default, and returns the marks in time order', () => {
    const truth = structureLogToTruth(rawLog(), { snap: false })
    expect(DEFAULT_LAG_COMPENSATION_SEC).toBe(0.5)
    expect(truth.lagCompensationSec).toBe(0.5)
    expect(truth.boundaries.map((b) => b.tapT)).toEqual([20.55, 30.6, 45.05])
    expect(r3(truth.boundaries.map((b) => b.t))).toEqual([20.05, 30.1, 44.55])
    expect(truth.boundaries.every((b) => !b.snapped)).toBe(true)
  })

  it('takes an explicit lag, including 0 for the raw taps', () => {
    expect(structureLogToTruth(rawLog(), { snap: false, lagCompensationSec: 0 }).boundaries.map((b) => b.t)).toEqual([
      20.55, 30.6, 45.05,
    ])
    expect(structureLogToTruth(rawLog(), { snap: false, lagCompensationSec: 1.2 }).boundaries[0].t).toBeCloseTo(19.35, 9)
  })

  it('never lets a mark precede the start of the recording (or 0)', () => {
    const early = rawLog({ marks: [{ id: 1, t: 10.2, beat: 0, beatProgress: 0.4, bpm: 120 }] })
    const b = structureLogToTruth(early, { snap: false }).boundaries[0]
    expect(b.t).toBe(10) // firstT
    expect(b.tRel).toBe(0)
    // a log that starts at audio time 0.1 and a tap at 0.3 s: floor is firstT, never below 0
    const atZero = rawLog({ firstT: 0, beats: [], marks: [{ id: 1, t: 0.3, beat: 0, beatProgress: 0.6, bpm: 120 }] })
    expect(structureLogToTruth(atZero, { snap: false, lagCompensationSec: 5 }).boundaries[0].t).toBe(0)
    const noFirst = rawLog({ firstT: null, marks: [{ id: 1, t: 0.3, beat: 0, beatProgress: 0.6, bpm: 120 }] })
    expect(structureLogToTruth(noFirst, { snap: false }).boundaries[0].t).toBe(0)
  })

  it('treats a negative lag as 0 and a non-finite lag as the default', () => {
    expect(structureLogToTruth(rawLog(), { snap: false, lagCompensationSec: -3 }).boundaries[0].t).toBe(20.55)
    expect(structureLogToTruth(rawLog(), { snap: false, lagCompensationSec: Number.NaN }).boundaries[0].t).toBeCloseTo(20.05, 9)
  })

  it('reports the reaction-lag caveat and the plausible range', () => {
    const truth = structureLogToTruth(rawLog())
    expect(truth.caveats).toContain(HUMAN_LAG_CAVEAT)
    expect(HUMAN_LAG_CAVEAT).toMatch(/0\.2-1\.5 s/)
    expect(HUMAN_TAP_LAG_RANGE_SEC).toEqual([0.2, 1.5])
  })
})

describe('snapping to the beat grid', () => {
  it('snaps the compensated time to the nearest recorded beat and reports the move', () => {
    const truth = structureLogToTruth(rawLog())
    const [a, b, c] = truth.boundaries
    // 20.05 -> beat 20 at 20.0
    expect(a).toMatchObject({ beat: 20, beatTime: 20, snapped: true })
    expect(a.snapDeltaSec).toBeCloseTo(-0.05, 9)
    // 30.1 -> beat 40 at 30.0
    expect(b).toMatchObject({ beat: 40, beatTime: 30 })
    // 44.55 -> beat 69 at 44.5
    expect(c).toMatchObject({ beat: 69, beatTime: 44.5 })
    expect(truthBoundaryBeats(truth)).toEqual([20, 40, 69])
    expect(truthBoundaryTimes(truth)).toEqual([20, 30, 44.5])
    expect(r3(truthBoundaryTimes(truth, false))).toEqual([20.05, 30.1, 44.55])
  })

  it('snapping depends on the lag: the same tap lands on a different beat with a longer lag', () => {
    const raw = structureLogToTruth(rawLog(), { lagCompensationSec: 0 })
    expect(raw.boundaries[1].beat).toBe(41) // 30.6 -> 30.5
    expect(structureLogToTruth(rawLog(), { lagCompensationSec: 1.0 }).boundaries[1].beat).toBe(39) // 29.6 -> 29.5
  })

  it('nearestBeat picks the closer neighbour, ties to the earlier, null on an empty grid', () => {
    const grid: Array<[number, number]> = [
      [0, 0],
      [1, 0.5],
      [2, 1.0],
    ]
    expect(nearestBeat(grid, 0.24)?.beat).toBe(0)
    expect(nearestBeat(grid, 0.26)?.beat).toBe(1)
    expect(nearestBeat(grid, 0.25)?.beat).toBe(0)
    expect(nearestBeat(grid, -5)?.beat).toBe(0)
    expect(nearestBeat(grid, 99)?.beat).toBe(2)
    expect(nearestBeat([], 1)).toBeNull()
    expect(nearestBeat(grid, Number.NaN)).toBeNull()
  })

  it('falls back to the tap-time bpm when the log recorded no beat grid', () => {
    const truth = structureLogToTruth(
      rawLog({ beats: [], marks: [{ id: 1, t: 10.6, beat: 21, beatInBar: 1, beatProgress: 0.2, bpm: 120 }] }),
    )
    const b = truth.boundaries[0]
    // compensated 10.1 -> 1 beat before the tap position 21.2 -> beat 20 at t = 10.0
    expect(b).toMatchObject({ beat: 20, snapped: true })
    expect(b.beatTime).toBeCloseTo(10.0, 9)
    expect(truth.caveats.some((c) => /No beat grid/.test(c))).toBe(true)
  })

  it('leaves a mark unsnapped (beat at the tap) when there is neither a grid nor a bpm', () => {
    const truth = structureLogToTruth(
      rawLog({ beats: [], marks: [{ id: 1, t: 10.6, beat: 21, beatProgress: 0.2, bpm: 0 }] }),
    )
    expect(truth.boundaries[0]).toMatchObject({ beat: 21, snapped: false, snapDeltaSec: 0 })
    expect(truth.boundaries[0].beatTime).toBeCloseTo(10.1, 9)
    expect(snapMarkToBeat({ t: 1, beat: 2, beatProgress: 0, bpm: Number.NaN }, 1, [])).toBeNull()
  })
})

describe('detector events', () => {
  it('returns every detector event in time order, grouped by kind', () => {
    const truth = structureLogToTruth(rawLog())
    expect(truth.detectorEvents.map((e) => e.t)).toEqual([25, 28, 29, 31])
    expect(Object.keys(truth.detectorsByKind).sort()).toEqual(['buildUp', 'drop', 'sectionChange'])
    expect(detectorEventTimes(truth, 'sectionChange')).toEqual([31])
    expect(detectorEventTimes(truth, 'buildUp')).toEqual([25, 28])
    expect(detectorEventTimes(truth, 'buildUp', true)).toEqual([25])
    expect(detectorEventTimes(truth, 'boundary')).toEqual([])
    expect(truth.commits).toHaveLength(1)
    expect(truth.beats).toHaveLength(100)
  })

  it('carries the run header: source, name, bpm, duration', () => {
    const truth = structureLogToTruth(rawLog())
    expect(truth).toMatchObject({ source: 'file', trackHint: 'Song', bpm: 120, durationSec: 50, firstT: 10, hasMarks: true })
    expect(truth.truncated).toBe(false)
  })

  it('flags a log whose rings overflowed', () => {
    const truth = structureLogToTruth(rawLog({ counters: { droppedEvents: 12 } }))
    expect(truth.truncated).toBe(true)
    expect(truth.caveats.some((c) => /overflowed/.test(c))).toBe(true)
  })
})

describe('empty and hostile logs', () => {
  it('an empty log has no boundaries and says so', () => {
    const truth = structureLogToTruth(new StructureLog({ isoNow: () => '2026-01-01T00:00:00.000Z' }).toJSON())
    expect(truth.boundaries).toEqual([])
    expect(truth.hasMarks).toBe(false)
    expect(truth.detectorEvents).toEqual([])
    expect(truth.firstT).toBeNull()
    expect(truth.bpm).toBeNull()
    expect(truthBoundaryTimes(truth)).toEqual([])
    expect(truthBoundaryBeats(truth)).toEqual([])
    expect(truth.caveats.some((c) => /No marks/.test(c))).toBe(true)
  })

  it('a minimal log with only a version parses (missing lists are empty)', () => {
    const truth = structureLogToTruth({ version: 1 })
    expect(truth.boundaries).toEqual([])
    expect(truth.source).toBe('unknown')
    expect(truth.trackHint).toBeNull()
  })

  it('drops entries with a non-finite time instead of failing', () => {
    const truth = structureLogToTruth(
      rawLog({
        marks: [{ id: 1, t: null, beat: 1 }, { id: 2, t: 30, beat: 40, bpm: 120, beatProgress: 0 }, 'x'],
        events: [{ kind: 'drop', t: 'soon', data: {} }, { kind: 'drop', t: 5, data: {} }],
      }),
    )
    expect(truth.boundaries).toHaveLength(1)
    expect(truth.detectorEvents).toHaveLength(1)
  })

  it('rejects anything that is not a structure log, and a newer schema than it knows', () => {
    expect(() => structureLogToTruth(null)).toThrow(/expected an object/)
    expect(() => structureLogToTruth([])).toThrow(/expected an object/)
    expect(() => structureLogToTruth({})).toThrow(/missing version/)
    expect(() => structureLogToTruth({ version: 1, schema: 'something.else' })).toThrow(/unknown schema/)
    expect(() => structureLogToTruth({ version: STRUCTURE_LOG_VERSION + 1 })).toThrow(/newer than supported/)
    expect(() => structureLogToTruth('{not json')).toThrow()
  })
})

describe('end to end with the recorder', () => {
  function frame(t: number): StructureLogFrame {
    const beat = Math.floor(t * 2)
    return {
      time: t,
      beatIndex: beat,
      beatInBar: beat % 4,
      beatProgress: (t * 2) % 1,
      bpm: 120,
      confidence: 0.9,
      tempoOctaves: 0,
      energy: 0.5,
      loudness: 0.5,
      lufsShortTerm: -12,
      silence: false,
      drop: false,
      buildUp: false,
      sectionChange: Math.abs(t - 12.3) < 0.01,
      sectionChangeStrength: 0.8,
      downbeatLocked: false,
      downbeatConfidence: 0,
      structureValid: true,
      songSection: {
        section: 'section',
        previousSection: '',
        sectionConfidence: 0.5,
        beatsInSection: 4,
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
      mood: { changed: false, state: 'groove', predictedState: 'groove', confidence: 0.5 },
      character: { primary: 'groove', confidence: 0.5, valence: 0.5, arousal: 0.5 },
    }
  }

  it('a recorded log, exported as text and read back, yields the marks and the detector events', () => {
    const log = new StructureLog({ isoNow: () => '2026-05-06T07:08:09.123Z', userAgent: 'vitest' })
    log.setTrackHint('E2E')
    const s = { sceneId: 'a', pendingSceneId: null, status: 'running', sourceType: 'system' }
    for (let t = 5; t < 30; t += 1 / 60) log.observe(frame(t), s)
    log.mark(13.1, 26) // a tap ~0.8 s after the change the detector saw at 12.3
    const truth = structureLogToTruth(stringifyStructureLog(log.toJSON()))
    expect(truth.source).toBe('system')
    expect(truth.trackHint).toBe('E2E')
    expect(truth.boundaries).toHaveLength(1)
    // 13.1 - 0.5 = 12.6 -> nearest recorded beat (a beat every 0.5 s) is 12.5
    expect(truth.boundaries[0].beatTime).toBeCloseTo(12.5, 1)
    expect(truth.boundaries[0].beat).toBe(25)
    const det = detectorEventTimes(truth, 'sectionChange')
    expect(det).toHaveLength(1)
    expect(det[0]).toBeCloseTo(12.3, 1)
    expect(parseStructureLog(log.toJSON()).version).toBe(STRUCTURE_LOG_VERSION)
  })
})
