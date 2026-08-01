import { createEmptyPercussion, type PercussionState } from './PercussionDetector'

/** Musical mood classes, ordered roughly calm → hype. */
export type MoodState =
  'silence' | 'ambient' | 'mellow' | 'groove' | 'building' | 'peak' | 'aggressive'

/**
 * The live mood read: where the song is, where it's heading, and how the
 * visuals should lean. Produced by MoodEstimator once per frame.
 */
export interface MoodMomentum {
  /** Committed (hysteresis-gated) mood state. */
  state: MoodState
  /** Where the momentum says we're heading (equals `state` when stable). */
  predictedState: MoodState
  /** 0..1 certainty in the committed state. */
  confidence: number
  /** Estimated beats until the predicted state arrives (-1 = unknown). */
  beatsTillTransition: number
  /** True for exactly one frame when the committed state changes. */
  changed: boolean
  /** Total committed state changes since start (used to vary generated art). */
  changeCount: number

  /** Trend velocities, roughly -1..1 per second. */
  energyVel: number
  bassVel: number
  brightVel: number

  /** Slow-smoothed overall intensity 0..1. */
  level: number
  /** Slow-smoothed spectral brightness 0..1. */
  brightness: number

  /** Per-state scores from the last evaluation (same scale as the internal
   * scoring, roughly 0..1.5) — the full distribution behind `confidence`'s
   * winner/runner-up margin. Useful for mood-ambiguity analytics. */
  scores: Record<MoodState, number>
  /** 0 = decisive winner, 1 = near-tie with the runner-up. */
  ambiguity: number

  /** Convenience flags. */
  isBuilding: boolean
  isPeaking: boolean
  isDecaying: boolean
  /** Energy falling while brightness rises — melting into a mellow section. */
  isMelting: boolean

  /** Smoothed visual multipliers derived from mood (applied over user params). */
  viz: { intensity: number; speed: number; reactivity: number }
}

/** Neutral mood state for engine construction and reset between sources. */
export function createEmptyMood(): MoodMomentum {
  return {
    state: 'silence',
    predictedState: 'silence',
    confidence: 0,
    beatsTillTransition: -1,
    changed: false,
    changeCount: 0,
    energyVel: 0,
    bassVel: 0,
    brightVel: 0,
    level: 0,
    brightness: 0,
    scores: {
      silence: 0,
      ambient: 0,
      mellow: 0,
      groove: 0,
      building: 0,
      peak: 0,
      aggressive: 0,
    },
    ambiguity: 1,
    isBuilding: false,
    isPeaking: false,
    isDecaying: false,
    isMelting: false,
    viz: { intensity: 1, speed: 1, reactivity: 1 },
  }
}

/**
 * The normalized audio state handed to scenes every frame.
 * Scenes never touch the Web Audio API — this is the whole contract.
 */
export interface AudioFeatures {
  /** Seconds since the engine started (AudioContext clock when running). */
  time: number
  /** Seconds since last frame. */
  delta: number

  /** Time-domain samples, -1..1. */
  waveform: Float32Array
  /** Normalized magnitude spectrum, 0..1 per bin. */
  spectrum: Float32Array
  /**
   * Time-domain samples from a band-pass around the lead/synth range
   * (~1.1 kHz, wide Q), -1..1.
   *
   * `waveform` above is the full mix and is dominated by kick and bass, so a
   * scene that traces it draws the drums. This one is dominated by sustained
   * tonal material, which is what makes a traced line read as the melody.
   * A filter, not source separation — percussive transients still leak in.
   */
  midWaveform: Float32Array

  /** Overall loudness 0..1 (adaptively normalized, smoothed). */
  rms: number
  /** Perceptual energy 0..1 — weighted blend of bands, smoothed. */
  energy: number
  /** Band energies 0..1, adaptively normalized, smoothed. */
  /** Sub-bass energy (20–80 Hz). */
  sub: number
  bass: number
  mid: number
  /** Upper-mid/presence energy (2–5 kHz). */
  presence: number
  high: number
  /** Vocal-band estimate (roughly 250 Hz–4 kHz). */
  vocal: number
  /** High-frequency "air" content above `high` (~9-16 kHz) — shimmer, cymbal
   * wash, breath. Adaptively normalized like the other bands. */
  air: number
  /** Spectral centroid 0..1 (dark → bright). */
  centroid: number
  /** Spectral flatness 0..1 — tonal/harmonic (low) vs. noisy/distorted (high)
   * texture, independent of loudness or brightness. */
  spectralFlatness: number
  /** Spectral rolloff 0..1 — normalized frequency below which 85% of energy
   * sits; a brightness cue robust to one dominant bin (unlike centroid). */
  spectralRolloff: number
  /** Peak/RMS ratio, typically 1..~15. Low = pushed/brickwalled masters, high
   * = dynamic/headroomy material. */
  crestFactor: number
  /** Onset flux 0..1 (spiky). */
  flux: number
  /** Fast transient envelope, useful for flashes and particles. */
  transient: number

  /**
   * Independently detected drum hits (kick / snare / hi-hat), each with a
   * one-frame trigger and a decaying envelope. Unlike `transient` — which is
   * one broadband envelope everything must share — these let separate visual
   * layers respond to separate parts of the kit.
   */
  percussion: PercussionState

  /** Current tempo estimate. */
  bpm: number
  /** True for exactly one frame when the beat grid crosses a beat. */
  beat: boolean
  /** Strength 0..1 of the current/most recent beat. */
  beatStrength: number
  /** 0..1 position inside the current beat. */
  beatProgress: number
  /** Beat index inside the current bar, 0..3. */
  beatInBar: number
  /** Running beat count since start. */
  beatIndex: number
  /** Bar count (4 beats). */
  bar: number
  /** Measure/phrase count (4 bars = 16 beats). */
  measure: number
  /** 0..1 confidence in the tempo/phase estimate. */
  confidence: number
  /** Predicted AudioContext time of the next beat. */
  nextBeatTime: number
  /** How tightly onsets are landing on the predicted beat grid, 0..1 — the
   * per-onset accuracy signal `confidence` is partly derived from, exposed on
   * its own for beat-tracking-accuracy analytics. */
  beatGridAccuracy: number

  /** Phrase count (16 beats, re-anchored at detected section changes). */
  phrase: number
  /** 0..1 position inside the current phrase. */
  phraseProgress: number
  /** True for one frame when a musical section boundary is detected. */
  sectionChange: boolean
  /** Continuous section-boundary strength backing `sectionChange` (which is
   * this value thresholded at 0.45). Holds its last value between
   * evaluations, similar to `phraseProgress`. */
  sectionChangeStrength: number

  /** Musical structure heuristics. */
  drop: boolean
  buildUp: boolean
  silence: boolean

  /** Live mood read — state, momentum, prediction. */
  mood: MoodMomentum
}

/**
 * Zeroed feature set. Note `bpm: 120` and `silence: true` rather than 0/false —
 * the beat grid free-runs at a sane default before any tempo is locked, so idle
 * motion is musical rather than frozen.
 */
export function createEmptyFeatures(): AudioFeatures {
  return {
    time: 0,
    delta: 1 / 60,
    waveform: new Float32Array(1024),
    spectrum: new Float32Array(512),
    midWaveform: new Float32Array(1024),
    rms: 0,
    energy: 0,
    sub: 0,
    bass: 0,
    mid: 0,
    presence: 0,
    high: 0,
    vocal: 0,
    air: 0,
    centroid: 0,
    spectralFlatness: 0,
    spectralRolloff: 0,
    crestFactor: 1,
    flux: 0,
    transient: 0,
    percussion: createEmptyPercussion(),
    bpm: 120,
    beat: false,
    beatStrength: 0,
    beatProgress: 0,
    beatInBar: 0,
    beatIndex: 0,
    bar: 0,
    measure: 0,
    confidence: 0,
    nextBeatTime: 0,
    beatGridAccuracy: 0,
    phrase: 0,
    phraseProgress: 0,
    sectionChange: false,
    sectionChangeStrength: 0,
    drop: false,
    buildUp: false,
    silence: true,
    mood: createEmptyMood(),
  }
}
