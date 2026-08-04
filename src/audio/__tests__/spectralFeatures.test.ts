import { describe, expect, it } from 'vitest'
import { computeSpectralBands } from '../spectralFeatures'

const FFT_LEN = 1024 // FFT_SIZE / 2, matching AudioEngine
const SAMPLE_RATE = 44100
const BIN_HZ = SAMPLE_RATE / 2 / FFT_LEN // ~21.53 Hz/bin

function silentDb(len = FFT_LEN): Float32Array {
  return new Float32Array(len).fill(-100)
}

function freshPrevMag(): Float32Array {
  return new Float32Array(FFT_LEN)
}

describe('computeSpectralBands', () => {
  it('reports low spectral flatness for a single dominant tone', () => {
    const db = silentDb()
    db[50] = 0 // one loud bin amid near-silence
    const r = computeSpectralBands(db, freshPrevMag(), BIN_HZ)
    expect(r.spectralFlatness).toBeLessThan(0.15)
  })

  it('reports high spectral flatness for a flat (white-noise-like) spectrum', () => {
    const db = new Float32Array(FFT_LEN).fill(-20)
    const r = computeSpectralBands(db, freshPrevMag(), BIN_HZ)
    expect(r.spectralFlatness).toBeGreaterThan(0.6)
  })

  it('isolates bass from mid/high/air when energy is concentrated below 160 Hz', () => {
    const db = silentDb()
    const bassEnd = Math.ceil(160 / BIN_HZ)
    for (let i = 1; i < bassEnd; i++) db[i] = 0
    const r = computeSpectralBands(db, freshPrevMag(), BIN_HZ)
    expect(r.bass).toBeGreaterThan(r.mid * 5)
    expect(r.high).toBeLessThan(0.01)
    expect(r.air).toBeLessThan(0.01)
  })

  it('keeps `air` and `high` independently controllable (energy above 9 kHz never reaches `high`)', () => {
    const db = silentDb()
    const highEnd = Math.ceil(9000 / BIN_HZ)
    const airEnd = Math.ceil(16000 / BIN_HZ)
    for (let i = highEnd; i < airEnd; i++) db[i] = 0 // loud only in the air range
    const r = computeSpectralBands(db, freshPrevMag(), BIN_HZ)
    expect(r.high).toBeLessThan(0.01)
    expect(r.air).toBeGreaterThan(0.5)
  })

  it('rolloff sits lower when energy concentrates in the bottom half of the band, higher for the top half', () => {
    const highEnd = Math.ceil(9000 / BIN_HZ)
    const mid = Math.floor(highEnd / 2)

    // NOTE: computeSpectralBands returns a REUSED object, so each result must
    // be read out before the next call rather than held as a reference.
    const lowHalf = silentDb()
    for (let i = 1; i < mid; i++) lowHalf[i] = 0
    const rolloffLow = computeSpectralBands(lowHalf, freshPrevMag(), BIN_HZ).spectralRolloff

    const highHalf = silentDb()
    for (let i = mid; i < highEnd; i++) highHalf[i] = 0
    const rolloffHigh = computeSpectralBands(highHalf, freshPrevMag(), BIN_HZ).spectralRolloff

    expect(rolloffLow).toBeLessThan(0.6)
    expect(rolloffHigh).toBeGreaterThan(rolloffLow)
  })

  it('separates kick/snare/hihat flux by band — energy in one must not leak into the others', () => {
    // Bin indices for the middle of each drum band (binHz ~= 21.5).
    const kickBin = Math.round(60 / BIN_HZ) // ~2.8k Hz below kick's 120Hz top
    const snareBin = Math.round(250 / BIN_HZ)
    const hihatBin = Math.round(9000 / BIN_HZ) // deliberately above highEnd

    for (const [name, bin] of [
      ['kick', kickBin],
      ['snare', snareBin],
      ['hihat', hihatBin],
    ] as const) {
      const prevMag = freshPrevMag()
      computeSpectralBands(silentDb(), prevMag, BIN_HZ) // establish baseline
      const loud = silentDb()
      loud[bin] = 0 // one loud bin in this drum's band
      const r = computeSpectralBands(loud, prevMag, BIN_HZ)
      const got = { kick: r.kickFlux, snare: r.snareFlux, hihat: r.hihatFlux }
      expect(got[name]).toBeGreaterThan(0)
      for (const other of ['kick', 'snare', 'hihat'] as const) {
        if (other !== name) expect(got[other]).toBeCloseTo(0, 6)
      }
    }
  })

  it('hihat flux above the 9kHz main-loop ceiling settles instead of spiking every frame', () => {
    // Regression guard: the air-band pass must carry prevMag forward for its
    // bins. If it does not, every frame diffs against zero and reports a
    // permanent false hi-hat.
    const prevMag = freshPrevMag()
    const steady = silentDb()
    steady[Math.round(10000 / BIN_HZ)] = 0 // constant tone above highEnd
    computeSpectralBands(steady, prevMag, BIN_HZ)
    const second = computeSpectralBands(steady, prevMag, BIN_HZ)
    expect(second.hihatFlux).toBeCloseTo(0, 6)
  })

  it('bassFlux is half-wave rectified: rises on an onset, drops to ~0 on decay', () => {
    const prevMag = freshPrevMag()
    const quiet = silentDb()
    const loud = silentDb()
    loud[5] = 0 // a bass bin (bassEnd ~= 8), well within the bass range

    computeSpectralBands(quiet, prevMag, BIN_HZ) // establish baseline in prevMag
    const rising = computeSpectralBands(loud, prevMag, BIN_HZ)
    expect(rising.bassFlux).toBeGreaterThan(0)

    const falling = computeSpectralBands(quiet, prevMag, BIN_HZ)
    expect(falling.bassFlux).toBeCloseTo(0, 6)
  })
})
