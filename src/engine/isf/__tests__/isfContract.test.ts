import { describe, expect, it } from 'vitest'
import { validateContract } from '../../../scenes/contract'
import {
  buildIsfContract,
  DERIVED_RANGE_FACTOR,
  isfParamUpdater,
  isfRemap,
  resolveRange,
} from '../isfContract'
import { parseISF, type IsfInput } from '../parseISF'
import CHECKERBOARD_FS from './fixtures/Checkerboard.fs?raw'

/** A parsed input, without needing a whole file around it. */
function input(over: Partial<IsfInput> & { name: string; type: IsfInput['type'] }): IsfInput {
  return { ...over, raw: over.raw ?? {} }
}

describe('isfRemap — the derived curve', () => {
  /**
   * The assertion the whole phase turns on.
   *
   * `MalachiteScene.tsx` writes this by hand:
   *
   * ```ts
   * u.uScale.value = P.fill < 0.5 ? 1.0 + P.fill * 2.8 : 2.4 + (P.fill - 0.5) * 5.2
   * ```
   *
   * Six numbers, of which only three are information: the knob runs 1.0 to 5.0
   * and the shader was authored at 2.4. If the derivation is right, feeding it
   * those three has to reproduce the other three exactly — not approximately,
   * because a curator comparing a generated descriptor against a hand-written
   * one will read any difference as a bug in one of them.
   */
  it('reproduces the hand-written Malachite curve across the whole dial', () => {
    const { map } = isfRemap({ min: 1.0, def: 2.4, max: 5.0 })
    const malachite = (p: number) => (p < 0.5 ? 1.0 + p * 2.8 : 2.4 + (p - 0.5) * 5.2)
    for (let i = 0; i <= 100; i++) {
      const p = i / 100
      expect(map(p)).toBeCloseTo(malachite(p), 12)
    }
  })

  it('lands 0.5 exactly on the authored DEFAULT', () => {
    // `toBe`, not `toBeCloseTo`. "Exactly" is the promise, and it is keepable:
    // at p = 0.5 the piecewise branch returns `def` without arithmetic.
    for (const range of [
      { min: 1.0, def: 2.4, max: 5.0 },
      { min: 0, def: 0.25, max: 1 },
      { min: -180, def: 0, max: 180 },
      { min: 0, def: 4096, max: 8192 },
    ]) {
      expect(isfRemap(range).map(0.5)).toBe(range.def)
    }
  })

  it('lands 0 on MIN and 1 on MAX', () => {
    const { map } = isfRemap({ min: 1.0, def: 2.4, max: 5.0 })
    expect(map(0)).toBe(1.0)
    expect(map(1)).toBe(5.0)
  })

  it('is monotonic, so a swept dial never doubles back', () => {
    const { map } = isfRemap({ min: 1.0, def: 2.4, max: 5.0 })
    let prev = -Infinity
    for (let i = 0; i <= 200; i++) {
      const v = map(i / 200)
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
  })

  it('clamps out-of-range input rather than extrapolating past the bounds', () => {
    const { map } = isfRemap({ min: 1.0, def: 2.4, max: 5.0 })
    expect(map(-1)).toBe(1.0)
    expect(map(2)).toBe(5.0)
  })

  it('clamps a DEFAULT that sits outside its own declared bounds', () => {
    const r = isfRemap({ min: 0, def: 9, max: 1 })
    expect(r.range.def).toBe(1)
    expect(r.map(1)).toBe(1)
  })
})

describe('isfRemap — DEFAULT on a bound', () => {
  it('goes linear with neutral 0 when DEFAULT sits at MIN', () => {
    const r = isfRemap({ min: 0, def: 0, max: 10 })
    expect(r.neutral).toBe(0)
    // The promise being kept: the scene at its declared default renders what
    // the ISF author authored.
    expect(r.map(r.neutral)).toBe(0)
    expect(r.map(0)).toBe(0)
    expect(r.map(1)).toBe(10)
    // And the whole dial still does something — a pinned-0.5 curve would leave
    // the bottom half of this one flat.
    expect(r.map(0.25)).toBe(2.5)
    expect(r.map(0.5)).toBe(5)
  })

  it('goes linear with neutral 1 when DEFAULT sits at MAX', () => {
    const r = isfRemap({ min: 2, def: 8, max: 8 })
    expect(r.neutral).toBe(1)
    expect(r.map(r.neutral)).toBe(8)
    expect(r.map(0)).toBe(2)
    expect(r.map(0.5)).toBe(5)
  })

  it('collapses a zero-width range to a constant instead of dividing by it', () => {
    const r = isfRemap({ min: 3, def: 3, max: 3 })
    for (const p of [0, 0.25, 0.5, 1]) expect(r.map(p)).toBe(3)
  })

  it('never produces NaN, at any bound arrangement', () => {
    const ranges = [
      { min: 0, def: 0, max: 0 },
      { min: 0, def: 0, max: 1 },
      { min: 1, def: 1, max: 1 },
      { min: -1, def: -1, max: 1 },
      { min: 5, def: 1, max: 2 },
      { min: 2, def: 3, max: 1 },
    ]
    for (const range of ranges) {
      const { map } = isfRemap(range)
      for (let i = 0; i <= 10; i++) expect(Number.isFinite(map(i / 10))).toBe(true)
    }
  })
})

describe('resolveRange — filling in what ISF left out', () => {
  it('uses MIN and MAX when the author stated them', () => {
    const r = resolveRange(input({ name: 'a', type: 'float', min: 1, max: 9, default: 3 }))
    expect(r).toEqual({ min: 1, def: 3, max: 9 })
  })

  it('synthesises the drastic() span around a DEFAULT with no declared range', () => {
    // Checkerboard's own `width`, which is the common corpus shape.
    const r = resolveRange(input({ name: 'width', type: 'float', default: 0.25 }))
    expect(r).toEqual({ min: 0.25 / DERIVED_RANGE_FACTOR, def: 0.25, max: 0.25 * 4 })
    // …and the curve over it still puts neutral on the authored value.
    expect(isfRemap(r).map(0.5)).toBe(0.25)
  })

  it('falls back to 0..1 for a zero or absent DEFAULT, where no span exists', () => {
    expect(resolveRange(input({ name: 'a', type: 'float', default: 0 }))).toEqual({
      min: 0,
      def: 0,
      max: 1,
    })
    expect(resolveRange(input({ name: 'a', type: 'float' }))).toEqual({ min: 0, def: 0.5, max: 1 })
  })

  it('handles a negative DEFAULT without inverting the range', () => {
    const r = resolveRange(input({ name: 'a', type: 'float', default: -2 }))
    expect(r.min).toBeLessThan(r.def)
    expect(r.max).toBeGreaterThan(r.def)
  })

  it('lets a curator narrow a range that is technically correct and unusable', () => {
    const r = resolveRange(input({ name: 'iters', type: 'float', min: 1, max: 200, default: 8 }), {
      max: 24,
    })
    expect(r).toEqual({ min: 1, def: 8, max: 24 })
  })
})

describe('buildIsfContract on the real Checkerboard.fs', () => {
  const { header } = parseISF(CHECKERBOARD_FS, { origin: 'Checkerboard.fs' })
  const built = buildIsfContract('checkerboard', header, { fill: 'width' })

  it('produces a contract the registry will accept', () => {
    expect(validateContract('checkerboard', built.contract)).toEqual([])
    expect(built.contract.version).toBe(1)
  })

  it('sets the declared default to the position that renders the authored value', () => {
    expect(built.contract.params.fill).toBe(0.5)
    expect(built.bindings[0].remap.map(built.contract.params.fill as number)).toBe(0.25)
  })

  it('labels the knob with the source shader’s own name for it', () => {
    expect(built.contract.paramLabels?.['*']?.fill).toBe('width')
  })

  it('points the binding at the uniform transpileISF generates', () => {
    expect(built.bindings.map((b) => [b.key, b.uniform])).toEqual([['fill', 'uIsfWidth']])
  })

  it('refuses a key mapped to an input the shader does not declare', () => {
    expect(() => buildIsfContract('checkerboard', header, { fill: 'wdith' })).toThrow(
      /does not declare/,
    )
  })

  it('refuses a key mapped to a point2D or a color', () => {
    // Two-to-four independent numbers cannot come off one 0..1 dial without
    // inventing a path through a space the author never described.
    expect(() => buildIsfContract('checkerboard', header, { fill: 'offset' })).toThrow(
      /two components/,
    )
    expect(() => buildIsfContract('checkerboard', header, { fill: 'color1' })).toThrow(
      /four components/,
    )
  })

  it('emits keys in canonical order regardless of how the mapping was typed', () => {
    const both = buildIsfContract('checkerboard', header, { fill: 'width', speed: 'width' })
    expect(both.bindings.map((b) => b.key)).toEqual(['speed', 'fill'])
  })
})

describe('non-float input types', () => {
  it('selects a long by menu ENTRY, not by interpolating its values', () => {
    // A menu of 1/2/4/8/16 is not evenly spaced. Mapping linearly over the
    // values would spend two thirds of the dial inside the last step.
    const r = buildIsfContract(
      'menu',
      {
        categories: [],
        raw: {},
        inputs: [input({ name: 'levels', type: 'long', values: [1, 2, 4, 8, 16], default: 4 })],
      },
      { density: 'levels' },
    ).bindings[0].remap
    expect(r.map(0)).toBe(1)
    expect(r.map(1)).toBe(16)
    expect(r.neutral).toBe(0.5)
    expect(r.map(r.neutral)).toBe(4)
  })

  it('thresholds a bool at the midpoint and neutralises on its default', () => {
    const on = buildIsfContract(
      'flag',
      { categories: [], raw: {}, inputs: [input({ name: 'invert', type: 'bool', default: true })] },
      { shape: 'invert' },
    ).bindings[0].remap
    expect(on.neutral).toBe(1)
    expect(on.map(0)).toBe(0)
    expect(on.map(1)).toBe(1)
  })

  it('rounds an integer knob so the top of its range is reachable', () => {
    const r = buildIsfContract(
      'ints',
      {
        categories: [],
        raw: {},
        inputs: [input({ name: 'n', type: 'long', min: 1, max: 5, default: 3 })],
      },
      { density: 'n' },
    ).bindings[0].remap
    expect(r.map(1)).toBe(5)
    expect(Number.isInteger(r.map(0.7))).toBe(true)
  })
})

describe('isfParamUpdater', () => {
  const { header } = parseISF(CHECKERBOARD_FS)
  const { bindings } = buildIsfContract('checkerboard', header, { fill: 'width' })
  const apply = isfParamUpdater(bindings)

  const params = (over: Record<string, number>) => ({
    speed: 0.5,
    shape: 0.5,
    complexity: 0.5,
    density: 0.5,
    fill: 0.5,
    tilt: 0.5,
    contrast: 0.5,
    ...over,
  })

  it('writes the mapped value into the uniform', () => {
    const u = { uIsfWidth: { value: 0 } }
    apply(u, params({ fill: 0.5 }))
    expect(u.uIsfWidth.value).toBe(0.25)
    apply(u, params({ fill: 1 }))
    expect(u.uIsfWidth.value).toBe(1)
  })

  it('throws loudly when the scene forgot the uniform, rather than running a dead dial', () => {
    expect(() => apply({}, params({}))).toThrow(/missing the uniform "uIsfWidth"/)
  })
})
