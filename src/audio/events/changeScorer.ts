/**
 * The bar-synchronous CHANGE SCORER: a per-beat novelty score over the eight channels of `barFeatures.ts`, whitened per
 * channel, with an ADAPTIVE threshold, local-maximum peak picking and a refractory period. Pure (no engine, no DOM).
 *
 * ## Why this and not the analyser / `f.sectionChange`
 * The slow analyser (beat-level SSM + Foote) reports a boundary ~4 beats after it happens and then waits for its next
 * batch; `f.sectionChange` looks at four coarse, already-normalised band means on an arbitrary phase and fires on fills
 * and volume steps. Here every beat is scored against the recent past on features that CAN see a change at equal
 * loudness (log-mel shape, chroma) and a louder chorus (raw dB level), and the score is compared with what this track's
 * own beat-to-beat wobble looks like, so a busy track raises its own bar instead of firing every bar.
 *
 * ## The algorithm (constants in {@link DEFAULT_SCORER}; the tuning is documented in the calibration report)
 * At each beat `n`, with the newest N beats (new) and the M before them (old; four beats of phase resolution, because
 * no reliable bar phase exists):
 *
 *   d_k   channel distance between the two window means (level/low/mid/high/rhythm signed, timbre/harmony/texture 1-cos
 *         or Euclid; `barFeatures.channelDistances`)
 *   z_k   ( |d_k| - median_k ) / max( 1.4826 * MAD_k , floor_k )    both over the trailing `statBeats` values of |d_k|
 *         (a robust z-score; the floor stops a perfectly clean, exactly-repeating stimulus from turning a rounding
 *         error into z = 1000, and is set from real-music per-track MADs)
 *   s     sqrt( sum_k w_k z_k^2 / sum_k w_k )              weights ~0.6-1.2, level/timbre/harmony highest
 *   thr   max( median(s) + k * max(1.4826 MAD(s), sigmaFloorS) , absFloor )  over the trailing `statBeats` scores
 *
 * Two refinements over that plain form, both measured on the synthetic suite and the real corpus:
 *  - the HARMONY channel compares an 8-beat new window (`newBeatsSlow`) with the 16 beats before it: a chord
 *    progression's chroma varies from bar to bar as much as a key change does, so a 4-beat window cannot see one;
 *  - the trailing statistics (per-channel |d| and s) leave out the decay tail of an ACCEPTED change (`shadowBeats`):
 *    the old window still straddles it, and a track with big changes would otherwise raise its own bar for the next mild
 *    one (an outro after two big drops was invisible).
 *
 * A CANDIDATE is a local maximum of `s` over +-`peakHalf` beats (so it is confirmed `peakHalf` beats after its peak:
 * that is most of the detector's lag) with `s >= thr`, at least `refractoryBeats` after the previous candidate, and
 * whose boundary is not within `refractoryBeats` of the previous one (a slower channel's later hump of the SAME change).
 * The boundary estimate is `peak - N` (the newest window is fully new at the peak) minus an extra lag for the chroma
 * channel, which trails the fast ones (weighted by its share of the score); when the fast channels carry the change a
 * least-squares CHANGE-POINT fit over the last cells (`refineAge`) then places the step, because the peak itself
 * saturates on a big change and is only good to +-2 beats. The bar grid (`barGrid.ts`, a {@link BeatPrior}) snaps the
 * estimate to the anchored bar line and multiplies the score of a marginal candidate on the anchored phase.
 *
 * Persistence (does the change stay?) is measured on the `peakHalf` beats AFTER the peak against the same old
 * baseline: a fill or a one-beat stab returns to the baseline (ratio ~0), a section change does not (~1). `EventLayer`
 * types the candidate with it.
 *
 * Allocation-free after construction: fixed typed-array rings; one reused {@link Candidate}. The MAD needs a sort of
 * the trailing window; it uses two fixed scratch arrays (`Float64Array.sort` in place).
 */
import {
  CHANNELS,
  CH_HARMONY,
  FEATURE_DIM,
  FeatureRing,
  MEL_N,
  OFF_LEVEL,
  OFF_LOW,
  OFF_MEL,
  channelDistances,
  harmonyDistance,
} from './barFeatures'
import type { BeatPrior } from './barGrid'

export interface ScorerConfig {
  /** N: beats in the NEW window; M: beats in the OLD window (at least `minOldBeats` are needed to score). */
  newBeats: number
  /** The harmony channel compares a longer NEW window (a chord progression's per-chord chroma varies as much as a key
   *  change does at 4 beats); its old window starts right after it. */
  newBeatsSlow: number
  oldBeats: number
  minOldBeats: number
  /** Trailing values kept for the per-channel and the score statistics (128 beats = 32 bars). */
  statBeats: number
  /** Local-maximum half-width = confirmation lookahead, in beats. */
  peakHalf: number
  /** Threshold: median + k * sigma of the trailing scores. */
  k: number
  /** Absolute floor on the threshold and on the score of a candidate. */
  absFloor: number
  /** Floor on the score sigma (a clean stimulus has MAD ~ 0). */
  sigmaFloorS: number
  weights: readonly number[]
  /** Per-channel floor on 1.4826 * MAD, in the channel's own units. */
  sigmaFloor: readonly number[]
  /** Beats after a candidate's peak in which no further candidate is accepted. */
  refractoryBeats: number
  /** Samples before a channel's / the score's own statistics are trusted (until then a stricter default is used). */
  warmChannel: number
  warmScore: number
  /** A candidate whose score already clears `strongOverride * thr` is not multiplied by the grid prior. */
  strongOverride: number
  /** Extra lag of the chroma channel in seconds (its 2 s EMA), converted to beats with the tempo. */
  chromaLagSec: number
  /**
   * Boundary refinement: the score peak saturates on a big change (1 - cos is bounded), so its beat is only good to
   * about +-2. A least-squares change-point fit over the last cells, within +-`refineRange` beats of the estimate,
   * finds where the step really is. 0 turns it off. (Skipped when the harmony channel, which trails, dominates.)
   */
  refineRange: number
  /** Scored beats after an accepted candidate that stay out of the trailing statistics (its decay tail). */
  shadowBeats: number
}

export const DEFAULT_SCORER: Readonly<ScorerConfig> = Object.freeze({
  newBeats: 4,
  newBeatsSlow: 8,
  oldBeats: 16,
  minOldBeats: 8,
  statBeats: 128,
  peakHalf: 2,
  k: 3.5,
  absFloor: 4,
  sigmaFloorS: 0.5,
  //                level low  mid  high timbre harmony rhythm texture
  weights: [1.2, 0.8, 0.6, 0.6, 1.2, 1.2, 0.6, 0.6],
  sigmaFloor: [0.35, 0.5, 0.5, 0.65, 0.006, 0.03, 0.02, 0.015],
  refractoryBeats: 8,
  warmChannel: 8,
  warmScore: 12,
  strongOverride: 1.5,
  chromaLagSec: 1.8,
  refineRange: 5,
  shadowBeats: 14,
})

/** Feature dims the change-point fit looks at: level, tilts, onset, flatness, centroid and the mel shape (not the lagging chroma). */
const REFINE_DIMS = OFF_MEL + MEL_N

const MAD_SCALE = 1.4826

/** A trailing window of values with a robust (median, MAD) summary; fixed memory, in-place sorts. */
class TrailingStat {
  private readonly buf: Float64Array
  private readonly a: Float64Array
  private readonly b: Float64Array
  private head = 0
  n = 0
  med = 0
  mad = 0

  constructor(private readonly cap: number) {
    this.buf = new Float64Array(cap)
    this.a = new Float64Array(cap)
    this.b = new Float64Array(cap)
  }

  clear(): void {
    this.head = 0
    this.n = 0
    this.med = 0
    this.mad = 0
  }

  push(v: number): void {
    this.buf[this.head] = v
    this.head = (this.head + 1) % this.cap
    if (this.n < this.cap) this.n++
  }

  private static median(sorted: Float64Array, n: number): number {
    const m = n >> 1
    return n & 1 ? sorted[m] : 0.5 * (sorted[m - 1] + sorted[m])
  }

  /** Recompute `med` / `mad` over the current contents. */
  summarize(): void {
    const n = this.n
    if (n === 0) {
      this.med = 0
      this.mad = 0
      return
    }
    for (let i = 0; i < n; i++) this.a[i] = this.buf[i]
    for (let i = n; i < this.cap; i++) this.a[i] = Number.POSITIVE_INFINITY
    this.a.sort()
    const med = TrailingStat.median(this.a, n)
    for (let i = 0; i < n; i++) this.b[i] = Math.abs(this.buf[i] - med)
    for (let i = n; i < this.cap; i++) this.b[i] = Number.POSITIVE_INFINITY
    this.b.sort()
    this.med = med
    this.mad = TrailingStat.median(this.b, n)
  }
}

/** What the scorer reports for an accepted candidate (ONE reused object: copy what you keep). */
export interface Candidate {
  peakBeat: number
  peakTime: number
  /** The scorer's own step counter at the peak (beat numbers are not always consecutive; steps are). */
  peakStep: number
  /** The beat / time the peak was confirmed (`peakHalf` beats later). */
  detectedBeat: number
  detectedTime: number
  /** Boundary estimate (float, before the grid), the snapped integer beat and its audio time. */
  boundaryBeatRaw: number
  boundaryBeat: number
  /** The same boundary in the GRID domain (consecutive cells differ by 1; the bar grid is learned here), before / after snapping. */
  boundarySeqRaw: number
  boundarySeq: number
  boundaryTime: number
  /** Score at the peak, after the prior, and the threshold it faced. */
  s: number
  sEff: number
  thr: number
  /** The prior boosted this candidate (its boundary is on the anchored bar phase). */
  onGrid: boolean
  /** Per-channel z at the peak, and the signed / raw channel distances. */
  z: Float64Array
  d: Float64Array
  /** Score of the beats AFTER the peak against the old baseline, as a share of `s` (a fill returns to ~0). */
  persist: number
  /** The score of those beats AFTER the peak (z units, same whitening): what `persist` is a share of. A saturating peak (score 30) makes the share small even when the change plainly stays (score 5 against a bar of 4): typing looks at both. */
  recentS: number
  /** The score with the level channel left out (0 = only the level moved: a volume knob). */
  shape: number
  /** Window means at the peak: low-band absolute dB change (low tilt + level) and level change, in dB. */
  lowAbsDelta: number
  levelDelta: number
  /** The same, for the beats after the peak: is a dropout still there? */
  recentLowAbsDelta: number
  recentLevelDelta: number
  /** Extra lag applied for slow channels, in beats. */
  extraLag: number
}

/** Copy every field of `src` into `dst` (a candidate the scorer will overwrite on its next accept must be kept by value). */
export function copyCandidate(dst: Candidate, src: Candidate): void {
  const z = dst.z
  const d = dst.d
  Object.assign(dst, src)
  dst.z = z
  dst.d = d
  z.set(src.z)
  d.set(src.d)
}

export function makeCandidate(): Candidate {
  return {
    peakBeat: 0,
    peakTime: 0,
    peakStep: 0,
    detectedBeat: 0,
    detectedTime: 0,
    boundaryBeatRaw: 0,
    boundaryBeat: 0,
    boundarySeqRaw: 0,
    boundarySeq: 0,
    boundaryTime: 0,
    s: 0,
    sEff: 0,
    thr: 0,
    onGrid: false,
    z: new Float64Array(CHANNELS),
    d: new Float64Array(CHANNELS),
    persist: 1,
    recentS: 0,
    shape: 0,
    lowAbsDelta: 0,
    levelDelta: 0,
    recentLowAbsDelta: 0,
    recentLevelDelta: 0,
    extraLag: 0,
  }
}

export class ChangeScorer {
  readonly cfg: ScorerConfig
  readonly ring: FeatureRing
  /** Diagnostics of the last step (not allocation: numbers only). */
  lastS = 0
  lastThr = 0
  readonly cand = makeCandidate()
  /**
   * OPTIONAL diagnostics hook (calibration scripts, tests): called after every scored beat with the raw channel
   * distances, the whitened z, the score and its threshold. Null in production: a single null check per beat.
   */
  probe: ((step: number, d: Float64Array, z: Float64Array, s: number, thr: number) => void) | null = null

  private readonly chStat: TrailingStat[]
  private readonly sStat: TrailingStat
  private readonly chMed = new Float64Array(CHANNELS)
  private readonly chScale = new Float64Array(CHANNELS)
  private readonly newMean = new Float64Array(FEATURE_DIM)
  private readonly oldMean = new Float64Array(FEATURE_DIM)
  /** Scratch of the change-point fit: standardised cells' prefix sums (sum and sum of squares) along the age axis. */
  private readonly fitP1: Float64Array
  private readonly fitP2: Float64Array
  private readonly fitMean = new Float64Array(REFINE_DIMS)
  private readonly fitStd = new Float64Array(REFINE_DIMS)
  private readonly newMeanB = new Float64Array(FEATURE_DIM)
  private readonly oldMeanB = new Float64Array(FEATURE_DIM)
  private readonly d = new Float64Array(CHANNELS)
  private readonly z = new Float64Array(CHANNELS)
  private readonly wSum: number
  /** Peak-picking ring over the last 2h+1 scored beats. */
  private readonly P: number
  private readonly pS: Float64Array
  private readonly pThr: Float64Array
  private readonly pBeat: Float64Array
  private readonly pStep: Float64Array
  private readonly pTime: Float64Array
  private readonly pZ: Float64Array
  private readonly pD: Float64Array
  private pCount = 0
  private pHead = 0
  /**
   * Scored steps so far. Refractory and suppression count STEPS (cells), not beat numbers: the engine's beat index can
   * jump (a grid re-lock advances it by up to 4 for one cell), which must not shorten or lengthen them.
   */
  private stepNo = 0
  private lastPeakStep = Number.NEGATIVE_INFINITY
  /** Grid-domain boundary of the last accepted candidate: a slower channel's later hump of the SAME change (the chroma
   *  EMA) has the same lag-compensated boundary and is refused by it. */
  private lastBoundarySeq = Number.NEGATIVE_INFINITY
  private suppressedThroughStep = Number.NEGATIVE_INFINITY
  /** Steps up to which scores are NOT added to the trailing statistics (the tail of an accepted change). */
  private shadowThroughStep = Number.NEGATIVE_INFINITY

  constructor(cfg: Partial<ScorerConfig> = {}) {
    this.cfg = { ...DEFAULT_SCORER, ...cfg }
    const c = this.cfg
    this.ring = new FeatureRing(Math.max(c.newBeats + c.oldBeats + 2 * c.peakHalf + 24, 64))
    this.fitP1 = new Float64Array((this.ring.cap + 1) * REFINE_DIMS)
    this.fitP2 = new Float64Array((this.ring.cap + 1) * REFINE_DIMS)
    this.chStat = Array.from({ length: CHANNELS }, () => new TrailingStat(c.statBeats))
    this.sStat = new TrailingStat(c.statBeats)
    let ws = 0
    for (let k = 0; k < CHANNELS; k++) ws += c.weights[k]
    this.wSum = ws
    this.P = 2 * c.peakHalf + 1
    this.pS = new Float64Array(this.P)
    this.pThr = new Float64Array(this.P)
    this.pBeat = new Float64Array(this.P)
    this.pStep = new Float64Array(this.P)
    this.pTime = new Float64Array(this.P)
    this.pZ = new Float64Array(this.P * CHANNELS)
    this.pD = new Float64Array(this.P * CHANNELS)
  }

  reset(): void {
    this.ring.clear()
    for (const s of this.chStat) s.clear()
    this.sStat.clear()
    this.invalidate()
    this.stepNo = 0
    this.lastPeakStep = Number.NEGATIVE_INFINITY
    this.lastBoundarySeq = Number.NEGATIVE_INFINITY
    this.suppressedThroughStep = Number.NEGATIVE_INFINITY
    this.shadowThroughStep = Number.NEGATIVE_INFINITY
    this.lastS = 0
    this.lastThr = 0
  }

  /** Forget the pending peak window (a tainted beat was dropped: the peaks around it are not real). */
  invalidate(): void {
    this.pCount = 0
    this.pHead = 0
  }

  /** No candidate is accepted for a peak within the next `steps` scored beats. */
  suppressNext(steps: number): void {
    const t = this.stepNo + steps
    if (t > this.suppressedThroughStep) this.suppressedThroughStep = t
  }

  /** Move the refractory reference: the previous candidate's peak counts as being at `step` (typed events choose their own). */
  setLastPeakStep(step: number): void {
    this.lastPeakStep = step
  }

  /** Forget the last boundary (a transient must not shadow the real change that follows it). */
  clearLastBoundary(): void {
    this.lastBoundarySeq = Number.NEGATIVE_INFINITY
  }

  /** Statistics summary for diagnostics/tests. */
  get scoreSamples(): number {
    return this.sStat.n
  }

  /**
   * Least-squares change-point fit: the number of NEW cells `s` (ages 0..s-1) that best splits the last cells into an
   * old and a new segment, searched within +-refineRange of `ageEst`. Standardised per dimension over the window so
   * every feature counts alike. Returns `ageEst` unchanged when there is too little history.
   */
  private refineAge(ageEst: number): number {
    const c = this.cfg
    const ring = this.ring
    const R = c.refineRange
    const est = Math.round(ageEst)
    const L = Math.min(ring.count, est + R + 4)
    const lo = Math.max(3, est - R)
    const hi = Math.min(L - 4, est + R)
    if (R <= 0 || hi < lo) return ageEst
    const D = REFINE_DIMS
    const mean = this.fitMean
    const std = this.fitStd
    mean.fill(0)
    std.fill(0)
    for (let a = 0; a < L; a++) {
      const o = ring.offsetAt(a)
      for (let i = 0; i < D; i++) mean[i] += ring.data[o + i]
    }
    for (let i = 0; i < D; i++) mean[i] /= L
    for (let a = 0; a < L; a++) {
      const o = ring.offsetAt(a)
      for (let i = 0; i < D; i++) {
        const d = ring.data[o + i] - mean[i]
        std[i] += d * d
      }
    }
    for (let i = 0; i < D; i++) std[i] = Math.sqrt(std[i] / L) + 1e-6
    const p1 = this.fitP1
    const p2 = this.fitP2
    for (let i = 0; i < D; i++) {
      p1[i] = 0
      p2[i] = 0
    }
    for (let a = 0; a < L; a++) {
      const o = ring.offsetAt(a)
      for (let i = 0; i < D; i++) {
        const z = (ring.data[o + i] - mean[i]) / std[i]
        p1[(a + 1) * D + i] = p1[a * D + i] + z
        p2[(a + 1) * D + i] = p2[a * D + i] + z * z
      }
    }
    let best = est
    let bestCost = Number.POSITIVE_INFINITY
    for (let s = lo; s <= hi; s++) {
      let cost = 0
      for (let i = 0; i < D; i++) {
        const nNew = s
        const nOld = L - s
        const newS1 = p1[s * D + i]
        const newS2 = p2[s * D + i]
        const oldS1 = p1[L * D + i] - newS1
        const oldS2 = p2[L * D + i] - newS2
        cost += newS2 - (newS1 * newS1) / nNew + (oldS2 - (oldS1 * oldS1) / nOld)
      }
      if (cost < bestCost - 1e-9) {
        bestCost = cost
        best = s
      }
    }
    return best
  }

  /** Harmony distance of the (slow) window pair whose newest cell is `fromAge` old; 0 when there is too little history. */
  private slowHarmony(fromAge: number): number {
    const c = this.cfg
    const ring = this.ring
    const NB = c.newBeatsSlow
    const MB = Math.min(c.oldBeats, ring.count - fromAge - NB)
    if (MB < c.minOldBeats) return 0
    if (!ring.meanWindow(fromAge, NB, this.newMeanB) || !ring.meanWindow(fromAge + NB, MB, this.oldMeanB)) return 0
    return harmonyDistance(this.newMeanB, this.oldMeanB)
  }

  /** Per-channel z from signed/raw distances `dd` (uses the frozen `chMed` / `chScale`). */
  private whiten(dd: Float64Array, zz: Float64Array): void {
    for (let k = 0; k < CHANNELS; k++) {
      const v = Math.abs(dd[k]) - this.chMed[k]
      zz[k] = v > 0 ? v / this.chScale[k] : 0
    }
  }

  private combine(zz: Float64Array, skipLevel: boolean): number {
    const w = this.cfg.weights
    let num = 0
    let den = 0
    for (let k = skipLevel ? 1 : 0; k < CHANNELS; k++) {
      num += w[k] * zz[k] * zz[k]
      den += w[k]
    }
    return den > 0 ? Math.sqrt(num / den) : 0
  }

  /**
   * Score the newest committed cell (the caller has written its features into `ring` and committed). Returns the
   * candidate confirmed on THIS step (its peak was `peakHalf` beats ago), or null. `spb` is seconds per beat.
   */
  step(spb: number, prior: BeatPrior | null): Candidate | null {
    const c = this.cfg
    const ring = this.ring
    const N = c.newBeats
    const n = ring.count
    if (n < N + c.minOldBeats) return null
    const M = Math.min(c.oldBeats, n - N)
    ring.meanWindow(0, N, this.newMean)
    ring.meanWindow(N, M, this.oldMean)
    channelDistances(this.newMean, this.oldMean, this.d)
    this.d[CH_HARMONY] = this.slowHarmony(0)

    // Whiten against the trailing statistics BEFORE this beat joins them.
    for (let k = 0; k < CHANNELS; k++) {
      const st = this.chStat[k]
      st.summarize()
      if (st.n >= c.warmChannel) {
        this.chMed[k] = st.med
        this.chScale[k] = Math.max(MAD_SCALE * st.mad, c.sigmaFloor[k])
      } else {
        this.chMed[k] = 0
        this.chScale[k] = 3 * c.sigmaFloor[k]
      }
    }
    this.whiten(this.d, this.z)
    // The statistics describe the BACKGROUND: the decay tail of an accepted change (the old window still straddles it)
    // is left out, or a track with big changes would raise its own bar for the next mild one.
    const background = this.stepNo > this.shadowThroughStep
    if (background) for (let k = 0; k < CHANNELS; k++) this.chStat[k].push(Math.abs(this.d[k]))
    const s = this.combine(this.z, false)

    this.sStat.summarize()
    let thr = this.sStat.med + c.k * Math.max(MAD_SCALE * this.sStat.mad, c.sigmaFloorS)
    if (thr < c.absFloor) thr = c.absFloor
    if (this.sStat.n < c.warmScore) thr = Math.max(thr, c.absFloor * 1.25)
    if (background) this.sStat.push(s)
    this.lastS = s
    this.lastThr = thr
    if (this.probe !== null) this.probe(this.stepNo, this.d, this.z, s, thr)

    // Record this beat in the peak-picking ring.
    const slot = this.pHead
    this.pS[slot] = s
    this.pThr[slot] = thr
    this.pBeat[slot] = ring.beatAt(0)
    this.pStep[slot] = this.stepNo++
    this.pTime[slot] = ring.timeAt(0)
    for (let k = 0; k < CHANNELS; k++) {
      this.pZ[slot * CHANNELS + k] = this.z[k]
      this.pD[slot * CHANNELS + k] = this.d[k]
    }
    this.pHead = (slot + 1) % this.P
    if (this.pCount < this.P) this.pCount++
    if (this.pCount < this.P) return null

    return this.pickPeak(spb, prior)
  }

  /**
   * Score (whitened, z units) of the newest `k` beats against the baseline that preceded the window of the peak `k - peakHalf`
   * beats ago: `pickPeak`'s persistence measure over a LONGER stretch after the peak. NaN when there is too little history.
   * `EventLayer` asks it a few beats after an ambiguous candidate to tell a change that stays from a fill that ends.
   */
  recentScoreOver(k: number): number {
    const c = this.cfg
    const ring = this.ring
    const N = c.newBeats
    const n = ring.count
    const Mp = Math.min(c.oldBeats, n - k - N)
    if (k < 1 || Mp < c.minOldBeats) return Number.NaN
    if (!ring.meanWindow(0, k, this.newMean) || !ring.meanWindow(k + N, Mp, this.oldMean)) return Number.NaN
    channelDistances(this.newMean, this.oldMean, this.d)
    const NB = c.newBeatsSlow
    const MBp = Math.min(c.oldBeats, n - k - NB)
    this.d[CH_HARMONY] = MBp >= c.minOldBeats && ring.meanWindow(k + NB, MBp, this.oldMeanB) ? harmonyDistance(this.newMean, this.oldMeanB) : 0
    this.whiten(this.d, this.z)
    return this.combine(this.z, false)
  }

  /** Ring slot of the entry `back` beats before the newest scored one. */
  private pSlot(back: number): number {
    return (this.pHead - 1 - back + this.P * 2) % this.P
  }

  private pickPeak(spb: number, prior: BeatPrior | null): Candidate | null {
    const c = this.cfg
    const h = c.peakHalf
    const centre = this.pSlot(h)
    const sc = this.pS[centre]
    const peakBeat = this.pBeat[centre]
    if (!(sc > 0)) return null
    for (let j = 1; j <= h; j++) {
      if (this.pS[this.pSlot(h + j)] >= sc) return null // an earlier beat is at least as high
      if (this.pS[this.pSlot(h - j)] > sc) return null // a later one is higher
    }
    const thr = this.pThr[centre]
    // The prior can lift a candidate by at most barBoost*phraseBoost (< 1.5): below thr/1.5 it can never pass.
    if (sc < thr / c.strongOverride) return null
    const peakStep = this.pStep[centre]
    if (peakStep - this.lastPeakStep < c.refractoryBeats) return null
    if (peakStep <= this.suppressedThroughStep) return null

    // Boundary estimate: the fully-new window starts N beats before the peak; the chroma channel trails.
    const zc = this.pZ
    const zo = centre * CHANNELS
    let cSum = 0
    for (let k = 0; k < CHANNELS; k++) cSum += c.weights[k] * zc[zo + k] * zc[zo + k]
    const cHarm = c.weights[CH_HARMONY] * zc[zo + CH_HARMONY] * zc[zo + CH_HARMONY]
    const beatsPerLag = spb > 0.05 && Number.isFinite(spb) ? c.chromaLagSec / spb : 3
    const slowExtra = c.newBeatsSlow - c.newBeats
    const extraLag = cSum > 0 ? (cHarm / cSum) * Math.min(12, slowExtra + Math.max(0, beatsPerLag)) : 0
    // In cell ages (the peak is `h` cells back): robust to a jump of the beat index inside the window.
    const ring = this.ring
    let ageF = h + c.newBeats + extraLag
    if (c.refineRange > 0 && cSum > 0 && cHarm / cSum < 0.5) ageF = this.refineAge(ageF)
    const a0 = Math.min(Math.floor(ageF), ring.count - 2)
    const frac = Math.min(1, ageF - a0)
    const s0 = ring.seqAt(a0)
    const s1 = ring.seqAt(a0 + 1)
    const rawSeq = s0 - frac * (s0 - s1)
    const snappedSeq = prior ? prior.snap(rawSeq) : Math.round(rawSeq)
    const shift = snappedSeq - rawSeq
    const b0 = ring.beatAt(a0)
    const b1 = ring.beatAt(a0 + 1)
    const rawBoundary = b0 - frac * (b0 - b1)
    if (Math.abs(rawSeq - this.lastBoundarySeq) < c.refractoryBeats) return null
    const mult = prior ? prior.multiplier(snappedSeq) : 1
    const strong = sc >= c.strongOverride * thr
    const sEff = strong ? sc : sc * mult
    if (sEff < thr) return null

    const cand = this.cand
    cand.peakBeat = peakBeat
    cand.peakStep = peakStep
    cand.peakTime = this.pTime[centre]
    cand.detectedBeat = this.ring.beatAt(0)
    cand.detectedTime = this.ring.timeAt(0)
    cand.boundaryBeatRaw = rawBoundary
    cand.boundaryBeat = Math.round(rawBoundary + shift)
    cand.boundarySeqRaw = rawSeq
    cand.boundarySeq = snappedSeq
    // Time of the boundary: the crossing the cell at that age closed on (interpolated for a fractional age), moved by
    // the snap (a whole number of beats at the current tempo).
    const t0 = ring.timeAt(a0)
    const t1 = ring.timeAt(a0 + 1)
    const tRaw = t0 - frac * (t0 - t1)
    cand.boundaryTime = tRaw + shift * (spb > 0 ? spb : 0.5)
    cand.s = sc
    cand.sEff = sEff
    cand.thr = thr
    cand.onGrid = !strong && mult > 1
    cand.extraLag = extraLag
    for (let k = 0; k < CHANNELS; k++) {
      cand.z[k] = zc[zo + k]
      cand.d[k] = this.pD[centre * CHANNELS + k]
    }
    cand.shape = this.combine(cand.z, true)

    // Means at the peak (ages h .. ) for the level / low-band deltas, and persistence over the beats after it.
    const N = c.newBeats
    const nAvail = ring.count
    const Mp = Math.min(c.oldBeats, nAvail - h - N)
    cand.lowAbsDelta = 0
    cand.levelDelta = 0
    cand.recentLowAbsDelta = 0
    cand.recentLevelDelta = 0
    cand.persist = 1
    cand.recentS = 0
    if (Mp >= c.minOldBeats && ring.meanWindow(h, N, this.newMean) && ring.meanWindow(h + N, Mp, this.oldMean)) {
      cand.levelDelta = this.newMean[OFF_LEVEL] - this.oldMean[OFF_LEVEL]
      cand.lowAbsDelta = this.newMean[OFF_LOW] + this.newMean[OFF_LEVEL] - (this.oldMean[OFF_LOW] + this.oldMean[OFF_LEVEL])
      if (ring.meanWindow(0, h, this.newMean)) {
        cand.recentLevelDelta = this.newMean[OFF_LEVEL] - this.oldMean[OFF_LEVEL]
        cand.recentLowAbsDelta = this.newMean[OFF_LOW] + this.newMean[OFF_LEVEL] - (this.oldMean[OFF_LOW] + this.oldMean[OFF_LEVEL])
        channelDistances(this.newMean, this.oldMean, this.d)
        const NB = c.newBeatsSlow
        const MBp = Math.min(c.oldBeats, nAvail - h - NB)
        this.d[CH_HARMONY] = MBp >= c.minOldBeats && ring.meanWindow(h + NB, MBp, this.oldMeanB) ? harmonyDistance(this.newMean, this.oldMeanB) : 0
        this.whiten(this.d, this.z)
        const sRecent = this.combine(this.z, false)
        cand.persist = sc > 0 ? sRecent / sc : 1
        cand.recentS = sRecent
      }
    }
    this.lastPeakStep = peakStep
    this.lastBoundarySeq = rawSeq
    this.shadowThroughStep = Math.max(this.shadowThroughStep, this.stepNo + c.shadowBeats)
    return cand
  }
}
