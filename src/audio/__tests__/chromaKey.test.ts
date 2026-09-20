import { describe, expect, it } from 'vitest'
import { frequencyDataDb } from '../../../scripts/calibrate/fft'
import { ChromaKeyEstimator, PITCH_CLASS_NAMES } from '../chromaKey'

/**
 * Synthetic-spectrum tests. Every spectrum here is a REAL 8192-point Blackman
 * FFT of synthesised audio (the same maths the browser's AnalyserNode applies,
 * via the calibration harness's `frequencyDataDb`), so window leakage, peak
 * shapes and partial interference are realistic. What these tests do NOT prove:
 * that real recordings are recognised. Real music has vocals, drums, reverb,
 * inharmonic partials and key changes; see the module header's honest limits.
 */

const FFT = 8192 // AudioEngine's LOW_FFT_SIZE analyser
const SR = 44100
const DT = 0.05

// Deterministic PRNG (mulberry32) so the suite is not flaky.
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const midiHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12)

interface Tone {
  hz: number
  amp: number
}

/** Add `tones` (each with `harmonics` partials at 1/h amplitude) into `frame`. */
function addTones(frame: Float32Array, tones: Tone[], sr: number, seed: number, harmonics = 6) {
  const r = rng(seed)
  const twoPi = 2 * Math.PI
  for (const t of tones) {
    for (let h = 1; h <= harmonics; h++) {
      const f = t.hz * h
      if (f > sr * 0.45) break
      const amp = t.amp / h
      const ph = r() * twoPi
      const w = (twoPi * f) / sr
      for (let i = 0; i < frame.length; i++) frame[i] += amp * Math.sin(w * i + ph)
    }
  }
}

function addNoise(
  frame: Float32Array,
  level: number,
  r: () => number,
  from = 0,
  to = frame.length,
) {
  for (let i = from; i < to; i++) frame[i] += level * (r() * 2 - 1)
}

function spectrumOf(frame: Float32Array): Float32Array {
  const out = new Float32Array(FFT / 2)
  frequencyDataDb(frame, FFT, out)
  return out
}

type Quality = 'M' | 'm'

/** Chord tones (triad) with a bass root two octaves down, as most real mixes have. */
function chordTones(rootPc: number, q: Quality, detuneCents = 0): Tone[] {
  const k = Math.pow(2, detuneCents / 1200)
  const root = 60 + rootPc
  const third = root + (q === 'M' ? 4 : 3)
  const fifth = root + 7
  const bass = 40 + ((((rootPc - 4) % 12) + 12) % 12) // E2..D#3
  return [
    { hz: midiHz(root) * k, amp: 0.1 },
    { hz: midiHz(third) * k, amp: 0.1 },
    { hz: midiHz(fifth) * k, amp: 0.1 },
    { hz: midiHz(bass) * k, amp: 0.16 },
  ]
}

/** Spectra for a four-chord loop. `mode` picks I–IV–V–I or i–iv–V–i (or natural minor). */
function progression(
  tonic: number,
  mode: 'major' | 'minor' | 'natural-minor',
  sr = SR,
  detuneCents = 0,
): Float32Array[] {
  const chords: Array<[number, Quality]> =
    mode === 'major'
      ? [
          [tonic, 'M'],
          [tonic + 5, 'M'],
          [tonic + 7, 'M'],
          [tonic, 'M'],
        ]
      : mode === 'minor'
        ? [
            [tonic, 'm'],
            [tonic + 5, 'm'],
            [tonic + 7, 'M'],
            [tonic, 'm'],
          ]
        : [
            [tonic, 'm'],
            [tonic + 8, 'M'], // VI
            [tonic + 10, 'M'], // VII
            [tonic, 'm'],
          ]
  return chords.map(([root, q], idx) => {
    const frame = new Float32Array(FFT)
    addTones(frame, chordTones(((root % 12) + 12) % 12, q, detuneCents), sr, 100 + idx)
    return spectrumOf(frame)
  })
}

/** Feed `seconds` of a chord loop (one chord per second) to a fresh estimator. */
function runLoop(spectra: Float32Array[], seconds = 24, sr = SR, chordSec = 1) {
  const est = new ChromaKeyEstimator()
  const steps = Math.round(seconds / DT)
  for (let i = 0; i < steps; i++) {
    const idx = Math.floor((i * DT) / chordSec) % spectra.length
    est.update(spectra[idx], sr, DT)
  }
  return est
}

const nameToPc = (n: string) => PITCH_CLASS_NAMES.indexOf(n as (typeof PITCH_CLASS_NAMES)[number])

describe('ChromaKeyEstimator', () => {
  it('reads a C major I-IV-V-I loop as C major with positive modeStrength', () => {
    const r = runLoop(progression(0, 'major')).read()
    expect(r.valid).toBe(true)
    expect(r.tonic).toBe('C')
    expect(r.scale).toBe('major')
    expect(r.modeStrength).toBeGreaterThan(0.2)
    expect(r.keyConfidence).toBeGreaterThan(0.2)
    expect(r.chroma.length).toBe(12)
    expect(Math.max(...r.chroma)).toBeCloseTo(1, 5)
  })

  it('reads A minor as A minor (not its relative C major) with negative modeStrength', () => {
    const r = runLoop(progression(9, 'minor')).read()
    expect(r.valid).toBe(true)
    expect(r.tonic).toBe('A')
    expect(r.scale).toBe('minor')
    expect(r.modeStrength).toBeLessThan(-0.2)
  })

  it('separates relative keys on all-diatonic natural-minor material (Am-F-G-Am is A minor, not C major)', () => {
    const r = runLoop(progression(9, 'natural-minor')).read()
    expect(r.tonic).toBe('A')
    expect(r.scale).toBe('minor')
  })

  it('recovers all 12 tonics in major and minor (>= 21 of 24, tonic + mode)', () => {
    let hits = 0
    const misses: string[] = []
    for (let t = 0; t < 12; t++) {
      for (const mode of ['major', 'minor'] as const) {
        const r = runLoop(progression(t, mode)).read()
        if (r.tonic === PITCH_CLASS_NAMES[t] && r.scale === mode) hits++
        else misses.push(`${PITCH_CLASS_NAMES[t]} ${mode} -> ${r.tonic} ${r.scale}`)
      }
    }
    console.info(`[chromaKey] 24-key recovery (I-IV-V-I / i-iv-V-i): ${hits}/24`, misses)
    expect(hits).toBeGreaterThanOrEqual(21)
  })

  it('still recovers most of the 24 keys with a noise floor, drum bursts and 20-cent detune (>= 19 of 24)', () => {
    // Harder variant of the recovery test: every frame carries broadband noise
    // (~ -6 dB re the chord) and half of them a loud decaying burst; the whole
    // mix is 20 cents sharp. Still synthetic — a stress test, not a real-music claim.
    let hits = 0
    const misses: string[] = []
    for (let t = 0; t < 12; t++) {
      for (const mode of ['major', 'minor'] as const) {
        const rn = rng(1000 + t * 2 + (mode === 'major' ? 0 : 1))
        const chords: Array<[number, Quality]> =
          mode === 'major'
            ? [
                [t, 'M'],
                [t + 5, 'M'],
                [t + 7, 'M'],
                [t, 'M'],
              ]
            : [
                [t, 'm'],
                [t + 5, 'm'],
                [t + 7, 'M'],
                [t, 'm'],
              ]
        const variants: Float32Array[][] = chords.map(([root, q], ci) => {
          const out: Float32Array[] = []
          for (let v = 0; v < 4; v++) {
            const frame = new Float32Array(FFT)
            addTones(frame, chordTones(root % 12, q, 20), SR, 500 + ci)
            addNoise(frame, 0.12, rn)
            if (v % 2 === 1) {
              const start = Math.floor(rn() * (FFT - 2000))
              for (let i = 0; i < 1800; i++)
                frame[start + i] += 1.0 * Math.exp(-i / 300) * (rn() * 2 - 1)
            }
            out.push(spectrumOf(frame))
          }
          return out
        })
        const est = new ChromaKeyEstimator()
        for (let i = 0; i < 480; i++) est.update(variants[Math.floor(i * DT) % 4][i % 4], SR, DT)
        const r = est.read()
        if (r.tonic === PITCH_CLASS_NAMES[t] && r.scale === mode) hits++
        else misses.push(`${PITCH_CLASS_NAMES[t]} ${mode} -> ${r.tonic} ${r.scale}`)
      }
    }
    console.info(`[chromaKey] 24-key recovery under noise + drums + detune: ${hits}/24`, misses)
    expect(hits).toBeGreaterThanOrEqual(19)
  })

  it('keeps a modal minor loop (i-VI-III-VII) inside its tonic/relative-major pair', () => {
    // Cm-Ab-Eb-Bb is all diatonic to Eb major and only 1 chord in 4 is the tonic
    // chord, so "Eb major" is a defensible answer; the failure that matters is a
    // read OUTSIDE the pair. Documents the relative-key ambiguity honestly.
    for (const t of [0, 4, 9]) {
      const chords: Array<[number, Quality]> = [
        [t, 'm'],
        [t + 8, 'M'],
        [t + 3, 'M'],
        [t + 10, 'M'],
      ]
      const spectra = chords.map(([root, q], ci) => {
        const frame = new Float32Array(FFT)
        addTones(frame, chordTones(root % 12, q), SR, 300 + ci)
        return spectrumOf(frame)
      })
      const r = runLoop(spectra).read()
      const minorPc = t
      const majorPc = (t + 3) % 12
      const ok =
        (r.scale === 'minor' && nameToPc(r.tonic) === minorPc) ||
        (r.scale === 'major' && nameToPc(r.tonic) === majorPc)
      expect(ok, `${PITCH_CLASS_NAMES[t]} minor loop read as ${r.tonic} ${r.scale}`).toBe(true)
    }
  })

  it('reports no confident key for a flat chromatic cluster (all 12 pitch classes equal)', () => {
    const frame = new Float32Array(FFT)
    const tones: Tone[] = []
    for (let pc = 0; pc < 12; pc++) tones.push({ hz: midiHz(60 + pc), amp: 0.06 })
    addTones(frame, tones, SR, 9, 3)
    const spec = spectrumOf(frame)
    const est = new ChromaKeyEstimator()
    for (let i = 0; i < 400; i++) est.update(spec, SR, DT)
    const r = est.read()
    expect(!r.valid || r.keyConfidence < 0.3).toBe(true)
  })

  it('is transposition-invariant: every major tonic gets the same mode read', () => {
    const base = runLoop(progression(0, 'major')).read()
    const baseMs = base.modeStrength
    for (let t = 1; t < 12; t++) {
      const r = runLoop(progression(t, 'major')).read()
      expect(r.scale).toBe('major')
      expect(nameToPc(r.tonic)).toBe(t)
      expect(Math.abs(r.modeStrength - baseMs)).toBeLessThan(0.35)
    }
  })

  it('recovers the key when everything is detuned by 30 cents (sharp and flat)', () => {
    for (const cents of [30, -30]) {
      for (const [t, mode] of [
        [0, 'major'],
        [9, 'minor'],
        [6, 'major'],
        [2, 'minor'],
      ] as const) {
        const r = runLoop(progression(t, mode, SR, cents)).read()
        expect(`${r.tonic} ${r.scale}`, `${cents} cents`).toBe(`${PITCH_CLASS_NAMES[t]} ${mode}`)
      }
    }
  })

  it('works at 48 kHz too', () => {
    const r = runLoop(progression(7, 'major', 48000), 24, 48000).read()
    expect(`${r.tonic} ${r.scale}`).toBe('G major')
  })

  it('is not valid for silence (digital zero and -Infinity dB)', () => {
    const est = new ChromaKeyEstimator()
    const silent = new Float32Array(FFT / 2).fill(-Infinity)
    const floor = new Float32Array(FFT / 2).fill(-100)
    for (let i = 0; i < 600; i++) est.update(i % 2 ? silent : floor, SR, DT)
    const r = est.read()
    expect(r.valid).toBe(false)
    expect(r.tonic).toBe('')
    expect(r.scale).toBe('')
    expect(r.modeStrength).toBe(0)
    expect(r.keyConfidence).toBe(0)
    for (const v of r.chroma) expect(Number.isFinite(v)).toBe(true)
  })

  it('is not valid for white noise, however long it plays', () => {
    const r0 = rng(7)
    const frames: Float32Array[] = []
    for (let k = 0; k < 12; k++) {
      const f = new Float32Array(FFT)
      addNoise(f, 0.3, r0)
      frames.push(spectrumOf(f))
    }
    const est = new ChromaKeyEstimator()
    for (let i = 0; i < 1200; i++) est.update(frames[i % frames.length], SR, DT) // 60 s
    const r = est.read()
    expect(r.valid).toBe(false)
    expect(r.tonic).toBe('')
    expect(r.keyConfidence).toBe(0)
  })

  it('stays valid-gated during warm-up: not valid before ~6 s of tonal audio, valid after', () => {
    const spectra = progression(0, 'major')
    const est = new ChromaKeyEstimator()
    let validAt = -1
    for (let i = 0; i < 400; i++) {
      est.update(spectra[Math.floor((i * DT) / 1) % 4], SR, DT)
      if (validAt < 0 && est.read().valid) validAt = i * DT
    }
    expect(validAt).toBeGreaterThan(4)
    expect(validAt).toBeLessThan(12)
  })

  it('survives percussion-like broadband bursts layered on a tonal signal', () => {
    for (const [t, mode] of [
      [0, 'major'],
      [9, 'minor'],
      [4, 'major'],
    ] as const) {
      const rn = rng(42 + t)
      const chords: Array<[number, Quality]> =
        mode === 'major'
          ? [
              [t, 'M'],
              [t + 5, 'M'],
              [t + 7, 'M'],
              [t, 'M'],
            ]
          : [
              [t, 'm'],
              [t + 5, 'm'],
              [t + 7, 'M'],
              [t, 'm'],
            ]
      // For each chord, 6 frame variants: half carry a loud noise burst (kick/snare/hat-like
      // broadband transient with a fast decay) starting at a random offset.
      const spectra: Float32Array[][] = chords.map(([root, q], ci) => {
        const variants: Float32Array[] = []
        for (let v = 0; v < 6; v++) {
          const frame = new Float32Array(FFT)
          addTones(frame, chordTones(((root % 12) + 12) % 12, q), SR, 200 + ci)
          if (v % 2 === 1) {
            const start = Math.floor(rn() * (FFT - 2000))
            for (let i = 0; i < 1800; i++) {
              const env = Math.exp(-i / 350)
              frame[start + i] += 1.2 * env * (rn() * 2 - 1)
            }
          }
          variants.push(spectrumOf(frame))
        }
        return variants
      })
      const est = new ChromaKeyEstimator()
      for (let i = 0; i < 480; i++) {
        const chord = Math.floor((i * DT) / 1) % 4
        est.update(spectra[chord][i % 6], SR, DT)
      }
      const r = est.read()
      expect(`${r.tonic} ${r.scale}`).toBe(`${PITCH_CLASS_NAMES[t]} ${mode}`)
    }
  })

  it('tracks a key change after enough time, and soften() speeds it up', () => {
    const a = progression(0, 'major')
    const b = progression(7, 'major')
    const est = new ChromaKeyEstimator()
    for (let i = 0; i < 400; i++) est.update(a[Math.floor(i * DT) % 4], SR, DT)
    expect(est.read().tonic).toBe('C')
    est.soften(0.1)
    for (let i = 0; i < 160; i++) est.update(b[Math.floor(i * DT) % 4], SR, DT) // 8 s
    const r = est.read()
    expect(`${r.tonic} ${r.scale}`).toBe('G major')
  })

  it('reset() clears the estimate and the read object is reused', () => {
    const est = runLoop(progression(0, 'major'))
    const first = est.read()
    expect(first.valid).toBe(true)
    const chromaRef = first.chroma
    est.reset()
    const r = est.read()
    expect(r).toBe(first)
    expect(r.chroma).toBe(chromaRef)
    expect(r.valid).toBe(false)
    expect(r.tonic).toBe('')
    expect(Math.max(...r.chroma)).toBe(0)
  })

  it('accepts linear magnitudes and reaches the same key as dB input', () => {
    const spectra = progression(2, 'minor')
    const lin = spectra.map((s) => {
      const o = new Float32Array(s.length)
      for (let i = 0; i < s.length; i++) o[i] = Math.pow(10, s[i] / 20)
      return o
    })
    const est = new ChromaKeyEstimator({ input: 'linear' })
    for (let i = 0; i < 480; i++) est.update(lin[Math.floor(i * DT) % 4], SR, DT)
    const r = est.read()
    expect(`${r.tonic} ${r.scale}`).toBe('D minor')
  })

  it('does not throw or emit NaN on the coarse 2048-point spectrum (degraded accuracy expected)', () => {
    const frame = new Float32Array(2048)
    addTones(frame, chordTones(0, 'M'), SR, 5)
    const out = new Float32Array(1024)
    frequencyDataDb(frame, 2048, out)
    const est = new ChromaKeyEstimator()
    for (let i = 0; i < 400; i++) est.update(out, SR, DT)
    const r = est.read()
    for (const v of r.chroma) expect(Number.isFinite(v)).toBe(true)
    expect(Number.isFinite(r.modeStrength)).toBe(true)
  })

  it('costs well under a frame budget per update (micro-benchmark, generous bound)', () => {
    const spectra = progression(0, 'major')
    const est = new ChromaKeyEstimator({ intervalSec: 0.005 }) // process every call
    for (let i = 0; i < 50; i++) est.update(spectra[i % 4], SR, DT) // warm the JIT
    const N = 400
    const t0 = performance.now()
    for (let i = 0; i < N; i++) {
      est.update(spectra[i % 4], SR, DT)
      est.read()
    }
    const perMs = (performance.now() - t0) / N
    console.info(`[chromaKey] update+read: ${perMs.toFixed(3)} ms per processed frame`)
    expect(perMs).toBeLessThan(2)
  })
})
