import { describe, expect, it } from 'vitest'
import {
  alignmentScore,
  barSec,
  barsToSec,
  detectionLagStats,
  detectionsNearEvents,
  falseAlarmsPerMinute,
  fMeasure,
  intervalStats,
  lagStats,
  matchEvents,
  mirEvalStyleDetectionF,
  negativeTimes,
  percentile,
  positiveTimes,
  recallWithinBars,
  scoreDetections,
  scoreDetectionsBars,
} from '../structureMetrics'
import type { TruthEvent } from '../synthSong'

describe('bar arithmetic', () => {
  it('a bar is 4 beats', () => {
    expect(barSec(120)).toBe(2)
    expect(barSec(100)).toBe(2.4)
    expect(barsToSec(3, 120)).toBe(6)
  })
})

describe('matchEvents / scoreDetections', () => {
  it('perfect detection', () => {
    const s = scoreDetections([10, 20, 30], [10, 20, 30], 0.5)
    expect(s).toMatchObject({ nTruth: 3, nDet: 3, hits: 3, precision: 1, recall: 1, f: 1 })
    expect(lagStats(s.match.pairs).mean).toBe(0)
  })

  it('everything missed', () => {
    const s = scoreDetections([10, 20, 30], [], 0.5)
    expect(s).toMatchObject({ hits: 0, precision: 0, recall: 0, f: 0 })
    expect(s.match.unmatchedTruth).toEqual([0, 1, 2])
  })

  it('everything false', () => {
    const s = scoreDetections([], [5, 15], 0.5)
    expect(s).toMatchObject({ nTruth: 0, nDet: 2, hits: 0, precision: 0, recall: 0, f: 0 })
    expect(s.match.unmatchedDet).toEqual([0, 1])
  })

  it('empty inputs on both sides score 0 without NaN', () => {
    const s = scoreDetections([], [], 1)
    expect(s).toMatchObject({ nTruth: 0, nDet: 0, hits: 0, precision: 0, recall: 0, f: 0 })
  })

  it('offset inside vs outside the tolerance, boundary inclusive', () => {
    expect(scoreDetections([10], [10.4], 0.5).hits).toBe(1)
    expect(scoreDetections([10], [9.6], 0.5).hits).toBe(1)
    expect(scoreDetections([10], [10.5], 0.5).hits).toBe(1)
    expect(scoreDetections([10], [10.6], 0.5).hits).toBe(0)
    expect(scoreDetections([10], [9.4], 0.5).hits).toBe(0)
  })

  it('asymmetric (causal) tolerance', () => {
    const tol = { before: 0.25, after: 2 }
    expect(scoreDetections([10], [11.9], tol).hits).toBe(1)
    expect(scoreDetections([10], [12.1], tol).hits).toBe(0)
    expect(scoreDetections([10], [9.8], tol).hits).toBe(1)
    expect(scoreDetections([10], [9.7], tol).hits).toBe(0)
  })

  it('duplicate detections: one hit, the extra is a false alarm', () => {
    const s = scoreDetections([10], [10.1, 10.2], 0.5)
    expect(s.hits).toBe(1)
    expect(s.precision).toBe(0.5)
    expect(s.recall).toBe(1)
    expect(s.match.pairs[0].det).toBe(10.1) // the closer one wins
    expect(s.match.unmatchedDet).toEqual([1])
    expect(s.f).toBeCloseTo(2 / 3, 12)
  })

  it('is one-to-one and optimal, not greedy: the shared detection goes where it is needed', () => {
    // 10.55 is the nearest to truth 10 (0.55) and the only feasible partner of truth 11 (0.45);
    // 9.4 is feasible only for truth 10 (0.6). Nearest-first would give truth 10 the 10.55 and strand truth 11.
    const s = scoreDetections([10, 11], [10.55, 9.4], 0.65)
    expect(s.hits).toBe(2)
    expect(s.match.pairs.map((p) => [p.truth, p.det])).toEqual([
      [10, 9.4],
      [11, 10.55],
    ])
  })

  it('among maximum matchings it minimises total lag', () => {
    // both pairings feasible; the aligned one has total |lag| 0.2, the crossed one 1.0
    const m = matchEvents([10, 11], [10.1, 11.1], 1.2)
    expect(m.pairs.map((p) => [p.truthIndex, p.detIndex])).toEqual([
      [0, 0],
      [1, 1],
    ])
  })

  it('works with unsorted input and reports original indices', () => {
    const m = matchEvents([30, 10, 20], [19.8, 30.2, 5], 0.5)
    expect(m.pairs.map((p) => [p.truthIndex, p.detIndex])).toEqual([
      [0, 1],
      [2, 0],
    ])
    expect(m.unmatchedTruth).toEqual([1])
    expect(m.unmatchedDet).toEqual([2])
  })

  it('handles many more detections than truths', () => {
    const det = Array.from({ length: 500 }, (_, i) => i * 0.37)
    const s = scoreDetections([50, 100], det, 0.2)
    expect(s.hits).toBe(2)
    expect(s.nDet).toBe(500)
  })

  it('f-measure with beta', () => {
    expect(fMeasure(1, 0.5)).toBeCloseTo(2 / 3, 12)
    expect(fMeasure(0, 0)).toBe(0)
    // beta 2 weighs recall more: with P=1, R=0.5, F2 = 5*1*.5/(4*1+.5)
    expect(fMeasure(1, 0.5, 2)).toBeCloseTo(2.5 / 4.5, 12)
  })

  it('bar-denominated scores', () => {
    // 120 BPM: one bar = 2 s
    const truth = [16, 32, 48]
    const det = [17.5, 33.9, 52.5]
    expect(scoreDetectionsBars(truth, det, 1, 120).hits).toBe(2)
    expect(recallWithinBars(truth, det, 1, 120)).toBeCloseTo(2 / 3, 12)
    expect(recallWithinBars(truth, det, 2.5, 120)).toBe(1)
  })
})

describe('false alarms', () => {
  it('per minute of audio, one-to-one', () => {
    // 3 detections, 1 matched, over 90 s => 2 false alarms / 1.5 min
    expect(falseAlarmsPerMinute([10], [10.1, 40, 70], 90, 0.5)).toBeCloseTo(2 / 1.5, 12)
    expect(falseAlarmsPerMinute([10, 40], [10.1, 40], 60, 0.5)).toBe(0)
    expect(falseAlarmsPerMinute([], [1, 2, 3], 30, 0.5)).toBe(6)
    expect(falseAlarmsPerMinute([], [], 30, 0.5)).toBe(0)
    expect(falseAlarmsPerMinute([1], [1], 0, 0.5)).toBeNaN()
  })

  it('a duplicate of a matched truth is a false alarm', () => {
    expect(falseAlarmsPerMinute([10], [10, 10.3], 60, 0.5)).toBe(1)
  })

  it('detectionsNearEvents counts each detection once', () => {
    expect(detectionsNearEvents([10, 12], [10.1, 11, 11.9, 30], 0.5)).toBe(2)
    expect(detectionsNearEvents([], [1, 2], 1)).toBe(0)
    expect(detectionsNearEvents([10], [], 1)).toBe(0)
  })
})

describe('lag statistics', () => {
  it('mean / median / p90 of det - truth, positive = late', () => {
    const l = lagStats([{ lag: 0.5 }, { lag: 1 }, { lag: 1.5 }, { lag: 2 }, { lag: 6 }])
    expect(l.n).toBe(5)
    expect(l.mean).toBeCloseTo(2.2, 12)
    expect(l.median).toBe(1.5)
    expect(l.p90).toBeCloseTo(2 + 0.6 * 4, 12) // index 3.6 -> 2 + 0.6*(6-2)
    expect(l.min).toBe(0.5)
    expect(l.max).toBe(6)
  })

  it('early detections are negative', () => {
    const s = scoreDetections([10, 20], [9.8, 20.4], 0.5)
    const l = lagStats(s.match.pairs)
    expect(l.min).toBeCloseTo(-0.2, 12)
    expect(l.max).toBeCloseTo(0.4, 12)
  })

  it('no matched pairs -> NaN', () => {
    const l = lagStats([])
    expect(l.n).toBe(0)
    expect(l.mean).toBeNaN()
    expect(l.median).toBeNaN()
    expect(l.p90).toBeNaN()
  })

  it('publication lag of a retrospective boundary: match on the claimed time, lag on the publish time', () => {
    // claims sit on the truth, but were published 4 s and 6 s later
    const l = detectionLagStats([10, 40], [10.1, 39.9], [14.1, 45.9], { before: 1, after: 1 })
    expect(l.n).toBe(2)
    expect(l.mean).toBeCloseTo(5, 9)
  })

  it('percentile interpolates and clamps', () => {
    expect(percentile([1, 2, 3, 4], 0)).toBe(1)
    expect(percentile([1, 2, 3, 4], 1)).toBe(4)
    expect(percentile([4, 1, 3, 2], 0.5)).toBe(2.5)
    expect(percentile([], 0.5)).toBeNaN()
    expect(percentile([7], 0.9)).toBe(7)
  })
})

describe('alignmentScore', () => {
  it('share of cuts within tolerance bars of a true boundary', () => {
    // 120 BPM => 1 bar = 2 s; cuts at 10.1 and 20.9 are inside +-1 bar of 10 / 21, the cut at 50 is not
    expect(alignmentScore([10.1, 20.9, 50], [10, 21], 1, 120)).toBeCloseTo(2 / 3, 12)
    expect(alignmentScore([10.1, 20.9, 50], [10, 21], 0.01, 120)).toBe(0)
    expect(alignmentScore([], [10], 1, 120)).toBe(0)
    expect(alignmentScore([10], [], 1, 120)).toBe(0)
  })

  it('is per cut (not one-to-one): two cuts near one boundary both count', () => {
    expect(alignmentScore([10, 11], [10.5], 1, 120)).toBe(1)
  })
})

describe('intervalStats', () => {
  it('seconds, bars and the share inside [4, 32] bars', () => {
    // 120 BPM (bar = 2 s): gaps 8, 16, 32, 4 s = 4, 8, 16, 2 bars
    const s = intervalStats([0, 8, 24, 56, 60], 120)
    expect(s.n).toBe(4)
    expect(s.medianSec).toBe(12)
    expect(s.p10Sec).toBeCloseTo(5.2, 12)
    expect(s.p90Sec).toBeCloseTo(27.2, 12)
    expect(s.medianBars).toBe(6)
    expect(s.p10Bars).toBeCloseTo(2.6, 12)
    expect(s.p90Bars).toBeCloseTo(13.6, 12)
    expect(s.shareInRange).toBe(0.75)
  })

  it('range edges are inclusive; unsorted cuts are sorted; bar length follows bpm', () => {
    // 100 BPM: bar = 2.4 s; gaps 9.6 s (4 bars) and 76.8 s (32 bars) are both in range, 79.2 s (33 bars) is not
    const s = intervalStats([86.4, 0, 9.6, 165.6], 100)
    expect(s.n).toBe(3)
    expect(s.shareInRange).toBeCloseTo(2 / 3, 12)
    expect(intervalStats([0, 10], 100, { minBars: 5, maxBars: 8 }).shareInRange).toBe(0)
  })

  it('fewer than two cuts -> NaN', () => {
    for (const cuts of [[], [5]]) {
      const s = intervalStats(cuts, 120)
      expect(s.n).toBe(0)
      expect(s.medianSec).toBeNaN()
      expect(s.shareInRange).toBeNaN()
    }
  })
})

describe('mirEvalStyleDetectionF', () => {
  const ref = [0, 10, 20, 30]
  const est = [0.2, 10.4, 25, 30.1]

  it('0.5 s window, untrimmed: 3 of 4 on both sides', () => {
    const s = mirEvalStyleDetectionF(ref, est, 0.5)
    expect(s).toMatchObject({ hits: 3, nRef: 4, nEst: 4, precision: 0.75, recall: 0.75, f: 0.75 })
  })

  it('trim drops the first and last boundary of each list', () => {
    const s = mirEvalStyleDetectionF(ref, est, 0.5, { trim: true })
    // ref -> [10, 20], est -> [10.4, 25]
    expect(s).toMatchObject({ hits: 1, nRef: 2, nEst: 2, precision: 0.5, recall: 0.5, f: 0.5 })
  })

  it('the 3 s window still misses a 5 s error, a 6 s window catches it', () => {
    expect(mirEvalStyleDetectionF(ref, est, 3, { trim: true }).hits).toBe(1)
    expect(mirEvalStyleDetectionF(ref, est, 6, { trim: true })).toMatchObject({ hits: 2, f: 1 })
  })

  it('precision and recall differ when the estimate has extras', () => {
    const s = mirEvalStyleDetectionF([10, 20], [10, 15, 20, 25], 0.5)
    expect(s.precision).toBe(0.5)
    expect(s.recall).toBe(1)
    expect(s.f).toBeCloseTo(2 / 3, 12)
  })

  it('beta 1 by default, and a recall-weighted F on request', () => {
    const s = mirEvalStyleDetectionF([10, 20], [10, 15, 20, 25], 0.5, { beta: 2 })
    expect(s.f).toBeCloseTo((5 * 0.5 * 1) / (4 * 0.5 + 1), 12)
  })

  it('empty (or trimmed-to-empty) lists score 0, like mir_eval', () => {
    expect(mirEvalStyleDetectionF([], [1], 0.5)).toMatchObject({ precision: 0, recall: 0, f: 0 })
    expect(mirEvalStyleDetectionF([1], [], 0.5)).toMatchObject({ precision: 0, recall: 0, f: 0 })
    expect(mirEvalStyleDetectionF([0, 10], [0, 10], 0.5, { trim: true })).toMatchObject({ f: 0, nRef: 0 })
  })

  it('does not require sorted input', () => {
    expect(mirEvalStyleDetectionF([30, 0, 10, 20], [30.1, 10.4, 0.2, 25], 0.5).f).toBe(0.75)
  })
})

describe('truth helpers', () => {
  const t = (type: TruthEvent['type'], timeSec: number, shouldTrigger: boolean): TruthEvent => ({ type, timeSec, beat: 0, bar: 0, shouldTrigger })
  const truth = [t('fill', 5, false), t('drop', 10, true), t('change', 20, true), t('gain', 30, false)]
  it('positiveTimes / negativeTimes with optional type filters', () => {
    expect(positiveTimes(truth)).toEqual([10, 20])
    expect(positiveTimes(truth, ['drop'])).toEqual([10])
    expect(negativeTimes(truth)).toEqual([5, 30])
    expect(negativeTimes(truth, ['gain'])).toEqual([30])
  })
})
