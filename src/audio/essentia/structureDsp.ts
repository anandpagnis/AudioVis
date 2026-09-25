/**
 * Pure song-structure DSP — self-similarity segmentation + a riser detector.
 * No essentia / tf imports, so it unit-tests in `environment: 'node'`.
 *
 * The worker turns a rolling PCM window into a beat-synchronous
 * `BeatCell[]` (HPCP + MFCC + scalar bands folded onto the engine beat grid),
 * then calls these functions. `structure.worker.ts` owns the essentia feature
 * extraction; this file owns the algorithm.
 *
 * Approach: MEAN-CENTRED cosine self-similarity matrices per feature block,
 * ASYMMETRIC checkerboard (Foote) novelty — long past context, short
 * `lookahead` future — at two past widths (fused — `dualKernelNovelty`), weighted
 * fusion across feature blocks in ABSOLUTE units, adaptive peak-pick behind an
 * absolute novelty floor → boundaries. Segment mean vectors → greedy repetition
 * letters. Kind labelling is deliberately minimal — `intro`/`outro` (position),
 * `breakdown` (quiet-and-tonal), everything else `section`; `build`/`drop` are the
 * riser's job.
 *
 * DELAY: a boundary at beat B needs `lookahead` (4) cells of "after" to be seen, so it
 * is reported once the live beat reaches ~B + 4 (the old symmetric 8/32-cell kernels
 * needed >= 8 / 32). Cross-batch persistence (a boundary must be seen in two
 * consecutive batches unless it is strong) lives in `StructureAnalyzer`, using
 * `confirmBoundaries` below.
 */
import type { SongSection } from '../types'
import type { StructureBuild, StructureSegment } from './structureProtocol'

export interface BeatCell {
  /** Absolute engine-grid beat index this cell covers. */
  beat: number
  /** 12-bin harmonic pitch-class profile, L2-normalised. Harmonic repetition. */
  hpcp: number[]
  /** MFCC coeffs 1..N (C0 dropped). Timbral change — the dominant EDM cue. */
  mfcc: number[]
  /** Normalised loudness in dB-ish units for slope maths. */
  logRms: number
  centroid: number
  flux: number
  flatness: number
  air: number
  sub: number
  bass: number
  mid: number
  high: number
  /** Rolling hi-hat/snare onset rate, 0..1 (`structure/onsetDensity.ts`). */
  onsetDensity: number
  /**
   * OPTIONAL, ADDITIVE (`audio/events`, the live change scorer; nothing in this file reads it): the beat's mean RAW,
   * un-normalised levels in dB, `[sub, bass, mid, presence, high, air, rms]` (`events/rawTap.ts`). Only differences
   * between beats are meaningful (gain-invariant use); the absolute dB scale depends on the analyser.
   */
  raw?: number[]
  /** OPTIONAL, ADDITIVE: the share (0..1) of this beat's frames that `f.silence` flagged. */
  silent?: number
}

export const STRUCTURE_DSP = {
  /** Symmetric checkerboard kernel half-width in beats (~4 bars). LEGACY: only
   * `checkerboardNovelty()` (kept for reference / tests / single-width callers)
   * still reads it; `segment()` no longer uses a symmetric kernel. */
  kernelHalfWidth: 16,
  /** Asymmetric-kernel FUTURE half-width in beats (1 bar) = the analysis lookahead: how much
   * "after" a boundary needs before it can be seen. The newest `lookahead - 1` cells of the
   * novelty curve are zeroed (was `M` = 8 / 32 for the symmetric kernels). Short on purpose: a
   * one-bar "after" is noisier, so the absolute floor + cross-batch persistence carry that. */
  lookahead: 4,
  /** Asymmetric-kernel PAST half-widths in beats, run in parallel and fused (short weighted 0.6).
   * 8 (2 bars) is the "what was the texture just before" scale for fast EDM-style cuts; 24
   * (6 bars) is a section-scale reference (an 8-bar phrase is 32 beats) that a 2-bar past is too
   * local to define, without reaching so far (the old 32) that it straddles the previous
   * section's own start on 16-beat sections. The past side is cheap to make long — only the
   * future side costs delay. */
  pastWidths: [8, 24] as readonly number[],
  /** Minimum segment length in beats. */
  minSegmentBeats: 8,
  /** Cosine ≥ this ⇒ two segments share a repetition letter. */
  repetitionTau: 0.86,
  /** Peak-pick: local median + this before a novelty peak counts (absolute novelty units). */
  peakDelta: 0.08,
  /** ABSOLUTE novelty floor: a peak below this is never a boundary, however far it stands above
   * the local median. `asymmetricCheckerboardNovelty` is on a fixed scale (1 = a perfect block
   * change), so a stationary passage — whose own peak used to be normalised UP to 1 — now
   * yields nothing. Offline over 30 PMEmo chorus clips + 16 Jamendo full tracks, real-music
   * candidate peaks are a continuum from ~0.1 to ~0.55 (noise-like beat-to-beat wobble alone
   * reaches ~0.15-0.2). Measured on 30 PMEmo clips: floor 0.22 -> 0.63 boundaries/clip (50% of clips with
   * one) but recall of loudness steps fell 73% -> 42%; 0.20 -> 0.97 (53%); 0.16 -> ~1.5 (80%). Set to 0.16
   * because a MISSED section change is the failure the user named (the old 3.5/clip was the noisy end, 0.22 the
   * deaf end); the persistence gate below still removes single-batch flickers between 0.16 and `strongBoundary`.
   * Raise toward 0.20-0.22 if live listening shows spurious section changes. A reasoned starting point. */
  noveltyFloor: 0.16,
  /** A candidate at or above this passes cross-batch persistence immediately (a clear change
   * needs no second look). ~1.6x the floor; roughly the top fifth of published candidates in the
   * offline corpora. A reasoned starting point: tune live. */
  strongBoundary: 0.35,
  /** Persistence: a candidate matches the previous batch's within this many beats. */
  persistTolBeats: 2,
  /** SSM sharpening exponent (sign-preserving |s|^gamma). 1 = off: gamma 2 was tried offline and
   * bought no better boundary/agreement trade-off than simply moving the floor. */
  ssmGamma: 1,
  /** Novelty-fusion weights. */
  fuse: { emb: 0, timbre: 0.55, harm: 0.2, scalar: 0.25 },
  /** Riser: enter/exit on this 0..1 score. */
  buildEnter: 0.55,
  buildExit: 0.4,
  /** Riser slope window in beats. */
  riserWindow: 24,
} as const

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

/** Cosine similarity of two equal-length vectors (0 when either is a zero vec). */
export function cosine(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na < 1e-12 || nb < 1e-12) return 0
  return dot / Math.sqrt(na * nb)
}

export interface SelfSimilarityOptions {
  /** Subtract each feature dimension's mean over the WHOLE list (the analysis window) before the
   * cosine. Non-negative features (band energies, chroma, 0..1 scalars) all point roughly the
   * same way, so raw cosines cluster near 1 and the block contrast is compressed; centring puts
   * "above/below this window's typical" on opposite sides of zero (a change reads as a NEGATIVE
   * cross-block similarity, not just a slightly smaller positive one). Default false. */
  center?: boolean
  /** Sign-preserving sharpening exponent: s -> sign(s) * |s|^gamma. > 1 suppresses the weak,
   * noisy similarities relative to strong ones. Default 1 (off). */
  gamma?: number
}

/** A (centred) vector shorter than this is treated as "no direction" (zero similarity), the same
 * guard `cosine()` applies to raw vectors (squared norm < 1e-12) — a perfectly stationary window
 * centres to exactly zero and must give an identity matrix, not amplified float noise. */
const MIN_NORM = 1e-6

/**
 * Cosine self-similarity matrix over a list of feature vectors (unit diagonal, symmetric). Each
 * vector is normalised once up front, so the O(n²) pass is dot products only. Zero / degenerate
 * vectors are similar to nothing but themselves (0 off-diagonal, 1 on it).
 */
export function selfSimilarity(vectors: number[][], opts: SelfSimilarityOptions = {}): number[][] {
  const n = vectors.length
  const m: number[][] = Array.from({ length: n }, () => new Array(n).fill(0))
  if (n === 0) return m
  const d = vectors[0].length
  const mean = new Float64Array(d)
  if (opts.center) {
    for (const v of vectors) for (let k = 0; k < d; k++) mean[k] += v[k]
    for (let k = 0; k < d; k++) mean[k] /= n
  }
  const z = new Float64Array(n * d)
  const live = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const v = vectors[i]
    let nn = 0
    for (let k = 0; k < d; k++) {
      const x = v[k] - mean[k]
      z[i * d + k] = x
      nn += x * x
    }
    const norm = Math.sqrt(nn)
    if (norm >= MIN_NORM) {
      live[i] = 1
      const inv = 1 / norm
      for (let k = 0; k < d; k++) z[i * d + k] *= inv
    }
  }
  const gamma = opts.gamma ?? 1
  for (let i = 0; i < n; i++) {
    m[i][i] = 1
    if (!live[i]) continue
    const oi = i * d
    for (let j = i + 1; j < n; j++) {
      if (!live[j]) continue
      const oj = j * d
      let dot = 0
      for (let k = 0; k < d; k++) dot += z[oi + k] * z[oj + k]
      if (gamma !== 1) dot = dot < 0 ? -Math.pow(-dot, gamma) : Math.pow(dot, gamma)
      m[i][j] = dot
      m[j][i] = dot
    }
  }
  return m
}

/**
 * Checkerboard (Foote) novelty along an SSM diagonal. `K(a,b) = sign(a·b) ·
 * exp(-(a²+b²)/(2σ²))`, σ = halfWidth/2, summed over the ±halfWidth window
 * centred on each frame; edges are clamped. Returns a 0..1 curve (running-max
 * normalised).
 */
export function checkerboardNovelty(
  ssm: number[][],
  halfWidth: number = STRUCTURE_DSP.kernelHalfWidth,
): number[] {
  const n = ssm.length
  const M = Math.min(halfWidth, Math.max(2, Math.floor(n / 2) - 1))
  const sigma = M / 2
  // Precompute the kernel.
  const size = 2 * M + 1
  const kernel: number[][] = Array.from({ length: size }, () => new Array(size).fill(0))
  for (let a = -M; a <= M; a++) {
    for (let b = -M; b <= M; b++) {
      // The centre row/col sit ON the seam and must contribute 0, otherwise the
      // positive and negative quadrants no longer cancel on a uniform matrix.
      const sign = a === 0 || b === 0 ? 0 : a * b > 0 ? 1 : -1
      kernel[a + M][b + M] = sign * Math.exp(-(a * a + b * b) / (2 * sigma * sigma))
    }
  }
  const nov = new Array(n).fill(0)
  for (let i = 0; i < n; i++) {
    let acc = 0
    for (let a = -M; a <= M; a++) {
      const ii = i + a
      if (ii < 0 || ii >= n) continue
      for (let b = -M; b <= M; b++) {
        const jj = i + b
        if (jj < 0 || jj >= n) continue
        acc += kernel[a + M][b + M] * ssm[ii][jj]
      }
    }
    nov[i] = Math.max(0, acc)
  }
  // The kernel's positive/negative quadrants only cancel with a FULL window, so
  // the clamped edges carry a large artefact. Zero the outer M cells — a
  // boundary in the first/last few bars of a streaming window is unreliable
  // anyway (no future context) — then normalise over the trustworthy interior.
  for (let i = 0; i < n; i++) if (i < M || i >= n - M) nov[i] = 0
  let peak = 0
  for (const v of nov) if (v > peak) peak = v
  if (peak > 1e-9) for (let i = 0; i < n; i++) nov[i] /= peak
  return nov
}

/**
 * Distance weights for one side of an asymmetric kernel: `len` cells at distances 0.5 … len-0.5
 * from the seam, Gaussian with the given sigma, normalised to sum 1 (so the two sides of the
 * kernel always carry EQUAL total weight and a uniform matrix cancels exactly, whatever the
 * side lengths).
 */
function halfWeights(len: number, sigma: number): Float64Array {
  const w = new Float64Array(len)
  let sum = 0
  for (let d = 0; d < len; d++) {
    const x = d + 0.5
    w[d] = Math.exp(-(x * x) / (2 * sigma * sigma))
    sum += w[d]
  }
  for (let d = 0; d < len; d++) w[d] /= sum
  return w
}

/** Fewest past cells a seam needs before a kernel of past width `past` may score it: half the
 * kernel, but never under 8 (2 bars — the shortest "before" that is a texture rather than a
 * couple of beats; it also keeps a track's first few warm-up cells, where the chroma/
 * loudness estimators are still settling, from reading as a boundary). Seams closer to the
 * window start than that are zeroed; between this and `past` the past side is truncated and
 * re-normalised. */
export function minPastFor(past: number): number {
  return Math.min(past, Math.max(8, past >> 1))
}

/**
 * ASYMMETRIC checkerboard (Foote) novelty on an SSM, on a FIXED ABSOLUTE scale.
 *
 * The novelty at cell `i` is scored at the SEAM between cells i-1 and i: the "past" block is the
 * `past` cells before the seam (Gaussian-weighted, sigma past/2, so nearer cells count more) and
 * the "future" block is the `future` cells from `i` on (sigma `future`, i.e. near-flat).
 * novelty = (within-past + within-future − 2·cross) / max, over off-diagonal pairs, each side's
 * weights summing to 1, so:
 *   - a uniform / stationary matrix scores exactly 0 (the two sides cancel),
 *   - a perfect block change (within-block similarity 1, across-seam similarity −1) scores 1,
 *   - a change whose across-seam similarity is 0 (non-centred SSM) tops out near 0.5.
 * Negative scores are clamped to 0. Unlike `checkerboardNovelty` this curve is NOT normalised by
 * its own peak — that is what lets `pickBoundaries` apply an absolute floor.
 *
 * DELAY: a seam needs `future` cells after it, so only the newest `future - 1` entries are zeroed
 * (`i > n - future`) — versus the symmetric kernel's `M` newest. A step at cell B is fully seen
 * from cell B + future - 1 on, and picked as a peak one cell later (the peak needs a
 * neighbour): ~`future` beats of lag. The oldest `minPastFor(past)` seams are zeroed too.
 */
export function asymmetricCheckerboardNovelty(
  ssm: number[][],
  past: number,
  future: number = STRUCTURE_DSP.lookahead,
): number[] {
  const n = ssm.length
  const out: number[] = new Array(n).fill(0)
  past = Math.floor(past)
  future = Math.floor(future)
  if (past < 1 || future < 1 || n < 2) return out
  const minPast = minPastFor(past)
  const wf = halfWeights(future, future)
  let sf2 = 0
  for (let k = 0; k < future; k++) sf2 += wf[k] * wf[k]
  const wpTable: Float64Array[] = []
  const sp2: number[] = []
  for (let len = minPast; len <= past; len++) {
    const w = halfWeights(len, past / 2)
    wpTable[len] = w
    let s = 0
    for (let k = 0; k < len; k++) s += w[k] * w[k]
    sp2[len] = s
  }
  for (let i = minPast; i <= n - future; i++) {
    const len = Math.min(past, i)
    const wp = wpTable[len]
    let pp = 0
    let pf = 0
    for (let a = 0; a < len; a++) {
      const row = ssm[i - 1 - a]
      let within = 0
      for (let b = a + 1; b < len; b++) within += wp[b] * row[i - 1 - b]
      pp += 2 * wp[a] * within
      let cross = 0
      for (let b = 0; b < future; b++) cross += wf[b] * row[i + b]
      pf += wp[a] * cross
    }
    let ff = 0
    for (let a = 0; a < future; a++) {
      const row = ssm[i + a]
      let within = 0
      for (let b = a + 1; b < future; b++) within += wf[b] * row[i + b]
      ff += 2 * wf[a] * within
    }
    const v = (pp + ff - 2 * pf) / (4 - sp2[len] - sf2)
    out[i] = v > 0 ? v : 0
  }
  return out
}

/**
 * Two (or more) asymmetric-checkerboard novelty curves at different PAST widths (same short
 * `future`), fused into one on the same ABSOLUTE scale (no peak normalisation — a fused value of
 * 0.3 means the same thing on every window, which the novelty floor relies on). A single kernel
 * width forces a trade-off between catching fast, local cuts (needs a short past) and
 * section-scale boundaries (a longer past defines "the section so far" better) — running both
 * in parallel and fusing avoids picking one at the other's expense.
 *
 * Weighting: the shortest width gets 0.6, the rest split the remaining 0.4 evenly (0.4 for the
 * canonical `[8, 24]`). The short scale is favoured because fast cuts are the more commonly
 * missed failure mode (EDM-scale cuts in a couple of bars) while a slow verse/chorus change is a
 * large sustained discontinuity that even the short scale still sees. A scale that is not yet
 * usable at a seam (too close to the window start, see `minPastFor`) drops out and the rest are
 * re-weighted, so early windows are not deflated. With one width this is exactly
 * `asymmetricCheckerboardNovelty` at that width.
 */
export function dualKernelNovelty(
  ssm: number[][],
  pastWidths: readonly number[] = STRUCTURE_DSP.pastWidths,
  future: number = STRUCTURE_DSP.lookahead,
): number[] {
  const k = pastWidths.length
  if (k === 0) return []
  if (k === 1) return asymmetricCheckerboardNovelty(ssm, pastWidths[0], future)
  const order = pastWidths.map((w, i) => ({ w, i })).sort((a, b) => a.w - b.w)
  const weights = new Array(k).fill(0)
  weights[order[0].i] = 0.6
  const rest = 0.4 / (k - 1)
  for (let j = 1; j < k; j++) weights[order[j].i] = rest
  const curves = pastWidths.map((w) => asymmetricCheckerboardNovelty(ssm, w, future))
  const starts = pastWidths.map((w) => minPastFor(Math.floor(w)))
  const n = ssm.length
  const out: number[] = new Array(n).fill(0)
  for (let i = 0; i < n; i++) {
    let acc = 0
    let wSum = 0
    for (let j = 0; j < k; j++) {
      if (i < starts[j]) continue
      acc += curves[j][i] * weights[j]
      wSum += weights[j]
    }
    out[i] = wSum > 0 ? acc / wSum : 0
  }
  return out
}

/** Weighted sum of novelty curves (each same length). Re-normalised to a unit peak by default;
 * pass `normalize = false` to keep the ABSOLUTE scale (what `segment()` does — the absolute
 * novelty floor needs it). */
export function fuseNovelty(
  curves: { curve: number[]; weight: number }[],
  normalize = true,
): number[] {
  const usable = curves.filter((c) => c.weight > 0 && c.curve.length > 0)
  if (usable.length === 0) return []
  const n = usable[0].curve.length
  const wSum = usable.reduce((s, c) => s + c.weight, 0)
  const out = new Array(n).fill(0)
  for (const { curve, weight } of usable) {
    for (let i = 0; i < n && i < curve.length; i++) out[i] += (curve[i] * weight) / wSum
  }
  if (!normalize) return out
  let peak = 0
  for (const v of out) if (v > peak) peak = v
  if (peak > 1e-9) for (let i = 0; i < n; i++) out[i] /= peak
  return out
}

function median(vals: number[]): number {
  if (vals.length === 0) return 0
  const s = [...vals].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/**
 * Adaptive peak-pick on a fused novelty curve. A local maximum counts as a
 * boundary when it (a) reaches the ABSOLUTE `floor` (default `noveltyFloor`; the curve is on
 * a fixed scale, so a stationary passage has no peak that clears it however sharp it looks
 * against its own noise), (b) exceeds `median(window) + peakDelta`, and (c) is at least
 * `minGap` beats after the previous kept peak. `cellBeats[i]` maps curve index → absolute
 * engine beat; `strength` is the curve value (absolute units).
 *
 * `end` (exclusive) is where the curve stops being SCORED: entries at `>= end` are the
 * zeroed lookahead tail, not evidence. A peak needs a genuinely scored, lower right-hand
 * neighbour, so the last scored entry (`end - 1`) can never itself be picked — otherwise a
 * still-rising edge would be reported against the zero tail with only part of its lookahead.
 */
export function pickBoundaries(
  novelty: number[],
  cellBeats: number[],
  minGap: number = STRUCTURE_DSP.minSegmentBeats,
  delta: number = STRUCTURE_DSP.peakDelta,
  floor: number = STRUCTURE_DSP.noveltyFloor,
  end: number = novelty.length,
): { beat: number; strength: number }[] {
  const n = novelty.length
  const out: { beat: number; strength: number }[] = []
  const w = Math.max(4, Math.round(minGap * 1.5))
  let lastBeat = -Infinity
  for (let i = 1; i < Math.min(n, end) - 1; i++) {
    if (novelty[i] < floor) continue
    if (novelty[i] <= novelty[i - 1] || novelty[i] < novelty[i + 1]) continue
    const lo = Math.max(0, i - w)
    const hi = Math.min(n, i + w + 1)
    const thresh = median(novelty.slice(lo, hi)) + delta
    if (novelty[i] < thresh) continue
    const beat = cellBeats[i]
    if (beat - lastBeat < minGap) {
      // Keep the stronger of the two close peaks.
      if (out.length && novelty[i] > out[out.length - 1].strength) {
        out[out.length - 1] = { beat, strength: novelty[i] }
        lastBeat = beat
      }
      continue
    }
    out.push({ beat, strength: novelty[i] })
    lastBeat = beat
  }
  return out
}

/**
 * Greedy online repetition labelling. For each segment mean-vector, assign the
 * letter of the first existing cluster with `cosine > tau`, else a new letter
 * (A..F, then `'?'`).
 */
export function labelRepetitions(
  segmentVectors: number[][],
  tau: number = STRUCTURE_DSP.repetitionTau,
): string[] {
  const letters = ['A', 'B', 'C', 'D', 'E', 'F']
  const centroids: number[][] = []
  const out: string[] = []
  for (const v of segmentVectors) {
    let assigned = -1
    for (let k = 0; k < centroids.length; k++) {
      if (cosine(v, centroids[k]) > tau) {
        assigned = k
        break
      }
    }
    if (assigned < 0) {
      assigned = centroids.length
      centroids.push(v.slice())
    }
    out.push(assigned < letters.length ? letters[assigned] : '?')
  }
  return out
}

/**
 * Minimal kind labelling — only what is acoustically defensible without a model.
 * `intro` = first segment starting near beat 0 and below-median energy;
 * `outro` = last segment with energy falling and below-median; `breakdown` =
 * quiet (< 45 % of the loudest segment) AND tonal (low flatness); everything
 * else `section`. `build`/`drop` are never emitted here — the riser + `f.drop`
 * own them in `SectionTracker`. A trailing segment shorter than `minSegmentBeats` is never
 * `outro`: with the ~4-beat lookahead the newest boundary can sit only a few beats behind the
 * live edge, and a few quiet beats at the window edge are not the song's end.
 */
export function classifyKinds(
  segments: { startBeat: number; endBeat: number; meanEnergy: number; meanFlatness: number }[],
  firstBeat: number,
): SongSection[] {
  const n = segments.length
  if (n === 0) return []
  const energies = segments.map((s) => s.meanEnergy)
  const maxE = Math.max(...energies, 1e-6)
  const medE = median(energies)
  const out: SongSection[] = new Array(n).fill('section')
  for (let i = 0; i < n; i++) {
    const s = segments[i]
    if (
      i === 0 &&
      s.startBeat - firstBeat <= STRUCTURE_DSP.minSegmentBeats &&
      s.meanEnergy <= medE
    ) {
      out[i] = 'intro'
      continue
    }
    if (
      i === n - 1 &&
      s.endBeat - s.startBeat >= STRUCTURE_DSP.minSegmentBeats &&
      s.meanEnergy <= medE &&
      (n < 2 || s.meanEnergy < segments[i - 1].meanEnergy)
    ) {
      out[i] = 'outro'
      continue
    }
    if (s.meanEnergy < 0.45 * maxE && s.meanFlatness < 0.35) out[i] = 'breakdown'
  }
  return out
}

function slope(vals: number[]): number {
  // Least-squares slope per index, normalised to "per window".
  const n = vals.length
  if (n < 3) return 0
  const mx = (n - 1) / 2
  let my = 0
  for (const v of vals) my += v
  my /= n
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    num += (i - mx) * (vals[i] - my)
    den += (i - mx) * (i - mx)
  }
  return den < 1e-9 ? 0 : (num / den) * (n - 1)
}

/**
 * Riser / build-up read over the last `riserWindow` beat cells. Weighted sum of
 * six normalised acoustic slopes (centroid, RMS, noise-sweep, hat/onset
 * acceleration, kick dropout, high-band rise); `beatsTillDrop` projects the
 * RMS slope to a ~0.95 ceiling and snaps to the nearest upcoming 8/16/32-beat
 * grid target from the build's start. The worker reports these numbers;
 * `SectionTracker` owns the latch/release.
 *
 * `enter` is the score above which the read is `active` (default
 * `buildEnter`). A caller that re-reads the riser every beat and already has an
 * active build in flight passes the lower `buildExit` so the read has
 * hysteresis instead of flickering around a single threshold.
 */
export function riserScore(
  cells: BeatCell[],
  buildStartBeat: number,
  window: number = STRUCTURE_DSP.riserWindow,
  enter: number = STRUCTURE_DSP.buildEnter,
): StructureBuild {
  const w = cells.slice(-window)
  if (w.length < 8) {
    return { active: false, score: 0, progress: 0, beatsTillDrop: -1, startBeat: -1 }
  }
  const norm = (s: number, scale: number) => clamp01(s / scale)

  const centroidRise = norm(slope(w.map((c) => c.centroid)), 0.35)
  const rmsRise = norm(slope(w.map((c) => c.logRms)), 0.3)
  const flatRise = slope(w.map((c) => c.flatness))
  const airRise = slope(w.map((c) => c.air))
  const noiseSweep = norm(Math.min(flatRise, airRise) * 2, 0.3)
  // Genuine multi-band term: a rising HIGH band specifically, not just a
  // rising broadband centroid. Centroid can rise from the low end quieting
  // down just as easily as from the top end brightening up; `high` isolates
  // the "sweep/riser synth climbing into the top octave" case a broadband
  // read dilutes. Same 0..1 domain as `centroid`, so the same slope scale.
  const highRise = norm(slope(w.map((c) => c.high)), 0.35)

  // Hat-acceleration read: blended, not fully replaced. The flux early/late
  // split is a crude proxy (it can't tell a genuine accelerating onset rate
  // from a broadband loudness ramp that happens to fall unevenly across the
  // window) but it needs nothing but the spectrum already read every frame,
  // so it still fires even before/without onset-density data available. The
  // new `onsetDensity` term is the direct signal the plan calls for (a
  // rising onset RATE is a much less ambiguous "snare roll" cue than a flux
  // split), so it gets equal weight in the blend once it *is* available;
  // when it isn't (flat/zero onsetDensity, e.g. before a caller wires the
  // tracker in), the flux term alone still carries the read rather than the
  // whole cue going to zero.
  const half = w.length >> 1
  const fluxEarly = w.slice(0, half).reduce((a, c) => a + c.flux, 0) / half
  const fluxLate = w.slice(half).reduce((a, c) => a + c.flux, 0) / (w.length - half)
  const fluxAccel = norm(fluxLate - fluxEarly, 0.25)
  const onsetAccel = norm(slope(w.map((c) => c.onsetDensity)), 0.4)
  const hatAccel = clamp01(0.5 * fluxAccel + 0.5 * onsetAccel)

  const lowSlope = slope(w.map((c) => c.sub + c.bass))
  const kickDropout = lowSlope < 0 && slope(w.map((c) => c.logRms)) > 0 ? norm(-lowSlope, 0.4) : 0

  // Rebalanced to make room for `highRise` without letting any one term
  // dominate: each of the five original terms was shaved down proportionally
  // (0.22->0.18, 0.22->0.20, 0.2->0.17, 0.18->0.15, 0.18->0.15) so the new
  // 0.15-weighted term still sums to exactly 1.0 — a deliberate choice over
  // just tacking `highRise` on top uncapped, which would have let the total
  // run past 1 well before `buildEnter`/`buildExit` intended, and over
  // leaving the weights lopsided (previously 0.22 vs 0.18 was already a
  // mild "trust broadband/RMS slightly more" bias; the new spread, 0.15-0.20,
  // is flatter across six now-more-equally-informative terms).
  const score = clamp01(
    centroidRise * 0.18 +
      rmsRise * 0.2 +
      noiseSweep * 0.17 +
      hatAccel * 0.15 +
      kickDropout * 0.15 +
      highRise * 0.15,
  )
  const active = score > enter
  if (!active) {
    return { active: false, score, progress: 0, beatsTillDrop: -1, startBeat: -1 }
  }

  const endBeat = w[w.length - 1].beat
  const start = buildStartBeat >= 0 ? buildStartBeat : endBeat - w.length
  const rmsNow = w[w.length - 1].logRms
  const rmsSlopePerBeat = slope(w.map((c) => c.logRms)) / w.length
  let byProjection = 24
  if (rmsSlopePerBeat > 1e-4) byProjection = Math.max(1, (0.95 - rmsNow) / rmsSlopePerBeat)
  // Nearest upcoming 8/16/32-beat grid target from the build start.
  const elapsed = endBeat - start
  const grid = [8, 16, 32].map((g) => g - (elapsed % g)).filter((d) => d >= 1)
  const byGrid = grid.length ? Math.min(...grid) : 16
  const beatsTillDrop = Math.round(Math.min(48, Math.max(1, Math.min(byProjection, byGrid))))
  const progress = clamp01(Math.max(score, elapsed / (elapsed + beatsTillDrop + 1e-6)))

  return { active: true, score, progress, beatsTillDrop, startBeat: start }
}

export interface DetectBoundariesOptions {
  /** Mean-centre the feature dimensions before the cosine (default true). */
  center?: boolean
  /** SSM sharpening exponent (default `STRUCTURE_DSP.ssmGamma`). */
  gamma?: number
  /** Absolute novelty floor for the peak-pick (default `STRUCTURE_DSP.noveltyFloor`). */
  floor?: number
  /** Asymmetric-kernel past widths (default `STRUCTURE_DSP.pastWidths`). */
  pastWidths?: readonly number[]
  /** Asymmetric-kernel future half-width = lookahead in beats (default `STRUCTURE_DSP.lookahead`). */
  lookahead?: number
}

/**
 * The boundary half of segmentation: build the three mean-centred SSMs, compute each one's
 * dual-scale asymmetric novelty (`dualKernelNovelty`), fuse across blocks in absolute units, pick
 * boundaries behind the absolute floor. `novelty` is the fused ABSOLUTE curve (not peak-
 * normalised: 0 = nothing changes here, ~1 = a textbook block change), aligned to `cells`.
 * Empty below `2 * minSegmentBeats` cells.
 */
export function detectBoundaries(
  cells: BeatCell[],
  opts: DetectBoundariesOptions = {},
): { novelty: number[]; boundaries: { beat: number; strength: number }[] } {
  const n = cells.length
  if (n < STRUCTURE_DSP.minSegmentBeats * 2) return { novelty: [], boundaries: [] }
  const center = opts.center ?? true
  const gamma = opts.gamma ?? STRUCTURE_DSP.ssmGamma
  const pastWidths = opts.pastWidths ?? STRUCTURE_DSP.pastWidths
  const lookahead = opts.lookahead ?? STRUCTURE_DSP.lookahead
  const cellBeats = cells.map((c) => c.beat)
  const ssmOpts = { center, gamma }
  const timbreSsm = selfSimilarity(cells.map((c) => c.mfcc), ssmOpts)
  const harmSsm = selfSimilarity(cells.map((c) => c.hpcp), ssmOpts)
  const scalarSsm = selfSimilarity(
    cells.map((c) => [c.logRms, c.centroid, c.flatness, c.air, c.sub, c.bass, c.flux]),
    ssmOpts,
  )
  const novelty = fuseNovelty(
    [
      { curve: dualKernelNovelty(timbreSsm, pastWidths, lookahead), weight: STRUCTURE_DSP.fuse.timbre },
      { curve: dualKernelNovelty(harmSsm, pastWidths, lookahead), weight: STRUCTURE_DSP.fuse.harm },
      { curve: dualKernelNovelty(scalarSsm, pastWidths, lookahead), weight: STRUCTURE_DSP.fuse.scalar },
    ],
    false,
  )
  const boundaries = pickBoundaries(
    novelty,
    cellBeats,
    STRUCTURE_DSP.minSegmentBeats,
    STRUCTURE_DSP.peakDelta,
    opts.floor ?? STRUCTURE_DSP.noveltyFloor,
    n - lookahead + 1, // the last scored seam is n - lookahead (see asymmetricCheckerboardNovelty)
  )
  return { novelty, boundaries }
}

/**
 * Cross-batch persistence filter. A candidate boundary from THIS batch is published when it is
 * at least `strong` (a clear change needs no second look) OR the PREVIOUS batch also had a
 * candidate within `tol` beats of it (same physical boundary seen twice, so a one-bar timbral
 * blip that the next batch no longer sees is not published). Returns the surviving candidates in
 * their input order. `previous` is the previous batch's candidate beats BEFORE filtering.
 */
export function confirmBoundaries(
  candidates: readonly { beat: number; strength: number }[],
  previous: readonly number[],
  strong: number = STRUCTURE_DSP.strongBoundary,
  tol: number = STRUCTURE_DSP.persistTolBeats,
): { beat: number; strength: number }[] {
  return candidates.filter(
    (c) => c.strength >= strong || previous.some((p) => Math.abs(p - c.beat) <= tol),
  )
}

/**
 * Cut a beat-cell window into segments at `boundaryBeats` (plus the window ends), then label
 * repetitions + kinds. Split out of `segment()` so `StructureAnalyzer` can cut at the boundaries
 * that SURVIVED persistence rather than at every raw candidate.
 */
export function cutSegments(cells: BeatCell[], boundaryBeats: readonly number[]): StructureSegment[] {
  const n = cells.length
  if (n === 0) return []
  const cellBeats = cells.map((c) => c.beat)
  const cutBeats = [cellBeats[0], ...boundaryBeats, cellBeats[n - 1] + 1]
  const raw: {
    startBeat: number
    endBeat: number
    meanEnergy: number
    meanFlatness: number
    vec: number[]
  }[] = []
  for (let k = 0; k < cutBeats.length - 1; k++) {
    const a = cutBeats[k]
    const b = cutBeats[k + 1]
    const inSeg = cells.filter((c) => c.beat >= a && c.beat < b)
    if (inSeg.length === 0) continue
    const meanEnergy = inSeg.reduce((s, c) => s + c.logRms, 0) / inSeg.length
    const meanFlatness = inSeg.reduce((s, c) => s + c.flatness, 0) / inSeg.length
    const dim = inSeg[0].mfcc.length + inSeg[0].hpcp.length
    const vec = new Array(dim).fill(0)
    for (const c of inSeg) {
      const cat = [...c.mfcc, ...c.hpcp]
      for (let d = 0; d < dim; d++) vec[d] += cat[d] / inSeg.length
    }
    raw.push({ startBeat: a, endBeat: b, meanEnergy, meanFlatness, vec })
  }

  const letters = labelRepetitions(raw.map((s) => s.vec))
  const kinds = classifyKinds(raw, cellBeats[0])
  return raw.map((s, i) => ({
    startBeat: s.startBeat,
    endBeat: s.endBeat,
    kind: kinds[i],
    repetitionLabel: letters[i],
    meanEnergy: clamp01(s.meanEnergy),
    meanFlatness: clamp01(s.meanFlatness),
  }))
}

/**
 * Full segmentation from a beat-cell window: `detectBoundaries` (every candidate that clears the
 * absolute floor — NO cross-batch persistence here, that needs the previous batch and lives in
 * `StructureAnalyzer`) then `cutSegments`.
 */
export function segment(cells: BeatCell[]): {
  novelty: number[]
  boundaries: { beat: number; strength: number }[]
  segments: StructureSegment[]
} {
  if (cells.length < STRUCTURE_DSP.minSegmentBeats * 2) {
    return { novelty: [], boundaries: [], segments: [] }
  }
  const { novelty, boundaries } = detectBoundaries(cells)
  return { novelty, boundaries, segments: cutSegments(cells, boundaries.map((b) => b.beat)) }
}
