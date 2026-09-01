/**
 * Rational-ratio, Kaiser-windowed-sinc resampler for the Essentia workers
 * (DSP audit item 9).
 *
 * The old per-worker `resampleTo441` / `resample` helpers were 2-tap linear
 * interpolation. At the capture rate 48 kHz feeding a 44.1 kHz (rhythm/key),
 * 22.05 kHz (structure) or 16 kHz (MusiCNN mel) front-end, linear interpolation
 *
 *   - has no real stopband, so every component above the target Nyquist folds
 *     straight back down into the band the Essentia algorithm then analyses;
 *   - droops the top octave of the passband by several dB (its transfer
 *     function is sinc^2 of the output-rate ratio);
 *   - leaves imaging replicas from the implicit up-sampling almost unattenuated.
 *
 * This module replaces all of that with a single polyphase FIR whose prototype
 * is a Kaiser-windowed sinc. One low-pass does BOTH jobs: its cutoff sits below
 * `min(inRate, outRate) / 2`, which is below the input Nyquist (kills imaging)
 * and below the output Nyquist (kills aliasing).
 *
 * Design choices
 * --------------
 * - **Rational L/M.** `gcd`-reduce the rate pair. 48000->44100 = 147/160,
 *   48000->22050 = 147/320, 48000->16000 = 1/3, 44100->16000 = 160/441,
 *   44100->22050 = 1/2. For every real capture/target pair L <= 160.
 * - **Polyphase, O(taps/phase) per output.** The prototype lives on the
 *   `L*inRate` grid and is `(2*halfLen + 1) * L` long, but output sample `m`
 *   only touches the `2*halfLen + 1` prototype taps of phase `(m*M) mod L`,
 *   each multiplied by one real input sample (the `L-1` inserted zeros
 *   contribute nothing). Cost is `2*halfLen + 1` MACs/output, independent of L,
 *   never `taps*L`. The L-fold upsampled signal is never materialised.
 * - **Kaiser beta** from the requested stop-band attenuation (Oppenheim &
 *   Schafer). 80 dB -> beta ~= 7.857.
 * - **halfLen scales with the DECIMATION RATIO.** `halfLen` is the number of
 *   *input* samples touched each side of centre, so the physical FIR runs at
 *   `inRate` no matter how far down we are resampling. To hold a transition
 *   band of `(1 - rolloff) * min-Nyquist` Hz we therefore need
 *   `halfLen ~ C * inRate / transitionHz` — i.e. a 3:1 decimator (48k->16k)
 *   needs ~3x the taps of a 1.09:1 one (48k->44.1k). The Kaiser length
 *   estimate is evaluated against `inRate`, which yields halfLen ~= 35 for
 *   48->44.1, ~69 for 48->22.05, ~95 for 48->16. Clamped to [8, 128].
 *   (The earlier revision of this file evaluated it against `min-Nyquist` and
 *   got a fixed halfLen 32 for every ratio -> the two decimating workers only
 *   reached ~35 dB of stopband rejection, not 80. DSP audit follow-up F168.)
 * - **Per-phase DC normalisation.** Each polyphase sub-filter is scaled so its
 *   coefficients sum to exactly 1. A constant / DC input is then reproduced
 *   with no gain error and no possibility of overshoot-driven clipping.
 * - **Stateless.** Every call site resamples one already-complete window (a
 *   12 s or 120 s ring copy) in a single shot; consecutive jobs share no
 *   continuity. So this is a pure function. The only retained state is a
 *   module-level cache of the (small) coefficient tables, keyed by design.
 * - **Edges: zero-pad.** Out-of-range input reads count as 0. The first/last
 *   `halfLen` input samples (~0.7-6 ms depending on ratio) get a mild taper;
 *   negligible against a 12 s / 120 s analysis window, and unlike edge
 *   replication it cannot bias the level.
 * - **Group delay** is a constant `halfLen / inRate` seconds and is removed:
 *   output sample `m` is centred on input time `m * M / L` exactly. No caller
 *   does cross-stream sample alignment, but the estimators' own internal
 *   framing is unaffected either way.
 */

export interface ResampleOptions {
  /**
   * Pass-band edge as a fraction of the lower of the two Nyquist limits.
   * 0.84 keeps the response flat to ~0.84 * min-Nyquist and reaches full
   * stop-band by min-Nyquist. Lower = cheaper filter, more of the top octave
   * rolled off.
   */
  rolloff?: number
  /** Target stop-band attenuation in dB (positive). Drives the Kaiser beta. */
  stopbandDb?: number
  /**
   * Override taps-per-zero-crossing (each side). Normally derived from
   * `rolloff` + `stopbandDb` + the decimation ratio. A worker whose features
   * are coarse and section-scale can force this down to trade stop-band depth
   * for CPU on a long window; nothing here currently does.
   */
  halfLen?: number
}

const DEFAULT_ROLLOFF = 0.84
const DEFAULT_STOPBAND_DB = 80
const MIN_HALF_LEN = 8
/** 48k->16k at 80 dB / rolloff 0.84 resolves to ~95; 128 leaves headroom. */
const MAX_HALF_LEN = 128

/** gcd for the rate reduction. */
function gcd(a: number, b: number): number {
  while (b) {
    ;[a, b] = [b, a % b]
  }
  return a
}

/** sin(pi x) / (pi x), == 1 at x == 0. */
function sinc(x: number): number {
  if (x === 0) return 1
  const px = Math.PI * x
  return Math.sin(px) / px
}

/** Modified Bessel function of the first kind, order 0 — for the Kaiser window. */
function besselI0(x: number): number {
  let sum = 1
  let term = 1
  const y = (x * x) / 4
  for (let k = 1; k < 60; k++) {
    term *= y / (k * k)
    sum += term
    if (term < sum * 1e-13) break
  }
  return sum
}

/** Kaiser beta for a target stop-band attenuation (dB, positive). */
export function kaiserBeta(stopbandDb: number): number {
  const a = Math.abs(stopbandDb)
  if (a > 50) return 0.1102 * (a - 8.7)
  if (a >= 21) return 0.5842 * Math.pow(a - 21, 0.4) + 0.07886 * (a - 21)
  return 0
}

/**
 * Kaiser filter-order estimate for transition width `df` Hz at working rate
 * `fs` Hz and attenuation `a` dB. Returns the number of taps (order + 1).
 */
function kaiserTaps(a: number, df: number, fs: number): number {
  const dOmega = (2 * Math.PI * df) / fs
  return Math.ceil((Math.abs(a) - 8) / (2.285 * dOmega)) + 1
}

interface PolyphaseDesign {
  L: number
  M: number
  halfLen: number
  /**
   * Prototype, length `(2*halfLen + 1) * L`, fully populated. Phase `p`'s
   * sub-filter is `h[p], h[p + L], ... h[p + 2*halfLen*L]` — exactly
   * `2*halfLen + 1` taps, for every `p` in `[0, L)`.
   */
  h: Float32Array
}

const cache = new Map<string, PolyphaseDesign>()

function design(
  fromRate: number,
  toRate: number,
  rolloff: number,
  stopbandDb: number,
  halfLenOverride: number | undefined,
): PolyphaseDesign {
  const inR = Math.round(fromRate)
  const outR = Math.round(toRate)
  const g = gcd(inR, outR)
  const L = outR / g
  const M = inR / g

  // The low-pass protects both Nyquist limits at once (anti-image AND
  // anti-alias). Band plan:
  //   passband edge  fp = rolloff * min-Nyquist   (flat below here)
  //   stopband edge  fs = min-Nyquist             (nothing above here aliases
  //                                                through / images in)
  //   sinc cutoff    fc = midpoint of the transition (that is how the Kaiser
  //                                                length formula defines it)
  const lowerRate = Math.min(inR, outR)
  const minNyq = lowerRate / 2
  const fp = rolloff * minNyq
  const fs = minNyq
  const fc = 0.5 * (fp + fs)

  let halfLen = halfLenOverride
  if (halfLen == null) {
    const df = fs - fp // transition band width, Hz (a fixed fraction of minNyq)
    // Evaluate the Kaiser length against the INPUT rate: the polyphase inner
    // loop convolves `2*halfLen (+1)` consecutive input samples, so the FIR's
    // physical sample rate is `inR`, and the tap count has to grow with the
    // decimation ratio to keep `df` Hz of transition.
    const taps = kaiserTaps(stopbandDb, df, inR)
    halfLen = Math.ceil(taps / 2)
  }
  halfLen = Math.max(MIN_HALF_LEN, Math.min(MAX_HALF_LEN, halfLen))

  const key = `${inR}>${outR}|${rolloff}|${stopbandDb}|${halfLen}`
  const hit = cache.get(key)
  if (hit) return hit

  const beta = kaiserBeta(stopbandDb)
  const i0beta = besselI0(beta)
  const taps = 2 * halfLen // + 1; the +1 tap is index 2*halfLen*L + phase
  const protoLen = (2 * halfLen + 1) * L
  const h = new Float32Array(protoLen)

  // proto[k] = g((k / L) - halfLen), the anti-alias low-pass sampled on the
  // 1/L input-sample grid, centred at k = halfLen*L. g(tau) is a windowed sinc
  // in INPUT-sample units: cutoff fcn = fc / inR cycles per input sample.
  const fcn = fc / inR
  const center = halfLen * L
  for (let k = 0; k < protoLen; k++) {
    const tau = (k - center) / L // input-sample units, -halfLen .. +halfLen
    const s = 2 * fcn * sinc(2 * fcn * tau)
    const r = tau / halfLen // -1 .. 1
    const w = besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / i0beta
    h[k] = s * w
  }

  // Per-phase DC normalisation: each of the L sub-filters sums to 1.
  for (let p = 0; p < L; p++) {
    let sum = 0
    for (let j = 0; j <= taps; j++) sum += h[p + j * L]
    if (sum !== 0) {
      const inv = 1 / sum
      for (let j = 0; j <= taps; j++) h[p + j * L] *= inv
    }
  }

  const d: PolyphaseDesign = { L, M, halfLen, h }
  cache.set(key, d)
  return d
}

/**
 * Resample mono `pcm` from `fromRate` to `toRate`.
 *
 * Pure and stateless. Returns a fresh `Float32Array` of length
 * `ceil(pcm.length * toRate / fromRate)` — or `pcm` itself, untouched, when the
 * rates are equal.
 */
export function resample(
  pcm: Float32Array,
  fromRate: number,
  toRate: number,
  opts: ResampleOptions = {},
): Float32Array {
  if (Math.round(fromRate) === Math.round(toRate)) return pcm
  if (pcm.length === 0) return new Float32Array(0)

  const rolloff = opts.rolloff ?? DEFAULT_ROLLOFF
  const stopbandDb = opts.stopbandDb ?? DEFAULT_STOPBAND_DB
  const { L, M, halfLen, h } = design(fromRate, toRate, rolloff, stopbandDb, opts.halfLen)

  const inLen = pcm.length
  const outLen = Math.ceil((inLen * L) / M)
  const out = new Float32Array(outLen)
  const taps = 2 * halfLen // loop runs j = 0 .. taps inclusive -> 2*halfLen+1 taps

  for (let m = 0; m < outLen; m++) {
    const tM = m * M
    const phase = tM % L
    const centerIdx = (tM - phase) / L // == floor(m*M/L), the input sample time
    const firstIn = centerIdx - halfLen
    const lastIn = centerIdx + halfLen
    let acc = 0

    if (firstIn >= 0 && lastIn < inLen) {
      // Interior: no bounds checks in the hot path.
      let pIdx = phase
      let inIdx = lastIn
      for (let j = 0; j <= taps; j++) {
        acc += pcm[inIdx] * h[pIdx]
        pIdx += L
        inIdx--
      }
    } else {
      // Edge: zero-pad out-of-range reads.
      let pIdx = phase
      let inIdx = lastIn
      for (let j = 0; j <= taps; j++) {
        if (inIdx >= 0 && inIdx < inLen) acc += pcm[inIdx] * h[pIdx]
        pIdx += L
        inIdx--
      }
    }
    out[m] = acc
  }
  return out
}

/** Introspection for tests / logging — the design that `resample` would use. */
export function resampleDesign(
  fromRate: number,
  toRate: number,
  opts: ResampleOptions = {},
): { L: number; M: number; halfLen: number; tapsPerOutput: number; beta: number } {
  const rolloff = opts.rolloff ?? DEFAULT_ROLLOFF
  const stopbandDb = opts.stopbandDb ?? DEFAULT_STOPBAND_DB
  const d = design(fromRate, toRate, rolloff, stopbandDb, opts.halfLen)
  return {
    L: d.L,
    M: d.M,
    halfLen: d.halfLen,
    tapsPerOutput: 2 * d.halfLen + 1,
    beta: kaiserBeta(stopbandDb),
  }
}
