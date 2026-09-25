/**
 * Weighted physical feature vectors for beats and bars. Layout (all in "dB-equivalent" units, so a squared
 * Euclidean distance between two vectors is a mean-square dB shift and one absolute floor means the same thing in
 * every song):
 *  - `[0, 40)`   spectral SHAPE: band dB minus the mean over bands, x 1/sqrt(40). Independent of overall gain, so a
 *                volume-knob step or a fade does not register; "louder chorus with a different mix" does.
 *  - `[40, 52)`  chroma (L2-normalised), x CHROMA_K (harmony / key)
 *  - `[52, 56)`  rhythm: mean onset strength, low-band (kick/bass) onset strength, high-band onset strength and the
 *                onset-strength std, x RHYTHM_K
 *  - `[56]`      bass share: sub+bass band dB minus broadband dB, x LOW_K. The mel shape gives the 30-160 Hz region only
 *                2-3 of its 40 bands, yet a kick/bass drop-out or return is the strongest cue in dance music.
 */
import { MEL_BANDS } from './dsp'
import type { Agg } from './aggregate'

export const CHROMA_K = 5
export const RHYTHM_K = [4, 4, 2, 2] as const
export const LOW_K = 0.6
export const VEC_DIM = MEL_BANDS + 12 + 4 + 1

export function featureVectors(a: Agg): Float32Array {
  const out = new Float32Array(a.n * VEC_DIM)
  const inv = 1 / Math.sqrt(MEL_BANDS)
  for (let k = 0; k < a.n; k++) {
    const o = k * VEC_DIM
    let m = 0
    for (let j = 0; j < MEL_BANDS; j++) m += a.melDb[k * MEL_BANDS + j]
    m /= MEL_BANDS
    for (let j = 0; j < MEL_BANDS; j++) out[o + j] = (a.melDb[k * MEL_BANDS + j] - m) * inv
    for (let p = 0; p < 12; p++) out[o + MEL_BANDS + p] = a.chroma[k * 12 + p] * CHROMA_K
    out[o + MEL_BANDS + 12] = a.flux[k] * RHYTHM_K[0]
    out[o + MEL_BANDS + 13] = a.lowFlux[k] * RHYTHM_K[1]
    out[o + MEL_BANDS + 14] = a.hiFlux[k] * RHYTHM_K[2]
    out[o + MEL_BANDS + 15] = a.fluxStd[k] * RHYTHM_K[3]
    out[o + MEL_BANDS + 16] = (a.lowDb[k] - a.levelDb[k]) * LOW_K
  }
  return out
}

/** Euclidean distance between two vectors in a flat array. */
export function vecDist(v: ArrayLike<number>, a: number, b: number): number {
  let s = 0
  const oa = a * VEC_DIM
  const ob = b * VEC_DIM
  for (let d = 0; d < VEC_DIM; d++) {
    const x = v[oa + d] - v[ob + d]
    s += x * x
  }
  return Math.sqrt(s)
}

/** Mean vector of rows `[from, to)`. */
export function meanVec(v: ArrayLike<number>, from: number, to: number, out: Float64Array): void {
  out.fill(0)
  const n = Math.max(1, to - from)
  for (let k = from; k < to; k++) for (let d = 0; d < VEC_DIM; d++) out[d] += v[k * VEC_DIM + d]
  for (let d = 0; d < VEC_DIM; d++) out[d] /= n
}
