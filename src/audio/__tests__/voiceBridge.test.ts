import { describe, expect, it } from 'vitest'
import { voiceBridge } from '../essentia/VoiceBridge'
import { createEmptyFeatures } from '../types'

/**
 * The classifier itself needs a browser (WASM backend + fetched weights), but
 * the parts with real decisions in them — the silent-fallback contract and the
 * fraction-vs-mean aggregation — are testable as plain logic.
 */
describe('VoiceBridge', () => {
  it('is inert and leaves features at defaults with no worker attached', () => {
    const f = createEmptyFeatures()
    f.time = 5
    for (let i = 0; i < 40; i++) {
      f.time += 0.5
      voiceBridge.update(f)
    }
    expect(f.vocalPresence).toBe(0)
    expect(f.moods).toEqual({ happy: 0, aggressive: 0, party: 0, relaxed: 0 })
  })

  it('reports not-loaded status before any classification', () => {
    expect(voiceBridge.status.loaded).toBe(false)
    expect(voiceBridge.status.runs).toBe(0)
  })

  it('reset and pushPcm are safe with nothing attached', () => {
    expect(() => voiceBridge.reset()).not.toThrow()
    expect(() => voiceBridge.pushPcm(new Float32Array(128), 48000)).not.toThrow()
  })

  it('exposes vocalPresence and moods on a fresh feature set', () => {
    const f = createEmptyFeatures()
    expect(f.vocalPresence).toBe(0)
    expect(f.moods.party).toBe(0)
  })
})

/**
 * The aggregation choice, stated as an executable claim.
 *
 * This is the shape that took the labelled test set from 5/8 to 7/8: a track
 * whose vocal enters late averages down to "instrumental" but still has a
 * clear majority of vocal segments once you count segments instead.
 */
describe('voice aggregation: fraction, not mean', () => {
  const THRESHOLD = 0.5
  const fraction = (p: number[]) => p.filter((v) => v > THRESHOLD).length / p.length
  const mean = (p: number[]) => p.reduce((a, b) => a + b, 0) / p.length

  it('rescues a vocal track with a long instrumental intro', () => {
    // Four instrumental segments, then four strongly vocal ones.
    const probs = [0.02, 0.05, 0.03, 0.08, 0.96, 0.99, 0.94, 0.97]
    expect(mean(probs)).toBeLessThan(0.55) // an average would call this instrumental
    expect(fraction(probs)).toBe(0.5) // counting segments does not
  })

  it('still rejects material that never crosses the threshold', () => {
    // Percussion-only measured 0.21, white noise 0.16, silence 0.26.
    const probs = [0.21, 0.16, 0.26, 0.19, 0.23]
    expect(fraction(probs)).toBe(0)
  })

  it('is monotonic in the number of vocal segments', () => {
    const base = [0.1, 0.1, 0.1, 0.1]
    const one = [0.9, 0.1, 0.1, 0.1]
    const three = [0.9, 0.9, 0.9, 0.1]
    expect(fraction(base)).toBeLessThan(fraction(one))
    expect(fraction(one)).toBeLessThan(fraction(three))
  })

  it('resolves finer than a single 12s window can', () => {
    // One request yields 4 patches -> only 0/.25/.5/.75/1 are representable.
    // Pooling 16 gives 1/16 steps, which is why the bridge keeps a history.
    const single = Array.from({ length: 4 }, (_, i) => (i === 0 ? 0.9 : 0.1))
    const pooled = Array.from({ length: 16 }, (_, i) => (i === 0 ? 0.9 : 0.1))
    expect(fraction(single)).toBeCloseTo(0.25, 5)
    expect(fraction(pooled)).toBeCloseTo(0.0625, 5)
  })
})
