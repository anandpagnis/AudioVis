import { describe, expect, it } from 'vitest'
import { sharpenForScale } from '../GradePass'

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
