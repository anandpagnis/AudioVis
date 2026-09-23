import { describe, expect, it } from 'vitest'
import {
  CONFIDENCE_CEIL,
  CONFIDENCE_FLOOR,
  REF_BPM,
  TEMPO_SPEED_MAX,
  TEMPO_SPEED_MIN,
  tempoSpeedMultiplier,
} from '../tempoSpeed'

describe('tempoSpeedMultiplier', () => {
  it('is exactly 1 at the reference BPM, at full confidence', () => {
    expect(tempoSpeedMultiplier(REF_BPM, 1)).toBeCloseTo(1, 9)
  })

  it('is greater than 1 above the reference BPM and less than 1 below it, at full confidence', () => {
    expect(tempoSpeedMultiplier(160, 1)).toBeGreaterThan(1)
    expect(tempoSpeedMultiplier(80, 1)).toBeLessThan(1)
  })

  it('matches worked values from the plan (k=0.6, ref=120)', () => {
    expect(tempoSpeedMultiplier(60, 1)).toBeCloseTo(TEMPO_SPEED_MIN, 9) // raw 0.4, clamped up to 0.6
    expect(tempoSpeedMultiplier(80, 1)).toBeCloseTo(0.649, 2)
    expect(tempoSpeedMultiplier(160, 1)).toBeCloseTo(1.249, 2)
    expect(tempoSpeedMultiplier(200, 1)).toBeCloseTo(1.442, 2)
  })

  it('clamps at the extremes: a very low bpm floors, an octave-double-style high bpm ceilings', () => {
    expect(tempoSpeedMultiplier(30, 1)).toBe(TEMPO_SPEED_MIN)
    expect(tempoSpeedMultiplier(320, 1)).toBe(TEMPO_SPEED_MAX) // e.g. a 160-track misread as double
  })

  it('is monotonically increasing in bpm at fixed (full) confidence', () => {
    const bpms = [60, 70, 85, 100, 120, 140, 160, 180, 200]
    let prev = -Infinity
    for (const bpm of bpms) {
      const v = tempoSpeedMultiplier(bpm, 1)
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
  })

  it('is roughly symmetric in log-space around the reference BPM (equal ratio, opposite sign deviation)', () => {
    const up = tempoSpeedMultiplier(REF_BPM * 1.5, 1) - 1
    const down = tempoSpeedMultiplier(REF_BPM / 1.5, 1) - 1
    expect(up).toBeCloseTo(-down, 9)
  })

  it('is fully neutral (1) at zero confidence, whatever the bpm', () => {
    expect(tempoSpeedMultiplier(200, 0)).toBe(1)
    expect(tempoSpeedMultiplier(60, 0)).toBe(1)
  })

  it('ramps linearly with confidence between the floor and the ceiling', () => {
    const full = tempoSpeedMultiplier(160, 1)
    const mid = tempoSpeedMultiplier(160, (CONFIDENCE_FLOOR + CONFIDENCE_CEIL) / 2)
    expect(mid).toBeCloseTo(1 + (full - 1) * 0.5, 6)
  })

  it('is monotonically non-decreasing in confidence for a bpm above the reference', () => {
    const confidences = [0, 0.1, CONFIDENCE_FLOOR, 0.25, CONFIDENCE_CEIL, 0.7, 1]
    let prev = -Infinity
    for (const c of confidences) {
      const v = tempoSpeedMultiplier(160, c)
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9)
      prev = v
    }
  })

  it('reaches the same value at and above the confidence ceiling (no further change past it)', () => {
    expect(tempoSpeedMultiplier(160, CONFIDENCE_CEIL)).toBeCloseTo(tempoSpeedMultiplier(160, 1), 9)
    expect(tempoSpeedMultiplier(160, 0.8)).toBeCloseTo(tempoSpeedMultiplier(160, 1), 9)
  })

  it('never throws and reads as neutral for non-finite or non-positive bpm', () => {
    for (const bpm of [0, -10, NaN, Infinity, -Infinity]) {
      expect(tempoSpeedMultiplier(bpm, 1)).toBe(1)
    }
  })

  it('never throws for non-finite confidence — every non-finite value reads as untrustworthy (neutral)', () => {
    // Infinity is NOT treated as "maximally confident": only a genuine finite reading is ever trusted, so
    // any non-finite value (NaN, +-Infinity) falls through to the same safe default as a missing read.
    for (const c of [NaN, Infinity, -Infinity]) expect(tempoSpeedMultiplier(160, c)).toBe(1)
  })

  it('octave correction is the caller\'s job, not this function\'s: a doubled bpm is just a bigger input', () => {
    // This function takes only (bpm, confidence) and imports nothing from BpmEstimator, so there is no
    // internal state that could double-apply octave correction — confirmed structurally by the module's
    // own header, and behaviourally here: a naive double/half input just moves along the same formula.
    const at80 = tempoSpeedMultiplier(80, 1)
    const at160 = tempoSpeedMultiplier(160, 1)
    expect(at160).toBeGreaterThan(at80)
  })
})
