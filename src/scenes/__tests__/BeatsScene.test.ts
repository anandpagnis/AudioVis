import { describe, expect, it } from 'vitest'
import { beatsPosition, beatsSpinRate } from '../BeatsScene'

/**
 * Covers the two pure helpers extracted from `BeatsScene.tsx`'s `update()`
 * for the beat-lock audit fix (Finding 1: `uBeats` reads the engine's real
 * beat grid instead of a free-running `dt*(bpm/60)` integral; Finding 2:
 * `mids` widens a JS-accumulated spin RATE instead of multiplying against a
 * raw, ever-growing beat count in the shader). Neither is reachable through a
 * GL context in this test suite (no test here invokes the GLSL compiler), so
 * this exercises the JS-side math the shader consumes as `uBeats`/`uSpin`.
 */

describe('beatsPosition', () => {
  it('is locked exactly to the beat grid at mult 1 — the phase-lock invariant', () => {
    // mult === 1 is what a neutral scene (energy 0, drastic(speed) at its
    // neutral 1) resolves to. At that point uBeats must equal the engine's
    // own beat position exactly, or the scene is not "locked to the beat".
    expect(beatsPosition(0, 0, 1)).toBe(0)
    expect(beatsPosition(12, 0.37, 1)).toBeCloseTo(12.37, 10)
    expect(beatsPosition(9999, 0.999, 1)).toBeCloseTo(9999.999, 6)
  })

  it('is a pure function of the current grid position — no history, no drift', () => {
    // The old free-running integral accumulated JS-side state frame over
    // frame, so a stale `bpm` reading left a permanent, growing offset from
    // the real grid. The replacement must have no memory: the same
    // (beatIndex, beatProgress, mult) always produces the same result,
    // regardless of what was computed on any previous frame — which is
    // exactly what makes it self-correct instantly on a tempo re-lock rather
    // than accumulate error.
    const a = beatsPosition(40, 0.2, 1)
    const b = beatsPosition(40, 0.2, 1)
    expect(a).toBe(b)
    // A simulated tempo re-lock — the grid jumps to a different position —
    // is reflected immediately, with no trace of the prior call.
    expect(beatsPosition(41, 0.0, 1)).toBeCloseTo(41, 10)
  })

  it('mult scales the beat position, on top of the grid rather than replacing it', () => {
    expect(beatsPosition(10, 0.5, 2)).toBeCloseTo(21, 10)
    expect(beatsPosition(10, 0.5, 0.5)).toBeCloseTo(5.25, 10)
  })
})

describe('beatsSpinRate', () => {
  it('falls back to 120 BPM before a tempo locks, same as uBeats used to', () => {
    expect(beatsSpinRate(0, 0)).toBeCloseTo(beatsSpinRate(120, 0), 10)
    expect(beatsSpinRate(-5, 0)).toBeCloseTo(beatsSpinRate(120, 0), 10)
  })

  it('reproduces the source-authored 0.1..0.18 coefficient range at mids 0..1', () => {
    // Source: `t * (0.1 + uMids * 0.08)`. At 120 BPM (bpm/60 == 2) the old
    // per-second rate at mids 0 was 2 * 0.1 = 0.2 rad/s, and at mids 1 was
    // 2 * 0.18 = 0.36 rad/s.
    expect(beatsSpinRate(120, 0)).toBeCloseTo(0.2, 10)
    expect(beatsSpinRate(120, 1)).toBeCloseTo(0.36, 10)
  })

  it('mids widens the RATE monotonically, not a value multiplied against a growing counter', () => {
    const rates = [0, 0.25, 0.5, 0.75, 1].map((mids) => beatsSpinRate(120, mids))
    for (let i = 1; i < rates.length; i++) {
      expect(rates[i]).toBeGreaterThan(rates[i - 1])
    }
  })

  it('scales linearly with bpm, so the spin stays beat-relative at any tempo', () => {
    expect(beatsSpinRate(240, 0.5)).toBeCloseTo(beatsSpinRate(120, 0.5) * 2, 10)
  })
})
