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

/**
 * Push `n` frames of `ms` each through BOTH `stepGovernorEma()` and `push()`,
 * so a test can assert on the real mean-axis signal PerfMonitor.tsx actually
 * feeds `quality.tick()` — not a hand-picked stand-in. Returns `{ t, ema }`.
 *
 * Order matters and must match PerfMonitor.tsx exactly: `stepGovernorEma`
 * reads `suspended` (`skip > 0`) BEFORE `push()` decrements it for this
 * frame. Reversed, the LAST excused frame of a suspension would see
 * `skip` already at 0 from `push()`'s own decrement and get folded into the
 * ema anyway — silently reopening exactly the gap this fixes, on exactly
 * the boundary frame that matters most.
 */
function feedWithEma(
  s: FrameSampler,
  n: number,
  ms: number,
  ema: number,
  t0 = 0,
): { t: number; ema: number } {
  let t = t0
  for (let i = 0; i < n; i++) {
    ema = s.stepGovernorEma(ema, ms)
    s.push(t, ms)
    t += ms / 1000
  }
  return { t, ema }
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

describe('FrameSampler — stepGovernorEma', () => {
  it('advances normally while not suspended', () => {
    const s = new FrameSampler()
    const next = s.stepGovernorEma(16.7, 20, 0.05)
    expect(next).toBeCloseTo(16.7 + (20 - 16.7) * 0.05, 10)
  })

  it('holds the exact previous value for every frame of a suspension', () => {
    // Order matches PerfMonitor.tsx: stepGovernorEma reads `suspended` BEFORE
    // push() decrements it for this frame — see feedWithEma's own doc above
    // for why calling these out of order would silently reopen the gap on
    // the boundary frame.
    const s = new FrameSampler()
    s.suspend(3)
    let t = 0
    let ema = 16.7
    for (let i = 0; i < 3; i++) {
      ema = s.stepGovernorEma(ema, 300)
      expect(ema).toBe(16.7)
      s.push(t, 300)
      t += 0.3
    }
  })

  it('resumes advancing the instant a suspension ends, with no leftover memory', () => {
    const s = new FrameSampler()
    s.suspend(1)
    let ema = 16.7
    ema = s.stepGovernorEma(ema, 999) // the one excused frame
    expect(ema).toBe(16.7)
    s.push(0, 999) // expires the suspension
    expect(s.suspended).toBe(false)
    ema = s.stepGovernorEma(ema, 20) // a normal frame right after
    expect(ema).toBeCloseTo(16.7 + (20 - 16.7) * 0.05, 10)
    s.push(0.999, 20)
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
    //
    // The ema fed to g.tick() below is computed the same way PerfMonitor.tsx
    // actually computes it (feedWithEma, via stepGovernorEma) rather than a
    // hand-picked constant — a version of this test that passed a fixed
    // 16.7 regardless of what was fed could not have caught F198, which was
    // a bug in that computation, not in QualityGovernor itself.
    const s = new FrameSampler()
    const g = new QualityGovernor()
    g.setMode('medium') // tier 2
    g.setMode('auto')
    const startTier = g.tier

    s.suspend()
    let ema = 16.7
    let t: number
    ;({ t, ema } = feedWithEma(s, 20, 250, ema)) // the stall, correctly suspended
    // Five governor decisions at SETTLE_SEC spacing over healthy frames.
    for (let step = 0; step < 5; step++) {
      ;({ t, ema } = feedWithEma(s, 120, 16.7, ema, t))
      g.tick(ema, 10 + step * 2.5, s.governorP95())
    }
    // The invariant is that it must not CASCADE DOWNWARD off one suspended
    // stall. Climbing is the correct response to a genuinely healthy run —
    // 16.7 ms is the refresh interval, i.e. every frame landing on time — so
    // only the downward direction is pinned here.
    expect(g.tier).toBeLessThanOrEqual(startTier)
  })

  it('F198: the mean-axis ema is blind during a suspension, matching the p95 window', () => {
    const s = new FrameSampler()
    let ema = 16.7
    s.suspend(20)
    ;({ ema } = feedWithEma(s, 20, 158.4, ema)) // the warm-mount stall this bug was found from
    // The whole point: a suspended frame must not move the governor's ema at
    // all, exactly as it already does not move governorP95().
    expect(ema).toBe(16.7)
    expect(s.governorP95()).toBe(0)
  })

  it('F198 regression: an unguarded ema WOULD have crossed the demote gate on this stall', () => {
    // Not testing frameSampler here — establishing that the scenario is real.
    // A naive 0.05-alpha ema fed one 158.4ms frame moves from 16.7 to 23.8,
    // past quality.ts's STEP_DOWN_MEAN_RATIO gate (16.67 * 1.1 = 18.3) — the
    // exact arithmetic the live session showed. stepGovernorEma must refuse
    // to reproduce this while suspended (covered above); this pins the
    // number so a future change to the decay rate can't silently reopen it
    // without a test noticing the gate is still crossed unguarded.
    const naive = 16.7 + (158.4 - 16.7) * 0.05
    expect(naive).toBeGreaterThan(16.67 * 1.1)
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
