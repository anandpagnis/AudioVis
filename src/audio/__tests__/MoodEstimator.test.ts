import { describe, expect, it } from 'vitest'
import { MoodEstimator } from '../MoodEstimator'
import { createEmptyFeatures, type AudioFeatures, type MoodState } from '../types'

/** Drives the estimator for `seconds` at a fixed dt, applying `patch` each frame. */
function run(
  seconds: number,
  dt: number,
  patch: (f: AudioFeatures, now: number) => void,
): AudioFeatures {
  const me = new MoodEstimator()
  const f = createEmptyFeatures()
  let now = 0
  for (; now < seconds; now += dt) {
    f.time = now
    f.delta = dt
    patch(f, now)
    me.update(f)
  }
  return f
}

describe('MoodEstimator', () => {
  it('commits to silence once it holds past its hold time', () => {
    const f = run(2, 0.05, (f) => {
      f.silence = true
      f.energy = 0
    })
    expect(f.mood.state).toBe('silence')
  })

  it('settles to groove for sustained mid-energy, confident, stable input', () => {
    const f = run(10, 0.02, (f) => {
      f.silence = false
      f.energy = 0.6
      f.bass = 0.6
      f.confidence = 0.8
      f.centroid = 0.4
      f.flux = 0.2
      f.bpm = 120
    })
    expect(f.mood.state).toBe('groove')
  })

  it('reaches a hype state quickly on a drop at already-high energy', () => {
    const me = new MoodEstimator()
    const f = createEmptyFeatures()
    let now = 0
    const dt = 0.02
    for (; now < 5; now += dt) {
      f.time = now
      f.delta = dt
      f.silence = false
      f.energy = 0.9
      f.bass = 0.9
      f.confidence = 0.9
      f.centroid = 0.5
      f.bpm = 128
      me.update(f)
    }
    f.time = now
    f.delta = dt
    f.drop = true
    me.update(f)
    now += dt
    for (let i = 0; i < 10; i++) {
      f.time = now
      f.delta = dt
      me.update(f)
      now += dt
    }
    expect(['peak', 'aggressive']).toContain(f.mood.state)
  })

  it('keeps changeCount low despite small per-frame score noise (hysteresis holds)', () => {
    let i = 0
    const f = run(10, 0.02, (f) => {
      f.silence = false
      f.energy = i % 2 === 0 ? 0.42 : 0.38
      f.bass = 0.5
      f.confidence = 0.7
      f.centroid = 0.4
      f.bpm = 120
      i++
    })
    expect(f.mood.changeCount).toBeLessThan(5)
  })

  it('always exposes a finite score for all 7 mood states', () => {
    const f = createEmptyFeatures()
    f.time = 1
    f.delta = 0.016
    new MoodEstimator().update(f)
    const expected: MoodState[] = [
      'silence',
      'ambient',
      'mellow',
      'groove',
      'building',
      'peak',
      'aggressive',
    ]
    expect(Object.keys(f.mood.scores).sort()).toEqual([...expected].sort())
    for (const k of expected) expect(Number.isFinite(f.mood.scores[k])).toBe(true)
  })

  it('reports lower ambiguity for a decisive winner than for a contested, boundary-region input', () => {
    const decisive = createEmptyFeatures()
    decisive.time = 1
    decisive.delta = 0.016
    decisive.silence = true
    new MoodEstimator().update(decisive)

    const contested = createEmptyFeatures()
    contested.time = 1
    contested.delta = 0.016
    contested.silence = false
    contested.energy = 0.3
    contested.bass = 0.3
    contested.confidence = 0.4
    contested.centroid = 0.3
    new MoodEstimator().update(contested)

    expect(decisive.mood.ambiguity).toBeLessThan(contested.mood.ambiguity)
  })

  it('scores aggressive higher for a noisier (higher spectral flatness) texture at the same energy', () => {
    function aggressiveScoreFor(flatness: number): number {
      const f = run(5, 0.02, (f) => {
        f.silence = false
        f.energy = 0.75
        f.bass = 0.6
        f.confidence = 0.7
        f.centroid = 0.5
        f.flux = 0.5
        f.bpm = 140
        f.spectralFlatness = flatness
      })
      return f.mood.scores.aggressive
    }
    expect(aggressiveScoreFor(0.9)).toBeGreaterThan(aggressiveScoreFor(0.05))
  })
})
