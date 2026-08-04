import { describe, expect, it } from 'vitest'
import { RollingWindow } from '../RollingWindow'

describe('RollingWindow', () => {
  it('computes mean/stdev/min/max over pushed samples', () => {
    const w = new RollingWindow(100)
    ;[1, 2, 3, 4, 5].forEach((v, i) => w.push(i, v))
    expect(w.mean()).toBeCloseTo(3, 9)
    expect(w.min()).toBe(1)
    expect(w.max()).toBe(5)
    expect(w.stdev()).toBeCloseTo(Math.sqrt(2), 9)
  })

  it('prunes samples older than the window relative to the latest push', () => {
    const w = new RollingWindow(5)
    w.push(0, 10)
    w.push(10, 20) // 10 - 0 = 10 > windowSec(5) -> the first sample ages out
    expect(w.count()).toBe(1)
    expect(w.values()[0].v).toBe(20)
  })

  it('computes nearest-rank percentiles', () => {
    const w = new RollingWindow(100)
    ;[1, 2, 3, 4, 5].forEach((v, i) => w.push(i, v))
    expect(w.percentile(0.5)).toBeCloseTo(3, 9)
    expect(w.percentile(0.95)).toBeCloseTo(5, 9)
  })

  it('returns zeroed stats on an empty window', () => {
    const w = new RollingWindow(10)
    expect(w.mean()).toBe(0)
    expect(w.stdev()).toBe(0)
    expect(w.min()).toBe(0)
    expect(w.max()).toBe(0)
    expect(w.percentile(0.5)).toBe(0)
    expect(w.count()).toBe(0)
  })

  it('clear() empties the buffer', () => {
    const w = new RollingWindow(10)
    w.push(0, 1)
    w.push(1, 2)
    w.clear()
    expect(w.count()).toBe(0)
  })
})
