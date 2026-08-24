import { describe, expect, it } from 'vitest'
import { resolveFeedbackKnobs } from '../feedbackParams'

/**
 * The pure half of the feedback pass: mapping the one external `trails` dial
 * onto the five shader knobs. See feedbackParams.ts for why it is one dial and
 * not five — these pin the mapping's shape, not the shader (which needs a
 * WebGL context this test suite does not have; see FeedbackPass.ts).
 */
describe('resolveFeedbackKnobs', () => {
  it('is fully off at 0 — no persistence, no drift', () => {
    const k = resolveFeedbackKnobs(0)
    expect(k.persist).toBe(0)
    expect(k.zoomRatePerSec).toBe(0)
    expect(k.rotateRatePerSec).toBe(0)
    expect(k.swirl).toBe(0)
    expect(k.wobble).toBe(0)
  })

  it('every knob rises monotonically with trails', () => {
    const lo = resolveFeedbackKnobs(0.3)
    const hi = resolveFeedbackKnobs(0.8)
    expect(hi.persist).toBeGreaterThan(lo.persist)
    expect(hi.zoomRatePerSec).toBeGreaterThan(lo.zoomRatePerSec)
    expect(hi.rotateRatePerSec).toBeGreaterThan(lo.rotateRatePerSec)
    expect(hi.swirl).toBeGreaterThan(lo.swirl)
    expect(hi.wobble).toBeGreaterThan(lo.wobble)
  })

  it('never lets persist reach 1, even at trails = 1', () => {
    // A persist of exactly 1 never decays — a single bright frame accumulates
    // forever and the picture washes to white. This is the one number in the
    // whole mapping that must have a hard ceiling below 1, not just "close to
    // the max input".
    const k = resolveFeedbackKnobs(1)
    expect(k.persist).toBeLessThan(1)
    expect(k.persist).toBeGreaterThan(0.9) // still reads as a long trail
  })

  it('clamps out-of-range input instead of extrapolating', () => {
    expect(resolveFeedbackKnobs(1.5)).toEqual(resolveFeedbackKnobs(1))
    expect(resolveFeedbackKnobs(-0.5)).toEqual(resolveFeedbackKnobs(0))
  })

  it('degrades to fully off on non-finite input', () => {
    // A NaN trails value must never reach the shader as a NaN uniform — that
    // would poison every downstream blend for the rest of the session.
    expect(resolveFeedbackKnobs(NaN)).toEqual(resolveFeedbackKnobs(0))
    expect(resolveFeedbackKnobs(Infinity)).toEqual(resolveFeedbackKnobs(1))
    expect(resolveFeedbackKnobs(-Infinity)).toEqual(resolveFeedbackKnobs(0))
  })

  it('is continuous — no jump between the off floor and just above it', () => {
    // The off-floor short-circuit (trails <= OFF_THRESHOLD) must not read as a
    // pop when a director eases `trails` up from zero.
    const justBelow = resolveFeedbackKnobs(0.019)
    const justAbove = resolveFeedbackKnobs(0.021)
    expect(justAbove.persist - justBelow.persist).toBeLessThan(0.05)
    expect(justAbove.zoomRatePerSec - justBelow.zoomRatePerSec).toBeLessThan(0.01)
  })

  it('is a pure function of its input', () => {
    const a = resolveFeedbackKnobs(0.42)
    const b = resolveFeedbackKnobs(0.42)
    expect(a).toEqual(b)
  })
})
