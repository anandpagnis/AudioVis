/**
 * Conservative, causal downbeat (bar phase) estimator for 4/4 material.
 *
 * ## The problem this exists for
 *
 * The beat grid (`BpmEstimator` + `AudioEngine.advanceGrid`) knows WHERE the beats are but not WHICH beat
 * is beat 1: `beatIndex` starts counting on whatever grid crossing happened first, so the old
 * `beatInBar = beatIndex % 4` had an arbitrary phase - "beat 1 of the bar" was right about one time in
 * four. Everything that keys off `beatInBar` / `bar` (the phrase detector's boundary snap, the mandala's
 * once-a-bar fold step, the camera's bar sweep, the phrase-edge fallbacks) inherited that.
 *
 * ## The idea
 *
 * A downbeat is usually where the kick / bass is strongest and where energy lands. Each beat gets a small
 * salience value ({@link BeatSalienceGatherer}: kick-hit strength near the beat, plus how hard the
 * low band rises into it). {@link DownbeatEstimator} accumulates that into FOUR phase bins
 * (`beatIndex mod 4`) with a slow exponential decay (~12 bars of memory) and asks: does one phase beat
 * the runner-up by a clear margin, consistently?
 *
 * ## The one rule that matters: default to legacy
 *
 * The estimator only ever moves `offset` away from 0 when it is CONFIDENT. `offset === 0` is exactly the
 * legacy behaviour (`beatInBar = beatIndex % 4`), so "I don't know" costs nothing and every failure mode
 * lands there:
 *   - four-on-the-floor with equal weight on every beat -> no phase beats another -> stays 0;
 *   - ambient / no kick -> salience below the floor, nothing accumulates -> stays 0;
 *   - a jittery grid or noisy salience -> the significance test cannot clear -> stays 0;
 *   - kick on 1 AND 3 with equal weight -> two phases tie -> the margin is ~0 -> stays 0;
 *   - not 4/4 (3/4, 6/8, 5/4, ...) -> the mod-4 bins see a rotating pattern that averages flat -> stays 0.
 * Detecting other meters is out of scope: this ASSUMES 4/4 and simply stays low-confidence otherwise.
 *
 * Confidence is the WEAKER of two things, so neither a huge-but-noisy nor a tiny-but-perfectly-clean
 * difference can carry it alone:
 *   - effect size: the best bin must exceed the runner-up by a real fraction of itself (`relFull`);
 *   - significance: that difference in units of its own standard error (Welch-style, with a variance
 *     floor so a perfectly repeated pattern is not "infinitely certain").
 * Each beat's salience is first divided by the mean of the last four beats (a bar's worth, whatever the
 * alignment), so loud sections do not outweigh quiet ones and the absolute level cancels.
 *
 * ## Hysteresis: adopting, holding, moving
 *
 *   - ADOPT: confidence >= `enterConf` with the SAME best phase for `enterBeats` (16) consecutive
 *     evidence beats, after every phase bin has `minVisits` (6) samples. Earliest adoption is therefore
 *     ~10 bars in (~20 s at 120 BPM).
 *   - HOLD: once adopted the offset is held. Losing the kick (a breakdown) does NOT release it - the
 *     grid keeps counting and the bar phase stays true through it; there is simply no fresh evidence.
 *   - RE-ANCHOR: a DIFFERENT phase must be the best bin, with confidence >= `reanchorConf`, for
 *     `reanchorBeats` (16 = four bars) consecutive beats. Because the bins carry ~12 bars of memory, a
 *     real shift takes roughly 10-16 bars to overturn. That slowness is deliberate.
 *   - NEVER while the grid is unusable: beats fed with `usable = false` (grid confidence low, silence)
 *     accumulate nothing and break every persistence run. After `lossBeats` (16) consecutive unusable
 *     beats the grid is considered lost: the whole estimator resets (lock dropped, offset 0), because
 *     whatever grid comes back has an unrelated phase.
 *
 * CONSUMER CONTRACT: `beatInBar` / `bar` / `measure` derived from `offset` are continuous EXCEPT at an
 * adoption or re-anchor, where `beatInBar` jumps by an arbitrary amount once (e.g. 1 -> 3) and `bar` /
 * `measure` may step by one. That happens at most a handful of times per track by construction; consumers
 * must tolerate one discontinuity but need no special handling. `beatIndex` itself never changes.
 *
 * ## Beat-index jumps and resets
 *
 * `advanceGrid` can advance `beatIndex` by up to 4 in one frame (a hitch). Beats that were skipped carry
 * no evidence (the mod-4 mapping is still right because `beatIndex` counted them), so a gap just clears
 * the four-beat normalisation window. If the engine had to CAP a catch-up (the grid jumped further than
 * `beatIndex` could follow) the true bar phase may have slipped: it calls {@link
 * DownbeatEstimator.discontinuity}, which forgets the accumulated bins but keeps the adopted offset until
 * fresh evidence says otherwise (normal re-anchor rules). A `beatIndex` that goes BACKWARDS, or
 * `reset()` (new source), discards everything - a new track never inherits an old offset.
 *
 * Nothing in this file allocates per frame except one small result object per completed beat, and
 * nothing throws on non-finite input.
 */

export const BEATS_PER_BAR = 4

/** Tunables. Every one is a first guess made without live music - see the report / tuning list. */
export interface DownbeatConfig {
  /** Per-visit (i.e. per-bar) decay of a phase bin's memory. 0.92 ~ 12 bars. */
  decay: number
  /** Every phase bin needs this many samples before any confidence is reported. */
  minVisits: number
  /** Confidence needed to ADOPT a phase from the unlocked state. */
  enterConf: number
  /** Consecutive evidence beats the same phase must hold `enterConf` before adoption. */
  enterBeats: number
  /** Confidence a DIFFERENT phase needs to challenge an adopted offset. */
  reanchorConf: number
  /** Consecutive beats a challenger must hold `reanchorConf` before the offset moves (16 = 4 bars). */
  reanchorBeats: number
  /** Relative margin (best - runnerUp) / best at which the effect-size term reaches 1. */
  relFull: number
  /** Standard errors of separation at which the significance term reaches 1. */
  zFull: number
  /** Floor on a bin's variance (in units where a bin's mean is ~1), so a clean repeat is not "certain". */
  varFloor: number
  /** Below this sum of the last four salience values there is no evidence to normalise against. */
  sumFloor: number
  /** Consecutive unusable beats after which the grid is treated as lost and everything resets. */
  lossBeats: number
  /** A gap in `beatIndex` larger than this counts as a grid discontinuity, not a hitch. */
  maxGap: number
}

export const DEFAULT_DOWNBEAT_CONFIG: Readonly<DownbeatConfig> = Object.freeze({
  decay: 0.92,
  minVisits: 6,
  enterConf: 0.6,
  enterBeats: 16,
  reanchorConf: 0.7,
  reanchorBeats: 16,
  relFull: 0.35,
  zFull: 7.5,
  varFloor: 0.15 * 0.15,
  sumFloor: 0.08,
  lossBeats: 16,
  maxGap: 8,
})

const MAX_SALIENCE = 1e3

/** Bar-relative position of a beat: what `advanceGrid` writes into `beatInBar` / `bar` / `measure`. */
export interface BarPosition {
  /** 0..3, 0 = the downbeat. */
  beatInBar: number
  /** Bar count, clamped at 0. */
  bar: number
  /** 16-beat measure count (4 bars), clamped at 0. */
  measure: number
}

/**
 * `beatIndex` shifted by the downbeat `offset` (0..3). With `offset === 0` this is exactly the legacy
 * `beatIndex % 4` / `floor(beatIndex / 4)` / `floor(beatIndex / 16)`. Non-finite input reads as 0.
 */
export function barPosition(beatIndex: number, offset: number): BarPosition {
  const b = Number.isFinite(beatIndex) ? Math.trunc(beatIndex) : 0
  const o = Number.isFinite(offset) ? Math.trunc(offset) : 0
  const shifted = b - o
  const inBar = ((shifted % BEATS_PER_BAR) + BEATS_PER_BAR) % BEATS_PER_BAR
  const clamped = Math.max(0, shifted)
  return {
    beatInBar: inBar,
    bar: Math.floor(clamped / BEATS_PER_BAR),
    measure: Math.floor(clamped / (BEATS_PER_BAR * 4)),
  }
}

/**
 * Is this the first beat of every fourth bar (a 16-beat phrase edge)? The bar-phase-aware replacement
 * for the old `beatInBar === 0 && beatIndex % 16 === 0` test, which is only correct while the offset is
 * 0: with an adopted offset `beatIndex % 16 === 0` and `beatInBar === 0` can never both hold. Identical
 * to the old expression at offset 0 (`bar = beatIndex / 4` on a downbeat).
 */
export function isPhraseEdge(beat: boolean, beatInBar: number, bar: number): boolean {
  return beat && Math.floor(beatInBar) === 0 && bar > 0 && bar % 4 === 0
}

const NONE = -1

export class DownbeatEstimator {
  private readonly cfg: DownbeatConfig

  // Per-phase exponentially-decayed sums of the normalised salience x: weight, sum x, sum x^2, sum weight^2.
  private readonly w = new Float64Array(4)
  private readonly s1 = new Float64Array(4)
  private readonly s2 = new Float64Array(4)
  private readonly q = new Float64Array(4)
  private readonly visits = new Int32Array(4)

  // Last four salience values (a bar's worth, any alignment) for the level normalisation.
  private readonly ring = new Float64Array(4)
  private ringPos = 0
  private ringCount = 0

  private lastBeat: number | null = null
  private unusableRun = 0

  private _offset = 0
  private _locked = false
  private _confidence = 0
  private _candidate = NONE
  private _candidateConf = 0

  private enterPhase = NONE
  private enterRun = 0
  private challenger = NONE
  private challengeRun = 0

  constructor(cfg: Partial<DownbeatConfig> = {}) {
    this.cfg = { ...DEFAULT_DOWNBEAT_CONFIG, ...cfg }
  }

  /**
   * Beats to subtract from `beatIndex` to get the bar-relative beat: 0..3, and 0 (the legacy behaviour)
   * unless {@link locked}.
   */
  get offset(): number {
    return this._offset
  }

  /** True once a phase has been adopted with high confidence (the adopted phase may itself be 0). */
  get locked(): boolean {
    return this._locked
  }

  /**
   * 0..1 evidence for the phase currently in force: while locked, how clearly the ADOPTED phase still
   * beats the best other one (0 if another phase leads, and 0 right after a {@link discontinuity} until
   * the bins refill); while unlocked, how clearly the best candidate leads (it is not adopted until this
   * has held above `enterConf` for `enterBeats`).
   */
  get confidence(): number {
    return this._confidence
  }

  /** The currently leading phase (0..3) or -1 while there is not enough evidence. Diagnostic. */
  get candidate(): number {
    return this._candidate
  }

  /** Diagnostic: how clearly {@link candidate} leads, whether or not it has been adopted. */
  get candidateConfidence(): number {
    return this._candidateConf
  }

  /** Diagnostic: the four phase bins' mean normalised salience (1 = an average beat). */
  get phaseScores(): number[] {
    return [0, 1, 2, 3].map((p) => (this.w[p] > 0 ? this.s1[p] / this.w[p] : 0))
  }

  /** Forget everything: bins, lock, offset. A new source must never inherit the old offset. */
  reset(): void {
    this.w.fill(0)
    this.s1.fill(0)
    this.s2.fill(0)
    this.q.fill(0)
    this.visits.fill(0)
    this.ring.fill(0)
    this.ringPos = 0
    this.ringCount = 0
    this.lastBeat = null
    this.unusableRun = 0
    this._offset = 0
    this._locked = false
    this._confidence = 0
    this._candidate = NONE
    this._candidateConf = 0
    this.enterPhase = NONE
    this.enterRun = 0
    this.challenger = NONE
    this.challengeRun = 0
  }

  /**
   * The beat grid slipped in a way `beatIndex` did not follow (the engine capped a catch-up): the bar
   * phase relative to `beatIndex` may no longer be what the bins learned. Forgets the accumulated bins
   * and persistence runs but KEEPS an adopted offset - it is as likely right as any replacement - and
   * lets the normal re-anchor rules move it if fresh evidence disagrees.
   */
  discontinuity(): void {
    this.w.fill(0)
    this.s1.fill(0)
    this.s2.fill(0)
    this.q.fill(0)
    this.visits.fill(0)
    this.ringCount = 0
    this.unusableRun = 0
    this._confidence = 0
    this._candidate = NONE
    this._candidateConf = 0
    this.enterPhase = NONE
    this.enterRun = 0
    this.challenger = NONE
    this.challengeRun = 0
  }

  /**
   * Feed one beat.
   *
   * @param beatIndex the beat's integer index (`AudioFeatures.beatIndex`). Non-finite is ignored; a
   *   repeat is ignored; a lower value than the last one resets (a new grid fed without a reset).
   * @param salience  how strongly this beat reads as a downbeat, >= 0 (scale-free: only its ratio to the
   *   neighbouring beats matters). Non-finite / negative values read as unusable / 0.
   * @param usable    false when the beat grid was unstable or the program silent around this beat: the
   *   beat then contributes nothing and breaks every persistence run.
   */
  update(beatIndex: number, salience: number, usable = true): void {
    if (!Number.isFinite(beatIndex)) return
    const bi = Math.trunc(beatIndex)
    const cfg = this.cfg

    if (this.lastBeat !== null) {
      if (bi === this.lastBeat) return
      if (bi < this.lastBeat) this.reset()
      else if (bi - this.lastBeat > 1) {
        // Skipped beats have no evidence, but the mod-4 mapping is still right (beatIndex counted them).
        this.ringCount = 0
        if (bi - this.lastBeat > cfg.maxGap) this.discontinuity()
      }
    }
    this.lastBeat = bi

    if (!usable || !Number.isFinite(salience)) {
      this.unusableRun++
      this.ringCount = 0
      this.enterRun = 0
      this.challengeRun = 0
      if (this.unusableRun >= cfg.lossBeats) {
        // The grid has been gone long enough that whatever comes back has an unrelated phase.
        this.reset()
        this.lastBeat = bi
      }
      return
    }
    this.unusableRun = 0

    const s = Math.min(MAX_SALIENCE, Math.max(0, salience))
    this.ring[this.ringPos] = s
    this.ringPos = (this.ringPos + 1) & 3
    if (this.ringCount < 4) this.ringCount++
    if (this.ringCount < 4) return

    const sum = this.ring[0] + this.ring[1] + this.ring[2] + this.ring[3]
    if (!(sum >= cfg.sumFloor)) {
      // No kick / no low-end movement: nothing to learn from, and a run of nothing breaks persistence.
      this.enterRun = 0
      this.challengeRun = 0
      return
    }

    const x = (BEATS_PER_BAR * s) / sum
    const p = ((bi % 4) + 4) % 4
    const a = cfg.decay
    this.w[p] = a * this.w[p] + 1
    this.q[p] = a * a * this.q[p] + 1
    this.s1[p] = a * this.s1[p] + x
    this.s2[p] = a * this.s2[p] + x * x
    this.visits[p]++

    this.evaluate()
  }

  private mean(p: number): number {
    return this.w[p] > 0 ? this.s1[p] / this.w[p] : 0
  }

  /** Confidence (0..1) that phase `a` leads every other phase: min(effect size, significance). */
  private marginConf(a: number): number {
    const cfg = this.cfg
    let o = -1
    for (let p = 0; p < 4; p++) {
      if (p === a) continue
      if (o < 0 || this.mean(p) > this.mean(o)) o = p
    }
    const ma = this.mean(a)
    const diff = ma - this.mean(o)
    if (!(ma > 0) || !(diff > 0)) return 0
    const rel = diff / ma
    const va = Math.max(cfg.varFloor, this.s2[a] / this.w[a] - ma * ma)
    const mo = this.mean(o)
    const vo = Math.max(cfg.varFloor, this.s2[o] / this.w[o] - mo * mo)
    const na = (this.w[a] * this.w[a]) / this.q[a]
    const no = (this.w[o] * this.w[o]) / this.q[o]
    const z = diff / Math.sqrt(va / na + vo / no)
    const c = Math.min(rel / cfg.relFull, z / cfg.zFull)
    return c > 0 ? (c < 1 ? c : 1) : 0
  }

  private evaluate(): void {
    const cfg = this.cfg
    for (let p = 0; p < 4; p++) {
      if (this.visits[p] < cfg.minVisits) {
        this._candidate = NONE
        this._candidateConf = 0
        this._confidence = 0
        this.enterRun = 0
        this.challengeRun = 0
        return
      }
    }
    let best = 0
    for (let p = 1; p < 4; p++) if (this.mean(p) > this.mean(best)) best = p
    const c = this.marginConf(best)
    this._candidate = best
    this._candidateConf = c

    if (!this._locked) {
      if (c >= cfg.enterConf) {
        if (best === this.enterPhase) this.enterRun++
        else {
          this.enterPhase = best
          this.enterRun = 1
        }
      } else {
        this.enterRun = 0
        this.enterPhase = NONE
      }
      if (this.enterRun >= cfg.enterBeats) {
        this._offset = best
        this._locked = true
        this.enterRun = 0
        this.enterPhase = NONE
        this.challenger = NONE
        this.challengeRun = 0
      }
    } else if (best !== this._offset && c >= cfg.reanchorConf) {
      if (best === this.challenger) this.challengeRun++
      else {
        this.challenger = best
        this.challengeRun = 1
      }
      if (this.challengeRun >= cfg.reanchorBeats) {
        this._offset = best
        this.challenger = NONE
        this.challengeRun = 0
      }
    } else {
      this.challenger = NONE
      this.challengeRun = 0
    }

    this._confidence = this._locked ? this.marginConf(this._offset) : c
  }
}

/* ------------------------------------------------------------------------------------------------
 * Frame -> per-beat salience
 * ---------------------------------------------------------------------------------------------- */

/** Weight of the kick-hit term in a beat's salience. */
export const KICK_WEIGHT = 0.6
/** Weight of the low-band rise term. */
export const LOW_RISE_WEIGHT = 0.4
/** How fast the low-band trough tracker climbs back toward the signal, per second (0..1 scale). */
export const LOW_FLOOR_RISE_PER_SEC = 0.5
/** A beat window's first/last frame may miss the window edge by this many beats before it is dropped. */
export const COVERAGE_SLACK = 0.3

export interface BeatSalienceFrame {
  /** Continuous grid position: `beatIndex + beatProgress` (beat n is centred on `pos === n`). */
  pos: number
  /** A kick hit was detected this frame. */
  kickTrigger: boolean
  /** That hit's strength, 0..1 (ignored unless `kickTrigger`). */
  kickStrength: number
  /** Low-band level, 0..1 (`(f.sub + f.bass) / 2`). */
  low: number
  /** Seconds since the previous frame. */
  dt: number
  /** false while the grid is unreliable or the program is silent. */
  usable: boolean
}

export interface BeatSalience {
  beatIndex: number
  salience: number
  usable: boolean
}

/**
 * Collapses a per-frame stream into one salience value per beat, using NEAREST-beat attribution: beat n
 * owns grid positions `[n - 0.5, n + 0.5)`, so a kick landing a few tens of ms before or after the
 * crossing still counts for that beat. A window closes half a beat after its crossing (causal, at the
 * cost of that latency), and reports:
 *
 *   salience = KICK_WEIGHT * (strongest kick hit in the window)
 *            + LOW_RISE_WEIGHT * (biggest rise of the low band above its recent trough in the window)
 *
 * The trough tracker (`floor = min(low, floor + rate * dt)`) makes the low term a measure of bass ONSET
 * rather than of sustained level, so a droning bass does not read as a downbeat every beat.
 *
 * A window whose first/last frame did not reach within {@link COVERAGE_SLACK} of its edges (a frame
 * hitch, or the first beat after a reset) is dropped rather than reported with partial data. Pure and
 * allocation-free per frame except the returned object on a window close.
 */
export class BeatSalienceGatherer {
  private cur: number | null = null
  private first = 0
  private last = 0
  private kickPeak = 0
  private risePeak = 0
  private allUsable = true
  private floor = 0
  private haveFloor = false

  reset(): void {
    this.cur = null
    this.first = 0
    this.last = 0
    this.kickPeak = 0
    this.risePeak = 0
    this.allUsable = true
    this.floor = 0
    this.haveFloor = false
  }

  /** Feed one frame. Returns the just-closed beat's salience when this frame opened a new window. */
  frame(f: BeatSalienceFrame): BeatSalience | null {
    if (!Number.isFinite(f.pos)) return null
    const dt = Number.isFinite(f.dt) && f.dt > 0 ? Math.min(f.dt, 0.25) : 0
    const low = Number.isFinite(f.low) ? Math.min(1, Math.max(0, f.low)) : 0

    // Trough tracker: snaps down instantly, climbs back slowly.
    if (!this.haveFloor) {
      this.floor = low
      this.haveFloor = true
    } else {
      this.floor = Math.min(low, this.floor + LOW_FLOOR_RISE_PER_SEC * dt)
    }

    const wanted = Math.floor(f.pos + 0.5)
    let out: BeatSalience | null = null

    if (this.cur === null) {
      this.open(wanted, f.pos)
    } else if (wanted > this.cur) {
      out = this.close()
      this.open(wanted, f.pos)
    } else if (wanted < this.cur - 1) {
      // Position went well backwards (a new grid): start over rather than mix two clocks.
      this.cur = null
      this.open(wanted, f.pos)
    }
    // else: same window, or a small PLL step backwards across the boundary - stay in the current window.

    this.last = f.pos
    if (!f.usable) this.allUsable = false
    if (f.kickTrigger && Number.isFinite(f.kickStrength)) {
      const k = Math.min(1, Math.max(0, f.kickStrength))
      if (k > this.kickPeak) this.kickPeak = k
    }
    const rise = low - this.floor
    if (rise > this.risePeak) this.risePeak = rise
    return out
  }

  private open(n: number, pos: number): void {
    this.cur = n
    this.first = pos
    this.last = pos
    this.kickPeak = 0
    this.risePeak = 0
    this.allUsable = true
  }

  private close(): BeatSalience | null {
    const n = this.cur
    if (n === null) return null
    // Partial window (first beat after a reset, or a hitch skipped part of it): no honest number.
    if (this.first > n - 0.5 + COVERAGE_SLACK || this.last < n + 0.5 - COVERAGE_SLACK) return null
    return {
      beatIndex: n,
      salience: KICK_WEIGHT * this.kickPeak + LOW_RISE_WEIGHT * Math.min(1, this.risePeak),
      usable: this.allUsable,
    }
  }
}
