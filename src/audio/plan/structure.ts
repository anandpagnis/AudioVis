/**
 * Bar-level structure analysis of a whole song: a bar-synchronous self-similarity matrix on mean-centred weighted
 * features (cosine), Foote checkerboard novelty with SYMMETRIC kernels at two scales (about 4 and 8 bars each side:
 * this is offline, the future is available), adaptive peak picking (median + k*MAD threshold, min spacing, a soft
 * 4/8-bar phase prior) gated by an ABSOLUTE feature-distance floor, repetition labelling of the resulting segments
 * and event typing from the level / bass / onset transitions across each boundary.
 *
 * Why the absolute floor: cosine similarity on mean-centred features and a MAD threshold are both scale-free. In a
 * song whose only variation is a snare fill or a uniform volume step they would promote that variation to a
 * section boundary. The features are in dB-equivalent units and spectral SHAPE only (gain-invariant), so a fixed
 * floor on the shift across a boundary rejects fills, gain steps and noise while a real change (bass drop-out, a
 * new mix, a key change) clears it by a wide margin.
 */
import type { EventFeats } from '../events/types'
import { aggregate, clamp, meanRange, median, robustZ, slope, type Agg, type Envelopes } from './aggregate'
import type { PhaseAlignment } from './downbeat'
import { MEL_BANDS, type FrameFeatures } from './dsp'
import { featureVectors, VEC_DIM } from './vectors'

export interface Peak {
  /** Boundary index: between bar `bar - 1` and bar `bar`. */
  bar: number
  /** Combined novelty z-score. */
  z: number
  /** Absolute feature shift across the boundary (dB-equivalent). */
  dist: number
  onGrid: boolean
}

export interface GridPhase {
  phase4: number
  phase8: number
  share4: number
}

export interface PeakOptions {
  minSpacing: number
  threshold: number
  /** A candidate weaker than this share of a stronger one within 2 x minSpacing bars is dropped (a transition bar
   *  or a chord change next to the real boundary). */
  dominance: number
}

/** Cosine self-similarity of mean-centred bar vectors, soft-normalised so near-mean bars do not blow up. */
export function cosineSsm(vec: Float32Array, n: number): Float32Array {
  const mu = new Float64Array(VEC_DIM)
  for (let i = 0; i < n; i++) for (let d = 0; d < VEC_DIM; d++) mu[d] += vec[i * VEC_DIM + d]
  for (let d = 0; d < VEC_DIM; d++) mu[d] /= Math.max(1, n)
  const vc = new Float32Array(n * VEC_DIM)
  const nrm2 = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    let s = 0
    for (let d = 0; d < VEC_DIM; d++) {
      const x = vec[i * VEC_DIM + d] - mu[d]
      vc[i * VEC_DIM + d] = x
      s += x * x
    }
    nrm2[i] = s
  }
  const eps2 = Math.pow(0.15, 2) * median(Array.from(nrm2))
  const nrm = Float64Array.from(nrm2, (s) => Math.sqrt(s + eps2 + 1e-12))
  const S = new Float32Array(n * n)
  for (let i = 0; i < n; i++) {
    S[i * n + i] = nrm2[i] / (nrm[i] * nrm[i])
    for (let j = i + 1; j < n; j++) {
      let s = 0
      for (let d = 0; d < VEC_DIM; d++) s += vc[i * VEC_DIM + d] * vc[j * VEC_DIM + d]
      const v = s / (nrm[i] * nrm[j])
      S[i * n + j] = v
      S[j * n + i] = v
    }
  }
  return S
}

/** Foote checkerboard novelty at boundary `i` (between bars i-1 and i) with a K-bar symmetric, mildly tapered kernel. */
export function footeNovelty(S: Float32Array, n: number, K: number): Float64Array {
  const out = new Float64Array(n)
  const g = new Float64Array(K)
  for (let u = 0; u < K; u++) g[u] = Math.exp(-0.5 * Math.pow(u / (0.85 * K), 2))
  for (let i = 1; i < n; i++) {
    const ke = Math.min(K, i, n - i)
    if (ke < 2) continue
    let acc = 0
    let wsum = 0
    for (let u = 0; u < ke; u++) {
      for (let v = 0; v < ke; v++) {
        const w = g[u] * g[v]
        const pp = S[(i - 1 - u) * n + (i - 1 - v)]
        const ff = S[(i + u) * n + (i + v)]
        const pf = S[(i - 1 - u) * n + (i + v)]
        const fp = S[(i + u) * n + (i - 1 - v)]
        acc += w * (pp + ff - pf - fp)
        wsum += w
      }
    }
    out[i] = acc / wsum
  }
  return out
}

/**
 * Distance between the (boxcar) mean feature vectors of the `K` bars before and after each boundary, over the
 * dimensions `[d0, d1)`. Squared-Euclidean checkerboard novelty reduces to exactly this quantity.
 */
export function windowDistance(vec: Float32Array, n: number, K: number, d0 = 0, d1 = VEC_DIM): Float64Array {
  const out = new Float64Array(n)
  for (let i = 1; i < n; i++) {
    const ke = Math.min(K, i, n - i)
    if (ke < 1) continue
    let s = 0
    for (let d = d0; d < d1; d++) {
      let a = 0
      let b = 0
      for (let u = 0; u < ke; u++) {
        a += vec[(i - 1 - u) * VEC_DIM + d]
        b += vec[(i + u) * VEC_DIM + d]
      }
      const x = (b - a) / ke
      s += x * x
    }
    out[i] = Math.sqrt(s)
  }
  return out
}

export interface NoveltyOptions {
  /** Floor on the feature shift across a boundary for the timbre / rhythm / bass channel (dB-equivalent). */
  distanceFloor: number
  /** The same floor for the harmony (chroma) channel. */
  harmonyFloor: number
  /** A step keeps its 2-bar shift at least this share of its 4/8-bar shift; a linear ramp's is 25-50%. */
  stepRatio: number
  /**
   * The beat grid carries no rhythm (drumless / ambient music): bars are arbitrary units, and in sparse tonal
   * textures every chord change is as large a timbre change as a section change. Judge the main channel on the
   * long (8-bar) kernel only.
   */
  beatless?: boolean
}

export interface NoveltyResult {
  /** Combined, gated novelty score per boundary index (0 where a gate rejected the candidate). */
  z: Float64Array
  /** The same before gating. */
  zRaw: Float64Array
  /** Absolute feature shift across each boundary (dB-equivalent): the larger of the timbre and harmony channels. */
  dist: Float64Array
}

/**
 * Two channels. MAIN (mel shape, onset texture, bass share): Foote novelty at 2, 4 and 8 bars each side. The 2-bar
 * kernel is the SHARP step detector (a ramp or a one-bar blip barely moves it); the 4/8-bar kernels say the change
 * persists; a soft AND (geometric mean) keeps steps, drops ramps and blips. HARMONY (chroma only): the 8-bar kernel
 * alone, which spans whole 2/4/8-bar chord cycles so a repeating progression does not ripple.
 * Each channel is z-scored robustly (median / MAD) and then GATED by an absolute shift floor in dB-equivalent units:
 * the z-scores are scale-free and would otherwise promote a snare fill or a volume step to a boundary in a song with
 * nothing else going on. The main channel also requires the 2-bar shift to be a step, not a ramp.
 */
export function computeNovelty(vecMain: Float32Array, chromaVec: Float32Array, n: number, opts: NoveltyOptions): NoveltyResult {
  const lo = 2
  const hi = Math.max(lo + 1, n - 2)
  const S = cosineSsm(vecMain, n)
  const z2 = robustZ(footeNovelty(S, n, 2), lo, hi)
  const z4 = robustZ(footeNovelty(S, n, 4), lo, hi)
  const z8 = robustZ(footeNovelty(S, n, 8), lo, hi)
  const d2 = windowDistance(vecMain, n, 2)
  const d4 = windowDistance(vecMain, n, 4)
  const d8 = windowDistance(vecMain, n, 8)
  const Sc = cosineSsm(chromaVec, n)
  const zh = robustZ(footeNovelty(Sc, n, 8), lo, hi)
  const dh = windowDistance(chromaVec, n, 8)
  const z = new Float64Array(n)
  const zRaw = new Float64Array(n)
  const dist = new Float64Array(n)
  for (let i = 1; i < n; i++) {
    const persist = Math.max(z4[i], 0.9 * z8[i])
    const main = opts.beatless ? 0.9 * Math.max(0, z8[i]) : Math.sqrt(Math.max(0, z2[i]) * Math.max(0, persist))
    const harm = (opts.beatless ? 1 : 0.8) * Math.max(0, zh[i])
    const dm = Math.max(d4[i], d8[i])
    dist[i] = Math.max(dm, dh[i])
    zRaw[i] = Math.max(main, harm)
    const mainOk = dm >= opts.distanceFloor && (opts.beatless || d2[i] >= opts.stepRatio * dm)
    // full 8-bar kernel only: a truncated window at either end of the song is dominated by its first / last bars
    const harmOk = dh[i] >= opts.harmonyFloor && i >= 8 && n - i >= 8
    z[i] = Math.max(mainOk ? main : 0, harmOk ? harm : 0)
  }
  return { z, zRaw, dist }
}

/** Local maxima (>= left neighbour, > right neighbour) of `c` over `[2, n - 3]`, kept when `c >= min`. */
function localMaxima(c: Float64Array, n: number, min: number, edge: number): number[] {
  const out: number[] = []
  for (let i = edge; i <= n - edge; i++) if (c[i] >= c[i - 1] && c[i] > c[i + 1] && c[i] >= min) out.push(i)
  return out
}

/** Greedy non-maximum suppression: strongest first, dropping any within `< spacing` bars of one already kept. */
function suppress(idx: number[], score: (i: number) => number, spacing: number): number[] {
  const order = [...idx].sort((a, b) => score(b) - score(a))
  const kept: number[] = []
  for (const i of order) if (!kept.some((k) => Math.abs(k - i) < spacing)) kept.push(i)
  return kept.sort((a, b) => a - b)
}

export function pickPeaks(nov: NoveltyResult, n: number, opts: PeakOptions): { peaks: Peak[]; grid: GridPhase; rejectedByFloor: number } {
  const { z, zRaw, dist } = nov
  const grid: GridPhase = { phase4: -1, phase8: -1, share4: 0 }
  if (n < 12) return { peaks: [], grid, rejectedByFloor: 0 }
  // pass 1: strong peaks vote for the 4-bar and 8-bar phase of the boundary grid
  const strong = suppress(
    localMaxima(z, n, Math.max(3.5, opts.threshold + 1), opts.minSpacing),
    (i) => z[i],
    opts.minSpacing,
  )
  if (strong.length >= 3) {
    const h4 = [0, 0, 0, 0]
    let tot = 0
    for (const i of strong) {
      h4[i % 4] += z[i]
      tot += z[i]
    }
    let b4 = 0
    for (let p = 1; p < 4; p++) if (h4[p] > h4[b4]) b4 = p
    grid.share4 = tot > 0 ? h4[b4] / tot : 0
    if (grid.share4 >= 0.5) {
      grid.phase4 = b4
      const on4 = strong.filter((i) => i % 4 === b4)
      if (on4.length >= 3) {
        const h8 = [0, 0]
        for (const i of on4) h8[((i - b4) / 4) & 1] += z[i]
        grid.phase8 = h8[0] >= h8[1] ? b4 : (b4 + 4) % 8
        const share8 = Math.max(h8[0], h8[1]) / Math.max(1e-9, h8[0] + h8[1])
        if (share8 < 0.6) grid.phase8 = -1
      }
    }
  }
  const prior = (i: number) => 1 + (grid.phase4 >= 0 && i % 4 === grid.phase4 ? 0.25 : 0) + (grid.phase8 >= 0 && i % 8 === grid.phase8 ? 0.12 : 0)
  // the soft grid prior enters BEFORE the local-maximum test, so a boundary that jitters by a bar between two
  // near-equal novelty values lands on the grid, while a clearly stronger off-grid peak still wins
  const scoreArr = Float64Array.from(z, (v, i) => v * prior(i))
  const score = (i: number) => scoreArr[i]
  const cand = localMaxima(scoreArr, n, opts.threshold, opts.minSpacing)
  // gated-out local maxima that would otherwise have passed: fills, volume steps, ramps, noise
  let rejected = 0
  for (const i of localMaxima(zRaw, n, opts.threshold, opts.minSpacing)) if (z[i] < opts.threshold) rejected++
  const spaced = suppress(cand, score, opts.minSpacing)
  const kept = spaced.filter((i) => !spaced.some((j) => j !== i && Math.abs(j - i) <= 2 * opts.minSpacing && score(j) * opts.dominance > score(i)))
  const peaks: Peak[] = kept.map((i) => ({
    bar: i,
    z: z[i],
    dist: dist[i],
    onGrid: grid.phase4 >= 0 && i % 4 === grid.phase4,
  }))
  return { peaks, grid, rejectedByFloor: rejected }
}

/* ------------------------------------------------------------------------------------------------
 * Segments: repetition labelling
 * ---------------------------------------------------------------------------------------------- */

export interface SegmentLabels {
  labels: string[]
  repeatOf: Array<number | undefined>
  /** Similarity (cosine of mean-centred signatures) to the segment it repeats. */
  similarity: number[]
}

const letter = (k: number) => (k < 26 ? String.fromCharCode(65 + k) : `${String.fromCharCode(65 + (k % 26))}${Math.floor(k / 26)}`)

/**
 * Cluster segment signatures (mean bar vector, centred over the song). A segment joins the first earlier cluster
 * whose prototype is both directionally similar (cosine >= `cosMin`) and close in absolute terms (`<= dMax`).
 */
export function labelSegments(vec: Float32Array, bounds: number[], cosMin: number, dMax: number): SegmentLabels {
  const n = bounds[bounds.length - 1]
  const mu = new Float64Array(VEC_DIM)
  for (let i = 0; i < n; i++) for (let d = 0; d < VEC_DIM; d++) mu[d] += vec[i * VEC_DIM + d]
  for (let d = 0; d < VEC_DIM; d++) mu[d] /= Math.max(1, n)
  const nSeg = bounds.length - 1
  const sig: Float64Array[] = []
  for (let s = 0; s < nSeg; s++) {
    const v = new Float64Array(VEC_DIM)
    const a = bounds[s]
    const b = bounds[s + 1]
    for (let i = a; i < b; i++) for (let d = 0; d < VEC_DIM; d++) v[d] += vec[i * VEC_DIM + d] - mu[d]
    for (let d = 0; d < VEC_DIM; d++) v[d] /= Math.max(1, b - a)
    sig.push(v)
  }
  const cos = (a: Float64Array, b: Float64Array) => {
    let ab = 0
    let aa = 0
    let bb = 0
    for (let d = 0; d < VEC_DIM; d++) {
      ab += a[d] * b[d]
      aa += a[d] * a[d]
      bb += b[d] * b[d]
    }
    return aa > 1e-12 && bb > 1e-12 ? ab / Math.sqrt(aa * bb) : 0
  }
  const dst = (a: Float64Array, b: Float64Array) => {
    let s = 0
    for (let d = 0; d < VEC_DIM; d++) s += (a[d] - b[d]) * (a[d] - b[d])
    return Math.sqrt(s)
  }
  const protos: Array<{ sum: Float64Array; bars: number; first: number; label: string }> = []
  const labels: string[] = []
  const repeatOf: Array<number | undefined> = []
  const similarity: number[] = []
  for (let s = 0; s < nSeg; s++) {
    const len = bounds[s + 1] - bounds[s]
    let bestK = -1
    let bestCos = -2
    for (let k = 0; k < protos.length; k++) {
      const proto = Float64Array.from(protos[k].sum, (x) => x / protos[k].bars)
      const c = cos(sig[s], proto)
      if (c >= cosMin && dst(sig[s], proto) <= dMax && c > bestCos) {
        bestCos = c
        bestK = k
      }
    }
    if (bestK < 0) {
      const sum = Float64Array.from(sig[s], (x) => x * len)
      protos.push({ sum, bars: len, first: s, label: letter(protos.length) })
      labels.push(protos[protos.length - 1].label)
      repeatOf.push(undefined)
      similarity.push(1)
    } else {
      const p = protos[bestK]
      for (let d = 0; d < VEC_DIM; d++) p.sum[d] += sig[s][d] * len
      p.bars += len
      labels.push(p.label)
      repeatOf.push(p.first)
      similarity.push(bestCos)
    }
  }
  return { labels, repeatOf, similarity }
}

/* ------------------------------------------------------------------------------------------------
 * Event typing
 * ---------------------------------------------------------------------------------------------- */

export type PlanEventType = 'change' | 'drop' | 'buildStart' | 'breakdown'

export interface Typing {
  type: PlanEventType
  deltaLowDb: number
  deltaLevelDb: number
  levelSlope: number
  lowFluxRatio: number
}

/** A stretch whose level and high band (or onset density) climb: a riser / build. */
export function segmentRising(a: Agg, from: number, to: number): boolean {
  if (to - from < 3) return false
  return slope(a.levelDb, from, to) >= 0.2 && (slope(a.highDb, from, to) >= 0.3 || slope(a.flux, from, to) >= 0.03)
}

/**
 * Type the boundary at bar `i` from the level / bass / onset transitions across it. `prev` / `next` are the
 * neighbouring boundaries (0 / nBars at the ends).
 *  - `buildStart` the new section RISES (level and high band or onset density climb across up to 8 bars): a riser;
 *  - `drop`       bass energy returns (>= +6 dB over the two bars either side, low-band onsets at least 2x) into a
 *                  section that is not itself rising;
 *  - `breakdown`  bass and kick drop out (>= -5 dB, low-band onsets at most 60%);
 *  - `change`     everything else.
 */
export function typeBoundary(a: Agg, i: number, prev: number, next: number): Typing {
  const wb = Math.max(1, Math.min(4, i - prev))
  const wa = Math.max(1, Math.min(4, next - i))
  const b2 = Math.min(2, wb)
  const a2 = Math.min(2, wa)
  const lowB2 = meanRange(a.lowDb, i - b2, i)
  const lowA2 = meanRange(a.lowDb, i, i + a2)
  const dLow = lowA2 - lowB2
  const dLevel = meanRange(a.levelDb, i, i + wa) - meanRange(a.levelDb, i - wb, i)
  const lfB = meanRange(a.lowFlux, i - b2, i)
  const lfA = meanRange(a.lowFlux, i, i + a2)
  const lowFluxRatio = (lfA + 0.05) / (lfB + 0.05)
  const na = Math.min(8, next - i)
  const rising = segmentRising(a, i, i + na)
  const levelSlope = na >= 3 ? slope(a.levelDb, i, i + na) : 0
  let type: PlanEventType = 'change'
  if (rising) type = 'buildStart'
  else if (dLow >= 6 && lowFluxRatio >= 2) type = 'drop'
  else if (dLow <= -5 && lowFluxRatio < 0.6) type = 'breakdown'
  return { type, deltaLowDb: dLow, deltaLevelDb: dLevel, levelSlope, lowFluxRatio }
}

/**
 * Remove boundaries that sit INSIDE a build: both neighbouring segments rise and no bass returns across the
 * boundary. A riser's internal steps (hi-hats enter, a snare roll starts, the kick drops out) are not sections.
 * Repeats until stable; `bounds` includes 0 and nBars.
 */
export function mergeBuilds(a: Agg, bounds: number[]): number[] {
  const out = [...bounds]
  let changed = true
  while (changed) {
    changed = false
    for (let k = 1; k + 1 < out.length; k++) {
      const i = out[k]
      // judge each side on up to 8 bars next to the boundary (a long flat section after the build must not hide it)
      if (!segmentRising(a, Math.max(out[k - 1], i - 8), i) || !segmentRising(a, i, Math.min(out[k + 1], i + 8))) continue
      const dLow = meanRange(a.lowDb, i, i + 2) - meanRange(a.lowDb, i - 2, i)
      if (dLow >= 6) continue
      out.splice(k, 1)
      changed = true
      break
    }
  }
  return out
}

/**
 * Per-channel z contributions at a boundary: how large the shift of each family of features is relative to the
 * typical bar-to-bar shift of the same channel in this song (median absolute shift, MAD-style scaling).
 */
export function channelZ(vec: Float32Array, a: Agg, n: number, boundaries: number[]): EventFeats[] {
  const K = 4
  const shape = windowDistance(vec, n, K, 0, MEL_BANDS)
  const harm = windowDistance(vec, n, K, MEL_BANDS, MEL_BANDS + 12)
  const rhythm = windowDistance(vec, n, K, MEL_BANDS + 12, VEC_DIM)
  const winDiff = (arr: Float32Array, i: number) => {
    const ke = Math.min(K, i, n - i)
    if (ke < 1) return 0
    return Math.abs(meanRange(arr, i, i + ke) - meanRange(arr, i - ke, i))
  }
  const level = new Float64Array(n)
  const low = new Float64Array(n)
  for (let i = 1; i < n; i++) {
    level[i] = winDiff(a.levelDb, i)
    low[i] = winDiff(a.lowDb, i)
  }
  const scale = (x: Float64Array) => Math.max(1e-3, 1.4826 * median(Array.from(x).slice(1)))
  const sc = { level: scale(level), low: scale(low), timbre: scale(shape), harmony: scale(harm), rhythm: scale(rhythm) }
  return boundaries.map((i) => ({
    level: clamp(level[i] / sc.level, 0, 12),
    low: clamp(low[i] / sc.low, 0, 12),
    timbre: clamp(shape[i] / sc.timbre, 0, 12),
    harmony: clamp(harm[i] / sc.harmony, 0, 12),
    rhythm: clamp(rhythm[i] / sc.rhythm, 0, 12),
  }))
}


/**
 * How well bars cut at each of the four phases resolve section steps. For phase p the bar summaries are rebuilt and
 * the mean height of the 8 strongest, well-spaced 2-bar feature steps (timbre / rhythm / bass channel) is taken:
 * bars that straddle a boundary smear it over two bars, so the true phase scores highest (25% higher on the
 * synthetic suite; a few percent on real music, hence the modest confidence). Cheap: four bar aggregations.
 */
export function phaseAlignment(frames: FrameFeatures, env: Envelopes, beatFrames: number[]): PhaseAlignment {
  const scores: number[] = []
  for (let p = 0; p < 4; p++) {
    const n = Math.floor((beatFrames.length - 1 - p) / 4)
    if (n < 12) {
      scores.push(0)
      continue
    }
    const edges: number[] = []
    for (let k = 0; k <= n; k++) edges.push(beatFrames[p + 4 * k])
    const vec = featureVectors(aggregate(frames, env, edges))
    for (let k = 0; k < n; k++) for (let j = MEL_BANDS; j < MEL_BANDS + 12; j++) vec[k * VEC_DIM + j] = 0
    const d2 = windowDistance(vec, n, 2)
    const idx: number[] = []
    for (let i = 3; i <= n - 3; i++) if (d2[i] >= d2[i - 1] && d2[i] > d2[i + 1]) idx.push(i)
    const kept = suppress(idx, (i) => d2[i], 4).sort((a, b) => d2[b] - d2[a]).slice(0, 8)
    scores.push(kept.length ? kept.reduce((t, i) => t + d2[i], 0) / kept.length : 0)
  }
  const sorted = [...scores].sort((a, b) => b - a)
  const margin = sorted[1] > 1e-9 ? sorted[0] / sorted[1] : 1
  return { scores, confidence: clamp((margin - 1.02) / 0.08, 0, 1) }
}
