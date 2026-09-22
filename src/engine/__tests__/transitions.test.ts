import { describe, expect, it } from 'vitest'
import {
  CONSTRAINED_FADE_SEC,
  TRANSITION_DURATION_BIAS_MAX,
  TRANSITION_DURATION_BIAS_MIN,
  TRANSITION_STYLES,
  applyTransitionDurationBias,
  fadeDurationFor,
  pickTransitionStyle,
  mixEnergy,
  resolveTransitionStyle,
  smoothstep,
  symmetricCurve,
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
  it('no longer marks a section boundary with a dip — dipToBlack is disabled', () => {
    // Was: the one moment the two scenes are not continuous material got its
    // own dip. dipToBlack is now in DISABLED_STYLES (an unclassified section
    // boundary read as "an extremely bright flash" — the incoming scene ramps
    // from held-black to full brightness in under 40% of the transition, the
    // one style that doesn't hold the energy invariant), so an unclassified
    // boundary must degrade to exactly what a non-boundary change already does
    // for the same mood — never a special, disabled style.
    for (const mood of ['ambient', 'groove', 'peak', 'aggressive']) {
      const boundary = pickTransitionStyle(mood, true, 0, undefined)
      expect(boundary).not.toBe('dipToBlack')
      expect(boundary).toBe(pickTransitionStyle(mood, false, 0, undefined))
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

describe('pickTransitionStyle — boundary type (audit c3)', () => {
  it('is unaffected when boundaryType is omitted — every existing call site', () => {
    // The whole existing suite above calls this with 4 args; this pins that
    // adding a 5th, optional one changed nothing for them. dipToBlack is
    // disabled, so groove/rotation=0/last=undefined now falls through to the
    // mood's own first pick rather than a forced style — the point of this
    // test is that BOTH call shapes still agree, not the specific value.
    const omitted = pickTransitionStyle('groove', true, 0, undefined)
    const explicitUndefined = pickTransitionStyle('groove', true, 0, undefined, undefined)
    expect(omitted).not.toBe('dipToBlack')
    expect(omitted).toBe(explicitUndefined)
  })

  it('no longer keeps a drop on dipToBlack — DROP_STYLE obeys the disable exactly like any other pick', () => {
    // dipToBlack was "the classic case" for a drop, but it's also the one
    // style that breaks the energy invariant — see DISABLED_STYLES. With it
    // disabled, DROP_STYLE's own selectability check fails and a drop must
    // degrade to precisely what an unclassified boundary already does for the
    // same mood, not to some other special-cased style.
    for (const mood of ['ambient', 'groove', 'peak', 'aggressive']) {
      const drop = pickTransitionStyle(mood, true, 0, undefined, 'drop')
      const generic = pickTransitionStyle(mood, true, 0, undefined, 'generic')
      expect(drop).not.toBe('dipToBlack')
      expect(drop).toBe(generic)
    }
  })

  it('gives a breakdown a different style than a drop', () => {
    const drop = pickTransitionStyle('groove', true, 0, undefined, 'drop')
    const breakdown = pickTransitionStyle('groove', true, 0, undefined, 'breakdown')
    expect(breakdown).not.toBe(drop)
    expect(breakdown).toBe('smear')
  })

  it('falls a generic (or unclassified) section boundary through to the mood pick, dipToBlack disabled', () => {
    for (const mood of ['ambient', 'groove', 'peak', 'aggressive']) {
      const nonBoundary = pickTransitionStyle(mood, false, 0, undefined)
      const generic = pickTransitionStyle(mood, true, 0, undefined, 'generic')
      const unclassified = pickTransitionStyle(mood, true, 0, undefined, null)
      expect(generic).not.toBe('dipToBlack')
      expect(generic).toBe(nonBoundary)
      expect(unclassified).toBe(nonBoundary)
    }
  })

  it('boundary type has no effect when sectionChange is false', () => {
    // The type describes what KIND of section edge this is; away from an edge
    // there is nothing for it to classify, and mood must still decide alone.
    const withoutType = pickTransitionStyle('mellow', false, 3, undefined)
    const withType = pickTransitionStyle('mellow', false, 3, undefined, 'drop')
    expect(withType).toBe(withoutType)
  })

  it('DROP_STYLE really is disabled now, not just hypothetically', () => {
    // This used to be a defensive test asserting the then-current enabled
    // state, guarding against a future disable silently bypassing the check.
    // The disable is real now (an "extremely bright flash" report — see
    // DISABLED_STYLES): pin that directly, plus that BREAKDOWN_STYLE (smear)
    // is untouched by it.
    expect(isStyleSelectable('smear')).toBe(true)
    expect(isStyleSelectable('dipToBlack')).toBe(false)
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
    expect(resolveTransitionStyle('dipToBlack')).toBe('dissolve')
  })

  it('leaves every other style selectable', () => {
    // Two disabled now: `cut` (always was) and `dipToBlack` (the bright-flash
    // report — see DISABLED_STYLES).
    expect(selectableStyles()).toHaveLength(TRANSITION_STYLES.length - 2)
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

/** A spread of `k` covering the authored 1..8 range from `LookRow.transitionSharpness`. */
const K_SAMPLES = [1, 1.5, 2, 3, 4, 5, 6, 7, 8]

describe('symmetricCurve', () => {
  it('reaches exactly 0 and 1 at the endpoints for every k', () => {
    for (const k of K_SAMPLES) {
      expect(symmetricCurve(0, k)).toBe(0)
      expect(symmetricCurve(1, k)).toBe(1)
    }
  })

  it('is monotonically increasing for every k', () => {
    for (const k of K_SAMPLES) {
      let prev = -Infinity
      for (const t of SAMPLES) {
        const v = symmetricCurve(t, k)
        expect(v, `k=${k} t=${t} went backwards`).toBeGreaterThanOrEqual(prev - 1e-12)
        prev = v
      }
    }
  })

  it('satisfies the symmetric identity S_k(1-t) === 1 - S_k(t) across a spread of t and k', () => {
    // The whole reason this family is safe to swap in for smoothstep: the
    // energy invariant only needs this identity, and it holds algebraically
    // for any k > 0 — not just k=3 (smoothstep's rough equivalent).
    for (const k of K_SAMPLES) {
      for (const t of SAMPLES) {
        expect(symmetricCurve(1 - t, k), `k=${k} t=${t}`).toBeCloseTo(1 - symmetricCurve(t, k), 9)
      }
    }
  })

  it('clamps out-of-range and non-finite progress like the rest of the module', () => {
    expect(symmetricCurve(-1, 3)).toBe(symmetricCurve(0, 3))
    expect(symmetricCurve(2, 3)).toBe(symmetricCurve(1, 3))
    expect(symmetricCurve(NaN, 3)).toBe(symmetricCurve(0, 3))
  })
})

describe('transitionMix — optional sharpness', () => {
  it('is byte-identical to the 2-arg call for every style, including cut/dipToBlack', () => {
    // The regression guard the plan calls for: adding a third, optional
    // parameter must not change a single existing call site's output.
    for (const style of TRANSITION_STYLES) {
      for (const t of SAMPLES) {
        const twoArg = transitionMix(style, t)
        expect(transitionMix(style, t, undefined), `${style} at t=${t}`).toEqual(twoArg)
      }
    }
  })

  it('applies symmetricCurve instead of smoothstep for non-cut/dipToBlack styles when k is given', () => {
    for (const style of TRANSITION_STYLES) {
      if (style === 'cut' || style === 'dipToBlack') continue
      for (const k of K_SAMPLES) {
        for (const t of SAMPLES) {
          const s = symmetricCurve(t, k)
          const m = transitionMix(style, t, k)
          expect(m.in, `${style} k=${k} t=${t}`).toBeCloseTo(s, 9)
          expect(m.out, `${style} k=${k} t=${t}`).toBeCloseTo(1 - s, 9)
        }
      }
    }
  })

  it('holds the energy invariant for every k, on the styles that already hold it at k=default', () => {
    for (const style of TRANSITION_STYLES) {
      if (style === 'dipToBlack') continue // the one deliberate exception, unaffected by k
      for (const k of K_SAMPLES) {
        for (const t of SAMPLES) {
          const m = transitionMix(style, t, k)
          expect(m.out + m.in, `${style} k=${k} t=${t}`).toBeCloseTo(1, 6)
        }
      }
    }
  })

  it('leaves cut and dipToBlack untouched by k — they keep their own special-cased curves', () => {
    for (const style of ['cut', 'dipToBlack'] as TransitionStyle[]) {
      for (const t of SAMPLES) {
        const baseline = transitionMix(style, t)
        for (const k of K_SAMPLES) {
          expect(transitionMix(style, t, k), `${style} k=${k} t=${t}`).toEqual(baseline)
        }
      }
    }
  })

  it('falls back to smoothstep for a non-finite or non-positive k', () => {
    for (const style of TRANSITION_STYLES) {
      if (style === 'cut' || style === 'dipToBlack') continue
      const baseline = transitionMix(style, 0.37)
      for (const badK of [0, -1, -0.001, NaN, Infinity, -Infinity]) {
        expect(transitionMix(style, 0.37, badK), `${style} k=${badK}`).toEqual(baseline)
      }
    }
  })
})

describe('applyTransitionDurationBias', () => {
  it('leaves the duration unchanged at bias 1', () => {
    expect(applyTransitionDurationBias(0.92, 1)).toBeCloseTo(0.92, 9)
  })

  it('scales the duration within the authored bounds', () => {
    expect(applyTransitionDurationBias(1, TRANSITION_DURATION_BIAS_MIN)).toBeCloseTo(
      TRANSITION_DURATION_BIAS_MIN,
      9,
    )
    expect(applyTransitionDurationBias(1, TRANSITION_DURATION_BIAS_MAX)).toBeCloseTo(
      TRANSITION_DURATION_BIAS_MAX,
      9,
    )
    expect(applyTransitionDurationBias(1, 1.2)).toBeCloseTo(1.2, 9)
  })

  it('clamps a bias outside 0.6..1.6', () => {
    expect(applyTransitionDurationBias(1, 5)).toBeCloseTo(TRANSITION_DURATION_BIAS_MAX, 9)
    expect(applyTransitionDurationBias(1, 0)).toBeCloseTo(TRANSITION_DURATION_BIAS_MIN, 9)
    expect(applyTransitionDurationBias(1, -3)).toBeCloseTo(TRANSITION_DURATION_BIAS_MIN, 9)
  })

  it('is NaN-safe: any non-finite bias behaves like 1 (no change)', () => {
    // Not clamped — a non-finite bias is not "an extreme in-range value", it's
    // a bad read (an invalid look, a broken blend), and the safe answer is the
    // neutral multiplier, same as `fadeDurationFor`'s own fallback for a bad
    // `musical` duration.
    expect(applyTransitionDurationBias(0.8, NaN)).toBeCloseTo(0.8, 9)
    expect(applyTransitionDurationBias(0.8, Infinity)).toBeCloseTo(0.8, 9)
    expect(applyTransitionDurationBias(0.8, -Infinity)).toBeCloseTo(0.8, 9)
  })

  it('passes a non-finite or non-positive base duration through unscaled, leaving fadeDurationFor to fall back', () => {
    expect(applyTransitionDurationBias(NaN, 1.2)).toBeNaN()
    expect(applyTransitionDurationBias(0, 1.2)).toBe(0)
    expect(applyTransitionDurationBias(-1, 1.2)).toBe(-1)
  })

  it('composes with fadeDurationFor: a lengthened fade can still be shortened under budget, never re-lengthened', () => {
    const musicalLong = 0.92
    const lengthened = applyTransitionDurationBias(musicalLong, TRANSITION_DURATION_BIAS_MAX) // serene-like

    // Unconstrained: the bias passes straight through.
    expect(fadeDurationFor(lengthened, false)).toBeCloseTo(musicalLong * TRANSITION_DURATION_BIAS_MAX, 9)

    // Constrained: the lengthened one gets cut down to the same ceiling as an
    // unbiased fade would be — never lengthened back up past it.
    expect(fadeDurationFor(lengthened, true)).toBe(CONSTRAINED_FADE_SEC)
    expect(fadeDurationFor(lengthened, true)).toBeLessThan(lengthened)

    // A short musical duration whose biased-down fade already sits BELOW the
    // constrained ceiling — the case that actually exercises "never
    // lengthened back up": an unbiased 0.3 s fade would be cut to the 0.2 s
    // ceiling under constraint, but the aggressive-mood-shortened 0.18 s fade
    // must stay at 0.18 s, not get pulled back UP to 0.2 s.
    const musicalShort = 0.3
    const shortened = applyTransitionDurationBias(musicalShort, TRANSITION_DURATION_BIAS_MIN) // aggressive-like
    expect(shortened).toBeLessThan(CONSTRAINED_FADE_SEC)
    expect(fadeDurationFor(musicalShort, true)).toBe(CONSTRAINED_FADE_SEC) // the unbiased fade DOES get cut to the ceiling
    expect(fadeDurationFor(shortened, true)).toBe(shortened) // the biased one is already under it and is left alone
    expect(fadeDurationFor(shortened, true)).toBeLessThan(CONSTRAINED_FADE_SEC)
  })
})
