import { describe, expect, it } from 'vitest'
import { KeyPaletteTracker, NO_KEY_FAMILY, keyFamily } from '../keyPalette'

/**
 * The family map exists to absorb key detection's measured jitter (43-65%
 * window agreement), so the tests assert the *collapsing* behaviour rather
 * than any particular colour — which key maps to which palette is a taste
 * call, but "adjacent readings agree" is the load-bearing property.
 */
describe('keyFamily', () => {
  it('collapses relative major/minor onto one family', () => {
    // The classic KeyExtractor confusion: identical pitch-class sets.
    expect(keyFamily('A', 'minor')).toBe(keyFamily('C', 'major'))
    expect(keyFamily('E', 'minor')).toBe(keyFamily('G', 'major'))
    expect(keyFamily('D', 'minor')).toBe(keyFamily('F', 'major'))
  })

  it('treats enharmonic spellings as the same key', () => {
    // Essentia emits either spelling depending on the profile.
    expect(keyFamily('C#', 'major')).toBe(keyFamily('Db', 'major'))
    expect(keyFamily('F#', 'major')).toBe(keyFamily('Gb', 'major'))
    expect(keyFamily('A#', 'minor')).toBe(keyFamily('Bb', 'minor'))
  })

  it('returns a real family for every chromatic tonic in both scales', () => {
    const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
    for (const n of names) {
      for (const scale of ['major', 'minor']) {
        expect(keyFamily(n, scale)).not.toBe(NO_KEY_FAMILY)
      }
    }
  })

  it('has no opinion when the key is unknown or unparseable', () => {
    expect(keyFamily('', '')).toBe(NO_KEY_FAMILY)
    expect(keyFamily('H', 'major')).toBe(NO_KEY_FAMILY)
  })
})

describe('KeyPaletteTracker', () => {
  it('stays silent until it has seen enough votes', () => {
    const t = new KeyPaletteTracker()
    expect(t.update('C', 'major', 0)).toBe(NO_KEY_FAMILY)
    expect(t.update('C', 'major', 7)).toBe(NO_KEY_FAMILY)
    expect(t.family).toBe(NO_KEY_FAMILY)
  })

  it('commits once a clear majority has accumulated', () => {
    const t = new KeyPaletteTracker()
    for (let i = 0; i < 25; i++) t.update('C', 'major', i)
    expect(t.family).toBe(keyFamily('C', 'major'))
  })

  it('cannot be ballot-stuffed by the per-frame call rate', () => {
    const fast = new KeyPaletteTracker()
    const slow = new KeyPaletteTracker()
    // 60fps for 60s vs. one call per second over the same 60s.
    for (let i = 0; i < 3600; i++) fast.update('C', 'major', i / 60)
    for (let i = 0; i < 60; i++) slow.update('C', 'major', i)
    expect(fast.family).toBe(slow.family)
  })

  it('lets a steady key accumulate agreement', () => {
    // The bug this guards: deduplicating by value meant a track solidly in one
    // key cast exactly one vote and could never reach a majority.
    const t = new KeyPaletteTracker()
    for (let i = 0; i < 40; i++) t.update('C', 'major', i)
    expect(t.family).toBe(keyFamily('C', 'major'))
  })

  it('refuses to switch again before the minimum dwell elapses', () => {
    const t = new KeyPaletteTracker()
    for (let i = 0; i < 30; i++) t.update('C', 'major', i)
    const first = t.family
    expect(first).not.toBe(NO_KEY_FAMILY)
    // A genuinely different family, but immediately after committing.
    for (let i = 30; i < 50; i++) t.update('E', 'major', i)
    expect(t.family).toBe(first)
  })

  it('does switch once the dwell has passed and the vote is decisive', () => {
    const t = new KeyPaletteTracker()
    for (let i = 0; i < 30; i++) t.update('C', 'major', i)
    const first = t.family
    // Well past MIN_DWELL_SEC and long enough to flush the history.
    for (let i = 30; i < 200; i++) t.update('E', 'major', i)
    expect(t.family).not.toBe(first)
    expect(t.family).toBe(keyFamily('E', 'major'))
  })

  it('holds position while readings are split three ways', () => {
    const t = new KeyPaletteTracker()
    // Rotating unrelated families so no single one ever holds a majority.
    // Stepped one vote-interval at a time on purpose: sampling a 3-element
    // rotation at a 6s interval from a per-second loop aliases to a constant.
    const rot = ['C', 'E', 'F']
    let time = 0
    for (let i = 0; i < 12; i++) {
      t.update(rot[i % 3], 'major', time)
      time += 6
    }
    expect(t.family).toBe(NO_KEY_FAMILY)
  })

  it('casts no vote while the key is unreadable', () => {
    const t = new KeyPaletteTracker()
    for (let i = 0; i < 60; i++) t.update('', '', i)
    expect(t.family).toBe(NO_KEY_FAMILY)
  })

  it('resets itself when the engine clock restarts (new source)', () => {
    const t = new KeyPaletteTracker()
    for (let i = 100; i < 130; i++) t.update('C', 'major', i)
    expect(t.family).not.toBe(NO_KEY_FAMILY)
    // A second track starts the AudioContext clock at 0 again; without this
    // the new track inherits the old family for a full dwell.
    t.update('E', 'major', 0)
    expect(t.family).toBe(NO_KEY_FAMILY)
  })
})
