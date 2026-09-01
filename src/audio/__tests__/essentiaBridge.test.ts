import { describe, expect, it } from 'vitest'
import { essentiaBridge, TAP_BLOCK } from '../essentia/EssentiaBridge'
import { createEmptyFeatures } from '../types'

/**
 * The bridge's scheduling/merge policy is pure logic and testable without a
 * worker or WASM: with no AudioContext attached there is no ring buffer, so
 * update() must be a safe no-op that leaves every field at its default. This
 * is the "silent fallback" contract — WASM unsupported, worklet blocked, or
 * worker construction refused all land here.
 */
describe('EssentiaBridge', () => {
  it('is inert and leaves features untouched when nothing is attached', () => {
    const f = createEmptyFeatures()
    f.time = 10
    // A throwaway stand-in for BpmEstimator; it must never be called.
    let modelCalls = 0
    const est = {
      setModelTempo: () => {
        modelCalls++
      },
    }
    for (let i = 0; i < 30; i++) {
      f.time += 0.5
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      essentiaBridge.update(f, est as any)
    }
    expect(modelCalls).toBe(0)
    expect(f.key).toBe('')
    expect(f.scale).toBe('')
    expect(f.keyConfidence).toBe(0)
    expect(f.danceability).toBe(0)
  })

  it('requestKey is safe to call with no worker attached', () => {
    expect(() => essentiaBridge.requestKey()).not.toThrow()
  })

  it('reports a not-running status before attach', () => {
    expect(essentiaBridge.status.running).toBe(false)
    expect(essentiaBridge.status.keyRuns).toBe(0)
    expect(essentiaBridge.status.danceRuns).toBe(0)
  })

  it('exposes key/danceability defaults on a fresh feature set', () => {
    const f = createEmptyFeatures()
    expect(f.key).toBe('')
    expect(f.scale).toBe('')
    expect(f.danceability).toBe(0)
  })

  it('PCM tap block is a render-quantum multiple, <= the old 4096 (F165)', () => {
    // The AudioWorklet fills its buffer 128 frames at a time and only posts on
    // an exact fill, so a non-multiple of 128 would never trigger.
    expect(TAP_BLOCK % 128).toBe(0)
    expect(TAP_BLOCK).toBeLessThanOrEqual(4096)
    expect(TAP_BLOCK).toBeGreaterThanOrEqual(1024)
  })
})
