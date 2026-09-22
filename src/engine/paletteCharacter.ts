import type { CharacterPoint } from '../audio/characterTypes'
import { PALETTES, type Palette } from './palettes'

/**
 * Palette selection by CHARACTER fit.
 *
 * ## The problem
 * Palettes were chosen from a per-mood-label pool (`MOOD_PALETTES`), and the
 * musical key then overrode that choice whenever its family was in the pool. The
 * key maps 24 keys onto 6 palette families, and the mood pools overlap heavily, so
 * most songs ended up on the same handful of colour schemes.
 *
 * ## The fix
 * Every palette gets an explicit position in the same space the music is
 * described in (valence, arousal, tension, all 0..1), DERIVED FROM ITS COLOURS,
 * and the palette is chosen by geometric fit to the music's current character over
 * the WHOLE roster. The key becomes a gentle bonus, not an override.
 *
 * ## How a palette's character is derived (no hand-annotation, so a palette added
 * later via `registerPalette` is placed automatically)
 * The three lit slots (mid, accent, glow; weights 0.5/0.3/0.2) are read in HSV.
 *  - pleasure = 0.69 * brightness + 0.22 * saturation - 0.20 * red
 *               (Valdez & Mehrabian 1994 for the first two; the red term is ours:
 *               saturated red reads threatening, not pleasant)
 *  - arousal  = -0.31 * brightness + 0.35 * saturation + 0.40 * warmth
 *               (their signs; we shifted weight from saturation to hue temperature
 *               because a fully saturated cyan/blue palette such as Deep Ocean reads
 *               CALM, which their saturation-only term scored as highly arousing)
 *  - tension  = hue discord (circular spread of the lit hues: analogous schemes are
 *               relaxed, complementary/split ones are not) plus saturated red
 * The Valdez & Mehrabian coefficients are quoted from memory and were NOT re-verified
 * against the paper here; only their signs are load-bearing. Tension is a judgement
 * call. Each axis is then RANK-normalised across the roster, so the palettes spread
 * over the full 0..1 range instead of bunching (they are all near-black grounds with
 * bright lit slots, so raw values sit in a narrow band).
 *
 * ## Optional: a gentle bonus toward the mood's own colour target
 * `PaletteFitOptions.moodTarget`, when given, adds a SECOND, much gentler term to `paletteAffinity`: how
 * closely this same intrinsic-colour derivation (mean lit-slot saturation, signed warmth along the same
 * orange/azure axis the arousal term above uses) matches the mood row's own authored `gradeSat`/`gradeTemp`
 * (see `lookRow.ts`). The palette this nudges toward is then a better colour match BEFORE the grade residual
 * (`gradeResidual.ts`) ever runs, so the residual — which reacts to whichever palette is live — has less work
 * left to do; nothing about the residual's own math needs to change for that to be true. See `moodColourBonus`
 * below for the formula and why its magnitude is sized against `KEY_FAMILY_BONUS`.
 */

export interface PaletteCharacter {
  valence: number
  arousal: number
  tension: number
  /**
   * Rank-normalised 0..1 (same treatment as valence/arousal/tension above, for the same reason — the raw HSV
   * values bunch in a narrow band). Mean lit-slot saturation. Read only by the optional `moodTarget` bonus in
   * `paletteAffinity`; never by the primary V/A/T fit.
   */
  intrinsicSat: number
  /**
   * Rank-normalised 0..1. The palette's own lean along the warm(1)/cool(0) axis (pre-rank it is signed, chroma-
   * weighted `cos(hue-25°)` — the same axis `arousal`'s `warm` term above uses, unsigned there; here the sign
   * survives into the raw value and only the FINAL rank is 0..1). Read only by the `moodTarget` bonus.
   */
  intrinsicWarmth: number
}

// --- colour helpers ---------------------------------------------------------

function hexToHsv(hex: string): { h: number; s: number; v: number } {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  const n = m ? parseInt(m[1], 16) : 0
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
  return { h, s: max > 1e-9 ? d / max : 0, v: max }
}

const rad = (deg: number) => (deg * Math.PI) / 180

/** Lit-slot weights: the body colour dominates, the highlight matters least. */
const LIT_WEIGHTS = [0.5, 0.3, 0.2] as const

interface RawPalette {
  pleasure: number
  arousal: number
  tension: number
  /** Pre-rank mean lit-slot saturation (`paletteCharacters()` rank-normalises this into `intrinsicSat`). */
  sat: number
  /** Pre-rank, SIGNED warm(+)/cool(-) lean — unlike `warm` below, no `+1)/2` offset. Rank-normalised into `intrinsicWarmth`. */
  warmth: number
}

function rawCharacter(p: Palette): RawPalette {
  const lit = [p.slots.mid, p.slots.accent, p.slots.glow].map(hexToHsv)
  let B = 0
  let S = 0
  let warm = 0
  let warmSigned = 0
  let red = 0
  let vx = 0
  let vy = 0
  let wsum = 0
  lit.forEach((c, i) => {
    const w = LIT_WEIGHTS[i]
    B += w * c.v
    S += w * c.s
    // Warmth peaks around orange (25 degrees), coolest at cyan-blue.
    warm += w * c.s * ((Math.cos(rad(c.h - 25)) + 1) / 2)
    // Same axis, signed (no 0..1 offset) — feeds `intrinsicWarmth`, not the arousal term above.
    warmSigned += w * c.s * Math.cos(rad(c.h - 25))
    red += w * c.s * Math.max(0, Math.cos(rad(c.h - 10)))
    // Chroma-weighted hue vector: a desaturated slot has no hue to clash.
    vx += w * c.s * Math.cos(rad(c.h))
    vy += w * c.s * Math.sin(rad(c.h))
    wsum += w * c.s
  })
  const discord = wsum > 1e-6 ? 1 - Math.hypot(vx, vy) / wsum : 0
  return {
    pleasure: 0.69 * B + 0.22 * S - 0.2 * red,
    arousal: -0.31 * B + 0.35 * S + 0.4 * warm,
    tension: 0.6 * discord + 0.4 * red,
    sat: S,
    warmth: warmSigned,
  }
}

/** Average-rank normalisation to 0..1 (ties share a rank). */
function rank01(values: readonly number[]): number[] {
  const n = values.length
  if (n < 2) return values.map(() => 0.5)
  const idx = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0])
  const out = new Array<number>(n)
  let i = 0
  while (i < n) {
    let j = i
    while (j + 1 < n && Math.abs(idx[j + 1][0] - idx[i][0]) < 1e-9) j++
    const r = (i + j) / 2 / (n - 1)
    for (let k = i; k <= j; k++) out[idx[k][1]] = r
    i = j + 1
  }
  return out
}

let cache: { size: number; map: Map<string, PaletteCharacter> } | null = null

/** Character of every registered palette (recomputed if a palette is registered later). */
export function paletteCharacters(): Map<string, PaletteCharacter> {
  if (cache && cache.size === PALETTES.length) return cache.map
  const raws = PALETTES.map(rawCharacter)
  const v = rank01(raws.map((r) => r.pleasure))
  const a = rank01(raws.map((r) => r.arousal))
  const t = rank01(raws.map((r) => r.tension))
  const satRank = rank01(raws.map((r) => r.sat))
  const warmRank = rank01(raws.map((r) => r.warmth))
  const map = new Map<string, PaletteCharacter>()
  PALETTES.forEach((p, i) =>
    map.set(p.id, { valence: v[i], arousal: a[i], tension: t[i], intrinsicSat: satRank[i], intrinsicWarmth: warmRank[i] }),
  )
  cache = { size: PALETTES.length, map }
  return map
}

// --- selection ---------------------------------------------------------------

/** Width (sigma) of the fit in each axis. Tension is the least trusted axis, so it is the loosest. */
const SIGMA_V = 0.3
const SIGMA_A = 0.3
const SIGMA_T = 0.45
/** Sharpens the fit so the best few palettes dominate without excluding the rest. */
const SHARPNESS = 1.6
/** Recency penalty by how many picks ago (index 0 = the most recent). Older than the table = not recent. */
const RECENCY = [0.08, 0.25, 0.45, 0.65, 0.82, 0.93] as const
/** The key family is a nudge, not an override: it can tip a close call, never beat a poor fit. */
const KEY_FAMILY_BONUS = 1.3
/** Per-song bias range: two songs with the same character still favour different palettes. */
const SEED_BIAS_LO = 0.75
const SEED_BIAS_HI = 1.25

function hash32(a: number, s: string): number {
  let h = (a ^ 0x9e3779b9) >>> 0
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0
  h ^= h >>> 15
  h = Math.imul(h, 0x2c1b3c6d) >>> 0
  h ^= h >>> 12
  return h >>> 0
}

/** Deterministic PRNG so a recorded set repeats (this file family avoids Math.random on purpose). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * A mood row's own authored colour target, in the EXACT units `LookRow.gradeSat`/`gradeTemp`/`gradeContrast`
 * use (see `lookRow.ts`): `sat` 0.75..1.3 (1 = neutral), `temp` -1..1 (cool..warm), `contrast` 0.95..1.3
 * (1 = neutral) — so a caller can pass a `LookProfile`'s three grade fields straight through. `contrast` is
 * accepted for that shape parity but is NOT read by `moodColourBonus` below: this file derives no intrinsic
 * contrast / luminance-range axis of its own, and recomputing one here (duplicating `gradeResidual.ts`'s
 * `range` trait and its calibration) is exactly the kind of independent re-derivation this feature must avoid.
 */
export interface PaletteMoodTarget {
  sat: number
  temp: number
  contrast: number
}

export interface PaletteFitOptions {
  character: Pick<CharacterPoint, 'valence' | 'arousal' | 'tension'>
  /** Palette currently showing: never returned. */
  current: string
  /** Most-recent-first list of previously picked palettes. */
  recentIds: readonly string[]
  /** The musical key's palette family (`keyPaletteTracker.family`), or '' for none. */
  keyFamily: string
  /** Stable per-song seed (`songSeedFor` in characterPick.ts). */
  songSeed: number
  /** Monotonic counter so successive picks on the same input differ deterministically. */
  rotation: number
  /**
   * OPTIONAL. The mood row's own colour target, so palette selection can lean toward the mood's implied
   * warmth/saturation directly rather than only through the grade residual applied after the fact (see the
   * file header's "Optional: a gentle bonus" section and `moodColourBonus` below). Omitted — the default —
   * `paletteAffinity`/`pickPaletteByCharacter` are byte-identical to how they behaved before this field
   * existed; this is the ONLY behaviour under `?scenepick=legacy` or an invalid look.
   */
  moodTarget?: PaletteMoodTarget
}

/**
 * Width (sigma) of the `moodTarget` bonus, on the same 0..1 scale `intrinsicSat`/`intrinsicWarmth` and the
 * mapped `moodTarget` both live in. Comparable to (a little looser than) `SIGMA_V`/`SIGMA_A` (0.3): this is a
 * secondary signal layered on the primary fit, not a fourth axis of it, so it is allowed to be a bit more
 * forgiving without needing `SIGMA_T`'s "least-trusted axis" excuse for going all the way to 0.45.
 */
const SIGMA_MOOD = 0.35
/**
 * Ceiling on the `moodTarget` bonus at PERFECT colour match, sized against `KEY_FAMILY_BONUS` (1.3) below —
 * the existing precedent for "how much should a secondary signal nudge without overriding". This bonus is
 * multiplied into `paletteAffinity`'s result, which `pickPaletteByCharacter` then raises to `SHARPNESS`
 * (1.6) along with the rest of the fit, so its EFFECTIVE ceiling on a pick's final weight is
 * `MOOD_BONUS_MAX ^ SHARPNESS` = 1.15^1.6 ~= 1.25 — comparably sized to, and a little under, the key bonus's
 * own un-exponentiated 1.3x. A maximally-matched colour target and a matched key family are therefore
 * comparable-strength nudges, and neither alone can outweigh a poor primary V/A/T fit (a 3-axis Gaussian,
 * which routinely swings the base fit by one or two orders of magnitude for a genuinely bad match).
 */
const MOOD_BONUS_MAX = 1.15
/** `LookRow.gradeSat`'s documented range (1 = neutral). Duplicated as a literal rather than imported, so this
 *  file keeps no dependency on `look/lookRow.ts` or `look/gradeResidual.ts` — see `PaletteMoodTarget`'s doc. */
const MOOD_SAT_MIN = 0.75
const MOOD_SAT_MAX = 1.3

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)
const finiteOr = (x: number, fallback: number) => (Number.isFinite(x) ? x : fallback)

/**
 * The `moodTarget` bonus itself: a Gaussian of width {@link SIGMA_MOOD} between this palette's own intrinsic
 * colour and the mood's target, mapped onto the same 0..1 space. Deliberately a BONUS ONLY (always >= 1,
 * never < 1): a palette whose colour fights the mood's ask is not penalised beyond simply not being helped —
 * the same one-sided shape `gradeResidual.ts`'s credit uses, and for the same reason (see this file's header).
 */
function moodColourBonus(p: PaletteCharacter, target: PaletteMoodTarget): number {
  const satNorm = clamp01((finiteOr(target.sat, 1) - MOOD_SAT_MIN) / (MOOD_SAT_MAX - MOOD_SAT_MIN))
  const warmNorm = clamp01((finiteOr(target.temp, 0) + 1) / 2)
  const dSat = (p.intrinsicSat - satNorm) / SIGMA_MOOD
  const dWarm = (p.intrinsicWarmth - warmNorm) / SIGMA_MOOD
  return 1 + (MOOD_BONUS_MAX - 1) * Math.exp(-0.5 * (dSat * dSat + dWarm * dWarm))
}

/**
 * Affinity of each candidate, for tests and diagnostics (higher is a better fit; ignores recency/seed). The
 * primary term is the V/A/T Gaussian fit, unchanged. `moodTarget`, when given, multiplies in
 * {@link moodColourBonus} as a gentle secondary nudge; omitted, the result is bit-for-bit what this function
 * has always returned.
 */
export function paletteAffinity(id: string, c: PaletteFitOptions['character'], moodTarget?: PaletteMoodTarget): number {
  const p = paletteCharacters().get(id)
  if (!p) return 0
  const dv = (c.valence - p.valence) / SIGMA_V
  const da = (c.arousal - p.arousal) / SIGMA_A
  const dt = (c.tension - p.tension) / SIGMA_T
  const base = Math.exp(-0.5 * (dv * dv + da * da + dt * dt))
  return moodTarget ? base * moodColourBonus(p, moodTarget) : base
}

/** The top `n` palette ids by pure fit (for diagnostics/tests). */
export function palettePool(c: PaletteFitOptions['character'], n = 6): string[] {
  return PALETTES.map((p) => [p.id, paletteAffinity(p.id, c)] as const)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([id]) => id)
}

/**
 * Choose a palette for the music's current character, or null when there is nowhere to go.
 * Never returns `current`. Deterministic for a given input.
 */
export function pickPaletteByCharacter(o: PaletteFitOptions): string | null {
  const chars = paletteCharacters()
  const candidates = PALETTES.filter((p) => p.id !== o.current && chars.has(p.id))
  if (candidates.length === 0) return null
  const weights = candidates.map((p) => {
    const recentIndex = o.recentIds.indexOf(p.id)
    const recency = recentIndex === -1 ? 1 : (RECENCY[recentIndex] ?? 1)
    const seed = SEED_BIAS_LO + (SEED_BIAS_HI - SEED_BIAS_LO) * (hash32(o.songSeed, p.id) / 4294967296)
    const key = o.keyFamily && p.id === o.keyFamily ? KEY_FAMILY_BONUS : 1
    return Math.pow(paletteAffinity(p.id, o.character, o.moodTarget), SHARPNESS) * recency * seed * key
  })
  const total = weights.reduce((s, w) => s + w, 0)
  if (!(total > 1e-12)) return candidates[Math.abs(o.rotation) % candidates.length].id
  let r = mulberry32(hash32(o.songSeed, `pick:${o.rotation}`))() * total
  for (let i = 0; i < candidates.length; i++) {
    r -= weights[i]
    if (r <= 0) return candidates[i].id
  }
  return candidates[candidates.length - 1].id
}
