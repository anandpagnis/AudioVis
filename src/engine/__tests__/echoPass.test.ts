import { describe, expect, it } from 'vitest'
import { EchoPass } from '../EchoPass'

/**
 * No GL context is available in this suite (vitest runs in `node`), same
 * posture as `lensPass.test.ts`/`isfFilterPass.test.ts`: what's checkable
 * off-GPU is `Pass.enabled`, which is exactly the lever `setEcho()` sets, not
 * that the shader draws anything or that the tap targets hold the right
 * content — that half needs a real WebGL driver, and is NOT covered here (see
 * the F231/F232 entries in docs/ISSUES.md).
 *
 * `setEcho(echo, tapSpacingSec, dt)` no longer gates `enabled` off the raw
 * `echo` value directly (F232) — it tracks `recentEcho`, a slow internal
 * envelope, specifically so a per-beat pulse that spikes and decays every
 * beat does not thrash `enabled` (and the tap-clearing it triggers) on that
 * same cadence. A large `dt` forces that envelope to fully converge to the
 * new `echo` value in one call — `Math.min(1, rate * dt)` saturates to 1 well
 * before `dt` reaches 1s at either rate this class uses — which is what makes
 * "on" and "off" steady-state testable in a single call; the hysteresis test
 * below uses a small, realistic `dt` instead, specifically to exercise the
 * behaviour the large-`dt` tests deliberately skip past.
 */
describe('EchoPass.setEcho — steady state', () => {
  it('enables above the off threshold, given time to rise', () => {
    const pass = new EchoPass()
    pass.setEcho(0.5, 0.25, 1)
    expect(pass.enabled).toBe(true)
  })

  it('disables at and below the off threshold, given time to fall', () => {
    const pass = new EchoPass()
    pass.setEcho(0.5, 0.25, 1)
    // 0.01, not exactly the 0.02 off threshold itself: `recentEcho`'s
    // floating-point arithmetic can land a hair above or below an input
    // chosen to sit exactly ON the boundary, which is a property of
    // comparing floats near a threshold, not of the hysteresis logic this
    // test means to exercise.
    pass.setEcho(0.01, 0.25, 2)
    expect(pass.enabled).toBe(false)
    pass.setEcho(0, 0.25, 2)
    expect(pass.enabled).toBe(false)
  })

  it('re-enables cleanly after being switched off', () => {
    const pass = new EchoPass()
    pass.setEcho(0.6, 0.25, 1)
    pass.setEcho(0, 0.25, 2)
    pass.setEcho(0.6, 0.25, 1)
    expect(pass.enabled).toBe(true)
  })
})

describe('EchoPass.setEcho — the per-beat hysteresis (F232)', () => {
  it('does not disable between two beats, only a real quiet stretch', () => {
    const pass = new EchoPass()
    // A strong beat, then several frames of a realistic 60fps delta where the
    // pulse has decayed toward zero (as `beatPulse()` does approaching the
    // next beat) — this must NOT read as "the rack turned off," which is
    // exactly the flicker this whole rewrite exists to prevent (see the
    // class header's `recentEcho` section).
    pass.setEcho(0.9, 0.25, 1 / 60)
    expect(pass.enabled).toBe(true)
    for (let i = 0; i < 20; i++) pass.setEcho(0, 0.25, 1 / 60)
    expect(pass.enabled).toBe(true)
  })

  it('does eventually disable over a genuinely long quiet stretch', () => {
    const pass = new EchoPass()
    pass.setEcho(0.9, 0.25, 1)
    expect(pass.enabled).toBe(true)
    // Several seconds of real elapsed time at zero — long enough for the
    // slow-decay envelope to actually clear the off threshold.
    for (let i = 0; i < 10; i++) pass.setEcho(0, 0.25, 1)
    expect(pass.enabled).toBe(false)
  })
})
