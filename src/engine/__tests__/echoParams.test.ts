import { describe, expect, it } from 'vitest'
import { ECHO_TAP_COUNT, isEchoActive, resolveEchoKnobs, resolveEchoTapSpacingSec } from '../echoParams'

/**
 * The pure half of the echo pass. `resolveEchoKnobs` now resolves to a fixed
 * `decay` only (F232 moved spacing out to `resolveEchoTapSpacingSec`, since
 * spacing is beat-locked rather than driven by the echo dial itself — see
 * echoParams.ts's header for the full diagnosis of why v1's shape was wrong).
 * These pin the mapping's shape, not the shader (which needs a WebGL context
 * this test suite does not have; see EchoPass.ts).
 */
describe('isEchoActive', () => {
  it('is off at 0 and at the off threshold', () => {
    expect(isEchoActive(0)).toBe(false)
    expect(isEchoActive(0.02)).toBe(false)
  })

  it('is on just above the off threshold', () => {
    expect(isEchoActive(0.021)).toBe(true)
    expect(isEchoActive(1)).toBe(true)
  })

  it('degrades to off on NaN', () => {
    // A NaN echo value must never reach the pass as "active" — that would
    // leave `enabled` true while every knob resolved from it is meaningless.
    expect(isEchoActive(NaN)).toBe(false)
  })

  it('degrades to off on any non-finite input, not just NaN', () => {
    // Every non-finite value (NaN, +/-Infinity) falls back to 0 — a genuinely
    // huge but non-finite reading is exactly as untrustworthy as NaN, so both
    // directions of infinity are treated the same rather than only guarding
    // the one that happens to be negative.
    expect(isEchoActive(Infinity)).toBe(false)
    expect(isEchoActive(-Infinity)).toBe(false)
  })
})

describe('ECHO_TAP_COUNT', () => {
  it('is at least 5 (F234: "more ghost images")', () => {
    expect(ECHO_TAP_COUNT).toBeGreaterThanOrEqual(5)
  })
})

describe('resolveEchoKnobs', () => {
  it('takes no argument and always returns the same fixed decay', () => {
    // Every field here is currently a constant — see the function's own doc
    // on why it stays a function anyway. Calling it repeatedly must be inert.
    const a = resolveEchoKnobs()
    const b = resolveEchoKnobs()
    expect(a).toEqual(b)
  })

  it('decay lands where each tap is noticeably dimmer than the last, but the oldest of five is still visible', () => {
    // F234: raised from 0.6 to 0.72 alongside ECHO_TAP_COUNT's bump to 5 —
    // at the old value the 5th tap would have survived at only ~0.078 of the
    // newest, invisible. See DECAY's own doc in echoParams.ts.
    const { decay } = resolveEchoKnobs()
    expect(decay).toBeGreaterThanOrEqual(0.65)
    expect(decay).toBeLessThanOrEqual(0.8)
    expect(decay ** 5).toBeGreaterThan(0.1)
  })
})

describe('resolveEchoTapSpacingSec', () => {
  it('halves as bpm doubles, at the default eighth-note subdivision', () => {
    // 60 / bpm / subdivision: spacing is inversely proportional to tempo.
    const slow = resolveEchoTapSpacingSec(60)
    const fast = resolveEchoTapSpacingSec(120)
    expect(fast).toBeCloseTo(slow / 2, 5)
  })

  it('a coarser subdivision (fewer taps per beat) widens the spacing', () => {
    const eighth = resolveEchoTapSpacingSec(120, 2)
    const quarter = resolveEchoTapSpacingSec(120, 1)
    expect(quarter).toBeGreaterThan(eighth)
  })

  it('falls back to 120 bpm for a zero, negative, or non-finite tempo', () => {
    // Same fallback value and reasoning DjCamDirector.ts's `bpmEff` guard
    // already uses — an unstarted or stalled tempo estimate must not divide
    // by zero or produce a negative/nonsensical spacing.
    const fallback = resolveEchoTapSpacingSec(120)
    expect(resolveEchoTapSpacingSec(0)).toBeCloseTo(fallback, 5)
    expect(resolveEchoTapSpacingSec(-10)).toBeCloseTo(fallback, 5)
    expect(resolveEchoTapSpacingSec(NaN)).toBeCloseTo(fallback, 5)
    expect(resolveEchoTapSpacingSec(Infinity)).toBeCloseTo(fallback, 5)
  })

  it('falls back to the default subdivision for a zero, negative, or non-finite one', () => {
    const fallback = resolveEchoTapSpacingSec(120)
    expect(resolveEchoTapSpacingSec(120, 0)).toBeCloseTo(fallback, 5)
    expect(resolveEchoTapSpacingSec(120, -2)).toBeCloseTo(fallback, 5)
    expect(resolveEchoTapSpacingSec(120, NaN)).toBeCloseTo(fallback, 5)
  })

  it('clamps to a sane range regardless of how extreme the tempo is', () => {
    expect(resolveEchoTapSpacingSec(1000)).toBeGreaterThanOrEqual(0.05)
    expect(resolveEchoTapSpacingSec(1)).toBeLessThanOrEqual(0.5)
  })

  it('is a pure function of its inputs', () => {
    expect(resolveEchoTapSpacingSec(128, 2)).toBe(resolveEchoTapSpacingSec(128, 2))
  })
})
