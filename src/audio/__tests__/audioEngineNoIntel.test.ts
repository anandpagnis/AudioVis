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

/**
 * `detectStructure` (private) is exercised directly, the same way other tests in this file reach past
 * TS-only privacy for internal state — there is no mocked AudioContext/AnalyserNode graph in this test
 * suite for driving the public `update()` loop, and building one just for this would be a large
 * integration harness for a small wiring check. This targets exactly what F-structure's drop-detector
 * task changed: two independent triggers into the same `f.drop` pulse-latch, both reached through the
 * real AudioEngine singleton (not the isolated DropStateMachine class, which has its own full test suite
 * in `src/audio/structure/__tests__/dropStateMachine.test.ts`).
 */
describe('AudioEngine detectStructure: f.drop has two independent trigger paths', () => {
  it('the ORIGINAL broadband energy/bass-ratio path still sets f.drop (unchanged behaviour)', () => {
    audioEngine.stop()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const engine = audioEngine as any
    const f = audioEngine.features
    let now = 100
    // "Before" window: steady low energy, long enough to fill the >10-sample before-bucket
    // (0.35s-2.2s ago) `detectStructure` reads from `energyLog`.
    for (let i = 0; i < 60; i++) {
      engine.energyLog.push({ t: now, e: 0.2 })
      now += 0.05
      engine.detectStructure(now, f)
    }
    expect(f.drop).toBe(false)
    // Sudden jump with heavy bass, sustained long enough that the <0.35s "recent" bucket fills
    // entirely with spike-level samples — the exact shape the broadband ratio test looks for.
    f.bass = 0.9
    let fired = false
    for (let i = 0; i < 30; i++) {
      engine.energyLog.push({ t: now, e: 0.9 })
      now += 0.05
      engine.detectStructure(now, f)
      if (f.drop) fired = true
    }
    expect(fired).toBe(true)
    audioEngine.stop()
  })

  it('the NEW fast breakdown->snap-back state machine also sets f.drop, through several detectStructure() calls', () => {
    audioEngine.stop()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const engine = audioEngine as any
    const f = audioEngine.features
    let now = 200
    f.delta = 0.05
    // Nothing in `energyLog` here, so the broadband block above is structurally skipped
    // (`recentN > 3 && beforeN > 10` never holds) — only the new path can set `dropUntil` below.
    f.sub = 0.4
    f.bass = 0.4
    for (let i = 0; i < 200; i++) {
      now += f.delta
      engine.detectStructure(now, f)
    }
    expect(f.drop).toBe(false)
    // Breakdown: sub+bass well under the trailing baseline, sustained past the arming floor (~1.5s).
    f.sub = 0.05
    f.bass = 0.05
    for (let i = 0; i < 40; i++) {
      now += f.delta
      engine.detectStructure(now, f)
    }
    expect(f.drop).toBe(false)
    // Snap-back with a concurrent broadband transient (flux).
    f.sub = 0.45
    f.bass = 0.45
    f.flux = 0.9
    now += f.delta
    engine.detectStructure(now, f)
    expect(f.drop).toBe(true)
    audioEngine.stop()
  })
})
