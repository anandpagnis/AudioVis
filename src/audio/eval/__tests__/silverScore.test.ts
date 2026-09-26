import { describe, expect, it } from 'vitest'
import {
  circularShift,
  cutsInLagWindow,
  scoreCuts,
  scoreEventsVsSilver,
  scoreTrackCuts,
  silverRef,
  summarizeEvents,
  summarizeSystem,
  STRONG_STRENGTH,
  type CutList,
  type CutSamples,
  type SilverPlanLike,
} from '../silverScore'

/**
 * `silverScore.ts` scores scene cuts and event detectors against the silver boundaries. The cases below are hand-made
 * so every count is known: bar = 2 s (120 BPM), boundaries at 30 / 60 / 90 s (30 and 90 strong), a 120 s track.
 */

const plan = (over: Partial<SilverPlanLike> = {}): SilverPlanLike => ({
  bpm: 120,
  events: [
    { boundaryTime: 60, strength: 0.4 },
    { boundaryTime: 30, strength: 0.8 },
    { boundaryTime: 90, strength: 0.9 },
  ],
  diagnostics: { tempo: { confidence: 0.9 }, beatless: false, downbeat: { confidence: 0.9 } },
  ...over,
})

const cutList = (times: number[], forced: boolean[] = times.map(() => false)): CutList => ({ times, beats: times.map((t) => Math.round(t * 2)), forced })

describe('silverRef', () => {
  it('sorts the boundaries, splits the strong ones at strength >= 0.5 and takes the bar from the silver tempo', () => {
    const r = silverRef(plan())
    expect(r.all).toEqual([30, 60, 90])
    expect(r.strong).toEqual([30, 90])
    expect(STRONG_STRENGTH).toBe(0.5)
    expect(r.barSec).toBeCloseTo(2)
    expect(silverRef(plan({ bpm: 96 })).barSec).toBeCloseTo(2.5)
    expect(r.lowConfidence).toBe(false)
  })

  it('flags a low-confidence bar grid: tempo < 0.3, beatless, or downbeat < 0.5', () => {
    expect(silverRef(plan({ diagnostics: { tempo: { confidence: 0.2 } } })).reasons).toEqual(['tempo'])
    expect(silverRef(plan({ diagnostics: { beatless: true } })).reasons).toEqual(['beatless'])
    expect(silverRef(plan({ diagnostics: { downbeat: { confidence: 0.4 } } })).reasons).toEqual(['downbeat'])
    expect(silverRef(plan({ diagnostics: { tempo: { confidence: 0.1 }, downbeat: { confidence: 0.1 } } })).lowConfidence).toBe(true)
    expect(silverRef(plan({ diagnostics: undefined })).lowConfidence).toBe(false)
  })

  it('drops non-finite boundary times', () => {
    expect(silverRef(plan({ events: [{ boundaryTime: NaN, strength: 1 }, { boundaryTime: 10, strength: 1 }] })).all).toEqual([10])
  })
})

describe('scoreCuts', () => {
  const ref = silverRef(plan())

  it('counts the cuts near a boundary (+-1 bar, +-2 s, strong) and after one ([-1, +4] bars), and the boundaries covered', () => {
    const samples: CutSamples = { since: [], coverLag: [] }
    const c = scoreCuts([31, 45, 68, 100], ref, 120, samples)
    expect(c.cuts).toBe(4)
    expect(c.within1Bar).toBe(1) // 31
    expect(c.within2s).toBe(1)
    expect(c.within1BarStrong).toBe(1)
    expect(c.followsBoundary).toBe(2) // 31 (after 30) and 68 (8 s = 4 bars after 60, inclusive)
    // coverage window [B - 2 s, B + 8 s]: 30 <- 31, 60 <- 68, 90 <- nothing before 98
    expect(c.covAll).toEqual({ boundaries: 3, covered: 2 })
    expect(c.covStrong).toEqual({ boundaries: 2, covered: 1 })
    expect(samples.since).toEqual([1, 15, 8, 10])
    expect(samples.coverLag).toEqual([1]) // the first cut in the window of the only covered strong boundary
  })

  it('a cut just BEFORE a boundary covers it (a cut may lead by one bar), one two bars before does not', () => {
    expect(scoreCuts([29], ref, 120).covStrong.covered).toBe(1)
    expect(scoreCuts([27.9], ref, 120).covStrong.covered).toBe(0)
  })

  it('boundaries too close to the end of the span cannot be covered, so they leave the coverage denominator (not the cut scores)', () => {
    const late = silverRef(plan({ events: [{ boundaryTime: 30, strength: 1 }, { boundaryTime: 115, strength: 1 }] }))
    const c = scoreCuts([116], late, 120)
    expect(c.covAll.boundaries).toBe(1) // 115 > 120 - 8 is not coverable
    expect(c.within1Bar).toBe(1) // ...but the cut at 116 is still near it
  })

  it('no cuts: zero counts and every boundary uncovered', () => {
    const c = scoreCuts([], ref, 120)
    expect(c.cuts).toBe(0)
    expect(c.covAll).toEqual({ boundaries: 3, covered: 0 })
  })
})

describe('cutsInLagWindow', () => {
  it('counts the cuts that follow a boundary by a lag inside the window (negative lo lets a cut lead it)', () => {
    const b = [30, 60, 90]
    const cuts = [31, 45, 68, 100]
    expect(cutsInLagWindow(cuts, b, 0, 4)).toBe(1) // 31 (lag 1); 68 is lag 8; 100 is lag 10
    expect(cutsInLagWindow(cuts, b, 0, 8)).toBe(2) // + 68
    expect(cutsInLagWindow(cuts, b, 2, 8)).toBe(1) // only 68: 31 lags by 1 s
    expect(cutsInLagWindow([29], b, -2, 4)).toBe(1)
    expect(cutsInLagWindow([29], b, 0, 4)).toBe(0)
    expect(cutsInLagWindow([], b, 0, 4)).toBe(0)
    expect(cutsInLagWindow(cuts, [], 0, 4)).toBe(0)
  })
})

describe('circularShift', () => {
  it('wraps inside the duration and sorts', () => {
    expect(circularShift([1, 5, 9], 10, 3)).toEqual([2, 4, 8])
    expect(circularShift([1, 2], 0, 3)).toEqual([1, 2])
  })
})

describe('scoreTrackCuts / summarizeSystem', () => {
  const ref = silverRef(plan())

  it('leaves the startup commit out of the alignment scores but keeps it in the cadence numbers', () => {
    const s = scoreTrackCuts('a', 'x', ref, cutList([2, 31]), 120, { chanceCopies: 3 })
    expect(s.post.real.cuts).toBe(1)
    expect(s.all.real.cuts).toBe(2)
    expect(s.cutsAll).toBe(2)
    expect(s.intervalsSec).toEqual([29])
  })

  it('interval, forced and bar statistics from the cuts (app bars = beats / 4, silver bars = seconds / bar)', () => {
    const s = scoreTrackCuts('a', 'x', ref, { times: [10, 30, 70], beats: [20, 60, 140], forced: [false, true, true] }, 120, { chanceCopies: 2 })
    expect(s.intervalsSec).toEqual([20, 40])
    expect(s.intervalsBarsApp).toEqual([10, 20])
    expect(s.intervalsBarsSilver).toEqual([10, 20])
    expect(s.forcedCuts).toBe(2)
    const sum = summarizeSystem([s])
    expect(sum.cuts).toBe(3)
    expect(sum.cutsPerMin).toBeCloseTo(3 / 2)
    expect(sum.forcedShare).toBeCloseTo(2 / 3)
    expect(sum.intervalBarsApp.median).toBe(15)
    expect(sum.intervalBarsApp.in4to32).toBe(1)
    expect(sum.intervalBarsApp.above32).toBe(0)
  })

  it('is deterministic for a seed and pools counts across tracks', () => {
    const a1 = scoreTrackCuts('a', 'x', ref, cutList([31, 62, 95]), 120, { chanceCopies: 5, seed: 4 })
    const a2 = scoreTrackCuts('a', 'x', ref, cutList([31, 62, 95]), 120, { chanceCopies: 5, seed: 4 })
    expect(a1).toEqual(a2)
    const b = scoreTrackCuts('b', 'x', ref, cutList([31, 62, 95]), 120, { chanceCopies: 5, seed: 4 })
    const pooled = summarizeSystem([a1, b])
    expect(pooled.tracks).toBe(2)
    expect(pooled.post.within1Bar.n).toBe(6)
    expect(pooled.silverBoundaries).toEqual({ all: 6, strong: 4 })
  })

  it('a system that cuts on the boundaries has a high lift; the same cuts shifted at random score near chance', () => {
    // 20 boundaries, one every 20 s over 400 s (bar 2 s)
    const events = Array.from({ length: 19 }, (_, k) => ({ boundaryTime: 20 * (k + 1), strength: 0.8 }))
    const r = silverRef({ bpm: 120, events })
    const on = scoreTrackCuts('t', 'x', r, cutList(events.map((e) => e.boundaryTime + 1)), 400, { chanceCopies: 40, seed: 2 })
    const s = summarizeSystem([on])
    expect(s.post.within1Bar.real).toBe(1)
    expect(s.post.within1Bar.chance).toBeGreaterThan(0.1)
    expect(s.post.within1Bar.chance).toBeLessThan(0.35)
    expect(s.post.within1Bar.lift).toBeGreaterThan(0.6)
    expect(s.post.coverStrong.real).toBe(1)
    expect(s.post.coverStrong.lift).toBeGreaterThan(0.3)
    // cuts that are unrelated to the boundaries: between them, 10 s from each
    const off = scoreTrackCuts('t', 'x', r, cutList(events.map((e) => e.boundaryTime + 10)), 400, { chanceCopies: 40, seed: 2 })
    expect(summarizeSystem([off]).post.within1Bar.real).toBe(0)
    expect(summarizeSystem([off]).post.within1Bar.lift).toBeLessThan(0)
  })

  it('cutting more often raises coverage by chance alone, and the chance control says so', () => {
    const events = Array.from({ length: 9 }, (_, k) => ({ boundaryTime: 40 * (k + 1), strength: 0.8 }))
    const r = silverRef({ bpm: 120, events })
    const dense = scoreTrackCuts('t', 'x', r, cutList(Array.from({ length: 80 }, (_, k) => 6 + 5 * k)), 400, { chanceCopies: 30, seed: 3 })
    const s = summarizeSystem([dense])
    expect(s.post.coverStrong.real).toBe(1) // a cut every 5 s covers everything
    expect(s.post.coverStrong.chance).toBeGreaterThan(0.9) // ...and so does chance (a 10 s window, a cut every 5 s)
    // chance saturates at 1, where "how much better than chance" is undefined: reported as NaN, never as a fake win
    expect(Number.isFinite(s.post.coverStrong.lift) ? Math.abs(s.post.coverStrong.lift) < 0.5 : true).toBe(true)
  })
})

describe('scoreEventsVsSilver / summarizeEvents', () => {
  const ref = silverRef(plan())

  it('a detector that reports exactly the silver boundaries scores 1 at every window', () => {
    const s = scoreEventsVsSilver('a', 'x', ref, ref.all, [30, 60, 90], 120, { chanceCopies: 3 })
    expect(s.real).toMatchObject({ nRef: 3, nEst: 3, hits1Bar: 3, hits3s: 3, hits05s: 3 })
    expect(s.f3).toBe(1)
    expect(s.f05).toBe(1)
  })

  it('1.5 s late: inside +-1 bar and +-3 s, outside +-0.5 s; an extra estimate costs precision', () => {
    const s = scoreEventsVsSilver('a', 'x', ref, ref.all, [31.5, 61.5, 91.5, 10], 120, { chanceCopies: 3 })
    expect(s.real).toMatchObject({ nRef: 3, nEst: 4, hits1Bar: 3, hits3s: 3, hits05s: 0 })
    const sum = summarizeEvents([s])
    expect(sum.bar1.recall).toBe(1)
    expect(sum.bar1.precision).toBeCloseTo(0.75)
    expect(sum.s3.f).toBeCloseTo((2 * 0.75) / 1.75)
    expect(sum.s05.f).toBe(0)
  })

  it('limits both lists to the scored span and scores the strong boundaries when asked', () => {
    const s = scoreEventsVsSilver('a', 'x', ref, ref.strong, [30, 90, 500], 100, { chanceCopies: 2 })
    expect(s.real.nRef).toBe(2)
    expect(s.real.nEst).toBe(2) // 500 is outside the span
    const early = scoreEventsVsSilver('a', 'x', ref, ref.all, [30], 50, { chanceCopies: 2 })
    expect(early.real.nRef).toBe(1) // 60 and 90 are outside a 50 s span
  })

  it('micro pooling weighs a track by its boundaries; macro F averages the per-track F over tracks with a reference', () => {
    const good = scoreEventsVsSilver('a', 'x', ref, ref.all, [30, 60, 90], 120, { chanceCopies: 2 })
    const none = scoreEventsVsSilver('b', 'x', ref, [], [30], 120, { chanceCopies: 2 })
    const sum = summarizeEvents([good, none])
    expect(sum.nRef).toBe(3)
    expect(sum.nEst).toBe(4)
    expect(sum.s3.recall).toBe(1)
    expect(sum.s3.precision).toBeCloseTo(0.75)
    expect(sum.macroF3).toBe(1) // the track with no reference boundary is left out of the macro mean
  })

  it('the chance control of a detector that reports far off the boundaries is not better than a real one', () => {
    const real = scoreEventsVsSilver('a', 'x', ref, ref.all, [30, 60, 90], 120, { chanceCopies: 30, seed: 5 })
    const sum = summarizeEvents([real])
    expect(sum.s3.f).toBeGreaterThan(sum.chanceS3.f)
    expect(sum.chanceS3.f).toBeLessThan(0.6)
  })

  it('an empty estimate scores 0 without dividing by zero', () => {
    const s = scoreEventsVsSilver('a', 'x', ref, ref.all, [], 120, { chanceCopies: 2 })
    const sum = summarizeEvents([s])
    expect(sum.s3).toEqual({ precision: 0, recall: 0, f: 0 })
    expect(sum.estPerMin).toBe(0)
  })
})
