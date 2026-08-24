import { describe, expect, it } from 'vitest'
import { MOOD_STATES } from '../../audio/types'
import { SCENE_PARAM_KEYS, type SceneParams } from '../../scenes/contract'
import { STEERED_KEYS, advanceSteer, clearSteer, steerTargets } from '../sceneSteer'

/**
 * The auto-VJ's art direction.
 *
 * These tests are the reason the mood table is worth having: they assert the
 * SHAPE of the journey — that quiet is sparser than loud, that a build looks
 * different from a groove, that a drop lands fast — rather than pinning the
 * individual numbers, which are taste and will be retuned. A test that asserted
 * `peak.complexity === 0.8` would fail on every honest tweak and tell nobody
 * anything.
 */

const MOOD_ORDER = ['silence', 'ambient', 'mellow', 'groove', 'building', 'peak'] as const

describe('steerTargets', () => {
  it('covers every mood the classifier can produce', () => {
    // A missing row would silently fall back to groove, so the show would look
    // identical in a mood it was supposed to have its own picture for.
    for (const mood of MOOD_STATES) {
      const t = steerTargets(mood, 0)
      for (const k of STEERED_KEYS) {
        expect(t[k], `${mood}.${k}`).toBeGreaterThanOrEqual(0)
        expect(t[k], `${mood}.${k}`).toBeLessThanOrEqual(1)
      }
    }
  })

  it('rises monotonically from silence to peak on every dial it drives', () => {
    // This IS the mood trajectory the product claims to perform. If any dial
    // dipped in the middle, the show would visibly back off mid-build.
    for (const k of STEERED_KEYS) {
      for (let i = 1; i < MOOD_ORDER.length; i++) {
        const prev = steerTargets(MOOD_ORDER[i - 1], 0)[k]
        const next = steerTargets(MOOD_ORDER[i], 0)[k]
        expect(next, `${k}: ${MOOD_ORDER[i]} vs ${MOOD_ORDER[i - 1]}`).toBeGreaterThan(prev)
      }
    }
  })

  it('parks groove near neutral, so most of a track sits near the authored look', () => {
    // Groove is the most common mood by a distance. If it sat high, the steer
    // would have nowhere left to go at the drop.
    for (const k of STEERED_KEYS) {
      expect(Math.abs(steerTargets('groove', 0)[k] - 0.5), k).toBeLessThan(0.1)
    }
  })

  it('makes aggressive harder than peak but not denser', () => {
    // Two different loud pictures, not one loud picture and a copy.
    const peak = steerTargets('peak', 0)
    const agg = steerTargets('aggressive', 0)
    expect(agg.contrast).toBeGreaterThan(peak.contrast)
    expect(agg.density).toBeLessThan(peak.density)
  })

  it('tension raises the picture without needing a mood change', () => {
    // The phrase-level half: the bar before a drop must not look like the same
    // mood without one.
    const calm = steerTargets('building', 0)
    const tense = steerTargets('building', 1)
    for (const k of STEERED_KEYS) expect(tense[k], k).toBeGreaterThan(calm[k])
  })

  it('spends tension mostly on contrast and complexity, least on speed', () => {
    // A build that mostly speeds up reads as a tempo change, which is a lie
    // about the music.
    const d = (k: 'speed' | 'complexity' | 'contrast') =>
      steerTargets('mellow', 1)[k] - steerTargets('mellow', 0)[k]
    expect(d('contrast')).toBeGreaterThan(d('speed'))
    expect(d('complexity')).toBeGreaterThan(d('speed'))
  })

  it('clamps rather than overflowing when a tense mood is already high', () => {
    for (const k of STEERED_KEYS) {
      expect(steerTargets('aggressive', 1)[k], k).toBeLessThanOrEqual(1)
    }
  })

  it('an out-of-range tension cannot push a dial out of range', () => {
    for (const k of STEERED_KEYS) {
      expect(steerTargets('peak', 99)[k], k).toBeLessThanOrEqual(1)
      expect(steerTargets('peak', -99)[k], k).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('advanceSteer', () => {
  it('leaves shape and tilt alone, so a human always owns two dials', () => {
    // Declining these is the design, not an omission: `shape` has no musical
    // quantity behind it and `tilt` belongs to the CameraDirector.
    const s: SceneParams = {}
    advanceSteer(s, { mood: 'peak', tension: 1, delta: 1 })
    expect(s.shape).toBeUndefined()
    expect(s.tilt).toBeUndefined()
    // And every other key IS written, or the steer would be silently partial.
    for (const k of SCENE_PARAM_KEYS) {
      if (k === 'shape' || k === 'tilt') continue
      expect(s[k], k).toBeDefined()
    }
  })

  it('seeds the first frame at the target rather than easing up from neutral', () => {
    // At boot there is no previous position worth preserving, and easing from
    // 0.5 would make every scene visibly settle for seconds after the first note.
    const s: SceneParams = {}
    advanceSteer(s, { mood: 'silence', tension: 0, delta: 1 / 60 })
    expect(s.complexity).toBeCloseTo(steerTargets('silence', 0).complexity)
  })

  it('eases rather than snapping once seeded', () => {
    const s: SceneParams = {}
    advanceSteer(s, { mood: 'silence', tension: 0, delta: 1 / 60 })
    const from = s.complexity!
    const target = steerTargets('peak', 0).complexity
    advanceSteer(s, { mood: 'peak', tension: 0, delta: 1 / 60 })
    // Moved toward the new mood, but nowhere near arrived: a section boundary
    // must not restyle five dials on one frame.
    expect(s.complexity!).toBeGreaterThan(from)
    expect(s.complexity!).toBeLessThan(from + (target - from) * 0.2)
  })

  it('converges on the target when the mood holds', () => {
    const s: SceneParams = { complexity: 0 }
    for (let i = 0; i < 60 * 30; i++) {
      advanceSteer(s, { mood: 'peak', tension: 0, delta: 1 / 60 })
    }
    expect(s.complexity!).toBeCloseTo(steerTargets('peak', 0).complexity, 2)
  })

  it('moves far faster on a drop', () => {
    // A drop is the one event where a three-second ease is simply wrong.
    const slow: SceneParams = { complexity: 0 }
    const fast: SceneParams = { complexity: 0 }
    advanceSteer(slow, { mood: 'peak', tension: 1, delta: 1 / 60 })
    advanceSteer(fast, { mood: 'peak', tension: 1, delta: 1 / 60, drop: true })
    expect(fast.complexity!).toBeGreaterThan(slow.complexity! * 4)
  })

  it('never leaves a dial outside 0..1, even on a long frame', () => {
    // `approach` clamps its own blend factor, but a spike frame is exactly when
    // a bad value would reach a shader and stay there.
    const s: SceneParams = {}
    for (const delta of [1 / 60, 0.5, 4]) {
      advanceSteer(s, { mood: 'aggressive', tension: 1, delta, drop: true })
      for (const k of STEERED_KEYS) {
        expect(s[k]!, `${k} @ ${delta}`).toBeGreaterThanOrEqual(0)
        expect(s[k]!, `${k} @ ${delta}`).toBeLessThanOrEqual(1)
      }
    }
  })
})

describe('clearSteer', () => {
  it('removes the opinion entirely rather than freezing it', () => {
    // Turning off mood-driven automation has to hand the scenes back to their
    // own defaults, not leave them stuck wherever the steer happened to be.
    const s: SceneParams = {}
    advanceSteer(s, { mood: 'peak', tension: 1, delta: 1 })
    clearSteer(s)
    for (const k of STEERED_KEYS) expect(s[k], k).toBeUndefined()
  })

  it('leaves nothing behind that a resolver would read as an opinion', () => {
    const s: SceneParams = {}
    advanceSteer(s, { mood: 'peak', tension: 1, delta: 1 })
    clearSteer(s)
    expect(Object.keys(s)).toEqual([])
  })
})
