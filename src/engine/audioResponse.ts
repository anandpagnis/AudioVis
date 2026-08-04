import { beatPulse } from '../audio/AudioEngine'
import type { AudioFeatures } from '../audio/types'

/** Stable, named controls scenes can use without re-deriving audio math. */
export interface AudioResponse {
  sub: number
  bass: number
  mid: number
  presence: number
  high: number
  vocal: number
  /** High-frequency "air" content above `high` — shimmer, cymbal wash, breath. */
  air: number
  energy: number
  transient: number
  /** 0..1 — tonal/harmonic (low) vs. noisy/distorted (high) texture. */
  flatness: number
  /** 0..1 — brightness cue robust to one dominant bin, complementary to centroid. */
  rolloff: number
  /** 0..1 — dynamic headroom; low means pushed/brickwalled, high means dynamic. */
  dynamics: number

  /**
   * Sustained TONAL content in the vocal range — the vocal band gated by
   * tonality (`1 - spectralFlatness`).
   *
   * Prefer this over the raw `vocal` band for anything meant to track a lead
   * line. `vocal` is a plain 250 Hz–5 kHz energy sum, so it lights up on hats,
   * snare body, and distortion just as readily as on a voice; multiplying by
   * tonality suppresses the noisy half of that range and leaves what is
   * actually pitched. A held note reads high, a busy percussive bar reads low.
   *
   * Still an estimate, not source separation — a real vocal stem needs a model
   * (see docs/02_Music_Intelligence.md). Good enough to drive a visual layer;
   * not good enough to claim "this is the singer".
   */
  voice: number
  beatPulse: number
  dropPulse: number
  build: number

  /**
   * Independent drum envelopes. Prefer these over `transient` when a visual
   * should belong to ONE part of the kit — `transient` fires on everything, so
   * routing three layers through it makes them move in lockstep.
   */
  kick: number
  snare: number
  hihat: number
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))

/**
 * Maps the normalized analyzer contract into expressive visual envelopes.
 * Keeping this here makes custom scenes portable: they can use the same
 * response vocabulary as built-in scenes without knowing analyzer details.
 */
export function getAudioResponse(f: AudioFeatures, sharpness = 3): AudioResponse {
  // Subdivision-aware pulse (audioEngine.tuning), confidence-weighted.
  const pulse = beatPulse(f, sharpness)
  return {
    sub: f.sub,
    bass: f.bass,
    mid: f.mid,
    presence: f.presence,
    high: f.high,
    vocal: f.vocal,
    air: f.air,
    energy: f.energy,
    transient: f.transient,
    flatness: clamp01(f.spectralFlatness),
    rolloff: clamp01(f.spectralRolloff),
    dynamics: clamp01((f.crestFactor - 1) / 9),
    voice: clamp01(f.vocal * (1 - clamp01(f.spectralFlatness))),
    beatPulse: clamp01(pulse),
    dropPulse: f.drop ? clamp01(0.55 + f.transient * 0.45) : 0,
    build: f.buildUp ? clamp01(0.35 + f.energy * 0.65) : 0,
    kick: clamp01(f.percussion.kick.env),
    snare: clamp01(f.percussion.snare.env),
    hihat: clamp01(f.percussion.hihat.env),
  }
}
