import { describe, expect, it } from 'vitest'
import { createLookProfile, LOOK_TRANSITIONS, type LookProfile } from '../look/lookRow'
import {
  TRANSITION_STYLES,
  isStyleSelectable,
  mixEnergy,
  pickIndexByWeight,
  pickTransitionStyle,
  rotationUnit,
  type TransitionStyle,
} from '../transitions'

/**
 * The mood look profile reaching the transition director: `pickTransitionStyle(..., look)` samples the SELECTABLE
 * styles by the blended `transitionWeights`, deterministically from the rotation counter, with the section-boundary
 * overrides above it untouched. The legacy behaviour (look omitted) is pinned by transitions.test.ts.
 */

type Weights = Partial<Record<(typeof LOOK_TRANSITIONS)[number], number>>

/** A profile whose transition weights are exactly `w`. NOT marked valid: the pick functions gate on the argument. */
function lookWith(w: Weights): LookProfile {
  const look = createLookProfile()
  look.transitionWeights = LOOK_TRANSITIONS.map((s) => w[s] ?? 0)
  return look
}

const MOODS = ['silence', 'ambient', 'mellow', 'groove', 'building', 'peak', 'aggressive']

/** `n` consecutive picks the way the bridge makes them: an incrementing counter and the previous result as `last`. */
function chain(look: LookProfile, n: number, feedLast = true): TransitionStyle[] {
  const out: TransitionStyle[] = []
  let last: TransitionStyle | undefined
  for (let r = 0; r < n; r++) {
    const s = pickTransitionStyle('groove', false, r, feedLast ? last : undefined, null, look)
    out.push(s)
    last = s
  }
  return out
}

const share = (xs: TransitionStyle[], s: TransitionStyle) => xs.filter((x) => x === s).length / xs.length

describe('rotationUnit / pickIndexByWeight — the deterministic weighted sampler', () => {
  it('maps a counter into [0, 1), 0 to 0, and folds nonsense onto a non-negative integer', () => {
    expect(rotationUnit(0)).toBe(0)
    for (const k of [1, 2, 3, 17, 1e6, -5, 2.9, NaN, Infinity, -Infinity]) {
      const u = rotationUnit(k)
      expect(u).toBeGreaterThanOrEqual(0)
      expect(u).toBeLessThan(1)
    }
    expect(rotationUnit(-5)).toBe(rotationUnit(5))
    expect(rotationUnit(NaN)).toBe(0)
  })

  it('selects options in proportion to their weights over successive counters', () => {
    const w = [0.5, 0.3, 0, 0.2]
    const counts = [0, 0, 0, 0]
    const n = 5000
    for (let k = 0; k < n; k++) counts[pickIndexByWeight(w, k)]++
    expect(counts[2]).toBe(0)
    w.forEach((wi, i) => expect(counts[i] / n).toBeCloseTo(wi, 2))
  })

  it('does not need the weights to sum to 1', () => {
    const a = Array.from({ length: 200 }, (_, k) => pickIndexByWeight([1, 3], k))
    const b = Array.from({ length: 200 }, (_, k) => pickIndexByWeight([0.25, 0.75], k))
    expect(a).toEqual(b)
  })

  it('counter 0 is the first positive option', () => {
    expect(pickIndexByWeight([0, 0.2, 0.8], 0)).toBe(1)
  })

  it('never selects a zero, negative or non-finite weight, and reports -1 when nothing is selectable', () => {
    for (let k = 0; k < 200; k++) {
      expect([1, 3]).toContain(pickIndexByWeight([-1, 0.5, NaN, 0.5], k))
    }
    expect(pickIndexByWeight([], 0)).toBe(-1)
    expect(pickIndexByWeight([0, 0, 0], 3)).toBe(-1)
    expect(pickIndexByWeight([NaN, -2, Infinity], 3)).toBe(-1)
  })
})

describe('pickTransitionStyle with a look profile', () => {
  it('is exactly the legacy pick when look is omitted or undefined', () => {
    for (const mood of [...MOODS, 'brand-new-mood']) {
      for (const sc of [true, false]) {
        for (const boundary of [undefined, null, 'drop', 'breakdown', 'generic'] as const) {
          for (let r = 0; r < 8; r++) {
            for (const last of [undefined, 'dissolve', 'smear'] as const) {
              const bare = pickTransitionStyle(mood, sc, r, last, boundary)
              expect(pickTransitionStyle(mood, sc, r, last, boundary, undefined), `${mood}/${sc}/${boundary}/${r}`).toBe(bare)
            }
          }
        }
      }
    }
  })

  it('samples the styles in proportion to the blended weights', () => {
    const look = lookWith({ dissolve: 0.6, smear: 0.3, melt: 0.1 })
    const xs = chain(look, 2000, false)
    expect(share(xs, 'dissolve')).toBeCloseTo(0.6, 1)
    expect(share(xs, 'smear')).toBeCloseTo(0.3, 1)
    expect(share(xs, 'melt')).toBeCloseTo(0.1, 1)
    expect(share(xs, 'dissolve')).toBeGreaterThan(share(xs, 'smear'))
    expect(share(xs, 'smear')).toBeGreaterThan(share(xs, 'melt'))
    expect(share(xs, 'collapse')).toBe(0)
  })

  it('leaves a style out entirely when its weight is zero', () => {
    for (const w of [{ collapse: 1 }, { dissolve: 1, melt: 1 }, { smear: 0.01, collapse: 5 }] as Weights[]) {
      const allowed = LOOK_TRANSITIONS.filter((s) => (w[s] ?? 0) > 0)
      for (const s of chain(lookWith(w), 300)) expect(allowed).toContain(s)
    }
  })

  it('rotation 0 is the mood’s top style, and different moods get different characters', () => {
    const calm = lookWith({ dissolve: 0.85, smear: 0.15 })
    const hard = lookWith({ collapse: 0.65, melt: 0.35 })
    expect(pickTransitionStyle('groove', false, 0, undefined, null, calm)).toBe('dissolve')
    expect(pickTransitionStyle('groove', false, 0, undefined, null, hard)).toBe('collapse')
    expect(share(chain(calm, 500), 'dissolve')).toBeGreaterThan(0.6)
    expect(share(chain(hard, 500), 'collapse')).toBeGreaterThan(0.5)
  })

  it('dampens an immediate repeat instead of forbidding it, so a dominant style stays dominant', () => {
    // With a hard no-repeat rule two dominant styles would collapse to strict alternation (50 / 50) and the weights
    // would be decoration. Damped, the long-run mix still follows the row: 85 / 15 settles near 78 / 22.
    const look = lookWith({ dissolve: 0.85, smear: 0.15 })
    const xs = chain(look, 2000)
    expect(share(xs, 'dissolve')).toBeGreaterThan(0.68)
    expect(share(xs, 'dissolve')).toBeLessThan(0.88)
    // ...but a repeat is less likely than the weights alone say (undamped, ~75% of consecutive pairs repeat).
    const repeats = xs.filter((s, i) => i > 0 && s === xs[i - 1]).length / (xs.length - 1)
    expect(repeats).toBeLessThan(0.65)
    // ...and it does still repeat: this is a weight, not the legacy hard rule.
    expect(repeats).toBeGreaterThan(0.3)
  })

  it('still gives the last style a chance when it is the only one with weight', () => {
    for (const s of chain(lookWith({ melt: 1 }), 20)) expect(s).toBe('melt')
  })

  it('never returns a disabled style, whatever the weights, mood, boundary or rotation', () => {
    const weightSets: Weights[] = [
      { dissolve: 1 },
      { smear: 1 },
      { melt: 1 },
      { collapse: 1 },
      { dissolve: 0.25, smear: 0.25, melt: 0.25, collapse: 0.25 },
    ]
    for (const w of weightSets) {
      const look = lookWith(w)
      for (const mood of MOODS) {
        for (const sc of [true, false]) {
          for (const boundary of [undefined, null, 'drop', 'breakdown', 'generic'] as const) {
            for (const r of [0, 1, 2, 7, 100, -3]) {
              const s = pickTransitionStyle(mood, sc, r, undefined, boundary, look)
              expect(isStyleSelectable(s), `${JSON.stringify(w)}/${mood}/${sc}/${boundary}/${r}: ${s}`).toBe(true)
              expect(TRANSITION_STYLES).toContain(s)
            }
          }
        }
      }
    }
  })

  it('keeps the energy invariant for everything it can return', () => {
    // Every look-picked style is a blending style, so the frame holds constant light through the fade.
    const look = lookWith({ dissolve: 0.3, smear: 0.3, melt: 0.2, collapse: 0.2 })
    for (const s of new Set(chain(look, 200))) {
      for (const t of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) expect(mixEnergy(s, t), `${s} at t=${t}`).toBeCloseTo(1, 6)
    }
  })

  describe('the section-boundary overrides above the mood pick', () => {
    const anyLook = lookWith({ collapse: 1 })

    it('keeps a classified breakdown on smear, whatever the profile says', () => {
      for (let r = 0; r < 10; r++) {
        expect(pickTransitionStyle('groove', true, r, undefined, 'breakdown', anyLook)).toBe('smear')
        expect(pickTransitionStyle('peak', true, r, 'smear', 'breakdown', lookWith({ dissolve: 1 }))).toBe('smear')
      }
    })

    it('lets a drop fall through to the profile’s pick while dipToBlack is disabled', () => {
      expect(isStyleSelectable('dipToBlack')).toBe(false)
      for (let r = 0; r < 10; r++) {
        const drop = pickTransitionStyle('groove', true, r, undefined, 'drop', anyLook)
        expect(drop).not.toBe('dipToBlack')
        expect(drop).toBe(pickTransitionStyle('groove', false, r, undefined, null, anyLook))
      }
    })

    it('treats a generic or unclassified boundary like any other change', () => {
      const look = lookWith({ dissolve: 0.5, smear: 0.5 })
      for (let r = 0; r < 10; r++) {
        const plain = pickTransitionStyle('groove', false, r, undefined, null, look)
        expect(pickTransitionStyle('groove', true, r, undefined, 'generic', look)).toBe(plain)
        expect(pickTransitionStyle('groove', true, r, undefined, null, look)).toBe(plain)
        expect(pickTransitionStyle('groove', true, r, undefined, undefined, look)).toBe(plain)
      }
    })

    it('ignores the boundary type away from an edge', () => {
      const look = lookWith({ dissolve: 0.5, smear: 0.5 })
      expect(pickTransitionStyle('groove', false, 3, undefined, 'breakdown', look)).toBe(
        pickTransitionStyle('groove', false, 3, undefined, null, look),
      )
    })
  })

  it('keeps silence on the neutral dissolve, whatever the profile says', () => {
    const look = lookWith({ collapse: 0.7, melt: 0.3 })
    for (let r = 0; r < 12; r++) {
      expect(pickTransitionStyle('silence', false, r, undefined, null, look)).toBe('dissolve')
      expect(pickTransitionStyle('silence', false, r, 'dissolve', null, look)).toBe('dissolve')
    }
    // ...while the same profile drives every other mood.
    expect(pickTransitionStyle('groove', false, 0, undefined, null, look)).toBe('collapse')
  })

  it('is deterministic, so a recorded set replays identically', () => {
    const look = lookWith({ dissolve: 0.4, smear: 0.3, melt: 0.2, collapse: 0.1 })
    expect(chain(look, 60)).toEqual(chain(look, 60))
  })

  it('falls back to the legacy per-mood list when the profile carries no usable weight', () => {
    for (const w of [{}, { dissolve: -1 }] as Weights[]) {
      const empty = lookWith(w)
      for (const mood of MOODS) {
        for (let r = 0; r < 6; r++) {
          expect(pickTransitionStyle(mood, false, r, undefined, null, empty)).toBe(
            pickTransitionStyle(mood, false, r, undefined, null),
          )
        }
      }
    }
    const nan = createLookProfile()
    nan.transitionWeights = LOOK_TRANSITIONS.map(() => NaN)
    expect(pickTransitionStyle('groove', false, 4, 'smear', null, nan)).toBe(pickTransitionStyle('groove', false, 4, 'smear', null))
  })

  it('survives a nonsense rotation counter', () => {
    const look = lookWith({ dissolve: 0.5, smear: 0.5 })
    for (const r of [NaN, Infinity, -Infinity, -7, 2.5, 1e12]) {
      const s = pickTransitionStyle('groove', false, r, undefined, null, look)
      expect(['dissolve', 'smear']).toContain(s)
    }
  })
})
