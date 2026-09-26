import { describe, expect, it } from 'vitest'
import { decimate, extractFrames, HOP, MEL_BANDS, onsetEnvelopes, toDb } from '../dsp'
import { autocorrelation, estimateTempo, foldPeriod, meanBeatPeriod, parabolic, trackBeats } from '../tempo'

const rmsDb = (x: Float32Array, from = 0, to = x.length) => {
  let s = 0
  for (let i = from; i < to; i++) s += x[i] * x[i]
  return 10 * Math.log10(s / Math.max(1, to - from) + 1e-20)
}
const sine = (f: number, sr: number, sec: number, amp = 1) => Float32Array.from({ length: Math.round(sr * sec) }, (_, i) => amp * Math.sin((2 * Math.PI * f * i) / sr))

describe('decimate', () => {
  it('halves 44.1 kHz, keeps a 1 kHz tone and removes an aliasing 15 kHz tone', () => {
    const keep = decimate(sine(1000, 44100, 1), 44100, 22050)
    expect(keep.sr).toBe(22050)
    expect(keep.data.length).toBe(22050)
    expect(Math.abs(rmsDb(keep.data, 1000, 21000) - -3.01)).toBeLessThan(0.3)
    // 15 kHz would alias to 7.05 kHz at 22.05 kHz; the anti-alias filter must take it well down
    const alias = decimate(sine(15000, 44100, 1), 44100, 22050)
    expect(rmsDb(alias.data, 1000, 21000)).toBeLessThan(-35)
  })

  it('passes an already-suitable rate through untouched, and maps 48 kHz to 24 kHz', () => {
    const x = sine(440, 22050, 0.5)
    const same = decimate(x, 22050, 22050)
    expect(same.data).toBe(x)
    expect(same.sr).toBe(22050)
    expect(decimate(sine(440, 48000, 0.5), 48000, 22050).sr).toBe(24000)
  })
})

describe('extractFrames', () => {
  const sr = 22050
  const x = sine(1000, sr, 2, 0.5)
  const f = extractFrames(x, sr)

  it('produces one frame per hop and finite, floored features', () => {
    expect(f.n).toBe(Math.floor(x.length / HOP) + 1)
    expect(f.hopSec).toBeCloseTo(HOP / sr, 9)
    for (const arr of [f.melDb, f.melLin, f.chroma, f.levelLin, f.lowLin, f.highLin]) for (let i = 0; i < arr.length; i += 97) expect(Number.isFinite(arr[i])).toBe(true)
  })

  it('a steady 1 kHz sine: level near -9 dBFS (amp 0.5), energy in the 1 kHz mel band, chroma on B', () => {
    const t = 40
    expect(toDb(f.levelLin[t])).toBeGreaterThan(-10)
    expect(toDb(f.levelLin[t])).toBeLessThan(-8)
    let best = 0
    for (let b = 1; b < MEL_BANDS; b++) if (f.melLin[t * MEL_BANDS + b] > f.melLin[t * MEL_BANDS + best]) best = b
    // 40 HTK-mel bands span 30 Hz - 10.5 kHz in equal mel steps: 1 kHz (1000 mel) falls in band ~12.9
    expect(best).toBeGreaterThanOrEqual(11)
    expect(best).toBeLessThanOrEqual(14)
    let pc = 0
    for (let p = 1; p < 12; p++) if (f.chroma[t * 12 + p] > f.chroma[t * 12 + pc]) pc = p
    expect(pc).toBe(11) // 1000 Hz = MIDI 83.2 = B
    expect(f.lowLin[t]).toBeLessThan(f.highLin[t] + 1e-3)
  })

  it('a click train produces onset-strength peaks on the clicks and nothing between', () => {
    const y = new Float32Array(sr * 3)
    for (let k = 0; k < 6; k++) {
      const at = Math.round(sr * (0.25 + 0.5 * k))
      for (let i = 0; i < 200; i++) y[at + i] = Math.exp(-i / 30) * (i % 2 ? 1 : -1)
    }
    const fr = extractFrames(y, sr)
    const env = onsetEnvelopes(fr)
    const at = (sec: number) => Math.round((sec * sr) / HOP)
    for (let k = 0; k < 6; k++) {
      const c = at(0.25 + 0.5 * k)
      let peak = 0
      for (let t = c - 2; t <= c + 2; t++) peak = Math.max(peak, env.flux[t])
      expect(peak).toBeGreaterThan(5)
      // half way to the next click the envelope is silent
      expect(env.flux[at(0.5 + 0.5 * k)]).toBeLessThan(0.5)
    }
  })
})

/** Envelope frames for a click train of `bpm` at 43 fps with a little background. */
function clickEnvelope(bpm: number, seconds: number, fps: number, accentEvery = 0): Float32Array {
  const n = Math.round(seconds * fps)
  const env = new Float32Array(n)
  const period = (fps * 60) / bpm
  for (let k = 0; k * period < n - 2; k++) {
    const t = Math.round(k * period)
    env[t] = accentEvery && k % accentEvery === 0 ? 8 : 5
    env[t + 1] += 1.5
  }
  for (let i = 0; i < n; i++) env[i] += 0.1 * ((i * 7919) % 13) / 13
  return env
}

describe('tempo', () => {
  const fps = 22050 / HOP

  it('autocorrelation peaks at the period of a pulse train and is 1 at lag 0', () => {
    const r = autocorrelation(clickEnvelope(120, 30, fps), 60)
    expect(r[0]).toBeCloseTo(1, 9)
    const period = Math.round((fps * 60) / 120)
    for (let l = 2; l < 40; l++) if (Math.abs(l - period) > 2 && Math.abs(l - 2 * period) > 2) expect(r[period]).toBeGreaterThan(r[l])
  })

  it.each([90, 100, 120, 128, 140, 174])('estimates %i BPM from a pulse train within 3%% after octave folding', (bpm) => {
    const t = estimateTempo(clickEnvelope(bpm, 40, fps), fps)
    // the autocorrelation alone cannot tell 140 from 70; `foldPeriod` puts every estimate in 74-152 BPM
    const folded = (fps * 60) / foldPeriod(t.periodFrames, fps)
    const want = bpm >= 152 ? bpm / 2 : bpm
    expect(Math.abs(folded / want - 1)).toBeLessThan(0.03)
    expect(t.confidence).toBeGreaterThan(0.5)
  })

  it('does not report a pulse for flat noise (low confidence)', () => {
    let seed = 12345
    const noise = Float32Array.from({ length: 1500 }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed / 4294967296
    })
    expect(estimateTempo(noise, fps).confidence).toBeLessThan(0.4)
  })

  it('the DP beat tracker follows the pulse, and the fitted period is exact', () => {
    const bpm = 124
    const env = clickEnvelope(bpm, 40, fps, 4)
    const tr = trackBeats(env, (fps * 60) / bpm)
    expect(tr.frames.length).toBeGreaterThan(60)
    const period = (fps * 60) / bpm
    for (let i = 4; i < tr.frames.length - 4; i++) expect(Math.abs(tr.frames[i] - tr.frames[i - 1] - period)).toBeLessThan(1.1)
    expect(tr.onsetRatio).toBeGreaterThan(3)
    const secPerBeat = meanBeatPeriod(tr.frames.map((f) => f / fps))
    expect(Math.abs(60 / secPerBeat / bpm - 1)).toBeLessThan(0.005)
  })

  it('folds slow and fast tempi into 74-152 BPM by octaves', () => {
    const bpmOf = (p: number) => (fps * 60) / p
    expect(bpmOf(foldPeriod((fps * 60) / 60, fps))).toBeCloseTo(120, 6)
    expect(bpmOf(foldPeriod((fps * 60) / 174, fps))).toBeCloseTo(87, 6)
    expect(bpmOf(foldPeriod((fps * 60) / 128, fps))).toBeCloseTo(128, 6)
  })

  it('parabolic refinement recovers a fractional peak position', () => {
    const y = [0, 1, 4, 3.6, 1]
    const p = parabolic(y, 2)
    expect(p).toBeGreaterThan(2)
    expect(p).toBeLessThan(2.5)
  })
})
