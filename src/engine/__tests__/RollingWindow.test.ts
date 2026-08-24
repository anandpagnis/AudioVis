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
    expect(w.valueAt(0)).toBe(20)
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

/**
 * Ring-buffer specifics.
 *
 * The class stores samples in two fixed `Float64Array`s and wraps, rather than
 * pushing `{t, v}` objects and `splice`-ing the front. That removes the
 * per-frame allocation and the O(n) memmove, but it introduces failure modes an
 * array simply cannot have: reads that wrap past the end, growth that has to
 * re-lay the samples out in order, and a memoized sort that has to notice when
 * it has gone stale. All three are invisible from the outside until they are
 * wrong, so they are pinned here.
 */
describe('RollingWindow — ring behaviour', () => {
  it('reads samples in age order after wrapping past the end of the ring', () => {
    // Small window, tight spacing: comfortably more pushes than the initial
    // capacity, so the write index wraps many times.
    const w = new RollingWindow(1)
    for (let i = 0; i < 500; i++) w.push(i * 0.01, i)
    const n = w.count()
    expect(n).toBeGreaterThan(1)
    // Oldest first, strictly increasing in both axes — a wrap read in the wrong
    // order would show up here as a discontinuity.
    for (let i = 1; i < n; i++) {
      expect(w.timeAt(i)).toBeGreaterThan(w.timeAt(i - 1))
      expect(w.valueAt(i)).toBeGreaterThan(w.valueAt(i - 1))
    }
    // Everything still inside the window, nothing older.
    expect(w.timeAt(n - 1) - w.timeAt(0)).toBeLessThanOrEqual(1)
  })

  it('grows rather than dropping samples that are still inside the window', () => {
    // Initial capacity is windowSec × 60. Pushing at 240 Hz for the full window
    // needs four times that, so this only passes if the ring grows.
    const w = new RollingWindow(2)
    const n = 2 * 240
    for (let i = 0; i < n; i++) w.push(i / 240, i)
    // Every sample is within the 2 s window, so every one must have survived.
    expect(w.count()).toBe(n)
    expect(w.valueAt(0)).toBe(0)
    expect(w.valueAt(n - 1)).toBe(n - 1)
  })

  it('keeps stats correct across a growth', () => {
    const w = new RollingWindow(2)
    for (let i = 0; i < 480; i++) w.push(i / 240, i)
    expect(w.min()).toBe(0)
    expect(w.max()).toBe(479)
    expect(w.mean()).toBeCloseTo(239.5, 6)
  })

  it('invalidates the memoized percentile sort when samples change', () => {
    const w = new RollingWindow(100)
    ;[1, 2, 3, 4, 5].forEach((v, i) => w.push(i, v))
    expect(w.percentile(1)).toBe(5)
    // A stale memo would keep answering 5 here.
    w.push(5, 100)
    expect(w.percentile(1)).toBe(100)
    w.clear()
    expect(w.percentile(1)).toBe(0)
  })

  it('answers repeated percentile calls consistently', () => {
    // The scratch buffer is reused, so a second call must not read stale slots
    // left behind by a previously larger sample set.
    const w = new RollingWindow(100)
    ;[5, 3, 1, 4, 2].forEach((v, i) => w.push(i, v))
    expect(w.percentile(0.5)).toBe(3)
    expect(w.percentile(0.5)).toBe(3)
    expect(w.percentile(0)).toBe(1)
    expect(w.percentile(1)).toBe(5)
  })

  it('sorts by value, not by insertion order', () => {
    // The old implementation copied then sorted; the ring sorts a scratch view.
    // Pushing in descending order catches a version that forgot to sort at all.
    const w = new RollingWindow(100)
    ;[9, 8, 7, 6, 5, 4, 3, 2, 1].forEach((v, i) => w.push(i, v))
    expect(w.percentile(0.5)).toBe(5)
  })

  it('survives a clock that never advances without growing without bound', () => {
    // Pathological: nothing ever ages out, so the window can only stay bounded
    // by dropping the oldest once it hits its hard capacity cap.
    const w = new RollingWindow(1)
    for (let i = 0; i < 200_000; i++) w.push(0, i)
    expect(w.count()).toBeLessThanOrEqual(1 << 16)
    // And it is still the MOST RECENT samples that were kept.
    expect(w.valueAt(w.count() - 1)).toBe(199_999)
  })
})
