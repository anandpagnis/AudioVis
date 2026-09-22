import { describe, expect, it } from 'vitest'
import { audioEngine } from '../AudioEngine'

/**
 * Boot smoke test for the commercial (no-Essentia) default: with
 * `VITE_ENABLE_ESSENTIA` unset the engine runs on a NullProvider, and every
 * AudioEngine path that used to call a bridge must be a safe no-op that leaves
 * the licence-clean fallbacks in place.
 */
describe('AudioEngine keeps features.character linked to its classifier', () => {
  it('after construction and after every reset (stop/start), so live reads reach the directors', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const classifier = (audioEngine as any).characterClassifier
    expect(audioEngine.features.character).toBe(classifier.state)
    audioEngine.stop()
    expect(audioEngine.features.character).toBe(classifier.state)
    classifier.state.valid = true
    expect(audioEngine.features.character.valid).toBe(true)
    classifier.reset()
  })
})

describe('AudioEngine without a music-intel provider', () => {
  it('idles, updates and stops without throwing; fallbacks stay at defaults', async () => {
    // Let the async provider factory settle (it resolves to NullProvider).
    await new Promise((r) => setTimeout(r, 0))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((audioEngine as any).intel.id).toBe('null')
    for (let i = 0; i < 5; i++) expect(() => audioEngine.update()).not.toThrow()
    expect(() => audioEngine.stop()).not.toThrow()
    const f = audioEngine.features
    expect(f.key).toBe('')
    expect(f.scale).toBe('')
    expect(f.keyConfidence).toBe(0)
    expect(f.moodsValid).toBe(false)
    expect(f.structureValid).toBe(false)
    expect(f.vocalPresence).toBe(0)
  })
})
