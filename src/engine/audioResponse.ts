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
  beatPulse: number
  dropPulse: number
  build: number
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
    beatPulse: clamp01(pulse),
    dropPulse: f.drop ? clamp01(0.55 + f.transient * 0.45) : 0,
    build: f.buildUp ? clamp01(0.35 + f.energy * 0.65) : 0,
  }
}
