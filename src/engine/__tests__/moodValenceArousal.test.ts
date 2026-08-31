import { describe, expect, it } from 'vitest'
import { MOOD_STATES } from '../../audio/types'
import { deriveVA, deriveVAFromList, MOOD_VA } from '../moodValenceArousal'

describe('MOOD_VA', () => {
  it('places every mood', () => {
    for (const mood of MOOD_STATES) {
      expect(MOOD_VA[mood], mood).toBeDefined()
      expect(MOOD_VA[mood].valence).toBeGreaterThanOrEqual(-1)
      expect(MOOD_VA[mood].valence).toBeLessThanOrEqual(1)
      expect(MOOD_VA[mood].arousal).toBeGreaterThanOrEqual(0)
      expect(MOOD_VA[mood].arousal).toBeLessThanOrEqual(1)
    }
  })

  it('orders arousal the way the mood ladder itself is documented to', () => {
    // silence/ambient calm, groove/building mid-to-high, peak/aggressive the
    // top — MoodEstimator's own thresholds place `peak`/`aggressive` as "the
    // genuine top tail", not just above-average.
    expect(MOOD_VA.silence.arousal).toBeLessThan(MOOD_VA.ambient.arousal)
    expect(MOOD_VA.ambient.arousal).toBeLessThan(MOOD_VA.mellow.arousal)
    expect(MOOD_VA.mellow.arousal).toBeLessThan(MOOD_VA.groove.arousal)
    expect(MOOD_VA.groove.arousal).toBeLessThan(MOOD_VA.building.arousal)
    expect(MOOD_VA.building.arousal).toBeLessThan(MOOD_VA.peak.arousal)
  })

  it('gives peak and aggressive nearly the same arousal but opposite valence', () => {
    // The whole reason there are two hot moods rather than one — see the
    // module's own header.
    expect(Math.abs(MOOD_VA.peak.arousal - MOOD_VA.aggressive.arousal)).toBeLessThan(0.1)
    expect(MOOD_VA.peak.valence).toBeGreaterThan(0)
    expect(MOOD_VA.aggressive.valence).toBeLessThan(0)
  })

  it('gives building a negative valence unlike every other non-aggressive mood', () => {
    // Anticipation, not pleasure — see the header's defence of this one.
    expect(MOOD_VA.building.valence).toBeLessThan(0)
    for (const mood of ['ambient', 'mellow', 'groove', 'peak'] as const) {
      expect(MOOD_VA[mood].valence).toBeGreaterThan(MOOD_VA.building.valence)
    }
  })
})

describe('deriveVA', () => {
  it('returns exactly a mood point when weighted entirely on that mood', () => {
    expect(deriveVA({ peak: 1 })).toEqual(MOOD_VA.peak)
  })

  it('is the weighted average of the moods given', () => {
    const half = deriveVA({ mellow: 1, peak: 1 })
    expect(half.valence).toBeCloseTo((MOOD_VA.mellow.valence + MOOD_VA.peak.valence) / 2, 6)
    expect(half.arousal).toBeCloseTo((MOOD_VA.mellow.arousal + MOOD_VA.peak.arousal) / 2, 6)
  })

  it('weights proportionally, not just by presence', () => {
    const mostlyMellow = deriveVA({ mellow: 9, peak: 1 })
    const mostlyPeak = deriveVA({ mellow: 1, peak: 9 })
    expect(mostlyMellow.arousal).toBeLessThan(mostlyPeak.arousal)
  })

  it('ignores a zero, negative, or non-finite weight', () => {
    const withJunk = deriveVA({ mellow: 1, peak: 0, aggressive: -5, groove: NaN })
    expect(withJunk).toEqual(MOOD_VA.mellow)
  })

  it('returns the origin-ish silence point for an empty or all-junk map', () => {
    expect(deriveVA({})).toEqual({ valence: 0, arousal: 0 })
    expect(deriveVA({ peak: 0, groove: NaN })).toEqual({ valence: 0, arousal: 0 })
  })

  it('reproduces a real scene moodFit table sensibly', () => {
    // dissolve's actual moodFit from scenes/index.ts.
    const dissolveFit = { groove: 0.7, building: 0.84, peak: 0.94, aggressive: 0.9 }
    const va = deriveVA(dissolveFit)
    // Weighted toward the hot end (peak/aggressive carry the most weight),
    // so arousal should read high.
    expect(va.arousal).toBeGreaterThan(0.7)
  })
})

describe('deriveVAFromList', () => {
  it('is deriveVA with equal weight per listed mood', () => {
    expect(deriveVAFromList(['mellow', 'peak'])).toEqual(deriveVA({ mellow: 1, peak: 1 }))
  })

  it('counts a repeated mood as extra weight', () => {
    const weighted = deriveVAFromList(['mellow', 'mellow', 'peak'])
    const even = deriveVAFromList(['mellow', 'peak'])
    // Repeating mellow should pull the result toward mellow's (lower) arousal.
    expect(weighted.arousal).toBeLessThan(even.arousal)
  })

  it('returns the empty-map default for an empty list', () => {
    expect(deriveVAFromList([])).toEqual({ valence: 0, arousal: 0 })
  })
})
