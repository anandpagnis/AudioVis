/**
 * Pure metrics for scoring section-boundary / event detectors (plan phase 0B). No dependencies, no Python:
 * everything is implemented from the definitions so it runs offline under vitest.
 *
 * CONVENTIONS
 * - Times are seconds on one shared clock; bars are 4 beats (`barSec(bpm) = 240 / bpm`).
 * - MATCHING is ONE-TO-ONE and OPTIMAL: among the (truth, detection) pairs whose signed lag
 *   `det - truth` lies inside the tolerance window, we take a maximum-cardinality matching and, among those,
 *   the one with the smallest total |lag| (Hungarian / Kuhn-Munkres on the feasible pairs). A greedy
 *   nearest-first match can lose hits when one detection is the nearest to two truths; this cannot.
 *   `mir_eval` uses a Hopcroft-Karp maximum matching, which has the same cardinality (hence identical
 *   precision / recall / F); the two can differ only in WHICH equal-size pairing they choose (lag stats).
 * - A tolerance is a number (symmetric, `|lag| <= tol`, inclusive) or `{ before, after }` (asymmetric: a
 *   detection may lead the truth by up to `before` and lag it by up to `after`; causal detectors want
 *   `after > before`).
 * - Duplicate detections of one truth: one matches, the rest are unmatched, i.e. FALSE ALARMS.
 * - Ratios with an empty denominator are 0 in precision / recall / F (the mir_eval convention; read `nTruth`
 *   and `nDet` to tell "nothing to find" from "found nothing"). Distribution statistics of an empty sample
 *   (lag, interval) are NaN.
 * - Percentiles use linear interpolation between order statistics (numpy's default).
 */
import type { TruthEvent, TruthEventType } from './synthSong'

export type Tolerance = number | { before: number; after: number }

const EPS = 1e-9

/** Seconds in one 4-beat bar. */
export const barSec = (bpm: number): number => 240 / bpm
/** `bars` bars in seconds. */
export const barsToSec = (bars: number, bpm: number): number => bars * barSec(bpm)

function toWindow(tol: Tolerance): { before: number; after: number } {
  return typeof tol === 'number' ? { before: tol, after: tol } : tol
}

export interface MatchedPair {
  truthIndex: number
  detIndex: number
  truth: number
  det: number
  /** `det - truth`: positive = the detection came AFTER the truth. */
  lag: number
}

export interface MatchResult {
  pairs: MatchedPair[]
  /** Indices (into the input arrays) that found no partner. */
  unmatchedTruth: number[]
  unmatchedDet: number[]
}

/** Kuhn-Munkres for an n x m cost matrix with n <= m; returns the column assigned to each row. */
function hungarian(cost: number[][]): number[] {
  const n = cost.length
  const m = cost[0].length
  const u = new Float64Array(n + 1)
  const v = new Float64Array(m + 1)
  const p = new Int32Array(m + 1)
  const way = new Int32Array(m + 1)
  for (let i = 1; i <= n; i++) {
    p[0] = i
    let j0 = 0
    const minv = new Float64Array(m + 1).fill(Infinity)
    const used = new Uint8Array(m + 1)
    do {
      used[j0] = 1
      const i0 = p[j0]
      let delta = Infinity
      let j1 = 0
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j]
        if (cur < minv[j]) {
          minv[j] = cur
          way[j] = j0
        }
        if (minv[j] < delta) {
          delta = minv[j]
          j1 = j
        }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          u[p[j]] += delta
          v[j] -= delta
        } else {
          minv[j] -= delta
        }
      }
      j0 = j1
    } while (p[j0] !== 0)
    do {
      const j1 = way[j0]
      p[j0] = p[j1]
      j0 = j1
    } while (j0 !== 0)
  }
  const ans = new Array<number>(n).fill(-1)
  for (let j = 1; j <= m; j++) if (p[j] !== 0) ans[p[j] - 1] = j - 1
  return ans
}

/**
 * One-to-one matching of detections to truth events inside `tol`: maximum cardinality, then minimum total
 * |lag| (see the module header). Inputs need not be sorted; indices in the result refer to the inputs.
 */
export function matchEvents(truth: readonly number[], det: readonly number[], tol: Tolerance): MatchResult {
  const { before, after } = toWindow(tol)
  const feasible = (t: number, d: number) => d - t <= after + EPS && d - t >= -before - EPS
  // Reduce to the candidates that can matter: a truth with no feasible detection (or vice versa) never pairs.
  const tCand: number[] = []
  const dCandSet = new Set<number>()
  const cand: number[][] = []
  for (let i = 0; i < truth.length; i++) {
    const ds: number[] = []
    for (let j = 0; j < det.length; j++) if (feasible(truth[i], det[j])) ds.push(j)
    if (ds.length > 0) {
      tCand.push(i)
      cand.push(ds)
      for (const j of ds) dCandSet.add(j)
    }
  }
  const dCand = [...dCandSet].sort((a, b) => a - b)
  const pairs: MatchedPair[] = []
  if (tCand.length > 0) {
    const dPos = new Map(dCand.map((j, k) => [j, k]))
    const tolMax = Math.max(before, after)
    const big = (Math.min(tCand.length, dCand.length) + 1) * (tolMax + 1) + 1
    // rows = the smaller side (the algorithm needs rows <= columns)
    const truthRows = tCand.length <= dCand.length
    const nr = truthRows ? tCand.length : dCand.length
    const nc = truthRows ? dCand.length : tCand.length
    const cost: number[][] = Array.from({ length: nr }, () => new Array<number>(nc).fill(big))
    for (let a = 0; a < tCand.length; a++) {
      for (const j of cand[a]) {
        const k = dPos.get(j) as number
        const c = Math.abs(det[j] - truth[tCand[a]])
        if (truthRows) cost[a][k] = c
        else cost[k][a] = c
      }
    }
    const assign = hungarian(cost)
    for (let r = 0; r < nr; r++) {
      const c = assign[r]
      if (c < 0 || cost[r][c] >= big) continue
      const ti = truthRows ? tCand[r] : tCand[c]
      const di = truthRows ? dCand[c] : dCand[r]
      pairs.push({ truthIndex: ti, detIndex: di, truth: truth[ti], det: det[di], lag: det[di] - truth[ti] })
    }
    pairs.sort((a, b) => a.truthIndex - b.truthIndex)
  }
  const tUsed = new Set(pairs.map((p) => p.truthIndex))
  const dUsed = new Set(pairs.map((p) => p.detIndex))
  return {
    pairs,
    unmatchedTruth: truth.map((_, i) => i).filter((i) => !tUsed.has(i)),
    unmatchedDet: det.map((_, i) => i).filter((i) => !dUsed.has(i)),
  }
}

export interface DetectionScore {
  nTruth: number
  nDet: number
  hits: number
  /** hits / nDet (0 when there are no detections). */
  precision: number
  /** hits / nTruth (0 when there is no truth). This is the "hit rate". */
  recall: number
  f: number
  match: MatchResult
}

/** F-measure with weight `beta` on recall (beta 1 = F1); 0 when precision + recall is 0. */
export function fMeasure(precision: number, recall: number, beta = 1): number {
  const b2 = beta * beta
  const d = b2 * precision + recall
  return d > 0 ? ((1 + b2) * precision * recall) / d : 0
}

/** Precision / recall / F of detections against truth inside a tolerance in seconds. */
export function scoreDetections(truth: readonly number[], det: readonly number[], tol: Tolerance, beta = 1): DetectionScore {
  const match = matchEvents(truth, det, tol)
  const hits = match.pairs.length
  const precision = det.length > 0 ? hits / det.length : 0
  const recall = truth.length > 0 ? hits / truth.length : 0
  return { nTruth: truth.length, nDet: det.length, hits, precision, recall, f: fMeasure(precision, recall, beta), match }
}

/** Same as `scoreDetections` with a symmetric tolerance of `bars` bars at `bpm`. */
export function scoreDetectionsBars(truth: readonly number[], det: readonly number[], bars: number, bpm: number, beta = 1): DetectionScore {
  return scoreDetections(truth, det, barsToSec(bars, bpm), beta)
}

/** Share of truth events matched (one-to-one) by a detection within `bars` bars either side. */
export function recallWithinBars(truth: readonly number[], det: readonly number[], bars: number, bpm: number): number {
  return scoreDetectionsBars(truth, det, bars, bpm).recall
}

/**
 * Detections per minute of audio that do not match any truth event (one-to-one, inside `tol`). A second
 * detection of an already-matched truth counts as a false alarm.
 */
export function falseAlarmsPerMinute(truth: readonly number[], det: readonly number[], durationSec: number, tol: Tolerance): number {
  if (!(durationSec > 0)) return NaN
  const { pairs } = matchEvents(truth, det, tol)
  return (det.length - pairs.length) / (durationSec / 60)
}

/**
 * Detections that land inside `tol` of ANY of the given (negative) events, each detection counted once. Not
 * one-to-one: every detection near a fill / gain step / silence gap is a mistake.
 */
export function detectionsNearEvents(events: readonly number[], det: readonly number[], tol: Tolerance): number {
  const { before, after } = toWindow(tol)
  let n = 0
  for (const d of det) {
    for (const e of events) {
      if (d - e <= after + EPS && d - e >= -before - EPS) {
        n++
        break
      }
    }
  }
  return n
}

/** Linear-interpolated percentile (`p` in 0..1) of an unsorted sample; NaN for an empty sample. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return NaN
  const s = [...values].sort((a, b) => a - b)
  const idx = clamp01(p) * (s.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  return s[lo] + (s[hi] - s[lo]) * (idx - lo)
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)

export interface LagStats {
  n: number
  mean: number
  median: number
  p90: number
  min: number
  max: number
}

/** Distribution of `detectedAt - truth` over matched pairs (positive = late). All NaN for no pairs. */
export function lagStats(pairs: readonly Pick<MatchedPair, 'lag'>[]): LagStats {
  const lags = pairs.map((p) => p.lag)
  if (lags.length === 0) return { n: 0, mean: NaN, median: NaN, p90: NaN, min: NaN, max: NaN }
  return {
    n: lags.length,
    mean: lags.reduce((s, x) => s + x, 0) / lags.length,
    median: percentile(lags, 0.5),
    p90: percentile(lags, 0.9),
    min: Math.min(...lags),
    max: Math.max(...lags),
  }
}

/**
 * Lag of a detector that reports at `detectedAt[i]` an event it places at `claimed[i]`: match on the claimed
 * time inside `tol`, then take `detectedAt - truth` for the matched pairs. For a flag that fires "now"
 * (`claimed === detectedAt`) this is plain lag; for a retrospective boundary (claimed in the past, published
 * later) it is the publication delay.
 */
export function detectionLagStats(
  truth: readonly number[],
  claimed: readonly number[],
  detectedAt: readonly number[],
  tol: Tolerance,
): LagStats {
  const { pairs } = matchEvents(truth, claimed, tol)
  return lagStats(pairs.map((p) => ({ lag: detectedAt[p.detIndex] - p.truth })))
}

/**
 * Share of scene cuts that fall within `toleranceBars` bars of a true boundary. NOT one-to-one: each cut is
 * judged on its own against the nearest truth (cuts are separated by a refractory period, so duplicates on one
 * boundary are the director's problem, reported through `intervalStats`). 0 for no cuts.
 */
export function alignmentScore(cutTimes: readonly number[], truthTimes: readonly number[], toleranceBars: number, bpm: number): number {
  if (cutTimes.length === 0) return 0
  const tol = barsToSec(toleranceBars, bpm)
  let aligned = 0
  for (const c of cutTimes) {
    for (const t of truthTimes) {
      if (Math.abs(c - t) <= tol + EPS) {
        aligned++
        break
      }
    }
  }
  return aligned / cutTimes.length
}

export interface IntervalStats {
  /** Number of intervals (cuts - 1). */
  n: number
  medianSec: number
  p10Sec: number
  p90Sec: number
  medianBars: number
  p10Bars: number
  p90Bars: number
  /** Share of intervals whose length lies in `[minBars, maxBars]` (inclusive). NaN for no intervals. */
  shareInRange: number
  minBars: number
  maxBars: number
}

/** Distribution of the gaps between consecutive scene cuts, in seconds and bars (bar = 240 / bpm s). */
export function intervalStats(cutTimes: readonly number[], bpm: number, range: { minBars?: number; maxBars?: number } = {}): IntervalStats {
  const minBars = range.minBars ?? 4
  const maxBars = range.maxBars ?? 32
  const s = [...cutTimes].sort((a, b) => a - b)
  const gaps: number[] = []
  for (let i = 1; i < s.length; i++) gaps.push(s[i] - s[i - 1])
  const bar = barSec(bpm)
  const inRange = gaps.filter((g) => g / bar >= minBars - EPS && g / bar <= maxBars + EPS).length
  const med = percentile(gaps, 0.5)
  const p10 = percentile(gaps, 0.1)
  const p90 = percentile(gaps, 0.9)
  return {
    n: gaps.length,
    medianSec: med,
    p10Sec: p10,
    p90Sec: p90,
    medianBars: med / bar,
    p10Bars: p10 / bar,
    p90Bars: p90 / bar,
    shareInRange: gaps.length > 0 ? inRange / gaps.length : NaN,
    minBars,
    maxBars,
  }
}

export interface MirEvalScore {
  precision: number
  recall: number
  f: number
  hits: number
  nRef: number
  nEst: number
}

/**
 * `mir_eval.segment.detection` from its definition: boundary hit-rate with a +-`windowSec` second window,
 * maximum one-to-one matching, precision = hits / |est|, recall = hits / |ref|, F with weight `beta`.
 * `trim: true` drops the first and last boundary of each list (mir_eval's `trim=True`, meant for boundary
 * lists that include the track start and end); either list empty after trimming scores 0 / 0 / 0.
 * The literature's F0.5 / F3 are `windowSec = 0.5` / `3` with beta 1.
 */
export function mirEvalStyleDetectionF(
  ref: readonly number[],
  est: readonly number[],
  windowSec: number,
  opts: { trim?: boolean; beta?: number } = {},
): MirEvalScore {
  const sortedRef = [...ref].sort((a, b) => a - b)
  const sortedEst = [...est].sort((a, b) => a - b)
  const r = opts.trim ? sortedRef.slice(1, -1) : sortedRef
  const e = opts.trim ? sortedEst.slice(1, -1) : sortedEst
  if (r.length === 0 || e.length === 0) return { precision: 0, recall: 0, f: 0, hits: 0, nRef: r.length, nEst: e.length }
  const hits = matchEvents(r, e, windowSec).pairs.length
  const precision = hits / e.length
  const recall = hits / r.length
  return { precision, recall, f: fMeasure(precision, recall, opts.beta ?? 1), hits, nRef: r.length, nEst: e.length }
}

/** Times of truth events that a detector should report (`shouldTrigger`), optionally restricted to `types`. */
export function positiveTimes(truth: readonly TruthEvent[], types?: readonly TruthEventType[]): number[] {
  return truth.filter((t) => t.shouldTrigger && (!types || types.includes(t.type))).map((t) => t.timeSec)
}

/** Times of the NEGATIVE truth events (fills, gain steps, silence gaps, morph steps), optionally by `types`. */
export function negativeTimes(truth: readonly TruthEvent[], types?: readonly TruthEventType[]): number[] {
  return truth.filter((t) => !t.shouldTrigger && (!types || types.includes(t.type))).map((t) => t.timeSec)
}
