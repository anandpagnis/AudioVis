/**
 * Dynamic tempo + beat-grid estimator.
 *
 * Tempo: inter-onset-interval histogram over a sliding 12 s window, with
 * harmonic folding (an interval of N beats votes for period/N) and a soft
 * prior toward musically common tempi. Re-evaluated twice per second so the
 * estimate tracks tempo changes.
 *
 * Phase: a free-running beat grid (phase + k * period). Onsets that land near
 * a predicted beat pull the phase toward them (phase-locked loop), so the
 * grid stays aligned while playing and keeps ticking through quiet sections.
 */

interface Onset {
  t: number
  s: number
}

const MIN_PERIOD = 60 / 200 // 200 BPM
const MAX_PERIOD = 60 / 60 // 60 BPM
const BIN_SIZE = 0.004
const BIN_COUNT = Math.ceil((MAX_PERIOD - MIN_PERIOD) / BIN_SIZE)
const WINDOW = 12 // seconds of onset history

/**
 * Ceiling on how strongly the 120-BPM prior can reweight the histogram. At
 * this mix the shaping matches the old always-on prior (0.35 + 0.65·gaussian);
 * the actual mix is scaled by histogram ambiguity, so a decisive peak is
 * trusted as-is and the prior only tie-breaks genuinely unclear windows.
 */
const PRIOR_MAX_MIX = 0.65
/** A ½×/2× octave sibling must beat the candidate's onset-grid fit by this
 * factor before we switch — keeps the correction from flapping on ties. This is
 * the base margin for a *cold* switch; leaving a well-supported metrical level
 * costs `+ octaveLock * OCTAVE_LOCK_MARGIN` on top (see {@link BpmEstimator}). */
const OCTAVE_SWITCH_MARGIN = 1.15
/** How much a fully-established `octaveLock` (1.0) adds to the switch margin
 * when a correction would push AWAY from the locked metrical level. */
const OCTAVE_LOCK_MARGIN = 0.9
/** Above this `octaveLock` a sparse-passage octave read is reclaimed by the
 * lock rather than followed, and the persist-before-jump gate holds an octave
 * jump entirely. Below it the lock has eroded enough to let a genuine metrical
 * change through. */
const OCTAVE_LOCK_HOLD = 0.35

/**
 * Reconcile a soft model tempo read (Essentia) against a confident internal
 * lock, folding an obvious ½×/2× octave error onto the locked metrical level.
 *
 * `degara` reports no confidence and does no octave folding of its own, so a
 * 152-BPM track can come back as a clean-looking 76. When the internal grid is
 * already locked with real confidence and the model read is ~half or ~double it,
 * trust the grid's octave and fold the model onto it — the model still gets to
 * refine the *rate*, it just doesn't get to halve the whole show. A model read
 * that carries its own strong confidence (multifeature ≥ ~0.7), or that lands
 * somewhere unrelated, passes through untouched.
 */
export function reconcileModelBpm(
  modelBpm: number,
  refBpm: number,
  refConfidence: number,
  modelConf: number,
): number {
  if (!Number.isFinite(modelBpm) || modelBpm <= 0) return modelBpm
  if (!Number.isFinite(refBpm) || refBpm <= 0) return modelBpm
  if (refConfidence < 0.6 || modelConf >= 0.7) return modelBpm
  for (const mult of [0.5, 2] as const) {
    if (Math.abs(modelBpm * mult - refBpm) / refBpm < 0.06) return modelBpm * mult
  }
  return modelBpm
}

export class BpmEstimator {
  period = 0.5 // seconds per beat (120 BPM)
  phase = 0 // reference beat time on the engine clock
  confidence = 0

  private onsets: Onset[] = []
  private bins = new Float32Array(BIN_COUNT)
  private scored = new Float32Array(BIN_COUNT)
  private lastEval = 0
  private lastCandidate = 0
  private stableCount = 0
  /** How tightly onsets are landing on the predicted grid, 0..1. Already fed
   * into `confidence`; exposed on its own as a beat-tracking-accuracy signal. */
  hitScore = 0
  /** Octave correction applied by the last evaluation: 1 = none, 0.5 = the
   * histogram's pick was halved (double-time error), 2 = doubled (half-time
   * error). Exposed for the debug panel. */
  octaveCorrection: 0.5 | 1 | 2 = 1
  /**
   * 0..1 — how strongly the CURRENT metrical level is backed by dense,
   * well-fitting onset evidence. Rises quickly while a dense section confirms
   * `period` is best among its octave siblings; decays slowly otherwise, so a
   * sparse verse cannot erase a lock a chorus established. This is the memory
   * the old recompute-from-scratch octave correction lacked: the ~8 % of
   * samples where the tempo read flipped 76↔152 were sparse passages that are
   * information-theoretically ambiguous between the two — only carried-forward
   * evidence of the dense sections resolves them (F121).
   */
  octaveLock = 0
  private externalUntil = -1

  private modelBpm = 0
  private modelConf = 0
  private modelUntil = -1

  reset(phase = 0) {
    this.period = 0.5
    this.phase = phase
    this.confidence = 0
    this.onsets = []
    this.bins.fill(0)
    this.lastEval = 0
    this.lastCandidate = 0
    this.stableCount = 0
    this.hitScore = 0
    this.octaveCorrection = 1
    this.octaveLock = 0
    this.externalUntil = -1
    this.modelBpm = 0
    this.modelConf = 0
    this.modelUntil = -1
  }

  /**
   * Tempo read from the Essentia worker (RhythmExtractor2013). A *soft*
   * source, unlike setExternalTempo: it supplies the candidate period (and,
   * when the multifeature method ran, Essentia's own 0..1 reliability score)
   * but flows through the same octave-check / persist-before-jump policy as
   * the internal histogram, and the PLL keeps owning phase via onsets. While
   * a read is fresh the internal IOI histogram is skipped; when reads stop
   * (worker dead, WASM unsupported) the histogram resumes automatically.
   */
  setModelTempo(bpm: number, confidence01: number, now: number, freshSec = 8) {
    if (!Number.isFinite(bpm) || bpm <= 0) return
    this.modelBpm = bpm
    this.modelConf = Math.max(0, Math.min(1, confidence01))
    this.modelUntil = now + freshSec
  }

  /** True while a fresh worker read is the candidate source (debug panel). */
  isModelDriven(now: number): boolean {
    return now < this.modelUntil && this.modelBpm > 0
  }

  /**
   * Phase 7: externally supplied tempo (MIDI clock, a future Link/OSC bridge).
   * Overrides the internal estimator while the clock keeps feeding it; expires
   * automatically ~2 s after the last call so a stopped clock hands control
   * back to onset tracking instead of freezing the grid.
   */
  setExternalTempo(bpm: number, beatTime: number, now: number) {
    const clamped = Math.min(300, Math.max(30, bpm))
    this.period = 60 / clamped
    this.phase = beatTime
    this.confidence = 1
    this.externalUntil = now + 2
  }

  isExternal(now: number): boolean {
    return now < this.externalUntil
  }

  get bpm(): number {
    return 60 / this.period
  }

  /** Signed distance from t to the nearest grid beat. */
  gridError(t: number): number {
    const k = Math.round((t - this.phase) / this.period)
    return t - (this.phase + k * this.period)
  }

  addOnset(t: number, strength: number) {
    if (this.isExternal(t)) return // an external clock owns the grid
    this.onsets.push({ t, s: strength })
    const err = this.gridError(t)
    const tolerance = this.period * 0.3
    if (Math.abs(err) < tolerance) {
      // Pull the grid toward the onset; stronger onsets pull harder.
      this.phase += err * 0.28 * Math.min(1, strength + 0.3)
      const hit = 1 - Math.abs(err) / tolerance
      this.hitScore = this.hitScore * 0.85 + hit * 0.15
    } else {
      this.hitScore *= 0.92
    }
  }

  update(now: number) {
    if (this.isExternal(now)) {
      this.confidence = 1
      return
    }
    if (this.onsets.length > 0 && now - this.onsets[0].t > WINDOW) {
      this.onsets = this.onsets.filter((o) => now - o.t < WINDOW)
    }
    if (now - this.lastEval > 0.5) {
      this.lastEval = now
      this.evaluate(now)
    }
    // With no recent onsets (silence/ambient), slowly relax confidence but
    // keep the grid free-running at the last known tempo.
    const last = this.onsets[this.onsets.length - 1]
    if (!last || now - last.t > 3) {
      this.confidence = Math.max(0, this.confidence - 0.02 * 0.016)
    }
  }

  private evaluate(now: number) {
    const os = this.onsets
    const modelFresh = this.isModelDriven(now)
    if (!modelFresh && os.length < 8) {
      this.confidence *= 0.92
      return
    }

    let candidate: number
    let clarity: number
    if (modelFresh) {
      // Essentia worker read is the candidate source; the histogram is skipped
      // entirely (its work is redundant while the model is fresh).
      candidate = Math.min(MAX_PERIOD, Math.max(MIN_PERIOD, 60 / this.modelBpm))
      clarity = this.modelConf
    } else {
      const h = this.histogramCandidate()
      if (!h) return
      candidate = h.candidate
      clarity = h.clarity
    }

    // --- Octave-error correction: the candidate source (histogram OR model)
    // can prefer ½× or 2× of the true period (half/double-time). Test the
    // candidate and its octave siblings against the actual onsets — which
    // grid do the observed hits land on — and take the best fit, not the
    // biggest vote pile. Skipped when too few onsets exist to test against.
    //
    // The switch is now ASYMMETRIC around the current metrical level: a sibling
    // that pulls BACK toward `this.period`'s octave is cheap (or free, when
    // `octaveLock` is high — a sparse passage's half-tempo read is reclaimed by
    // the lock rather than followed), while one that pushes AWAY is resisted in
    // proportion to `octaveLock`. This is what stops the 76↔152 flip: the
    // sparse verse can no longer win the octave the dense chorus established.
    let fitQuality = 0
    if (os.length >= 8) {
      const baseFit = this.gridFit(candidate)
      let bestFit = baseFit
      let correction: 0.5 | 1 | 2 = 1
      const octavesFromLock = (p: number) => Math.abs(Math.log2(p / this.period))
      const candDist = octavesFromLock(candidate)
      for (const mult of [0.5, 2] as const) {
        const p2 = candidate * mult
        if (p2 < MIN_PERIOD || p2 > MAX_PERIOD) continue
        const fit = this.gridFit(p2)
        const pullingHome = octavesFromLock(p2) < 0.15 && this.octaveLock > OCTAVE_LOCK_HOLD
        if (pullingHome && fit > baseFit * (1 - 0.5 * this.octaveLock)) {
          // A well-supported metrical level reclaims a sparse-passage octave
          // read without having to out-score it outright.
          if (fit > bestFit) bestFit = fit
          correction = mult
        } else {
          const leavingLock = octavesFromLock(p2) > candDist + 0.05
          const margin =
            OCTAVE_SWITCH_MARGIN + (leavingLock ? this.octaveLock * OCTAVE_LOCK_MARGIN : 0)
          if (fit > bestFit && fit > baseFit * margin) {
            bestFit = fit
            correction = mult
          }
        }
      }
      this.octaveCorrection = correction
      if (correction !== 1) candidate *= correction
      fitQuality = bestFit

      // --- Metrical-level memory: reinforce `octaveLock` only when a dense
      // window confirms `period` is genuinely the best octave, decay it slowly
      // the rest of the time (a sparse verse must not erase a chorus's lock).
      const slowerP = this.period * 2
      const fasterP = this.period * 0.5
      const selfFit = this.gridFit(this.period)
      const slowerFit = slowerP <= MAX_PERIOD ? this.gridFit(slowerP) : 0
      const fasterFit = fasterP >= MIN_PERIOD ? this.gridFit(fasterP) : 0
      const wellSupported =
        os.length >= 12 && selfFit > 0.6 && selfFit >= slowerFit && selfFit >= fasterFit
      this.octaveLock += ((wellSupported ? 1 : 0) - this.octaveLock) * (wellSupported ? 0.15 : 0.03)
    } else {
      this.octaveCorrection = 1
    }
    // degara reports no confidence — fall back to grid-fit quality as the
    // reliability read, but only when the applied octave is trusted; otherwise
    // a wrong-octave candidate would launder its grid-fit into "model reliability".
    if (modelFresh && clarity <= 0) {
      clarity =
        os.length >= 8 && this.octaveCorrection === 1 ? fitQuality : Math.max(0.3, this.hitScore)
    }

    const density = modelFresh ? 1 : Math.min(1, os.length / 16)
    const candConf = clarity * density

    const rel = Math.abs(candidate - this.period) / this.period
    if (rel < 0.05) {
      // Same tempo — refine smoothly.
      this.period += (candidate - this.period) * 0.25
      this.stableCount = 0
    } else {
      // Different tempo — require it to persist before jumping (handles
      // tempo changes without chasing noise).
      if (Math.abs(candidate - this.lastCandidate) / candidate < 0.04) {
        this.stableCount++
      } else {
        this.stableCount = 0
      }
      this.lastCandidate = candidate
      // A well-supported metrical level does not yield to an octave jump at all
      // until `octaveLock` has eroded (a sustained ½/2× section outlasting the
      // lock's decay) or confidence has collapsed. `stableCount` keeps counting
      // meanwhile, so a genuine metrical change flips the instant the lock lets go.
      const octaveJump = Math.abs(Math.abs(Math.log2(candidate / this.period)) - 1) < 0.15
      const lockedIn = octaveJump && this.octaveLock > OCTAVE_LOCK_HOLD && this.confidence > 0.15
      if (!lockedIn && (this.stableCount >= 2 || this.confidence < 0.08)) {
        this.period = candidate
        this.stableCount = 0
      }
    }

    const target = candConf * (0.45 + 0.55 * this.hitScore)
    this.confidence += (target - this.confidence) * 0.3
  }

  /** IOI-histogram candidate + clarity — the built-in tempo source, used
   * whenever no fresh Essentia read exists. Returns null on an empty window. */
  private histogramCandidate(): { candidate: number; clarity: number } | null {
    const os = this.onsets
    // --- IOI histogram: raw data votes only; the prior is applied later,
    // conditionally, so it can't drag a clear peak toward 120. ---
    this.bins.fill(0)
    let total = 0
    for (let i = 0; i < os.length; i++) {
      for (let j = i + 1; j < os.length; j++) {
        const d = os[j].t - os[i].t
        if (d > 4) break
        if (d < 0.2) continue
        const w0 = os[i].s * os[j].s
        // An interval of m beats votes for period d/m.
        for (let m = 1; m <= 8; m++) {
          const p = d / m
          if (p < MIN_PERIOD || p > MAX_PERIOD) continue
          const w = w0 / m
          const bin = (p - MIN_PERIOD) / BIN_SIZE
          const b0 = Math.floor(bin)
          for (let k = -2; k <= 2; k++) {
            const b = b0 + k
            if (b < 0 || b >= BIN_COUNT) continue
            const dist = bin - b
            const g = Math.exp(-dist * dist * 0.7)
            this.bins[b] += w * g
            total += w * g
          }
        }
      }
    }
    if (total <= 0) return null

    // --- Conditional 120-BPM prior: measure how decisive the raw data is
    // first, and only let the prior reweight in proportion to the ambiguity.
    // A clean unusual tempo (say 82) keeps its peak; a mushy histogram gets
    // the same tie-break shaping as before. ---
    let rawPeak = 0
    for (let b = 0; b < BIN_COUNT; b++) if (this.bins[b] > rawPeak) rawPeak = this.bins[b]
    const clarity = Math.min(1, (rawPeak * 7) / total)
    const priorMix = PRIOR_MAX_MIX * (1 - clarity)
    for (let b = 0; b < BIN_COUNT; b++) {
      const bpm = 60 / (MIN_PERIOD + (b + 0.5) * BIN_SIZE)
      const prior = Math.exp(-Math.pow((bpm - 120) / 55, 2))
      this.scored[b] = this.bins[b] * (1 - priorMix * (1 - prior))
    }

    let peakBin = 0
    let peakVal = 0
    for (let b = 0; b < BIN_COUNT; b++) {
      if (this.scored[b] > peakVal) {
        peakVal = this.scored[b]
        peakBin = b
      }
    }
    // Refine with a weighted mean around the peak.
    let wSum = 0
    let pSum = 0
    for (let b = Math.max(0, peakBin - 3); b <= Math.min(BIN_COUNT - 1, peakBin + 3); b++) {
      wSum += this.scored[b]
      pSum += this.scored[b] * (MIN_PERIOD + (b + 0.5) * BIN_SIZE)
    }
    const candidate = pSum / wSum
    return { candidate, clarity }
  }

  /**
   * How well a beat period `p` explains the onsets in the window, 0..1.
   *
   * Scored on *adjacent* inter-onset intervals rather than an absolute grid
   * anchored at one point. An anchored grid extrapolates across the whole 12 s
   * window, so a candidate that is off by even 1.5% accumulates phase error
   * until nothing matches — and because its tolerance scales with `p`, the
   * doubled period always tolerates that drift better and wins. Measuring
   * interval-by-interval is local, so a slightly-off candidate stays slightly
   * off instead of drifting away.
   *
   * Two terms, and both are needed to pin the metrical level:
   *  - `fit`: each interval should be close to a whole number of periods.
   *    A doubled period makes every real interval a half-integer (0.5, 1.5…),
   *    which scores zero — this is what rejects half-time.
   *  - `occupancy`: onsets per expected beat. A halved period fits the
   *    intervals perfectly (they land on 2, 4…) but leaves half its beats
   *    empty — this is what rejects double-time.
   *
   * The occupancy PENALTY is kept (a too-fast period with empty beats still
   * scores low — this is what rejects double-time), but its former mirror-image
   * REWARD is now density-gated: in a sparse passage where real onsets land
   * every other beat, "a hit on every predicted beat" no longer boosts the
   * half-tempo grid over the true one, because we can't tell "wrong period"
   * from "sparse music" without more onsets than a sparse window holds. That
   * asymmetry is what made `gridFit(halfTempo) > gridFit(true)` in the F121
   * sparse passages.
   */
  private gridFit(p: number): number {
    const os = this.onsets
    if (os.length < 2) return 0
    let fitW = 0
    let totalW = 0
    let expectedBeats = 0
    let intervals = 0
    for (let i = 1; i < os.length; i++) {
      const d = os[i].t - os[i - 1].t
      if (d <= 0) continue
      const w = Math.min(os[i].s, os[i - 1].s)
      const r = d / p
      const k = Math.max(1, Math.round(r))
      const err = Math.abs(r - k) // in periods, 0..0.5
      totalW += w
      fitW += w * Math.max(0, 1 - err / 0.3)
      expectedBeats += k
      intervals++
    }
    if (totalW <= 0 || expectedBeats <= 0) return 0
    const occupancy = Math.min(1, intervals / expectedBeats)
    // `densFactor` → 1 only with a dense window (~1.5 onsets/s over 12 s); when
    // it is low, occupancy stops pulling the score down and the histogram/prior
    // and `octaveLock` decide the metrical level instead. At `densFactor = 1`
    // this reduces exactly to the old `(0.3 + 0.7·occupancy)`.
    const densFactor = Math.min(1, os.length / (WINDOW * 1.5))
    return (fitW / totalW) * (1 - 0.7 * densFactor * (1 - occupancy))
  }
}
