import { describe, expect, it } from 'vitest'
import { DropStateMachine } from '../dropStateMachine'

const DT = 0.05

/** Feed `n` frames of (subBass, transient) at a fixed `dt`, returning true if ANY frame fired. */
function feed(m: DropStateMachine, n: number, subBass: number, transient: number, dt = DT): boolean {
  let fired = false
  for (let i = 0; i < n; i++) if (m.update(subBass, transient, dt)) fired = true
  return fired
}

/** Seed a stable baseline near `level` (steady input, no transients, well past the EMA settling time). */
function seedBaseline(m: DropStateMachine, level: number) {
  feed(m, 200, level, 0, DT) // 10s at dt=0.05, several tau=8s time constants
}

describe('DropStateMachine', () => {
  it('never fires without a preceding real dip (steady level + occasional transient spikes)', () => {
    const m = new DropStateMachine()
    seedBaseline(m, 0.7)
    let fired = false
    for (let i = 0; i < 400; i++) {
      // Every ~10th frame throws in a transient spike, but subBass never dips.
      const transient = i % 10 === 0 ? 0.9 : 0.1
      if (m.update(0.7 + (i % 3 === 0 ? 0.05 : 0), transient, DT)) fired = true
    }
    expect(fired).toBe(false)
  })

  it('fires on a synthetic breakdown-then-snap-back sequence', () => {
    const m = new DropStateMachine()
    seedBaseline(m, 0.8) // baseline settles near 0.8
    // Breakdown: sub+bass well under 0.4*0.8=0.32, sustained > dipMinSec (1.5s @ 36 frames of 0.05s = 1.8s).
    expect(feed(m, 36, 0.15, 0, DT)).toBe(false)
    // Snap-back: sub+bass jumps back to/above baseline WITH a concurrent transient, same frame.
    const fired = m.update(0.85, 0.9, DT)
    expect(fired).toBe(true)
  })

  it('does not fire if sub+bass rises back SLOWLY (a gradual climb, not a snap)', () => {
    const m = new DropStateMachine()
    seedBaseline(m, 0.8)
    // Genuine breakdown first.
    expect(feed(m, 36, 0.15, 0, DT)).toBe(false)
    // Now climb gradually from 0.15 back up past baseline over ~3s (60 frames @ 0.05s),
    // well beyond the 0.5s snap window, with a transient thrown in near the top of the climb.
    let fired = false
    for (let i = 0; i < 60; i++) {
      const level = 0.15 + (0.85 - 0.15) * (i / 59)
      const transient = i > 50 ? 0.9 : 0
      if (m.update(level, transient, DT)) fired = true
    }
    expect(fired).toBe(false)
  })

  it('does not fire if the dip was too short (a single quiet beat, not a breakdown)', () => {
    const m = new DropStateMachine()
    seedBaseline(m, 0.8)
    // Only 0.3s of "deep" (6 frames @ 0.05s), well under the 1.5s dip-confirmation floor.
    expect(feed(m, 6, 0.15, 0, DT)).toBe(false)
    // Snap back immediately with a concurrent transient.
    const fired = m.update(0.85, 0.9, DT)
    expect(fired).toBe(false)
  })

  it('releases a stale arm (no snap-back within the timeout) and is ready to arm again afterwards', () => {
    // Small overrides purely to keep the simulated timeline short or to sanity-check the boundary —
    // the FSM logic under test is identical to the defaults.
    const m = new DropStateMachine({ dipMinSec: 0.5, armTimeoutSec: 1, snapWindowSec: 0.5 })
    seedBaseline(m, 0.8)
    // Arm: 0.5s+ deep.
    expect(feed(m, 12, 0.15, 0, DT)).toBe(false) // 0.6s
    // Stay deep well past the 1s stale-arm timeout without ever snapping back.
    expect(feed(m, 30, 0.15, 0, DT)).toBe(false) // +1.5s, armed -> released (still deep throughout)
    // The FSM was released mid-batch (still deep) and re-entered "dipping" for the remaining frames,
    // but has NOT yet re-accumulated a fresh dipMinSec — so an immediate snap attempt right now must
    // NOT fire. If it were still latched "armed" from before the timeout, this WOULD fire.
    expect(m.update(0.85, 0.9, DT)).toBe(false)
    // That snap attempt (subBass above the dip threshold) reset the in-progress fresh dip; re-establish
    // a full qualifying breakdown from scratch and confirm it can arm (and fire) again.
    expect(feed(m, 12, 0.15, 0, DT)).toBe(false) // fresh 0.6s deep, re-arms
    // Now the snap-back should be able to fire again — proof the FSM is "ready to arm again", not
    // permanently latched inert by the earlier stale release.
    expect(m.update(0.85, 0.9, DT)).toBe(true)
  })

  it('is deterministic', () => {
    const run = () => {
      const m = new DropStateMachine()
      seedBaseline(m, 0.8)
      const fires: boolean[] = []
      for (let i = 0; i < 36; i++) fires.push(m.update(0.15, 0, DT))
      fires.push(m.update(0.85, 0.9, DT))
      return fires
    }
    expect(run()).toEqual(run())
  })

  it('is NaN/negative-dt-safe and does not corrupt subsequent behaviour', () => {
    const m = new DropStateMachine()
    expect(() => m.update(NaN, 0.5, DT)).not.toThrow()
    expect(m.update(NaN, 0.5, DT)).toBe(false)
    expect(() => m.update(0.5, NaN, DT)).not.toThrow()
    expect(m.update(0.5, NaN, DT)).toBe(false)
    expect(() => m.update(0.5, 0.5, -1)).not.toThrow()
    expect(m.update(0.5, 0.5, -1)).toBe(false)
    expect(() => m.update(0.5, 0.5, 0)).not.toThrow()
    expect(m.update(0.5, 0.5, 0)).toBe(false)
    expect(() => m.update(0.5, 0.5, NaN)).not.toThrow()
    expect(m.update(0.5, 0.5, NaN)).toBe(false)
    // A normal breakdown/snap-back sequence still works after the bad input.
    seedBaseline(m, 0.8)
    expect(feed(m, 36, 0.15, 0, DT)).toBe(false)
    expect(m.update(0.85, 0.9, DT)).toBe(true)
  })

  it('reset() clears state: a snap right after reset does not fire without a fresh dip, but works after', () => {
    const m = new DropStateMachine()
    seedBaseline(m, 0.8)
    // Get all the way to "armed" (breakdown confirmed, not yet snapped).
    expect(feed(m, 36, 0.15, 0, DT)).toBe(false)
    m.reset()
    // Immediately after reset, a snap-back + transient with NO preceding dip must not fire — a prior
    // armed state must not carry over.
    expect(m.update(0.85, 0.9, DT)).toBe(false)
    // But a fresh instance-like sequence (re-seed, breakdown, snap) behaves exactly as if new.
    seedBaseline(m, 0.8)
    expect(feed(m, 36, 0.15, 0, DT)).toBe(false)
    expect(m.update(0.85, 0.9, DT)).toBe(true)
  })
})
