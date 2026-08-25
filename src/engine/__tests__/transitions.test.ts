import { describe, expect, it } from 'vitest'
import {
  CONSTRAINED_FADE_SEC,
  TRANSITION_STYLES,
  fadeDurationFor,
  pickTransitionStyle,
  mixEnergy,
  resolveTransitionStyle,
  smoothstep,
  transitionMix,
  isStyleSelectable,
  selectableStyles,
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

describe('pickTransitionStyle — the director', () => {
  it('marks a section boundary with a dip rather than a blend', () => {
    // The one moment the two scenes are not continuous material: the music has
    // drawn a line, and a dip states that where a blend smooths over it.
    for (const mood of ['ambient', 'groove', 'peak', 'aggressive']) {
      expect(pickTransitionStyle(mood, true, 0, undefined)).toBe('dipToBlack')
    }
  })

  it('gives quiet and loud moods different characters', () => {
    // The point of having a vocabulary at all: a breakdown and a peak should not
    // change scene the same way.
    const quiet = pickTransitionStyle('mellow', false, 0, undefined)
    const loud = pickTransitionStyle('aggressive', false, 0, undefined)
    expect(quiet).not.toBe(loud)
  })

  it('never repeats the previous style when an alternative exists', () => {
    // Otherwise a mood with two styles still shows one of them, and the rack is
    // decoration rather than variety.
    for (const mood of ['ambient', 'mellow', 'groove', 'building', 'peak', 'aggressive']) {
      for (let r = 0; r < 8; r++) {
        const last = pickTransitionStyle(mood, false, r, undefined)
        expect(pickTransitionStyle(mood, false, r, last)).not.toBe(last)
      }
    }
  })

  it('leaves silence on the neutral style', () => {
    for (let r = 0; r < 6; r++) {
      expect(pickTransitionStyle('silence', false, r, undefined)).toBe('dissolve')
    }
  })

  it('never chooses a disabled style', () => {
    // Disabling has to reach the autonomy, not just the picker — otherwise the
    // director keeps selecting something the UI says is unavailable.
    for (const mood of ['silence', 'ambient', 'mellow', 'groove', 'building', 'peak', 'aggressive']) {
      for (let r = 0; r < 10; r++) {
        for (const sc of [true, false]) {
          expect(isStyleSelectable(pickTransitionStyle(mood, sc, r, undefined))).toBe(true)
        }
      }
    }
  })

  it('is deterministic, so a recorded set replays identically', () => {
    expect(pickTransitionStyle('groove', false, 3, 'dissolve')).toBe(
      pickTransitionStyle('groove', false, 3, 'dissolve'),
    )
  })

  it('falls back for an unknown mood rather than returning undefined', () => {
    // A new MoodState added later must not make the director return nothing.
    const st = pickTransitionStyle('brand-new-mood', false, 0, undefined)
    expect(TRANSITION_STYLES).toContain(st)
    expect(isStyleSelectable(st)).toBe(true)
  })

  it('reaches every style in a mood list as the rotation advances', () => {
    const seen = new Set<string>()
    for (let r = 0; r < 12; r++) seen.add(pickTransitionStyle('groove', false, r, undefined))
    expect(seen.size).toBeGreaterThan(1)
  })
})

describe('fadeDurationFor — the budget degrade', () => {
  it('leaves an affordable transition at its musical length', () => {
    expect(fadeDurationFor(0.92, false)).toBe(0.92)
  })

  it('shortens rather than removes an unaffordable one', () => {
    // The whole point of F64. This path used to produce a hard cut, which meant
    // a performance constraint decided the edit — and on a loaded machine that
    // was EVERY transition, so no crossfade ever ran.
    const constrained = fadeDurationFor(0.92, true)
    expect(constrained).toBeGreaterThan(0)
    expect(constrained).toBeLessThan(0.92)
    expect(constrained).toBe(CONSTRAINED_FADE_SEC)
  })

  it('never lengthens a fade that was already shorter', () => {
    // The constraint is a ceiling on how long two primaries may overlap, not a
    // target — raising a 0.1 s fade to 0.2 s would spend MORE of the budget it
    // exists to protect.
    expect(fadeDurationFor(0.1, true)).toBe(0.1)
  })

  it('returns something usable for a nonsense musical duration', () => {
    // The per-frame advance divides by this, so a zero or NaN here would make
    // the fade jump straight to complete or poison it permanently.
    expect(fadeDurationFor(0, false)).toBeGreaterThan(0)
    expect(fadeDurationFor(NaN, false)).toBeGreaterThan(0)
    expect(fadeDurationFor(-1, true)).toBeGreaterThan(0)
  })

  it('keeps the constrained window short enough to be worth the trade', () => {
    // At 60fps this is the number of frames carrying two subjects. The guard's
    // intent is to bound that, and the trade is only defensible while it stays
    // a fraction of a musical fade.
    expect(CONSTRAINED_FADE_SEC * 60).toBeLessThan(15)
  })
})

describe('disabled styles', () => {
  it('keeps cut in the vocabulary but out of the picker', () => {
    // Not deleted: the value is stored in cues and recorded in transition
    // telemetry, so removing the name would orphan saved shows and make old
    // records unreadable.
    expect(TRANSITION_STYLES).toContain('cut')
    expect(selectableStyles()).not.toContain('cut')
    expect(isStyleSelectable('cut')).toBe(false)
  })

  it('still produces a working curve for cut', () => {
    // Disabled as a CHOICE, not as a fallback: SceneManager still forces a cut
    // when the budget cannot fund two primaries, and that path must keep
    // working. A disabled style that stopped rendering would black the frame.
    expect(transitionMix('cut', 0.5)).toEqual({ out: 0, in: 1 })
  })

  it('resolves a stored disabled style to the default', () => {
    // What makes the disable real for a cue saved while it was still available,
    // rather than only hiding it from the picker.
    expect(resolveTransitionStyle('cut')).toBe('dissolve')
  })

  it('leaves every other style selectable', () => {
    expect(selectableStyles()).toHaveLength(TRANSITION_STYLES.length - 1)
  })
})

describe('resolveTransitionStyle', () => {
  it('accepts every selectable style', () => {
    for (const style of selectableStyles()) {
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
