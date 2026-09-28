/**
 * Small statistics helpers and the segment aggregator that turns per-frame features into per-beat / per-bar
 * summaries (mean and spread of mel, chroma, level, onset density). Pure.
 */
import { MEL_BANDS, toDb, type FrameFeatures } from './dsp'

export const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x)

export function median(xs: ArrayLike<number>): number {
  const n = xs.length
  if (n === 0) return 0
  const s = Array.from(xs).sort((a, b) => a - b)
  return n & 1 ? s[n >> 1] : 0.5 * (s[n / 2 - 1] + s[n / 2])
}

/** Median absolute deviation, scaled to be comparable to a standard deviation. */
export function mad(xs: ArrayLike<number>, med = median(xs)): number {
  const d = Array.from(xs, (x) => Math.abs(x - med))
  return 1.4826 * median(d)
}

/** Robust z-scores (median / MAD); a degenerate spread falls back to the standard deviation, then 1. */
export function robustZ(xs: ArrayLike<number>, from = 0, to = xs.length): Float64Array {
  const seg = Array.from({ length: Math.max(0, to - from) }, (_, i) => xs[from + i])
  const med = median(seg)
  let sc = mad(seg, med)
  if (!(sc > 1e-9)) {
    let v = 0
    for (const x of seg) v += (x - med) * (x - med)
    sc = Math.sqrt(v / Math.max(1, seg.length))
  }
  if (!(sc > 1e-9)) sc = 1
  const out = new Float64Array(xs.length)
  for (let i = 0; i < xs.length; i++) out[i] = (xs[i] - med) / sc
  return out
}

export interface Envelopes {
  flux: Float32Array
  lowFlux: Float32Array
  hiFlux: Float32Array
}

export interface Agg {
  n: number
  /** Mean spectrum per segment, dB of the mean LINEAR band energy (n x MEL_BANDS). */
  melDb: Float32Array
  /** Mean over bands of the std (over frames) of the band dB: temporal texture. */
  melStd: Float32Array
  /** Energy-weighted mean chroma, L2-normalised (n x 12); all zeros for a silent segment. */
  chroma: Float32Array
  levelDb: Float32Array
  lowDb: Float32Array
  highDb: Float32Array
  flux: Float32Array
  lowFlux: Float32Array
  hiFlux: Float32Array
  fluxStd: Float32Array
}

/** Aggregate frames `[edges[k], edges[k+1])` for every segment `k` (edges are frame indices, non-decreasing). */
export function aggregate(f: FrameFeatures, env: Envelopes, edges: ArrayLike<number>): Agg {
  const n = Math.max(0, edges.length - 1)
  const out: Agg = {
    n,
    melDb: new Float32Array(n * MEL_BANDS),
    melStd: new Float32Array(n),
    chroma: new Float32Array(n * 12),
    levelDb: new Float32Array(n),
    lowDb: new Float32Array(n),
    highDb: new Float32Array(n),
    flux: new Float32Array(n),
    lowFlux: new Float32Array(n),
    hiFlux: new Float32Array(n),
    fluxStd: new Float32Array(n),
  }
  const lin = new Float64Array(MEL_BANDS)
  const s1 = new Float64Array(MEL_BANDS)
  const s2 = new Float64Array(MEL_BANDS)
  for (let k = 0; k < n; k++) {
    const a = clamp(Math.round(edges[k]), 0, f.n)
    const b = clamp(Math.round(edges[k + 1]), a, f.n)
    const cnt = Math.max(1, b - a)
    lin.fill(0)
    s1.fill(0)
    s2.fill(0)
    let lv = 0
    let lo = 0
    let hi = 0
    let fx = 0
    let fl = 0
    let fh = 0
    let fx2 = 0
    const ch = new Float64Array(12)
    for (let t = a; t < b; t++) {
      const o = t * MEL_BANDS
      for (let j = 0; j < MEL_BANDS; j++) {
        lin[j] += f.melLin[o + j]
        const d = f.melDb[o + j]
        s1[j] += d
        s2[j] += d * d
      }
      lv += f.levelLin[t]
      lo += f.lowLin[t]
      hi += f.highLin[t]
      fx += env.flux[t]
      fx2 += env.flux[t] * env.flux[t]
      fl += env.lowFlux[t]
      fh += env.hiFlux[t]
      for (let p = 0; p < 12; p++) ch[p] += f.chroma[t * 12 + p]
    }
    let stdSum = 0
    for (let j = 0; j < MEL_BANDS; j++) {
      out.melDb[k * MEL_BANDS + j] = toDb(lin[j] / cnt)
      const m = s1[j] / cnt
      stdSum += Math.sqrt(Math.max(0, s2[j] / cnt - m * m))
    }
    out.melStd[k] = stdSum / MEL_BANDS
    let nrm = 0
    for (let p = 0; p < 12; p++) nrm += ch[p] * ch[p]
    nrm = Math.sqrt(nrm)
    if (nrm > 1e-6) for (let p = 0; p < 12; p++) out.chroma[k * 12 + p] = ch[p] / nrm
    out.levelDb[k] = toDb(lv / cnt)
    out.lowDb[k] = toDb(lo / cnt)
    out.highDb[k] = toDb(hi / cnt)
    out.flux[k] = fx / cnt
    out.lowFlux[k] = fl / cnt
    out.hiFlux[k] = fh / cnt
    const fm = fx / cnt
    out.fluxStd[k] = Math.sqrt(Math.max(0, fx2 / cnt - fm * fm))
  }
  return out
}

/** Least-squares slope of `y` over `x = 0..n-1` (units of y per step). */
export function slope(y: ArrayLike<number>, from: number, to: number): number {
  const n = to - from
  if (n < 2) return 0
  let sx = 0
  let sy = 0
  let sxx = 0
  let sxy = 0
  for (let i = 0; i < n; i++) {
    const v = y[from + i]
    sx += i
    sy += v
    sxx += i * i
    sxy += i * v
  }
  const den = n * sxx - sx * sx
  return den !== 0 ? (n * sxy - sx * sy) / den : 0
}

export function meanRange(y: ArrayLike<number>, from: number, to: number): number {
  let s = 0
  const a = Math.max(0, from)
  const b = Math.min(y.length, to)
  for (let i = a; i < b; i++) s += y[i]
  return b > a ? s / (b - a) : 0
}
