/**
 * ITU-R BS.1770-4 K-weighting — the perceptual loudness pre-filter, as a pure,
 * sample-rate-agnostic module (issue 12).
 *
 * Two biquads in series: a high-shelf "pre-filter" (head/torso diffraction
 * model, ~+4 dB above ~1.5 kHz) then the "RLB" high-pass (~38 Hz). BS.1770 only
 * tabulates the 48 kHz digital coefficients; the analog prototypes below (De Man
 * 2014, as shipped in `libebur128`) reproduce that table to ~1e-12 under a
 * pre-warped bilinear transform, and work at any sample rate.
 *
 * Loudness from the K-weighted signal `y`:
 *   L_K = -0.691 + 10·log10( mean(y²) over the measurement window )   [LUFS]
 * The -0.691 dB offset is exactly -(K-weighting gain at 997 Hz), applied once to
 * the window mean-square. Mono here (the engine's analysis path is a mono
 * mixdown) — no BS.1770 per-channel weighting.
 *
 * The AudioWorklet (`LOUDNESS_PROCESSOR` in AudioEngine.ts) inlines the same
 * coefficient formulas and biquad — a worklet Blob can't import. Keep them in
 * sync; `loudness.test.ts` pins this copy against the spec, and the offline
 * calibration harness imports this one directly.
 */

export interface Biquad {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
}

/** Stage 1: BS.1770 pre-filter (high-shelf). Recomputed for `sampleRate`. */
export function kWeightingStage1(sampleRate: number): Biquad {
  const f0 = 1681.9744509555319
  const G = 3.99984385397 // dB
  const Q = 0.7071752369554196

  const K = Math.tan((Math.PI * f0) / sampleRate)
  const Vh = Math.pow(10, G / 20)
  const Vb = Math.pow(Vh, 0.4996667741545416)
  const a0 = 1 + K / Q + K * K

  return {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  }
}

/** Stage 2: BS.1770 RLB high-pass. Numerator is exactly [1, -2, 1] at any rate. */
export function kWeightingStage2(sampleRate: number): Biquad {
  const f0 = 38.13547087602444
  const Q = 0.5003270373238773

  const K = Math.tan((Math.PI * f0) / sampleRate)
  const a0 = 1 + K / Q + K * K

  return {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  }
}

/** −(K-weighting power gain at 997 Hz), in dB — the BS.1770 L_K offset. */
export const LUFS_OFFSET = -0.691
/** Floor for a LUFS reading (digital silence → mean-square 0 → −∞). */
export const LUFS_SILENCE = -70

/**
 * Two-stage K-weighting filter over a continuous sample stream. Direct Form I,
 * with a denormal flush — the RLB pole sits at radius ≈ 0.995, so without the
 * flush the f64 state denormals after a few seconds of digital silence and the
 * filter runs 10–100× slower on x86 "forever" (no FTZ from JS).
 */
export class KWeighting {
  private readonly s1: Biquad
  private readonly s2: Biquad
  private x1a = 0
  private x2a = 0
  private y1a = 0
  private y2a = 0
  private x1b = 0
  private x2b = 0
  private y1b = 0
  private y2b = 0

  constructor(sampleRate: number) {
    this.s1 = kWeightingStage1(sampleRate)
    this.s2 = kWeightingStage2(sampleRate)
  }

  reset(): void {
    this.x1a = this.x2a = this.y1a = this.y2a = 0
    this.x1b = this.x2b = this.y1b = this.y2b = 0
  }

  /** One sample in, K-weighted sample out. A non-finite input resets the state
   * and returns 0 rather than poisoning the IIR forever. */
  process(x: number): number {
    if (!Number.isFinite(x)) {
      this.reset()
      return 0
    }
    const s1 = this.s1
    let ya =
      s1.b0 * x + s1.b1 * this.x1a + s1.b2 * this.x2a - s1.a1 * this.y1a - s1.a2 * this.y2a
    if (ya < 1e-15 && ya > -1e-15) ya = 0
    this.x2a = this.x1a
    this.x1a = x
    this.y2a = this.y1a
    this.y1a = ya

    const s2 = this.s2
    let yb =
      s2.b0 * ya + s2.b1 * this.x1b + s2.b2 * this.x2b - s2.a1 * this.y1b - s2.a2 * this.y2b
    if (yb < 1e-15 && yb > -1e-15) yb = 0
    this.x2b = this.x1b
    this.x1b = ya
    this.y2b = this.y1b
    this.y1b = yb

    return yb
  }
}

/** Mean-square of K-weighted samples → LUFS, floored at {@link LUFS_SILENCE}. */
export function meanSquareToLufs(meanSquare: number): number {
  if (!(meanSquare > 0)) return LUFS_SILENCE
  const l = LUFS_OFFSET + 10 * Math.log10(meanSquare)
  return l < LUFS_SILENCE ? LUFS_SILENCE : l
}

/**
 * Offline: sliding-window K-weighted loudness over a whole decoded signal.
 * Returns `{ momentary, shortTerm }` mean-squares (linear) at the END of the
 * given window position — i.e. call once per analysis frame with the sample
 * index of "now". For the calibration harness, which has the full contiguous
 * PCM; the app uses the streaming worklet instead.
 */
export class OfflineLoudness {
  private readonly filter: KWeighting
  private readonly momN: number
  private readonly shortN: number
  private readonly ring: Float64Array // squared K-weighted samples, newest-at-head
  private head = 0
  private filled = 0
  private shortSum = 0

  constructor(sampleRate: number, momentarySec = 0.4, shortTermSec = 3.0) {
    this.filter = new KWeighting(sampleRate)
    this.momN = Math.max(1, Math.round(sampleRate * momentarySec))
    this.shortN = Math.max(this.momN, Math.round(sampleRate * shortTermSec))
    this.ring = new Float64Array(this.shortN)
  }

  reset(): void {
    this.filter.reset()
    this.ring.fill(0)
    this.head = 0
    this.filled = 0
    this.shortSum = 0
  }

  /** Feed the next contiguous PCM block; state carries across calls. */
  push(pcm: Float32Array, from = 0, to = pcm.length): void {
    const ring = this.ring
    const n = ring.length
    for (let i = from; i < to; i++) {
      const w = this.filter.process(pcm[i])
      const sq = w * w
      if (this.filled >= n) this.shortSum -= ring[this.head] // evict oldest
      else this.filled++
      ring[this.head] = sq
      this.shortSum += sq
      this.head = (this.head + 1) % n
    }
  }

  /**
   * Current window mean-squares (linear). Short-term is an O(1) running mean;
   * momentary is summed on demand over the newest `momN` ring entries (called
   * once per analysis frame in the offline harness — cheap).
   */
  read(): { momentary: number; shortTerm: number } {
    const ring = this.ring
    const n = ring.length
    const m = Math.min(this.filled, this.momN)
    let momSum = 0
    for (let k = 1; k <= m; k++) momSum += ring[(this.head - k + n) % n]
    return {
      momentary: m > 0 ? momSum / m : 0,
      shortTerm: this.filled > 0 ? this.shortSum / this.filled : 0,
    }
  }
}
