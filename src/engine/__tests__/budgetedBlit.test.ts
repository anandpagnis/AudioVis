import { describe, expect, it } from 'vitest'
import { BLIT_CUBIC_MAX_TIER, BLIT_CUBIC_TENSION, DISPLAY_FRAG, blitCubicFor } from '../createShaderScene'

/**
 * F272 stage 2: the budgeted-scene blit.
 *
 * `DISPLAY_FRAG` is mirrored below in plain TypeScript, operation for
 * operation, against a synthetic texture with hardware-style bilinear
 * filtering, so the properties that matter are checked without a GPU:
 * exact copy at 1:1 (the alignment bug), no tap outside the active rect
 * (stale texels), and no ringing or negative light from the cubic.
 */

interface Tex {
  /** Allocated size. The active rect is the bottom-left `srcW x srcH`. */
  fullW: number
  fullH: number
  data: Float64Array
}

function makeTex(fullW: number, fullH: number, fill: (x: number, y: number) => number): Tex {
  const data = new Float64Array(fullW * fullH)
  for (let y = 0; y < fullH; y++) for (let x = 0; x < fullW; x++) data[y * fullW + x] = fill(x, y)
  return { fullW, fullH, data }
}

/** GL_LINEAR with CLAMP_TO_EDGE, at normalised uv. */
function bilinear(t: Tex, u: number, v: number): number {
  const x = u * t.fullW - 0.5
  const y = v * t.fullH - 0.5
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = x - x0
  const fy = y - y0
  const at = (xi: number, yi: number) =>
    t.data[Math.min(t.fullH - 1, Math.max(0, yi)) * t.fullW + Math.min(t.fullW - 1, Math.max(0, xi))]
  return (
    at(x0, y0) * (1 - fx) * (1 - fy) + at(x0 + 1, y0) * fx * (1 - fy) + at(x0, y0 + 1) * (1 - fx) * fy + at(x0 + 1, y0 + 1) * fx * fy
  )
}

/** Mirror of DISPLAY_FRAG. Records every tap's texel-space coordinate in `taps`. */
function blit(t: Tex, srcW: number, srcH: number, vu: number, vv: number, cubic: number, taps?: [number, number][]): number {
  const rect = (px: number, py: number): [number, number] => {
    const cx = Math.min(srcW - 0.5, Math.max(0.5, px))
    const cy = Math.min(srcH - 0.5, Math.max(0.5, py))
    taps?.push([cx, cy])
    return [cx / t.fullW, cy / t.fullH]
  }
  const px = vu * srcW
  const py = vv * srcH
  if (cubic <= 0) {
    const [u, v] = rect(px, py)
    return bilinear(t, u, v)
  }
  const tc = [Math.floor(px - 0.5) + 0.5, Math.floor(py - 0.5) + 0.5]
  const f = [px - tc[0], py - tc[1]]
  const C = cubic
  const w0 = f.map((a) => -C * a * (1 - a) * (1 - a))
  const w3 = f.map((a) => -C * a * a * (1 - a))
  const w1 = f.map((a) => 1 + a * a * (C - 3 + (2 - C) * a))
  const w2 = [0, 1].map((i) => 1 - w0[i] - w1[i] - w3[i])
  const w12 = [w1[0] + w2[0], w1[1] + w2[1]]
  const t0 = rect(tc[0] - 1, tc[1] - 1)
  const t3 = rect(tc[0] + 2, tc[1] + 2)
  const t12 = rect(tc[0] + w2[0] / w12[0], tc[1] + w2[1] / w12[1])
  const cC = bilinear(t, t12[0], t12[1])
  const cL = bilinear(t, t0[0], t12[1])
  const cR = bilinear(t, t3[0], t12[1])
  const cB = bilinear(t, t12[0], t0[1])
  const cT = bilinear(t, t12[0], t3[1])
  const wC = w12[0] * w12[1]
  const wL = w0[0] * w12[1]
  const wR = w3[0] * w12[1]
  const wB = w12[0] * w0[1]
  const wT = w12[0] * w3[1]
  const c = (cC * wC + cL * wL + cR * wR + cB * wB + cT * wT) / (wC + wL + wR + wB + wT)
  const mn = Math.min(cC, cL, cR, cB, cT)
  const mx = Math.max(cC, cL, cR, cB, cT)
  return Math.max(Math.min(Math.max(c, mn), mx), 0)
}

/** Output pixel centre -> vUv, for an output `destW x destH`. */
const vuv = (i: number, n: number) => (i + 0.5) / n

describe('blitCubicFor', () => {
  it('is 0 (an exact bilinear copy) whenever the rect is not smaller than what it covers', () => {
    expect(blitCubicFor(1920, 1920, 0)).toBe(0)
    expect(blitCubicFor(2000, 1920, 0)).toBe(0)
  })

  it('is the Catmull-Rom tension for an upscale on a top tier', () => {
    for (let t = 0; t <= BLIT_CUBIC_MAX_TIER; t++) expect(blitCubicFor(1200, 1920, t)).toBe(BLIT_CUBIC_TENSION)
  })

  it('falls back to bilinear below the top tiers, so a struggling machine never pays for it', () => {
    for (let t = BLIT_CUBIC_MAX_TIER + 1; t <= 4; t++) expect(blitCubicFor(1200, 1920, t)).toBe(0)
  })

  it('is total against non-finite input', () => {
    expect(blitCubicFor(Number.NaN, 1920, 0)).toBe(0)
    expect(blitCubicFor(1200, Number.POSITIVE_INFINITY, 0)).toBe(0)
    expect(blitCubicFor(1200, 1920, Number.NaN)).toBe(0)
  })
})

describe('DISPLAY_FRAG mirror', () => {
  // Allocation bigger than the active rect, with a poison value outside it.
  const FULL_W = 40
  const FULL_H = 30
  const SRC_W = 24
  const SRC_H = 16
  const POISON = 1e6
  const tex = makeTex(FULL_W, FULL_H, (x, y) =>
    x < SRC_W && y < SRC_H ? ((x * 7 + y * 13) % 11) / 10 + (x === 12 ? 3 : 0) : POISON,
  )

  it('at 1:1 every output pixel is an exact copy of its texel, on both paths (the alignment fix)', () => {
    for (const cubic of [0, BLIT_CUBIC_TENSION]) {
      for (let y = 0; y < SRC_H; y++) {
        for (let x = 0; x < SRC_W; x++) {
          const out = blit(tex, SRC_W, SRC_H, vuv(x, SRC_W), vuv(y, SRC_H), cubic)
          // 6 places: float64 rounding in the mirror is ~1e-9, far under the
          // GPU's own float32 precision (~1e-7).
          expect(out).toBeCloseTo(tex.data[y * FULL_W + x], 6)
        }
      }
    }
  })

  it('the old mapping was not an exact copy at 1:1 — the bug this replaces', () => {
    // `vUv * (w/fullW - 0.5/fullW)`: at the right edge it lands between texels.
    const x = SRC_W - 1
    const u = vuv(x, SRC_W) * (SRC_W / FULL_W - 0.5 / FULL_W)
    const old = bilinear(tex, u, vuv(0, SRC_H) * (SRC_H / FULL_H - 0.5 / FULL_H))
    expect(Math.abs(old - tex.data[x])).toBeGreaterThan(1e-3)
  })

  it('never taps outside the active rect, so stale texels cannot bleed in', () => {
    for (const cubic of [0, BLIT_CUBIC_TENSION]) {
      const taps: [number, number][] = []
      const DW = 61
      const DH = 43
      for (let y = 0; y < DH; y++) {
        for (let x = 0; x < DW; x++) {
          const out = blit(tex, SRC_W, SRC_H, vuv(x, DW), vuv(y, DH), cubic, taps)
          expect(out).toBeLessThan(POISON / 100)
        }
      }
      for (const [tx, ty] of taps) {
        expect(tx).toBeGreaterThanOrEqual(0.5)
        expect(tx).toBeLessThanOrEqual(SRC_W - 0.5)
        expect(ty).toBeGreaterThanOrEqual(0.5)
        expect(ty).toBeLessThanOrEqual(SRC_H - 0.5)
      }
    }
  })

  it('the cubic upscale never rings past its taps or goes negative (bright line on black)', () => {
    const line = makeTex(FULL_W, FULL_H, (x, y) => (x < SRC_W && y < SRC_H ? (x === 10 ? 4 : 0) : POISON))
    for (let x = 0; x < 61; x++) {
      const out = blit(line, SRC_W, SRC_H, vuv(x, 61), 0.5, BLIT_CUBIC_TENSION)
      expect(out).toBeGreaterThanOrEqual(0)
      expect(out).toBeLessThanOrEqual(4)
    }
  })

  it('is linear, so it stays exact under the scene fade', () => {
    const k = 0.37
    const scaled = { ...tex, data: tex.data.map((v) => v * k) }
    for (let x = 0; x < 61; x += 3) {
      const a = blit(tex, SRC_W, SRC_H, vuv(x, 61), 0.4, BLIT_CUBIC_TENSION)
      const b = blit(scaled, SRC_W, SRC_H, vuv(x, 61), 0.4, BLIT_CUBIC_TENSION)
      expect(b).toBeCloseTo(a * k, 9)
    }
  })
})

describe('DISPLAY_FRAG source', () => {
  it('declares exactly the uniforms the budgeted display material provides', () => {
    const declared = [...DISPLAY_FRAG.matchAll(/uniform\s+\w+\s+(\w+);/g)].map((m) => m[1]).sort()
    expect(declared).toEqual(['uCubic', 'uScene', 'uSrcSize', 'uTexel'])
  })

  it('clamps every tap to the active rect', () => {
    expect(DISPLAY_FRAG).toMatch(/clamp\(t, vec2\(0\.5\), uSrcSize - 0\.5\) \* uTexel/)
    expect(DISPLAY_FRAG).not.toMatch(/uUvMax/)
  })
})
