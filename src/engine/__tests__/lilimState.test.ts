import { describe, expect, it } from 'vitest'
import { createEmptyFeatures } from '../../audio/types'
import { createLilimState, updateLilimState } from '../lilimState'
import type { SceneFrame } from '../sceneFrame'

/**
 * A minimal SceneFrame. The adapter only reads `f`, `b`, `dt` and
 * `params.reactivity`, so the rest is deliberately absent — filling it in would
 * just be a second copy of the engine's own defaults, drifting.
 */
function frame(over: {
  b?: Partial<SceneFrame['b']>
  f?: Partial<ReturnType<typeof createEmptyFeatures>>
  dt?: number
  reactivity?: number
}): SceneFrame {
  const bands: SceneFrame['b'] = {
    sub: 0,
    bass: 0,
    mid: 0,
    presence: 0,
    high: 0,
    vocal: 0,
    voice: 0,
    air: 0,
    energy: 0,
    transient: 0,
    pulse: 0,
    kick: 0,
    snare: 0,
    hihat: 0,
    ...over.b,
  }
  const features = { ...createEmptyFeatures(), ...over.f }
  return {
    f: features,
    b: bands,
    dt: over.dt ?? 1 / 60,
    params: { intensity: 1, speed: 1, reactivity: over.reactivity ?? 1 },
  } as unknown as SceneFrame
}

describe('band mapping', () => {
  it('passes the already-normalised bands straight through', () => {
    const s = createLilimState()
    updateLilimState(s, frame({ b: { sub: 0.7, high: 0.4, air: 0.2, energy: 0.55, kick: 0.9 } }))
    expect(s.sub).toBe(0.7)
    expect(s.highs).toBe(0.4)
    expect(s.air).toBe(0.2)
    expect(s.energy).toBe(0.55)
    expect(s.kick).toBe(0.9)
  })

  it('averages mid and presence into mids', () => {
    // lilim's `mids` spanned roughly 240 Hz-1.9 kHz, which this engine splits
    // across two named bands. Taking `mid` alone loses the upper half of the
    // range the shaders were tuned against.
    const s = createLilimState()
    updateLilimState(s, frame({ b: { mid: 0.8, presence: 0.2 } }))
    expect(s.mids).toBeCloseTo(0.5, 10)
  })

  it('takes loud from programme RMS, not from a normalised band', () => {
    // `loud` exists to make quiet sections read quiet. A rolling-peak-normalised
    // band cannot do that — it renormalises the quiet section back up to 1.
    const s = createLilimState()
    updateLilimState(s, frame({ f: { rms: 0.12 }, b: { energy: 0.9 } }))
    expect(s.loud).toBe(0.12)
  })

  it('leaves loud unscaled by reactivity', () => {
    // lilim exempted it on the grounds that it is measurement, not reaction.
    const s = createLilimState()
    updateLilimState(s, frame({ f: { rms: 0.3 }, reactivity: 2 }))
    expect(s.loud).toBe(0.3)
  })
})

describe('onset mapping', () => {
  const hit = (trigger: boolean, strength: number) => ({
    percussion: {
      kick: { trigger, env: 0.5, strength, count: 1 },
      snare: { trigger, env: 0.5, strength, count: 1 },
      hihat: { trigger, env: 0.5, strength, count: 1 },
    },
  })

  it('is zero on a frame with no hit', () => {
    const s = createLilimState()
    updateLilimState(s, frame({ f: hit(false, 0.8) }))
    expect(s.onKick).toBe(0)
    expect(s.onMid).toBe(0)
    expect(s.onHigh).toBe(0)
  })

  it('reports the hit strength on the frame it fires', () => {
    const s = createLilimState()
    updateLilimState(s, frame({ f: hit(true, 0.8) }))
    expect(s.onKick).toBeCloseTo(0.8, 10)
    expect(s.onMid).toBeCloseTo(0.8, 10)
    expect(s.onHigh).toBeCloseTo(0.8, 10)
  })

  it('scales an onset by reactivity, matching lilim REACT', () => {
    const s = createLilimState()
    updateLilimState(s, frame({ f: hit(true, 0.4), reactivity: 2 }))
    expect(s.onKick).toBeCloseTo(0.8, 10)
  })

  it('keeps kick level and kick onset independent', () => {
    // `kick` is a ~140 ms punch envelope; `onKick` is a single-frame impulse.
    // A scene that treated them as the same signal would either flash for a
    // seventh of a second or convulse for one frame.
    const s = createLilimState()
    updateLilimState(s, frame({ b: { kick: 0.6 }, f: hit(false, 1) }))
    expect(s.kick).toBe(0.6)
    expect(s.onKick).toBe(0)
  })
})

describe('specHi resampler', () => {
  /** Fill f.spectrum with a linear magnitude ramp, as the FFT would. */
  const withSpectrum = (fill: (i: number) => number) => {
    const f = createEmptyFeatures()
    for (let i = 0; i < f.spectrum.length; i++) f.spectrum[i] = fill(i)
    return f
  }

  it('produces 192 bins', () => {
    expect(createLilimState().specHi).toHaveLength(192)
  })

  it('stays in 0..1 for every bin', () => {
    const s = createLilimState()
    updateLilimState(s, frame({ f: withSpectrum((i) => 0.5 + 0.5 * Math.sin(i)) }))
    for (let i = 0; i < s.specHi.length; i++) {
      expect(s.specHi[i], `bin ${i}`).toBeGreaterThanOrEqual(0)
      expect(s.specHi[i], `bin ${i}`).toBeLessThanOrEqual(1)
    }
  })

  it('leaves no bin permanently empty from an out-of-range source span', () => {
    // The bottom of a 192-bin log range is narrower than one 21.5 Hz FFT bin,
    // and the top must not index past f.spectrum's 1024 entries. Either mistake
    // shows up as a bin that is always exactly zero against a flat input.
    const s = createLilimState()
    updateLilimState(s, frame({ f: withSpectrum(() => 1) }))
    for (let i = 0; i < s.specHi.length; i++) {
      expect(s.specHi[i], `bin ${i} never received a source sample`).toBeGreaterThan(0)
    }
  })

  it('reads 1 at the frame peak and 0 at 48 dB below it', () => {
    const s = createLilimState()
    // Two plateaus 48 dB apart, wide enough that no output bin straddles them.
    const quiet = Math.pow(10, -48 / 20)
    updateLilimState(s, frame({ f: withSpectrum((i) => (i < 128 ? 1 : quiet)) }))
    expect(Math.max(...s.specHi)).toBeCloseTo(1, 5)
    expect(Math.min(...s.specHi)).toBeCloseTo(0, 5)
  })

  it('preserves spectral tilt rather than flattening every frame', () => {
    // A shared reference peak is the point: normalising per bin would map any
    // input, including a single tone, onto the same full-scale silhouette.
    const s = createLilimState()
    updateLilimState(s, frame({ f: withSpectrum((i) => Math.exp(-i / 60)) }))
    expect(s.specHi[10]).toBeGreaterThan(s.specHi[150])
  })

  it('decays its reference peak so a loud passage does not deafen a quiet one', () => {
    const s = createLilimState()
    updateLilimState(s, frame({ f: withSpectrum(() => 1) }))
    const loudPeak = s.specPeak
    // 60 s of near-silence at 1 s steps.
    for (let i = 0; i < 60; i++) {
      updateLilimState(s, frame({ f: withSpectrum(() => 1e-5), dt: 1 }))
    }
    expect(s.specPeak).toBeLessThan(loudPeak)
  })

  it('never divides by zero on a silent spectrum', () => {
    const s = createLilimState()
    for (let i = 0; i < 10; i++) updateLilimState(s, frame({ f: withSpectrum(() => 0), dt: 1 }))
    expect(s.specPeak).toBeGreaterThan(0)
    for (const v of s.specHi) expect(Number.isFinite(v)).toBe(true)
  })

  it('keeps a separate reference peak per instance', () => {
    // Two scenes can be mounted at once. A shared module-level peak would decay
    // once per instance per frame instead of once per frame, dragging the
    // reference down and washing the spectrum out whenever more than one scene
    // was on screen.
    const a = createLilimState()
    const b = createLilimState()
    updateLilimState(a, frame({ f: withSpectrum(() => 1) }))
    expect(b.specPeak).not.toBe(a.specPeak)
  })
})

describe('allocation discipline', () => {
  it('reuses the specHi buffer across frames', () => {
    // The render loop must not allocate. A fresh Float32Array every frame per
    // scene is exactly the GC pressure this codebase has already fixed once.
    const s = createLilimState()
    const buffer = s.specHi
    for (let i = 0; i < 5; i++) updateLilimState(s, frame({}))
    expect(s.specHi).toBe(buffer)
  })
})
