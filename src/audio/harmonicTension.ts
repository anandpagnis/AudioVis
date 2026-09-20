/**
 * Harmonic tension from the spectrum: sensory roughness + dissonance +
 * tonalness, blended into one 0..1 `tension`.
 *
 * Clean-room, dependency-free. The roughness model is the classic
 * psychoacoustic one: every pair of spectral peaks beats against each other,
 * and the beating is strongest when their spacing is about a quarter of the
 * critical bandwidth (Plomp & Levelt 1965, "Tonal consonance and critical
 * bandwidth", JASA 38). We use Sethares' closed-form fit of that curve
 * (Sethares 1993, "Local consonance and the relationship between timbre and
 * scale", JASA 94):
 *
 *     d(f1, f2) = a1 · a2 · ( exp(−b1·s·Δf) − exp(−b2·s·Δf) )
 *     s = D* / (s1·fmin + s2),   b1 = 3.5, b2 = 5.75, D* = 0.24, s1 = 0.0207, s2 = 18.96
 *
 * summed over pairs of the strongest {@link TOP_PEAKS} peaks (≤ 190 pairs, so
 * cost is bounded regardless of how busy the spectrum is).
 *
 * Three cues, all 0..1, all smoothed over ~0.6 s:
 *   - `roughness`  — pairwise beating among the strongest peaks of ANY kind,
 *     normalised by the peaks' total energy (so it is loudness-invariant).
 *     Noise scores HIGH here: random peaks land at rough spacings.
 *   - `dissonance` — the same sum but weighted by each peak's tonal-ness
 *     (prominence gate). It asks "do the genuinely PITCHED partials clash?",
 *     so noise scores ~0 while a cluster of adjacent semitones scores high.
 *   - `tonalness`  — fraction of the analysed band's power that sits in
 *     prominent spectral peaks (a harmonic-peak-fraction, not a Wiener
 *     flatness: real music is always "peaky" against a −60 dB rolloff, which
 *     makes flatness saturate near 0). Noise → ~0, clean sustained tones → high.
 *
 * `tension = 0.45·dissonance + 0.30·roughness + 0.25·(1 − tonalness)`.
 * THE WEIGHTS ARE JUDGEMENT CALLS, not fitted to listener data: dissonance
 * leads because it is the actual harmonic-clash signal; roughness backs it up
 * (and picks up distorted/harsh timbres); low tonalness adds a smaller push for
 * noisy, unresolved texture. Tune them against real material.
 *
 * INPUT. One analyser frame, `length = fftSize / 2` bins over 0..Nyquist — feed
 * AudioEngine's 8192-point `lowFreqDb` (5.4 Hz/bin) if available. Beating
 * between partials closer than ~35 Hz falls inside one Blackman main lobe and
 * merges into a single peak, so roughness is UNDER-estimated for very tight
 * clusters at low pitch, and worse still on the 2048-point spectrum.
 *
 * HONEST LIMITS. Roughness of the *mix* is not chord dissonance: reverb tails,
 * distortion, detuned supersaws and inharmonic percussion all read rough without
 * being "tense" musically; conversely a tense chord voiced wide apart can read
 * calm. It says nothing about resolution or context (a dominant 7th is tense
 * because of where it sits, not only its roughness). Use it as one input.
 *
 * Zero allocations per frame; `read()` returns a REUSED object.
 */

import { SpectralPeakPicker, TONAL_GATE_HI_DB, TONAL_GATE_LO_DB, smoothRamp } from './chromaKey'

const MIN_HZ = 80
const MAX_HZ = 6000
/** Peaks kept for the pairwise sum: 20 → at most 190 pairs. */
const TOP_PEAKS = 20
/** A roughness peak must stand this far above its local log-mean (dB). */
const MIN_PROM_DB = 8
/** …and be within this many dB of the frame's strongest peak. */
const DYN_RANGE_DB = 45
/** Effective-noise-bandwidth of the Blackman window in bins (~1.73): converts a
 * peak-bin power into the total power its main lobe spreads over the bins. */
const BLACKMAN_ENBW = 1.73
/** Absolute floor for "there is a signal here" (dB, `getFloatFrequencyData` scale). */
const SIGNAL_FLOOR_DB = -85

// Sethares (1993) fit of the Plomp-Levelt curve.
const B1 = 3.5
const B2 = 5.75
const D_STAR = 0.24
const S1 = 0.0207
const S2 = 18.96
/** s·Δf beyond this the curve is < 1e-7: skip the pair. */
const MAX_SDF = 4.5

/** Raw normalised pair-sum at which the 0..1 mapping reaches 1 − 1/e ≈ 0.63.
 * Two equal peaks at the worst spacing give ≈ 0.09. Measured on synthetic
 * material (8192-pt FFT, 5 partials at 1/h): fifth ≈ 0.01, equal-tempered triad
 * ≈ 0.05, three adjacent semitones ≈ 0.16; on 8 real tracks 0.02-0.08. 0.15
 * keeps a cluster well below saturation and spreads real music over ~0.15-0.4
 * (0.08 crushed it into 0.26-0.59). Judgement call. */
const ROUGH_SCALE = 0.15

const W_DISSONANCE = 0.45
const W_ROUGHNESS = 0.3
const W_ATONAL = 0.25

const DEFAULT_INTERVAL_SEC = 0.04
const DEFAULT_SMOOTH_SEC = 0.6
/** Seconds of signal before `valid`; seconds of silence after which it lapses. */
const VALID_ACTIVE_SEC = 1
const VALID_SILENT_SEC = 1

export interface HarmonicTensionRead {
  /** 0..1 pairwise beating among the strongest peaks (noise reads high). */
  roughness: number
  /** 0..1 beating among the genuinely pitched peaks only (noise reads ~0). */
  dissonance: number
  /** 0..1 share of band power in prominent spectral peaks (noise ~0, pure tones high). */
  tonalness: number
  /** 0..1 blend: see the module header for the (judgement) weights. */
  tension: number
  /** False until ~1 s of real signal has been seen, and after ~1 s of silence. */
  valid: boolean
}

export interface HarmonicTensionOptions {
  /** Spectrum unit: 'db' = `getFloatFrequencyData` (default), 'linear' = magnitudes. */
  input?: 'db' | 'linear'
  /** Minimum spacing between processed frames (s). Default 0.04. */
  intervalSec?: number
  /** Output smoothing time constant (s). Default 0.6. */
  smoothSec?: number
}

export class HarmonicTensionEstimator {
  private readonly picker: SpectralPeakPicker
  private readonly linear: boolean
  private readonly interval: number
  private readonly smoothTau: number
  // Top-N selection scratch (indices into the picker's arrays, strongest first).
  private readonly topIdx = new Int32Array(TOP_PEAKS)
  private readonly topDb = new Float32Array(TOP_PEAKS)
  private readonly amp = new Float32Array(TOP_PEAKS)
  private readonly ampG = new Float32Array(TOP_PEAKS)
  private readonly freq = new Float32Array(TOP_PEAKS)
  private pending = 0
  private primed = false
  private activeSec = 0
  private silentSec = 0
  private seeded = false
  private readonly out: HarmonicTensionRead = {
    roughness: 0,
    dissonance: 0,
    tonalness: 0,
    tension: 0,
    valid: false,
  }

  constructor(opts: HarmonicTensionOptions = {}) {
    this.linear = opts.input === 'linear'
    this.picker = new SpectralPeakPicker(512, this.linear)
    this.interval = Math.max(0.005, opts.intervalSec ?? DEFAULT_INTERVAL_SEC)
    this.smoothTau = Math.max(0.05, opts.smoothSec ?? DEFAULT_SMOOTH_SEC)
  }

  reset() {
    this.pending = 0
    this.primed = false
    this.activeSec = 0
    this.silentSec = 0
    this.seeded = false
    const o = this.out
    o.roughness = 0
    o.dissonance = 0
    o.tonalness = 0
    o.tension = 0
    o.valid = false
  }

  /** Feed one analyser frame; `dt` = seconds since the previous call. Allocation-free. */
  update(spectrum: ArrayLike<number>, sampleRate: number, dt: number) {
    if (!(dt > 0)) return
    this.pending += Math.min(dt, 0.5)
    if (this.primed && this.pending < this.interval) return
    this.primed = true
    const h = this.pending
    this.pending = 0

    const picker = this.picker
    const nPeaks = picker.pick(spectrum, sampleRate, MIN_HZ, MAX_HZ)

    // --- Strongest TOP_PEAKS peaks above the prominence floor -------------
    let nTop = 0
    let maxDb = -Infinity
    const { topIdx, topDb } = this
    for (let i = 0; i < nPeaks; i++) {
      if (picker.prom[i] < MIN_PROM_DB) continue
      const d = picker.db[i]
      if (d > maxDb) maxDb = d
      // Insertion into a fixed-size, descending list.
      if (nTop === TOP_PEAKS && d <= topDb[nTop - 1]) continue
      let j = nTop < TOP_PEAKS ? nTop : TOP_PEAKS - 1
      while (j > 0 && topDb[j - 1] < d) {
        topDb[j] = topDb[j - 1]
        topIdx[j] = topIdx[j - 1]
        j--
      }
      topDb[j] = d
      topIdx[j] = i
      if (nTop < TOP_PEAKS) nTop++
    }

    if (nTop < 2 || maxDb < SIGNAL_FLOOR_DB + 10) {
      // Silence / nothing peaked enough to analyse: hold the last values (a
      // breakdown should not read as "no tension") and lapse `valid` only after
      // VALID_SILENT_SEC, so a one-frame dropout does not flap it.
      this.silentSec += h
      if (this.silentSec >= VALID_SILENT_SEC) {
        this.activeSec = 0
        this.out.valid = false
      }
      return
    }
    this.silentSec = 0
    this.activeSec += h

    // --- Roughness / dissonance over the top peaks -------------------------
    const { amp, ampG, freq } = this
    let e2 = 0
    let nUse = 0
    for (let t = 0; t < nTop; t++) {
      const i = topIdx[t]
      const d = picker.db[i]
      if (d < maxDb - DYN_RANGE_DB) break // sorted descending
      const a = Math.pow(10, (d - maxDb) / 20)
      amp[nUse] = a
      ampG[nUse] = a * smoothRamp(picker.prom[i], TONAL_GATE_LO_DB, TONAL_GATE_HI_DB)
      freq[nUse] = picker.freq[i]
      e2 += a * a
      nUse++
    }
    let rough = 0
    let diss = 0
    for (let i = 0; i < nUse; i++) {
      const fi = freq[i]
      for (let j = i + 1; j < nUse; j++) {
        const fj = freq[j]
        const fmin = fi < fj ? fi : fj
        const df = fi < fj ? fj - fi : fi - fj
        const s = D_STAR / (S1 * fmin + S2)
        const x = s * df
        if (x > MAX_SDF) continue
        const d = Math.exp(-B1 * x) - Math.exp(-B2 * x)
        rough += amp[i] * amp[j] * d
        diss += ampG[i] * ampG[j] * d
      }
    }
    const inv = e2 > 0 ? 1 / (e2 * ROUGH_SCALE) : 0
    const roughness = 1 - Math.exp(-rough * inv)
    const dissonance = 1 - Math.exp(-diss * inv)

    // --- Tonalness: power in prominent peaks ÷ total band power ------------
    const spec = spectrum
    const binHz = picker.binHz
    const kLo = Math.max(1, Math.ceil(MIN_HZ / binHz))
    const kHi = Math.min(spec.length - 1, Math.floor(MAX_HZ / binHz))
    let total = 0
    if (this.linear) {
      for (let k = kLo; k <= kHi; k++) total += spec[k] * spec[k]
    } else {
      for (let k = kLo; k <= kHi; k++) {
        const v = spec[k]
        if (v > -120) total += Math.exp(v * 0.23025850929940458) // 10^(v/10)
      }
    }
    let tonal = 0
    for (let i = 0; i < nPeaks; i++) {
      const g = smoothRamp(picker.prom[i], TONAL_GATE_LO_DB, TONAL_GATE_HI_DB)
      if (g > 0) tonal += g * Math.exp(picker.db[i] * 0.23025850929940458)
    }
    const tonalness = total > 1e-20 ? Math.min(1, (tonal * BLACKMAN_ENBW) / total) : 0

    // --- Smooth + blend -------------------------------------------------------
    const o = this.out
    const k = this.seeded ? 1 - Math.exp(-h / this.smoothTau) : 1
    this.seeded = true
    o.roughness += (roughness - o.roughness) * k
    o.dissonance += (dissonance - o.dissonance) * k
    o.tonalness += (tonalness - o.tonalness) * k
    o.tension = Math.min(
      1,
      Math.max(
        0,
        W_DISSONANCE * o.dissonance + W_ROUGHNESS * o.roughness + W_ATONAL * (1 - o.tonalness),
      ),
    )
    o.valid = this.activeSec >= VALID_ACTIVE_SEC
  }

  /** Current read. REUSED object — copy what you keep beyond the frame. */
  read(): HarmonicTensionRead {
    return this.out
  }
}
