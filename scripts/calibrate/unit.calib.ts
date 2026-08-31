/**
 * Synthetic sanity checks for the calibration harness's own machinery — these
 * run under `npm run calibrate` even with no audio present, so a broken FFT or
 * aggregator is caught before a multi-minute corpus run.
 */
import { describe, expect, it } from 'vitest'
import { frequencyDataDb } from './fft'
import { runTrack } from './features'
import { octaveStats, percentile, percentileTable, secondsPerMood } from './report'
import type { FrameSample } from './features'

describe('fft', () => {
  it('puts a pure tone in the expected bin', () => {
    const fftSize = 2048
    const sampleRate = 48000
    const binHz = sampleRate / fftSize
    const targetBin = 64
    const freq = targetBin * binHz
    const frame = new Float32Array(fftSize)
    for (let i = 0; i < fftSize; i++) frame[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate)
    const out = new Float32Array(fftSize / 2)
    frequencyDataDb(frame, fftSize, out)
    let peak = 0
    let peakBin = -1
    for (let k = 1; k < out.length; k++) {
      const lin = 10 ** (out[k] / 20)
      if (lin > peak) {
        peak = lin
        peakBin = k
      }
    }
    expect(Math.abs(peakBin - targetBin)).toBeLessThanOrEqual(1)
  })

  it('floors silent bins rather than returning -Infinity', () => {
    const out = new Float32Array(16)
    frequencyDataDb(new Float32Array(32), 32, out)
    for (const v of out) expect(Number.isFinite(v)).toBe(true)
  })
})

describe('report aggregation', () => {
  it('percentile interpolates', () => {
    expect(percentile([0, 10], 0.5)).toBe(5)
    expect(percentile([0, 1, 2, 3, 4], 0.25)).toBe(1)
  })

  it('percentileTable carries n and mean', () => {
    const t = percentileTable([1, 2, 3, 4])
    expect(t.n).toBe(4)
    expect(t.mean).toBe(2.5)
  })

  it('octaveStats counts a 76<->152 flip against a 152 reference', () => {
    const mk = (bpm: number): FrameSample =>
      ({
        silence: false,
        bpm,
        moodState: 'groove',
        moodConfidence: 0.5,
        moodAmbiguity: 0.3,
        moodChanged: false,
      }) as FrameSample
    const frames = [
      ...Array(40)
        .fill(0)
        .map(() => mk(152)),
      ...Array(40)
        .fill(0)
        .map(() => mk(76)),
      ...Array(40)
        .fill(0)
        .map(() => mk(152)),
    ]
    const s = octaveStats(frames, 152)
    expect(s.flips).toBeGreaterThanOrEqual(1)
    expect(s.halfTempoSampleShare).toBeGreaterThan(0.2)
  })

  it('secondsPerMood sums frame time by state', () => {
    const mk = (moodState: string): FrameSample => ({ moodState }) as FrameSample
    // 1 decimal of rounding in the aggregator — use whole-second spans.
    const frames = [
      ...Array(120)
        .fill(0)
        .map(() => mk('mellow')),
      ...Array(60)
        .fill(0)
        .map(() => mk('groove')),
    ]
    const secs = secondsPerMood(frames, 60)
    expect(secs.mellow).toBeCloseTo(2, 5)
    expect(secs.groove).toBeCloseTo(1, 5)
  })
})

describe('runTrack', () => {
  it('produces a frame stream from a synthetic 120 BPM kick pattern', () => {
    const sampleRate = 48000
    const seconds = 20
    const pcm = new Float32Array(sampleRate * seconds)
    const period = 0.5 // 120 BPM
    for (let beat = 0; beat * period < seconds; beat++) {
      const start = Math.floor(beat * period * sampleRate)
      for (let i = 0; i < 2000 && start + i < pcm.length; i++) {
        const env = Math.exp(-i / 400)
        pcm[start + i] = Math.sin((2 * Math.PI * 60 * i) / sampleRate) * env * 0.8
      }
    }
    const run = runTrack(pcm, sampleRate)
    expect(run.frames.length).toBeGreaterThan(600)
    const last = run.frames[run.frames.length - 1]
    expect(last.bpm).toBeGreaterThan(90)
    expect(last.bpm).toBeLessThan(150)
  })
})
