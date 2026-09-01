import { describe, expect, it } from 'vitest'
import { MoodEstimator } from '../MoodEstimator'
import { createEmptyFeatures, type AudioFeatures } from '../types'
import { pickCameraMode } from '../../engine/CameraDirector'

/** Drive the estimator to a settled state on groove-ish material. */
function runGrooveLike(mutate: (f: AudioFeatures) => void, seconds = 12): AudioFeatures {
  const est = new MoodEstimator()
  const f = createEmptyFeatures()
  f.delta = 1 / 60
  for (let t = 0; t < seconds * 60; t++) {
    f.time = t / 60
    f.silence = false
    f.energy = 0.58
    f.bass = 0.6
    f.centroid = 0.45
    f.confidence = 0.8
    f.spectralFlatness = 0.25
    f.crestFactor = 4
    mutate(f)
    est.update(f)
  }
  return f
}

describe('mood_party -> groove bonus', () => {
  it('raises the groove score when the classifier reports party material', () => {
    const without = runGrooveLike((f) => {
      f.moodsValid = true
      f.moods.party = 0
    })
    const with_ = runGrooveLike((f) => {
      f.moodsValid = true
      f.moods.party = 0.95
    })
    expect(with_.mood.scores.groove).toBeGreaterThan(without.mood.scores.groove)
  })

  it('is neutral — not suppressive — when the classifier never ran', () => {
    // The failure this guards: a multiplicative bonus would collapse groove to
    // near zero for every user who never fetched the (gitignored) weights.
    const noModels = runGrooveLike((f) => {
      f.moodsValid = false
      f.moods.party = 0
    })
    const modelsSayZero = runGrooveLike((f) => {
      f.moodsValid = true
      f.moods.party = 0
    })
    expect(noModels.mood.scores.groove).toBeGreaterThan(0)
    expect(noModels.mood.scores.groove).toBeCloseTo(modelsSayZero.mood.scores.groove, 5)
  })

  it('ignores party when moodsValid is false, even if a stale value is present', () => {
    const stale = runGrooveLike((f) => {
      f.moodsValid = false
      f.moods.party = 0.95
    })
    const clean = runGrooveLike((f) => {
      f.moodsValid = false
      f.moods.party = 0
    })
    expect(stale.mood.scores.groove).toBeCloseTo(clean.mood.scores.groove, 5)
  })

  it('cannot by itself turn a quiet passage into groove', () => {
    // Energy-gated: party is a bias inside the groove band, not a bypass of it.
    const quiet = runGrooveLike((f) => {
      f.energy = 0.05
      f.bass = 0.05
      f.moodsValid = true
      f.moods.party = 1
    })
    expect(quiet.mood.state).not.toBe('groove')
  })
})

describe('danceability -> groove bonus (F166, MusiCNN-absent fallback)', () => {
  it('raises groove when danceability is high AND the classifier is absent', () => {
    const flat = runGrooveLike((f) => {
      f.moodsValid = false
      f.danceability = 0
    })
    const dancey = runGrooveLike((f) => {
      f.moodsValid = false
      f.danceability = 7.5 // solid four-on-floor
    })
    expect(dancey.mood.scores.groove).toBeGreaterThan(flat.mood.scores.groove)
  })

  it('does nothing when the MusiCNN party head is available', () => {
    // moodsValid -> partyBonus owns the club bias; danceability must not stack.
    const withDance = runGrooveLike((f) => {
      f.moodsValid = true
      f.moods.party = 0
      f.danceability = 7.5
    })
    const withoutDance = runGrooveLike((f) => {
      f.moodsValid = true
      f.moods.party = 0
      f.danceability = 0
    })
    expect(withDance.mood.scores.groove).toBeCloseTo(withoutDance.mood.scores.groove, 5)
  })

  it('treats a degenerate reading (~97 on noise/near-silence) as zero, not +inf', () => {
    const degenerate = runGrooveLike((f) => {
      f.moodsValid = false
      f.danceability = 97
    })
    const zero = runGrooveLike((f) => {
      f.moodsValid = false
      f.danceability = 0
    })
    expect(Number.isFinite(degenerate.mood.scores.groove)).toBe(true)
    expect(degenerate.mood.scores.groove).toBeCloseTo(zero.mood.scores.groove, 5)
  })

  it('cannot by itself turn a quiet passage into groove', () => {
    const quiet = runGrooveLike((f) => {
      f.energy = 0.05
      f.bass = 0.05
      f.moodsValid = false
      f.danceability = 8
    })
    expect(quiet.mood.state).not.toBe('groove')
  })
})

describe('voiceFocus -> camera framing', () => {
  const modes = ['orbit', 'locked', 'push', 'cinematic', 'hover'] as const

  it('prefers intimate framing when a voice dominates the section', () => {
    const withVoice = pickCameraMode([...modes], 'mellow', 0, 0, 0.9)
    expect(['locked', 'push']).toContain(withVoice)
  })

  it('leaves instrumental sections on the mood default', () => {
    const instrumental = pickCameraMode([...modes], 'mellow', 0, 0, 0)
    expect(['locked', 'push']).not.toContain(instrumental)
  })

  it('lets tension outrank intimacy — a sung build is still shot as a build', () => {
    // Both signals high: tension must win, otherwise the build and its release
    // are framed identically.
    const tense = pickCameraMode([...modes], 'building', 0.9, 0, 0.9)
    expect(tense).toBe('push')
  })

  it('never introduces handheld from the voice path', () => {
    // Same calm-mood invariant the tension override protects.
    for (const mood of ['ambient', 'mellow', 'groove'] as const) {
      const m = pickCameraMode(['handheld', 'locked', 'hover'], mood, 0, 0, 1)
      expect(m).not.toBe('handheld')
    }
  })

  it('only offers modes the scene actually declared', () => {
    // A scene with no intimate modes must not be handed one.
    const m = pickCameraMode(['orbit', 'topdown'], 'mellow', 0, 0, 1)
    expect(['orbit', 'topdown']).toContain(m)
  })

  it('defaults to the old behaviour when voiceFocus is omitted', () => {
    expect(pickCameraMode([...modes], 'mellow', 0, 0)).toBe(
      pickCameraMode([...modes], 'mellow', 0, 0, 0),
    )
  })
})
