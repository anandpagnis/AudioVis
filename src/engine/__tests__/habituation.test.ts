import { describe, expect, it } from 'vitest'
import {
  createHabituation,
  habituatedGate,
  stepHabituation,
  type Habituation,
} from '../habituation'

describe('createHabituation', () => {
  it('starts fresh', () => {
    expect(createHabituation()).toEqual({ exposure: 0 })
  })
})

describe('stepHabituation', () => {
  it('rises toward 1 while engaged', () => {
    let s = createHabituation()
    s = stepHabituation(s, true)
    expect(s.exposure).toBeGreaterThan(0)
    const prev = s.exposure
    s = stepHabituation(s, true)
    expect(s.exposure).toBeGreaterThan(prev)
  })

  it('decays toward 0 while not engaged', () => {
    let s: Habituation = { exposure: 0.9 }
    s = stepHabituation(s, false)
    expect(s.exposure).toBeLessThan(0.9)
    expect(s.exposure).toBeGreaterThan(0)
  })

  it('never exceeds 1 or falls below 0', () => {
    let s = createHabituation()
    for (let i = 0; i < 100; i++) s = stepHabituation(s, true)
    expect(s.exposure).toBeLessThanOrEqual(1)
    for (let i = 0; i < 100; i++) s = stepHabituation(s, false)
    expect(s.exposure).toBeGreaterThanOrEqual(0)
  })

  it('rises faster than it decays by default — one firing matters more than one rest', () => {
    const risen = stepHabituation({ exposure: 0 }, true)
    const decayed = stepHabituation({ exposure: 1 }, false)
    // Distance covered toward the target in one step.
    expect(risen.exposure).toBeGreaterThan(1 - decayed.exposure)
  })

  it('is total against a poisoned state', () => {
    const s = stepHabituation({ exposure: NaN }, true)
    expect(Number.isFinite(s.exposure)).toBe(true)
  })
})

describe('habituatedGate', () => {
  const FRESH: Habituation = { exposure: 0 }
  const SATURATED: Habituation = { exposure: 1 }

  it('at zero exposure, engagement frequency over many seeds matches baseRate', () => {
    const baseRate = 5 / 6
    let on = 0
    const N = 6000
    for (let seed = 0; seed < N; seed++) if (habituatedGate(seed, FRESH, baseRate)) on++
    expect(on / N).toBeCloseTo(baseRate, 1)
  })

  it('fires less often at full habituation than at zero, for the same seed range', () => {
    const baseRate = 5 / 6
    const N = 3000
    let onFresh = 0
    let onSaturated = 0
    for (let seed = 0; seed < N; seed++) {
      if (habituatedGate(seed, FRESH, baseRate)) onFresh++
      if (habituatedGate(seed, SATURATED, baseRate)) onSaturated++
    }
    expect(onSaturated).toBeLessThan(onFresh)
  })

  it('fires strictly less often as habituation rises, at the default dampening', () => {
    const baseRate = 5 / 6
    const N = 4000
    const rateAt = (exposure: number) => {
      let on = 0
      for (let seed = 0; seed < N; seed++) if (habituatedGate(seed, { exposure }, baseRate)) on++
      return on / N
    }
    const r0 = rateAt(0)
    const r5 = rateAt(0.5)
    const r10 = rateAt(1)
    expect(r5).toBeLessThan(r0)
    expect(r10).toBeLessThan(r5)
    expect(r10).toBeGreaterThan(0) // never fully locked off
  })

  it('the floor is exact when dampening would otherwise suppress the rate below it', () => {
    // baseRate 1, dampening 1, full exposure: the dampened rate would be
    // exactly 0 without a floor. floor=0.1 must be what actually governs.
    const rate = 0.1
    let on = 0
    const N = 4000
    for (let seed = 0; seed < N; seed++) {
      if (habituatedGate(seed, SATURATED, 1, 1, rate)) on++
    }
    expect(on / N).toBeCloseTo(rate, 1)
  })

  it('degenerates to a pure baseRate-frequency roll when dampening is 0', () => {
    const withNoDampening = Array.from({ length: 2000 }, (_, seed) =>
      habituatedGate(seed, SATURATED, 0.5, 0),
    )
    const onCount = withNoDampening.filter(Boolean).length
    expect(onCount / 2000).toBeCloseTo(0.5, 1)
  })

  it('is deterministic — same seed and state always gives the same answer', () => {
    const state: Habituation = { exposure: 0.42 }
    for (const seed of [0, 1, 5, 17, 200, 9999]) {
      expect(habituatedGate(seed, state, 0.6)).toBe(habituatedGate(seed, state, 0.6))
    }
  })

  it('is total against garbage seeds and a garbage state', () => {
    const garbageSeeds = [NaN, Infinity, -Infinity, -5, 1.7]
    for (const seed of garbageSeeds) {
      expect(() => habituatedGate(seed, FRESH, 0.5)).not.toThrow()
    }
    expect(() => habituatedGate(0, { exposure: NaN }, 0.5)).not.toThrow()
    expect(() => habituatedGate(0, { exposure: -5 }, 0.5)).not.toThrow()
    expect(() => habituatedGate(0, { exposure: 99 }, 0.5)).not.toThrow()
  })

  it('a negative seed still reduces into a valid, in-range roll', () => {
    // The old `seed % 6` code this replaces had the same JS negative-modulo
    // hazard; this must not regress it into always-true or always-false.
    const results = Array.from({ length: 50 }, (_, i) => habituatedGate(-i, FRESH, 5 / 6))
    expect(results.some((r) => r)).toBe(true)
    expect(results.some((r) => !r)).toBe(true)
  })

  /**
   * F239: a real session recording showed the lens rack's duty cycle reading
   * 100% — one continuous "on" stretch spanning nearly the whole 131s show —
   * while the mirror rack, driven through this identical function in the same
   * session, cycled normally (34% duty, real off periods). Both call sites
   * feed a seed that increments by exactly 1 per DECISION (not per frame,
   * per `PerformanceStateBridge.tsx`'s `sectionCount`/`mirrorSeed` refs); the
   * lens just decides far less often (roughly once a minute vs. most phrase
   * edges for the mirror), so its seed stays small for the whole session.
   *
   * The bug: `roll = seed % resolution` for `seed = 0, 1, 2, …` is just
   * `0, 1, 2, …` again, and even FULL habituation only dampens the comparison
   * threshold down to `floor * resolution` (~100 at a 0.1 floor) — so a seed
   * run that never climbs past double digits can NEVER roll a "false",
   * regardless of habituation. This test reproduces the lens's actual
   * cadence (a decision roughly every phrase-backstop interval, not a tight
   * loop) and asserts what real hardware showed was missing: at least one
   * disengagement inside a run this short, once habituation has had a chance
   * to build up from repeated engagement.
   */
  it('a small, sequential seed run (a realistic session) still shows real habituation', () => {
    let state: Habituation = createHabituation()
    let anyDisengaged = false
    for (let seed = 0; seed < 25; seed++) {
      const engaged = habituatedGate(seed, state, 1 / 3)
      state = stepHabituation(state, engaged)
      if (!engaged) anyDisengaged = true
    }
    expect(anyDisengaged).toBe(true)
  })
})
