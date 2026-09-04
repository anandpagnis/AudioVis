import { describe, expect, it } from 'vitest'
import {
  barPhase,
  criticalDamping,
  everyNBars,
  gate,
  impulseClock,
  isDownbeat,
  sinceImpulse,
  slew,
  spring,
  springStep,
} from '../response'

/**
 * The response primitives (engine/response.ts) — the shapes a scene answers the
 * music with. Pure or single-object-mutating by design, so all of this is
 * testable without a GL context, matching the pattern `advanceEffects`,
 * `advanceFilter` and `layerPoolForRole` already follow.
 *
 * What these pin is mostly the properties a SCENE AUTHOR relies on and would
 * not notice breaking: that a spring actually overshoots (the entire reason it
 * exists over `exp()` decay), that a gate replays identically, and that nothing
 * detonates on the frame someone alt-tabs back.
 */

/** Advance a spring `steps` times at a fixed dt, returning the value history. */
function run(target: number, steps: number, dt: number, stiffness: number, damping: number) {
  const st = spring(0)
  const history: number[] = []
  for (let i = 0; i < steps; i++) history.push(springStep(st, target, dt, stiffness, damping))
  return history
}

describe('springStep', () => {
  it('overshoots when under-damped — the whole reason it exists over exp() decay', () => {
    // `exp(-dt*k)` can only ever fall toward its target. If this never exceeds
    // the target, the primitive is just a worse one-pole and the entire
    // "a hit should read as having mass" premise is gone.
    const history = run(1, 200, 1 / 60, 180, criticalDamping(180) * 0.35)
    expect(Math.max(...history)).toBeGreaterThan(1)
  })

  it('settles at the target rather than ringing forever', () => {
    const history = run(1, 600, 1 / 60, 180, criticalDamping(180) * 0.35)
    expect(history[history.length - 1]).toBeCloseTo(1, 2)
  })

  it('does not overshoot at critical damping', () => {
    // The documented contract of `criticalDamping`: fastest approach with no
    // overshoot. A scene that wants a firm, non-bouncy settle relies on this.
    const history = run(1, 400, 1 / 60, 180, criticalDamping(180))
    expect(Math.max(...history)).toBeLessThanOrEqual(1.0001)
    expect(history[history.length - 1]).toBeCloseTo(1, 3)
  })

  it('survives a frame hitch instead of detonating', () => {
    // THE failure this clamp exists for: an unclamped semi-implicit Euler step
    // of half a second at usable stiffness overshoots so far the spring never
    // comes back. A tab returning from the background hands exactly that dt.
    const st = spring(0)
    springStep(st, 1, 0.5, 180, 12)
    expect(Number.isFinite(st.value)).toBe(true)
    expect(Math.abs(st.value)).toBeLessThan(10)
    // And it must still converge afterwards, not sit permanently wrecked.
    for (let i = 0; i < 600; i++) springStep(st, 1, 1 / 60, 180, criticalDamping(180))
    expect(st.value).toBeCloseTo(1, 2)
  })

  it('ignores a non-finite or non-positive dt rather than poisoning the state', () => {
    const st = spring(0.5)
    springStep(st, 1, Number.NaN, 180, 12)
    springStep(st, 1, 0, 180, 12)
    springStep(st, 1, -1, 180, 12)
    expect(st.value).toBe(0.5)
    expect(st.velocity).toBe(0)
  })
})

describe('slew', () => {
  it('rises and falls at genuinely different rates', () => {
    // The point of the primitive: one identical kick envelope can read as a
    // struck bell (fast attack, slow release) or a swell that gets cut off.
    const up = slew(0, 1, 1 / 60, 20, 1)
    const down = slew(1, 0, 1 / 60, 20, 1)
    expect(up).toBeGreaterThan(0.2)
    expect(1 - down).toBeLessThan(0.05)
  })

  it('reduces to approach() when both rates match', () => {
    // Documented equivalence — a scene wanting symmetric smoothing should get
    // exactly the existing helper's behaviour, not a subtly different curve.
    const dt = 1 / 60
    const rate = 8
    const expected = 0 + (1 - 0) * (1 - Math.exp(-dt * rate))
    expect(slew(0, 1, dt, rate, rate)).toBeCloseTo(expected, 12)
  })

  it('never overshoots, however large the step', () => {
    // The snapping failure `approach`'s own doc records: the first-order form
    // clamps and teleports once dt*rate >= 1. The exponential form asymptotes.
    expect(slew(0, 1, 10, 50, 50)).toBeLessThanOrEqual(1)
    expect(slew(1, 0, 10, 50, 50)).toBeGreaterThanOrEqual(0)
  })

  it('holds still on a bad dt', () => {
    expect(slew(0.3, 1, Number.NaN, 10, 10)).toBe(0.3)
    expect(slew(0.3, 1, 0, 10, 10)).toBe(0.3)
  })
})

describe('sinceImpulse', () => {
  it('reports a large finite number before the first fire, never Infinity', () => {
    // A shader multiplying by Infinity produces NaN and the scene renders
    // black with no error anywhere — the exact silent-failure class this
    // codebase keeps hitting.
    const c = impulseClock()
    const v = sinceImpulse(c, 5)
    expect(Number.isFinite(v)).toBe(true)
    expect(v).toBeGreaterThan(100)
  })

  it('measures forward from the moment it fired', () => {
    const c = impulseClock()
    sinceImpulse(c, 10, true)
    expect(sinceImpulse(c, 10)).toBeCloseTo(0, 10)
    expect(sinceImpulse(c, 10.5)).toBeCloseTo(0.5, 10)
  })

  it('recovers from a source restart rewinding the clock', () => {
    // `features.time` restarts at 0 on a new source, leaving lastAt in the
    // future — same hazard EffectDirector's own retire pass guards against.
    const c = impulseClock()
    sinceImpulse(c, 90, true)
    const v = sinceImpulse(c, 0.5)
    expect(Number.isFinite(v)).toBe(true)
    expect(v).toBeGreaterThan(100)
  })
})

describe('gate', () => {
  it('is deterministic — the same seed always decides the same way', () => {
    // Hard requirement, not tidiness: a recorded show has to replay
    // identically, and a Math.random() gate would make every playback of the
    // same session a different edit. Same reasoning as pickTransitionStyle's
    // deterministic rotation.
    for (const seed of [0, 1, 7, 42, 1000]) {
      expect(gate(seed, 0.5)).toBe(gate(seed, 0.5))
    }
  })

  it('honours the extremes exactly', () => {
    for (const seed of [0, 3, 99]) {
      expect(gate(seed, 1)).toBe(true)
      expect(gate(seed, 0)).toBe(false)
    }
  })

  it('fires roughly at the requested rate over many seeds', () => {
    // Not a distribution proof — just enough to catch a hash that is stuck,
    // constant, or wildly biased, which would silently turn "fires sometimes"
    // into "never fires" and look like a broken scene.
    const n = 2000
    let fired = 0
    for (let i = 0; i < n; i++) if (gate(i, 0.3)) fired++
    expect(fired / n).toBeGreaterThan(0.2)
    expect(fired / n).toBeLessThan(0.4)
  })
})

describe('structural gates', () => {
  it('isDownbeat picks out beat 0 only', () => {
    expect(isDownbeat(0)).toBe(true)
    expect(isDownbeat(1)).toBe(false)
    expect(isDownbeat(3)).toBe(false)
    // beatInBar is documented 0..3 but arrives as a float in places.
    expect(isDownbeat(0.4)).toBe(true)
  })

  it('barPhase ramps 0..1 across the bar and wraps', () => {
    expect(barPhase(0, 0)).toBeCloseTo(0, 10)
    expect(barPhase(2, 0)).toBeCloseTo(0.5, 10)
    expect(barPhase(3, 0.99)).toBeGreaterThan(0.9)
    // Wraps rather than growing without bound as beatIndex accumulates.
    expect(barPhase(4, 0)).toBeCloseTo(0, 10)
    expect(barPhase(400, 0)).toBeCloseTo(0, 10)
  })

  it('barPhase honours a non-default bar length', () => {
    expect(barPhase(4, 0, 8)).toBeCloseTo(0.5, 10)
  })

  it('everyNBars only ever fires on a downbeat', () => {
    for (let beatInBar = 1; beatInBar < 4; beatInBar++) {
      expect(everyNBars(8, beatInBar, 2)).toBe(false)
    }
  })

  it('everyNBars fires on the right bars', () => {
    // beatIndex 0,8,16 are bars 0,2,4 — every 2nd bar. 4 is bar 1, which is not.
    expect(everyNBars(0, 0, 2)).toBe(true)
    expect(everyNBars(4, 0, 2)).toBe(false)
    expect(everyNBars(8, 0, 2)).toBe(true)
    expect(everyNBars(16, 0, 2)).toBe(true)
  })
})
