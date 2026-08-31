import { describe, expect, it } from 'vitest'
import { beatCyclePhase, beatOscillators, beatSin } from '../beatOscillators'

describe('beatCyclePhase', () => {
  it('is 0 at the start of a beat, for a 1-beat cycle', () => {
    expect(beatCyclePhase(0, 0, 1)).toBeCloseTo(0, 6)
  })

  it('is 0.5 halfway through a 1-beat cycle', () => {
    expect(beatCyclePhase(0, 0.5, 1)).toBeCloseTo(0.5, 6)
  })

  it('wraps back to (near) 0 at the end of a cycle', () => {
    expect(beatCyclePhase(0, 0.999, 1)).toBeCloseTo(0.999, 3)
  })

  it('a 2-beat cycle is 0.5 through at the start of the second beat', () => {
    expect(beatCyclePhase(1, 0, 2)).toBeCloseTo(0.5, 6)
  })

  it('a 4-beat cycle completes exactly once per bar', () => {
    expect(beatCyclePhase(0, 0, 4)).toBeCloseTo(0, 6)
    expect(beatCyclePhase(2, 0, 4)).toBeCloseTo(0.5, 6)
    expect(beatCyclePhase(4, 0, 4)).toBeCloseTo(0, 6) // wrapped: bar 2 starts
  })

  it('stays in 0..1 across a long run of beat indices', () => {
    for (let i = 0; i < 200; i++) {
      for (const cycle of [1, 2, 4]) {
        const phase = beatCyclePhase(i, 0.3, cycle)
        expect(phase).toBeGreaterThanOrEqual(0)
        expect(phase).toBeLessThan(1)
      }
    }
  })

  it('falls back to a 1-beat cycle for a non-finite or non-positive beatsPerCycle', () => {
    expect(beatCyclePhase(0, 0.25, NaN)).toBeCloseTo(beatCyclePhase(0, 0.25, 1), 6)
    expect(beatCyclePhase(0, 0.25, 0)).toBeCloseTo(beatCyclePhase(0, 0.25, 1), 6)
    expect(beatCyclePhase(0, 0.25, -3)).toBeCloseTo(beatCyclePhase(0, 0.25, 1), 6)
  })

  it('is total against a non-finite beatIndex or beatProgress', () => {
    expect(Number.isFinite(beatCyclePhase(NaN, 0.5, 1))).toBe(true)
    expect(Number.isFinite(beatCyclePhase(0, NaN, 1))).toBe(true)
    expect(Number.isFinite(beatCyclePhase(Infinity, 0.5, 1))).toBe(true)
  })
})

describe('beatSin', () => {
  it('starts at 0 at the top of a cycle', () => {
    expect(beatSin(0, 0, 1)).toBeCloseTo(0, 6)
  })

  it('peaks at quarter-phase', () => {
    expect(beatSin(0, 0.25, 1)).toBeCloseTo(1, 6)
  })

  it('troughs at three-quarter-phase', () => {
    expect(beatSin(0, 0.75, 1)).toBeCloseTo(-1, 6)
  })

  it('stays within -1..1', () => {
    for (let i = 0; i < 100; i++) {
      const v = beatSin(i, (i % 7) / 7, 2)
      expect(v).toBeGreaterThanOrEqual(-1)
      expect(v).toBeLessThanOrEqual(1)
    }
  })
})

describe('beatOscillators', () => {
  it('sin2 runs at half the frequency of sin1', () => {
    // Over one full 2-beat cycle, sin1 completes two full cycles and sin2
    // completes exactly one — so sin2 at the end of beat 1 (halfway through
    // its own cycle) should be near its trough/peak transition (0), while
    // sin1 has already completed a full cycle and returned near 0 too, but
    // the PERIODS differ: sample at the quarter points and compare peaks.
    const atBeat0Quarter = beatOscillators(0, 0.25)
    // sin1 is 1 cycle/beat: quarter through beat 0 is peak (phase 0.25 of 1).
    expect(atBeat0Quarter.sin1).toBeCloseTo(1, 6)
    // sin2 is 1 cycle/2 beats: quarter through beat 0 is only 1/8 through its
    // own cycle, well short of peak.
    expect(atBeat0Quarter.sin2).toBeLessThan(atBeat0Quarter.sin1)
  })

  it('sin4 completes exactly one cycle per bar', () => {
    const start = beatOscillators(0, 0)
    const barLater = beatOscillators(4, 0)
    expect(start.sin4).toBeCloseTo(barLater.sin4, 6)
  })

  it('all three oscillate independently — not all locked to the same phase', () => {
    const o = beatOscillators(1, 0.5)
    const values = [o.sin1, o.sin2, o.sin4]
    expect(new Set(values.map((v) => v.toFixed(4))).size).toBeGreaterThan(1)
  })

  it('returns a fully-formed object for every beat position', () => {
    for (let i = 0; i < 20; i++) {
      const o = beatOscillators(i, i / 20)
      expect(Number.isFinite(o.sin1)).toBe(true)
      expect(Number.isFinite(o.sin2)).toBe(true)
      expect(Number.isFinite(o.sin4)).toBe(true)
    }
  })
})
