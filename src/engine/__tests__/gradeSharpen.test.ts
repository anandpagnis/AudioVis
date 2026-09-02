import { describe, expect, it } from 'vitest'
import { CAS_SHARPEN_CEILING, sharpenForScale, sharpenWithSparkle } from '../GradePass'

describe('sharpenForScale', () => {
  it('sharpens nothing at native resolution', () => {
    // A native frame has lost no detail, so there is none to reconstruct —
    // sharpening it would only manufacture edges. The shader branches on this
    // being zero to skip the taps entirely, so it is a cost guarantee too.
    expect(sharpenForScale(1)).toBe(0)
    expect(sharpenForScale(1.5)).toBe(0)
  })

  it('ramps up as the frame gets further from native', () => {
    // The governor's own rungs, in order. Each softer frame must get strictly
    // more reconstruction than the one above it.
    const ramp = [0.9, 0.7, 0.55, 0.48, 0.4].map(sharpenForScale)
    for (let i = 1; i < ramp.length; i++) expect(ramp[i]).toBeGreaterThan(ramp[i - 1])
  })

  it('is capped below the point where CAS invents edges', () => {
    // RENDER_SCALE_FLOOR is 0.4, so this is the most sharpening the show can
    // ever apply. Past ~0.85 the filter starts drawing edges that were not in
    // the source, which on a wireframe scene is worse than the blur it fixes.
    expect(sharpenForScale(0.4)).toBeLessThanOrEqual(0.85)
    expect(sharpenForScale(0.1)).toBe(0.85)
  })

  it('never returns a negative or non-finite amount', () => {
    for (const s of [0, -1, NaN, Infinity]) {
      const v = sharpenForScale(s)
      expect(Number.isFinite(v)).toBe(true)
      expect(v).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('sharpenWithSparkle — Bundle C1 shimmer term', () => {
  it('adds nothing at zero sparkle, on any base', () => {
    expect(sharpenWithSparkle(0, 0)).toBe(0)
    expect(sharpenWithSparkle(0.5, 0)).toBe(0.5)
  })

  it('rises monotonically with the eased sparkle read', () => {
    const at = [0, 0.25, 0.5, 0.75, 1].map((s) => sharpenWithSparkle(0, s))
    for (let i = 1; i < at.length; i++) expect(at[i]).toBeGreaterThan(at[i - 1])
  })

  it('caps its own contribution well under the ceiling on a native (zero-base) frame', () => {
    // A native frame has a render-scale base of 0 — sparkle alone must stay a
    // gentle cue, not sharpen a frame that had nothing to reconstruct up to
    // the same intensity a heavily-downscaled frame would need.
    expect(sharpenWithSparkle(0, 1)).toBeLessThan(0.2)
  })

  it('never exceeds CAS_SHARPEN_CEILING even at both inputs maxed', () => {
    expect(sharpenWithSparkle(CAS_SHARPEN_CEILING, 1)).toBeLessThanOrEqual(CAS_SHARPEN_CEILING)
    expect(sharpenWithSparkle(10, 10)).toBeLessThanOrEqual(CAS_SHARPEN_CEILING)
  })

  it('clamps an out-of-range or non-finite sparkle read rather than propagating it', () => {
    for (const bad of [-5, 2, NaN, Infinity, -Infinity]) {
      const v = sharpenWithSparkle(0.2, bad)
      expect(Number.isFinite(v)).toBe(true)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(CAS_SHARPEN_CEILING)
    }
  })

  it('never returns a negative amount even on a negative base', () => {
    expect(sharpenWithSparkle(-1, 0)).toBe(0)
  })
})
