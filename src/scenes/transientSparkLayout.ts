/**
 * Pure layout for Transient Spark: how many lights a firing gets, and where they go.
 *
 * Kept out of the scene component so it can be tested without a GL context. Everything
 * is a function of a seed (the beat position at the firing, plus a per-firing counter),
 * never `Math.random()`, so a recorded show replays identically.
 */

export const MIN_SPARKS = 1
/** Upper bound of one burst. The shader loops to this, so it is also the uniform array length. */
export const MAX_SPARKS = 15
/** Golden angle, radians — spreads points around a disc without clustering. */
const GOLDEN_ANGLE = 2.399963

/** Consecutive bursts must differ in size by at least this many lights. */
export const MIN_JUMP = 3
/** How many of the most recent counts are not reused. */
export const RECENT_WINDOW = 4

/** Deterministic hash to [0, 1). */
export function hash01(x: number): number {
  const s = Math.sin(x * 127.1 + 311.7) * 43758.5453
  return s - Math.floor(s)
}

/**
 * How many lights this firing gets, 1..15.
 *
 * Two rules keep it from settling into a pattern (the old scene always drew exactly three):
 * - the last few counts are excluded, so a small window of recent numbers is never reused;
 * - the new count must differ from the previous one by at least {@link MIN_JUMP}, so
 *   consecutive bursts read as clearly different sizes and not 7 then 8.
 * A harder transient (`strength` 0..1) tilts the odds toward a bigger burst, gently: soft hits
 * still throw big bursts sometimes and hard ones still throw single lights.
 */
export function pickSparkCount(seed: number, strength: number, recent: readonly number[]): number {
  const s = Math.min(1, Math.max(0, strength))
  const last = recent.length ? recent[recent.length - 1] : -100
  const window = recent.slice(-RECENT_WINDOW)
  const weights: number[] = []
  let total = 0
  for (let n = MIN_SPARKS; n <= MAX_SPARKS; n++) {
    let w = 1 + 0.9 * (s - 0.5) * (2 * ((n - MIN_SPARKS) / (MAX_SPARKS - MIN_SPARKS)) - 1)
    if (window.includes(n) || Math.abs(n - last) < MIN_JUMP) w = 0
    weights.push(w)
    total += w
  }
  // Cannot happen with a window of 4 and a jump of 3 over 15 values, but never return a dead pick.
  if (total <= 0) return MIN_SPARKS + Math.floor(hash01(seed) * (MAX_SPARKS - MIN_SPARKS + 1))
  let r = hash01(seed * 1.618 + 4.2) * total
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i]
    if (r < 0) return MIN_SPARKS + i
  }
  return MAX_SPARKS
}

export interface Spark {
  x: number
  y: number
  /** Falloff steepness in `amp / (d^2 * k + 1)`: bigger = a smaller, tighter light. */
  k: number
  /** Brightness multiplier. */
  amp: number
}

/**
 * Positions and sizes for `count` lights across the visible area (`aspect` = width / height;
 * the scene works in units of the shorter screen side).
 *
 * A lone light gets a random spot and a big soft bloom; a crowd is a sunflower spread of small
 * bright points. The spread of the whole burst also varies per firing (tight cluster to
 * screen-wide), so the same count does not look the same twice.
 */
export function layoutSparks(count: number, seed: number, aspect: number): Spark[] {
  const n = Math.min(MAX_SPARKS, Math.max(MIN_SPARKS, Math.round(count)))
  const hx = 0.5 * Math.max(1, aspect) * 0.9
  const hy = 0.5 * 0.85
  const spread = 0.35 + 0.65 * hash01(seed * 3.17 + 1.3)
  const phase = hash01(seed * 5.91 + 2.7) * Math.PI * 2
  // Bigger and softer when few, smaller and tighter when many.
  const baseK = 60 + 240 * Math.sqrt((n - 1) / (MAX_SPARKS - 1))
  // Many overlapping additive lights would blow out; ease the brightness down as the count grows.
  const crowd = 1 - 0.3 * ((n - 1) / (MAX_SPARKS - 1))
  const out: Spark[] = []
  for (let i = 0; i < n; i++) {
    const j1 = hash01(seed * 7.13 + i * 12.9898)
    const j2 = hash01(seed * 2.71 + i * 78.233)
    const j3 = hash01(seed * 9.31 + i * 37.719)
    let r: number
    let a: number
    let scale = spread
    if (n === 1) {
      // A single light lands anywhere on screen, not only near the middle.
      r = 0.85 * j1
      a = phase + j2 * Math.PI * 2
      scale = 1
    } else {
      r = Math.sqrt((i + 0.5 + 0.35 * (j1 - 0.5)) / n)
      a = phase + i * GOLDEN_ANGLE
    }
    out.push({
      x: Math.cos(a) * r * hx * scale,
      y: Math.sin(a) * r * hy * scale,
      k: baseK * (0.75 + 0.5 * j2),
      amp: crowd * (0.55 + 0.45 * j3),
    })
  }
  return out
}
