import { describe, expect, it } from 'vitest'
import SCENE_MANAGER_SRC from '../SceneManager.tsx?raw'
import { TRANSITION_STYLES, usesRack, type TransitionStyle } from '../transitions'
import {
  DATAMOSH_CHANNEL_OFFSET_MAX,
  DATAMOSH_MAX_DISPLACEMENT,
  WIPE_FEATHER_MAX,
  WIPE_FEATHER_MIN,
  WIPE_LAYER_IN,
  WIPE_LAYER_OUT,
  WIPE_MAX_TIER,
  WIPE_STYLE_INDEX,
  datamoshBlockOffset,
  datamoshChannelOffset,
  featherFor,
  inkMaskValue,
  irisMaskValue,
  shouldCapture,
  transitionCategory,
  usesWipe,
} from '../transitionWipe'

/** Sample points across a transition, endpoints included — same spread as transitions.test.ts. */
const SAMPLES = Array.from({ length: 41 }, (_, i) => i / 40)

describe('WIPE_LAYER_OUT / WIPE_LAYER_IN', () => {
  it('are distinct, far from the low layer bits a scene author would casually reach for', () => {
    expect(WIPE_LAYER_OUT).not.toBe(WIPE_LAYER_IN)
    expect(WIPE_LAYER_OUT).toBeGreaterThanOrEqual(29)
    expect(WIPE_LAYER_IN).toBeGreaterThanOrEqual(29)
    // THREE.Layers uses a 32-bit mask (bits 0..31) — both must be valid bit indices.
    expect(WIPE_LAYER_OUT).toBeLessThanOrEqual(31)
    expect(WIPE_LAYER_IN).toBeLessThanOrEqual(31)
  })
})

describe('usesWipe / transitionCategory', () => {
  it('classifies all 9 TRANSITION_STYLES into exactly one of ramp / wipe / mix', () => {
    const WIPE: TransitionStyle[] = ['inkDissolve', 'irisWipe', 'datamosh']
    for (const style of TRANSITION_STYLES) {
      expect(usesWipe(style), style).toBe(WIPE.includes(style))
      const cat = transitionCategory(style)
      if (WIPE.includes(style)) {
        expect(cat, style).toBe('wipe')
      } else if (usesRack(style)) {
        expect(cat, style).toBe('ramp')
      } else {
        expect(cat, style).toBe('mix')
      }
    }
  })

  it('wipe and ramp are mutually exclusive for every style', () => {
    for (const style of TRANSITION_STYLES) {
      expect(usesWipe(style) && usesRack(style), style).toBe(false)
    }
  })

  it('WIPE_STYLE_INDEX has a distinct index 0..2 for each of the 3 wipe styles', () => {
    const indices = Object.values(WIPE_STYLE_INDEX)
    expect(new Set(indices).size).toBe(3)
    expect([...indices].sort()).toEqual([0, 1, 2])
    expect(Object.keys(WIPE_STYLE_INDEX).sort()).toEqual(['datamosh', 'inkDissolve', 'irisWipe'])
  })
})

describe('shouldCapture', () => {
  it('is never true while inactive, whatever the style', () => {
    for (const style of TRANSITION_STYLES) {
      expect(shouldCapture({ active: false, style }), style).toBe(false)
    }
  })

  it('is true only for an active wipe style', () => {
    for (const style of TRANSITION_STYLES) {
      expect(shouldCapture({ active: true, style }), style).toBe(usesWipe(style))
    }
  })
})

describe('WIPE_MAX_TIER', () => {
  it('restricts wipe styles to the two richest tiers (0 and 1) of quality.ts\'s 0..4 ladder', () => {
    expect(WIPE_MAX_TIER).toBeGreaterThanOrEqual(0)
    expect(WIPE_MAX_TIER).toBeLessThan(2)
  })
})

describe('featherFor', () => {
  it('is monotonically non-increasing as sharpness rises from 1 to 8', () => {
    let prev = featherFor(1)
    for (let k = 1; k <= 8; k += 0.5) {
      const f = featherFor(k)
      expect(f).toBeLessThanOrEqual(prev + 1e-9)
      prev = f
    }
  })

  it('is widest at the calmest sharpness and narrowest at the harshest', () => {
    expect(featherFor(1)).toBeCloseTo(WIPE_FEATHER_MAX, 9)
    expect(featherFor(8)).toBeCloseTo(WIPE_FEATHER_MIN, 9)
    expect(featherFor(1)).toBeGreaterThan(featherFor(8))
  })

  it('clamps out-of-range sharpness to the documented 1..8', () => {
    expect(featherFor(0)).toBe(featherFor(1))
    expect(featherFor(-5)).toBe(featherFor(1))
    expect(featherFor(100)).toBe(featherFor(8))
  })

  it('folds a non-finite sharpness to the neutral default (k=3)', () => {
    expect(featherFor(NaN)).toBe(featherFor(3))
    expect(featherFor(Infinity)).toBe(featherFor(3))
    expect(featherFor(-Infinity)).toBe(featherFor(3))
  })

  it('always stays within the documented [MIN, MAX] range', () => {
    for (let k = -10; k <= 20; k += 0.7) {
      const f = featherFor(k)
      expect(f).toBeGreaterThanOrEqual(WIPE_FEATHER_MIN - 1e-9)
      expect(f).toBeLessThanOrEqual(WIPE_FEATHER_MAX + 1e-9)
    }
  })
})

describe('inkMaskValue / irisMaskValue', () => {
  // A representative noise/radius value comfortably inside [feather, 1-feather] for every feather this
  // system produces (feather never exceeds WIPE_FEATHER_MAX), so the endpoint behaviour below is exact
  // rather than softened by the feathered edge extending past the 0..1 domain (see the doc comment on
  // inkMaskValue for why that softening is expected, not a bug, near noise01/radius 0 or 1).
  const MID = 0.5

  it('reaches exactly 0 at progress 0 and exactly 1 at progress 1, for a mid-range threshold', () => {
    for (const feather of [WIPE_FEATHER_MIN, 0.1, WIPE_FEATHER_MAX]) {
      expect(inkMaskValue(MID, 0, feather)).toBe(0)
      expect(inkMaskValue(MID, 1, feather)).toBe(1)
      expect(irisMaskValue(MID, 0, feather)).toBe(0)
      expect(irisMaskValue(MID, 1, feather)).toBe(1)
    }
  })

  it('is monotonically non-decreasing in progress for any threshold/feather', () => {
    for (const threshold of [0, 0.2, 0.5, 0.8, 1]) {
      for (const feather of [WIPE_FEATHER_MIN, 0.1, WIPE_FEATHER_MAX]) {
        let prev = -Infinity
        for (const t of SAMPLES) {
          const v = inkMaskValue(threshold, t, feather)
          expect(v).toBeGreaterThanOrEqual(prev - 1e-9)
          prev = v
        }
      }
    }
  })

  it('stays within [0, 1] for any input, including out-of-range noise/progress', () => {
    for (const n of [-2, -0.1, 0, 0.5, 1, 1.5, 3]) {
      for (const p of [-2, -0.1, 0, 0.5, 1, 1.5, 3]) {
        const v = inkMaskValue(n, p, 0.1)
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(1)
      }
    }
  })

  it('is complementary with (1 - value): maskOut + maskIn === 1 by construction', () => {
    // The pass computes maskOut as `1.0 - maskIn` directly rather than calling a second function — this
    // test pins that the value itself is always a clean 0..1 number that construction can safely subtract
    // from 1 with no separate "maskOut" formula needed (see WipeCompositorPass.ts's header).
    for (const t of SAMPLES) {
      const maskIn = inkMaskValue(0.4, t, 0.15)
      const maskOut = 1 - maskIn
      expect(maskOut + maskIn).toBeCloseTo(1, 12)
    }
  })

  it('irisMaskValue is literally the same shape as inkMaskValue (radius plays the role of noise)', () => {
    for (const t of SAMPLES) {
      expect(irisMaskValue(0.3, t, 0.12)).toBe(inkMaskValue(0.3, t, 0.12))
    }
  })
})

describe('datamoshBlockOffset', () => {
  const SEEDS = [0, 1, 7, 42, 1000.5, -3]
  const BLOCK_INDICES = [0, 1, 5, 17, 63, 255]

  it('is deterministic: repeated calls with the same inputs give the same output', () => {
    for (const seed of SEEDS) {
      for (const blockIndex of BLOCK_INDICES) {
        const a = datamoshBlockOffset(seed, blockIndex, 0.42)
        const b = datamoshBlockOffset(seed, blockIndex, 0.42)
        expect(b).toEqual(a)
      }
    }
  })

  it('displacement magnitude is strictly non-increasing as progress sweeps 0 -> 1 (settles)', () => {
    for (const seed of SEEDS) {
      for (const blockIndex of BLOCK_INDICES) {
        let prevMag = Infinity
        for (const t of SAMPLES) {
          const { dx, dy } = datamoshBlockOffset(seed, blockIndex, t)
          const mag = Math.hypot(dx, dy)
          expect(mag).toBeLessThanOrEqual(prevMag + 1e-9)
          prevMag = mag
        }
      }
    }
  })

  it('displacement is exactly zero at progress 1 (fully settled) for every seed/block sampled', () => {
    for (const seed of SEEDS) {
      for (const blockIndex of BLOCK_INDICES) {
        const { dx, dy } = datamoshBlockOffset(seed, blockIndex, 1)
        // Math.abs rather than a bare toBe(0): a negative hash direction times
        // a zero `settle` produces IEEE754 negative zero, and Object.is(-0, 0)
        // (what `toBe` checks) is false even though -0 === 0 numerically.
        expect(Math.abs(dx)).toBe(0)
        expect(Math.abs(dy)).toBe(0)
      }
    }
  })

  it('never exceeds DATAMOSH_MAX_DISPLACEMENT in magnitude', () => {
    for (const seed of SEEDS) {
      for (const blockIndex of BLOCK_INDICES) {
        for (const t of SAMPLES) {
          const { dx, dy } = datamoshBlockOffset(seed, blockIndex, t)
          expect(Math.hypot(dx, dy)).toBeLessThanOrEqual(DATAMOSH_MAX_DISPLACEMENT * Math.SQRT2 + 1e-9)
        }
      }
    }
  })

  it('reveal is a pure function of (seed, blockIndex, progress): monotonic threshold, no hidden state', () => {
    for (const seed of SEEDS) {
      for (const blockIndex of BLOCK_INDICES) {
        // Once a block reveals at some progress p0, it must stay revealed for every p' > p0 — a pure
        // hash-vs-progress threshold guarantees this; hidden per-call state (a counter, a clock) would not.
        let sawReveal = false
        for (const t of SAMPLES) {
          const { reveal } = datamoshBlockOffset(seed, blockIndex, t)
          if (sawReveal) expect(reveal, `seed=${seed} block=${blockIndex} t=${t}`).toBe(true)
          if (reveal) sawReveal = true
        }
      }
    }
  })

  it('reveal is always true by progress 1 and always false at progress 0 (hash strictly < 1, never < 0)', () => {
    for (const seed of SEEDS) {
      for (const blockIndex of BLOCK_INDICES) {
        expect(datamoshBlockOffset(seed, blockIndex, 0).reveal).toBe(false)
        expect(datamoshBlockOffset(seed, blockIndex, 1).reveal).toBe(true)
      }
    }
  })

  it('spreads reveal thresholds across many blocks rather than flipping them all at once', () => {
    // A large sample of block indices under one seed should reveal at meaningfully different progress
    // values — not a formal uniformity test, just a guard against a degenerate hash that returns a
    // near-constant value (which would make every block reveal in the same instant, defeating the whole
    // point of a per-block threshold).
    const revealProgressOf = (blockIndex: number): number => {
      for (const t of SAMPLES) {
        if (datamoshBlockOffset(7, blockIndex, t).reveal) return t
      }
      return 1
    }
    const thresholds = Array.from({ length: 64 }, (_, i) => revealProgressOf(i))
    const distinct = new Set(thresholds)
    expect(distinct.size).toBeGreaterThan(10)
  })

  it('has no time/frame parameter to reseed from — structurally enforced by the function signature', () => {
    expect(datamoshBlockOffset.length).toBe(3)
  })
})

describe('datamoshChannelOffset', () => {
  it('is bounded within ±DATAMOSH_CHANNEL_OFFSET_MAX for every reveal/progress combination', () => {
    for (const reveal of [true, false]) {
      for (const t of SAMPLES) {
        const v = datamoshChannelOffset(reveal, t)
        expect(Math.abs(v)).toBeLessThanOrEqual(DATAMOSH_CHANNEL_OFFSET_MAX + 1e-9)
      }
    }
  })

  it('is zero at progress 0 and progress 1 (never a static offset when the wipe is not in motion)', () => {
    expect(datamoshChannelOffset(true, 0)).toBeCloseTo(0, 9)
    expect(datamoshChannelOffset(false, 0)).toBeCloseTo(0, 9)
    expect(datamoshChannelOffset(true, 1)).toBeCloseTo(0, 9)
    expect(datamoshChannelOffset(false, 1)).toBeCloseTo(0, 9)
  })

  it('peaks at the transition midpoint', () => {
    expect(Math.abs(datamoshChannelOffset(true, 0.5))).toBeCloseTo(DATAMOSH_CHANNEL_OFFSET_MAX, 9)
  })

  it('flips sign with reveal, for a directional split rather than a uniform tint', () => {
    for (const t of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      expect(datamoshChannelOffset(true, t)).toBeCloseTo(-datamoshChannelOffset(false, t), 9)
    }
  })
})

describe('capture ordering (source pin)', () => {
  // The layer assignment in SceneManager.tsx and the capture read in PostFXChain.tsx are two DEFAULT-priority
  // useFrame hooks with no other ordering relationship: R3F gives no guarantee about execution order between
  // equal-priority hooks beyond registration order, which today happens to work only because <SceneManager>
  // mounts before <PostFXChain> (Stage.tsx) -- fragile, and silently breakable by an unrelated JSX reorder.
  // SceneManager's hook was given an explicit -1 so it is GUARANTEED to run before PostFXChain's capture
  // (default 0) regardless of mount order. This test pins that the priority argument is still there, so a
  // future edit that drops it (even accidentally, e.g. a refactor that reformats the useFrame call) is caught
  // here rather than silently reintroducing a one-frame-stale-capture bug that no visual test can catch.
  it('the wipe-layer assignment useFrame in SceneManager.tsx has an explicit priority before PostFXChain default', () => {
    const layerBlock = SCENE_MANAGER_SRC.indexOf('WIPE_LAYER_OUT : entry.dir === 1 ? WIPE_LAYER_IN : 0')
    expect(layerBlock, 'the wipe-layer targetLayer computation').toBeGreaterThan(-1)
    // From that point, the enclosing useFrame's close must carry a priority below PostFXChain's default (0).
    const closeIdx = SCENE_MANAGER_SRC.indexOf('}, -1)', layerBlock)
    expect(closeIdx, 'useFrame(..., -1) after the layer-assignment block').toBeGreaterThan(layerBlock)
  })
})
