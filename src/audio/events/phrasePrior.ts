/**
 * PHRASE PERIODICITY PRIOR (experimental, not wired in by default): music is written in phrases of a fixed length, so once a
 * few section boundaries are confirmed, the gap between them predicts where the next ones fall. This learns that gap from the
 * RUNNING song, in SECONDS (the app's bpm flips octave and drifts, so a bar count from it is unreliable; a phrase's duration in
 * seconds is the same whichever octave the tracker chose), and returns a modest score multiplier for a candidate boundary that
 * lands where the phrase grid says a boundary is due. It never suppresses (the multiplier is >= 1), it learns nothing from
 * irregular music (no consistent gap -> no period -> 1), and it starts from nothing for every song (`reset`).
 *
 * Estimation: the last `maxEvents` confirmed boundary times; every pairwise difference (and its half and third) inside
 * [`minPeriod`, `maxPeriod`] is a candidate period P; the evidence of P is the number of pairs whose difference is a whole
 * number of P (k = 1..6) within a tolerance (`tolFrac` of P, clamped to `[tolMinSec, tolMaxSec]` seconds), MINUS the number a
 * random set of boundaries would have matched by luck (a small P with a wide tolerance explains almost anything: the chance
 * share of one pair is `2 * tol / P`). The largest excess wins, a tie goes to the LARGER period (a sub-multiple always explains
 * as much, and a phrase is longer than a bar). The strength of belief is `min(1, excess / 3)`: one gap between two events is a
 * weak hint, three consistent pairs beyond chance are a period.
 *
 * `multiplier(t)`: `1 + (boost - 1) * belief` when `t` is within the tolerance of `last + k P` for k = 1..`maxK`, else 1.
 *
 * Pure, allocation-free after construction apart from two small scratch arrays.
 */

export interface PhrasePriorConfig {
  minPeriod: number
  maxPeriod: number
  tolFrac: number
  tolMinSec: number
  tolMaxSec: number
  maxEvents: number
  maxK: number
  /** Multiplier at full belief. */
  boost: number
  /** Events closer than this are one event. */
  mergeSec: number
}

export const DEFAULT_PHRASE_PRIOR: Readonly<PhrasePriorConfig> = Object.freeze({
  minPeriod: 6,
  maxPeriod: 48,
  tolFrac: 0.05,
  tolMinSec: 0.5,
  tolMaxSec: 1.5,
  maxEvents: 8,
  maxK: 4,
  boost: 1.15,
  mergeSec: 3,
})

export interface PhraseEstimate {
  period: number
  /** Pairs of boundaries a whole number of periods apart, and how many of them beyond what chance alone would give. */
  evidence: number
  excess: number
  belief: number
}

export class PhrasePrior {
  readonly cfg: PhrasePriorConfig
  private readonly t: number[] = []
  private est: PhraseEstimate | null = null

  constructor(cfg: Partial<PhrasePriorConfig> = {}) {
    this.cfg = { ...DEFAULT_PHRASE_PRIOR, ...cfg }
  }

  reset(): void {
    this.t.length = 0
    this.est = null
  }

  /** The current estimate (null: no period yet). */
  get estimate(): PhraseEstimate | null {
    return this.est
  }

  get last(): number {
    return this.t.length ? this.t[this.t.length - 1] : Number.NaN
  }

  private tol(p: number): number {
    const c = this.cfg
    return Math.min(c.tolMaxSec, Math.max(c.tolMinSec, c.tolFrac * p))
  }

  /** A confirmed boundary at time `time` (seconds). */
  add(time: number): void {
    if (!Number.isFinite(time)) return
    const c = this.cfg
    const n = this.t.length
    if (n > 0) {
      if (time < this.t[n - 1]) this.reset() // the clock went back: a new source
      else if (time - this.t[n - 1] < c.mergeSec) return
    }
    this.t.push(time)
    if (this.t.length > c.maxEvents) this.t.shift()
    this.est = this.estimateNow()
  }

  private estimateNow(): PhraseEstimate | null {
    const c = this.cfg
    const t = this.t
    const n = t.length
    if (n < 2) return null
    let best: PhraseEstimate | null = null
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const d = t[j] - t[i]
        for (let div = 1; div <= 3; div++) {
          const p = d / div
          if (p < c.minPeriod || p > c.maxPeriod) continue
          const tol = this.tol(p)
          let ev = 0
          let pairs = 0
          for (let a = 0; a < n; a++) {
            for (let b = a + 1; b < n; b++) {
              const dd = t[b] - t[a]
              pairs++
              const k = Math.round(dd / p)
              if (k >= 1 && k <= 6 && Math.abs(dd - k * p) <= tol) ev++
            }
          }
          const excess = ev - pairs * Math.min(1, (2 * tol) / p)
          if (best === null || excess > best.excess + 1e-9 || (Math.abs(excess - best.excess) <= 1e-9 && p > best.period)) {
            best = { period: p, evidence: ev, excess, belief: Math.min(1, Math.max(0, excess) / 3) }
          }
        }
      }
    }
    return best
  }

  /** Score multiplier (>= 1) for a candidate boundary at `time`. */
  multiplier(time: number): number {
    const e = this.est
    if (e === null || !Number.isFinite(time)) return 1
    const last = this.t[this.t.length - 1]
    const dt = time - last
    if (dt <= 0) return 1
    const k = Math.round(dt / e.period)
    if (k < 1 || k > this.cfg.maxK) return 1
    return Math.abs(dt - k * e.period) <= this.tol(e.period) ? 1 + (this.cfg.boost - 1) * e.belief : 1
  }
}
