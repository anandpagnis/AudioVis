/**
 * Triangular log-mel filterbank over an FFT magnitude spectrum.
 *
 * Pure — takes a plain `Float32Array` + a sample rate, nothing Web-Audio or
 * AudioEngine shaped, so it is fully unit-testable against a synthetic array
 * and has zero runtime dependency on the rest of the engine.
 *
 * NOT MFCC: this deliberately stops after the log-compressed band energies
 * and never applies the DCT step that turns mel bands into MFCC. MFCC's DCT
 * exists to decorrelate the band axes for classifiers/distance metrics that
 * assume roughly independent dimensions (e.g. a Gaussian mixture model, or a
 * Euclidean distance). The structure segmenter compares these vectors with
 * COSINE similarity, which only cares about direction, not inter-axis
 * correlation — so the extra step would spend cycles decorrelating an axis
 * set the consumer doesn't need decorrelated, and would throw away the
 * (physically meaningful) direct band-energy shape for no benefit here.
 *
 * RANGE: ~80 Hz - 8 kHz, mirroring the plan's brief. 80 Hz sits below almost
 * all musical fundamentals (keeps DC/sub-bass rumble, already covered by the
 * separate sub/bass scalar bands, from dominating a timbre-focused filter);
 * 8 kHz covers essentially all harmonic + percussive timbral energy that
 * matters for section-to-section timbral *change* without spending filters
 * on the near-silent top octave of a typical mix.
 *
 * MEMOISATION: building the triangular weight tables means walking the mel
 * scale and laying out `nBands` triangles over the bin axis — cheap once,
 * wasteful if repeated every call when this may run every frame later. The
 * filterbank is cached in a module-level `Map`, keyed by the exact inputs
 * that determine its shape (`nBins`, `sampleRate`, `nBands`, and the fixed
 * Hz range), following the same keyed-`Map` memoisation idiom already used
 * for the polyphase resampler's coefficient tables
 * (`src/audio/essentia/resample.ts`). Only the per-call OUTPUT vector is
 * freshly allocated (unavoidable for a pure function that returns a value);
 * the filter weight tables themselves are built once per distinct shape and
 * reused after that — `melFilterbank()` is exported so tests can assert the
 * same cached object comes back (`toBe`) across repeated calls.
 */

const MEL_MIN_HZ = 80
const MEL_MAX_HZ = 8000

function hzToMel(hz: number): number {
  return 2595 * Math.log10(1 + hz / 700)
}

function melToHz(mel: number): number {
  return 700 * (10 ** (mel / 2595) - 1)
}

/** One band's sparse triangular weights over a contiguous bin range `[startBin, startBin + weights.length)`. */
export interface MelFilterbank {
  nBands: number
  nBins: number
  startBin: Int32Array
  weights: Float32Array[]
}

const cache = new Map<string, MelFilterbank>()

/**
 * Build (or fetch the cached) triangular mel filterbank for a given spectrum
 * length / sample rate / band count. Exported mainly so tests can confirm
 * memoisation (`melFilterbank(...) === melFilterbank(...)` for the same
 * shape) and so the weight-table construction is independently inspectable.
 */
export function melFilterbank(
  nBins: number,
  sampleRate: number,
  nBands: number,
  minHz: number = MEL_MIN_HZ,
  maxHz: number = MEL_MAX_HZ,
): MelFilterbank {
  const key = `${nBins}|${sampleRate}|${nBands}|${minHz}|${maxHz}`
  const hit = cache.get(key)
  if (hit) return hit

  const bins = Math.max(2, Math.floor(nBins))
  const nyquist = Math.max(1, sampleRate / 2)
  const lo = Math.max(0, Math.min(minHz, nyquist))
  const hi = Math.max(lo + 1, Math.min(maxHz, nyquist))
  const melLo = hzToMel(lo)
  const melHi = hzToMel(hi)

  // nBands + 2 equally-spaced mel points -> nBands overlapping triangles,
  // each spanning [point[i], point[i+1], point[i+2]] (left-zero, peak, right-zero).
  const nPoints = nBands + 2
  const binPoints = new Float32Array(nPoints)
  const binScale = (bins - 1) / nyquist
  for (let j = 0; j < nPoints; j++) {
    const mel = melLo + ((melHi - melLo) * j) / Math.max(1, nPoints - 1)
    const hz = melToHz(mel)
    const b = hz * binScale
    binPoints[j] = b < 0 ? 0 : b > bins - 1 ? bins - 1 : b
  }

  const startBin = new Int32Array(nBands)
  const weights: Float32Array[] = new Array(nBands)
  for (let i = 0; i < nBands; i++) {
    const left = binPoints[i]
    const peak = binPoints[i + 1]
    const right = binPoints[i + 2]
    const lo2 = Math.max(0, Math.floor(left))
    const hi2 = Math.min(bins - 1, Math.ceil(right))
    const len = Math.max(0, hi2 - lo2 + 1)
    const w = new Float32Array(len)
    const upDen = Math.max(1e-6, peak - left)
    const downDen = Math.max(1e-6, right - peak)
    for (let b = lo2; b <= hi2; b++) {
      const t = b <= peak ? (b - left) / upDen : (right - b) / downDen
      w[b - lo2] = t < 0 ? 0 : t > 1 ? 1 : t
    }
    startBin[i] = lo2
    weights[i] = w
  }

  const fb: MelFilterbank = { nBands, nBins: bins, startBin, weights }
  cache.set(key, fb)
  return fb
}

/**
 * Log-compressed mel-band energies of `spectrum` (an FFT magnitude
 * spectrum — one-sided, bin 0 = DC, last bin = Nyquist). `log1p` rather than
 * `log`/`log10 + epsilon`: it maps 0 energy to exactly 0 (no `-Infinity`, no
 * epsilon fudge-factor to tune) while still compressing the dynamic range of
 * louder bands the way a perceptual/log feature should.
 */
export function melBands(spectrum: Float32Array, sampleRate: number, nBands = 24): Float32Array {
  const fb = melFilterbank(spectrum.length, sampleRate, nBands)
  const out = new Float32Array(fb.nBands)
  for (let i = 0; i < fb.nBands; i++) {
    const w = fb.weights[i]
    const start = fb.startBin[i]
    let sum = 0
    for (let k = 0; k < w.length; k++) {
      const bin = start + k
      if (bin < spectrum.length) sum += spectrum[bin] * w[k]
    }
    out[i] = Math.log1p(sum > 0 ? sum : 0)
  }
  return out
}
