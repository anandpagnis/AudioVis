import type { CharacterInput } from './characterTypes'
import { EMOTION_CALIBRATION, type EmotionCalibration } from './emotionQuantiles'

/**
 * Continuous valence / arousal / tension / pulse for the CHARACTER layer.
 *
 * WHY THIS REPLACES THE OLD ENERGY WINDOWS
 * The old engine compared a loudness-invariant `energy` (a running-peak
 * normalised band mix, squashed by gamma 2.8) against fixed thresholds. That
 * number describes "how loud is this moment relative to this track's own recent
 * peak", so a quiet ambient piece and a loud metal track both land mid-scale, and
 * fixed thresholds then pile most music into three middle states. Measured on
 * 400 human-rated clips (PMEmo) its arousal read correlated only 0.44 with the
 * listeners, while single timbre features such as spectral flatness reached 0.76.
 *
 * WHAT THIS DOES INSTEAD
 *  1. Every input feature is mapped to its PERCENTILE in a reference population
 *     (`emotionQuantiles.ts`, built from unlabelled audio features), so "bright"
 *     means "brighter than 90% of music", not "centroid > 0.68".
 *  2. Arousal, valence and tension are plain averages of a short list of features
 *     chosen from the music-emotion literature (see below), NOT weights fitted to
 *     any labelled dataset. Human-rated data is used only to CHECK the result
 *     (scripts/calibrate/emotion.calib.ts), on held-out clips.
 *  3. The averaged composite is smoothed slowly (character changes over seconds)
 *     and mapped through its own reference CDF, so the output spreads across
 *     0..1 instead of clustering at 0.5 (an average of several uniform variables
 *     is not uniform).
 *
 * FEATURE CHOICES (signs are the load-bearing part; magnitudes are judgement)
 *  Arousal:  loudness, spectral centroid (brightness), spectral flatness
 *            (noisy/distorted/percussive timbre), rolloff, spectral flux (rate of
 *            change), energy. Standard MER arousal correlates (Eerola 2013,
 *            Laurier 2008). Tempo is deliberately absent: the beat estimator is
 *            unreliable on short or free-time material and measured ~0 here.
 *  Valence:  brightness and mode (major vs minor, from the clean-room key
 *            estimator, only when that read is valid; otherwise brightness alone).
 *            Two deliberate omissions. Noisiness: distortion reads negative in
 *            metal and positive in pop, so its sign is genre-dependent.
 *            Roughness/consonance: measured on FULL MIXES it tracks noisiness and
 *            loudness, not chord quality, and on 200 human-rated tune-fold clips
 *            it pulled the composite BELOW brightness alone (0.30 vs 0.49), so it
 *            is kept for tension only. Valence is the least reliable axis in the
 *            literature (r about 0.65 for trained models);
 *            `valenceConfidence` tells the classifier so.
 *  Tension:  dissonance, non-tonalness, minor mode. Not validated against human
 *            ratings (none exist in PMEmo); treat as a plausible, unproven axis.
 *            Dissonance (not plain roughness) is the harmonic-clash term: both
 *            are the identical Sethares pairwise-beating sigmoid on the
 *            identical normalisation (`harmonicTension.ts`), but dissonance
 *            weights each pair by how PITCHED its partials are, so it stays
 *            near zero on noise/distortion/drum wash that plain roughness
 *            scores high — closer to what "tension" should mean musically.
 *  Pulse:    beat-lock confidence, mapped to its percentile like every other input.
 *            Raw confidence has a median of 0.19 and reaches 0.5 in only ~4% of
 *            frames, so a fixed "groove needs pulse 0.85" threshold was
 *            unreachable (the same failure the old energy windows had).
 */

/** The per-frame features this needs. `AudioFeatures` and the calibration harness's `FrameSample` both satisfy it. */
export interface EmotionFeatureFrame {
  loudness: number
  centroid: number
  spectralFlatness: number
  spectralRolloff: number
  flux: number
  energy: number
  keyValid: boolean
  keyModeStrength: number
  harmonicTensionValid: boolean
  harmonicRoughness: number
  harmonicDissonance: number
  harmonicTonalness: number
  confidence: number
  silence: boolean
}

/** Seconds of non-silent input before the read is reported as valid. */
export const EMOTION_WARMUP_SEC = 5
/** Time constants (s) for smoothing the composites: character moves over seconds, not frames. */
const TAU_AROUSAL = 6
const TAU_VALENCE = 10
const TAU_TENSION = 10
const TAU_PULSE = 6
const TAU_KEY = 8

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0)

/**
 * Piecewise-linear percentile lookup. `knots` are the feature values at equally
 * spaced probabilities 0, 1/(n-1), ... 1. Without knots it is the identity (used
 * while the tables themselves are being generated).
 */
export function quantileMap(value: number, knots: readonly number[] | undefined): number {
  if (!Number.isFinite(value)) return 0.5
  if (!knots || knots.length < 2) return clamp01(value)
  const n = knots.length
  if (value <= knots[0]) return 0
  if (value >= knots[n - 1]) return 1
  let lo = 0
  let hi = n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (knots[mid] <= value) lo = mid
    else hi = mid
  }
  const span = knots[hi] - knots[lo]
  const frac = span > 1e-12 ? (value - knots[lo]) / span : 0
  return (lo + frac) / (n - 1)
}

export interface EmotionRaw {
  arousal: number
  valence: number
  tension: number
}

export class EmotionDimensionEstimator {
  private readonly cal: EmotionCalibration
  private active = 0
  private aRaw = 0
  private vRaw = 0
  private tRaw = 0
  private pulse = 0
  private modeEma = 0.5
  private modeSeeded = false
  private keyWeight = 0
  private seeded = false
  private readonly out: CharacterInput = { valence: 0.5, arousal: 0.5, tension: 0.5, pulse: 0, valid: false, valenceConfidence: 0.4 }
  /** Smoothed composites BEFORE the final CDF mapping (used to build the composite tables). */
  readonly raw: EmotionRaw = { arousal: 0.5, valence: 0.5, tension: 0.5 }

  constructor(calibration: EmotionCalibration = EMOTION_CALIBRATION) {
    this.cal = calibration
  }

  reset() {
    this.active = 0
    this.aRaw = this.vRaw = this.tRaw = this.pulse = 0
    this.modeEma = 0.5
    this.modeSeeded = false
    this.keyWeight = 0
    this.seeded = false
    this.out.valid = false
    this.out.valenceConfidence = 0.4
  }

  private p(name: string, v: number): number {
    return quantileMap(v, this.cal.features[name])
  }

  update(f: EmotionFeatureFrame, dt: number): void {
    if (f.silence || !(dt > 0)) return // hold the last read through silence
    this.active += dt

    // --- instantaneous percentiles ---
    const arousalNow =
      (this.p('loudness', f.loudness) +
        this.p('centroid', f.centroid) +
        this.p('flatness', f.spectralFlatness) +
        this.p('rolloff', f.spectralRolloff) +
        this.p('flux', f.flux) +
        this.p('energy', f.energy)) /
      6

    const bright = this.p('centroid', f.centroid)
    // Dissonance reuses the 'roughness' percentile table: both are the same sigmoid on the same
    // normalisation in harmonicTension.ts (dissonance additionally gates each pair by how pitched it
    // is, so it is pointwise <= roughness for the same audio), so 'roughness' is the correct scale for
    // it. A dedicated 'dissonance' calibration table would need its own `npm run calibrate:quantiles`
    // pass — not done here.
    const dissonance = f.harmonicTensionValid ? this.p('roughness', f.harmonicDissonance) : 0.5
    const tonal = f.harmonicTensionValid ? this.p('tonalness', f.harmonicTonalness) : 0.5

    // Mode: smoothed only over frames where the key read is valid; 0.5 when unknown.
    const kAlpha = 1 - Math.exp(-dt / TAU_KEY)
    this.keyWeight += ((f.keyValid ? 1 : 0) - this.keyWeight) * kAlpha
    if (f.keyValid) {
      const target = clamp01(0.5 + 0.5 * f.keyModeStrength)
      if (this.modeSeeded) this.modeEma += (target - this.modeEma) * kAlpha
      else {
        this.modeEma = target
        this.modeSeeded = true
      }
    }
    const mode = this.modeSeeded && this.keyWeight > 0.3 ? this.modeEma : 0.5

    // Mode replaces brightness-as-a-stand-in only as far as the key read is trustworthy.
    const kw = clamp01(this.keyWeight)
    const modeBlend = this.modeSeeded ? this.modeEma * kw + bright * (1 - kw) : bright
    const valenceNow = 0.55 * bright + 0.45 * modeBlend
    const tensionNow = 0.4 * dissonance + 0.3 * (1 - tonal) + 0.3 * (1 - mode)
    const pulseNow = this.p('beat', f.confidence)

    // --- slow smoothing (seed on the first non-silent frame so warm-up is not a slow ramp from 0) ---
    if (!this.seeded) {
      this.aRaw = arousalNow
      this.vRaw = valenceNow
      this.tRaw = tensionNow
      this.pulse = pulseNow
      this.seeded = true
    } else {
      this.aRaw += (arousalNow - this.aRaw) * (1 - Math.exp(-dt / TAU_AROUSAL))
      this.vRaw += (valenceNow - this.vRaw) * (1 - Math.exp(-dt / TAU_VALENCE))
      this.tRaw += (tensionNow - this.tRaw) * (1 - Math.exp(-dt / TAU_TENSION))
      this.pulse += (pulseNow - this.pulse) * (1 - Math.exp(-dt / TAU_PULSE))
    }
    this.raw.arousal = this.aRaw
    this.raw.valence = this.vRaw
    this.raw.tension = this.tRaw

    this.out.arousal = quantileMap(this.aRaw, this.cal.composites.arousal)
    this.out.valence = quantileMap(this.vRaw, this.cal.composites.valence)
    this.out.tension = quantileMap(this.tRaw, this.cal.composites.tension)
    this.out.pulse = clamp01(this.pulse)
    this.out.valid = this.active >= EMOTION_WARMUP_SEC
    // Valence is the shakiest axis; it is trusted more once a key read is available.
    this.out.valenceConfidence = 0.4 + 0.6 * clamp01(this.keyWeight)
  }

  /** The current read. The same object is returned every call (no per-frame allocation). */
  read(): CharacterInput {
    return this.out
  }
}
