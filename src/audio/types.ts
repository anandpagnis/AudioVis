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
 * Song-structure sections — a LATCHED read of where in the track we are, from
 * the off-thread structure analyzer, as opposed to the one-frame
 * `AudioFeatures.sectionChange` event.
 *
 * Deliberately NOT verse/chorus. Without a trained model, guessing "this
 * recurring loud segment is the chorus" is a rule cascade that breaks on
 * anything without pop structure. What IS acoustically robust — and what the
 * directors actually need — is: are we in a build-up (hold the look), did a
 * drop just land (fire the switch), are we in a breakdown (no heavy visuals),
 * did *some* boundary happen (recompose). `'section'` is "a boundary was
 * detected, function unknown"; `intro`/`outro` are position-based.
 * `SongSectionMomentum.repetitionLabel` separately carries "this is the same
 * material as an earlier segment" (A/B/C…) without claiming to name it.
 */
export const SECTION_STATES = [
  'intro',
  'build',
  'drop',
  'breakdown',
  'section',
  'outro',
] as const

/** `''` is the bootstrap sentinel; the field holds its last value between
 * async structure reads, like `key`. */
export type SongSection = (typeof SECTION_STATES)[number] | ''

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
 * The live song-structure read — where we are, where a boundary/drop is
 * heading, and whether we've returned to earlier material. Produced by
 * `SectionTracker` once per frame from the off-thread structure analyzer's
 * latest result plus the synchronous drop/build flags.
 */
export interface SongSectionMomentum {
  /** Committed (hysteresis-gated) section. */
  section: SongSection
  /** The section before the last committed boundary. */
  previousSection: SongSection
  /** 0..1 certainty in the committed section. */
  sectionConfidence: number
  /** Beats elapsed since the last committed boundary. */
  beatsInSection: number
  /** Estimated beats until the next boundary (-1 = unknown). */
  beatsTillBoundary: number
  /** True for exactly one frame when a committed boundary lands. */
  boundaryChanged: boolean
  /** Total committed boundaries since start. */
  changeCount: number

  /** 0..1 progress through the current build-up (0 when not building). */
  buildProgress: number
  /** A drop is coming — hold the current look. */
  dropExpected: boolean
  /** Estimated beats until the drop (-1 = unknown / not building). */
  beatsTillDrop: number

  /** Convenience flags. */
  isBuild: boolean
  /** True for a short latched window right after a drop lands. */
  isDrop: boolean
  isBreakdown: boolean
  /** `isBuild || dropExpected` — "hold discretionary transitions". */
  isSustain: boolean

  /**
   * A/B/C… identifying repeated material (this segment's feature profile
   * matches an earlier one), or `''`. Directors can recall an earlier
   * palette/scene on a return without the read claiming "chorus".
   */
  repetitionLabel: string
}

/** Neutral structure state for engine construction and reset between sources. */
export function createEmptySongSection(): SongSectionMomentum {
  return {
    section: '',
    previousSection: '',
    sectionConfidence: 0,
    beatsInSection: 0,
    beatsTillBoundary: -1,
    boundaryChanged: false,
    changeCount: 0,
    buildProgress: 0,
    dropExpected: false,
    beatsTillDrop: -1,
    isBuild: false,
    isDrop: false,
    isBreakdown: false,
    isSustain: false,
    repetitionLabel: '',
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
  /**
   * Linear magnitude spectrum, clamped to 0..1 per bin. `FFT_SIZE / 2` = 1024
   * bins spanning 0..Nyquist (~21.5 Hz/bin, ~0–22 kHz at 44.1 kHz). The empty
   * upper bins sit at the FFT noise floor (~1e-5), not zero. The clamp matters
   * on hot masters — an un-clamped bin reaches ~1.6 linear there (a real
   * `AnalyserNode` does not clamp `getFloatFrequencyData` to `maxDecibels`).
   */
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
  /**
   * "Sparkle" — mean magnitude from 16 kHz to Nyquist, above where `air` stops.
   * Non-overlapping with `air` by construction. Distinguishes an air-heavy
   * master from a dull or lossy-encoded one (most lossy codecs brick-wall
   * around 15–19 kHz). Adaptively normalized like the other bands.
   *
   * Surfaced on the contract but NOT yet consumed anywhere. It reads as a
   * natural harshness/shimmer cue for `MoodEstimator`, but the calibration
   * corpus (96 kbps) has nothing up here, so a wired weight would be untunable
   * — wiring waits for a lossless A/B. Same "computed and exposed first"
   * pattern as `air` / `key` / `vocalPresence` before them.
   */
  sparkle: number
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
  /**
   * Perceived loudness 0..1 — ITU-R BS.1770 K-weighted RMS over ~400 ms,
   * adaptively normalized like the bands (so it is loudness-INVARIANT). Unlike
   * `energy` (a hand-weighted band blend, bass-dominated) this uses the
   * standards frequency shaping: sub-bass de-weighted, 1–4 kHz — where the ear
   * judges loudness — boosted. Computed off a dedicated K-weighting worklet.
   */
  loudness: number
  /**
   * Raw short-term loudness in LUFS (ITU-R BS.1770, 3 s window), roughly
   * −60..0. This is an ABSOLUTE scale: it rises when the operator turns the
   * input gain up, unlike every other field here. Diagnostic / reference only
   * — a "is the input level sane" readout and a substrate for a gain-invariant
   * dynamic-range measure (a *difference* of two LUFS values is invariant).
   * NEVER feed it into `mood.state` scoring or `energy` — that would break the
   * loudness-invariance guarantee. Mono-path, so ~3 dB below a true stereo
   * short-term meter. Floors at −70 (silence / no worklet).
   */
  lufsShortTerm: number
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
   * Latched, predictive song-structure read from the off-thread analyzer +
   * `SectionTracker`. Unlike `sectionChange` (a one-frame event), this says
   * where in the song we ARE and whether a boundary/drop is imminent.
   *
   * Holds its last value between async reads. Read `structureValid` first:
   * when false, consumers fall back to `sectionChange` / today's behaviour.
   */
  songSection: SongSectionMomentum
  /**
   * True once the structure analyzer has produced at least one real segmentation.
   *
   * Four-way ambiguous exactly like `moodsValid`: `songSection.section === ''`
   * also means "worker not built yet" AND "still in the first ~30 s of history"
   * AND "worker died". Every consumer must gate on this AND stay additive with a
   * neutral fallback — an absent structure read costs nothing.
   */
  structureValid: boolean

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
    spectrum: new Float32Array(1024), // FFT_SIZE / 2 — full FFT output, 0..Nyquist
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
    sparkle: 0,
    centroid: 0,
    spectralFlatness: 0,
    spectralRolloff: 0,
    crestFactor: 1,
    loudness: 0,
    lufsShortTerm: -70,
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
    songSection: createEmptySongSection(),
    structureValid: false,
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
