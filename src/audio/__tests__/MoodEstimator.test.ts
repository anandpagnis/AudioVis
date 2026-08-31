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

  it('does not commit mellow for a bass-heavy mid-energy mix (F121)', () => {
    // The F121 failure: 139 of 155 s on `mellow` while bass regularly passed
    // 0.8. Soft-ish energy but a bass-forward mix must read as groove.
    const f = run(10, 0.02, (f) => {
      f.silence = false
      f.energy = 0.4
      f.bass = 0.85
      f.confidence = 0.7
      f.centroid = 0.45
      f.bpm = 120
    })
    expect(f.mood.state).not.toBe('mellow')
  })

  it('still reaches groove when the beat-tracker confidence is weak', () => {
    // groove used to collapse to ~half when `f.confidence` was low — which is
    // exactly F121's octave-flip symptom. The CONF_FLOOR keeps it reachable.
    const f = run(10, 0.02, (f) => {
      f.silence = false
      f.energy = 0.6
      f.bass = 0.7
      f.confidence = 0.15
      f.centroid = 0.4
      f.flux = 0.2
      f.bpm = 120
    })
    expect(f.mood.state).toBe('groove')
  })

  it('still commits mellow for genuinely soft, sparse, bass-light material', () => {
    const f = run(10, 0.02, (f) => {
      f.silence = false
      f.energy = 0.32
      f.bass = 0.2
      f.confidence = 0.4
      f.centroid = 0.6
      f.bpm = 90
    })
    expect(f.mood.state).toBe('mellow')
  })

  it('reports a high confidence for a decisive, settled read (not capped near 0.39)', () => {
    // F121: the old formula could not carry confidence past ~0.4 on ANY input
    // because it used the raw score margin. A sustained, clearly-groove read
    // must now land well above the AutoPilot gate.
    const f = run(12, 0.02, (f) => {
      f.silence = false
      f.energy = 0.62
      f.bass = 0.6
      f.confidence = 0.85
      f.centroid = 0.42
      f.flux = 0.2
      f.bpm = 122
    })
    expect(f.mood.state).toBe('groove')
    expect(f.mood.confidence).toBeGreaterThan(0.6)
  })

  it('confidence moves opposite to ambiguity', () => {
    // Decisive: silence scores 1.5 alone → ambiguity ~0.
    const decisive = run(2, 0.05, (f) => {
      f.silence = true
      f.energy = 0
    })
    // Contested: a boundary-region input with several states near-tied.
    const contested = run(2, 0.05, (f) => {
      f.silence = false
      f.energy = 0.3
      f.bass = 0.3
      f.confidence = 0.4
      f.centroid = 0.3
    })
    expect(decisive.mood.ambiguity).toBeLessThan(contested.mood.ambiguity)
    expect(decisive.mood.confidence).toBeGreaterThan(contested.mood.confidence)
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

  it('ignores f.sparkle — it is a contract-level cue, not wired into scoring yet', () => {
    const scoreWith = (sparkle: number) =>
      run(5, 0.02, (f) => {
        f.silence = false
        f.energy = 0.75
        f.bass = 0.6
        f.confidence = 0.7
        f.centroid = 0.5
        f.flux = 0.5
        f.bpm = 140
        f.sparkle = sparkle
      }).mood.scores
    const lo = scoreWith(0)
    const hi = scoreWith(1)
    expect(hi.aggressive).toBeCloseTo(lo.aggressive, 10)
    expect(hi.ambient).toBeCloseTo(lo.ambient, 10)
  })
})
