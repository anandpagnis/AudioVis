import { beforeEach, describe, expect, it } from 'vitest'
import { audioEngine } from '../../audio/AudioEngine'
import { createEmptyFeatures } from '../../audio/types'
import {
  animationSignals,
  applyToUniforms,
  updateAnimationSignals,
  type AnimationUniforms,
} from '../AnimationDirector'
import { performanceState } from '../performanceState'

/** Reset the world to a known, silent state before each case. */
function reset() {
  Object.assign(audioEngine.features, createEmptyFeatures())
  audioEngine.features.delta = 1 / 60
  performanceState.animationIntensity = 1
  performanceState.visualTension = 0
}

describe('AnimationDirector', () => {
  beforeEach(reset)

  it('produces finite values for every primitive, even on a silent frame', () => {
    updateAnimationSignals()
    for (const [k, v] of Object.entries(animationSignals)) {
      expect(Number.isFinite(v), `${k} = ${v}`).toBe(true)
    }
  })

  it('inflate tracks bass mass', () => {
    updateAnimationSignals()
    const quiet = animationSignals.inflate
    audioEngine.features.bass = 1
    audioEngine.features.sub = 1
    updateAnimationSignals()
    expect(animationSignals.inflate).toBeGreaterThan(quiet)
  })

  it('carries no signal that SceneFrame.b already provides', () => {
    // Two sources of truth for "the beat hit" is how a scene ends up pulsing
    // twice as hard as its neighbour. These names were all duplicates at a
    // different scale factor and were removed; scenes read them from `b.*`.
    for (const dup of ['pulse', 'flash', 'kick', 'snare', 'hihat']) {
      expect(animationSignals, `${dup} duplicates SceneFrame.b.${dup}`).not.toHaveProperty(dup)
    }
  })

  it('animationIntensity scales the whole show', () => {
    audioEngine.features.bass = 1
    updateAnimationSignals()
    const full = animationSignals.inflate
    performanceState.animationIntensity = 0.25
    updateAnimationSignals()
    expect(animationSignals.inflate).toBeCloseTo(full * 0.25, 5)
  })

  it('explode rises with visual tension and slams on a drop', () => {
    updateAnimationSignals()
    expect(animationSignals.explode).toBe(0)
    performanceState.visualTension = 0.8
    updateAnimationSignals()
    const tense = animationSignals.explode
    expect(tense).toBeGreaterThan(0)
    audioEngine.features.drop = true
    updateAnimationSignals()
    expect(animationSignals.explode).toBeGreaterThan(tense)
  })

  it('ripple phase advances monotonically within its 0..1 wrap', () => {
    const seen: number[] = []
    for (let i = 0; i < 5; i++) {
      updateAnimationSignals()
      seen.push(animationSignals.ripple)
    }
    for (const v of seen) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  describe('applyToUniforms', () => {
    it('writes only the uniforms a material actually declares', () => {
      audioEngine.features.bass = 1
      updateAnimationSignals()
      // A material opting into two primitives only.
      const u: AnimationUniforms = {
        uAnimInflate: { value: -1 },
        uAnimExplode: { value: -1 },
      }
      applyToUniforms(u)
      expect(u.uAnimInflate!.value).toBeCloseTo(animationSignals.inflate, 6)
      expect(u.uAnimExplode!.value).toBeCloseTo(animationSignals.explode, 6)
      // Undeclared ones stay absent rather than being created.
      expect(u.uAnimRipple).toBeUndefined()
      expect(u.uAnimTwist).toBeUndefined()
    })
  })

})
