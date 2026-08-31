import { describe, expect, it } from 'vitest'
import {
  BEAT_HIT_TOLERANCE_BEATS,
  beatCoverageScore,
  beatHitScore,
  beatOffsetBeats,
  cutOffsetDistribution,
  downbeatOffsetBeats,
  histogramBuckets,
  normalisedEntropy,
  offsetDistribution,
  rackDutyCycle,
  repeatGapsSec,
  shannonEntropyBits,
  timeToRepeat,
  type CutBeatSample,
} from '../showQualityMetrics'

describe('downbeatOffsetBeats', () => {
  it('is 0 exactly on the downbeat', () => {
    expect(downbeatOffsetBeats(0, 0)).toBeCloseTo(0, 6)
  })

  it('is 2 (max) exactly halfway through the bar', () => {
    expect(downbeatOffsetBeats(2, 0)).toBeCloseTo(2, 6)
  })

  it('wraps: just before the next downbeat reads as close, not far', () => {
    expect(downbeatOffsetBeats(3, 0.99)).toBeCloseTo(0.01, 6)
  })

  it('is symmetric around the downbeat', () => {
    const before = downbeatOffsetBeats(3, 0.9) // 0.1 beats before
    const after = downbeatOffsetBeats(0, 0.1) // 0.1 beats after
    expect(before).toBeCloseTo(after, 6)
  })

  it('is total against non-finite or out-of-range inputs', () => {
    expect(Number.isFinite(downbeatOffsetBeats(NaN, 0.5))).toBe(true)
    expect(Number.isFinite(downbeatOffsetBeats(0, NaN))).toBe(true)
    expect(Number.isFinite(downbeatOffsetBeats(-5, 3))).toBe(true)
    expect(Number.isFinite(downbeatOffsetBeats(99, -3))).toBe(true)
  })

  it('stays within 0..2 across a full sweep of the bar', () => {
    for (let bib = 0; bib < 4; bib++) {
      for (let p = 0; p <= 1; p += 0.1) {
        const d = downbeatOffsetBeats(bib, p)
        expect(d).toBeGreaterThanOrEqual(0)
        expect(d).toBeLessThanOrEqual(2)
      }
    }
  })
})

describe('beatOffsetBeats', () => {
  it('is 0 exactly on a beat', () => {
    expect(beatOffsetBeats(0)).toBeCloseTo(0, 6)
  })

  it('is 0.5 (max) exactly halfway through a beat', () => {
    expect(beatOffsetBeats(0.5)).toBeCloseTo(0.5, 6)
  })

  it('wraps toward the next beat past the midpoint', () => {
    expect(beatOffsetBeats(0.9)).toBeCloseTo(0.1, 6)
  })

  it('is total against non-finite input', () => {
    expect(Number.isFinite(beatOffsetBeats(NaN))).toBe(true)
    expect(Number.isFinite(beatOffsetBeats(Infinity))).toBe(true)
  })
})

describe('offsetDistribution', () => {
  it('returns the empty stats for no offsets', () => {
    expect(offsetDistribution([])).toEqual({ n: 0, meanBeats: 0, medianBeats: 0, p90Beats: 0, maxBeats: 0 })
  })

  it('computes mean/median/p90/max over a known set', () => {
    const s = offsetDistribution([0, 0.1, 0.2, 0.3, 2])
    expect(s.n).toBe(5)
    expect(s.meanBeats).toBeCloseTo(0.52, 6)
    expect(s.medianBeats).toBeCloseTo(0.2, 6)
    expect(s.maxBeats).toBeCloseTo(2, 6)
  })

  it('ignores non-finite entries rather than propagating NaN', () => {
    const s = offsetDistribution([0, 0.5, NaN, Infinity])
    expect(s.n).toBe(2)
    expect(Number.isFinite(s.meanBeats)).toBe(true)
  })
})

describe('beatHitScore', () => {
  it('is 0 for no cuts', () => {
    expect(beatHitScore([])).toBe(0)
  })

  it('is 1 when every cut lands exactly on a beat', () => {
    const cuts: CutBeatSample[] = [
      { bar: 0, beatInBar: 0, beatProgress: 0 },
      { bar: 0, beatInBar: 2, beatProgress: 0 },
    ]
    expect(beatHitScore(cuts)).toBe(1)
  })

  it('is 0 when every cut lands at the worst possible offset', () => {
    const cuts: CutBeatSample[] = [{ bar: 0, beatInBar: 1, beatProgress: 0.5 }]
    expect(beatHitScore(cuts)).toBe(0)
  })

  it('counts only cuts within tolerance', () => {
    const cuts: CutBeatSample[] = [
      { bar: 0, beatInBar: 0, beatProgress: 0.01 }, // within default tolerance
      { bar: 0, beatInBar: 0, beatProgress: 0.5 }, // worst case, outside
    ]
    expect(beatHitScore(cuts)).toBeCloseTo(0.5, 6)
  })

  it('honours a custom tolerance', () => {
    const cuts: CutBeatSample[] = [{ bar: 0, beatInBar: 0, beatProgress: 0.2 }]
    expect(beatHitScore(cuts, 0.1)).toBe(0)
    expect(beatHitScore(cuts, 0.25)).toBe(1)
  })
})

describe('beatCoverageScore', () => {
  it('is 0 for zero or negative total bars', () => {
    expect(beatCoverageScore([], 0)).toBe(0)
    expect(beatCoverageScore([{ bar: 0, beatInBar: 0, beatProgress: 0 }], -1)).toBe(0)
  })

  it('is 0 when no cut lands near a downbeat', () => {
    const cuts: CutBeatSample[] = [{ bar: 0, beatInBar: 2, beatProgress: 0.5 }]
    expect(beatCoverageScore(cuts, 10)).toBe(0)
  })

  it('counts one covered bar per on-downbeat cut, deduplicated within a bar', () => {
    const cuts: CutBeatSample[] = [
      { bar: 0, beatInBar: 0, beatProgress: 0 },
      { bar: 0, beatInBar: 0, beatProgress: 0.01 }, // same bar again — must not double count
      { bar: 3, beatInBar: 3, beatProgress: 0.99 }, // near bar 4's downbeat, wraps to bar 3 tag
    ]
    expect(beatCoverageScore(cuts, 10)).toBeCloseTo(0.2, 6) // 2 of 10 bars covered
  })

  it('never exceeds 1 even if cuts outnumber bars', () => {
    const cuts: CutBeatSample[] = Array.from({ length: 20 }, (_, i) => ({
      bar: i,
      beatInBar: 0,
      beatProgress: 0,
    }))
    expect(beatCoverageScore(cuts, 5)).toBe(1)
  })
})

describe('cutOffsetDistribution', () => {
  it('feeds cuts through downbeatOffsetBeats into offsetDistribution', () => {
    const cuts: CutBeatSample[] = [
      { bar: 0, beatInBar: 0, beatProgress: 0 },
      { bar: 0, beatInBar: 2, beatProgress: 0 },
    ]
    const d = cutOffsetDistribution(cuts)
    expect(d.n).toBe(2)
    expect(d.meanBeats).toBeCloseTo(1, 6)
  })

  it('is empty for no cuts', () => {
    expect(cutOffsetDistribution([]).n).toBe(0)
  })
})

describe('BEAT_HIT_TOLERANCE_BEATS', () => {
  it('is an eighth note at a 4/4 grid', () => {
    expect(BEAT_HIT_TOLERANCE_BEATS).toBeCloseTo(0.125, 6)
  })
})

describe('rackDutyCycle', () => {
  it('returns the empty result for no samples or a non-positive interval', () => {
    expect(rackDutyCycle([], 0.25)).toEqual({ dutyCycle: 0, longestOnSec: 0, longestOffSec: 0 })
    expect(rackDutyCycle([true], 0)).toEqual({ dutyCycle: 0, longestOnSec: 0, longestOffSec: 0 })
  })

  it('computes duty cycle as the fraction of engaged samples', () => {
    const r = rackDutyCycle([true, true, false, false], 1)
    expect(r.dutyCycle).toBeCloseTo(0.5, 6)
  })

  it('finds the longest unbroken on-run, in seconds', () => {
    const r = rackDutyCycle([true, true, true, false, true], 0.25)
    expect(r.longestOnSec).toBeCloseTo(0.75, 6)
  })

  it('finds the longest unbroken off-run, in seconds', () => {
    const r = rackDutyCycle([true, false, false, false, true], 0.25)
    expect(r.longestOffSec).toBeCloseTo(0.75, 6)
  })

  it('a rack always on has zero longest-off', () => {
    const r = rackDutyCycle([true, true, true], 1)
    expect(r.longestOffSec).toBe(0)
    expect(r.dutyCycle).toBe(1)
  })

  it('two racks can share a duty cycle with very different on/off shape', () => {
    // Flickery: on-off-on-off... vs held: on-on-on-off-off-off, both 50%.
    const flicker = rackDutyCycle([true, false, true, false, true, false], 1)
    const held = rackDutyCycle([true, true, true, false, false, false], 1)
    expect(flicker.dutyCycle).toBeCloseTo(held.dutyCycle, 6)
    expect(flicker.longestOnSec).toBeLessThan(held.longestOnSec)
  })
})

describe('shannonEntropyBits', () => {
  it('is 0 for an empty list', () => {
    expect(shannonEntropyBits([])).toBe(0)
  })

  it('is 0 when only one label ever appears', () => {
    expect(shannonEntropyBits(['a', 'a', 'a'])).toBe(0)
  })

  it('is 1 bit for a perfect 50/50 split of two labels', () => {
    expect(shannonEntropyBits(['a', 'b', 'a', 'b'])).toBeCloseTo(1, 6)
  })

  it('is log2(4) for a perfectly even four-way split', () => {
    expect(shannonEntropyBits(['a', 'b', 'c', 'd'])).toBeCloseTo(2, 6)
  })

  it('is lower for a skewed distribution than an even one over the same label set', () => {
    const even = shannonEntropyBits(['a', 'b', 'a', 'b'])
    const skewed = shannonEntropyBits(['a', 'a', 'a', 'b'])
    expect(skewed).toBeLessThan(even)
  })

  it('ignores empty-string labels', () => {
    expect(shannonEntropyBits(['', '', ''])).toBe(0)
  })
})

describe('normalisedEntropy', () => {
  it('is 0 for an empty list or a single label', () => {
    expect(normalisedEntropy([])).toBe(0)
    expect(normalisedEntropy(['a', 'a'])).toBe(0)
  })

  it('is 1 for a perfectly even split regardless of how many distinct labels', () => {
    expect(normalisedEntropy(['a', 'b'])).toBeCloseTo(1, 6)
    expect(normalisedEntropy(['a', 'b', 'c', 'd'])).toBeCloseTo(1, 6)
  })

  it('lets a small even rotation and a large even rotation both read as 1', () => {
    // The whole point: a 3-scene show and a 9-scene show, each used evenly,
    // should not be penalised against each other just for pool size.
    const three = normalisedEntropy(['a', 'b', 'c', 'a', 'b', 'c'])
    const nine = normalisedEntropy('abcdefghi'.split('').concat('abcdefghi'.split('')))
    expect(three).toBeCloseTo(1, 6)
    expect(nine).toBeCloseTo(1, 6)
  })

  it('is between 0 and 1 for a skewed multi-label distribution', () => {
    const n = normalisedEntropy(['a', 'a', 'a', 'a', 'b', 'c'])
    expect(n).toBeGreaterThan(0)
    expect(n).toBeLessThan(1)
  })
})

describe('timeToRepeat', () => {
  it('returns the empty result when nothing repeats', () => {
    expect(timeToRepeat([{ t: 0, label: 'a' }, { t: 1, label: 'b' }])).toEqual({
      n: 0,
      meanSec: 0,
      medianSec: 0,
      minSec: 0,
      maxSec: 0,
    })
  })

  it('is empty for zero or one entries', () => {
    expect(timeToRepeat([]).n).toBe(0)
    expect(timeToRepeat([{ t: 0, label: 'a' }]).n).toBe(0)
  })

  it('measures the gap between two occurrences of the same label', () => {
    const s = timeToRepeat([{ t: 0, label: 'a' }, { t: 5, label: 'a' }])
    expect(s.n).toBe(1)
    expect(s.meanSec).toBeCloseTo(5, 6)
    expect(s.minSec).toBeCloseTo(5, 6)
    expect(s.maxSec).toBeCloseTo(5, 6)
  })

  it('aggregates gaps across multiple distinct labels', () => {
    const s = timeToRepeat([
      { t: 0, label: 'a' },
      { t: 2, label: 'b' },
      { t: 4, label: 'a' }, // a: gap 4
      { t: 5, label: 'b' }, // b: gap 3
    ])
    expect(s.n).toBe(2)
    expect(s.minSec).toBeCloseTo(3, 6)
    expect(s.maxSec).toBeCloseTo(4, 6)
  })

  it('tracks three-plus occurrences as successive gaps, not first-to-last', () => {
    const s = timeToRepeat([
      { t: 0, label: 'a' },
      { t: 1, label: 'a' },
      { t: 3, label: 'a' },
    ])
    expect(s.n).toBe(2) // gap 0->1 (1s) and 1->3 (2s), not one 0->3 (3s) gap
    expect(s.meanSec).toBeCloseTo(1.5, 6)
  })

  it('ignores entries with an empty label or a non-finite time', () => {
    const s = timeToRepeat([
      { t: 0, label: '' },
      { t: 1, label: '' },
      { t: NaN, label: 'a' },
      { t: 2, label: 'a' },
    ])
    expect(s.n).toBe(0)
  })

  it('skips a would-be-negative gap rather than propagating it', () => {
    const s = timeToRepeat([
      { t: 5, label: 'a' },
      { t: 1, label: 'a' }, // out of order — must not produce a -4s gap
    ])
    expect(s.n).toBe(0)
  })
})

describe('repeatGapsSec', () => {
  it('matches the count and values timeToRepeat derives its stats from', () => {
    const entries = [
      { t: 0, label: 'a' },
      { t: 2, label: 'b' },
      { t: 4, label: 'a' },
      { t: 5, label: 'b' },
    ]
    const gaps = repeatGapsSec(entries)
    expect(gaps.sort((a, b) => a - b)).toEqual([3, 4])
    expect(timeToRepeat(entries).n).toBe(gaps.length)
  })

  it('is empty when nothing repeats', () => {
    expect(repeatGapsSec([{ t: 0, label: 'a' }, { t: 1, label: 'b' }])).toEqual([])
  })
})

describe('histogramBuckets', () => {
  it('returns an empty array for a non-positive bucket size or bucket count', () => {
    expect(histogramBuckets([1, 2], 0, 5)).toEqual([])
    expect(histogramBuckets([1, 2], 1, 0)).toEqual([])
  })

  it('buckets values into fixed-width bins from zero', () => {
    expect(histogramBuckets([0, 0.5, 1, 1.5, 2], 1, 3)).toEqual([2, 2, 1])
  })

  it('folds overflow into the last bucket instead of growing the array', () => {
    const b = histogramBuckets([0, 100], 1, 3)
    expect(b.length).toBe(3)
    expect(b[2]).toBe(1) // the 100 folded in here
  })

  it('ignores negative or non-finite values', () => {
    expect(histogramBuckets([-1, NaN, Infinity, 0], 1, 3)).toEqual([1, 0, 0])
  })
})
