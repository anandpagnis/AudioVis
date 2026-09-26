/**
 * The boundary-ANCHORED bar grid.
 *
 * There is no reliable downbeat in the live signal (`DownbeatEstimator` locks on 0 of 60 real clips) and the beat index
 * is an arbitrary count from whenever the tracker locked, so `beatIndex % 4` says nothing about where the music's bars
 * are. What IS reliable is where the section changes fall: in dance music and most pop they fall on a bar line, and
 * usually on a 4-bar phrase line. So the grid is LEARNED from the changes themselves (plan: "Boundary-anchored bar
 * grid"): every confirmed boundary votes for `beat mod 4` and `beat mod 16`, and the winning phase, with a confidence,
 * is the bar phase.
 *
 * VOTES. A boundary beat is a float (the scorer's estimate before snapping); its vote is split between the two
 * neighbouring bins (a triangular kernel), so an estimate that wobbles by a beat smears the histogram instead of
 * flipping the phase. Old votes decay ({@link BarGridConfig.decay} per boundary) so a phase change of the music (a
 * tempo or grid jump, which also resets the grid) is followed. The phase is the circular mean of the histogram and the
 * confidence combines how peaked it is (resultant length) with how much evidence there is:
 *
 *     conf = R * T / (T + evidenceOffset)         R = |sum h_i e^(i 2 pi i / n)| / T,  T = total vote weight
 *
 * so a single consistent boundary gives ~0.55, two ~0.7, and a smeared or contradictory histogram stays low. Votes come
 * from the UNSNAPPED estimate, never from the snapped beat, otherwise the grid would confirm itself.
 *
 * USE (all soft; nothing here can create or suppress an event on its own):
 *  - {@link BarGrid.multiplier}: a candidate change on the anchored bar phase has its score multiplied by 1.25, on the
 *    anchored 16-beat phase by a further 1.15 (the scorer does not apply it to a candidate whose score already clears
 *    1.5x its threshold, so a strong off-grid change is never lost to a wrong phase).
 *  - {@link BarGrid.snap}: once the grid is confident, a boundary estimate is moved to the nearest bar line within
 *    +-2 beats (the score peak is only good to about a beat; the music's bar line is exact).
 *  - {@link BarGrid.beatsToBarLine}: where the next bar line is, for the show adapter's CUT alignment.
 *  - `DownbeatEstimator` is ONLY a tie-breaker ({@link BarGrid.setHint}): it supplies the phase while no boundary has
 *    voted yet and settles a near-tie between the two best bins. It never overrides a confident histogram.
 *
 * Pure; the histograms are fixed typed arrays.
 */

export interface BeatPrior {
  /** Score multiplier for a candidate whose boundary is at `beat` (>= 1). */
  multiplier(beat: number): number
  /** The boundary beat after snapping (integer). */
  snap(beat: number): number
}

export interface BarGridConfig {
  /** Every added boundary multiplies the existing votes by this. */
  decay: number
  /** `conf` needed for the prior boost / for snapping. */
  anchorMinConf: number
  snapMinConf: number
  /** Score multipliers on the anchored bar phase and (additionally) the 16-beat phase. */
  barBoost: number
  phraseBoost: number
  phraseMinConf: number
  /** Snap window, in beats, either side. */
  snapBeats: number
  /** `T + evidenceOffset` in the confidence. */
  evidenceOffset: number
}

export const DEFAULT_BAR_GRID: Readonly<BarGridConfig> = Object.freeze({
  decay: 0.92,
  anchorMinConf: 0.5,
  snapMinConf: 0.6,
  barBoost: 1.25,
  phraseBoost: 1.15,
  phraseMinConf: 0.5,
  snapBeats: 2,
  evidenceOffset: 0.6,
})

const TWO_PI = Math.PI * 2
const mod = (x: number, n: number): number => ((x % n) + n) % n

/** Circular mean phase (in bins, 0..n) and resultant length R of a histogram; total is passed in. */
function circular(h: Float64Array, total: number): { phase: number; r: number } {
  const n = h.length
  let c = 0
  let s = 0
  for (let i = 0; i < n; i++) {
    const a = (TWO_PI * i) / n
    c += h[i] * Math.cos(a)
    s += h[i] * Math.sin(a)
  }
  if (!(total > 1e-9)) return { phase: 0, r: 0 }
  const r = Math.sqrt(c * c + s * s) / total
  const phase = mod((Math.atan2(s, c) * n) / TWO_PI, n)
  return { phase, r: r > 1 ? 1 : r }
}

export class BarGrid implements BeatPrior {
  readonly cfg: BarGridConfig
  private readonly h4 = new Float64Array(4)
  private readonly h16 = new Float64Array(16)
  private total = 0
  private p4 = 0
  private p16 = 0
  private c4 = 0
  private c16 = 0
  private a4 = -1
  private a16 = -1
  private hintLocked = false
  private hintOffset = 0
  /** Boundaries that voted since the last reset. */
  votes = 0

  constructor(cfg: Partial<BarGridConfig> = {}) {
    this.cfg = { ...DEFAULT_BAR_GRID, ...cfg }
  }

  reset(): void {
    this.h4.fill(0)
    this.h16.fill(0)
    this.total = 0
    this.p4 = 0
    this.p16 = 0
    this.c4 = 0
    this.c16 = 0
    this.a4 = -1
    this.a16 = -1
    this.votes = 0
  }

  /** The `DownbeatEstimator`'s read: bar lines are the beats with `(beat - offset) % 4 === 0`. */
  setHint(locked: boolean, offset: number): void {
    this.hintLocked = locked && Number.isFinite(offset)
    this.hintOffset = this.hintLocked ? mod(Math.round(offset), 4) : 0
  }

  /** Register a confirmed boundary at (float) `beat` with vote `weight` (0..1). Non-finite input is ignored. */
  addBoundary(beat: number, weight = 1): void {
    if (!Number.isFinite(beat) || !(weight > 0)) return
    const d = this.cfg.decay
    for (let i = 0; i < 4; i++) this.h4[i] *= d
    for (let i = 0; i < 16; i++) this.h16[i] *= d
    this.total *= d
    this.vote(this.h4, beat, weight)
    this.vote(this.h16, beat, weight)
    this.total += weight
    this.votes++
    this.refresh()
  }

  private vote(h: Float64Array, beat: number, w: number): void {
    const n = h.length
    const b = mod(beat, n)
    const i0 = Math.floor(b)
    const frac = b - i0
    h[i0 % n] += w * (1 - frac)
    h[(i0 + 1) % n] += w * frac
  }

  private refresh(): void {
    const t = this.total
    const q4 = circular(this.h4, t)
    const q16 = circular(this.h16, t)
    const ev = t / (t + this.cfg.evidenceOffset)
    this.p4 = q4.phase
    this.p16 = q16.phase
    this.c4 = q4.r * ev
    this.c16 = q16.r * ev
    this.a4 = t > 1e-9 ? Math.round(q4.phase) % 4 : -1
    this.a16 = t > 1e-9 ? Math.round(q16.phase) % 16 : -1
    // Near-tie between the two best bins: the downbeat estimator (only when it is locked) decides.
    if (this.hintLocked && this.a4 >= 0) {
      let best = -1
      let second = -1
      for (let i = 0; i < 4; i++) {
        if (best < 0 || this.h4[i] > this.h4[best]) {
          second = best
          best = i
        } else if (second < 0 || this.h4[i] > this.h4[second]) second = i
      }
      const near = second >= 0 && this.h4[best] > 0 && this.h4[second] >= 0.85 * this.h4[best]
      if (near && (this.hintOffset === best || this.hintOffset === second)) this.a4 = this.hintOffset
    }
  }

  /** Confidence (0..1) of the bar phase / the 16-beat phase. */
  get confidence(): number {
    return this.c4
  }
  get phraseConfidence(): number {
    return this.c16
  }
  /** Float phases (bins), for diagnostics. */
  get phaseFloat(): number {
    return this.p4
  }

  /** The histogram has enough consistent evidence for the soft prior. */
  anchored(): boolean {
    return this.a4 >= 0 && this.c4 >= this.cfg.anchorMinConf
  }

  /** ... and for snapping / driving cut alignment. */
  snapReady(): boolean {
    return this.a4 >= 0 && this.c4 >= this.cfg.snapMinConf
  }

  /** The 16-beat phase is anchored AND consistent with the bar phase. */
  phraseAnchored(): boolean {
    return this.anchored() && this.a16 >= 0 && this.c16 >= this.cfg.phraseMinConf && this.a16 % 4 === this.a4
  }

  /** Bar phase in 0..3 (the beats `b` with `b % 4 === phase` are bar lines); the hint while nothing has voted; else -1. */
  phase(): number {
    if (this.a4 >= 0) return this.a4
    return this.hintLocked ? this.hintOffset : -1
  }

  /** Position of `beat` in the anchored bar (0 = the bar line), or -1 when there is no phase. */
  beatInBar(beat: number): number {
    const p = this.phase()
    return p < 0 || !Number.isFinite(beat) ? -1 : mod(Math.round(beat) - p, 4)
  }

  /** Beats from `beat` to the next bar line (0 = `beat` IS one), or -1 unless the grid is trustworthy enough to cut on. */
  beatsToBarLine(beat: number): number {
    if (!Number.isFinite(beat)) return -1
    if (!this.snapReady() && !(this.a4 < 0 && this.hintLocked)) return -1
    const p = this.phase()
    return p < 0 ? -1 : mod(p - Math.round(beat), 4)
  }

  multiplier(beat: number): number {
    if (!this.anchored() || !Number.isFinite(beat)) return 1
    const b = Math.round(beat)
    if (mod(b - this.a4, 4) !== 0) return 1
    let m = this.cfg.barBoost
    if (this.phraseAnchored() && mod(b - this.a16, 16) === 0) m *= this.cfg.phraseBoost
    return m
  }

  snap(beat: number): number {
    const r = Math.round(beat)
    if (!this.snapReady() || !Number.isFinite(beat)) return r
    // Nearest bar-line beat to the float estimate within the snap window; a tie goes to the earlier line.
    let best = r
    let bestD = Number.POSITIVE_INFINITY
    for (let c = r - this.cfg.snapBeats; c <= r + this.cfg.snapBeats; c++) {
      if (mod(c - this.a4, 4) !== 0) continue
      const dist = Math.abs(c - beat)
      if (dist < bestD - 1e-9) {
        bestD = dist
        best = c
      }
    }
    return bestD <= this.cfg.snapBeats + 0.5 ? best : r
  }
}
