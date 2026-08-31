import { describe, expect, it } from 'vitest'
import { BLOOM_THRESHOLD_BASE, BLOOM_THRESHOLD_FLOOR, bloomThreshold } from '../bloomParams'

/**
 * bloomThreshold — the gain-relative resting level (audit c10). The property
 * worth defending is that a servo correction changes overall brightness
 * without silently changing how much of the picture blooms.
 */

const base = {
  gain: 1,
  sampled: true,
  gainFloor: 0.35,
  tension: 0,
  drop: false,
  pulse: 0,
}

describe('bloomThreshold — gain relative resting level', () => {
  it('equals the bare constant at rest (gain 1, no pressure)', () => {
    expect(bloomThreshold(base)).toBeCloseTo(BLOOM_THRESHOLD_BASE, 6)
  })

  it('rises when the servo has corrected the frame down (gain < 1)', () => {
    // The concrete case the fix is for: the scenes render hot, gain drops to
    // compensate, and the same pre-gain threshold now needs to be higher to
    // cover the same share of what the viewer actually sees.
    const corrected = bloomThreshold({ ...base, gain: 0.5 })
    expect(corrected).toBeGreaterThan(bloomThreshold(base))
    expect(corrected).toBeCloseTo(BLOOM_THRESHOLD_BASE / 0.5, 6)
  })

  it('falls when the servo has lifted the frame (gain > 1)', () => {
    const lifted = bloomThreshold({ ...base, gain: 1.2 })
    expect(lifted).toBeLessThan(bloomThreshold(base))
  })

  it('falls back to the bare constant before the first exposure sample lands', () => {
    // sampled: false must ignore gain entirely — dividing by an unsampled
    // gain (which may not even be meaningful yet) would be answering a
    // question with no data behind it.
    expect(bloomThreshold({ ...base, sampled: false, gain: 0.2 })).toBeCloseTo(
      BLOOM_THRESHOLD_BASE,
      6,
    )
  })

  it('never lets the gain floor be crossed by a near-zero gain', () => {
    // Without the floor, a gain approaching 0 would send the threshold toward
    // infinity. gainFloor (GAIN_MIN in production) caps how far the divisor
    // can shrink.
    const atFloor = bloomThreshold({ ...base, gain: base.gainFloor })
    const belowFloor = bloomThreshold({ ...base, gain: base.gainFloor / 10 })
    expect(belowFloor).toBeCloseTo(atFloor, 6)
  })
})

describe('bloomThreshold — pressure modulation, unchanged in shape', () => {
  it('still falls as tension rises', () => {
    const calm = bloomThreshold({ ...base, tension: 0 })
    const tense = bloomThreshold({ ...base, tension: 1 })
    expect(tense).toBeLessThan(calm)
  })

  it('still drops further on a beat with a drop active', () => {
    const noDrop = bloomThreshold({ ...base, pulse: 0.5 })
    const drop = bloomThreshold({ ...base, pulse: 0.5, drop: true })
    expect(drop).toBeLessThan(noDrop)
  })

  it('still falls with the beat pulse', () => {
    const rest = bloomThreshold({ ...base, pulse: 0 })
    const onBeat = bloomThreshold({ ...base, pulse: 1 })
    expect(onBeat).toBeLessThan(rest)
  })

  it('layers pressure on top of the gain-relative baseline, not instead of it', () => {
    // A corrected-down frame (higher baseline) under full pressure should
    // still read higher than a resting frame under the same pressure — the
    // two effects add rather than one overriding the other.
    const restingUnderPressure = bloomThreshold({ ...base, tension: 1, pulse: 1, drop: true })
    const correctedUnderPressure = bloomThreshold({
      ...base,
      gain: 0.5,
      tension: 1,
      pulse: 1,
      drop: true,
    })
    expect(correctedUnderPressure).toBeGreaterThan(restingUnderPressure)
  })
})

describe('bloomThreshold — the floor', () => {
  it('never returns below BLOOM_THRESHOLD_FLOOR under maximum pressure', () => {
    const min = bloomThreshold({ ...base, gain: base.gainFloor, tension: 1, pulse: 1, drop: true })
    expect(min).toBeGreaterThanOrEqual(BLOOM_THRESHOLD_FLOOR)
  })

  it('never returns below the floor even with a very low gain', () => {
    const min = bloomThreshold({ ...base, gain: 5, tension: 1, pulse: 1, drop: true })
    expect(min).toBeGreaterThanOrEqual(BLOOM_THRESHOLD_FLOOR)
  })
})

describe('bloomThreshold — totality', () => {
  it('is finite and at or above the floor for every garbage input', () => {
    const garbageInputs = [
      { ...base, gain: NaN },
      { ...base, gain: Infinity },
      { ...base, gain: -Infinity },
      { ...base, gain: 0 },
      { ...base, gainFloor: NaN },
      { ...base, gainFloor: 0 },
      { ...base, gainFloor: -1 },
      { ...base, tension: NaN },
      { ...base, pulse: NaN },
      { ...base, tension: Infinity, pulse: Infinity, drop: true },
    ]
    for (const g of garbageInputs) {
      const value = bloomThreshold(g)
      expect(Number.isFinite(value), JSON.stringify(g)).toBe(true)
      expect(value, JSON.stringify(g)).toBeGreaterThanOrEqual(BLOOM_THRESHOLD_FLOOR)
    }
  })
})
