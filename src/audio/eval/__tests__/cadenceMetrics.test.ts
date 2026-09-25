import { describe, expect, it } from 'vitest'
import { aggregateCadence, alignTimes, cadenceOfTrack, detectorEvents, distStats, quantile, shareWithin } from '../cadenceMetrics'
import { createEmptyTrace, type CadenceTrace } from '../cadenceTrace'
import { simulateLegacy } from '../legacyCadence'

const FPS = 60

/** Steady 120 BPM grid, 30 frames per beat. */
function grid(seconds: number, structureValid: boolean): CadenceTrace {
  const n = seconds * FPS
  const t = createEmptyTrace(n, FPS)
  let beat = 0
  for (let i = 0; i < n; i++) {
    if (i > 0 && i % 30 === 0) {
      beat++
      t.cols.beat[i] = 1
    }
    t.cols.beatIndex[i] = beat
    t.cols.beatInBar[i] = beat % 4
    t.cols.bar[i] = Math.floor(beat / 4)
    t.cols.bpm10[i] = 1200
    t.cols.confidence[i] = 230
    t.cols.structureValid[i] = structureValid ? 1 : 0
  }
  return t
}

describe('cadenceMetrics helpers', () => {
  it('quantiles and distribution stats', () => {
    expect(quantile([1, 2, 3, 4, 5], 0.5)).toBe(3)
    expect(quantile([0, 10], 0.9)).toBeCloseTo(9)
    const d = distStats([5, 1, 3, NaN, 2, 4])
    expect(d).toMatchObject({ n: 5, min: 1, median: 3, max: 5, mean: 3 })
    expect(distStats([]).n).toBe(0)
    expect(shareWithin([1, 2, 3, 40], 2, 30)).toBe(0.5)
  })

  it('nearest-event distance and time since the latest event', () => {
    const a = alignTimes([10, 0.5, 100], [1, 9, 12])
    expect(a.abs).toEqual([1, 0.5, 88])
    expect(a.since[0]).toBe(1)
    expect(a.since[1]).toBe(Infinity) // no event at or before 0.5
    expect(a.since[2]).toBe(88)
  })
})

describe('cadenceOfTrack', () => {
  it('summarises a phrase-fallback show: level-type commits, edges lost to the dwell, next-commit kinds', () => {
    const t = grid(34, false)
    t.cols.sectionChange[24 * 30] = 1 // beat 24, 8 beats after the beat-16 fallback commit
    t.cols.sectionChangeStrength[24 * 30] = 100
    const r = simulateLegacy(t, { armed: false, buildSwitch: false, characterShift: false, staleSec: 1e9 })
    const m = cadenceOfTrack('x', t, r, { chanceCopies: 4, seed: 3 })
    expect(r.commits.map((c) => c.beat)).toEqual([16, 48])
    expect(m.commits).toBe(2)
    expect(m.kinds).toEqual({ event: 0, latched: 0, level: 2 })
    expect(m.intervalsBars).toEqual([8])
    expect(m.intervalsSec).toEqual([16])
    expect(m.slackBeats).toEqual([0]) // beat 48 is exactly the first phrase edge after the dwell (16 + 32)
    expect(m.triggers).toEqual({ phraseFallback: 2 })
    expect(m.edges.sectionChange).toMatchObject({ total: 1, inDwell: 1 })
    expect(m.edges.sectionChange.outcomes.dwell).toBe(1)
    // the lost edge was replaced by a LEVEL-type change 12 s later
    expect(m.nextCommitAfterDiscard).toEqual(['level'])
    expect(m.commitsAfterDiscard.level).toBe(1)
    expect(m.lagAfterDiscardSec).toEqual([12])
    // one detector event on the track; the commits are 8 s / 16 s away from it
    expect(m.detector.sectionChange).toBe(1)
    expect(m.align.sectionChange.real.abs).toEqual([4, 12])
    expect(m.align.sectionChange.chance.abs).toHaveLength(2 * 4)
    // dwell: beats 16..48 of 120 beats -> the second commit's dwell starts at beat 48
    expect(m.dwellShare).toBeGreaterThan(0.4)
  })

  it('the chance control is deterministic for a seed', () => {
    const t = grid(60, false)
    const r = simulateLegacy(t)
    const a = cadenceOfTrack('x', t, r, { seed: 7 })
    const b = cadenceOfTrack('x', t, r, { seed: 7 })
    expect(b.align.any.chance).toEqual(a.align.any.chance)
  })

  it('detector events: rising edges only, boundaries gated on structureValid, analyser boundaries mapped to time', () => {
    const t = grid(30, true)
    for (let i = 100; i < 104; i++) t.cols.drop[i] = 1 // one latched drop, one rising edge
    t.cols.boundaryChanged[300] = 1
    t.cols.structureValid.fill(0, 0, 200)
    t.cols.boundaryChanged[50] = 1 // before structureValid: not an event
    t.analyserBoundaries.push({ beat: 10, seenFrame: 500 })
    const e = detectorEvents(t)
    expect(e.drop).toEqual([100 / FPS])
    expect(e.boundary).toEqual([5])
    expect(e.analyser).toEqual([5]) // beat 10 is at frame 300
    expect(e.any).toEqual([100 / FPS, 5, 5])
  })
})

describe('aggregateCadence', () => {
  it('pools intervals and counts across tracks', () => {
    const mk = (id: string, seconds: number) => {
      const t = grid(seconds, false)
      return cadenceOfTrack(id, t, simulateLegacy(t, { armed: false, buildSwitch: false, characterShift: false, staleSec: 1e9 }), {
        chanceCopies: 2,
      })
    }
    const a = aggregateCadence([mk('a', 70), mk('b', 70)])
    expect(a.tracks).toBe(2)
    expect(a.commits).toBe(8) // beats 16, 48, 80, 112 on each 70 s track (the phrase timer, dwell-limited)
    expect(a.intervalBars.median).toBeGreaterThan(0)
    expect(a.kinds.level).toBe(a.commits)
    expect(a.triggers[0].trigger).toBe('phraseFallback')
    expect(a.align.any.commits).toBe(a.commits)
  })
})
