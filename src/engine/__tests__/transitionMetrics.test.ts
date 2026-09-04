import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  beginTransition,
  sampleTransitionFrame,
  transitionMetrics,
} from '../transitionMetrics'

/** A minimal pending record — only the fields under test carry meaning here. */
function commit(key: number, nowSec: number) {
  beginTransition(
    {
      key,
      fromScene: 'nebula',
      toScene: 'lattice',
      style: 'dissolve',
      onDownbeat: true,
      hardCut: false,
      waitedSec: 0,
      targetDurationSec: 1,
    },
    nowSec,
  )
}

beforeEach(() => {
  transitionMetrics.history.length = 0
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  transitionMetrics.history.length = 0
})

describe('the transition timestamp', () => {
  it('records when the scene actually changed, not when the fade finished', () => {
    // The distinction is the whole point of stamping in `beginTransition`
    // rather than at the push: the age shown in the panel should answer "when
    // did this scene change", and a fade adds up to ~2 beats to that.
    vi.setSystemTime(1_000_000)
    commit(7, 100)
    vi.setSystemTime(1_005_000)
    sampleTransitionFrame(7, 16, 1, 105)

    expect(transitionMetrics.history).toHaveLength(1)
    expect(transitionMetrics.history[0].atMs).toBe(1_000_000)
  })

  it('keeps wall time and the render clock as separate quantities', () => {
    // `actualDurationSec` measures the fade on the render clock the caller
    // passes in; `atMs` is wall time. Deriving either from the other would
    // break the console's second window, which shares one but not the other.
    vi.setSystemTime(2_000_000)
    commit(1, 40)
    sampleTransitionFrame(1, 16, 0.5, 40.5)
    sampleTransitionFrame(1, 16, 1, 40.9)

    const r = transitionMetrics.history[0]
    expect(r.atMs).toBe(2_000_000)
    expect(r.actualDurationSec).toBeCloseTo(0.9, 6)
  })

  it('gives every capped-history entry an age, oldest first', () => {
    // The cap is 50 and the panel reads the tail, so the invariant that
    // matters is that shifting never leaves a record without a timestamp and
    // never reorders them.
    for (let i = 0; i < 55; i++) {
      vi.setSystemTime(3_000_000 + i * 1000)
      commit(i, i)
      sampleTransitionFrame(i, 16, 1, i + 0.5)
    }

    expect(transitionMetrics.history).toHaveLength(50)
    // The first five were dropped, so the oldest survivor is the sixth commit.
    expect(transitionMetrics.history[0].atMs).toBe(3_000_000 + 5 * 1000)
    expect(transitionMetrics.history[49].atMs).toBe(3_000_000 + 54 * 1000)
    for (let i = 1; i < transitionMetrics.history.length; i++) {
      expect(transitionMetrics.history[i].atMs).toBeGreaterThan(
        transitionMetrics.history[i - 1].atMs,
      )
    }
  })

  it('does not stamp anything for a frame that belongs to another transition', () => {
    vi.setSystemTime(4_000_000)
    commit(11, 10)
    sampleTransitionFrame(99, 16, 1, 11)
    expect(transitionMetrics.history).toHaveLength(0)

    sampleTransitionFrame(11, 16, 1, 11)
    expect(transitionMetrics.history).toHaveLength(1)
    expect(transitionMetrics.history[0].atMs).toBe(4_000_000)
  })
})
