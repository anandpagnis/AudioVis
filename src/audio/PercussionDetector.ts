/**
 * Independent kick / snare / hi-hat detection.
 *
 * The main onset detector answers "did something happen?" — one broadband
 * trigger the whole beat grid rides on. That is the right signal for TIMING,
 * but it collapses a kick, a snare and a hat into a single event, so visuals
 * driven from it can only ever pulse in unison. This runs a separate
 * adaptive-threshold detector per drum band, so the three become independently
 * routable: a kick can shake the camera while hats sparkle particles and the
 * snare flashes something else entirely.
 *
 * Deliberately plain DSP — band-limited flux + a rolling mean/σ threshold, the
 * same technique the main onset detector uses, just confined to a band. No ML,
 * no lookahead, sample-accurate to the frame. (Real source separation would
 * need a stem model, which costs 100–500 ms of latency — fine for deciding
 * *what* is playing, useless for deciding *when* a hit lands. Per-hit timing
 * has to stay here.)
 */

/**
 * Rolling flux-history window in SECONDS, matching the main onset detector.
 * Was a fixed 60-sample count — "≈ 1 s at 60 fps", but 2 s at 30 fps and 0.4 s
 * at 144 fps, so the adaptive threshold's mean/σ drifted with the display.
 */
const HISTORY_SEC = 1.0
/** Below this many samples in the window, mean/σ aren't meaningful yet. */
const MIN_SAMPLES = 20

interface BandConfig {
  /** Threshold sensitivity in σ above the rolling mean. Higher = fewer hits. */
  sigma: number
  /** Minimum seconds between hits — the band's fastest musically real rate. */
  minInterval: number
  /** Envelope decay rate; larger falls faster. */
  decay: number
}

/**
 * Per-band tuning. Hats are the fastest and quietest (low sigma, short
 * interval, snappy decay); kicks are the slowest and most dominant, and get a
 * higher bar so bass wobble doesn't read as a hit.
 */
const CONFIG: Record<PercussionBand, BandConfig> = {
  kick: { sigma: 1.9, minInterval: 0.09, decay: 9 },
  snare: { sigma: 2.0, minInterval: 0.08, decay: 11 },
  hihat: { sigma: 1.7, minInterval: 0.04, decay: 18 },
}

export type PercussionBand = 'kick' | 'snare' | 'hihat'

/** One drum's live state. */
export interface PercussionHit {
  /** True for exactly one frame when a hit is detected. */
  trigger: boolean
  /** Decaying 1→0 envelope since the last hit — what scenes should read. */
  env: number
  /** 0..1 strength of the most recent hit. */
  strength: number
  /** Hits detected since reset (lets a scene vary per-hit, e.g. alternate). */
  count: number
}

export interface PercussionState {
  kick: PercussionHit
  snare: PercussionHit
  hihat: PercussionHit
}

export function createEmptyPercussion(): PercussionState {
  const hit = (): PercussionHit => ({ trigger: false, env: 0, strength: 0, count: 0 })
  return { kick: hit(), snare: hit(), hihat: hit() }
}

/** Rolling stats + refractory state for a single band. */
class BandDetector {
  private history: { t: number; v: number }[] = []
  private lastHit = -10

  constructor(private readonly cfg: BandConfig) {}

  reset() {
    this.history = []
    this.lastHit = -10
  }

  /** Advance one frame; mutates `out` in place (no per-frame allocation). */
  update(flux: number, now: number, delta: number, silence: boolean, out: PercussionHit) {
    out.trigger = false
    out.env = Math.max(0, out.env - out.env * Math.min(1, delta * this.cfg.decay))

    this.history.push({ t: now, v: flux })
    // The `- 1e-6` keeps this exactly 60 samples at a steady 60 fps (unchanged
    // from the old fixed count, robust to frame-clock float drift) while staying
    // a true ~1 s window at any other frame rate.
    while (this.history.length > 0 && now - this.history[0].t >= HISTORY_SEC - 1e-6)
      this.history.shift()
    // Need enough history for mean/σ to mean anything, and a silent passage
    // must not fire on noise-floor jitter.
    if (this.history.length < MIN_SAMPLES || silence) return

    let mean = 0
    for (const e of this.history) mean += e.v
    mean /= this.history.length
    let variance = 0
    for (const e of this.history) variance += (e.v - mean) * (e.v - mean)
    const std = Math.sqrt(variance / this.history.length)

    const threshold = mean + this.cfg.sigma * std + 1e-6
    if (flux > threshold && now - this.lastHit > this.cfg.minInterval) {
      this.lastHit = now
      out.trigger = true
      out.strength = Math.min(1, (flux - mean) / (std * 4 + 1e-6))
      out.env = Math.max(out.env, out.strength)
      out.count++
    }
  }
}

export class PercussionDetector {
  private readonly kick = new BandDetector(CONFIG.kick)
  private readonly snare = new BandDetector(CONFIG.snare)
  private readonly hihat = new BandDetector(CONFIG.hihat)

  reset() {
    this.kick.reset()
    this.snare.reset()
    this.hihat.reset()
  }

  /**
   * Advance all three bands one frame, writing into `state` in place.
   * Call after the spectral pass, before anything reads `features.percussion`.
   */
  update(
    state: PercussionState,
    flux: { kickFlux: number; snareFlux: number; hihatFlux: number },
    now: number,
    delta: number,
    silence: boolean,
  ) {
    this.kick.update(flux.kickFlux, now, delta, silence, state.kick)
    this.snare.update(flux.snareFlux, now, delta, silence, state.snare)
    this.hihat.update(flux.hihatFlux, now, delta, silence, state.hihat)
  }
}
