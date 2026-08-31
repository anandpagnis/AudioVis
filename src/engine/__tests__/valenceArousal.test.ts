import { describe, expect, it } from 'vitest'
import { createEmptyFeatures, type AudioFeatures } from '../../audio/types'
import { computeValenceArousal, vaDistance } from '../valenceArousal'

/**
 * The continuous replacement for routing every visual decision through the
 * 7-way mood label. These pin DIRECTION, not exact magnitude — there is no
 * labelled dataset behind the weights, and the module's own header says so.
 */

const f = (overrides: Partial<AudioFeatures>): AudioFeatures => ({
  ...createEmptyFeatures(),
  ...overrides,
})

describe('computeValenceArousal — arousal axis', () => {
  it('reads near zero on silence', () => {
    const { arousal } = computeValenceArousal(f({ energy: 0, loudness: 0, bpm: 0 }))
    expect(arousal).toBeCloseTo(0, 5)
  })

  it('rises monotonically with energy', () => {
    const low = computeValenceArousal(f({ energy: 0.1, loudness: 0.1 })).arousal
    const mid = computeValenceArousal(f({ energy: 0.5, loudness: 0.1 })).arousal
    const high = computeValenceArousal(f({ energy: 0.9, loudness: 0.1 })).arousal
    expect(low).toBeLessThan(mid)
    expect(mid).toBeLessThan(high)
  })

  it('rises with tempo, holding energy fixed', () => {
    const slow = computeValenceArousal(f({ energy: 0.4, bpm: 70 })).arousal
    const fast = computeValenceArousal(f({ energy: 0.4, bpm: 170 })).arousal
    expect(fast).toBeGreaterThan(slow)
  })

  it('rises with tension even when the music is quiet', () => {
    // The literal case tension exists to describe — the bar before a drop.
    const quiet = f({ energy: 0.1, loudness: 0.05, bpm: 90 })
    const withoutTension = computeValenceArousal(quiet, 0).arousal
    const withTension = computeValenceArousal(quiet, 0.9).arousal
    expect(withTension).toBeGreaterThan(withoutTension)
  })

  it('stays within 0..1 at every extreme', () => {
    const extremeHigh = computeValenceArousal(f({ energy: 1, loudness: 1, bpm: 300 }), 1).arousal
    const extremeLow = computeValenceArousal(f({ energy: 0, loudness: 0, bpm: 0 }), 0).arousal
    expect(extremeHigh).toBeLessThanOrEqual(1)
    expect(extremeHigh).toBeGreaterThanOrEqual(0)
    expect(extremeLow).toBeLessThanOrEqual(1)
    expect(extremeLow).toBeGreaterThanOrEqual(0)
  })

  it('treats a BPM at or below the working floor as the same as unset', () => {
    const unset = computeValenceArousal(f({ energy: 0.5, bpm: 0 })).arousal
    const atFloor = computeValenceArousal(f({ energy: 0.5, bpm: 60 })).arousal
    expect(unset).toBeCloseTo(atFloor, 5)
  })
})

describe('computeValenceArousal — valence axis', () => {
  it('reads neutral (0) when scale is unknown, centroid and flatness are mid-range', () => {
    const { valence } = computeValenceArousal(
      f({ scale: '', centroid: 0.5, spectralFlatness: 0.5 }),
    )
    expect(valence).toBeCloseTo(0, 5)
  })

  it('reads more positive for major than minor, all else equal', () => {
    const base = { centroid: 0.5, spectralFlatness: 0.5 }
    const major = computeValenceArousal(f({ ...base, scale: 'major' })).valence
    const minor = computeValenceArousal(f({ ...base, scale: 'minor' })).valence
    expect(major).toBeGreaterThan(minor)
    expect(major).toBeGreaterThan(0)
    expect(minor).toBeLessThan(0)
  })

  it('does not guess when the key has not been detected', () => {
    // '' must not read as "minor" or "major" — it is "unknown", and the
    // header is explicit that this contributes zero rather than guessing.
    const withKey = computeValenceArousal(
      f({ scale: 'major', centroid: 0.5, spectralFlatness: 0.5 }),
    ).valence
    const withoutKey = computeValenceArousal(
      f({ scale: '', centroid: 0.5, spectralFlatness: 0.5 }),
    ).valence
    expect(withKey).toBeGreaterThan(withoutKey)
  })

  it('rises with spectral brightness', () => {
    const dark = computeValenceArousal(f({ centroid: 0.1, spectralFlatness: 0.5, scale: '' })).valence
    const bright = computeValenceArousal(f({ centroid: 0.9, spectralFlatness: 0.5, scale: '' })).valence
    expect(bright).toBeGreaterThan(dark)
  })

  it('reads more positive for tonal/harmonic texture than noisy/distorted', () => {
    const tonal = computeValenceArousal(f({ spectralFlatness: 0.05, centroid: 0.5, scale: '' })).valence
    const noisy = computeValenceArousal(f({ spectralFlatness: 0.95, centroid: 0.5, scale: '' })).valence
    expect(tonal).toBeGreaterThan(noisy)
  })

  it('stays within -1..1 at every extreme', () => {
    const mostPositive = computeValenceArousal(
      f({ scale: 'major', centroid: 1, spectralFlatness: 0 }),
    ).valence
    const mostNegative = computeValenceArousal(
      f({ scale: 'minor', centroid: 0, spectralFlatness: 1 }),
    ).valence
    expect(mostPositive).toBeLessThanOrEqual(1)
    expect(mostNegative).toBeGreaterThanOrEqual(-1)
  })
})

describe('computeValenceArousal — totality', () => {
  it('never returns NaN or an out-of-range value on garbage input', () => {
    const garbage: Partial<AudioFeatures>[] = [
      { energy: NaN, loudness: NaN, bpm: NaN, centroid: NaN, spectralFlatness: NaN },
      { energy: Infinity, loudness: -Infinity, bpm: -50 },
      { energy: -5, loudness: 5, centroid: -2, spectralFlatness: 3 },
    ]
    for (const g of garbage) {
      const { valence, arousal } = computeValenceArousal(f(g), NaN)
      expect(Number.isFinite(valence), JSON.stringify(g)).toBe(true)
      expect(Number.isFinite(arousal), JSON.stringify(g)).toBe(true)
      expect(valence).toBeGreaterThanOrEqual(-1)
      expect(valence).toBeLessThanOrEqual(1)
      expect(arousal).toBeGreaterThanOrEqual(0)
      expect(arousal).toBeLessThanOrEqual(1)
    }
  })

  it('defaults tension to 0 when the caller has none to pass', () => {
    const withDefault = computeValenceArousal(f({ energy: 0.5 }))
    const withExplicitZero = computeValenceArousal(f({ energy: 0.5 }), 0)
    expect(withDefault).toEqual(withExplicitZero)
  })
})

describe('vaDistance', () => {
  it('is zero for identical points', () => {
    const p = { valence: 0.3, arousal: 0.6 }
    expect(vaDistance(p, { ...p })).toBeCloseTo(0, 10)
  })

  it('is symmetric', () => {
    const a = { valence: -0.4, arousal: 0.8 }
    const b = { valence: 0.6, arousal: 0.1 }
    expect(vaDistance(a, b)).toBeCloseTo(vaDistance(b, a), 10)
  })

  it('matches the plain Euclidean distance on the raw axes', () => {
    const a = { valence: 0, arousal: 0 }
    const b = { valence: 3, arousal: 4 }
    expect(vaDistance(a, b)).toBeCloseTo(5, 10)
  })
})
