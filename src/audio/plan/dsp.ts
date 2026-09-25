/**
 * Front end of the whole-song analyser: decimate to ~22 kHz mono, then STFT (2048 Hann, hop 512) streamed frame by
 * frame into compact per-frame features. Nothing bigger than one FFT frame plus the per-frame feature rows is ever
 * held: no full spectrogram (a 4-minute track is ~10k frames x ~60 floats, about 3 MB).
 *
 * Per-frame outputs (all indexed by frame `t`, frame centre at sample `t * HOP` of the decimated signal):
 *  - `melLin`  MEL_BANDS mean-square-per-band values, linear (log taken by the consumer: bar means of the LINEAR
 *              energy are robust to a two-beat silence gap, bar means of dB are not)
 *  - `melDb`   the same in dB (floored), used for spectral flux
 *  - `chroma`  12 pitch classes, magnitude folded from a 4096-point analysis (refreshed every second frame)
 *  - `levelLin`/`lowLin`/`highLin` broadband, sub+bass (30-160 Hz) and high (4-10.5 kHz) energy, linear
 *
 * Clean-room: standard STFT/mel/chroma definitions only.
 */
import { RealFft } from './fft'

export const FFT_SIZE = 2048
export const HOP = 512
export const MEL_BANDS = 40
export const CHROMA_FFT = 4096
const DB_FLOOR_ENERGY = 1e-8

export interface FrameFeatures {
  /** Analysis sample rate (after decimation). */
  sr: number
  /** Number of frames. */
  n: number
  /** Seconds per hop. */
  hopSec: number
  melLin: Float32Array
  melDb: Float32Array
  chroma: Float32Array
  levelLin: Float32Array
  lowLin: Float32Array
  highLin: Float32Array
}

export function toDb(e: number): number {
  return 10 * Math.log10(e + DB_FLOOR_ENERGY)
}

/**
 * Anti-aliased integer decimation to the rate nearest `target` (44.1 kHz -> 22.05 kHz, 48 kHz -> 24 kHz, an input
 * already near the target passes through untouched). Windowed-sinc low-pass (Hann, `20 * D + 1` taps, cut-off at
 * 0.45 of the new Nyquist band edge).
 */
export function decimate(pcm: Float32Array, sr: number, target: number): { data: Float32Array; sr: number } {
  const d = Math.max(1, Math.round(sr / target))
  if (d === 1) return { data: pcm, sr }
  const taps = 20 * d + 1
  const half = (taps - 1) >> 1
  const fc = 0.45 / d
  const h = new Float64Array(taps)
  let sum = 0
  for (let i = 0; i < taps; i++) {
    const x = i - half
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x)
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1))
    h[i] = sinc * w
    sum += h[i]
  }
  for (let i = 0; i < taps; i++) h[i] /= sum
  const nOut = Math.floor(pcm.length / d)
  const out = new Float32Array(nOut)
  const n = pcm.length
  for (let o = 0; o < nOut; o++) {
    const c = o * d
    let acc = 0
    const lo = Math.max(0, c - half)
    const hi = Math.min(n - 1, c + half)
    const base = c - half
    for (let i = lo; i <= hi; i++) acc += pcm[i] * h[i - base]
    out[o] = acc
  }
  return { data: out, sr: sr / d }
}

/** HTK mel scale. */
const hzToMel = (f: number) => 2595 * Math.log10(1 + f / 700)
const melToHz = (m: number) => 700 * (Math.pow(10, m / 2595) - 1)

interface MelBank {
  /** Per band: first bin, weights. */
  lo: Int32Array
  w: Float64Array[]
  centres: Float64Array
}

function buildMelBank(sr: number, nFft: number): MelBank {
  const fmin = 30
  const fmax = Math.min(10500, 0.49 * sr)
  const mMin = hzToMel(fmin)
  const mMax = hzToMel(fmax)
  const edges = new Float64Array(MEL_BANDS + 2)
  for (let i = 0; i < MEL_BANDS + 2; i++) edges[i] = melToHz(mMin + ((mMax - mMin) * i) / (MEL_BANDS + 1))
  const binHz = sr / nFft
  const lo = new Int32Array(MEL_BANDS)
  const w: Float64Array[] = []
  const centres = new Float64Array(MEL_BANDS)
  for (let b = 0; b < MEL_BANDS; b++) {
    const f0 = edges[b]
    const f1 = edges[b + 1]
    const f2 = edges[b + 2]
    centres[b] = f1
    const k0 = Math.max(1, Math.floor(f0 / binHz))
    const k2 = Math.min(nFft / 2, Math.ceil(f2 / binHz))
    const ws: number[] = []
    for (let k = k0; k <= k2; k++) {
      const f = k * binHz
      const v = f <= f1 ? (f - f0) / (f1 - f0) : (f2 - f) / (f2 - f1)
      ws.push(v > 0 ? v : 0)
    }
    lo[b] = k0
    w.push(Float64Array.from(ws))
  }
  return { lo, w, centres }
}

interface ChromaMap {
  k0: number
  pc0: Uint8Array
  pc1: Uint8Array
  w1: Float32Array
}

function buildChromaMap(sr: number, nFft: number): ChromaMap {
  const binHz = sr / nFft
  const fLo = 100
  const fHi = Math.min(2500, 0.45 * sr)
  const k0 = Math.ceil(fLo / binHz)
  const k1 = Math.floor(fHi / binHz)
  const cnt = Math.max(0, k1 - k0 + 1)
  const pc0 = new Uint8Array(cnt)
  const pc1 = new Uint8Array(cnt)
  const w1 = new Float32Array(cnt)
  for (let i = 0; i < cnt; i++) {
    const f = (k0 + i) * binHz
    // fractional pitch class, C = 0 (A440 = MIDI 69 = pc 9)
    const q = (((12 * Math.log2(f / 440) + 9) % 12) + 12) % 12
    const a = Math.floor(q)
    pc0[i] = a % 12
    pc1[i] = (a + 1) % 12
    w1[i] = q - a
  }
  return { k0, pc0, pc1, w1 }
}

/** Hann window (periodic form, fine for analysis). */
function hann(n: number): Float64Array {
  const w = new Float64Array(n)
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n)
  return w
}

/** Stream the STFT of a decimated signal into per-frame features. */
export function extractFrames(x: Float32Array, sr: number): FrameFeatures {
  const n = Math.max(0, Math.floor(x.length / HOP) + 1)
  const fft = new RealFft(FFT_SIZE)
  const cfft = new RealFft(CHROMA_FFT)
  const win = hann(FFT_SIZE)
  const cwin = hann(CHROMA_FFT)
  let winSum = 0
  let winSq = 0
  for (let i = 0; i < FFT_SIZE; i++) {
    winSum += win[i]
    winSq += win[i] * win[i]
  }
  let cwinSum = 0
  for (let i = 0; i < CHROMA_FFT; i++) cwinSum += cwin[i]
  // |X_k| -> unit amplitude sinusoid gives 1
  const pScale = 4 / (winSum * winSum)
  const cScale = 2 / cwinSum

  const bank = buildMelBank(sr, FFT_SIZE)
  const cmap = buildChromaMap(sr, CHROMA_FFT)
  const binHz = sr / FFT_SIZE
  const lowLo = Math.max(1, Math.round(30 / binHz))
  const lowHi = Math.round(160 / binHz)
  const highLo = Math.round(4000 / binHz)
  const highHi = Math.min(FFT_SIZE / 2, Math.round(10500 / binHz))

  const melLin = new Float32Array(n * MEL_BANDS)
  const melDb = new Float32Array(n * MEL_BANDS)
  const chroma = new Float32Array(n * 12)
  const levelLin = new Float32Array(n)
  const lowLin = new Float32Array(n)
  const highLin = new Float32Array(n)

  const buf = new Float64Array(FFT_SIZE)
  const cbuf = new Float64Array(CHROMA_FFT)
  const pow = new Float64Array(FFT_SIZE / 2 + 1)
  const cre = new Float64Array(CHROMA_FFT / 2 + 1)
  const cim = new Float64Array(CHROMA_FFT / 2 + 1)
  const len = x.length

  for (let t = 0; t < n; t++) {
    const c = t * HOP
    const s0 = c - FFT_SIZE / 2
    let ms = 0
    for (let i = 0; i < FFT_SIZE; i++) {
      const idx = s0 + i
      const v = idx >= 0 && idx < len ? x[idx] : 0
      const wv = v * win[i]
      buf[i] = wv
      ms += wv * wv
    }
    levelLin[t] = ms / winSq
    fft.power(buf, pow)
    const mo = t * MEL_BANDS
    for (let b = 0; b < MEL_BANDS; b++) {
      const wb = bank.w[b]
      const k0 = bank.lo[b]
      let e = 0
      for (let j = 0; j < wb.length; j++) e += wb[j] * pow[k0 + j]
      e *= pScale
      melLin[mo + b] = e
      melDb[mo + b] = toDb(e)
    }
    let low = 0
    for (let k = lowLo; k <= lowHi; k++) low += pow[k]
    lowLin[t] = low * pScale
    let high = 0
    for (let k = highLo; k <= highHi; k++) high += pow[k]
    highLin[t] = high * pScale

    const co = t * 12
    if ((t & 1) === 0) {
      const cs0 = c - CHROMA_FFT / 2
      for (let i = 0; i < CHROMA_FFT; i++) {
        const idx = cs0 + i
        cbuf[i] = (idx >= 0 && idx < len ? x[idx] : 0) * cwin[i]
      }
      cfft.forward(cbuf, cre, cim)
      for (let j = 0; j < cmap.pc0.length; j++) {
        const k = cmap.k0 + j
        const a = Math.sqrt(cre[k] * cre[k] + cim[k] * cim[k]) * cScale
        const w1 = cmap.w1[j]
        chroma[co + cmap.pc0[j]] += a * (1 - w1)
        chroma[co + cmap.pc1[j]] += a * w1
      }
    } else {
      for (let p = 0; p < 12; p++) chroma[co + p] = chroma[co - 12 + p]
    }
  }
  return { sr, n, hopSec: HOP / sr, melLin, melDb, chroma, levelLin, lowLin, highLin }
}

/**
 * Spectral-flux onset strength on log-mel (SuperFlux style: each band is compared with the max of its three
 * neighbouring bands one frame earlier, which suppresses vibrato and slow filter sweeps). Returns three envelopes,
 * all in dB per band per frame, length `n`:
 *  - `flux`   mean over all bands (the beat / tempo envelope)
 *  - `lowFlux` mean over the lowest 6 bands (kick and bass, below ~350 Hz)
 *  - `hiFlux` mean over the bands above ~2 kHz
 */
export function onsetEnvelopes(f: FrameFeatures): { flux: Float32Array; lowFlux: Float32Array; hiFlux: Float32Array } {
  const n = f.n
  const flux = new Float32Array(n)
  const lowFlux = new Float32Array(n)
  const hiFlux = new Float32Array(n)
  const NL = 6
  const hiStart = 24
  for (let t = 1; t < n; t++) {
    const cur = t * MEL_BANDS
    const prev = (t - 1) * MEL_BANDS
    let all = 0
    let lo = 0
    let hi = 0
    for (let b = 0; b < MEL_BANDS; b++) {
      let ref = f.melDb[prev + b]
      if (b > 0 && f.melDb[prev + b - 1] > ref) ref = f.melDb[prev + b - 1]
      if (b < MEL_BANDS - 1 && f.melDb[prev + b + 1] > ref) ref = f.melDb[prev + b + 1]
      const d = f.melDb[cur + b] - ref
      if (d > 0) {
        all += d
        if (b < NL) lo += d
        if (b >= hiStart) hi += d
      }
    }
    flux[t] = all / MEL_BANDS
    lowFlux[t] = lo / NL
    hiFlux[t] = hi / (MEL_BANDS - hiStart)
  }
  return { flux, lowFlux, hiFlux }
}
