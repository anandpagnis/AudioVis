/**
 * Whole-song downbeat (bar phase) estimation. The four possible phases `beat index mod 4` are scored by summing,
 * over the WHOLE song (future included), per-phase evidence from features that are strongest on a bar line:
 *  1. SALIENCE: bass-onset strength, broadband onset strength and harmonic (chroma) change at each beat, minus a
 *     small penalty for snare-like (high-band, back-beat) onsets that sit on beats 2 and 4;
 *  2. STRUCTURE: the beat-level change between the 4 beats before and the 4 beats after each beat (mel shape, chroma
 *     and rhythm); sections and phrases begin on bar lines, so this vote accumulates on the true phase.
 * 3. ALIGNMENT (optional, computed by the caller from the bar-synchronous features): bars cut at the true phase give
 *    sharper section steps than bars cut mid-bar, so the phase that maximises the height of the strongest 2-bar
 *    feature steps (`phaseAlignment` in `structure.ts`) votes too.
 * Each method reports its own confidence; they are combined weighted by confidence, so when one is weak
 * (four-on-the-floor EDM has identical kicks on every beat, which kills the salience vote) the others decide. The
 * result carries the final confidence: methods that agree with the chosen phase reinforce each other, a confident
 * dissenter discounts it.
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
  alignmentConfidence: number
  /** At least two of the (up to three) independent cues pick the chosen phase. */
  methodsAgree: boolean
}

export interface PhaseAlignment {
  /** Per phase: mean height of the strongest section steps when bars are cut at that phase. */
  scores: number[]
  confidence: number
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

export function estimateDownbeat(
  beatFrames: number[],
  env: Envelopes,
  beatAgg: Agg,
  beatVec: Float32Array,
  align?: PhaseAlignment,
): DownbeatEstimate {
  const nb = beatAgg.n // number of complete beats
  const flat = { phase: 0, confidence: 0, scores: [0, 0, 0, 0], salienceConfidence: 0, structureConfidence: 0, alignmentConfidence: 0, methodsAgree: false }
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
  // structure vote: only clear beat-level changes (section / phrase starts) count, in-section jitter does not. A
  // sparse vote, so its confidence is the concentration of the mass on one phase and the number of strong changes
  // (a t-test over all beats would grossly overstate it).
  const mass = [0, 0, 0, 0]
  let nStrong = 0
  for (let i = 0; i < nb; i++) {
    if (!validVote(i)) continue
    const w = Math.max(0, zVote[i] - 1.5)
    mass[i & 3] += w
    if (zVote[i] > 3) nStrong++
  }
  const massTotal = mass[0] + mass[1] + mass[2] + mass[3]
  const massShare = massTotal > 0 ? Math.max(...mass) / massTotal : 0
  const pv = { m: mass.map((x) => (massTotal > 0 ? x / massTotal : 0)), cnt: nStrong }

  const sal = [0, 1, 2, 3].map((p) => W_BASS * pb.m[p] + W_BROAD * pr.m[p] + W_HARM * ph.m[p] + W_SNARE * psn.m[p])
  const wsum = Math.sqrt(W_BASS ** 2 + W_BROAD ** 2 + W_HARM ** 2 + W_SNARE ** 2)
  const seSal = wsum / (Math.abs(W_BASS) + W_BROAD + W_HARM + Math.abs(W_SNARE)) / Math.sqrt(Math.max(1, pb.cnt) / 4)
  const salConf = marginConfidence(sal, seSal * 1.6)
  const strConf = clamp((massShare - 0.25) / 0.5, 0, 1) * (1 - Math.exp(-pv.cnt / 4))

  const cues: Array<{ s: number[]; conf: number }> = [
    { s: normalise4(sal), conf: salConf },
    { s: normalise4(pv.m), conf: strConf },
  ]
  if (align) cues.push({ s: normalise4(align.scores), conf: align.confidence })
  const wTot = cues.reduce((t, c) => t + c.conf + 0.05, 0)
  const comb = [0, 1, 2, 3].map((p) => cues.reduce((t, c) => t + (c.conf + 0.05) * c.s[p], 0) / wTot)
  const argmax = (v: number[]) => v.reduce((b, x, i) => (x > v[b] ? i : b), 0)
  const best = argmax(comb)
  const votes = cues.map((c) => argmax(c.s))
  const agreeing = cues.filter((_, k) => votes[k] === best)
  const dissent = cues.filter((c, k) => votes[k] !== best && c.conf > 0.5)
  let confidence = 1 - agreeing.reduce((t, c) => t * (1 - c.conf), 1)
  if (dissent.length > 0) confidence *= 0.6
  return {
    phase: best,
    confidence: clamp(confidence, 0, 1),
    scores: comb,
    salienceConfidence: salConf,
    structureConfidence: strConf,
    alignmentConfidence: align ? align.confidence : 0,
    methodsAgree: agreeing.length >= 2,
  }
}
