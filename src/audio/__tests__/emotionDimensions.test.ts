import { describe, expect, it } from 'vitest'
import {
  EMOTION_WARMUP_SEC,
  EmotionDimensionEstimator,
  quantileMap,
  type EmotionFeatureFrame,
} from '../emotionDimensions'
import type { EmotionCalibration } from '../emotionQuantiles'

/** Identity-shaped tables (value == percentile) so tests do not depend on the generated ones. */
const LINEAR = Array.from({ length: 21 }, (_, i) => i / 20)
const CAL: EmotionCalibration = {
  features: {
    loudness: LINEAR,
    centroid: LINEAR,
    flatness: LINEAR,
    rolloff: LINEAR,
    flux: LINEAR,
    energy: LINEAR,
    roughness: LINEAR,
    tonalness: LINEAR,
  },
  composites: { arousal: LINEAR, valence: LINEAR, tension: LINEAR },
  source: 'test',
}

function frame(over: Partial<EmotionFeatureFrame> = {}): EmotionFeatureFrame {
  return {
    loudness: 0.5,
    centroid: 0.5,
    spectralFlatness: 0.5,
    spectralRolloff: 0.5,
    flux: 0.5,
    energy: 0.5,
    keyValid: false,
    keyModeStrength: 0,
    harmonicTensionValid: false,
    harmonicRoughness: 0.5,
    harmonicDissonance: 0.5,
    harmonicTonalness: 0.5,
    confidence: 0,
    silence: false,
    ...over,
  }
}

function run(est: EmotionDimensionEstimator, f: EmotionFeatureFrame, seconds: number, dt = 1 / 60) {
  for (let t = 0; t < seconds; t += dt) est.update(f, dt)
  return est.read()
}

describe('quantileMap', () => {
  it('is the identity without knots and clamps to 0..1', () => {
    expect(quantileMap(0.3, undefined)).toBeCloseTo(0.3, 10)
    expect(quantileMap(2, undefined)).toBe(1)
    expect(quantileMap(-1, [])).toBe(0)
  })

  it('maps a value to its percentile by linear interpolation between knots', () => {
    const knots = [0, 10, 20, 100] // 4 knots => probabilities 0, 1/3, 2/3, 1
    expect(quantileMap(0, knots)).toBe(0)
    expect(quantileMap(10, knots)).toBeCloseTo(1 / 3, 10)
    expect(quantileMap(15, knots)).toBeCloseTo(0.5, 10)
    expect(quantileMap(100, knots)).toBe(1)
    expect(quantileMap(500, knots)).toBe(1)
    expect(quantileMap(-5, knots)).toBe(0)
  })

  it('handles flat knot runs (ties) without dividing by zero and never returns NaN', () => {
    const knots = [0, 0, 0, 1]
    for (const v of [-1, 0, 0.5, 1, 2]) expect(Number.isFinite(quantileMap(v, knots))).toBe(true)
    expect(quantileMap(Number.NaN, knots)).toBe(0.5)
    expect(quantileMap(Number.POSITIVE_INFINITY, knots)).toBe(0.5)
  })

  it('is monotone non-decreasing', () => {
    const knots = [0, 0.1, 0.1, 0.4, 0.9, 1]
    let prev = -1
    for (let v = -0.1; v <= 1.1; v += 0.01) {
      const q = quantileMap(v, knots)
      expect(q).toBeGreaterThanOrEqual(prev)
      prev = q
    }
  })
})

describe('EmotionDimensionEstimator', () => {
  it('is not valid until it has heard enough non-silent audio', () => {
    const est = new EmotionDimensionEstimator(CAL)
    expect(run(est, frame(), EMOTION_WARMUP_SEC - 1).valid).toBe(false)
    expect(run(est, frame(), 2).valid).toBe(true)
  })

  it('silence holds the last read and does not advance the warm-up', () => {
    const est = new EmotionDimensionEstimator(CAL)
    run(est, frame({ centroid: 0.9, loudness: 0.9, spectralFlatness: 0.9 }), 8)
    const before = est.read().arousal
    run(est, frame({ silence: true, centroid: 0, loudness: 0 }), 30)
    expect(est.read().arousal).toBe(before)
    expect(est.read().valid).toBe(true)

    const fresh = new EmotionDimensionEstimator(CAL)
    run(fresh, frame({ silence: true }), 30)
    expect(fresh.read().valid).toBe(false)
  })

  it('arousal rises with louder, brighter, noisier, busier input (and falls with the opposite)', () => {
    const calm = run(new EmotionDimensionEstimator(CAL), frame({ loudness: 0.1, centroid: 0.1, spectralFlatness: 0.1, spectralRolloff: 0.1, flux: 0.1, energy: 0.1 }), 20)
    const mid = run(new EmotionDimensionEstimator(CAL), frame(), 20)
    const hot = run(new EmotionDimensionEstimator(CAL), frame({ loudness: 0.9, centroid: 0.9, spectralFlatness: 0.9, spectralRolloff: 0.9, flux: 0.9, energy: 0.9 }), 20)
    expect(calm.arousal).toBeLessThan(mid.arousal)
    expect(mid.arousal).toBeLessThan(hot.arousal)
    expect(calm.arousal).toBeLessThan(0.2)
    expect(hot.arousal).toBeGreaterThan(0.8)
  })

  it('valence: major reads higher than minor, and stays neutral when the key is unknown', () => {
    const major = run(new EmotionDimensionEstimator(CAL), frame({ keyValid: true, keyModeStrength: 0.9 }), 30)
    const minor = run(new EmotionDimensionEstimator(CAL), frame({ keyValid: true, keyModeStrength: -0.9 }), 30)
    const unknown = run(new EmotionDimensionEstimator(CAL), frame(), 30)
    expect(major.valence).toBeGreaterThan(unknown.valence)
    expect(minor.valence).toBeLessThan(unknown.valence)
  })

  it('valence confidence grows once a key read is available', () => {
    const noKey = run(new EmotionDimensionEstimator(CAL), frame(), 30)
    const haveKey = run(new EmotionDimensionEstimator(CAL), frame({ keyValid: true, keyModeStrength: 0.5 }), 30)
    expect(noKey.valenceConfidence ?? 1).toBeLessThan(0.5)
    expect(haveKey.valenceConfidence ?? 0).toBeGreaterThan(0.9)
  })

  it('tension: dissonant, atonal, minor input reads higher than consonant, tonal, major input', () => {
    const tense = run(new EmotionDimensionEstimator(CAL), frame({ harmonicTensionValid: true, harmonicDissonance: 0.9, harmonicTonalness: 0.1, keyValid: true, keyModeStrength: -0.9 }), 30)
    const relaxed = run(new EmotionDimensionEstimator(CAL), frame({ harmonicTensionValid: true, harmonicDissonance: 0.1, harmonicTonalness: 0.9, keyValid: true, keyModeStrength: 0.9 }), 30)
    expect(tense.tension).toBeGreaterThan(relaxed.tension + 0.3)
  })

  it('tension ignores plain roughness (noise/distortion) when dissonance is unchanged', () => {
    const noisy = run(new EmotionDimensionEstimator(CAL), frame({ harmonicTensionValid: true, harmonicRoughness: 0.9, harmonicDissonance: 0.4, harmonicTonalness: 0.4 }), 30)
    const clean = run(new EmotionDimensionEstimator(CAL), frame({ harmonicTensionValid: true, harmonicRoughness: 0.1, harmonicDissonance: 0.4, harmonicTonalness: 0.4 }), 30)
    expect(noisy.tension).toBeCloseTo(clean.tension, 5)
  })

  it('pulse follows beat-lock confidence', () => {
    const locked = run(new EmotionDimensionEstimator(CAL), frame({ confidence: 0.9 }), 20)
    const free = run(new EmotionDimensionEstimator(CAL), frame({ confidence: 0.05 }), 20)
    expect(locked.pulse).toBeGreaterThan(0.8)
    expect(free.pulse).toBeLessThan(0.1)
  })

  it('character moves slowly: a one-second burst barely moves the read, a sustained change does', () => {
    const est = new EmotionDimensionEstimator(CAL)
    run(est, frame({ loudness: 0.1, centroid: 0.1, spectralFlatness: 0.1, spectralRolloff: 0.1, flux: 0.1, energy: 0.1 }), 20)
    const base = est.read().arousal
    run(est, frame({ loudness: 1, centroid: 1, spectralFlatness: 1, spectralRolloff: 1, flux: 1, energy: 1 }), 1)
    expect(est.read().arousal - base).toBeLessThan(0.25)
    run(est, frame({ loudness: 1, centroid: 1, spectralFlatness: 1, spectralRolloff: 1, flux: 1, energy: 1 }), 30)
    expect(est.read().arousal).toBeGreaterThan(0.9)
  })

  it('outputs stay finite and in 0..1 for garbage input, and read() returns the same object', () => {
    const est = new EmotionDimensionEstimator(CAL)
    const r = est.read()
    const junk = frame({ loudness: Number.NaN, centroid: Number.POSITIVE_INFINITY, spectralFlatness: -5, spectralRolloff: 9, flux: Number.NaN, energy: 1e9, confidence: Number.NaN, keyModeStrength: 7, keyValid: true })
    run(est, junk, 15)
    for (const k of ['valence', 'arousal', 'tension', 'pulse'] as const) {
      expect(Number.isFinite(r[k])).toBe(true)
      expect(r[k]).toBeGreaterThanOrEqual(0)
      expect(r[k]).toBeLessThanOrEqual(1)
    }
    expect(est.read()).toBe(r)
  })

  it('a non-positive dt is ignored and reset() restarts warm-up', () => {
    const est = new EmotionDimensionEstimator(CAL)
    est.update(frame(), 0)
    est.update(frame(), -1)
    expect(est.read().valid).toBe(false)
    run(est, frame(), 10)
    expect(est.read().valid).toBe(true)
    est.reset()
    expect(est.read().valid).toBe(false)
  })
})
