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

/** Frames for `sec` seconds at DT. */
const frames = (sec: number) => Math.round(sec / DT)

/**
 * A four-on-the-floor loop at 120 BPM as a sub+bass envelope the way `AudioEngine` produces it (BandNormalizer's
 * release is 5/s, i.e. tau ~0.2 s): each kick jumps to ~0.96 and decays exponentially onto a small sustained
 * floor (bass line / kick tail), flux spikes on the kick frame only. `skip` = beat numbers whose kick is MISSING
 * (the envelope just keeps decaying). Returns how many frames fired.
 */
function kickLoop(m: DropStateMachine, beats: number, skip: number[] = [], floor = 0.06, tau = 0.2, from = 0): number {
  let lastKick = -100
  let fired = 0
  for (let b = from; b < from + beats; b++) {
    for (let k = 0; k < 10; k++) {
      const t = b * 0.5 + k * DT
      const kick = k === 0 && !skip.includes(b)
      if (kick) lastKick = t
      const level = floor + 0.9 * Math.exp(-(t - lastKick) / tau)
      if (m.update(level, kick ? 0.9 : 0.05, DT)) fired++
    }
  }
  return fired
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

  it('never fires on steady audio with realistic level wobble, over a long run', () => {
    const m = new DropStateMachine()
    let seed = 42
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    seedBaseline(m, 0.7)
    let fired = false
    for (let i = 0; i < frames(120); i++) {
      const level = 0.7 + 0.12 * (rand() - 0.5) + 0.05 * Math.sin(i * 0.1)
      if (m.update(level, rand() < 0.15 ? 0.8 : 0.1, DT)) fired = true
    }
    expect(fired).toBe(false)
  })

  it('fires on a synthetic breakdown-then-snap-back sequence', () => {
    const m = new DropStateMachine()
    seedBaseline(m, 0.8) // baseline settles near 0.8
    // Breakdown: sub+bass well under 0.4*0.8=0.32, sustained well past dipMinSec (0.7s @ 36 frames of 0.05s = 1.8s).
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

  // NEW: the slow-volume-swell false-positive guard, on both triggers (with and without a transient at the top).
  it('does not fire on a slow volume swell — a long fade down, a hold, and a slow swell back up', () => {
    for (const transientAtTop of [0.9, 0]) {
      const m = new DropStateMachine()
      seedBaseline(m, 0.8)
      let fired = false
      const step = (level: number, transient: number) => {
        if (m.update(level, transient, DT)) fired = true
      }
      for (let i = 0; i < frames(6); i++) step(0.8 - 0.7 * (i / frames(6)), 0) // 6 s fade down to 0.1
      for (let i = 0; i < frames(3); i++) step(0.1, 0) // hold quiet (deep for seconds: armed)
      for (let i = 0; i < frames(6); i++) step(0.1 + 0.75 * (i / frames(6)), i > frames(5) ? transientAtTop : 0) // 6 s swell back
      for (let i = 0; i < frames(4); i++) step(0.85, transientAtTop)
      expect(fired, `transient at top ${transientAtTop}`).toBe(false)
    }
  })

  it('does not fire on a slow fade-IN from quiet (no dip below a moving baseline)', () => {
    const m = new DropStateMachine()
    let fired = false
    for (let i = 0; i < frames(20); i++) {
      if (m.update(0.1 + 0.7 * (i / frames(20)), i % 20 === 0 ? 0.9 : 0.1, DT)) fired = true
    }
    expect(fired).toBe(false)
  })

  // UPDATED (was 1.5 s): dipMinSec is now 0.7 s. The 0.3 s case is unchanged in spirit — a single quiet beat.
  it('does not fire if the dip was too short (a 0.3 s gap, a single quiet beat, not a breakdown)', () => {
    const m = new DropStateMachine()
    seedBaseline(m, 0.8)
    // Only 0.3s of "deep" (6 frames @ 0.05s), well under the 0.7s dip-confirmation floor.
    expect(feed(m, 6, 0.15, 0, DT)).toBe(false)
    // Snap back immediately with a concurrent transient.
    const fired = m.update(0.85, 0.9, DT)
    expect(fired).toBe(false)
  })

  it('does not fire on a 0.5 s gap either (still under the 0.7 s floor)', () => {
    const m = new DropStateMachine()
    seedBaseline(m, 0.8)
    expect(feed(m, frames(0.5), 0.15, 0, DT)).toBe(false)
    expect(m.update(0.85, 0.9, DT)).toBe(false)
  })

  // NEW (this is what the looser floor is for): the ~1-beat hush producers leave right before a drop. It used to
  // need 1.5 s of continuous deep time and so never armed.
  it('fires after a pre-drop gap of >= 0.8 s (0.8 / 0.9 / 1.2 s), which the old 1.5 s floor never armed on', () => {
    for (const gapSec of [0.8, 0.9, 1.2]) {
      const m = new DropStateMachine()
      seedBaseline(m, 0.8)
      expect(feed(m, frames(gapSec), 0.15, 0, DT), `gap ${gapSec}`).toBe(false)
      expect(m.update(0.85, 0.9, DT), `gap ${gapSec}`).toBe(true)
    }
    // The previous behaviour (1.5 s floor, reset-on-flicker) stays reachable through the options and does not fire.
    const old = new DropStateMachine({ dipMinSec: 1.5, dipLeak: 1e9 })
    seedBaseline(old, 0.8)
    feed(old, frames(0.9), 0.15, 0, DT)
    expect(old.update(0.85, 0.9, DT)).toBe(false)
  })

  // NEW: LEAKY dip timer. Previously one non-deep frame zeroed a genuine breakdown's accumulated dip.
  describe('leaky dip timer', () => {
    it('a single flicker back above the dip threshold mid-breakdown drains the timer instead of zeroing it', () => {
      const run = (opts: ConstructorParameters<typeof DropStateMachine>[0]) => {
        const m = new DropStateMachine(opts)
        seedBaseline(m, 0.8) // deep threshold 0.32
        feed(m, 10, 0.15, 0, DT) // 0.5 s deep
        m.update(0.5, 0, DT) // ONE frame above the threshold (still below baseline): a flicker
        feed(m, 10, 0.15, 0, DT) // 0.5 s deep again
        return m.update(0.85, 0.9, DT)
      }
      expect(run({})).toBe(true) // 0.5 - 0.1 (leak) + 0.5 = 0.9 s >= 0.7
      expect(run({ dipLeak: 1e9 })).toBe(false) // reset-to-zero: 0.5 s < 0.7
    })

    it('a longer non-deep stretch still drains the dip completely (a quiet stretch is not a breakdown)', () => {
      const m = new DropStateMachine()
      seedBaseline(m, 0.8)
      feed(m, 10, 0.15, 0, DT) // 0.5 s deep
      feed(m, 10, 0.6, 0, DT) // 0.5 s NOT deep: drains 1.0 s worth -> back to nothing
      feed(m, 10, 0.15, 0, DT) // 0.5 s deep again: not enough on its own
      expect(m.update(0.85, 0.9, DT)).toBe(false)
    })
  })

  // NEW: second trigger. Sub-bass returning to baseline right after a dip is enough by itself when the dip was a
  // long one (>= 1.0 s of deep time), even if the transient/flux input is small.
  describe('low-band-only snap-back', () => {
    it('fires without a transient after a >= 1.0 s dip', () => {
      for (const gapSec of [1.0, 1.2, 2.5]) {
        const m = new DropStateMachine()
        seedBaseline(m, 0.8)
        expect(feed(m, frames(gapSec), 0.15, 0.05, DT)).toBe(false)
        expect(m.update(0.85, 0.05, DT), `gap ${gapSec}`).toBe(true)
      }
    })

    it('a shorter dip (0.8-0.9 s) still needs the transient', () => {
      const m = new DropStateMachine()
      seedBaseline(m, 0.8)
      feed(m, frames(0.9), 0.15, 0.05, DT)
      expect(m.update(0.85, 0.05, DT)).toBe(false)
      const m2 = new DropStateMachine()
      seedBaseline(m2, 0.8)
      feed(m2, frames(0.9), 0.15, 0.05, DT)
      expect(m2.update(0.85, 0.9, DT)).toBe(true)
    })

    it('is still a SNAP: a slow low-band climb after a long dip does not fire on its own', () => {
      const m = new DropStateMachine()
      seedBaseline(m, 0.8)
      feed(m, frames(2), 0.15, 0.05, DT)
      let fired = false
      for (let i = 0; i < 60; i++) {
        if (m.update(0.15 + 0.7 * (i / 59), 0.05, DT)) fired = true
      }
      expect(fired).toBe(false)
    })

    it('lowSnapMinDipSec can switch the trigger off (very large = transient always required)', () => {
      const m = new DropStateMachine({ lowSnapMinDipSec: 1e9 })
      seedBaseline(m, 0.8)
      feed(m, frames(2), 0.15, 0.05, DT)
      expect(m.update(0.85, 0.05, DT)).toBe(false)
    })
  })

  // NEW: the false-positive guard for the looser floor. At 120 BPM a kick every 0.5 s; one MISSING kick leaves the
  // sub+bass envelope decaying for a full second — deep for roughly 0.5-0.65 s, which is why the floor is 0.7 s.
  describe('four-on-the-floor kick loop', () => {
    it('the loop alone never fires', () => {
      const m = new DropStateMachine()
      expect(kickLoop(m, 120)).toBe(0) // 60 s
    })

    // (80 beats = 40 s of loop first: the baseline EMA is seeded from the first sample, a kick peak, and needs a
    // few time constants to settle onto the loop's average.)
    it('a single missing kick does not fire (the same gap DOES fire a looser 0.5 s / no-leak detector)', () => {
      const m = new DropStateMachine()
      expect(kickLoop(m, 80)).toBe(0)
      expect(kickLoop(m, 40, [100], 0.06, 0.2, 80)).toBe(0) // beat 100's kick is missing; nothing fires around it
      // ...proving the case is not vacuous: loosened detectors fire on exactly that gap.
      const loose = new DropStateMachine({ dipMinSec: 0.5 })
      kickLoop(loose, 80)
      expect(kickLoop(loose, 40, [100], 0.06, 0.2, 80)).toBeGreaterThan(0)
      const looseNoLeak = new DropStateMachine({ dipMinSec: 0.3, dipLeak: 1e9 })
      kickLoop(looseNoLeak, 80)
      expect(kickLoop(looseNoLeak, 40, [100], 0.06, 0.2, 80)).toBeGreaterThan(0)
    })

    it('two missing kicks in a row (1.5 s between kicks, a real hush) is a genuine gap and fires on the returning kick', () => {
      const m = new DropStateMachine()
      kickLoop(m, 80)
      expect(kickLoop(m, 40, [100, 101], 0.06, 0.2, 80)).toBe(1)
    })
  })

  it('releases a stale arm (no snap-back within the timeout) and is ready to arm again afterwards', () => {
    // Small overrides purely to keep the simulated timeline short or to sanity-check the boundary —
    // the FSM logic under test is identical to the defaults.
    const m = new DropStateMachine({ dipMinSec: 0.5, armTimeoutSec: 1, snapWindowSec: 0.5 })
    seedBaseline(m, 0.8)
    // Arm: 0.5s+ deep.
    expect(feed(m, 12, 0.15, 0, DT)).toBe(false) // 0.6s
    // Stay deep well past the 1s stale-arm timeout without ever snapping back.
    expect(feed(m, 24, 0.15, 0, DT)).toBe(false) // +1.2s, armed -> released (still deep throughout)
    // The FSM was released mid-batch (still deep) and re-entered "dipping" for the last few frames,
    // but has NOT yet re-accumulated a fresh dipMinSec — so an immediate snap attempt right now must
    // NOT fire. If it were still latched "armed" from before the timeout, this WOULD fire.
    // (UPDATED: 30 -> 24 frames; with the entering frame now counting as deep time the old 30 landed the
    // fresh dip exactly on the 0.5 s boundary.)
    expect(m.update(0.85, 0.9, DT)).toBe(false)
    // That snap attempt (subBass above the dip threshold) DRAINED the in-progress fresh dip (it used to reset it);
    // re-establish a full qualifying breakdown and confirm it can arm (and fire) again.
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

  it('reset() also clears the accumulated dip time carried into a low-band-only decision', () => {
    const m = new DropStateMachine()
    seedBaseline(m, 0.8)
    feed(m, frames(2), 0.15, 0.05, DT) // long dip, armed
    m.reset()
    seedBaseline(m, 0.8)
    feed(m, frames(0.8), 0.15, 0.05, DT) // short dip only
    expect(m.update(0.85, 0.05, DT)).toBe(false) // no transient and < 1.0 s: must not fire from stale deepSec
  })
})
