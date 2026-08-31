import { describe, expect, it } from 'vitest'
import {
  KWeighting,
  LUFS_SILENCE,
  OfflineLoudness,
  kWeightingStage1,
  kWeightingStage2,
  meanSquareToLufs,
} from '../loudness'

// ITU-R BS.1770-4 Table 1 / Table 2 — the canonical 48 kHz coefficients.
const SPEC_48K_S1 = {
  b0: 1.53512485958697,
  b1: -2.69169618940638,
  b2: 1.19839281085285,
  a1: -1.69065929318241,
  a2: 0.73248077421585,
}
const SPEC_48K_S2 = {
  b0: 1.0,
  b1: -2.0,
  b2: 1.0,
  a1: -1.99004745483398,
  a2: 0.99007225036621,
}

describe('K-weighting coefficients', () => {
  it('reproduce the BS.1770-4 48 kHz table', () => {
    const s1 = kWeightingStage1(48000)
    const s2 = kWeightingStage2(48000)
    for (const k of ['b0', 'b1', 'b2', 'a1', 'a2'] as const) {
      expect(s1[k]).toBeCloseTo(SPEC_48K_S1[k], 6)
      expect(s2[k]).toBeCloseTo(SPEC_48K_S2[k], 6)
    }
  })

  it('stay stable (poles inside the unit circle) at every common rate', () => {
    for (const fs of [22050, 32000, 44100, 48000, 88200, 96000, 192000]) {
      for (const c of [kWeightingStage1(fs), kWeightingStage2(fs)]) {
        // |a1| < 1 + a2 and |a2| < 1  ⇔  both poles inside the unit circle
        expect(Math.abs(c.a2)).toBeLessThan(1)
        expect(Math.abs(c.a1)).toBeLessThan(1 + c.a2 + 1e-9)
      }
    }
  })

  it('stage 2 numerator is exactly [1, -2, 1] at any rate (perfect DC null)', () => {
    for (const fs of [44100, 48000, 96000]) {
      const s2 = kWeightingStage2(fs)
      expect(s2.b0).toBe(1)
      expect(s2.b1).toBe(-2)
      expect(s2.b2).toBe(1)
    }
  })
})

describe('meanSquareToLufs', () => {
  it('applies -0.691 + 10log10(ms) and floors at silence', () => {
    // a K-weighted mean-square of 1.0 → -0.691 LUFS
    expect(meanSquareToLufs(1)).toBeCloseTo(-0.691, 6)
    // 0.5 → 3 dB lower
    expect(meanSquareToLufs(0.5)).toBeCloseTo(-0.691 - 3.0103, 3)
    expect(meanSquareToLufs(0)).toBe(LUFS_SILENCE)
    expect(meanSquareToLufs(1e-30)).toBe(LUFS_SILENCE)
  })
})

describe('KWeighting filter', () => {
  it('passes ~1 kHz through at ~unity gain (the K-weighting calibration point)', () => {
    const fs = 48000
    const f = new KWeighting(fs)
    const N = fs * 2
    let sumIn = 0
    let sumOut = 0
    for (let i = 0; i < N; i++) {
      const x = Math.sin((2 * Math.PI * 997 * i) / fs)
      const y = f.process(x)
      if (i > fs) {
        // skip the first second (filter settling)
        sumIn += x * x
        sumOut += y * y
      }
    }
    const gainDb = 10 * Math.log10(sumOut / sumIn)
    // K-weighting is ~+0.69 dB at 997 Hz (that's why L_K subtracts 0.691)
    expect(gainDb).toBeGreaterThan(0.4)
    expect(gainDb).toBeLessThan(1.0)
  })

  it('heavily attenuates sub-bass (the RLB high-pass)', () => {
    const fs = 48000
    const f = new KWeighting(fs)
    const N = fs * 3
    let sumIn = 0
    let sumOut = 0
    for (let i = 0; i < N; i++) {
      const x = Math.sin((2 * Math.PI * 20 * i) / fs)
      const y = f.process(x)
      if (i > fs * 1.5) {
        sumIn += x * x
        sumOut += y * y
      }
    }
    const gainDb = 10 * Math.log10(sumOut / sumIn)
    expect(gainDb).toBeLessThan(-10) // ~-13 dB at 20 Hz
  })

  it('recovers from a non-finite sample instead of poisoning the state', () => {
    const f = new KWeighting(44100)
    for (let i = 0; i < 100; i++) f.process(Math.sin(i))
    expect(f.process(NaN)).toBe(0)
    // clean sine again → finite output within a few samples
    let last = 0
    for (let i = 0; i < 50; i++) last = f.process(Math.sin(i / 3))
    expect(Number.isFinite(last)).toBe(true)
  })
})

describe('OfflineLoudness', () => {
  const fs = 48000

  it('reads a full-scale 1 kHz sine near -3 LUFS short-term', () => {
    const lm = new OfflineLoudness(fs)
    const block = new Float32Array(fs * 4)
    for (let i = 0; i < block.length; i++) block[i] = Math.sin((2 * Math.PI * 1000 * i) / fs)
    lm.push(block)
    const { shortTerm } = lm.read()
    // full-scale sine RMS = -3.01 dBFS; K-weighting ~0 dB at 1 kHz → ~-3 LUFS
    expect(meanSquareToLufs(shortTerm)).toBeGreaterThan(-4)
    expect(meanSquareToLufs(shortTerm)).toBeLessThan(-2)
  })

  it('drops exactly 6 dB when the input amplitude halves (LTI)', () => {
    const mk = (amp: number) => {
      const lm = new OfflineLoudness(fs)
      const block = new Float32Array(fs * 4)
      for (let i = 0; i < block.length; i++)
        block[i] = amp * Math.sin((2 * Math.PI * 1000 * i) / fs)
      lm.push(block)
      return meanSquareToLufs(lm.read().shortTerm)
    }
    expect(mk(1.0) - mk(0.5)).toBeCloseTo(6.02, 1)
  })

  it('short-term integrates ~3 s: a 1 s loud burst after 2 s silence reads ~5 dB below steady', () => {
    const lm = new OfflineLoudness(fs)
    const sil = new Float32Array(fs * 2)
    const loud = new Float32Array(fs * 1)
    for (let i = 0; i < loud.length; i++) loud[i] = Math.sin((2 * Math.PI * 1000 * i) / fs)
    lm.push(sil)
    lm.push(loud)
    const burst = meanSquareToLufs(lm.read().shortTerm)

    const lm2 = new OfflineLoudness(fs)
    const steady = new Float32Array(fs * 4)
    for (let i = 0; i < steady.length; i++) steady[i] = Math.sin((2 * Math.PI * 1000 * i) / fs)
    lm2.push(steady)
    const full = meanSquareToLufs(lm2.read().shortTerm)

    // 1 s of energy in a 3 s window ≈ 10·log10(1/3) ≈ -4.8 dB
    expect(full - burst).toBeGreaterThan(3)
    expect(full - burst).toBeLessThan(7)
  })

  it('momentary (400 ms) reacts faster than short-term to the same burst', () => {
    const lm = new OfflineLoudness(fs)
    const sil = new Float32Array(fs * 2)
    const loud = new Float32Array(Math.round(fs * 0.5))
    for (let i = 0; i < loud.length; i++) loud[i] = Math.sin((2 * Math.PI * 1000 * i) / fs)
    lm.push(sil)
    lm.push(loud)
    const { momentary, shortTerm } = lm.read()
    // 0.5 s burst fills the 400 ms momentary window but only 1/6 of the 3 s one
    expect(meanSquareToLufs(momentary)).toBeGreaterThan(meanSquareToLufs(shortTerm) + 3)
  })

  it('reads silence as the LUFS floor', () => {
    const lm = new OfflineLoudness(fs)
    lm.push(new Float32Array(fs))
    expect(meanSquareToLufs(lm.read().shortTerm)).toBe(LUFS_SILENCE)
  })
})
