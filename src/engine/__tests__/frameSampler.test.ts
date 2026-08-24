import { describe, expect, it } from 'vitest'
import {
  FrameSampler,
  GOVERNOR_WINDOW_SEC,
  MIN_GOVERNOR_SAMPLES,
  DEFAULT_SUSPEND_FRAMES,
} from '../frameSampler'
import { QualityGovernor } from '../quality'

/** Push `n` frames of `ms` each, advancing time realistically. */
function feed(s: FrameSampler, n: number, ms: number, t0 = 0): number {
  let t = t0
  for (let i = 0; i < n; i++) {
    s.push(t, ms)
    t += ms / 1000
  }
  return t
}

describe('FrameSampler — display vs governor', () => {
  it('reports every frame to the display window, including suspended ones', () => {
    const s = new FrameSampler()
    s.suspend(10)
    feed(s, 10, 200)
    // The meter must tell the truth: a scene change really did drop frames.
    expect(s.display.count()).toBe(10)
    expect(s.display.max()).toBe(200)
  })

  it('hides suspended frames from the governor', () => {
    const s = new FrameSampler()
    s.suspend(10)
    feed(s, 10, 200)
    // Nothing steady-state was observed, so there is no variance signal at all.
    expect(s.governorP95()).toBe(0)
  })

  it('resumes feeding the governor once the suspension expires', () => {
    const s = new FrameSampler()
    s.suspend(5)
    const t = feed(s, 5, 300) // the stall
    feed(s, MIN_GOVERNOR_SAMPLES + 5, 16.7, t) // steady state after it
    const p95 = s.governorP95()
    expect(p95).toBeGreaterThan(0)
    // The 300ms stall must not appear in the governor's view.
    expect(p95).toBeLessThan(20)
  })

  it('takes the longer of two overlapping suspensions', () => {
    const s = new FrameSampler()
    s.suspend(30)
    s.suspend(5) // a shorter request must not cut the longer one short
    feed(s, 20, 200)
    expect(s.governorP95()).toBe(0)
    expect(s.suspended).toBe(true)
  })

  it('withholds a percentile until there is enough evidence', () => {
    const s = new FrameSampler()
    // 16.7ms frames, so all of these stay inside the 2s window rather than
    // ageing each other out — this is testing the sample-count floor, not
    // pruning.
    const t = feed(s, MIN_GOVERNOR_SAMPLES - 1, 16.7)
    // A p95 over a handful of frames is noise, and acting on noise is how the
    // runaway started. 0 means "no signal", which quality.tick treats as inert.
    expect(s.governorP95()).toBe(0)
    feed(s, 5, 16.7, t)
    expect(s.governorP95()).toBeGreaterThan(0)
  })

  it('reset() clears both windows and any pending suspension', () => {
    const s = new FrameSampler()
    s.suspend(30)
    feed(s, 20, 50)
    s.reset()
    expect(s.display.count()).toBe(0)
    expect(s.governorP95()).toBe(0)
    expect(s.suspended).toBe(false)
  })
})

describe('FrameSampler — control-loop invariants', () => {
  it('keeps the governor window no longer than the reaction interval', () => {
    // THE invariant. quality.ts re-decides every SETTLE_SEC (2s). If the
    // governor's window outlives that interval, one spike is visible to several
    // consecutive decisions and the loop compounds — which is exactly how a
    // single stall used to drive the tier from 0 to 4 in ten seconds.
    const SETTLE_SEC = 2
    expect(GOVERNOR_WINDOW_SEC).toBeLessThanOrEqual(SETTLE_SEC)
  })

  it('suspends long enough to cover a resize stall at 60fps', () => {
    // ~0.5s. Shorter and the tail of a reallocation leaks back into the metric.
    expect(DEFAULT_SUSPEND_FRAMES).toBeGreaterThanOrEqual(20)
  })

  it('does not cascade the tier when one stall is suspended', () => {
    // End-to-end regression for the reported bug: a heavy one-off (a scene
    // commit, a DPR resize) followed by a perfectly healthy 60fps must leave
    // the tier where it was, not walk it to the floor.
    const s = new FrameSampler()
    const g = new QualityGovernor()
    g.setMode('medium') // tier 2
    g.setMode('auto')
    const startTier = g.tier

    s.suspend()
    let t = feed(s, 20, 250) // the stall, correctly suspended
    // Five governor decisions at SETTLE_SEC spacing over healthy frames.
    for (let step = 0; step < 5; step++) {
      t = feed(s, 120, 16.7, t)
      g.tick(16.7, 10 + step * 2.5, s.governorP95())
    }
    // The invariant is that it must not CASCADE DOWNWARD off one suspended
    // stall. Climbing is the correct response to a genuinely healthy run —
    // 16.7 ms is the refresh interval, i.e. every frame landing on time — so
    // only the downward direction is pinned here.
    expect(g.tier).toBeLessThanOrEqual(startTier)
  })

  it('still steps down when the load is genuinely steady, not a one-off', () => {
    // The suspension must not become a blindfold: sustained bad frames that
    // nobody suspended have to reach the governor and shed load.
    const s = new FrameSampler()
    const g = new QualityGovernor()
    g.setMode('medium')
    g.setMode('auto')
    const startTier = g.tier

    feed(s, 120, 60) // a solid 2s of 60ms frames — genuinely overloaded
    g.tick(60, 10, s.governorP95())
    expect(g.tier).toBe(startTier + 1)
  })
})
