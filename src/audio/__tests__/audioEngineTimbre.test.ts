import { describe, expect, it } from 'vitest'
import { audioEngine } from '../AudioEngine'

const KEYS = ['harsh', 'busy', 'sparse'] as const

/**
 * `features.timbre` (harsh / busy / sparse, DSP-only) must always exist and stay in 0..1: while idle, after
 * `update()` without a graph, and after `stop()`, whose `resetAnalysis()` REPLACES the sub-object (the same
 * trap that detached `features.character`, F253). The engine therefore copies the three numbers in each
 * frame instead of aliasing its descriptor instance.
 */
describe('AudioEngine timbre descriptors', () => {
  it('features.timbre exists with 0..1 values after update() and after stop()', async () => {
    await new Promise((r) => setTimeout(r, 0))
    for (let i = 0; i < 5; i++) expect(() => audioEngine.update()).not.toThrow()
    for (const stage of ['after update', 'after stop']) {
      if (stage === 'after stop') expect(() => audioEngine.stop()).not.toThrow()
      const t = audioEngine.features.timbre
      expect(t, stage).toBeDefined()
      for (const k of KEYS) {
        expect(Number.isFinite(t[k]), `${stage} ${k}`).toBe(true)
        expect(t[k], `${stage} ${k}`).toBeGreaterThanOrEqual(0)
        expect(t[k], `${stage} ${k}`).toBeLessThanOrEqual(1)
      }
    }
    expect(audioEngine.features.timbre).toEqual({ harsh: 0.5, busy: 0.5, sparse: 0.5 })
  })

  it('does not alias the descriptor instance (so a resetAnalysis() that replaces the object cannot detach it)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const instance = (audioEngine as any).timbre
    expect(instance).toBeDefined()
    expect(audioEngine.features.timbre).not.toBe(instance.read())
    audioEngine.stop()
    expect(audioEngine.features.timbre).not.toBe(instance.read())
    // The instance is reset with the rest of the analysis state.
    expect(instance.read()).toEqual({ harsh: 0.5, busy: 0.5, sparse: 0.5 })
  })
})
