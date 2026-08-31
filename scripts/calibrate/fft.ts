/**
 * Minimal radix-2 FFT + a `getFloatFrequencyData`-equivalent, for the offline
 * calibration harness only. NOT shipped, NOT imported by anything under `src/`.
 *
 * The goal is *consistency* with the browser's `AnalyserNode`, not bit-identity:
 * same Blackman window, same `20·log10(|FFT|/fftSize)` normalization, no
 * smoothing (the engine sets `smoothingTimeConstant = 0`). `crosscheck.calib.ts`
 * bounds the residual difference against a real decode.
 */

/** In-place iterative Cooley–Tukey FFT. `re`/`im` length must be a power of two. */
export function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length
  if (n <= 1) return
  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]
      re[i] = re[j]
      re[j] = tr
      const ti = im[i]
      im[i] = im[j]
      im[j] = ti
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wpr = Math.cos(ang)
    const wpi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let wr = 1
      let wi = 0
      const half = len >> 1
      for (let k = 0; k < half; k++) {
        const a = i + k
        const b = a + half
        const xr = re[b] * wr - im[b] * wi
        const xi = re[b] * wi + im[b] * wr
        re[b] = re[a] - xr
        im[b] = im[a] - xi
        re[a] += xr
        im[a] += xi
        const nwr = wr * wpr - wi * wpi
        wi = wr * wpi + wi * wpr
        wr = nwr
      }
    }
  }
}

/** Web-Audio Blackman window (α = 0.16), cached per size. */
const windowCache = new Map<number, Float64Array>()
export function blackman(size: number): Float64Array {
  const cached = windowCache.get(size)
  if (cached) return cached
  const w = new Float64Array(size)
  const a0 = 0.42
  const a1 = 0.5
  const a2 = 0.08
  for (let i = 0; i < size; i++) {
    const x = (2 * Math.PI * i) / (size - 1)
    w[i] = a0 - a1 * Math.cos(x) + a2 * Math.cos(2 * x)
  }
  windowCache.set(size, w)
  return w
}

/**
 * `AnalyserNode.getFloatFrequencyData` equivalent: Blackman-windowed FFT of
 * `frame` (length `fftSize`), magnitude normalized by `fftSize`, in dB, floored
 * at `minDb`. Writes the lower `fftSize/2` bins into `out`.
 */
export function frequencyDataDb(
  frame: Float32Array,
  fftSize: number,
  out: Float32Array,
  minDb = -140,
): void {
  const w = blackman(fftSize)
  const re = new Float64Array(fftSize)
  const im = new Float64Array(fftSize)
  for (let i = 0; i < fftSize; i++) re[i] = frame[i] * w[i]
  fftInPlace(re, im)
  const half = fftSize / 2
  for (let k = 0; k < half; k++) {
    const mag = Math.hypot(re[k], im[k]) / fftSize
    out[k] = mag > 0 ? Math.max(minDb, 20 * Math.log10(mag)) : minDb
  }
}
