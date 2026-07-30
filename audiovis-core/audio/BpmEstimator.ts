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

export class BpmEstimator {
  period = 0.5 // seconds per beat (120 BPM)
  phase = 0 // reference beat time on the engine clock
  confidence = 0

  private onsets: Onset[] = []
  private bins = new Float32Array(BIN_COUNT)
  private lastEval = 0
  private lastCandidate = 0
  private stableCount = 0
  private hitScore = 0 // how often onsets land on the predicted grid
  private externalUntil = -1

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
    this.externalUntil = -1
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
      this.evaluate()
    }
    // With no recent onsets (silence/ambient), slowly relax confidence but
    // keep the grid free-running at the last known tempo.
    const last = this.onsets[this.onsets.length - 1]
    if (!last || now - last.t > 3) {
      this.confidence = Math.max(0, this.confidence - 0.02 * 0.016)
    }
  }

  private evaluate() {
    const os = this.onsets
    if (os.length < 8) {
      this.confidence *= 0.92
      return
    }

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
          const bpm = 60 / p
          // Soft prior toward common tempi (center ~120 BPM).
          const prior = Math.exp(-Math.pow((bpm - 120) / 55, 2))
          const w = (w0 / m) * (0.35 + 0.65 * prior)
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
    if (total <= 0) return

    let peakBin = 0
    let peakVal = 0
    for (let b = 0; b < BIN_COUNT; b++) {
      if (this.bins[b] > peakVal) {
        peakVal = this.bins[b]
        peakBin = b
      }
    }
    // Refine with a weighted mean around the peak.
    let wSum = 0
    let pSum = 0
    for (let b = Math.max(0, peakBin - 3); b <= Math.min(BIN_COUNT - 1, peakBin + 3); b++) {
      wSum += this.bins[b]
      pSum += this.bins[b] * (MIN_PERIOD + (b + 0.5) * BIN_SIZE)
    }
    const candidate = pSum / wSum
    const clarity = Math.min(1, (peakVal * 7) / total)
    const density = Math.min(1, os.length / 16)
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
      if (this.stableCount >= 2 || this.confidence < 0.08) {
        this.period = candidate
        this.stableCount = 0
      }
    }

    const target = candConf * (0.45 + 0.55 * this.hitScore)
    this.confidence += (target - this.confidence) * 0.3
  }
}
