import { describe, expect, it } from 'vitest'
import { frequencyDataDb } from '../../../scripts/calibrate/fft'
import { HarmonicTensionEstimator, type HarmonicTensionRead } from '../harmonicTension'

/**
 * Tension tests on real 8192-point Blackman FFTs of synthesised audio (the
 * calibration harness's AnalyserNode-equivalent). Only MONOTONIC / ordering
 * claims are asserted: the absolute values are judgement-scaled, not fitted.
 */

const FFT = 8192
const SR = 44100
const DT = 0.05

function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const midiHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12)

/** Sum of harmonic tones (1/h partials, random phases) → 8192-bin dB spectrum. */
function toneSpectrum(midis: number[], gain = 0.1, harmonics = 5, seed = 1): Float32Array {
  const frame = new Float32Array(FFT)
  const r = rng(seed)
  for (const m of midis) {
    for (let h = 1; h <= harmonics; h++) {
      const w = (2 * Math.PI * midiHz(m) * h) / SR
      const ph = r() * 2 * Math.PI
      const a = gain / h
      for (let i = 0; i < FFT; i++) frame[i] += a * Math.sin(w * i + ph)
    }
  }
  const out = new Float32Array(FFT / 2)
  frequencyDataDb(frame, FFT, out)
  return out
}

function noiseSpectra(count: number, level = 0.3): Float32Array[] {
  const r = rng(99)
  const res: Float32Array[] = []
  for (let k = 0; k < count; k++) {
    const frame = new Float32Array(FFT)
    for (let i = 0; i < FFT; i++) frame[i] = level * (r() * 2 - 1)
    const out = new Float32Array(FFT / 2)
    frequencyDataDb(frame, FFT, out)
    res.push(out)
  }
  return res
}

function measure(spectra: Float32Array[], seconds = 4): HarmonicTensionRead {
  const est = new HarmonicTensionEstimator()
  const n = Math.round(seconds / DT)
  for (let i = 0; i < n; i++) est.update(spectra[i % spectra.length], SR, DT)
  return { ...est.read() }
}

describe('HarmonicTensionEstimator', () => {
  const C4 = 60
  const fifth = measure([toneSpectrum([C4, C4 + 7])])
  const triad = measure([toneSpectrum([C4, C4 + 4, C4 + 7])])
  const single = measure([toneSpectrum([C4])])
  const semis3 = measure([toneSpectrum([C4, C4 + 1, C4 + 2])])
  const semis4 = measure([toneSpectrum([C4, C4 + 1, C4 + 2, C4 + 3])])
  const tritones = measure([toneSpectrum([C4, C4 + 6, C4 + 12, C4 + 18])])
  const noise = measure(noiseSpectra(8))

  it('all outputs are finite and within 0..1', () => {
    for (const r of [fifth, triad, single, semis3, semis4, tritones, noise]) {
      for (const v of [r.roughness, r.dissonance, r.tonalness, r.tension]) {
        expect(Number.isFinite(v)).toBe(true)
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(1)
      }
    }
  })

  it('a consonant fifth and major triad are smoother than a semitone cluster', () => {
    console.info('[harmonicTension]', { single, fifth, triad, semis3, semis4, tritones, noise })
    expect(fifth.roughness).toBeLessThan(semis3.roughness)
    expect(triad.roughness).toBeLessThan(semis3.roughness)
    expect(fifth.dissonance).toBeLessThan(semis3.dissonance)
    expect(triad.dissonance).toBeLessThan(semis3.dissonance)
    expect(triad.tension).toBeLessThan(semis3.tension)
    expect(fifth.tension).toBeLessThan(semis3.tension)
  })

  it('a tritone stack is rougher and more tense than a fifth (a wide tritone stack can still read smoother than a close-voiced triad: PL roughness is register-dependent)', () => {
    expect(tritones.roughness).toBeGreaterThan(fifth.roughness)
    expect(tritones.dissonance).toBeGreaterThan(fifth.dissonance)
    expect(tritones.tension).toBeGreaterThan(fifth.tension)
  })

  it('climbs a consonance ladder: single tone < fifth < triad < 3-semitone cluster <= 4-semitone cluster', () => {
    const ladder = [single, fifth, triad, semis3, semis4]
    for (let i = 1; i < ladder.length; i++) {
      expect(ladder[i].roughness).toBeGreaterThanOrEqual(ladder[i - 1].roughness - 0.02)
      expect(ladder[i].tension).toBeGreaterThanOrEqual(ladder[i - 1].tension - 0.02)
    }
    expect(semis3.roughness).toBeGreaterThan(single.roughness + 0.3)
  })

  it('adding adjacent semitones never reduces dissonance (single < 3-cluster <= 4-cluster)', () => {
    expect(single.dissonance).toBeLessThan(semis3.dissonance)
    expect(semis4.dissonance).toBeGreaterThanOrEqual(semis3.dissonance - 0.03)
  })

  it('white noise is atonal (low tonalness) and rough, but NOT "dissonant" (no pitched partials to clash)', () => {
    expect(noise.tonalness).toBeLessThan(0.2)
    expect(noise.tonalness).toBeLessThan(triad.tonalness)
    expect(noise.roughness).toBeGreaterThan(triad.roughness)
    expect(noise.dissonance).toBeLessThan(semis3.dissonance)
  })

  it('clean tones are highly tonal', () => {
    expect(single.tonalness).toBeGreaterThan(0.5)
    expect(triad.tonalness).toBeGreaterThan(0.5)
  })

  it('tension ranks: a consonant fifth is below noise, and a triad is below a semitone cluster', () => {
    expect(fifth.tension).toBeLessThan(noise.tension)
    expect(triad.tension).toBeLessThan(semis3.tension)
  })

  it('is loudness-invariant: the same chord 20 dB quieter reads the same', () => {
    const loud = measure([toneSpectrum([C4, C4 + 1, C4 + 5], 0.2)])
    const quiet = measure([toneSpectrum([C4, C4 + 1, C4 + 5], 0.02)])
    expect(Math.abs(loud.roughness - quiet.roughness)).toBeLessThan(0.05)
    expect(Math.abs(loud.tension - quiet.tension)).toBeLessThan(0.05)
  })

  it('is not valid for silence; valid after ~1 s of signal; lapses after ~1 s of silence again', () => {
    const est = new HarmonicTensionEstimator()
    const silent = new Float32Array(FFT / 2).fill(-Infinity)
    for (let i = 0; i < 40; i++) est.update(silent, SR, DT)
    expect(est.read().valid).toBe(false)
    const tone = toneSpectrum([C4, C4 + 7])
    est.update(tone, SR, DT)
    expect(est.read().valid).toBe(false)
    for (let i = 0; i < 30; i++) est.update(tone, SR, DT)
    expect(est.read().valid).toBe(true)
    for (let i = 0; i < 5; i++) est.update(silent, SR, DT) // brief dropout: holds
    expect(est.read().valid).toBe(true)
    for (let i = 0; i < 40; i++) est.update(silent, SR, DT)
    expect(est.read().valid).toBe(false)
  })

  it('reset() clears state; read() returns a reused object', () => {
    const est = new HarmonicTensionEstimator()
    const tone = toneSpectrum([C4, C4 + 1])
    for (let i = 0; i < 60; i++) est.update(tone, SR, DT)
    const a = est.read()
    expect(a.valid).toBe(true)
    est.reset()
    const b = est.read()
    expect(b).toBe(a)
    expect(b.valid).toBe(false)
    expect(b.tension).toBe(0)
  })

  it('accepts linear magnitudes and agrees with dB input', () => {
    const db = toneSpectrum([C4, C4 + 1, C4 + 2])
    const lin = new Float32Array(db.length)
    for (let i = 0; i < db.length; i++) lin[i] = Math.pow(10, db[i] / 20)
    const est = new HarmonicTensionEstimator({ input: 'linear' })
    for (let i = 0; i < 80; i++) est.update(lin, SR, DT)
    const r = est.read()
    expect(Math.abs(r.tension - semis3.tension)).toBeLessThan(0.05)
    expect(Math.abs(r.tonalness - semis3.tonalness)).toBeLessThan(0.05)
  })

  it('costs well under a frame budget per update (micro-benchmark, generous bound)', () => {
    const busy = toneSpectrum([C4, C4 + 1, C4 + 4, C4 + 7, C4 + 10, C4 - 12], 0.06, 8)
    const est = new HarmonicTensionEstimator({ intervalSec: 0.005 }) // process every call
    for (let i = 0; i < 50; i++) est.update(busy, SR, DT)
    const N = 500
    const t0 = performance.now()
    for (let i = 0; i < N; i++) est.update(busy, SR, DT)
    const perMs = (performance.now() - t0) / N
    console.info(`[harmonicTension] update: ${perMs.toFixed(3)} ms per processed frame`)
    expect(perMs).toBeLessThan(1)
  })
})
