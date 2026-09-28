import { describe, expect, it } from 'vitest'
import { PhrasePrior } from '../phrasePrior'

describe('PhrasePrior: a period learned from the running song, in seconds, never a suppression', () => {
  it('knows nothing before two boundaries and boosts nothing', () => {
    const p = new PhrasePrior()
    expect(p.estimate).toBeNull()
    expect(p.multiplier(30)).toBe(1)
    p.add(10)
    expect(p.estimate).toBeNull()
    expect(p.multiplier(30)).toBe(1)
  })

  it('a regular phrase length is learned and the next boundaries (1x, 2x) are boosted, others are not', () => {
    const p = new PhrasePrior()
    for (const t of [10, 31.2, 52.1, 73.3]) p.add(t)
    const e = p.estimate
    expect(e).not.toBeNull()
    expect(e?.period).toBeGreaterThan(20.5)
    expect(e?.period).toBeLessThan(22)
    expect(e?.belief).toBe(1)
    const on = p.multiplier(73.3 + 21.2)
    const twice = p.multiplier(73.3 + 2 * 21.2)
    const off = p.multiplier(73.3 + 11)
    expect(on).toBeCloseTo(1.15, 2)
    expect(twice).toBeCloseTo(1.15, 2)
    expect(off).toBe(1)
  })

  it('the multiplier is never below 1 and never above the configured boost', () => {
    const p = new PhrasePrior({ boost: 1.3 })
    for (const t of [0, 20, 40, 60]) p.add(t)
    for (let t = 61; t < 200; t += 0.7) {
      const m = p.multiplier(t)
      expect(m).toBeGreaterThanOrEqual(1)
      expect(m).toBeLessThanOrEqual(1.3 + 1e-9)
    }
  })

  it('irregular boundaries give at most a weak belief (one lone gap is a hint, not a period)', () => {
    const p = new PhrasePrior()
    for (const t of [3, 17, 52, 61, 109]) p.add(t)
    expect(p.estimate === null || p.estimate.belief < 1).toBe(true)
  })

  it('a single gap is a weak hint: a third of the boost', () => {
    const p = new PhrasePrior()
    p.add(10)
    p.add(30)
    const b = p.estimate?.belief ?? 0
    expect(b).toBeGreaterThan(0.2)
    expect(b).toBeLessThan(0.4)
    expect(p.multiplier(50)).toBeCloseTo(1 + 0.15 * b, 5)
  })

  it('events that are one event (closer than mergeSec) count once; a clock that goes back is a new source', () => {
    const p = new PhrasePrior()
    p.add(10)
    p.add(11)
    expect(p.estimate).toBeNull()
    p.add(31)
    expect(p.estimate?.period).toBeCloseTo(21, 0)
    p.add(2) // backwards
    expect(p.estimate).toBeNull()
  })

  it('periods outside [minPeriod, maxPeriod] are not learned', () => {
    const p = new PhrasePrior()
    p.add(0)
    p.add(3)
    p.add(5.5)
    expect(p.estimate).toBeNull() // 3 s and 2.5 s apart: under minPeriod (6 s)
  })

  it('ignores non-finite times and reset() forgets', () => {
    const p = new PhrasePrior()
    p.add(Number.NaN)
    p.add(10)
    p.add(30)
    p.add(50)
    expect(p.estimate).not.toBeNull()
    expect(p.multiplier(Number.NaN)).toBe(1)
    p.reset()
    expect(p.estimate).toBeNull()
  })
})
