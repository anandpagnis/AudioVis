import { describe, expect, it } from 'vitest'
import { QualityGovernor , snapToRefreshInterval } from '../quality'

/**
 * The quality governor's two axes.
 *
 * The one that matters here is VARIANCE. `perf.ms` is an EMA with α = 0.05 —
 * roughly a 20-frame time constant — so a single 200 ms stall lifts it by about
 * 9 ms and has decayed back out before the governor's own SETTLE_SEC elapses.
 * It never reacted. That is the wrong blind spot for this project to carry: the
 * standing rule is "buttery smooth beats visual ambition; frame-time variance
 * matters more than richness", and the component enforcing it was measuring
 * only the mean.
 *
 * Each test drives a FRESH governor. The production `quality` export is a
 * module singleton carrying a tier plus two hysteresis timers, so sharing it
 * across tests means asserting against whatever the previous test left behind.
 */

/** A governor placed at `tier`, in auto mode, with its timers at zero. */
function governorAt(tier: number): QualityGovernor {
  const g = new QualityGovernor()
  // `pinTier` reaches every rung; `setMode` only maps to 4/2/0, so the earlier
  // version of this helper silently placed tiers 1 and 3 at tier 4 and any test
  // using them was asserting against the wrong starting point.
  g.pinTier(tier)
  // Hand the walker back control without disturbing the placement.
  g.setMode('auto')
  return g
}

/** Time cursor helper: every tick is spaced past SETTLE_SEC (2s). */
const T0 = 10
const T1 = 20
const T2 = 30

describe('quality governor — mean axis', () => {
  it('steps down on a bad mean, as it always did', () => {
    const g = governorAt(2)
    g.tick(30, T0, 8)
    expect(g.tier).toBe(3)
  })

  it('still sheds load under a fixed quality — the setting is a CEILING', () => {
    // This test used to assert the opposite ("does nothing at all while pinned
    // to a fixed quality"), and that assertion was the bug (F116). A fixed mode
    // set `auto = false`, and `tick` returns on its first line when that is
    // false — so choosing a quality did not bias the ladder, it deleted it.
    //
    // The first real session recording caught it: 77 s at a p95 of 80-96 ms on
    // a 4K panel with ZERO tier changes, because the store's quality was `high`
    // and `FIXED_TIER.high` is 0. A 300 ms frame must never be something the
    // governor is contractually obliged to ignore.
    const g = new QualityGovernor()
    g.setMode('high')
    g.tick(300, T0, 400)
    expect(g.tier).toBeGreaterThan(0)
  })

  it('will not climb back above the ceiling a fixed quality sets', () => {
    // The other half of "ceiling": the setting still means something. `medium`
    // caps at tier 2, so a machine with headroom to spare stops there instead
    // of walking up to 0.
    const g = new QualityGovernor()
    g.setMode('medium')
    expect(g.tier).toBe(2)
    // Sustained headroom, well past CLIMB_HOLD_SEC.
    for (let t = 0; t < 60; t++) g.tick(8, T0 + t, 9)
    expect(g.tier).toBe(2)
  })

  it('lets `auto` climb all the way back to the richest tier', () => {
    const g = new QualityGovernor()
    g.setMode('low') // ceiling 4
    g.setMode('auto') // ceiling cleared
    for (let t = 0; t < 120; t++) g.tick(8, T0 + t, 9)
    expect(g.tier).toBe(0)
  })

  it('will not step below the last tier', () => {
    const g = governorAt(4)
    g.tick(300, T0, 400)
    g.tick(300, T1, 400)
    expect(g.tier).toBe(4)
  })
})

describe('quality governor — variance axis', () => {
  it('steps down on a bad p95 even when the mean looks healthy', () => {
    // The regression this axis exists for: 16 ms average is a solid 60 fps,
    // and a 60 ms p95 means a visible hitch is landing regularly. The old
    // EMA-only governor read this frame budget as comfortable and sat still.
    const g = governorAt(2)
    g.tick(16, T0, 60)
    expect(g.tier).toBe(3)
  })

  it('holds the tier when the mean is clear but spikes remain', () => {
    const g = governorAt(2)
    // The middle band: at a 16.67 ms refresh the step-up gate is 1.25x (20.8 ms)
    // and the step-down gate is 1.5x (25 ms), so a p95 of 23 is not bad enough
    // to shed load nor clean enough to earn more. The mean alone (8 ms, well
    // inside the step-up ratio) would have climbed here, which is exactly the
    // promotion this axis exists to refuse.
    g.tick(8, T0, 23)
    g.tick(8, T1, 23)
    g.tick(8, T2, 23)
    expect(g.tier).toBe(2)
  })

  it('climbs when both axes are clear and the hold has elapsed', () => {
    const g = governorAt(2)
    g.tick(8, T0, 14)
    expect(g.tier).toBe(1)
  })

  it('treats a missing p95 as inert rather than as a stall', () => {
    // The parameter defaults to 0 so a two-argument caller keeps the exact
    // pre-existing behaviour. A missing signal must never hold the tier down.
    const g = governorAt(2)
    g.tick(8, T0)
    expect(g.tier).toBe(1)
  })

  it('lets a spike force a step down even from a freshly-climbed tier', () => {
    const g = governorAt(2)
    g.tick(8, T0, 14)
    expect(g.tier).toBe(1)
    g.tick(8, T1, 80)
    expect(g.tier).toBe(2)
  })
})

/**
 * The transition discount.
 *
 * A crossfade renders both primaries at full cost for its whole duration, and a
 * warming candidate renders beside the current scene too — so for about a second
 * per switch the frame carries twice the scene work it was tiered for. That is
 * why transitions stuttered on essentially every switch rather than randomly,
 * and why the `bothHeavy` hard-cut did not catch it (at tier 0 the budget funds
 * two heavy primaries, so even the worst pair crossfades).
 */
describe('quality governor — transition discount', () => {
  it('drops complexity while two primaries share the frame', () => {
    const g = governorAt(0)
    const full = g.knobs.raymarchSteps
    g.setTransitionDiscount(1)
    expect(g.knobs.raymarchSteps).toBeLessThan(full)
  })

  it('restores full complexity when the transition ends', () => {
    const g = governorAt(0)
    const full = g.knobs.raymarchSteps
    g.setTransitionDiscount(1)
    g.setTransitionDiscount(0)
    expect(g.knobs.raymarchSteps).toBe(full)
  })

  it('leaves pixelBudgetScale alone', () => {
    // Moving the budget re-solves the render scale, which resizes the renderer
    // and reallocates the post chain — far more expensive than the discount
    // saves, and it would fire at the start of every single crossfade.
    const g = governorAt(0)
    const scale = g.knobs.pixelBudgetScale
    g.setTransitionDiscount(1)
    expect(g.knobs.pixelBudgetScale).toBe(scale)
  })

  it('leaves the composition budget alone', () => {
    // Layers are chosen at phrase boundaries. If the budget moved because a
    // transition happened to be in flight, layers would be dropped mid-fade.
    const g = governorAt(0)
    const budget = g.knobs.frameBudgetMs
    g.setTransitionDiscount(1)
    expect(g.knobs.frameBudgetMs).toBe(budget)
  })

  it('is idempotent, so it can be called every frame', () => {
    const g = governorAt(0)
    g.setTransitionDiscount(1)
    const first = g.knobs
    g.setTransitionDiscount(1)
    expect(g.knobs).toBe(first)
  })

  it('clamps at the last tier instead of running off the ladder', () => {
    const g = governorAt(4)
    g.setTransitionDiscount(1)
    expect(g.knobs.raymarchSteps).toBeGreaterThan(0)
    expect(g.knobs.pixelBudgetScale).toBe(governorAt(4).knobs.pixelBudgetScale)
  })

  it('survives a tier change while discounting', () => {
    // The governor can step down mid-crossfade; the discount must still apply
    // to the NEW tier rather than being silently dropped.
    const g = governorAt(0)
    g.setTransitionDiscount(1)
    const discountedAt0 = g.knobs.raymarchSteps
    g.tick(30, 10, 8) // force a step down
    expect(g.tier).toBe(1)
    expect(g.knobs.raymarchSteps).toBeLessThanOrEqual(discountedAt0)
  })
})

/**
 * Regression for the field report: a panel reading `mean 18.7ms p95 32.3ms`
 * with the tier sitting still.
 *
 * That is the exact signature of a 60 Hz display dropping roughly one frame in
 * eight — and the old absolute thresholds (20 ms mean, 34 ms p95) both sat just
 * ABOVE it, so the governor watched the frame rate fall over and did nothing.
 */
describe('quality governor — refresh-relative thresholds', () => {
  it('sheds load at the 60Hz drop signature the old gates ignored', () => {
    const g = governorAt(1)
    g.setRefreshInterval(1000 / 60)
    g.tick(18.7, T0, 32.3)
    expect(g.tier).toBe(2)
  })

  it('does not shed load at a healthy 60Hz', () => {
    const g = governorAt(1)
    g.setRefreshInterval(1000 / 60)
    g.tick(16.8, T0, 17.0)
    expect(g.tier).toBeLessThanOrEqual(1)
  })

  it('scales to a high-refresh display', () => {
    // 20 ms on a 144 Hz panel is three dropped frames. The old absolute gates
    // called that healthy; as a ratio of a 6.9 ms interval it is plainly not.
    const g = governorAt(1)
    g.setRefreshInterval(1000 / 144)
    g.tick(12, T0, 20)
    expect(g.tier).toBe(2)
  })

  it('treats the same numbers as healthy on a 60Hz panel', () => {
    // Same frame times, different display: 12 ms mean beats a 16.7 ms interval.
    const g = governorAt(1)
    g.setRefreshInterval(1000 / 60)
    g.tick(12, T0, 20)
    expect(g.tier).toBeLessThanOrEqual(1)
  })

  it('clamps an absurd measured interval', () => {
    // A backgrounded tab throttles rAF to ~1 Hz. Left unclamped that would make
    // every threshold enormous and pin the tier at 0 forever.
    const g = governorAt(1)
    g.setRefreshInterval(1000)
    g.tick(60, T0, 90)
    expect(g.tier).toBe(2)
  })

  it('ignores a non-finite measurement', () => {
    const g = governorAt(1)
    g.setRefreshInterval(Number.NaN)
    g.tick(18.7, T0, 32.3)
    expect(g.tier).toBe(2)
  })
})

/**
 * Properties the first version of the discount got wrong, reported as "the ms
 * didn't rise but it still lagged".
 *
 * Nothing was slow — the discount was simply degrading the picture, visibly and
 * far more often than it should have. Frame times looked healthy the whole time,
 * which is exactly why it read as a mystery.
 */
describe('quality governor — discount must be imperceptible', () => {
  it('never removes particles', () => {
    // particleFraction drives setDrawRange, so discounting it makes points
    // literally vanish — 44% of plasma's cloud at tier 1. That is a glitch, not
    // a quality change, and it is the one knob a viewer cannot miss.
    const g = governorAt(1)
    const full = g.knobs.particleFraction
    g.setTransitionDiscount(1)
    expect(g.knobs.particleFraction).toBe(full)
  })

  it('slides continuously rather than stepping', () => {
    const g = governorAt(0)
    const full = g.knobs.raymarchSteps
    g.setTransitionDiscount(1)
    const floor = g.knobs.raymarchSteps
    g.setTransitionDiscount(0.5)
    const half = g.knobs.raymarchSteps
    // A partial amount must land strictly between the endpoints, which is what
    // lets the caller ease it in without a pop at either end.
    expect(half).toBeLessThan(full)
    expect(half).toBeGreaterThan(floor)
  })

  it('is fully reversible', () => {
    const g = governorAt(1)
    const before = { ...g.knobs }
    g.setTransitionDiscount(1)
    g.setTransitionDiscount(0)
    expect(g.knobs).toEqual(before)
  })

  it('keeps loop bounds at or above 1 at the bottom tier', () => {
    // Rounding a mix toward the survival tier must never produce a zero-length
    // loop, which would blank the scene outright.
    const g = governorAt(4)
    g.setTransitionDiscount(1)
    expect(g.knobs.noiseOctaves).toBeGreaterThanOrEqual(1)
    expect(g.knobs.fluidJacobi).toBeGreaterThanOrEqual(1)
    expect(g.knobs.raymarchSteps).toBeGreaterThan(0)
  })

  it('allocates nothing while easing', () => {
    // The knobs object is mutated in place: an ease that allocated per frame
    // would reintroduce exactly the GC pressure F11 removed.
    const g = governorAt(1)
    g.setTransitionDiscount(0.3)
    const first = g.knobs
    g.setTransitionDiscount(0.7)
    expect(g.knobs).toBe(first)
  })
})

describe('snapToRefreshInterval', () => {
  it('rounds a measured 60 Hz panel back onto 16.67, not 15.70', () => {
    // The number that made F119 real. `PerfMonitor` estimates the display
    // interval from the 10th percentile of frame times, and a session recording
    // measured that p10 at 15.70 ms on a locked 60 Hz display — because 13.3%
    // of frames arrive EARLY (the compositor catching up after a late one), so
    // the fast tail sits below the interval rather than on it.
    //
    // A 6% underestimate is fatal at these gates: it puts the STEADY line at
    // 16.48 ms, below the vsync interval, so a perfect 60 fps can never be
    // judged steady and sits a hair under the demote line forever.
    expect(snapToRefreshInterval(15.7)).toBeCloseTo(1000 / 60, 3)
  })

  it('snaps high-refresh panels to their own rate, not to 60', () => {
    expect(snapToRefreshInterval(6.5)).toBeCloseTo(1000 / 144, 3)
    expect(snapToRefreshInterval(8.0)).toBeCloseTo(1000 / 120, 3)
    expect(snapToRefreshInterval(4.0)).toBeCloseTo(1000 / 240, 3)
  })

  it('leaves an exact measurement exactly where it is', () => {
    expect(snapToRefreshInterval(1000 / 60)).toBeCloseTo(1000 / 60, 6)
    expect(snapToRefreshInterval(1000 / 144)).toBeCloseTo(1000 / 144, 6)
  })

  it('passes through anything not near a real display rate', () => {
    // An unusual panel degrades to the previous behaviour rather than being
    // snapped onto a rate it is not running at.
    expect(snapToRefreshInterval(30)).toBe(30)
    expect(snapToRefreshInterval(0)).toBe(0)
  })

  it('never lets a perfect 60 fps frame read as overloaded', () => {
    // The end-to-end statement of the bug, at the governor rather than the
    // helper: a machine holding vsync exactly must be able to CLIMB.
    const g = new QualityGovernor()
    g.setMode('auto')
    g.setRefreshInterval(15.7) // what the estimator actually reports at 60 Hz
    for (let t = 0; t < 200; t++) g.tick(1000 / 60, t, 1000 / 60)
    expect(g.tier).toBe(0)
  })
})

/**
 * Failed-rung memory (F149).
 *
 * The governor used to be memoryless, so on a machine that cannot hold its top
 * rung it had no fixed point: climb, overload, demote, wait, climb into the
 * identical failure. A 320 s session recording did that 13 times, and since
 * every tier move forces a render-scale change and a render-scale change
 * reallocates the post chain (F140), the controller was the session's entire
 * source of dropped frames.
 *
 * `STEADY` and `BAD` below are expressed against the default 60 Hz interval:
 * steady needs mean < 17.5 and p95 < 20.8; overloaded needs mean > 18.3 or
 * p95 > 25.0.
 */
describe('quality governor — failed-rung memory', () => {
  const STEADY = { ms: 16.6, p95: 16.7 }
  const BAD = { ms: 21, p95: 24 }

  it('does not immediately re-enter a rung that failed its probe', () => {
    const g = governorAt(1)
    // Steady long enough to earn the climb (CLIMB_HOLD_SEC = 4).
    g.tick(STEADY.ms, 0, STEADY.p95)
    g.tick(STEADY.ms, 10, STEADY.p95)
    expect(g.tier).toBe(0)
    // Tier 0 turns out to be unaffordable, well inside RUNG_PROOF_SEC.
    g.tick(BAD.ms, 13, BAD.p95)
    expect(g.tier).toBe(1)
    // Steady again, and past CLIMB_HOLD_SEC — the old governor climbed here.
    g.tick(STEADY.ms, 20, STEADY.p95)
    g.tick(STEADY.ms, 26, STEADY.p95)
    expect(g.tier).toBe(1)
  })

  it('re-probes the rung once the back-off expires', () => {
    const g = governorAt(1)
    g.tick(STEADY.ms, 0, STEADY.p95)
    g.tick(STEADY.ms, 10, STEADY.p95)
    expect(g.tier).toBe(0)
    g.tick(BAD.ms, 13, BAD.p95) // fails at t=13, first back-off is 20s
    expect(g.tier).toBe(1)
    g.tick(STEADY.ms, 20, STEADY.p95)
    g.tick(STEADY.ms, 30, STEADY.p95) // still inside the block (until 33)
    expect(g.tier).toBe(1)
    g.tick(STEADY.ms, 40, STEADY.p95) // block expired
    expect(g.tier).toBe(0)
  })

  it('doubles the back-off on each consecutive failure', () => {
    const g = governorAt(1)
    // Probe 1: climb at 10, fail at 13 -> blocked until 33.
    g.tick(STEADY.ms, 0, STEADY.p95)
    g.tick(STEADY.ms, 10, STEADY.p95)
    g.tick(BAD.ms, 13, BAD.p95)
    // Probe 2: climb at 40, fail at 43 -> blocked until 43 + 40 = 83.
    g.tick(STEADY.ms, 30, STEADY.p95)
    g.tick(STEADY.ms, 40, STEADY.p95)
    expect(g.tier).toBe(0)
    g.tick(BAD.ms, 43, BAD.p95)
    expect(g.tier).toBe(1)
    // 60s in, the first back-off would have expired but the doubled one has not.
    g.tick(STEADY.ms, 60, STEADY.p95)
    g.tick(STEADY.ms, 70, STEADY.p95)
    expect(g.tier).toBe(1)
    g.tick(STEADY.ms, 90, STEADY.p95)
    expect(g.tier).toBe(0)
  })

  it('forgives a rung that survives its probe window', () => {
    const g = governorAt(1)
    g.tick(STEADY.ms, 0, STEADY.p95)
    g.tick(STEADY.ms, 10, STEADY.p95)
    expect(g.tier).toBe(0)
    // Held past RUNG_PROOF_SEC (10s) before anything went wrong, so the later
    // demote is the workload changing, not the rung failing.
    g.tick(STEADY.ms, 25, STEADY.p95)
    g.tick(BAD.ms, 30, BAD.p95)
    expect(g.tier).toBe(1)
    // Free to climb straight back on the next steady window.
    g.tick(STEADY.ms, 34, STEADY.p95)
    g.tick(STEADY.ms, 40, STEADY.p95)
    expect(g.tier).toBe(0)
  })

  it('never blocks a DEMOTION — shedding load stays unconditional', () => {
    const g = governorAt(1)
    g.tick(STEADY.ms, 0, STEADY.p95)
    g.tick(STEADY.ms, 10, STEADY.p95)
    g.tick(BAD.ms, 13, BAD.p95) // tier 0 now carries a back-off
    expect(g.tier).toBe(1)
    // The back-off is recorded against tier 0; tier 1 going bad must still fall.
    g.tick(BAD.ms, 16, BAD.p95)
    expect(g.tier).toBe(2)
    g.tick(BAD.ms, 19, BAD.p95)
    expect(g.tier).toBe(3)
  })

  it('blocks only the rung that failed, not the whole ladder', () => {
    const g = governorAt(2)
    // Climb 2 -> 1, hold it past the probe window so 1 is proven good.
    g.tick(STEADY.ms, 0, STEADY.p95)
    g.tick(STEADY.ms, 10, STEADY.p95)
    expect(g.tier).toBe(1)
    // Climb 1 -> 0 and fail it.
    g.tick(STEADY.ms, 16, STEADY.p95)
    expect(g.tier).toBe(0)
    g.tick(BAD.ms, 19, BAD.p95)
    expect(g.tier).toBe(1)
    // Now demote for an unrelated reason and climb back: rung 1 is unblocked.
    g.tick(BAD.ms, 22, BAD.p95)
    expect(g.tier).toBe(2)
    g.tick(STEADY.ms, 26, STEADY.p95)
    g.tick(STEADY.ms, 32, STEADY.p95)
    expect(g.tier).toBe(1)
  })

  it('a display or quality change clears the memory', () => {
    const g = governorAt(1)
    g.tick(STEADY.ms, 0, STEADY.p95)
    g.tick(STEADY.ms, 10, STEADY.p95)
    g.tick(BAD.ms, 13, BAD.p95)
    expect(g.tier).toBe(1)
    // PerfMonitor re-runs setMode in the same effect that re-solves the display,
    // so a window resize arrives here as a mode reassertion.
    g.setMode('auto')
    g.tick(STEADY.ms, 20, STEADY.p95)
    g.tick(STEADY.ms, 26, STEADY.p95)
    expect(g.tier).toBe(0)
  })
})
