/** Musical mood classes, ordered roughly calm → hype. */
export type MoodState =
  | 'silence'
  | 'ambient'
  | 'mellow'
  | 'groove'
  | 'building'
  | 'peak'
  | 'aggressive'

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

  /** Convenience flags. */
  isBuilding: boolean
  isPeaking: boolean
  isDecaying: boolean
  /** Energy falling while brightness rises — melting into a mellow section. */
  isMelting: boolean

  /** Smoothed visual multipliers derived from mood (applied over user params). */
  viz: { intensity: number; speed: number; reactivity: number }
}

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
  /** Spectral centroid 0..1 (dark → bright). */
  centroid: number
  /** Onset flux 0..1 (spiky). */
  flux: number
  /** Fast transient envelope, useful for flashes and particles. */
  transient: number

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

  /** Phrase count (16 beats, re-anchored at detected section changes). */
  phrase: number
  /** 0..1 position inside the current phrase. */
  phraseProgress: number
  /** True for one frame when a musical section boundary is detected. */
  sectionChange: boolean

  /** Musical structure heuristics. */
  drop: boolean
  buildUp: boolean
  silence: boolean

  /** Live mood read — state, momentum, prediction. */
  mood: MoodMomentum
}

export function createEmptyFeatures(): AudioFeatures {
  return {
    time: 0,
    delta: 1 / 60,
    waveform: new Float32Array(1024),
    spectrum: new Float32Array(512),
    rms: 0,
    energy: 0,
    sub: 0,
    bass: 0,
    mid: 0,
    presence: 0,
    high: 0,
    vocal: 0,
    centroid: 0,
    flux: 0,
    transient: 0,
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
    phrase: 0,
    phraseProgress: 0,
    sectionChange: false,
    drop: false,
    buildUp: false,
    silence: true,
    mood: createEmptyMood(),
  }
}
