import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  lerpOklab,
  linearSrgbToOklab,
  oklabDistance,
  oklabToLinearSrgb,
  oklabToOklch,
  oklchToOklab,
} from '../oklab'

/**
 * Correctness of the conversion matrices, then the two properties that
 * actually motivated switching `PaletteBlender` off `THREE.Color.lerp`:
 * chroma retention through a hue-distant midpoint, and no midpoint darkening.
 */

describe('linearSrgbToOklab / oklabToLinearSrgb — round trip and anchors', () => {
  it('round-trips arbitrary in-gamut colours', () => {
    const samples: [number, number, number][] = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
      [1, 1, 0],
      [0, 1, 1],
      [1, 0, 1],
      [0.5, 0.25, 0.75],
      [0.02, 0.6, 0.9],
    ]
    for (const [r, g, b] of samples) {
      const [L, a, bb] = linearSrgbToOklab(r, g, b)
      const [r2, g2, b2] = oklabToLinearSrgb(L, a, bb)
      expect(r2, `r for ${r},${g},${b}`).toBeCloseTo(r, 4)
      expect(g2, `g for ${r},${g},${b}`).toBeCloseTo(g, 4)
      expect(b2, `b for ${r},${g},${b}`).toBeCloseTo(b, 4)
    }
  })

  it('maps linear black and white to Oklab (0,0,0) and (1,0,0)', () => {
    const black = linearSrgbToOklab(0, 0, 0)
    expect(black[0]).toBeCloseTo(0, 5)
    expect(black[1]).toBeCloseTo(0, 5)
    expect(black[2]).toBeCloseTo(0, 5)

    const white = linearSrgbToOklab(1, 1, 1)
    expect(white[0]).toBeCloseTo(1, 4)
    expect(white[1]).toBeCloseTo(0, 4)
    expect(white[2]).toBeCloseTo(0, 4)
  })

  it('matches the published reference value for pure red', () => {
    // sRGB (1,0,0) is also linear (1,0,0) — a gamma curve fixes 0 and 1 — so
    // this is directly comparable to the widely-quoted anchor from Ottosson's
    // own writeup and reproduced identically across culori/colorjs.io/CSS
    // Color 4 worked examples: Oklab ≈ (0.6280, 0.2249, 0.1258).
    const [L, a, b] = linearSrgbToOklab(1, 0, 0)
    expect(L).toBeCloseTo(0.628, 3)
    expect(a).toBeCloseTo(0.2249, 3)
    expect(b).toBeCloseTo(0.1258, 3)
  })
})

describe('oklabToOklch / oklchToOklab', () => {
  it('round-trips through polar form', () => {
    const cases: [number, number, number][] = [
      [0.6, 0.1, 0.05],
      [0.3, -0.08, 0.12],
      [0.9, 0, 0],
    ]
    for (const [L, a, b] of cases) {
      const [Lc, C, h] = oklabToOklch(L, a, b)
      const [L2, a2, b2] = oklchToOklab(Lc, C, h)
      expect(L2).toBeCloseTo(L, 5)
      expect(a2).toBeCloseTo(a, 5)
      expect(b2).toBeCloseTo(b, 5)
    }
  })

  it('gives achromatic colours zero chroma', () => {
    const [, C] = oklabToOklch(0.5, 0, 0)
    expect(C).toBeCloseTo(0, 6)
  })
})

describe('lerpOklab', () => {
  it('is a no-op at alpha 0 and a snap at alpha 1', () => {
    const c = new THREE.Color('#ff0000')
    const target = new THREE.Color('#0000ff')
    const before = c.clone()
    lerpOklab(c, target, 0)
    expect(c.equals(before)).toBe(true)
    lerpOklab(c, target, 1)
    expect(c.equals(target)).toBe(true)
  })

  it('never produces a NaN or out-of-range channel across the whole roster of hue pairs', () => {
    const hexes = [
      '#020208',
      '#00e5ff',
      '#7c4dff',
      '#00ffa3',
      '#ff6d00',
      '#ff1744',
      '#ffd54f',
      '#b388ff',
      '#ffffff',
      '#000000',
    ]
    for (const h1 of hexes) {
      for (const h2 of hexes) {
        for (const t of [0, 0.1, 0.5, 0.9, 1]) {
          const c = new THREE.Color(h1)
          lerpOklab(c, new THREE.Color(h2), t)
          expect(Number.isFinite(c.r) && Number.isFinite(c.g) && Number.isFinite(c.b)).toBe(true)
          expect(c.r).toBeGreaterThanOrEqual(0)
          expect(c.r).toBeLessThanOrEqual(1)
          expect(c.g).toBeGreaterThanOrEqual(0)
          expect(c.g).toBeLessThanOrEqual(1)
          expect(c.b).toBeGreaterThanOrEqual(0)
          expect(c.b).toBeLessThanOrEqual(1)
        }
      }
    }
  })

  it('keeps a blue->yellow midpoint more saturated than a linear-sRGB lerp does', () => {
    // This is the actual defect the switch fixes. Linear interpolation of a
    // hue-distant pair passes through a desaturated, often muddier midpoint;
    // Oklab holds chroma across the ramp. Measured as Oklab chroma of the
    // midpoint colour under each method.
    const blue = new THREE.Color('#0033ff')
    const yellow = new THREE.Color('#ffee00')

    const okMid = blue.clone()
    lerpOklab(okMid, yellow, 0.5)
    const [, okChroma] = oklabToOklch(...linearSrgbToOklab(okMid.r, okMid.g, okMid.b))

    const linMid = blue.clone().lerp(yellow, 0.5)
    const [, linChroma] = oklabToOklch(...linearSrgbToOklab(linMid.r, linMid.g, linMid.b))

    expect(okChroma).toBeGreaterThan(linChroma)
  })

  it('holds midpoint lightness close to the average, unlike a linear-sRGB lerp on this pair', () => {
    // The blue->yellow linear lerp is also documented as reading too dark /
    // magenta-tinted at the midpoint. Oklab's L is designed to be closer to
    // perceived lightness, so the midpoint L should land nearer the mean of
    // the two endpoints' Oklab L than the linear lerp's midpoint does.
    const blue = new THREE.Color('#0033ff')
    const yellow = new THREE.Color('#ffee00')
    const [Lblue] = linearSrgbToOklab(blue.r, blue.g, blue.b)
    const [Lyellow] = linearSrgbToOklab(yellow.r, yellow.g, yellow.b)
    const meanL = (Lblue + Lyellow) / 2

    const okMid = blue.clone()
    lerpOklab(okMid, yellow, 0.5)
    const [okL] = linearSrgbToOklab(okMid.r, okMid.g, okMid.b)

    const linMid = blue.clone().lerp(yellow, 0.5)
    const [linL] = linearSrgbToOklab(linMid.r, linMid.g, linMid.b)

    expect(Math.abs(okL - meanL)).toBeLessThan(Math.abs(linL - meanL))
  })

  it('mutates and returns the first argument, matching THREE.Color.lerp\'s call shape', () => {
    const c = new THREE.Color('#112233')
    const result = lerpOklab(c, new THREE.Color('#ffffff'), 0.3)
    expect(result).toBe(c)
  })
})

describe('oklabDistance', () => {
  it('is zero for identical colours and positive for distinct ones', () => {
    const a = new THREE.Color('#00e5ff')
    expect(oklabDistance(a, a.clone())).toBeCloseTo(0, 6)
    expect(oklabDistance(new THREE.Color('#000000'), new THREE.Color('#ffffff'))).toBeGreaterThan(0)
  })

  it('is symmetric', () => {
    const a = new THREE.Color('#ff6d00')
    const b = new THREE.Color('#7c4dff')
    expect(oklabDistance(a, b)).toBeCloseTo(oklabDistance(b, a), 8)
  })
})
