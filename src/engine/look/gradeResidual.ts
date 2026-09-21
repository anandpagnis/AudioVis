import { getPalette, type Palette } from '../palettes'
import type { LookFamilies, LookProfile } from './lookRow'

/**
 * The mood colour grade, as pure arithmetic: WHAT to apply (the residual against the palette) and a
 * JS mirror of HOW the shader applies it (`gradeMath`). No GL, no store, no per-frame allocation.
 *
 * `GradePass.ts` runs the GLSL; `PostFXChain.tsx` feeds it from a {@link GradeResidualTracker}. Everything
 * the shader and the tests must agree on (luma weights, pivot, guards) is exported from here and
 * interpolated into the shader source, so the two cannot drift apart silently.
 *
 * ## Why a residual, not the mood's grade
 *
 * A mood row says "euphoric is +25% saturated and warm". But the palette on screen was itself picked by
 * character fit, so it usually ALREADY carries part of that: an Ember palette is saturated and warm before
 * any grade touches it. Applying the row's full grade on top would count the same warmth twice and push the
 * frame into a cartoon. So the grade to apply is the mood's target minus what the palette carries.
 *
 * The credit is ONE-SIDED, on purpose. Subtracting the palette's raw deviation (`target - carried`) also
 * works out to "desaturate a vivid palette whenever the mood is merely neutral", which is the grade quietly
 * flattening every palette toward the roster average and fighting exactly the identity the palette exists to
 * give. Instead the palette may only REDUCE the push the mood asks for, never invert or overshoot it:
 *
 *  - a neutral mood (sat 1, temp 0, contrast 1) applies nothing on any palette;
 *  - a palette that already leans the mood's way is credited, up to the size of the ask;
 *  - a palette that leans the OTHER way gets the full ask (not ask + its lean), still bounded by the clamps;
 *  - the residual never has a larger magnitude than the mood's own target, before clamping.
 *
 * What a palette "carries" is read off its three lit slots (mid / accent / glow, weights .5/.3/.2, the same
 * convention as `paletteCharacter.ts`, which derives the palette's character from these very colours):
 * saturation (HSV), warmth (chroma-weighted lean along the same orange-to-azure axis paletteCharacter uses)
 * and luminance range (a hot glow over a darker body reads punchier than three slots of equal brightness).
 * The gains that convert those into grade units are art-direction hypotheses, calibrated so the roster's
 * extremes (Pearl / Monolith at the drab end, Ocean / Aurora / Ember at the vivid end) carry roughly
 * the same size of deviation as the mood rows do. Tune them by eye.
 *
 * ## Bounded, and eased
 *
 * The result is clamped bold-but-bounded ({@link GRADE_LIMITS}: +-25% saturation, +-15% temperature, +-15%
 * contrast) and eased over ~2 s ({@link GRADE_EASE_TAU}), so a palette switch (whose carried values jump the
 * instant the id changes) or a look going valid / invalid never pops. The mood target arriving from
 * `LookProfileTracker` is already slow (~6 s); this is a second, shorter stage, and it is the one that owns
 * palette-change and on/off transitions.
 */

// ---------------------------------------------------------------------------------------------------------
// Shared with the shader
// ---------------------------------------------------------------------------------------------------------

/** Rec. 709 luma weights in linear light. Same coefficients as `exposure.ts`, so "luma" means one thing. */
export const GRADE_LUMA = [0.2126, 0.7152, 0.0722] as const
/** Mid-grey pivot of the contrast curve, in LINEAR light (about 0.46 after the sRGB encode). */
export const GRADE_PIVOT = 0.18
/**
 * Green compensation for the temperature gains `(1 + t, 1 - GRADE_TEMP_G * t, 1 - t)`. Solving
 * `Lr(1+t) + Lg*gG + Lb(1-t) = 1` gives `gG = 1 - t * (Lr - Lb) / Lg` = `1 - 0.19631 t`, which is what makes a
 * neutral grey keep its luma under any tint (a warm cast should not also be a brightness change the exposure
 * servo has to answer).
 */
export const GRADE_TEMP_G = 0.19631
/** Floor on `luma - min(channel)` in the saturation cap's divisor. */
export const GRADE_SAT_EPS = 1e-5
/** Below this luma the contrast stage maps to exactly 0 (black stays black; also keeps the pow argument > 0). */
export const GRADE_LUMA_EPS = 1e-6

/** Design clamps on the grade actually applied. `GradePass` enforces the same numbers before the GPU. */
export const GRADE_LIMITS = {
  satMin: 0.75,
  satMax: 1.25,
  /** The uniform is the R-gain offset: R x (1 + t), B x (1 - t), G compensated. */
  tempMax: 0.15,
  contrastMin: 0.85,
  contrastMax: 1.15,
} as const

/** Values this close to identity are snapped to it, so the shader's identity branch can switch the stage off. */
export const GRADE_SNAP = { sat: 0.002, temp: 0.0015, contrast: 0.002 } as const

// ---------------------------------------------------------------------------------------------------------
// gradeMath: the shader's operations, in JS
// ---------------------------------------------------------------------------------------------------------

export type Rgb = [number, number, number]

/**
 * The grade exactly as `GradePass`'s `moodGrade()` does it, for one linear-light pixel.
 *
 *  1. TEMPERATURE: per-channel gain `(1 + t, 1 - 0.19631 t, 1 - t)`. Strictly positive for |t| < 1, so it can
 *     only scale a non-negative channel to a non-negative one, and black is untouched.
 *  2. SATURATION: `mix(vec3(l), c, s)` with `l` the Rec. 709 luma, so luma is preserved exactly. The strength
 *     is capped per pixel at `l / (l - min(c))`, the largest boost before the smallest channel would cross
 *     zero: a fully saturated pixel (a palette's pure lit slot) gets no boost, because inside the gamut it
 *     CANNOT be more saturated, instead of being handed a negative channel. That is the AgX failure mode from
 *     GradePass's header in its saturation form. Desaturation is a convex combination, so it is always safe.
 *  3. CONTRAST: a power curve on LUMA about the pivot, applied as a ratio (`c *= f(l) / l`). RGB scales
 *     together, so hue AND saturation are untouched (contrast does not leak into the saturation control) and
 *     the output luma is exactly `pivot * (l / pivot)^k`. Below {@link GRADE_LUMA_EPS} the result is exactly 0.
 *  4. A final `max(c, 0)`: a rounding guard only, never the mechanism.
 *
 * At identity (sat 1, temp 0, contrast 1) the input is returned untouched, like the shader's uniform branch.
 * This function does not clamp its parameters: `GradePass` does that before a value reaches the GPU.
 * `out` may alias `rgb`.
 */
export function gradeMath(rgb: readonly [number, number, number], sat: number, temp: number, contrast: number, out: Rgb = [0, 0, 0]): Rgb {
  let r = rgb[0]
  let g = rgb[1]
  let b = rgb[2]
  if (sat === 1 && temp === 0 && contrast === 1) {
    out[0] = r
    out[1] = g
    out[2] = b
    return out
  }
  const [lr, lg, lb] = GRADE_LUMA
  if (temp !== 0) {
    r *= 1 + temp
    g *= 1 - GRADE_TEMP_G * temp
    b *= 1 - temp
  }
  if (sat !== 1) {
    const l = lr * r + lg * g + lb * b
    const headroom = l - Math.min(r, g, b)
    const s = Math.min(sat, l / Math.max(headroom, GRADE_SAT_EPS))
    r = l * (1 - s) + r * s
    g = l * (1 - s) + g * s
    b = l * (1 - s) + b * s
  }
  if (contrast !== 1) {
    const l = lr * r + lg * g + lb * b
    const lc = Math.max(l, GRADE_LUMA_EPS)
    const shaped = Math.pow(lc / GRADE_PIVOT, contrast) * GRADE_PIVOT
    const f = l < GRADE_LUMA_EPS ? 0 : shaped / lc
    r *= f
    g *= f
    b *= f
  }
  out[0] = Math.max(r, 0)
  out[1] = Math.max(g, 0)
  out[2] = Math.max(b, 0)
  return out
}

// ---------------------------------------------------------------------------------------------------------
// What a palette already carries
// ---------------------------------------------------------------------------------------------------------

export interface PaletteGradeTraits {
  /** Weighted mean HSV saturation of the lit slots, 0..1. */
  sat: number
  /** Chroma-weighted lean along the warm (orange, +1) to cool (azure, -1) axis; 0 = neutral or desaturated. */
  warmth: number
  /** Spread of linear relative luminance across the lit slots, 0..1. */
  range: number
}

/** Lit-slot weights: the body colour dominates, the highlight matters least (same as `paletteCharacter.ts`). */
const LIT_WEIGHTS = [0.5, 0.3, 0.2] as const
const rad = (deg: number) => (deg * Math.PI) / 180

interface Hsv {
  h: number
  s: number
  r: number
  g: number
  b: number
}

/** `#rrggbb` / `#rgb` to HSV plus the sRGB channels. Anything unparseable reads as black, never throws. */
function parseHex(hex: string): Hsv {
  const t = hex.trim().replace(/^#/, '')
  const full = /^[0-9a-f]{3}$/i.test(t) ? t[0] + t[0] + t[1] + t[1] + t[2] + t[2] : t
  const n = /^[0-9a-f]{6}$/i.test(full) ? parseInt(full, 16) : 0
  const r = ((n >> 16) & 255) / 255
  const g = ((n >> 8) & 255) / 255
  const b = (n & 255) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  if (d > 1e-9) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  return { h, s: max > 1e-9 ? d / max : 0, r, g, b }
}

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))

function computeTraits(p: Palette): PaletteGradeTraits {
  const lit = [p.slots.mid, p.slots.accent, p.slots.glow].map(parseHex)
  let sat = 0
  let warmth = 0
  let lo = Infinity
  let hi = -Infinity
  lit.forEach((c, i) => {
    const w = LIT_WEIGHTS[i]
    sat += w * c.s
    // Same warm axis as paletteCharacter.ts (peaks at orange, 25 degrees), but signed and chroma-weighted so a
    // desaturated slot has no lean either way.
    warmth += w * c.s * Math.cos(rad(c.h - 25))
    const lum = 0.2126 * srgbToLinear(c.r) + 0.7152 * srgbToLinear(c.g) + 0.0722 * srgbToLinear(c.b)
    lo = Math.min(lo, lum)
    hi = Math.max(hi, lum)
  })
  return {
    sat: Math.min(1, Math.max(0, sat)),
    warmth: Math.min(1, Math.max(-1, warmth)),
    range: Math.min(1, Math.max(0, hi - lo)),
  }
}

const traitCache = new Map<string, PaletteGradeTraits>()

/**
 * Colour-derived grade traits of a palette (cached per id, so a per-frame call is a Map lookup). An unknown
 * id resolves through `getPalette`'s fallback, the palette the scenes actually render with.
 */
export function paletteGradeTraits(paletteId: string): PaletteGradeTraits {
  // A known id hits on the first lookup, so the per-frame call is one Map read. An unknown id is deliberately
  // NOT cached under its own name (a palette registered later with that id must not be shadowed by the
  // fallback's traits), so it pays the `getPalette` scan; that is the rare path.
  const hit = traitCache.get(paletteId)
  if (hit) return hit
  const p = getPalette(paletteId)
  const t = traitCache.get(p.id) ?? computeTraits(p)
  traitCache.set(p.id, t)
  return t
}

// ---------------------------------------------------------------------------------------------------------
// Residual
// ---------------------------------------------------------------------------------------------------------

/** The roster's median saturation (0.615 measured over the 30 palettes) reads as "carries nothing". */
const SAT_REF = 0.6
/** Saturation deviation carried per unit of palette saturation: Pearl (0.09) ~ -0.26, Ocean (0.96) ~ +0.18. */
const SAT_PER_UNIT = 0.5
/** Row temperature units carried per unit of palette warmth: Ember (+0.85) ~ +0.34, Ocean (-0.93) ~ -0.37. */
const WARM_TO_TEMP = 0.4
/** Median luminance range of the roster (0.609). */
const RANGE_REF = 0.6
/** Contrast deviation carried per unit of luminance range. Deliberately small. */
const CONTRAST_PER_UNIT = 0.25
/** Row temperature units (-1..+1; the rows use up to +-0.35) to the temperature uniform. 0.35 -> 0.15. */
const TEMP_UNIT_TO_GAIN = 0.43

export interface GradeTriple {
  /** Saturation multiplier, 1 = unchanged. */
  sat: number
  /** R-gain offset, 0 = unchanged; + warm, - cool. */
  temp: number
  /** Contrast exponent about the pivot, 1 = unchanged. */
  contrast: number
}

const finiteOr = (x: number, fallback: number) => (Number.isFinite(x) ? x : fallback)
const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x)
/** Collapse -0 to 0 so callers can compare with `===` / `toBe`. */
const noNegZero = (x: number) => (x === 0 ? 0 : x)

/**
 * The one-sided credit (see the header): the palette's carried deviation may reduce the ask only when it
 * points the same way, and never by more than the ask.
 */
function residualDeviation(targetDev: number, carriedDev: number): number {
  if (targetDev === 0) return 0
  const dir = targetDev > 0 ? 1 : -1
  const credit = Math.min(Math.abs(targetDev), Math.max(0, carriedDev * dir))
  return targetDev - dir * credit
}

/**
 * The grade to APPLY for a mood target on a palette with these traits, clamped to {@link GRADE_LIMITS}.
 * Unsmoothed and stateless. A non-finite target component reads as neutral.
 *
 * `targetTemp` is in the rows' units (-1 cool .. +1 warm) and is scaled to the temperature uniform here.
 */
export function computeGradeResidual(
  targetSat: number,
  targetTemp: number,
  targetContrast: number,
  traits: PaletteGradeTraits,
  out: GradeTriple = { sat: 1, temp: 0, contrast: 1 },
): GradeTriple {
  const satDev = residualDeviation(finiteOr(targetSat, 1) - 1, SAT_PER_UNIT * (traits.sat - SAT_REF))
  out.sat = noNegZero(clamp(1 + satDev, GRADE_LIMITS.satMin, GRADE_LIMITS.satMax))

  const tempUnits = residualDeviation(clamp(finiteOr(targetTemp, 0), -1, 1), WARM_TO_TEMP * traits.warmth)
  out.temp = noNegZero(clamp(tempUnits * TEMP_UNIT_TO_GAIN, -GRADE_LIMITS.tempMax, GRADE_LIMITS.tempMax))

  const contrastDev = residualDeviation(finiteOr(targetContrast, 1) - 1, CONTRAST_PER_UNIT * (traits.range - RANGE_REF))
  out.contrast = noNegZero(clamp(1 + contrastDev, GRADE_LIMITS.contrastMin, GRADE_LIMITS.contrastMax))
  return out
}

// ---------------------------------------------------------------------------------------------------------
// Tracker: gating + palette lookup + easing
// ---------------------------------------------------------------------------------------------------------

/**
 * Easing time constant, seconds. Settles to 95% in 3 tau = 1.8 s and to 99% in ~2.8 s, which is the "~2 s"
 * the palette-switch blend is meant to take (the palette colours themselves sweep in about 1.2 s).
 */
export const GRADE_EASE_TAU = 0.6

/** The slice of `LookProfile` the grade reads. `performanceState.look` satisfies it structurally. */
export type GradeLookInput = Pick<LookProfile, 'valid' | 'gradeSat' | 'gradeTemp' | 'gradeContrast'> & {
  families: Pick<LookFamilies, 'grade'>
}

/**
 * Whether the mood grade may drive the frame: the look must be a real read (`valid`) with the grade family
 * enabled (`?look=-grade` and `?scenepick=legacy` clear it). Anything else feeds identity.
 */
export function gradeFamilyActive(look: Pick<GradeLookInput, 'valid' | 'families'>): boolean {
  return look.valid === true && look.families.grade === true
}

/** Distance within which an eased value snaps onto its target, so identity is reached exactly. */
const SETTLE = 1e-4

/**
 * Turns `performanceState.look` plus the current palette id into the eased grade to feed `GradePass`.
 *
 * Each frame the target residual is recomputed (the palette id may have changed, and the look's own
 * blend moves), then the applied values ease toward it with {@link GRADE_EASE_TAU}. When the look is not
 * usable the target is identity, so switching the feature off (a kill switch, an invalid character read)
 * eases out rather than popping, and a tracker that has never been active stays at exact identity.
 *
 * Mutable public fields, no allocation in `update`. Read `sat` / `temp` / `contrast` after calling it.
 */
export class GradeResidualTracker {
  sat = 1
  temp = 0
  contrast = 1
  private readonly target: GradeTriple = { sat: 1, temp: 0, contrast: 1 }

  update(look: GradeLookInput, paletteId: string, dt: number): void {
    const t = this.target
    if (gradeFamilyActive(look)) {
      computeGradeResidual(look.gradeSat, look.gradeTemp, look.gradeContrast, paletteGradeTraits(paletteId), t)
    } else {
      t.sat = 1
      t.temp = 0
      t.contrast = 1
    }
    // A backgrounded-tab resume can hand back a huge dt (=> settle in one step, which is right) or garbage
    // (=> hold), never a NaN that would poison the eased state for the rest of the session.
    const k = Number.isFinite(dt) && dt > 0 ? 1 - Math.exp(-dt / GRADE_EASE_TAU) : 0
    this.sat = settle(this.sat + (t.sat - this.sat) * k, t.sat)
    this.temp = settle(this.temp + (t.temp - this.temp) * k, t.temp)
    this.contrast = settle(this.contrast + (t.contrast - this.contrast) * k, t.contrast)
  }

  /** Back to identity (a test, or a context loss). */
  reset(): void {
    this.sat = 1
    this.temp = 0
    this.contrast = 1
  }
}

function settle(x: number, target: number): number {
  return Math.abs(x - target) < SETTLE ? target : x
}
