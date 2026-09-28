/**
 * Radix-2 real FFT for the whole-song analyser (`analyzeSong.ts`). Clean-room, pure TypeScript, no DOM: it must run
 * in Node (calibration, tests) and later in a worker. `src` cannot import from `scripts/`, so this is its own copy.
 *
 * A real transform of size N is done as ONE complex transform of size N/2 (pack even samples as the real part and
 * odd samples as the imaginary part, then split the two interleaved spectra with the standard twiddle step). One
 * `RealFft` owns its tables and scratch buffers, so create one per size and reuse it (not re-entrant).
 */

export class RealFft {
  readonly n: number
  private readonly m: number
  private readonly rev: Uint32Array
  private readonly cosT: Float64Array
  private readonly sinT: Float64Array
  private readonly wr: Float64Array
  private readonly wi: Float64Array
  private readonly re: Float64Array
  private readonly im: Float64Array

  constructor(n: number) {
    if (n < 4 || (n & (n - 1)) !== 0) throw new Error(`RealFft: size must be a power of two >= 4, got ${n}`)
    this.n = n
    const m = n >> 1
    this.m = m
    this.rev = new Uint32Array(m)
    let bits = 0
    while (1 << bits < m) bits++
    for (let i = 0; i < m; i++) {
      let r = 0
      for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b)
      this.rev[i] = r
    }
    // twiddles of the size-m complex transform: e^{-2 pi i k / m}, k < m/2
    this.cosT = new Float64Array(Math.max(1, m >> 1))
    this.sinT = new Float64Array(Math.max(1, m >> 1))
    for (let k = 0; k < m >> 1; k++) {
      this.cosT[k] = Math.cos((2 * Math.PI * k) / m)
      this.sinT[k] = -Math.sin((2 * Math.PI * k) / m)
    }
    // split twiddles e^{-2 pi i k / n}, k <= m
    this.wr = new Float64Array(m + 1)
    this.wi = new Float64Array(m + 1)
    for (let k = 0; k <= m; k++) {
      this.wr[k] = Math.cos((2 * Math.PI * k) / n)
      this.wi[k] = -Math.sin((2 * Math.PI * k) / n)
    }
    this.re = new Float64Array(m)
    this.im = new Float64Array(m)
  }

  /** Forward transform of `x` (first `n` samples, real) into the packed complex buffer. */
  private run(x: ArrayLike<number>): void {
    const { m, rev, re, im, cosT, sinT } = this
    for (let i = 0; i < m; i++) {
      const j = rev[i]
      re[j] = x[2 * i]
      im[j] = x[2 * i + 1]
    }
    for (let len = 2; len <= m; len <<= 1) {
      const half = len >> 1
      const step = m / len
      for (let i = 0; i < m; i += len) {
        for (let k = 0, t = 0; k < half; k++, t += step) {
          const a = i + k
          const b = a + half
          const c = cosT[t]
          const s = sinT[t]
          const xr = re[b] * c - im[b] * s
          const xi = re[b] * s + im[b] * c
          re[b] = re[a] - xr
          im[b] = im[a] - xi
          re[a] += xr
          im[a] += xi
        }
      }
    }
  }

  /** Squared magnitude `|X_k|^2` for bins `0..n/2` (length `n/2 + 1`) of the real signal `x` (`x.length >= n`). */
  power(x: ArrayLike<number>, out: Float64Array | Float32Array): void {
    this.run(x)
    const { m, re, im, wr, wi } = this
    for (let k = 0; k <= m; k++) {
      const k1 = k === m ? 0 : k
      const k2 = k === 0 ? 0 : m - k
      const ar = re[k1]
      const ai = im[k1]
      const br = re[k2]
      const bi = -im[k2]
      const er = 0.5 * (ar + br)
      const ei = 0.5 * (ai + bi)
      const dr = 0.5 * (ar - br)
      const di = 0.5 * (ai - bi)
      // O = -i * D
      const or = di
      const oi = -dr
      const xr = er + wr[k] * or - wi[k] * oi
      const xi = ei + wr[k] * oi + wi[k] * or
      out[k] = xr * xr + xi * xi
    }
  }

  /** Complex bins `0..n/2` of the real signal `x`. */
  forward(x: ArrayLike<number>, outRe: Float64Array, outIm: Float64Array): void {
    this.run(x)
    const { m, re, im, wr, wi } = this
    for (let k = 0; k <= m; k++) {
      const k1 = k === m ? 0 : k
      const k2 = k === 0 ? 0 : m - k
      const ar = re[k1]
      const ai = im[k1]
      const br = re[k2]
      const bi = -im[k2]
      const er = 0.5 * (ar + br)
      const ei = 0.5 * (ai + bi)
      const dr = 0.5 * (ar - br)
      const di = 0.5 * (ai - bi)
      const or = di
      const oi = -dr
      outRe[k] = er + wr[k] * or - wi[k] * oi
      outIm[k] = ei + wr[k] * oi + wi[k] * or
    }
  }
}
