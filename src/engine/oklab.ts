import * as THREE from 'three'

/**
 * Oklab: a perceptually uniform colour space, used as the interpolation basis
 * for every colour blend in this engine (see {@link lerpOklab} and its call
 * sites in `palettes.ts`).
 *
 * ## Why not linear sRGB
 *
 * `THREE.Color`'s working colour space is linear sRGB (three r0.178's
 * default), and `Color.lerp()` interpolates there directly. Linear sRGB is
 * NOT a fix for gamma-space interpolation — it has its own well-documented
 * failure mode: a blue→yellow ramp passes through a bright, magenta-tinted
 * grey, and a red→green ramp spends visibly less of its length looking red
 * than it does looking green, because linear-light mixing does not correspond
 * to how the eye integrates hue.
 *
 * Every one of this product's thirty palettes puts hue-distant colours in
 * adjacent slots on purpose — `rainbow` most deliberately, whose own doc
 * comment says "the four lit slots span distant hues, so a scene that sweeps
 * the ramp pulls a full spectrum out of five slots" — which is exactly the
 * configuration where linear-sRGB interpolation is worst: it desaturates
 * through the midpoint of precisely the transitions this product relies on to
 * read as a full spectrum.
 *
 * Oklab is built so that equal numeric steps read as equal PERCEIVED steps,
 * and a blue→yellow ramp stays saturated across its whole length instead of
 * washing out in the middle. It shipped in CSS Color 4 (`oklab()`/`oklch()`,
 * supported in every major browser) on the strength of exactly this property.
 *
 * ## Matrices
 *
 * Björn Ottosson's reference conversion
 * (https://bottosson.github.io/posts/oklab/), applied directly to LINEAR sRGB
 * — no separate gamma step, because linear is already what a `THREE.Color`
 * holds once `Color.set(hexString)` has run through `ColorManagement`.
 *
 * ## Gamut
 *
 * `oklabToLinearSrgb` is not gamut-mapped. An out-of-sRGB-gamut Oklab point is
 * rare for a straight-line lerp between two in-gamut endpoints — sRGB is
 * convex and Oklab is very nearly so — but not impossible for a highly
 * saturated pair. `lerpOklab` clamps its result to 0..1 before writing it
 * back, so the failure mode is a barely-visible desaturation at the gamut
 * edge, never a NaN or an out-of-range colour reaching the renderer. A
 * dedicated gamut-mapping step (project back toward the lightness axis until
 * in-gamut) would be the next increment if that clamp is ever visible —
 * nothing in this palette set is saturated enough to trigger it today.
 */

/** Linear sRGB (each channel 0..1, NOT gamma-encoded) → Oklab. */
export function linearSrgbToOklab(
  r: number,
  g: number,
  b: number,
  out: [number, number, number] = [0, 0, 0],
): [number, number, number] {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b

  const l_ = Math.cbrt(l)
  const m_ = Math.cbrt(m)
  const s_ = Math.cbrt(s)

  out[0] = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_
  out[1] = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_
  out[2] = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_
  return out
}

/**
 * Oklab → linear sRGB (each channel 0..1 for an in-gamut input; may exceed
 * that range for an out-of-gamut one — see the module header on gamut).
 */
export function oklabToLinearSrgb(
  L: number,
  a: number,
  b: number,
  out: [number, number, number] = [0, 0, 0],
): [number, number, number] {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.291485548 * b

  const l = l_ * l_ * l_
  const m = m_ * m_ * m_
  const s = s_ * s_ * s_

  out[0] = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
  out[1] = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
  out[2] = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  return out
}

/** Oklab L, a, b → Oklch L, chroma, hue-in-degrees. Pure convenience for authoring/annotation UIs. */
export function oklabToOklch(L: number, a: number, b: number): [number, number, number] {
  const C = Math.sqrt(a * a + b * b)
  let h = (Math.atan2(b, a) * 180) / Math.PI
  if (h < 0) h += 360
  return [L, C, h]
}

/** Oklch L, chroma, hue-in-degrees → Oklab L, a, b. */
export function oklchToOklab(L: number, C: number, hDeg: number): [number, number, number] {
  const h = (hDeg * Math.PI) / 180
  return [L, C * Math.cos(h), C * Math.sin(h)]
}

// Scratch buffers reused across calls — lerpOklab allocates nothing per frame,
// matching the "mutated in place, never replaced" discipline the rest of
// palettes.ts already follows for THREE.Color.
const _a: [number, number, number] = [0, 0, 0]
const _b: [number, number, number] = [0, 0, 0]
const _out: [number, number, number] = [0, 0, 0]

/**
 * Ease `color` toward `target` by `alpha`, interpolating in Oklab rather than
 * `color`'s native working space.
 *
 * Same call shape as `THREE.Color.lerp` — mutates `color` in place and
 * returns it — so it drops into any call site that currently reads
 * `color.lerp(target, alpha)` with no change to the caller beyond the name.
 */
export function lerpOklab(color: THREE.Color, target: THREE.Color, alpha: number): THREE.Color {
  if (!(alpha > 0)) return color
  if (alpha >= 1) return color.copy(target)
  linearSrgbToOklab(color.r, color.g, color.b, _a)
  linearSrgbToOklab(target.r, target.g, target.b, _b)
  const L = _a[0] + (_b[0] - _a[0]) * alpha
  const A = _a[1] + (_b[1] - _a[1]) * alpha
  const B = _a[2] + (_b[2] - _a[2]) * alpha
  oklabToLinearSrgb(L, A, B, _out)
  return color.setRGB(
    Math.min(1, Math.max(0, _out[0])),
    Math.min(1, Math.max(0, _out[1])),
    Math.min(1, Math.max(0, _out[2])),
  )
}

/**
 * Perceptual distance between two colours — Euclidean in Oklab. Used by the
 * palette selector (`AutoPilot.ts`) to keep "different enough" comparisons
 * honest instead of eyeballing hex strings.
 */
export function oklabDistance(c1: THREE.Color, c2: THREE.Color): number {
  linearSrgbToOklab(c1.r, c1.g, c1.b, _a)
  linearSrgbToOklab(c2.r, c2.g, c2.b, _b)
  const dL = _a[0] - _b[0]
  const dA = _a[1] - _b[1]
  const dB = _a[2] - _b[2]
  return Math.sqrt(dL * dL + dA * dA + dB * dB)
}
