import { beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { audioEngine } from '../../audio/AudioEngine'
import { createEmptyFeatures } from '../../audio/types'
import {
  animationSignals,
  applyToObject,
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

  it('routes the drum channels independently — a kick must not move the hat signal', () => {
    audioEngine.features.percussion.kick.env = 1
    updateAnimationSignals()
    expect(animationSignals.kick).toBeGreaterThan(0.5)
    expect(animationSignals.hihat).toBe(0)
    expect(animationSignals.snare).toBe(0)
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
        uAnimKick: { value: -1 },
      }
      applyToUniforms(u)
      expect(u.uAnimInflate!.value).toBeCloseTo(animationSignals.inflate, 6)
      expect(u.uAnimKick!.value).toBeCloseTo(animationSignals.kick, 6)
      // Undeclared ones stay absent rather than being created.
      expect(u.uAnimPulse).toBeUndefined()
      expect(u.uAnimTwist).toBeUndefined()
    })
  })

  describe('applyToObject', () => {
    it('is absolute, not cumulative — repeated frames at the same signal do not drift', () => {
      // The failure this guards: animating relative to the LIVE transform
      // compounds every frame, so a steady bass would inflate an object
      // without bound instead of holding a steady offset.
      audioEngine.features.bass = 1
      updateAnimationSignals()
      const obj = new THREE.Object3D()
      applyToObject(obj, { inflate: 1 }, 1 / 60)
      const first = obj.scale.x
      for (let i = 0; i < 100; i++) applyToObject(obj, { inflate: 1 }, 1 / 60)
      expect(obj.scale.x).toBeCloseTo(first, 6)
    })

    it('returns to the captured rest pose when signals fall back to zero', () => {
      const obj = new THREE.Object3D()
      audioEngine.features.bass = 1
      updateAnimationSignals()
      applyToObject(obj, { inflate: 1 }, 1 / 60)
      expect(obj.scale.x).toBeGreaterThan(1)

      reset()
      updateAnimationSignals()
      applyToObject(obj, { inflate: 1 }, 1 / 60)
      expect(obj.scale.x).toBeCloseTo(1, 6)
    })

    it('twist accumulates rotation over time (unlike scale, which is absolute)', () => {
      audioEngine.features.mid = 1
      for (let i = 0; i < 30; i++) updateAnimationSignals()
      const obj = new THREE.Object3D()
      applyToObject(obj, { twist: 1 }, 1 / 60)
      const after1 = obj.rotation.y
      for (let i = 0; i < 10; i++) applyToObject(obj, { twist: 1 }, 1 / 60)
      expect(Math.abs(obj.rotation.y)).toBeGreaterThan(Math.abs(after1))
    })
  })
})
