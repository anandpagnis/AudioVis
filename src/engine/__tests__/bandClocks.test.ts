import { describe, expect, it } from 'vitest'
import {
  advanceBandClocks,
  bandClocks,
  createBandClocks,
  resetBandClocks,
  stepBandClocks,
} from '../bandClocks'

describe('createBandClocks', () => {
  it('starts every clock at zero', () => {
    expect(createBandClocks()).toEqual({ bass: 0, mid: 0, high: 0 })
  })
})

describe('stepBandClocks', () => {
  it('advances a clock proportional to its own band level', () => {
    const s0 = createBandClocks()
    const s1 = stepBandClocks(s0, { bass: 1, mid: 0.5, high: 0 }, 1)
    expect(s1.bass).toBeGreaterThan(s1.mid)
    expect(s1.mid).toBeGreaterThan(s1.high)
    expect(s1.high).toBe(0)
  })

  it('a band at full level advances at the same rate as wall-clock time', () => {
    // The load-bearing property from the module's own doc: swapping uTime
    // for a band clock must reproduce the original speed exactly when that
    // band is maxed out.
    const s1 = stepBandClocks(createBandClocks(), { bass: 1, mid: 1, high: 1 }, 2.5)
    expect(s1.bass).toBeCloseTo(2.5, 6)
    expect(s1.mid).toBeCloseTo(2.5, 6)
    expect(s1.high).toBeCloseTo(2.5, 6)
  })

  it('a silent band does not advance at all', () => {
    const s1 = stepBandClocks(createBandClocks(), { bass: 0, mid: 0, high: 0 }, 10)
    expect(s1).toEqual({ bass: 0, mid: 0, high: 0 })
  })

  it('accumulates across repeated steps rather than resetting', () => {
    let s = createBandClocks()
    for (let i = 0; i < 10; i++) s = stepBandClocks(s, { bass: 1, mid: 0, high: 0 }, 0.1)
    expect(s.bass).toBeCloseTo(1, 6)
  })

  it('is pure — does not mutate the state it was given', () => {
    const s0 = createBandClocks()
    const frozen = { ...s0 }
    stepBandClocks(s0, { bass: 1, mid: 1, high: 1 }, 1)
    expect(s0).toEqual(frozen)
  })

  it('is total against non-finite dt or band levels', () => {
    const s = stepBandClocks(createBandClocks(), { bass: NaN, mid: Infinity, high: -5 }, NaN)
    expect(Number.isFinite(s.bass)).toBe(true)
    expect(Number.isFinite(s.mid)).toBe(true)
    expect(Number.isFinite(s.high)).toBe(true)
    expect(s).toEqual({ bass: 0, mid: 0, high: 0 })
  })

  it('clamps an out-of-range band level rather than propagating it', () => {
    const s = stepBandClocks(createBandClocks(), { bass: 5, mid: -5, high: 0.5 }, 1)
    expect(s.bass).toBeCloseTo(1, 6) // clamped to 1, same as a fully-loud band
    expect(s.mid).toBe(0) // clamped to 0
  })
})

describe('the live singleton', () => {
  it('advanceBandClocks mutates the shared singleton in place', () => {
    resetBandClocks()
    advanceBandClocks({ bass: 1, mid: 0, high: 0 }, 1)
    expect(bandClocks.bass).toBeCloseTo(1, 6)
    expect(bandClocks.mid).toBe(0)
    resetBandClocks()
  })

  it('resetBandClocks zeroes every clock', () => {
    advanceBandClocks({ bass: 1, mid: 1, high: 1 }, 5)
    resetBandClocks()
    expect(bandClocks).toEqual({ bass: 0, mid: 0, high: 0 })
  })
})
