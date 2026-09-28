import { describe, expect, it } from 'vitest'
import { melBands, melFilterbank } from '../timbreBands'

function spectrumWithPeak(nBins: number, peakBin: number, amp = 1): Float32Array {
  const s = new Float32Array(nBins)
  s[Math.max(0, Math.min(nBins - 1, peakBin))] = amp
  return s
}

function hzToBin(hz: number, sampleRate: number, nBins: number): number {
  return Math.round((hz / (sampleRate / 2)) * (nBins - 1))
}

describe('melBands', () => {
  it('returns exactly nBands values for various band counts', () => {
    const s = new Float32Array(513).fill(0.01)
    expect(melBands(s, 44100, 24)).toHaveLength(24)
    expect(melBands(s, 44100, 12)).toHaveLength(12)
    expect(melBands(s, 44100)).toHaveLength(24) // default
  })

  it('an all-zero spectrum gives an all-low, finite result (no NaN/Infinity)', () => {
    const s = new Float32Array(513)
    const bands = melBands(s, 44100, 24)
    for (const v of bands) {
      expect(Number.isFinite(v)).toBe(true)
      expect(v).toBeCloseTo(0, 6)
    }
  })

  it('energy concentrated near a low frequency peaks in a low band index', () => {
    const sampleRate = 44100
    const nBins = 1025
    const bin = hzToBin(200, sampleRate, nBins)
    const s = spectrumWithPeak(nBins, bin, 50)
    const bands = melBands(s, sampleRate, 24)
    let peakIdx = 0
    for (let i = 1; i < bands.length; i++) if (bands[i] > bands[peakIdx]) peakIdx = i
    expect(peakIdx).toBeLessThan(8)
  })

  it('energy concentrated near a high frequency peaks in a high band index', () => {
    const sampleRate = 44100
    const nBins = 1025
    const bin = hzToBin(6000, sampleRate, nBins)
    const s = spectrumWithPeak(nBins, bin, 50)
    const bands = melBands(s, sampleRate, 24)
    let peakIdx = 0
    for (let i = 1; i < bands.length; i++) if (bands[i] > bands[peakIdx]) peakIdx = i
    expect(peakIdx).toBeGreaterThan(15)
  })

  it('a mid-frequency peak lands strictly between the low- and high-frequency peak bands', () => {
    const sampleRate = 44100
    const nBins = 1025
    const lowBands = melBands(spectrumWithPeak(nBins, hzToBin(200, sampleRate, nBins), 50), sampleRate, 24)
    const midBands = melBands(spectrumWithPeak(nBins, hzToBin(1500, sampleRate, nBins), 50), sampleRate, 24)
    const highBands = melBands(spectrumWithPeak(nBins, hzToBin(6000, sampleRate, nBins), 50), sampleRate, 24)
    const argmax = (b: Float32Array) => {
      let idx = 0
      for (let i = 1; i < b.length; i++) if (b[i] > b[idx]) idx = i
      return idx
    }
    const lowIdx = argmax(lowBands)
    const midIdx = argmax(midBands)
    const highIdx = argmax(highBands)
    expect(midIdx).toBeGreaterThan(lowIdx)
    expect(midIdx).toBeLessThan(highIdx)
  })
})

describe('melFilterbank memoisation', () => {
  it('returns the identical cached object for repeated calls with the same shape', () => {
    const a = melFilterbank(513, 44100, 24)
    const b = melFilterbank(513, 44100, 24)
    expect(a).toBe(b)
  })

  it('builds a distinct filterbank when nBins, sampleRate or nBands differ', () => {
    const base = melFilterbank(513, 44100, 24)
    expect(melFilterbank(1025, 44100, 24)).not.toBe(base)
    expect(melFilterbank(513, 48000, 24)).not.toBe(base)
    expect(melFilterbank(513, 44100, 16)).not.toBe(base)
  })

  it('repeated melBands calls with the same input shape do not rebuild the filterbank', () => {
    const s = new Float32Array(1025).fill(0.02)
    melBands(s, 44100, 24)
    const before = melFilterbank(1025, 44100, 24)
    melBands(s, 44100, 24)
    melBands(s, 44100, 24)
    const after = melFilterbank(1025, 44100, 24)
    expect(after).toBe(before)
  })
})
