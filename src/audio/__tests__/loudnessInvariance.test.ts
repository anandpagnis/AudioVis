import { describe, expect, it } from 'vitest'
import { BandNormalizer } from '../bandNormalizer'
import {
  computeLowBands,
  computeSpectralBands,
  writeLinearSpectrum,
} from '../spectralFeatures'
import { createEmptyFeatures } from '../types'

/**
 * Item 5 of the DSP audit. Two things:
 *
 *  1. `getFloatFrequencyData` is NOT clamped by `minDecibels`/`maxDecibels` in
 *     Chromium — those only affect `getByteFrequencyData`, which this codebase
 *     never calls. Verified empirically (an oscillator at +18 dBFS through an
 *     `OfflineAudioContext` analyser read the same bin value with
 *     `maxDecibels` set to −30, −10, and 0, and un-set). So there is no
 *     analyser-property change to make; the concern the audit raised —
 *     loudness invariance breaking on hot masters — is guarded here instead,
 *     through the real dB→linear→band→BandNormalizer path.
 *
 *  2. Because the float path is unclamped, a hot master genuinely produces
 *     `f.spectrum` bins above 1.0 linear, violating the "0..1 per bin"
 *     contract. `writeLinearSpectrum` clamps them.
 */

const FFT_LEN = 1024 // FFT_SIZE / 2
const LOW_LEN = 4096 // LOW_FFT_SIZE / 2
const SR = 44100
const BIN_HZ = SR / 2 / FFT_LEN
const LOW_BIN_HZ = SR / 2 / LOW_LEN
const DT = 1 / 60

/** A music-like dB spectrum: a bass tone, a mid tone, a hat, over a floor. */
function refSpectrum(len: number, floorDb = -90): Float32Array {
  const db = new Float32Array(len).fill(floorDb)
  db[Math.round(60 / (SR / 2 / len))] = -8 // ~60 Hz
  db[Math.round(1500 / (SR / 2 / len))] = -14 // ~1.5 kHz
  db[Math.round(8000 / (SR / 2 / len))] = -20 // ~8 kHz
  return db
}

/** Run `frames` of the same spectrum, offset by `gainDb`, through the band +
 *  normalizer path; return the last normalized value for one band. */
function normalizedBand(
  pick: (r: ReturnType<typeof computeSpectralBands>) => number,
  gainDb: number,
  frames = 400,
): number {
  const norm = new BandNormalizer()
  const prevMag = new Float32Array(FFT_LEN)
  const base = refSpectrum(FFT_LEN)
  const db = new Float32Array(FFT_LEN)
  let out = 0
  for (let i = 0; i < frames; i++) {
    for (let k = 0; k < FFT_LEN; k++) db[k] = base[k] + gainDb
    const r = computeSpectralBands(db, prevMag, BIN_HZ)
    out = norm.update(pick(r), DT, false, 1, 1)
  }
  return out
}

describe('loudness invariance through the real dB→band→normalizer path', () => {
  it('normalized bass is identical across a ±20 dB input-level swing', () => {
    const quiet = normalizedBand((r) => r.bass, -20)
    const unity = normalizedBand((r) => r.bass, 0)
    const hot = normalizedBand((r) => r.bass, +20)
    expect(quiet).toBeCloseTo(unity, 6)
    expect(hot).toBeCloseTo(unity, 6)
  })

  it('normalized high (an upper band the old absolute floor used to crush) is level-independent too', () => {
    const quiet = normalizedBand((r) => r.high, -20)
    const hot = normalizedBand((r) => r.high, +20)
    expect(quiet).toBeCloseTo(hot, 6)
  })

  it('the dedicated low-frequency path is loudness-invariant as well', () => {
    const run = (gainDb: number) => {
      const norm = new BandNormalizer()
      const base = refSpectrum(LOW_LEN)
      const db = new Float32Array(LOW_LEN)
      let out = 0
      for (let i = 0; i < 400; i++) {
        for (let k = 0; k < LOW_LEN; k++) db[k] = base[k] + gainDb
        out = norm.update(computeLowBands(db, LOW_BIN_HZ).sub, DT, false, 1, 1)
      }
      return out
    }
    expect(run(-20)).toBeCloseTo(run(0), 6)
    expect(run(+20)).toBeCloseTo(run(0), 6)
  })
})

describe('f.spectrum 0..1 contract', () => {
  it('clamps hot bins that a real (unclamped) AnalyserNode would report above 1.0 linear', () => {
    const db = new Float32Array(FFT_LEN).fill(-90)
    db[5] = +6 // ~2.0 linear — a real getFloatFrequencyData returns values like this
    db[6] = +14 // ~5.0 linear
    const out = new Float32Array(FFT_LEN)
    writeLinearSpectrum(db, out)
    expect(out[5]).toBe(1)
    expect(out[6]).toBe(1)
    for (const v of out) expect(v).toBeLessThanOrEqual(1)
  })

  it('leaves in-range bins untouched', () => {
    const db = new Float32Array(FFT_LEN).fill(-90)
    db[10] = -20 // 0.1 linear exactly
    const out = new Float32Array(FFT_LEN)
    writeLinearSpectrum(db, out)
    expect(out[10]).toBeCloseTo(0.1, 6)
  })

  it('writes exactly f.spectrum.length bins, and that length is FFT_SIZE/2 = 1024', () => {
    const f = createEmptyFeatures()
    expect(f.spectrum.length).toBe(1024)
    const db = new Float32Array(1024).fill(-40)
    writeLinearSpectrum(db, f.spectrum)
    // full Nyquist coverage — the upper half is now real data, not left at 0
    expect(f.spectrum[1000]).toBeGreaterThan(0)
  })
})
