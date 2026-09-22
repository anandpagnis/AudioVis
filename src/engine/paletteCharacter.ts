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
 */

export interface PaletteCharacter {
  valence: number
  arousal: number
  tension: number
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
}

function rawCharacter(p: Palette): RawPalette {
  const lit = [p.slots.mid, p.slots.accent, p.slots.glow].map(hexToHsv)
  let B = 0
  let S = 0
  let warm = 0
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
  const map = new Map<string, PaletteCharacter>()
  PALETTES.forEach((p, i) => map.set(p.id, { valence: v[i], arousal: a[i], tension: t[i] }))
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
}

/** Affinity of each candidate, for tests and diagnostics (higher is a better fit; ignores recency/seed). */
export function paletteAffinity(id: string, c: PaletteFitOptions['character']): number {
  const p = paletteCharacters().get(id)
  if (!p) return 0
  const dv = (c.valence - p.valence) / SIGMA_V
  const da = (c.arousal - p.arousal) / SIGMA_A
  const dt = (c.tension - p.tension) / SIGMA_T
  return Math.exp(-0.5 * (dv * dv + da * da + dt * dt))
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
    return Math.pow(paletteAffinity(p.id, o.character), SHARPNESS) * recency * seed * key
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
