import { describe, expect, it } from 'vitest'
import { resample, resampleDesign, kaiserBeta } from '../resample'

/** Naive 2-tap linear resampler — the thing this module replaces. */
function linear(pcm: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return pcm
  const outLen = Math.floor((pcm.length * toRate) / fromRate)
  const out = new Float32Array(outLen)
  const step = fromRate / toRate
  for (let i = 0; i < outLen; i++) {
    const pos = i * step
    const i0 = Math.floor(pos)
    const i1 = Math.min(pcm.length - 1, i0 + 1)
    const frac = pos - i0
    out[i] = pcm[i0] * (1 - frac) + pcm[i1] * frac
  }
  return out
}

function tone(freqHz: number, rate: number, seconds: number, amp = 1): Float32Array {
  const n = Math.round(rate * seconds)
  const out = new Float32Array(n)
  const w = (2 * Math.PI * freqHz) / rate
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin(w * i)
  return out
}

/** RMS over the steady middle, skipping `guard` samples of filter transient at each end. */
function rms(x: Float32Array, guard = 0): number {
  let s = 0
  let n = 0
  for (let i = guard; i < x.length - guard; i++) {
    s += x[i] * x[i]
    n++
  }
  return Math.sqrt(s / Math.max(1, n))
}

const RATE_PAIRS = [
  [48000, 44100],
  [48000, 22050],
  [48000, 16000],
  [44100, 16000],
  [44100, 22050],
] as const

/** Expected taps-per-output for each pair with the defaults (rolloff 0.84,
 * 80 dB). halfLen scales with the decimation ratio — see resample.ts. */
const EXPECTED_HALFLEN: Record<string, number> = {
  '48000>44100': 35,
  '48000>22050': 69,
  '48000>16000': 95,
  '44100>16000': 87,
  '44100>22050': 64,
}

describe('resampleDesign', () => {
  it('reduces every real capture/target pair to a small L/M with L <= 160', () => {
    expect(resampleDesign(48000, 44100)).toMatchObject({ L: 147, M: 160 })
    expect(resampleDesign(48000, 22050)).toMatchObject({ L: 147, M: 320 })
    expect(resampleDesign(48000, 16000)).toMatchObject({ L: 1, M: 3 })
    expect(resampleDesign(44100, 16000)).toMatchObject({ L: 160, M: 441 })
    expect(resampleDesign(44100, 22050)).toMatchObject({ L: 1, M: 2 })
  })

  it('scales halfLen with the decimation ratio (NOT a fixed 32)', () => {
    for (const [from, to] of RATE_PAIRS) {
      const d = resampleDesign(from, to)
      const want = EXPECTED_HALFLEN[`${from}>${to}`]
      expect(d.halfLen).toBe(want)
      expect(d.tapsPerOutput).toBe(2 * want + 1)
    }
    // The 3:1 decimators must carry roughly 3x the taps of the near-unity one,
    // or their physical FIR cannot hold an 80 dB stopband.
    expect(resampleDesign(48000, 16000).halfLen).toBeGreaterThan(
      2.4 * resampleDesign(48000, 44100).halfLen,
    )
  })

  it('kaiserBeta matches the Oppenheim & Schafer formula at 80 dB', () => {
    expect(kaiserBeta(80)).toBeCloseTo(0.1102 * (80 - 8.7), 6)
  })
})

describe('resample — passband fidelity (test a)', () => {
  it('passes a mid-band tone with < 0.5 dB error and no image', () => {
    for (const [from, to] of RATE_PAIRS) {
      const f = 1000 // well inside every target passband
      const src = tone(f, from, 0.5)
      const dst = resample(src, from, to)

      // length ~= ceil(n * to/from)  (test d)
      expect(Math.abs(dst.length - Math.ceil((src.length * to) / from))).toBeLessThanOrEqual(1)

      const guard = 128
      const errDb = 20 * Math.log10(rms(dst, guard) / rms(src, guard))
      expect(Math.abs(errDb)).toBeLessThan(0.5)

      // No spurious image: fit a clean sinusoid at f and check the residual.
      const ref = tone(f, to, dst.length / to)
      const qc = new Float32Array(ref.length)
      const w = (2 * Math.PI * f) / to
      for (let i = 0; i < qc.length; i++) qc[i] = Math.cos(w * i)
      let den = 0
      for (let i = guard; i < dst.length - guard; i++) den += ref[i] * ref[i]
      let a = 0
      let b = 0
      for (let i = guard; i < dst.length - guard; i++) {
        a += dst[i] * ref[i]
        b += dst[i] * qc[i]
      }
      a /= den
      b /= den
      let resid = 0
      let num = 0
      for (let i = guard; i < dst.length - guard; i++) {
        const fit = a * ref[i] + b * qc[i]
        const d = dst[i] - fit
        resid += d * d
        num++
      }
      const residRms = Math.sqrt(resid / num)
      const thdDb = 20 * Math.log10(residRms / (Math.hypot(a, b) || 1e-9))
      expect(thdDb).toBeLessThan(-60)
    }
  })

  it('holds the passband flat up to ~0.8 * min-Nyquist', () => {
    for (const [from, to] of RATE_PAIRS) {
      const edge = 0.8 * (Math.min(from, to) / 2)
      const src = tone(edge, from, 0.4)
      const dst = resample(src, from, to)
      const errDb = 20 * Math.log10(rms(dst, 160) / rms(src, 160))
      // Kaiser passband ripple for 80 dB is ~1e-4 dB; allow generous slack for
      // the tone sitting a little into the transition knee.
      expect(errDb).toBeGreaterThan(-1.5)
      expect(errDb).toBeLessThan(0.2)
    }
  })
})

describe('resample — stopband rejection (test b)', () => {
  // The design cutoff sits between rolloff*minNyq and minNyq. A tone anywhere
  // above the target Nyquist folds back into the analysed band if not filtered.
  // Probe the WORST case first: just above the target Nyquist, where the
  // earlier fixed-halfLen-32 revision leaked ~30-45 dB on the 3:1 decimators.
  it('rejects a tone just above the target Nyquist by > 70 dB', () => {
    for (const [from, to] of RATE_PAIRS) {
      const targetNyq = to / 2
      for (const mult of [1.03, 1.1, 1.25]) {
        const fAbove = targetNyq * mult
        if (fAbove >= from / 2) continue // must stay below the source Nyquist
        const src = tone(fAbove, from, 0.4)
        const rej = 20 * Math.log10(rms(resample(src, from, to), 128) / rms(src, 128))
        expect(rej).toBeLessThan(-70)
      }
    }
  })

  it('beats linear interpolation by > 30 dB in the fold region', () => {
    for (const [from, to] of RATE_PAIRS) {
      const targetNyq = to / 2
      const fAbove = Math.min(from / 2 - 500, targetNyq * 1.28)
      const src = tone(fAbove, from, 0.4)
      const inRms = rms(src, 96)
      const sincDb = 20 * Math.log10(rms(resample(src, from, to), 96) / inRms)
      const linDb = 20 * Math.log10(rms(linear(src, from, to), 96) / inRms)
      expect(sincDb).toBeLessThan(-70)
      expect(linDb).toBeGreaterThan(sincDb + 30)
    }
  })
})

describe('resample — DC & full-scale, no clip (test c)', () => {
  it('reproduces DC with no gain error in the interior', () => {
    for (const [from, to] of RATE_PAIRS) {
      const src = new Float32Array(Math.round(from * 0.15)).fill(1)
      const dst = resample(src, from, to)
      const guard = 128
      for (let i = guard; i < dst.length - guard; i++) {
        expect(dst[i]).toBeGreaterThan(1 - 1e-4)
        expect(dst[i]).toBeLessThan(1 + 1e-4)
      }
    }
  })

  it('never overshoots on a full-scale tone (no clipping)', () => {
    for (const [from, to] of RATE_PAIRS) {
      const src = tone(900, from, 0.4, 1.0)
      const dst = resample(src, from, to)
      let peak = 0
      for (let i = 0; i < dst.length; i++) peak = Math.max(peak, Math.abs(dst[i]))
      // A few hundredths of a dB of Gibbs overshoot is tolerable; a hard clip is not.
      expect(peak).toBeLessThan(1.02)
    }
  })

  it('handles a DC + full-scale mix without exploding', () => {
    const src = new Float32Array(48000)
    for (let i = 0; i < src.length; i++)
      src[i] = 0.5 + 0.5 * Math.sin((2 * Math.PI * 300 * i) / 48000)
    const dst = resample(src, 48000, 44100)
    let peak = 0
    for (let i = 0; i < dst.length; i++) peak = Math.max(peak, Math.abs(dst[i]))
    expect(peak).toBeLessThan(1.05)
    expect(peak).toBeGreaterThan(0.9)
  })
})

describe('resample — every polyphase branch is a full-length sub-filter', () => {
  // Regression for the earlier bug where phases 1..L-1 read one prototype tap
  // out of the zero-pad region, so 146 of 147 sub-filters were a slightly wrong
  // shape. Fit ONE clean sinusoid over the whole steady region and bound the
  // WORST single-sample residual: a per-phase shape error shows up as a
  // fixed-pattern (period-L in the output index) deviation that RMS averages
  // away but a max-residual catches.
  it('per-sample residual against a single fitted sinusoid stays < 0.3%', () => {
    for (const [from, to] of [
      [48000, 44100],
      [48000, 16000],
    ] as const) {
      const f = 1234 // dense in phase, well inside every passband
      const src = tone(f, from, 0.6)
      const dst = resample(src, from, to)
      const g = 256
      const w = (2 * Math.PI * f) / to
      let snn = 0
      let sn = 0
      let sc = 0
      for (let i = g; i < dst.length - g; i++) {
        const s = Math.sin(w * i)
        const c = Math.cos(w * i)
        snn += s * s
        sn += dst[i] * s
        sc += dst[i] * c
      }
      const a = sn / snn
      const b = sc / snn
      const amp = Math.hypot(a, b)
      let worst = 0
      for (let i = g; i < dst.length - g; i++) {
        const fit = a * Math.sin(w * i) + b * Math.cos(w * i)
        worst = Math.max(worst, Math.abs(dst[i] - fit))
      }
      expect(Math.abs(amp - 1)).toBeLessThan(0.01)
      expect(worst).toBeLessThan(0.003) // the dropped-tap bug gave ~0.02-0.05
    }
  })
})

describe('resample — output length (test d) & identity', () => {
  it('length == ceil(n * to/from) for assorted lengths', () => {
    for (const [from, to] of RATE_PAIRS) {
      for (const n of [0, 1, 1000, 48000, 200000]) {
        const dst = resample(new Float32Array(n), from, to)
        if (n === 0) {
          expect(dst.length).toBe(0)
        } else {
          expect(dst.length).toBe(Math.ceil((n * to) / from))
        }
      }
    }
  })

  it('returns the input untouched when the rates match', () => {
    const src = tone(440, 44100, 0.1)
    expect(resample(src, 44100, 44100)).toBe(src)
  })
})

describe('resample — the two headline conversions', () => {
  it('48000 -> 44100 (rhythm / key front-end)', () => {
    const src = tone(2000, 48000, 0.6)
    const dst = resample(src, 48000, 44100)
    expect(dst.length).toBe(Math.ceil((src.length * 44100) / 48000))
    const errDb = 20 * Math.log10(rms(dst, 96) / rms(src, 96))
    expect(Math.abs(errDb)).toBeLessThan(0.3)
  })

  it('48000 -> 16000 (MusiCNN mel front-end) kills 8.5 kHz, keeps 6 kHz', () => {
    const keep = resample(tone(6000, 48000, 0.5), 48000, 16000)
    const keepDb = 20 * Math.log10(rms(keep, 128) / rms(tone(6000, 48000, 0.5), 128))
    expect(Math.abs(keepDb)).toBeLessThan(1.0)

    // 8.5 kHz is 500 Hz above the 8 kHz target Nyquist — must be gone.
    const gone = resample(tone(8500, 48000, 0.5), 48000, 16000)
    const goneDb = 20 * Math.log10(rms(gone, 128) / rms(tone(8500, 48000, 0.5), 128))
    expect(goneDb).toBeLessThan(-70)
  })
})
