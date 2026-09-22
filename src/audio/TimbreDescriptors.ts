import { quantileMap, type EmotionFeatureFrame } from './emotionDimensions'
import { TIMBRE_CALIBRATION, type TimbreCalibration } from './timbreQuantiles'

/**
 * Three slow "texture" descriptors: HOW harsh, busy and sparse the sound is, independent of the mood label
 * (which says what the music feels like). They exist so the look system can scale how much of a mood's
 * effects show (a tense track can still be sparse or dense, a euphoric one rough or smooth). DSP-only, so
 * they run in every build (no `moods.*` model heads).
 *
 *   harsh  0..1  rough, noisy spectrum: mean( sensory roughness, 1 - tonalness ).
 *   busy   0..1  dense, unresolved texture: mean( onset flux, harmonic ambiguity = 1 - |key mode strength| ).
 *   sparse 0..1  space, emptiness: (1 - busy) * (1 - loudness), so quiet AND steady.
 *
 * Every input is mapped to its PERCENTILE in the reference pool (`timbreQuantiles.ts`, the same idea as
 * `emotionDimensions.ts`), averaged, smoothed with a ~4 s time constant, and the smoothed composite is mapped
 * through its own reference CDF so the output spreads over 0..1 instead of clustering at 0.5. An input that is
 * not available (no key read yet, harmonic estimator not warmed up) counts as its neutral 0.5. Silence holds
 * the last read.
 *
 * WHY THESE INPUTS AND NOT SPECTRAL FLATNESS / ROLLOFF (the first design)
 * The plan's first formula was harsh = mean(flatness, roughness, rolloff, flux) and busy = mean(flux, key
 * ambiguity, rolloff). Across 867 corpus clips flatness, rolloff and centroid are one brightness cluster
 * (mutual Spearman rho 0.89-0.95) and flux joins loudness and energy in a level cluster (0.6-0.75), and the
 * arousal composite already averages both clusters. Measured with `npm run eval:descriptors`:
 *   plan formula     harsh vs character arousal rho +0.90, busy +0.70 (limit 0.70)  -> redundant with arousal
 *   adjustment 1     harsh = .5 rough + .25 flat + .25 rolloff, busy = mean(flux, key ambiguity): +0.67 / +0.27,
 *                    but harsh then failed the Gemini gate (AUC 0.62 vs 0.65)
 *   adjustment 2     harsh = mean(rough, 1 - tonalness), busy unchanged: +0.46 / +0.27, all gates pass
 * so brightness was dropped from both (it is the arousal and valence axes' job) and flux belongs to `busy`.
 * The report (corpus/emotion/descriptors-report.md) carries the full numbers.
 *
 * HONEST LIMITS. The gates check spread, independence from arousal and a sign check against LLM pre-labels
 * on 98 tracks; they do not prove that a listener would call the result harsh or busy.
 *  - `harsh` uses the same two inputs as the character `tension` estimator, so it is highly correlated with
 *    it (rho about 0.85). It is independent of arousal, not of tension.
 *  - The Gemini pass for `harsh` rests on the 21 "driving" tracks; the strict split without them (n = 6
 *    aggressive/tense/brooding tracks) shows no signal, and the formula was adjusted twice with that gate
 *    in view, so the pass is optimistic.
 *  - `busy` is weakly tied to anything human-rated (rho about 0.2 with arousal, 0.06 with valence).
 *  - Clip-level spread is marginal for `busy` and `sparse` (IQR 0.31 and 0.30 on the pooled corpus; the
 *    per-frame IQR the look system sees is 0.41-0.45).
 * Treat them as bounded modulators (about +-40% of an effect), never as a selector of which effect family runs.
 */

/** The per-frame features this needs. `AudioFeatures` and the calibration harness's `FrameSample` both satisfy it. */
export type TimbreFeatureFrame = Pick<
  EmotionFeatureFrame,
  | 'loudness'
  | 'flux'
  | 'keyValid'
  | 'keyModeStrength'
  | 'harmonicTensionValid'
  | 'harmonicRoughness'
  | 'harmonicTonalness'
  | 'silence'
>

export interface TimbreRead {
  harsh: number
  busy: number
  sparse: number
}

/** Time constant (s) of the smoothing: texture is a property of a passage, not of a frame. */
export const TIMBRE_TAU_SEC = 4

export class TimbreDescriptors {
  private readonly cal: TimbreCalibration
  private seeded = false
  private hRaw = 0.5
  private bRaw = 0.5
  private lRaw = 0.5
  private readonly out: TimbreRead = { harsh: 0.5, busy: 0.5, sparse: 0.5 }
  /** Smoothed composites BEFORE the final CDF mapping (used to build the composite tables). */
  readonly raw: TimbreRead = { harsh: 0.5, busy: 0.5, sparse: 0.5 }

  constructor(calibration: TimbreCalibration = TIMBRE_CALIBRATION) {
    this.cal = calibration
  }

  reset() {
    this.seeded = false
    this.hRaw = this.bRaw = this.lRaw = 0.5
    this.out.harsh = this.out.busy = this.out.sparse = 0.5
    this.raw.harsh = this.raw.busy = this.raw.sparse = 0.5
  }

  private p(name: string, v: number): number {
    return quantileMap(v, this.cal.features[name])
  }

  update(f: TimbreFeatureFrame, dt: number): void {
    if (f.silence || !(dt > 0)) return // hold the last read through silence

    // --- instantaneous percentiles (non-finite input reads as 0.5, see quantileMap) ---
    const flux = this.p('flux', f.flux)
    const loud = this.p('loudness', f.loudness)
    const rough = f.harmonicTensionValid ? this.p('roughness', f.harmonicRoughness) : 0.5
    const tonal = f.harmonicTensionValid ? this.p('tonalness', f.harmonicTonalness) : 0.5
    const ambiguity = f.keyValid ? this.p('modeAmbiguity', 1 - Math.abs(f.keyModeStrength)) : 0.5

    const harshNow = (rough + (1 - tonal)) / 2
    const busyNow = (flux + ambiguity) / 2

    // --- slow smoothing (seed on the first non-silent frame so warm-up is not a slow ramp) ---
    if (!this.seeded) {
      this.hRaw = harshNow
      this.bRaw = busyNow
      this.lRaw = loud
      this.seeded = true
    } else {
      const a = 1 - Math.exp(-dt / TIMBRE_TAU_SEC)
      this.hRaw += (harshNow - this.hRaw) * a
      this.bRaw += (busyNow - this.bRaw) * a
      this.lRaw += (loud - this.lRaw) * a
    }

    // Sparse is built from the MAPPED busy and the smoothed loudness percentile (already slow), then mapped.
    const busy = quantileMap(this.bRaw, this.cal.composites.busy)
    const sparseRaw = (1 - busy) * (1 - this.lRaw)
    this.raw.harsh = this.hRaw
    this.raw.busy = this.bRaw
    this.raw.sparse = sparseRaw
    this.out.harsh = quantileMap(this.hRaw, this.cal.composites.harsh)
    this.out.busy = busy
    this.out.sparse = quantileMap(sparseRaw, this.cal.composites.sparse)
  }

  /** The current read. The same object is returned every call (no per-frame allocation). */
  read(): TimbreRead {
    return this.out
  }
}
