import { describe, expect, it } from 'vitest'
import {
  gapPercentile,
  hitRate,
  makeStream,
  medianBars,
  runDirector,
  runLegacy,
  sampleNovelty,
} from './cadenceSim'

/**
 * The offline proof that the redesign fixes the complaint ("it changes scenes at times uncorrelated with the music and
 * misses the real changes"): a long, noisy, realistic event stream is fed to the pure director and to an inline model
 * of the legacy show (32-beat dwell, first opportunity, edges discarded during the dwell). See `cadenceSim.ts` for the
 * stream and both models. Nothing here touches React, the store or audio: it is arithmetic on the policy.
 */

const SEEDS = [1, 2, 3, 4]

describe('cadence simulation, 120 BPM, noise ~1 per 8 s + a true strong change every 16-32 bars', () => {
  const runs = SEEDS.map((seed) => {
    const stream = makeStream({ seed, bpm: 120, beats: 24000, noiseGapSec: 8 })
    return { stream, director: runDirector(stream), legacy: runLegacy(stream) }
  })

  it('the stream is what it says it is', () => {
    for (const { stream } of runs) {
      // ~1 noise event per 8 s = per 16 beats, plus a true one every 16-32 bars.
      let n = 0
      for (const list of stream.byBeat.values()) n += list.length
      const noise = n - stream.trueBeats.length
      expect(noise / (stream.beats / 16)).toBeGreaterThan(0.85)
      expect(noise / (stream.beats / 16)).toBeLessThan(1.15)
      const gaps = stream.trueBeats.slice(1).map((b, k) => (b - stream.trueBeats[k]) / 4)
      expect(Math.min(...gaps)).toBeGreaterThanOrEqual(16)
      expect(Math.max(...gaps)).toBeLessThanOrEqual(32)
    }
    // the novelty sampler reproduces the measured percentiles
    expect(sampleNovelty(0.1)).toBeCloseTo(0.48)
    expect(sampleNovelty(0.5)).toBeCloseTo(0.64)
    expect(sampleNovelty(0.9)).toBeCloseTo(1.11)
  })

  it('median scene interval is 8-16 bars, with 90% of intervals inside 4-32 bars', () => {
    for (const { director } of runs) {
      const m = medianBars(director.commits)
      expect(m).toBeGreaterThanOrEqual(8)
      expect(m).toBeLessThanOrEqual(16)
      expect(gapPercentile(director.commits, 0.05)).toBeGreaterThanOrEqual(4)
      expect(gapPercentile(director.commits, 0.95)).toBeLessThanOrEqual(32)
    }
  })

  it('at most 25% of the cuts are forced by the ceiling (the rest follow the music)', () => {
    for (const { director } of runs) {
      expect(director.forced / director.commits.length).toBeLessThanOrEqual(0.25)
    }
  })

  it('answers the true strong changes within one bar far more often than the legacy show', () => {
    let dSum = 0
    let lSum = 0
    for (const { stream, director, legacy } of runs) {
      const d = hitRate(director.commits, stream.trueBeats)
      const l = hitRate(legacy.commits, stream.trueBeats)
      expect(d).toBeGreaterThan(0.75)
      expect(d).toBeGreaterThanOrEqual(1.7 * l) // measured 0.81-0.83 against 0.39-0.46
      dSum += d
      lSum += l
    }
    expect(dSum / lSum).toBeGreaterThanOrEqual(1.9) // ~2.0x on average
  })

  it('a much larger share of the director\'s cuts land on a real change than the legacy show\'s', () => {
    for (const { stream, director, legacy } of runs) {
      const aligned = (commits: readonly number[]) => (hitRate(commits, stream.trueBeats) * stream.trueBeats.length) / commits.length
      expect(aligned(director.commits)).toBeGreaterThanOrEqual(2 * aligned(legacy.commits))
    }
  })

  it('the legacy baseline is what the plan says it is: ~10-11 bars, tightly packed behind the 32-beat dwell', () => {
    for (const { legacy } of runs) {
      expect(medianBars(legacy.commits)).toBeGreaterThanOrEqual(8)
      expect(medianBars(legacy.commits)).toBeLessThanOrEqual(13)
      expect(gapPercentile(legacy.commits, 0)).toBeGreaterThanOrEqual(8) // never under the 32-beat dwell
    }
  })

  it('is deterministic', () => {
    const a = runDirector(makeStream({ seed: 9 }))
    const b = runDirector(makeStream({ seed: 9 }))
    expect(a.commits).toEqual(b.commits)
  })
})

describe('cadence simulation, other tempos and noise rates', () => {
  it('stays sane at 60, 90 and 170 BPM (bars clamped by seconds)', () => {
    for (const bpm of [60, 90, 170]) {
      const stream = makeStream({ seed: 5, bpm, beats: Math.round(24000 * (bpm / 120)) })
      const d = runDirector(stream)
      const secPerBar = 240 / bpm
      const medSec = medianBars(d.commits) * secPerBar
      expect(medSec, `${bpm} BPM`).toBeGreaterThan(14) // never a strobe...
      expect(medSec, `${bpm} BPM`).toBeLessThan(48) // ...never a stall (the 60 s ceiling still binds)
      expect(hitRate(d.commits, stream.trueBeats), `${bpm} BPM`).toBeGreaterThan(0.6)
    }
  })

  it('a quiet song (few noise events) still changes: the ceiling catches it, and the forced share stays small', () => {
    const stream = makeStream({ seed: 3, bpm: 120, beats: 24000, noiseGapSec: 30 })
    const d = runDirector(stream)
    expect(d.forced / d.commits.length).toBeLessThanOrEqual(0.25)
    expect(gapPercentile(d.commits, 1)).toBeLessThanOrEqual(34) // nothing stays past the ceiling (plus a bar to commit)
  })

  it('a noisy song (an event every 4 s) does not strobe: the intervals stay long', () => {
    const stream = makeStream({ seed: 3, bpm: 120, beats: 24000, noiseGapSec: 4 })
    const d = runDirector(stream)
    expect(medianBars(d.commits)).toBeGreaterThanOrEqual(8)
    expect(gapPercentile(d.commits, 0)).toBeGreaterThanOrEqual(4)
  })
})
