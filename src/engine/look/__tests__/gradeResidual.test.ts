import { describe, expect, it } from 'vitest'
import { PALETTES } from '../../palettes'
import {
  GRADE_EASE_TAU,
  GRADE_LIMITS,
  GRADE_LUMA,
  GRADE_PIVOT,
  GRADE_TEMP_G,
  GradeResidualTracker,
  computeGradeResidual,
  gradeFamilyActive,
  gradeMath,
  paletteGradeTraits,
  type GradeLookInput,
  type GradeTriple,
  type Rgb,
} from '../gradeResidual'

// ---------------------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------------------

/** Deterministic PRNG so a failure reproduces (the codebase avoids Math.random in tests for the same reason). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const luma = (c: readonly number[]) => GRADE_LUMA[0] * c[0] + GRADE_LUMA[1] * c[1] + GRADE_LUMA[2] * c[2]
const chroma = (c: readonly number[]) => Math.max(...c) - Math.min(...c)
const isFiniteNonNeg = (c: readonly number[]) => c.every((v) => Number.isFinite(v) && v >= 0)

/** Random linear colours: a mix of in-gamut, fully saturated (a zero channel), and hot (> 1) pixels. */
function randomColours(n: number, seed = 7): Rgb[] {
  const rnd = mulberry32(seed)
  const out: Rgb[] = []
  for (let i = 0; i < n; i++) {
    const c: Rgb = [rnd(), rnd(), rnd()]
    const kind = i % 4
    if (kind === 1) c[Math.floor(rnd() * 3)] = 0 // on the gamut boundary, like a palette's pure slot
    if (kind === 2) for (let j = 0; j < 3; j++) c[j] *= 1 + rnd() * 6 // additive scenes render hot
    out.push(c)
  }
  return out
}

const look = (over: Partial<GradeLookInput> = {}): GradeLookInput => ({
  valid: true,
  families: { grade: true },
  gradeSat: 1,
  gradeTemp: 0,
  gradeContrast: 1,
  ...over,
})

/** A few of the plan's authored grade rows (sat / temp / contrast), as fixtures. */
const ROWS: Record<string, [number, number, number]> = {
  serene: [0.92, 0.1, 0.97],
  melancholic: [0.78, -0.35, 1.05],
  mysterious: [0.85, -0.3, 1.05],
  playful: [1.15, 0.25, 1],
  euphoric: [1.25, 0.2, 1.1],
  tense: [0.85, -0.2, 1.2],
  aggressive: [1.2, 0.35, 1.25],
}

const within = (g: GradeTriple) => {
  expect(g.sat).toBeGreaterThanOrEqual(GRADE_LIMITS.satMin)
  expect(g.sat).toBeLessThanOrEqual(GRADE_LIMITS.satMax)
  expect(Math.abs(g.temp)).toBeLessThanOrEqual(GRADE_LIMITS.tempMax)
  expect(g.contrast).toBeGreaterThanOrEqual(GRADE_LIMITS.contrastMin)
  expect(g.contrast).toBeLessThanOrEqual(GRADE_LIMITS.contrastMax)
}

// ---------------------------------------------------------------------------------------------------------
// gradeMath: the shader's operations
// ---------------------------------------------------------------------------------------------------------

describe('gradeMath - identity', () => {
  it('returns the input untouched at sat 1, temp 0, contrast 1 (the shader skips the stage entirely)', () => {
    for (const c of randomColours(400)) expect(gradeMath(c, 1, 0, 1)).toEqual(c)
  })

  it('may write into its own input', () => {
    const c: Rgb = [0.4, 0.2, 0.1]
    const expected = gradeMath([0.4, 0.2, 0.1], 1.2, 0.1, 1.1)
    gradeMath(c, 1.2, 0.1, 1.1, c)
    expect(c).toEqual(expected)
  })
})

describe('gradeMath - black stays black', () => {
  it('maps exactly black to exactly black for every parameter combination, in range or wildly out of it', () => {
    for (const sat of [0, 0.5, 0.75, 1, 1.25, 2, 5]) {
      for (const temp of [-0.9, -0.15, 0, 0.15, 0.9]) {
        for (const contrast of [0.3, 0.85, 1, 1.15, 3]) {
          const out = gradeMath([0, 0, 0], sat, temp, contrast)
          expect(out.every((v) => v === 0)).toBe(true)
        }
      }
    }
  })

  it('does not lift near-black: a dim palette ground stays dim under lower contrast', () => {
    // The palette grounds are #020208-ish, about 6e-4 linear. 0.85 contrast may lift them a little; it must
    // stay a few 8-bit codes, not the full-frame wash AgX produced from a negative black.
    const ground: Rgb = [0.0006, 0.0006, 0.0024]
    const out = gradeMath(ground, 1, 0, 0.85)
    expect(luma(out)).toBeLessThan(0.004)
  })
})

describe('gradeMath - saturation', () => {
  it('preserves luma exactly, above and below 1, in gamut and hot', () => {
    for (const sat of [0.75, 0.9, 1.1, 1.25]) {
      for (const c of randomColours(500, 11)) {
        const l = luma(c)
        if (l < 1e-3) continue
        const out = gradeMath(c, sat, 0, 1)
        expect(Math.abs(luma(out) - l)).toBeLessThan(1e-9 * Math.max(1, l))
      }
    }
  })

  it('desaturating scales chroma by exactly the factor (a convex mix toward the luma)', () => {
    for (const c of randomColours(200, 3)) {
      if (luma(c) < 1e-3) continue
      const out = gradeMath(c, 0.75, 0, 1)
      expect(chroma(out)).toBeCloseTo(0.75 * chroma(c), 9)
    }
  })

  it('never produces a negative channel, even for pure primaries at the maximum boost', () => {
    const pure: Rgb[] = [
      [1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0.9, 1], [1, 1, 0], [0, 1, 1], [1, 0, 1],
      [1, 0.01, 0], [0.02, 0, 1], [0, 0.3, 0.05],
    ]
    for (const sat of [1.1, GRADE_LIMITS.satMax, 2, 5]) {
      for (const c of pure) expect(isFiniteNonNeg(gradeMath(c, sat, 0, 1))).toBe(true)
    }
    // The point of the cap: an uncapped luma-mix at 1.25 hands cyan (0, .9, 1) a red of about -0.18.
    const l = luma([0, 0.9, 1])
    expect(l * (1 - 1.25) + 0 * 1.25).toBeLessThan(-0.1)
  })

  it('leaves a fully saturated pixel alone (it cannot get more saturated inside the gamut)', () => {
    for (const c of [[0, 0.9, 1], [1, 0, 0], [0, 1, 0.4]] as Rgb[]) {
      const out = gradeMath(c, 1.25, 0, 1)
      for (let i = 0; i < 3; i++) expect(out[i]).toBeCloseTo(c[i], 9)
    }
  })

  it('does boost a less-saturated pixel, up to (never past) the gamut edge', () => {
    const c: Rgb = [0.5, 0.4, 0.3]
    const out = gradeMath(c, 1.25, 0, 1)
    expect(chroma(out)).toBeGreaterThan(chroma(c))
    expect(Math.min(...out)).toBeGreaterThanOrEqual(0)
  })

  it('keeps hue: channels move along the ray from the grey axis, so their ordering never flips', () => {
    for (const sat of [0.75, 1.25]) {
      for (const c of randomColours(300, 5)) {
        if (luma(c) < 1e-3) continue
        const out = gradeMath(c, sat, 0, 1)
        const order = (x: readonly number[]) => [0, 1, 2].sort((a, b) => x[a] - x[b] || a - b).join()
        // Ties can reorder by rounding, so only assert when the input channels are clearly apart.
        if (chroma(c) > 1e-3 && Math.min(Math.abs(c[0] - c[1]), Math.abs(c[1] - c[2]), Math.abs(c[0] - c[2])) > 1e-3) {
          expect(order(out)).toBe(order(c))
        }
      }
    }
  })

  it('is scale-covariant: grading a scaled pixel equals scaling the graded pixel (why its order vs the gain is free)', () => {
    for (const c of randomColours(200, 9)) {
      if (luma(c) < 0.05) continue
      for (const k of [0.01, 0.5, 4, 50]) {
        const a = gradeMath([c[0] * k, c[1] * k, c[2] * k], 1.25, 0.1, 1)
        const b = gradeMath(c, 1.25, 0.1, 1)
        for (let i = 0; i < 3; i++) expect(a[i]).toBeCloseTo(b[i] * k, 8)
      }
    }
  })
})

describe('gradeMath - temperature', () => {
  it('warm raises red and lowers blue, cool does the reverse', () => {
    const c: Rgb = [0.4, 0.4, 0.4]
    const warm = gradeMath(c, 1, 0.15, 1)
    const cool = gradeMath(c, 1, -0.15, 1)
    expect(warm[0]).toBeGreaterThan(c[0])
    expect(warm[2]).toBeLessThan(c[2])
    expect(cool[0]).toBeLessThan(c[0])
    expect(cool[2]).toBeGreaterThan(c[2])
  })

  it('is monotone per channel in t: red rises, blue falls, as t increases', () => {
    const c: Rgb = [0.3, 0.5, 0.2]
    let prev = gradeMath(c, 1, -0.15, 1)
    for (let t = -0.14; t <= 0.15001; t += 0.01) {
      const cur = gradeMath(c, 1, t, 1)
      expect(cur[0]).toBeGreaterThan(prev[0])
      expect(cur[2]).toBeLessThan(prev[2])
      prev = cur
    }
  })

  it('keeps a neutral grey at the same luma (the servo is not asked to answer a colour cast)', () => {
    for (const g of [0.001, 0.05, 0.18, 0.5, 1, 4]) {
      for (const t of [-0.15, -0.05, 0.05, 0.15]) {
        const out = gradeMath([g, g, g], 1, t, 1)
        expect(Math.abs(luma(out) - g)).toBeLessThan(2e-5 * g)
      }
    }
  })

  it('uses strictly positive gains, so no channel can go negative (checked well past the clamp)', () => {
    for (const t of [-0.9, -0.15, 0.15, 0.9]) {
      expect(1 + t).toBeGreaterThan(0)
      expect(1 - GRADE_TEMP_G * t).toBeGreaterThan(0)
      expect(1 - t).toBeGreaterThan(0)
      for (const c of randomColours(100, 2)) expect(isFiniteNonNeg(gradeMath(c, 1, t, 1))).toBe(true)
    }
  })
})

describe('gradeMath - contrast', () => {
  it('leaves the pivot fixed and pushes away from it above 1 (brighter above, darker below)', () => {
    const pivot = gradeMath([GRADE_PIVOT, GRADE_PIVOT, GRADE_PIVOT], 1, 0, 1.15)
    for (const v of pivot) expect(v).toBeCloseTo(GRADE_PIVOT, 9)

    const above = gradeMath([0.5, 0.5, 0.5], 1, 0, 1.15)
    const below = gradeMath([0.05, 0.05, 0.05], 1, 0, 1.15)
    expect(above[0]).toBeGreaterThan(0.5)
    expect(below[0]).toBeLessThan(0.05)
  })

  it('pulls toward the pivot below 1 (darks lift, brights fall)', () => {
    expect(gradeMath([0.5, 0.5, 0.5], 1, 0, 0.85)[0]).toBeLessThan(0.5)
    expect(gradeMath([0.05, 0.05, 0.05], 1, 0, 0.85)[0]).toBeGreaterThan(0.05)
  })

  it('makes the output luma exactly pivot * (luma / pivot)^k for any colour', () => {
    for (const k of [0.85, 1.05, 1.15]) {
      for (const c of randomColours(300, 13)) {
        const l = luma(c)
        if (l < 1e-4) continue
        const out = gradeMath(c, 1, 0, k)
        const want = GRADE_PIVOT * Math.pow(l / GRADE_PIVOT, k)
        expect(Math.abs(luma(out) - want)).toBeLessThan(1e-9 * Math.max(1, want))
      }
    }
  })

  it('does not touch hue or saturation: RGB scales together, so channel ratios are unchanged', () => {
    for (const c of randomColours(200, 17)) {
      const l = luma(c)
      if (l < 1e-3) continue
      const out = gradeMath(c, 1, 0, 1.15)
      const f = luma(out) / l // the single ratio contrast applied
      for (let i = 0; i < 3; i++) expect(out[i]).toBeCloseTo(c[i] * f, 8)
      // and the saturation measure (chroma / max) is identical
      expect(chroma(out) / Math.max(...out)).toBeCloseTo(chroma(c) / Math.max(...c), 9)
    }
  })

  it('is orthogonal to saturation: saturation leaves luma alone, so contrast sees the same input either way', () => {
    for (const c of randomColours(150, 19)) {
      if (luma(c) < 1e-3) continue
      const lumaOfSatFirst = luma(gradeMath(c, 1.2, 0, 1))
      expect(Math.abs(lumaOfSatFirst - luma(c))).toBeLessThan(1e-9 * Math.max(1, luma(c)))
    }
  })
})

describe('gradeMath - monotonicity and range safety', () => {
  const combos: [number, number, number][] = []
  for (const sat of [0.75, 1, 1.25]) for (const temp of [-0.15, 0, 0.15]) for (const contrast of [0.85, 1, 1.15]) combos.push([sat, temp, contrast])

  it('output luma never decreases as a pixel is scaled up (no inversion of the tone order)', () => {
    for (const [sat, temp, contrast] of combos) {
      for (const c of randomColours(60, 23)) {
        if (luma(c) < 0.01) continue
        let prev = -1
        for (let k = 0.001; k < 200; k *= 1.5) {
          const l = luma(gradeMath([c[0] * k, c[1] * k, c[2] * k], sat, temp, contrast))
          // luma(c*k) >= 1e-5 always here; the eps guards only bite below that
          expect(l).toBeGreaterThanOrEqual(prev - 1e-12)
          prev = l
        }
      }
    }
  })

  it('raising contrast above the pivot brightens and below it darkens, monotonically', () => {
    const hi: Rgb = [0.7, 0.7, 0.7]
    const lo: Rgb = [0.06, 0.06, 0.06]
    let prevHi = gradeMath(hi, 1, 0, 0.85)[0]
    let prevLo = gradeMath(lo, 1, 0, 0.85)[0]
    for (let k = 0.86; k <= 1.15001; k += 0.01) {
      const h = gradeMath(hi, 1, 0, k)[0]
      const l = gradeMath(lo, 1, 0, k)[0]
      expect(h).toBeGreaterThan(prevHi)
      expect(l).toBeLessThan(prevLo)
      prevHi = h
      prevLo = l
    }
  })

  it('produces no NaN, Infinity or negative for any input in range at any corner of the limits', () => {
    const levels = [0, 1e-12, 1e-6, 1e-3, GRADE_PIVOT, 0.5, 1, 10, 1e3, 1e4]
    for (const [sat, temp, contrast] of combos) {
      for (const r of levels) {
        for (const g of levels) {
          for (const b of levels) {
            const out = gradeMath([r, g, b], sat, temp, contrast)
            expect(isFiniteNonNeg(out)).toBe(true)
          }
        }
      }
    }
  })

  it('stays finite and non-negative at the limits for random hot and boundary colours', () => {
    for (const c of randomColours(2000, 29)) {
      const out = gradeMath(c, GRADE_LIMITS.satMax, GRADE_LIMITS.tempMax, GRADE_LIMITS.contrastMax)
      expect(isFiniteNonNeg(out)).toBe(true)
      const out2 = gradeMath(c, GRADE_LIMITS.satMin, -GRADE_LIMITS.tempMax, GRADE_LIMITS.contrastMin)
      expect(isFiniteNonNeg(out2)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------------------------------------
// what a palette carries
// ---------------------------------------------------------------------------------------------------------

describe('paletteGradeTraits', () => {
  it('is finite and in range for every palette in the roster', () => {
    for (const p of PALETTES) {
      const t = paletteGradeTraits(p.id)
      expect(t.sat).toBeGreaterThanOrEqual(0)
      expect(t.sat).toBeLessThanOrEqual(1)
      expect(t.warmth).toBeGreaterThanOrEqual(-1)
      expect(t.warmth).toBeLessThanOrEqual(1)
      expect(t.range).toBeGreaterThanOrEqual(0)
      expect(t.range).toBeLessThanOrEqual(1)
    }
  })

  it('reads warm palettes as warm, cool as cool, and monochrome ones as drab and neutral', () => {
    expect(paletteGradeTraits('ember').warmth).toBeGreaterThan(0.5)
    expect(paletteGradeTraits('solar').warmth).toBeGreaterThan(0.5)
    expect(paletteGradeTraits('ocean').warmth).toBeLessThan(-0.5)
    expect(paletteGradeTraits('aurora').warmth).toBeLessThan(-0.5)
    for (const id of ['mono', 'pearl']) {
      const t = paletteGradeTraits(id)
      expect(t.sat).toBeLessThan(0.2)
      expect(Math.abs(t.warmth)).toBeLessThan(0.15)
    }
    expect(paletteGradeTraits('ocean').sat).toBeGreaterThan(paletteGradeTraits('sage').sat)
  })

  it('is cached, and an unknown id falls back to the roster head like getPalette', () => {
    expect(paletteGradeTraits('ember')).toBe(paletteGradeTraits('ember'))
    expect(paletteGradeTraits('no-such-palette')).toBe(paletteGradeTraits(PALETTES[0].id))
  })
})

// ---------------------------------------------------------------------------------------------------------
// the residual
// ---------------------------------------------------------------------------------------------------------

describe('computeGradeResidual', () => {
  it('applies nothing for a neutral mood, on any palette (palette identity is left alone)', () => {
    for (const p of PALETTES) {
      const g = computeGradeResidual(1, 0, 1, paletteGradeTraits(p.id))
      expect(g).toEqual({ sat: 1, temp: 0, contrast: 1 })
    }
  })

  it('stays within +-25% saturation, +-15% temperature and +-15% contrast for every mood row on every palette', () => {
    for (const p of PALETTES) {
      const traits = paletteGradeTraits(p.id)
      for (const [s, t, c] of Object.values(ROWS)) within(computeGradeResidual(s, t, c, traits))
    }
  })

  it('holds the clamps for absurd targets, and reads a non-finite target as neutral', () => {
    for (const p of PALETTES) {
      const traits = paletteGradeTraits(p.id)
      for (const v of [-50, -1, 0, 5, 50]) within(computeGradeResidual(v, v, v, traits))
      for (const bad of [NaN, Infinity, -Infinity]) {
        expect(computeGradeResidual(bad, bad, bad, traits)).toEqual({ sat: 1, temp: 0, contrast: 1 })
      }
    }
    // The extremes really do reach the clamps (they are not just vacuously inside them).
    const neutral = paletteGradeTraits('pearl')
    expect(computeGradeResidual(9, 9, 9, neutral)).toEqual({ sat: GRADE_LIMITS.satMax, temp: GRADE_LIMITS.tempMax, contrast: GRADE_LIMITS.contrastMax })
    expect(computeGradeResidual(-9, -9, -9, paletteGradeTraits('ember')).temp).toBe(-GRADE_LIMITS.tempMax)
    expect(computeGradeResidual(0, 0, 0, neutral).sat).toBe(GRADE_LIMITS.satMin)
    expect(computeGradeResidual(0, 0, 0, neutral).contrast).toBe(GRADE_LIMITS.contrastMin)
  })

  it('never overshoots or inverts the mood: |residual| <= |target| and the sign is kept', () => {
    for (const p of PALETTES) {
      const traits = paletteGradeTraits(p.id)
      for (const target of [0.8, 0.9, 1.1, 1.2]) {
        const g = computeGradeResidual(target, 0, target, traits)
        for (const got of [g.sat, g.contrast]) {
          // Inside the clamps the ask is the ceiling; the clamps can only shrink it further.
          expect(Math.abs(got - 1)).toBeLessThanOrEqual(Math.abs(target - 1) + 1e-12)
          expect((got - 1) * (target - 1)).toBeGreaterThanOrEqual(0)
        }
      }
      for (const t of [-0.35, -0.1, 0.1, 0.35]) {
        const g = computeGradeResidual(1, t, 1, traits)
        expect(Math.abs(g.temp)).toBeLessThanOrEqual(Math.abs(t) * 0.43 + 1e-12)
        expect(g.temp * t).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('does not double-count warmth: a warm palette needs less warm grade than a cool one', () => {
    const warm = computeGradeResidual(1, 0.3, 1, paletteGradeTraits('ember')).temp
    const cool = computeGradeResidual(1, 0.3, 1, paletteGradeTraits('ocean')).temp
    const neutral = computeGradeResidual(1, 0.3, 1, paletteGradeTraits('pearl')).temp
    expect(warm).toBeGreaterThanOrEqual(0)
    expect(warm).toBeLessThan(cool)
    // A palette leaning the OTHER way gets the full ask, not ask + its lean.
    expect(cool).toBeCloseTo(neutral, 6)
    expect(cool).toBeCloseTo(0.3 * 0.43, 6)
    // and the mirror image: a cool mood on a cool palette is mostly already there.
    const coolOnCool = computeGradeResidual(1, -0.3, 1, paletteGradeTraits('ocean')).temp
    const coolOnWarm = computeGradeResidual(1, -0.3, 1, paletteGradeTraits('ember')).temp
    expect(Math.abs(coolOnCool)).toBeLessThan(Math.abs(coolOnWarm))
  })

  it('does not double-count saturation: a vivid palette needs less boost, a drab one needs less cut', () => {
    const boostOnVivid = computeGradeResidual(1.2, 0, 1, paletteGradeTraits('ocean')).sat
    const boostOnDrab = computeGradeResidual(1.2, 0, 1, paletteGradeTraits('pearl')).sat
    expect(boostOnVivid).toBeLessThan(boostOnDrab)
    expect(boostOnDrab).toBeCloseTo(1.2, 6)

    const cutOnVivid = computeGradeResidual(0.78, 0, 1, paletteGradeTraits('aurora')).sat
    const cutOnDrab = computeGradeResidual(0.78, 0, 1, paletteGradeTraits('pearl')).sat
    expect(cutOnDrab).toBeGreaterThan(cutOnVivid)
    expect(cutOnVivid).toBeCloseTo(0.78, 6)
  })

  it('does not double-count contrast: a palette with a hot glow over a darker body carries some of it', () => {
    const punchy = computeGradeResidual(1, 0, 1.12, paletteGradeTraits('glacial')).contrast
    const flat = computeGradeResidual(1, 0, 1.12, paletteGradeTraits('violet')).contrast
    expect(punchy).toBeLessThan(flat)
    expect(flat).toBeCloseTo(1.12, 6)
  })

  it('reuses a caller-supplied output object', () => {
    const out: GradeTriple = { sat: 9, temp: 9, contrast: 9 }
    const ret = computeGradeResidual(1.1, 0.2, 1.1, paletteGradeTraits('pearl'), out)
    expect(ret).toBe(out)
    within(out)
  })
})

// ---------------------------------------------------------------------------------------------------------
// the tracker: gating and easing
// ---------------------------------------------------------------------------------------------------------

const DT = 1 / 60
function run(tr: GradeResidualTracker, lk: GradeLookInput, palette: string, seconds: number, dt = DT): void {
  const n = Math.round(seconds / dt)
  for (let i = 0; i < n; i++) tr.update(lk, palette, dt)
}
const STRONG = look({ gradeSat: 1.25, gradeTemp: 0.35, gradeContrast: 1.25 })

describe('gradeFamilyActive', () => {
  it('needs a valid look AND the grade family on', () => {
    expect(gradeFamilyActive(look())).toBe(true)
    expect(gradeFamilyActive(look({ valid: false }))).toBe(false)
    expect(gradeFamilyActive(look({ families: { grade: false } }))).toBe(false)
    expect(gradeFamilyActive(look({ valid: false, families: { grade: false } }))).toBe(false)
  })
})

describe('GradeResidualTracker - gating', () => {
  it('starts at exact identity', () => {
    const tr = new GradeResidualTracker()
    expect([tr.sat, tr.temp, tr.contrast]).toEqual([1, 0, 1])
  })

  it('stays at EXACT identity while the look is invalid, whatever the row says', () => {
    const tr = new GradeResidualTracker()
    run(tr, { ...STRONG, valid: false }, 'ember', 30)
    expect(tr.sat).toBe(1)
    expect(tr.temp).toBe(0)
    expect(tr.contrast).toBe(1)
  })

  it('stays at exact identity while families.grade is off', () => {
    const tr = new GradeResidualTracker()
    run(tr, { ...STRONG, families: { grade: false } }, 'pearl', 30)
    expect([tr.sat, tr.temp, tr.contrast]).toEqual([1, 0, 1])
  })

  it('reaches the residual once active, and never leaves the clamps on the way', () => {
    const tr = new GradeResidualTracker()
    const want = computeGradeResidual(1.25, 0.35, 1.25, paletteGradeTraits('pearl'))
    for (let i = 0; i < 60 * 6; i++) {
      tr.update(STRONG, 'pearl', DT)
      within({ sat: tr.sat, temp: tr.temp, contrast: tr.contrast })
    }
    expect(tr.sat).toBeCloseTo(want.sat, 6)
    expect(tr.temp).toBeCloseTo(want.temp, 6)
    expect(tr.contrast).toBeCloseTo(want.contrast, 6)
  })

  it('eases back out to EXACT identity when the look goes invalid, without stepping', () => {
    const tr = new GradeResidualTracker()
    run(tr, STRONG, 'pearl', 6)
    const before = { sat: tr.sat, temp: tr.temp, contrast: tr.contrast }
    tr.update({ ...STRONG, valid: false }, 'pearl', DT)
    expect(Math.abs(tr.temp - before.temp)).toBeLessThan(0.05 * Math.abs(before.temp))
    run(tr, { ...STRONG, valid: false }, 'pearl', 0.3)
    expect(tr.temp).toBeGreaterThan(0.3 * before.temp) // still most of the way there after 0.3 s
    run(tr, { ...STRONG, valid: false }, 'pearl', 8)
    expect([tr.sat, tr.temp, tr.contrast]).toEqual([1, 0, 1])
  })

  it('never produces a NaN, from a garbage look or a garbage dt', () => {
    const tr = new GradeResidualTracker()
    run(tr, look({ gradeSat: NaN, gradeTemp: Infinity, gradeContrast: -Infinity }), 'ember', 5)
    expect([tr.sat, tr.temp, tr.contrast]).toEqual([1, 0, 1])
    run(tr, STRONG, 'ember', 6)
    const held = { sat: tr.sat, temp: tr.temp, contrast: tr.contrast }
    for (const dt of [NaN, -1, 0]) tr.update(look({ gradeSat: 0.8, gradeTemp: -0.3, gradeContrast: 1 }), 'ocean', dt)
    expect(tr.sat).toBe(held.sat)
    expect(tr.temp).toBe(held.temp)
    expect(tr.contrast).toBe(held.contrast)
    tr.update(look({ gradeSat: 0.8, gradeTemp: -0.3, gradeContrast: 1 }), 'nonexistent-palette', 1e6)
    expect(Number.isFinite(tr.sat + tr.temp + tr.contrast)).toBe(true)
  })

  it('settles in one step on a huge dt (a backgrounded tab resuming) rather than misbehaving', () => {
    const tr = new GradeResidualTracker()
    tr.update(STRONG, 'pearl', 1e6)
    const want = computeGradeResidual(1.25, 0.35, 1.25, paletteGradeTraits('pearl'))
    expect([tr.sat, tr.temp, tr.contrast]).toEqual([want.sat, want.temp, want.contrast])
  })

  it('reset() returns to identity', () => {
    const tr = new GradeResidualTracker()
    run(tr, STRONG, 'pearl', 6)
    tr.reset()
    expect([tr.sat, tr.temp, tr.contrast]).toEqual([1, 0, 1])
  })
})

describe('GradeResidualTracker - easing (no pop)', () => {
  it('takes about 2 s: barely started at 0.1 s, >= 95% at 2 s, done by 3.5 s', () => {
    expect(GRADE_EASE_TAU).toBeGreaterThan(0.4)
    expect(GRADE_EASE_TAU).toBeLessThan(0.8)
    const want = computeGradeResidual(1.25, 0.35, 1.25, paletteGradeTraits('pearl'))
    const progress = (tr: GradeResidualTracker) => (tr.temp - 0) / (want.temp - 0)

    const tr = new GradeResidualTracker()
    run(tr, STRONG, 'pearl', 0.1)
    expect(progress(tr)).toBeLessThan(0.2)
    run(tr, STRONG, 'pearl', 1.9)
    expect(progress(tr)).toBeGreaterThan(0.95)
    run(tr, STRONG, 'pearl', 1.5)
    expect(progress(tr)).toBeGreaterThan(0.99)
  })

  it('does not step when the palette changes: every channel moves in small increments to its new value', () => {
    const lk = look({ gradeSat: 1.2, gradeTemp: 0.3, gradeContrast: 1.12 })
    const pairs: [string, string][] = [['ember', 'ocean'], ['pearl', 'aurora'], ['violet', 'glacial'], ['ocean', 'ember']]
    for (const [from, to] of pairs) {
      const tr = new GradeResidualTracker()
      run(tr, lk, from, 8)
      const start = [tr.sat, tr.temp, tr.contrast]
      const end = computeGradeResidual(lk.gradeSat, lk.gradeTemp, lk.gradeContrast, paletteGradeTraits(to))
      const swing = [end.sat - start[0], end.temp - start[1], end.contrast - start[2]]
      const maxStep = [0, 0, 0]
      let prev = start
      for (let i = 0; i < 60 * 8; i++) {
        tr.update(lk, to, DT)
        const cur = [tr.sat, tr.temp, tr.contrast]
        for (let c = 0; c < 3; c++) maxStep[c] = Math.max(maxStep[c], Math.abs(cur[c] - prev[c]))
        prev = cur
      }
      for (let c = 0; c < 3; c++) {
        if (Math.abs(swing[c]) < 0.01) continue // this pair barely moves this channel
        // Exponential ease at 60 fps: the first step is 1 - exp(-1/60/tau) ~ 2.7% of the swing, and the swing is
        // never crossed in one frame.
        expect(maxStep[c]).toBeLessThanOrEqual(0.035 * Math.abs(swing[c]))
      }
      expect(tr.sat).toBeCloseTo(end.sat, 6)
      expect(tr.temp).toBeCloseTo(end.temp, 6)
      expect(tr.contrast).toBeCloseTo(end.contrast, 6)
    }
  })

  it('is frame-rate independent: the same wall-clock time gives the same progress at 30 and 144 fps', () => {
    const a = new GradeResidualTracker()
    const b = new GradeResidualTracker()
    run(a, STRONG, 'pearl', 1.2, 1 / 30)
    run(b, STRONG, 'pearl', 1.2, 1 / 144)
    expect(a.temp).toBeCloseTo(b.temp, 3)
    expect(a.sat).toBeCloseTo(b.sat, 3)
  })
})
