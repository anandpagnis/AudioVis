import { describe, expect, it } from 'vitest'
import {
  TRANSITION_STYLES,
  mixEnergy,
  resolveTransitionStyle,
  smoothstep,
  transitionMix,
  transitionRack,
  usesRack,
  type TransitionStyle,
} from '../transitions'

/** Sample points across a transition, endpoints included. */
const SAMPLES = Array.from({ length: 41 }, (_, i) => i / 40)

describe('the energy invariant', () => {
  it('holds the frame at constant light through every blending style', () => {
    // 17 of 18 scenes are additive, so mid-fade the viewer sees the SUM of the
    // two scenes. A curve pair that does not sum to 1 brightens or dims the
    // frame through the transition, which reads as a flash rather than a fade —
    // and it is the exact mistake an "equal-power" curve borrowed from audio
    // would introduce here.
    for (const style of TRANSITION_STYLES) {
      if (style === 'dipToBlack') continue // dimming IS the effect; see below
      for (const t of SAMPLES) {
        expect(mixEnergy(style, t), `${style} at t=${t}`).toBeCloseTo(1, 6)
      }
    }
  })

  it('lets dipToBlack actually reach black', () => {
    // The one deliberate exception. If this ever summed to 1 it would have
    // silently become a plain dissolve.
    expect(mixEnergy('dipToBlack', 0.5)).toBe(0)
    expect(mixEnergy('dipToBlack', 0)).toBeCloseTo(1, 6)
    expect(mixEnergy('dipToBlack', 1)).toBeCloseTo(1, 6)
  })
})

describe('transitionMix', () => {
  it('starts on the outgoing scene and ends on the incoming one', () => {
    for (const style of TRANSITION_STYLES) {
      if (style === 'cut') continue
      expect(transitionMix(style, 0), `${style} start`).toEqual({ out: 1, in: 0 })
      expect(transitionMix(style, 1), `${style} end`).toEqual({ out: 0, in: 1 })
    }
  })

  it('makes cut instantaneous by construction', () => {
    // Not "a very fast dissolve" — there is no t at which both are visible, so
    // a cut can never ghost.
    for (const t of SAMPLES) {
      expect(transitionMix('cut', t)).toEqual({ out: 0, in: 1 })
    }
  })

  it('moves monotonically — a transition never backs up', () => {
    // A non-monotonic curve reads as the picture changing its mind, which is
    // exactly the "sudden and jerky" complaint this work is answering.
    for (const style of TRANSITION_STYLES) {
      let prevIn = -Infinity
      let prevOut = Infinity
      for (const t of SAMPLES) {
        const m = transitionMix(style, t)
        expect(m.in, `${style} in went backwards at ${t}`).toBeGreaterThanOrEqual(prevIn - 1e-9)
        expect(m.out, `${style} out went backwards at ${t}`).toBeLessThanOrEqual(prevOut + 1e-9)
        prevIn = m.in
        prevOut = m.out
      }
    }
  })

  it('eases in and out rather than ramping linearly', () => {
    // The actual fix for "jerky". A linear ramp moves the same amount in the
    // first 10% as in the middle 10%; an eased one moves far less at the edges.
    const nearStart = transitionMix('dissolve', 0.1).in
    const nearMiddle = transitionMix('dissolve', 0.55).in - transitionMix('dissolve', 0.45).in
    expect(nearStart).toBeLessThan(0.1) // linear would be exactly 0.1
    expect(nearMiddle).toBeGreaterThan(0.1) // ...and the middle moves faster
  })

  it('clamps out-of-range and non-finite progress', () => {
    for (const style of TRANSITION_STYLES) {
      expect(transitionMix(style, -1)).toEqual(transitionMix(style, 0))
      expect(transitionMix(style, 2)).toEqual(transitionMix(style, 1))
      expect(transitionMix(style, NaN)).toEqual(transitionMix(style, 0))
    }
  })
})

describe('transitionRack', () => {
  it('is fully off at both ends of every style', () => {
    // The safety property. A transition can be interrupted — a new scene
    // requested mid-fade, a context loss — and a rack left switched on would
    // silently become part of the show with nothing tracking it.
    for (const style of TRANSITION_STYLES) {
      for (const t of [0, 1]) {
        const r = transitionRack(style, t)
        expect(r.trails, `${style} trails at ${t}`).toBe(0)
        expect(r.lensAmount, `${style} lens at ${t}`).toBe(0)
        expect(r.mirrorTwist, `${style} twist at ${t}`).toBe(0)
      }
    }
  })

  it('peaks in the middle for the rack styles', () => {
    expect(transitionRack('smear', 0.5).trails).toBeGreaterThan(0.5)
    expect(transitionRack('melt', 0.5).lensAmount).toBeGreaterThan(0.5)
    expect(transitionRack('collapse', 0.5).mirrorTwist).toBeGreaterThan(1)
  })

  it('leaves the racks alone for the mix-only styles', () => {
    for (const style of ['cut', 'dissolve', 'dipToBlack'] as TransitionStyle[]) {
      expect(usesRack(style)).toBe(false)
      for (const t of SAMPLES) {
        expect(transitionRack(style, t)).toEqual(transitionRack(style, 0))
      }
    }
  })

  it('drives mirror tiles past the shader gate or not at all', () => {
    // MirrorPass ignores tiles below 1.5, so a ramp that spent the transition
    // sitting at 0.9 would be pure cost for no picture.
    for (const t of SAMPLES) {
      const tiles = transitionRack('collapse', t).mirrorTiles
      expect(tiles === 0 || tiles >= 1.5, `tiles=${tiles} at t=${t}`).toBe(true)
    }
  })

  it('names a real lens material for melt', () => {
    // Index 3 is `melt` in opticalRack's LENS_STYLES. If that list is ever
    // reordered this silently selects a different material.
    expect(transitionRack('melt', 0.5).lensStyle).toBe(3)
  })
})

describe('resolveTransitionStyle', () => {
  it('accepts every declared style', () => {
    for (const style of TRANSITION_STYLES) {
      expect(resolveTransitionStyle(style)).toBe(style)
    }
  })

  it('degrades unknown input to dissolve, not to cut', () => {
    // A cue written against a future style should land on the gentlest
    // transition, not the harshest — an unrecognised name becoming a hard cut
    // would turn a forward-compatibility gap into a visible jolt.
    expect(resolveTransitionStyle('kaleido-wipe-9000')).toBe('dissolve')
    expect(resolveTransitionStyle(undefined)).toBe('dissolve')
    expect(resolveTransitionStyle(42)).toBe('dissolve')
  })
})

describe('smoothstep', () => {
  it('is symmetric, which is what preserves additive energy', () => {
    // S(1-t) === 1 - S(t). The mix curves depend on this identity; without it
    // the energy invariant above cannot hold.
    for (const t of SAMPLES) {
      expect(smoothstep(1 - t)).toBeCloseTo(1 - smoothstep(t), 9)
    }
  })

  it('has zero slope at both ends', () => {
    expect(smoothstep(0.001)).toBeLessThan(0.001)
    expect(1 - smoothstep(0.999)).toBeLessThan(0.001)
  })
})
