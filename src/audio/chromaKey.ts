/**
 * Clean-room musical key / mode estimator: spectrum → chroma → key-profile match.
 *
 * Replaces the key read that used to come only from Essentia's KeyExtractor
 * (AGPL-3.0) so the analysis can ship without it. Written from the published
 * method, not from any library's source:
 *
 *   1. Peak-pick the FFT magnitude spectrum (log domain, parabolic
 *      interpolation) and keep only peaks that stand out from their local
 *      surroundings — noise and drum wash have no such peaks, so they cannot
 *      smear the chroma the way a plain "fold every bin" approach does.
 *   2. Fold each surviving peak onto the 12 pitch classes with a soft
 *      (raised-cosine) assignment, after subtracting a slowly estimated global
 *      tuning offset, so a detuned recording still lands on the right classes.
 *   3. Accumulate over a long window (default 10 s time constant), bias-
 *      corrected so the first seconds after `reset()` are a plain average.
 *   4. Correlate against the 24 rotated key profiles. Three published sets are
 *      averaged: Krumhansl & Kessler (1982, "Tracing the dynamic changes in
 *      perceived tonal organization in a spatial representation of musical
 *      keys", Psychological Review 89), Temperley (2001, "The Cognition of
 *      Basic Musical Structures", MIT Press) and Albrecht & Shanahan (2013,
 *      "The use of large corpora to train a new type of key-finding algorithm",
 *      Music Perception 31). Correlation is Pearson's r, the Krumhansl-Schmuckler
 *      key-finding formulation.
 *   5. Relative major/minor pairs share a pitch set, so the correlation margin
 *      alone cannot separate C major from A minor. Two small additive terms
 *      break those ties: how strong the candidate tonic is in the chroma, and
 *      how much of the BASS register (65-260 Hz) sits on it.
 *
 * INPUT. `update()` takes one analyser frame with `length = fftSize / 2` bins
 * spanning 0..Nyquist. Feed it AudioEngine's `lowFreqDb` (fftSize 8192, ~5.4
 * Hz/bin, `getFloatFrequencyData` dB) — NOT the 2048-point `freqDb`: at 21.5
 * Hz/bin a semitone is narrower than one bin below ~250 Hz, so chords cannot be
 * resolved and the key read degrades badly. Pass `{ input: 'linear' }` to feed
 * linear magnitudes instead (`f.spectrum`); dB is the native, cheaper path.
 *
 * HONEST LIMITS. Static-profile key finding assumes a tonal, mostly diatonic
 * centre that persists for several seconds. It will be unreliable on: heavily
 * percussive or noise-based tracks (little tonal energy survives the gates),
 * key changes (the 10 s window lags by design), modal/atonal/chromatic music,
 * sub-bass-only content (below the 65 Hz floor), and low-bitrate material whose
 * high partials are smeared. Relative major/minor remains the commonest wrong
 * answer even with the tie-breakers. `keyConfidence` reports the score margin,
 * not a probability.
 *
 * Zero allocations per frame: every buffer is created once (lazily sized to the
 * first spectrum) and `read()` returns a REUSED object.
 */

export const PITCH_CLASS_NAMES = [
  'C',
  'C#',
  'D',
  'D#',
  'E',
  'F',
  'F#',
  'G',
  'G#',
  'A',
  'A#',
  'B',
] as const

/** Chroma analysis band. Below 65 Hz (C2) a bin is wider than a semitone-and-a-half. */
const MIN_HZ = 65
const MAX_HZ = 5000
/** Upper edge of the "bass" register used for the tonic tie-breaker. */
const BASS_MAX_HZ = 260

/** Bins below this level are treated as silence (dB, `getFloatFrequencyData` scale). */
const ABS_FLOOR_DB = -85
/** Clamp for -Infinity / NaN bins, so sums and parabolic fits stay finite. */
const DB_CLAMP = -140
/** Half-width (bins) of the window whose mean dB is a peak's "local floor". */
const PROM_HALF_WIDTH = 10
/**
 * Tonal-gate ramp on peak prominence (dB above the local log-mean): weight 0
 * below LO, 1 at HI. Shared with HarmonicTensionEstimator so both agree on what
 * counts as "pitched". Measured on white noise, the strongest 20 peaks per frame
 * sit at 4-14 dB (none above), so LO = 10 keeps noise almost fully out, while
 * dense real mixes (vocals + drums at 100 kbps) put their tonal peaks at 10-25.
 */
export const TONAL_GATE_LO_DB = 10
export const TONAL_GATE_HI_DB = 20

// --- Peak picker -----------------------------------------------------------

/**
 * Local-maximum finder with sub-bin frequency, peak level and prominence.
 * Shared by {@link ChromaKeyEstimator} and `HarmonicTensionEstimator` so both
 * see the same notion of "a real spectral peak". Output arrays are reused.
 */
export class SpectralPeakPicker {
  /** Interpolated peak frequency (Hz). */
  readonly freq: Float32Array
  /** Interpolated peak level (dB). */
  readonly db: Float32Array
  /** dB above the mean dB of the surrounding ±{@link PROM_HALF_WIDTH} bins. */
  readonly prom: Float32Array
  /** Number of valid entries after the last {@link pick}. */
  count = 0
  private cum = new Float64Array(0)
  private lin = new Float32Array(0)

  constructor(
    readonly maxPeaks = 512,
    private readonly linearInput = false,
  ) {
    this.freq = new Float32Array(maxPeaks)
    this.db = new Float32Array(maxPeaks)
    this.prom = new Float32Array(maxPeaks)
  }

  /** Bin spacing (Hz) of the last analysed spectrum. */
  binHz = 0

  pick(spec: ArrayLike<number>, sampleRate: number, loHz: number, hiHz: number): number {
    this.count = 0
    const n = spec.length
    if (n < 32 || !(sampleRate > 0)) return 0
    const binHz = sampleRate / (2 * n)
    this.binHz = binHz
    const kLo = Math.max(2, Math.ceil(loHz / binHz))
    const kHi = Math.min(n - 2, Math.floor(hiHz / binHz))
    if (kHi <= kLo) return 0
    const a0 = Math.max(0, kLo - PROM_HALF_WIDTH - 1)
    const b0 = Math.min(n - 1, kHi + PROM_HALF_WIDTH + 1)

    if (this.cum.length < n + 1) {
      this.cum = new Float64Array(n + 1)
      if (this.linearInput) this.lin = new Float32Array(n)
    }
    let s: ArrayLike<number> = spec
    if (this.linearInput) {
      const lin = this.lin
      for (let i = a0; i <= b0; i++) {
        const v = spec[i]
        lin[i] = v > 1e-7 ? 20 * Math.log10(v) : DB_CLAMP
      }
      s = lin
    }

    // Prefix sums of clamped dB → O(1) local log-mean per candidate.
    const cum = this.cum
    cum[a0] = 0
    for (let i = a0; i <= b0; i++) {
      const v = s[i]
      cum[i + 1] = cum[i] + (v > DB_CLAMP ? v : DB_CLAMP)
    }

    const { freq, db, prom, maxPeaks } = this
    let cnt = 0
    for (let k = kLo; k <= kHi && cnt < maxPeaks; k++) {
      const b = s[k]
      if (!(b > ABS_FLOOR_DB)) continue
      const a = s[k - 1] > DB_CLAMP ? s[k - 1] : DB_CLAMP
      const c = s[k + 1] > DB_CLAMP ? s[k + 1] : DB_CLAMP
      if (!(b > a && b >= c)) continue
      // Parabolic interpolation of the log magnitude (Smith, "Spectral Audio
      // Signal Processing"): exact for a Gaussian, close for a windowed sinusoid.
      const denom = a - 2 * b + c
      const p = denom < -1e-6 ? (0.5 * (a - c)) / denom : 0
      const lo = Math.max(a0, k - PROM_HALF_WIDTH)
      const hi = Math.min(b0, k + PROM_HALF_WIDTH)
      const localMean = (cum[hi + 1] - cum[lo]) / (hi - lo + 1)
      const height = b - 0.25 * (a - c) * p
      freq[cnt] = (k + p) * binHz
      db[cnt] = height
      prom[cnt] = height - localMean
      cnt++
    }
    this.count = cnt
    return cnt
  }
}

/** 0..1 smoothstep ramp of `x` between `lo` and `hi`. */
export function smoothRamp(x: number, lo: number, hi: number): number {
  const t = (x - lo) / (hi - lo)
  if (t <= 0) return 0
  if (t >= 1) return 1
  return t * t * (3 - 2 * t)
}

// --- Key profiles ----------------------------------------------------------

// Index 0 is the tonic, then ascending semitones. Only the SHAPE matters: each
// is zero-meaned and unit-normalised below, so Pearson r is a plain dot product.
const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
const TEMPERLEY_MAJOR = [5.0, 2.0, 3.5, 2.0, 4.5, 4.0, 2.0, 4.5, 2.0, 3.5, 1.5, 4.0]
const TEMPERLEY_MINOR = [5.0, 2.0, 3.5, 4.5, 2.0, 4.0, 2.0, 4.5, 3.5, 2.0, 1.5, 4.0]
const ALBRECHT_MAJOR = [
  0.238, 0.006, 0.111, 0.006, 0.137, 0.094, 0.016, 0.214, 0.009, 0.08, 0.008, 0.081,
]
const ALBRECHT_MINOR = [
  0.22, 0.006, 0.104, 0.123, 0.019, 0.103, 0.012, 0.214, 0.062, 0.022, 0.061, 0.052,
]

function normalizeProfile(p: number[]): Float64Array {
  let mean = 0
  for (const v of p) mean += v
  mean /= p.length
  let norm = 0
  for (const v of p) norm += (v - mean) * (v - mean)
  norm = Math.sqrt(norm)
  const out = new Float64Array(p.length)
  for (let i = 0; i < p.length; i++) out[i] = (p[i] - mean) / norm
  return out
}

/** [profile set][mode 0=major 1=minor] → normalised 12-vector. */
const PROFILES: Float64Array[][] = [
  [normalizeProfile(KK_MAJOR), normalizeProfile(KK_MINOR)],
  [normalizeProfile(TEMPERLEY_MAJOR), normalizeProfile(TEMPERLEY_MINOR)],
  [normalizeProfile(ALBRECHT_MAJOR), normalizeProfile(ALBRECHT_MINOR)],
]

// --- Tunables (judgement calls, not fitted to a corpus) ---------------------

/** Chroma accumulation time constant, seconds. */
const DEFAULT_TAU_SEC = 10
/** Minimum spacing between processed frames, seconds (a 8192 window overlaps
 * ~75 % at 20 Hz; running at 60 Hz would just re-read the same audio). */
const DEFAULT_INTERVAL_SEC = 0.04
/** Tonal-seconds needed before `valid`. */
const VALID_TONAL_SEC = 6
/** …and the tonal fraction of the recent window must stay above this. */
const VALID_TONAL_FRACTION = 0.25
/** Time constant of the tuning-offset estimate, seconds. */
const TUNING_TAU_SEC = 30
/** Raised-cosine half-width (semitones) of the pitch-class assignment kernel.
 * < 1 so a peak halfway between two classes is down-weighted, not doubled. */
const ASSIGN_WIDTH = 0.75
/** Amplitude compression on peak weights: weight ∝ magnitude^0.5. */
const AMP_EXPONENT = 0.5
/** Tie-breaker weights (added to a candidate key's mean correlation). */
const TONIC_STRENGTH_W = 0.04
const BASS_TONIC_W = 0.06
/** A challenger must beat the current key by this much to displace it. */
const SWITCH_MARGIN = 0.02
/** Correlation gap (major − minor at the winning tonic) mapped to ±1. */
const MODE_SCALE = 0.35
/** Score margin (best − second) that maps to full confidence. */
const CONF_MARGIN = 0.1
/** Best mean correlation below/above which absolute fit contributes 0/1 confidence. */
const CONF_FIT_LO = 0.3
const CONF_FIT_HI = 0.7

const LN10 = Math.LN10

export interface ChromaKeyRead {
  /** 'C', 'C#', … 'B' (sharps). Empty until `valid`. */
  tonic: string
  /** 'major' | 'minor', or '' until `valid`. */
  scale: 'major' | 'minor' | ''
  /**
   * −1 (clearly minor) … +1 (clearly major), 0 = ambiguous. The correlation gap
   * between the major and minor profile AT THE WINNING TONIC — i.e. parallel
   * major vs minor, the contrast that actually moves listeners' valence — not
   * the best-major-vs-best-minor gap, which relative keys make tiny.
   */
  modeStrength: number
  /** 0..1 — margin between the best and second-best key, damped by absolute fit. */
  keyConfidence: number
  /** Accumulated chroma, index 0 = C … 11 = B, scaled so the maximum is 1. */
  chroma: Float32Array
  /** True once ≥ ~6 s of tonal material has accumulated and it is still present. */
  valid: boolean
}

export interface ChromaKeyOptions {
  /** Spectrum unit: 'db' = `getFloatFrequencyData` (default), 'linear' = magnitudes. */
  input?: 'db' | 'linear'
  /** Accumulation time constant (s). Default 10. */
  tauSec?: number
  /** Minimum spacing between processed frames (s). Default 0.04. */
  intervalSec?: number
}

export class ChromaKeyEstimator {
  private readonly picker: SpectralPeakPicker
  private readonly tau: number
  private readonly interval: number

  // Decayed accumulators (see `update`). `acc` is chroma mass, `bassAcc` the
  // bass-register subset. `wTime`/`tonalTime` are decayed second-sums used for
  // bias correction and the tonal-fraction gate.
  private readonly acc = new Float64Array(12)
  private readonly bassAcc = new Float64Array(12)
  private readonly frame = new Float64Array(12)
  private readonly frameBass = new Float64Array(12)
  private wTime = 0
  private tonalTime = 0
  private tonalTotal = 0
  private tuneCos = 0
  private tuneSin = 0
  private tuneW = 0
  private pending = 0
  private primed = false

  // Key state (held between evaluations, with hysteresis).
  private readonly scoreMaj = new Float64Array(12)
  private readonly scoreMin = new Float64Array(12)
  private readonly cz = new Float64Array(12)
  private dirty = false
  private curTonic = -1
  private curMode = -1
  private curScore = 0
  private cachedValid = false
  private readonly out: ChromaKeyRead = {
    tonic: '',
    scale: '',
    modeStrength: 0,
    keyConfidence: 0,
    chroma: new Float32Array(12),
    valid: false,
  }

  constructor(opts: ChromaKeyOptions = {}) {
    this.picker = new SpectralPeakPicker(512, opts.input === 'linear')
    this.tau = Math.max(1, opts.tauSec ?? DEFAULT_TAU_SEC)
    this.interval = Math.max(0.005, opts.intervalSec ?? DEFAULT_INTERVAL_SEC)
  }

  /** Forget everything (new track, source change). */
  reset() {
    this.acc.fill(0)
    this.bassAcc.fill(0)
    this.wTime = 0
    this.tonalTime = 0
    this.tonalTotal = 0
    this.tuneCos = 0
    this.tuneSin = 0
    this.tuneW = 0
    this.pending = 0
    this.primed = false
    this.curTonic = -1
    this.curMode = -1
    this.curScore = 0
    this.dirty = false
    this.cachedValid = false
    this.out.tonic = ''
    this.out.scale = ''
    this.out.modeStrength = 0
    this.out.keyConfidence = 0
    this.out.valid = false
    this.out.chroma.fill(0)
  }

  /**
   * Partial forget for a section boundary: keeps `keep` (0..1) of the history so
   * a key change is picked up in a couple of seconds instead of ~10, while a
   * false boundary costs little. `keep = 0` is a full `reset()` of the window
   * (the tuning estimate is kept — tuning does not change mid-track).
   */
  soften(keep = 0.3) {
    const k = Math.min(1, Math.max(0, keep))
    for (let i = 0; i < 12; i++) {
      this.acc[i] *= k
      this.bassAcc[i] *= k
    }
    this.wTime *= k
    this.tonalTime *= k
    this.tonalTotal *= k
    this.dirty = true
  }

  /**
   * Feed one analyser frame. `dt` is seconds since the previous call; frames
   * closer together than `intervalSec` are coalesced (the newest spectrum wins)
   * so calling at render rate costs ~one analysis per 40 ms. Allocation-free.
   */
  update(spectrum: ArrayLike<number>, sampleRate: number, dt: number) {
    if (!(dt > 0)) return
    this.pending += Math.min(dt, 0.5)
    if (this.primed && this.pending < this.interval) return
    this.primed = true
    const h = this.pending
    this.pending = 0

    const picker = this.picker
    const nPeaks = picker.pick(spectrum, sampleRate, MIN_HZ, MAX_HZ)

    const tune = this.tuningSemitones()

    const frame = this.frame
    const frameBass = this.frameBass
    frame.fill(0)
    frameBass.fill(0)
    let gSum = 0
    let wSum = 0
    let bassSum = 0
    let tc = 0
    let ts = 0
    let tw = 0
    const ampK = (AMP_EXPONENT * LN10) / 20
    for (let i = 0; i < nPeaks; i++) {
      const g = smoothRamp(picker.prom[i], TONAL_GATE_LO_DB, TONAL_GATE_HI_DB)
      if (g <= 0) continue
      const f = picker.freq[i]
      gSum += g
      // Compressed magnitude, and a soft roll-off of the upper partials, which
      // mostly re-state the fundamental's overtone series (3rd, 5th, 7th…) and
      // add pitch-class energy that is not chord content.
      const amp = Math.exp(ampK * picker.db[i])
      const w = g * amp
      const s = 12 * Math.log2(f / 440) + 9 // semitones above C, unwrapped
      const ang = 2 * Math.PI * s
      tc += w * Math.cos(ang)
      ts += w * Math.sin(ang)
      tw += w
      const fw = f <= 1800 ? 1 : 1 - 0.85 * smoothRamp(f, 1800, MAX_HZ)
      const q = s - tune
      const lower = Math.floor(q)
      const frac = q - lower
      const c0 = ((lower % 12) + 12) % 12
      const c1 = c0 === 11 ? 0 : c0 + 1
      const k0 = frac < ASSIGN_WIDTH ? Math.cos((Math.PI * frac) / (2 * ASSIGN_WIDTH)) ** 2 : 0
      const d1 = 1 - frac
      const k1 = d1 < ASSIGN_WIDTH ? Math.cos((Math.PI * d1) / (2 * ASSIGN_WIDTH)) ** 2 : 0
      frame[c0] += w * fw * k0
      frame[c1] += w * fw * k1
      wSum += w * fw * (k0 + k1)
      if (f <= BASS_MAX_HZ) {
        frameBass[c0] += w * k0
        frameBass[c1] += w * k1
        bassSum += w * (k0 + k1)
      }
    }

    // Frame weight: ≥ ~4 solid tonal peaks counts fully, ≤ 1 not at all. This is
    // what makes silence and noise contribute nothing and gate `valid`.
    const fw = wSum > 0 ? Math.min(1, Math.max(0, (gSum - 1) / 3)) : 0

    const decay = Math.exp(-h / this.tau)
    const acc = this.acc
    const bassAcc = this.bassAcc
    const inv = fw > 0 ? 1 / wSum : 0
    const invB = fw > 0 && bassSum > 0 ? 1 / bassSum : 0
    for (let i = 0; i < 12; i++) {
      // Each frame is normalised to unit mass before weighting, so a loud
      // passage does not outvote a quiet one — only tonal-ness does.
      acc[i] = acc[i] * decay + h * fw * frame[i] * inv
      bassAcc[i] = bassAcc[i] * decay + h * fw * frameBass[i] * invB
    }
    this.wTime = this.wTime * decay + h
    this.tonalTime = this.tonalTime * decay + h * fw
    this.tonalTotal += h * fw
    // Tuning accumulators decay slower and are only fed by tonal frames.
    const td = Math.exp(-h / TUNING_TAU_SEC)
    if (fw > 0 && tw > 0) {
      this.tuneCos = this.tuneCos * td + (h * fw * tc) / tw
      this.tuneSin = this.tuneSin * td + (h * fw * ts) / tw
      this.tuneW = this.tuneW * td + h * fw
    } else {
      this.tuneCos *= td
      this.tuneSin *= td
      this.tuneW *= td
    }
    this.dirty = true
  }

  /**
   * Tuning offset (semitones) from the circular mean of the peaks' fractional
   * semitone position — the standard estimate: peaks cluster at a constant
   * offset from equal temperament. Trusted only when the cluster is tight.
   */
  private tuningSemitones(): number {
    if (this.tuneW > 1e-6) {
      const res = Math.hypot(this.tuneCos, this.tuneSin) / this.tuneW
      if (res > 0.2) return Math.atan2(this.tuneSin, this.tuneCos) / (2 * Math.PI)
    }
    return 0
  }

  /** Estimated global tuning offset from A440 equal temperament, cents. Diagnostic. */
  get tuningCents(): number {
    return this.tuningSemitones() * 100
  }

  /** Fraction (0..1) of the recent window that carried tonal peaks. Diagnostic. */
  get tonalFraction(): number {
    return this.wTime > 1e-9 ? this.tonalTime / this.wTime : 0
  }

  /** Total seconds of tonal material seen since `reset()` (what `valid` waits on). */
  get tonalSeconds(): number {
    return this.tonalTotal
  }

  /**
   * Current estimate. The returned object (and its `chroma`) is REUSED — copy
   * what you keep beyond the frame. Cheap: the 24-key match (~1k multiply-adds)
   * only re-runs when new audio has been analysed since the last call.
   */
  read(): ChromaKeyRead {
    if (this.dirty) {
      this.evaluate()
      this.dirty = false
    }
    return this.out
  }

  private evaluate() {
    const out = this.out
    const acc = this.acc
    let sum = 0
    let max = 0
    for (let i = 0; i < 12; i++) {
      sum += acc[i]
      if (acc[i] > max) max = acc[i]
    }
    const tonalFraction = this.wTime > 1e-9 ? this.tonalTime / this.wTime : 0
    const valid =
      sum > 1e-9 && this.tonalTotal >= VALID_TONAL_SEC && tonalFraction >= VALID_TONAL_FRACTION
    out.valid = valid
    if (sum <= 1e-9) {
      out.chroma.fill(0)
      out.tonic = ''
      out.scale = ''
      out.modeStrength = 0
      out.keyConfidence = 0
      this.curTonic = -1
      this.curMode = -1
      return
    }
    for (let i = 0; i < 12; i++) out.chroma[i] = acc[i] / max
    if (!valid) {
      out.tonic = ''
      out.scale = ''
      out.modeStrength = 0
      out.keyConfidence = 0
      this.curTonic = -1
      this.curMode = -1
      return
    }

    // Zero-mean / unit-norm chroma → Pearson r is a dot product.
    const cz = this.cz
    let norm = 0
    for (let i = 0; i < 12; i++) {
      cz[i] = acc[i] / sum - 1 / 12
      norm += cz[i] * cz[i]
    }
    norm = Math.sqrt(norm)
    if (norm < 1e-9) {
      // Perfectly flat chroma: no key information at all.
      out.tonic = ''
      out.scale = ''
      out.modeStrength = 0
      out.keyConfidence = 0
      this.curTonic = -1
      this.curMode = -1
      out.valid = false
      return
    }
    for (let i = 0; i < 12; i++) cz[i] /= norm

    // Bass register emphasis per pitch class.
    let bassMax = 0
    for (let i = 0; i < 12; i++) if (this.bassAcc[i] > bassMax) bassMax = this.bassAcc[i]

    const scoreMaj = this.scoreMaj
    const scoreMin = this.scoreMin
    const nSets = PROFILES.length
    for (let t = 0; t < 12; t++) {
      let rMaj = 0
      let rMin = 0
      for (let s = 0; s < nSets; s++) {
        const pMaj = PROFILES[s][0]
        const pMin = PROFILES[s][1]
        for (let i = 0; i < 12; i++) {
          const x = cz[t + i >= 12 ? t + i - 12 : t + i]
          rMaj += x * pMaj[i]
          rMin += x * pMin[i]
        }
      }
      scoreMaj[t] = rMaj / nSets
      scoreMin[t] = rMin / nSets
    }

    // Winner + runner-up over all 24 keys, with the relative-key tie-breakers.
    let best = -Infinity
    let second = -Infinity
    let bestT = 0
    let bestM = 0
    let curTotal = -Infinity
    for (let t = 0; t < 12; t++) {
      const tonicStrength = max > 0 ? acc[t] / max : 0
      const bassEmph = bassMax > 0 ? this.bassAcc[t] / bassMax : 0
      const bonus = TONIC_STRENGTH_W * tonicStrength + BASS_TONIC_W * bassEmph
      for (let m = 0; m < 2; m++) {
        const total = (m === 0 ? scoreMaj[t] : scoreMin[t]) + bonus
        if (t === this.curTonic && m === this.curMode) curTotal = total
        if (total > best) {
          second = best
          best = total
          bestT = t
          bestM = m
        } else if (total > second) {
          second = total
        }
      }
    }
    // Hysteresis: hold the previous key unless a challenger clearly beats it.
    let t = bestT
    let m = bestM
    if (this.curTonic >= 0 && (t !== this.curTonic || m !== this.curMode)) {
      if (best - curTotal < SWITCH_MARGIN) {
        t = this.curTonic
        m = this.curMode
      }
    }
    this.curTonic = t
    this.curMode = m
    this.curScore = best

    const margin = best - second
    const fit = Math.min(1, Math.max(0, (best - CONF_FIT_LO) / (CONF_FIT_HI - CONF_FIT_LO)))
    out.keyConfidence = Math.min(1, Math.max(0, margin / CONF_MARGIN)) * fit
    out.tonic = PITCH_CLASS_NAMES[t]
    out.scale = m === 0 ? 'major' : 'minor'
    out.modeStrength = Math.min(1, Math.max(-1, (scoreMaj[t] - scoreMin[t]) / MODE_SCALE))
  }
}
