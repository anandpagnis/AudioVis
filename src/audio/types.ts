import { createEmptyPercussion, type PercussionState } from './PercussionDetector'

/**
 * Musical mood classes, ordered roughly calm → hype.
 *
 * The runtime array is the single source of truth and the type is derived from
 * it, so anything that needs to iterate every mood (registry coverage checks,
 * score tables, the analytics bar chart) cannot drift out of sync with the type.
 */
export const MOOD_STATES = [
  'silence',
  'ambient',
  'mellow',
  'groove',
  'building',
  'peak',
  'aggressive',
] as const

export type MoodState = (typeof MOOD_STATES)[number]

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

  /**
   * Estimated tonic ('C', 'F#', …) and mode, from Essentia's KeyExtractor in
   * the analysis worker. Empty string until the first read lands, and it holds
   * its last value between reads (re-evaluated on section boundaries, not per
   * frame). Nothing reads these yet — surfaced for the debug/analytics panels
   * so accuracy can be judged before they drive anything.
   */
  key: string
  scale: 'major' | 'minor' | ''
  /**
   * KeyExtractor's `strength` for the winning profile, 0..1.
   *
   * NOT a "is there a key at all" gate: measured 0.765 on pure white noise and
   * 0.662 on unpitched drums, against 0.94 for a clean triad progression. Treat
   * it as a relative margin between key candidates, not an absolute presence
   * score.
   */
  keyConfidence: number
  /**
   * RAW Essentia Danceability (DFA-based). Deliberately not renormalized.
   *
   * The algorithm documents "normally 0 to ~3", but measured values run higher
   * on real input (~7.8 for a four-on-the-floor beat with bass, ~0.6 for a
   * beatless pad) and go *wildly* out of range on degenerate input — white
   * noise and near-silence both read ≈97. The bridge skips analysis during
   * silence for that reason, but anything consuming this must clamp/guard
   * rather than assume the documented range.
   */
  danceability: number

  /**
   * Share of recent ~3 s segments in which a vocal was detected, 0..1, from
   * the MusiCNN voice/instrumental classifier in the voice worker.
   *
   * A FRACTION, not an average confidence. Vocals enter and leave, so "does
   * this have vocals" is a some-segment question: averaging p(voice) over a
   * track with a long instrumental intro reads as instrumental even when it
   * plainly is not (measured: averaging scored 5/8 on the labelled test set
   * where the fraction scores 7/8). Pooled over the last 16 patches (~48 s)
   * so the value has usable resolution rather than jumping in quarters.
   *
   * Stays 0 when the models are absent or the worker failed. Nothing reads
   * this yet — surfaced for the debug/analytics panels first.
   */
  vocalPresence: number
  /**
   * MusiCNN mood-head activations, 0..1 for the POSITIVE class of each.
   * Means over the window, unlike `vocalPresence` — mood is sustained
   * character rather than an intermittent event.
   *
   * Read-only diagnostics for now; deliberately NOT connected to
   * `mood.state`, which stays pure heuristic DSP.
   */
  moods: { happy: number; aggressive: number; party: number; relaxed: number }
  /**
   * True once the classifier has produced at least one real read.
   *
   * Without this, `moods.party === 0` is ambiguous in a way that matters: it
   * means "this is ambient" AND "the weights were never fetched" AND "we are
   * still in the first ~18s" AND "the worker died". Consumers that treat 0 as
   * evidence would silently mis-read three of those four as the fourth. Every
   * consumer must additionally stay ADDITIVE with a neutral zero, so an absent
   * signal costs nothing rather than suppressing what it was meant to boost.
   */
  moodsValid: boolean

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
    key: '',
    scale: '',
    keyConfidence: 0,
    danceability: 0,
    vocalPresence: 0,
    moods: { happy: 0, aggressive: 0, party: 0, relaxed: 0 },
    moodsValid: false,
    drop: false,
    buildUp: false,
    silence: true,
    mood: createEmptyMood(),
  }
}
