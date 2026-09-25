/**
 * Whole-song downbeat (bar phase) estimation. The four possible phases `beat index mod 4` are scored by summing,
 * over the WHOLE song (future included), per-phase evidence from features that are strongest on a bar line:
 *  1. SALIENCE: bass-onset strength, broadband onset strength and harmonic (chroma) change at each beat, minus a
 *     small penalty for snare-like (high-band, back-beat) onsets that sit on beats 2 and 4;
 *  2. STRUCTURE: the beat-level change between the 4 beats before and the 4 beats after each beat (mel shape, chroma
 *     and rhythm); sections and phrases begin on bar lines, so this vote accumulates on the true phase.
 * Each method reports its own confidence (a t-statistic of the margin between the best and second-best phase); the
 * two are combined weighted by confidence, so when one is weak (four-on-the-floor EDM has identical kicks on every
 * beat, which kills the salience vote) the other decides. The result carries the final confidence.
 */
import { clamp, robustZ, type Agg, type Envelopes } from './aggregate'
import { meanVec, VEC_DIM } from './vectors'

export interface DownbeatEstimate {
  /** 0..3: which of the first four beats is a downbeat. */
  phase: number
  confidence: number
  /** Combined per-phase score (higher = more likely a downbeat). */
  scores: number[]
  salienceConfidence: number
  structureConfidence: number
}

const W_BASS = 0.8
const W_BROAD = 0.4
const W_HARM = 1.0
const W_SNARE = -0.5

function phaseMeans(z: ArrayLike<number>, valid: (i: number) => boolean, n: number): { m: number[]; cnt: number } {
  const sum = [0, 0, 0, 0]
  const c = [0, 0, 0, 0]
  for (let i = 0; i < n; i++) {
    if (!valid(i)) continue
    const p = i & 3
    sum[p] += clamp(z[i], -3, 5)
    c[p]++
  }
  const cnt = c[0] + c[1] + c[2] + c[3]
  return { m: sum.map((s, p) => (c[p] ? s / c[p] : 0)), cnt }
}

/** Margin between the best and second-best phase in standard errors -> confidence 0..1. */
function marginConfidence(scores: number[], se: number): number {
  const s = [...scores].sort((a, b) => b - a)
  const t = (s[0] - s[1]) / (Math.SQRT2 * Math.max(1e-9, se))
  return clamp(1 - Math.exp(-Math.pow(t / 3, 2)), 0, 1)
}

function normalise4(s: number[]): number[] {
  const m = (s[0] + s[1] + s[2] + s[3]) / 4
  const sd = Math.sqrt(s.reduce((a, x) => a + (x - m) * (x - m), 0) / 4)
  return s.map((x) => (sd > 1e-9 ? (x - m) / sd : 0))
}

export function estimateDownbeat(beatFrames: number[], env: Envelopes, beatAgg: Agg, beatVec: Float32Array): DownbeatEstimate {
  const nb = beatAgg.n // number of complete beats
  const flat = { phase: 0, confidence: 0, scores: [0, 0, 0, 0], salienceConfidence: 0, structureConfidence: 0 }
  if (nb < 16) return flat

  const peakOf = (arr: Float32Array, i: number) => {
    const f = Math.round(beatFrames[i])
    let m = 0
    for (let t = Math.max(0, f - 2); t <= Math.min(arr.length - 1, f + 2); t++) if (arr[t] > m) m = arr[t]
    return m
  }
  const bass = new Float64Array(nb)
  const broad = new Float64Array(nb)
  const hi = new Float64Array(nb)
  for (let i = 0; i < nb; i++) {
    bass[i] = peakOf(env.lowFlux, i)
    broad[i] = peakOf(env.flux, i)
    hi[i] = peakOf(env.hiFlux, i)
  }
  // harmonic change: 1 - cos(mean chroma of the 2 beats after, 2 beats before)
  const harm = new Float64Array(nb)
  const c = beatAgg.chroma
  const win = (from: number, to: number, out: Float64Array) => {
    out.fill(0)
    for (let k = from; k < to; k++) for (let p = 0; p < 12; p++) out[p] += c[k * 12 + p]
  }
  const ca = new Float64Array(12)
  const cb = new Float64Array(12)
  for (let i = 2; i < nb - 2; i++) {
    win(i, i + 2, ca)
    win(i - 2, i, cb)
    let ab = 0
    let aa = 0
    let bb = 0
    for (let p = 0; p < 12; p++) {
      ab += ca[p] * cb[p]
      aa += ca[p] * ca[p]
      bb += cb[p] * cb[p]
    }
    harm[i] = aa > 1e-9 && bb > 1e-9 ? 1 - ab / Math.sqrt(aa * bb) : 0
  }
  // structural change across each beat over 4-beat windows
  const vote = new Float64Array(nb)
  const ma = new Float64Array(VEC_DIM)
  const mb = new Float64Array(VEC_DIM)
  for (let i = 4; i <= nb - 4; i++) {
    meanVec(beatVec, i, i + 4, ma)
    meanVec(beatVec, i - 4, i, mb)
    let s = 0
    for (let d = 0; d < VEC_DIM; d++) s += (ma[d] - mb[d]) * (ma[d] - mb[d])
    vote[i] = Math.sqrt(s)
  }

  const validSal = (i: number) => i >= 2 && i < nb - 2
  const validVote = (i: number) => i >= 4 && i <= nb - 4
  const zBass = robustZ(bass)
  const zBroad = robustZ(broad)
  const zHi = robustZ(hi)
  const zHarm = robustZ(harm, 2, nb - 2)
  const zVote = robustZ(vote, 4, nb - 3)
  const pb = phaseMeans(zBass, validSal, nb)
  const pr = phaseMeans(zBroad, validSal, nb)
  const ph = phaseMeans(zHarm, validSal, nb)
  const psn = phaseMeans(zHi, validSal, nb)
  const pv = phaseMeans(zVote, validVote, nb)

  const sal = [0, 1, 2, 3].map((p) => W_BASS * pb.m[p] + W_BROAD * pr.m[p] + W_HARM * ph.m[p] + W_SNARE * psn.m[p])
  const wsum = Math.sqrt(W_BASS ** 2 + W_BROAD ** 2 + W_HARM ** 2 + W_SNARE ** 2)
  const seSal = wsum / (Math.abs(W_BASS) + W_BROAD + W_HARM + Math.abs(W_SNARE)) / Math.sqrt(Math.max(1, pb.cnt) / 4)
  const seVote = 1 / Math.sqrt(Math.max(1, pv.cnt) / 4)
  const salConf = marginConfidence(sal, seSal * 1.6)
  const strConf = marginConfidence(pv.m, seVote * 1.6)

  const ns = normalise4(sal)
  const nv = normalise4(pv.m)
  const comb = [0, 1, 2, 3].map((p) => ((salConf + 0.05) * ns[p] + (strConf + 0.05) * nv[p]) / (salConf + strConf + 0.1))
  let best = 0
  for (let p = 1; p < 4; p++) if (comb[p] > comb[best]) best = p
  let bs = 0
  for (let p = 1; p < 4; p++) if (sal[p] > sal[bs]) bs = p
  let bv = 0
  for (let p = 1; p < 4; p++) if (pv.m[p] > pv.m[bv]) bv = p
  const agree = bs === bv
  const confidence = agree ? 1 - (1 - salConf) * (1 - strConf) : Math.max(salConf, strConf) * 0.6
  return { phase: best, confidence: clamp(confidence, 0, 1), scores: comb, salienceConfidence: salConf, structureConfidence: strConf }
}
