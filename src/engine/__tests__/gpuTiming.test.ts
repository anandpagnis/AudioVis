import { describe, expect, it } from 'vitest'
import { MAX_PENDING_QUERIES, interpretQueryResult, nsToMs, trimPending } from '../gpuTiming'

describe('nsToMs', () => {
  it('converts nanoseconds to milliseconds', () => {
    expect(nsToMs(1_000_000)).toBeCloseTo(1, 9)
    expect(nsToMs(16_700_000)).toBeCloseTo(16.7, 6)
  })

  it('is zero for zero', () => {
    expect(nsToMs(0)).toBe(0)
  })
})

describe('interpretQueryResult', () => {
  it('converts a clean result to milliseconds', () => {
    expect(interpretQueryResult(5_000_000, false)).toBeCloseTo(5, 6)
  })

  it('discards a result flagged disjoint, regardless of its value', () => {
    expect(interpretQueryResult(5_000_000, true)).toBeNull()
    expect(interpretQueryResult(0, true)).toBeNull()
  })

  it('discards a non-finite reading rather than propagating it', () => {
    expect(interpretQueryResult(NaN, false)).toBeNull()
    expect(interpretQueryResult(Infinity, false)).toBeNull()
  })

  it('discards a negative reading', () => {
    expect(interpretQueryResult(-1, false)).toBeNull()
  })

  it('accepts exactly zero elapsed time', () => {
    // A query that fired around an empty frame (nothing drawn) is a real,
    // trustworthy zero, not an error.
    expect(interpretQueryResult(0, false)).toBe(0)
  })
})

describe('MAX_PENDING_QUERIES', () => {
  it('is a small positive number of frames of backlog', () => {
    expect(MAX_PENDING_QUERIES).toBeGreaterThan(0)
    expect(MAX_PENDING_QUERIES).toBeLessThan(16)
  })
})

describe('trimPending', () => {
  it('does nothing when the queue is already within the limit', () => {
    const q = [1, 2, 3]
    const dropped = trimPending(q, 4)
    expect(q).toEqual([1, 2, 3])
    expect(dropped).toEqual([])
  })

  it('drops from the front until the queue fits', () => {
    const q = [1, 2, 3, 4, 5]
    const dropped = trimPending(q, 2)
    expect(q).toEqual([4, 5])
    expect(dropped).toEqual([1, 2, 3])
  })

  it('mutates the queue in place', () => {
    const q = [1, 2, 3]
    const same = q
    trimPending(q, 1)
    expect(same).toBe(q)
    expect(q).toEqual([3])
  })

  it('can empty the queue entirely with max 0', () => {
    const q = [1, 2, 3]
    const dropped = trimPending(q, 0)
    expect(q).toEqual([])
    expect(dropped).toEqual([1, 2, 3])
  })

  it('works over objects, not just primitives — the real WebGLQuery use case', () => {
    const a = { id: 'a' }
    const b = { id: 'b' }
    const c = { id: 'c' }
    const q = [a, b, c]
    const dropped = trimPending(q, 1)
    expect(q).toEqual([c])
    expect(dropped).toEqual([a, b])
  })
})
