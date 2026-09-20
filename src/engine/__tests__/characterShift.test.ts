import { describe, expect, it } from 'vitest'
import { createEmptyCharacterState, type CharacterMood, type CharacterState } from '../../audio/characterTypes'
import { CHARACTER_SHIFT_MIN_GAP_SEC, CharacterShiftTrigger } from '../characterShift'

function read(primary: CharacterMood | null, valid = true): CharacterState {
  return { ...createEmptyCharacterState(), valid, primary }
}

describe('CharacterShiftTrigger', () => {
  it('does not fire on the first valid read, only on a change from one real read to another', () => {
    const t = new CharacterShiftTrigger()
    t.observe(read('serene'))
    expect(t.take(100, -Infinity)).toBe(false)
    t.observe(read('serene'))
    expect(t.take(101, -Infinity)).toBe(false)
    t.observe(read('tense'))
    expect(t.take(102, -Infinity)).toBe(true)
  })

  it('fires once per shift', () => {
    const t = new CharacterShiftTrigger()
    t.observe(read('serene'))
    t.observe(read('tense'))
    expect(t.take(50, -Infinity)).toBe(true)
    expect(t.take(51, -Infinity)).toBe(false)
  })

  it('holds a shift back inside the minimum gap, then releases it (latched, not lost)', () => {
    const t = new CharacterShiftTrigger()
    t.observe(read('groove'))
    t.observe(read('epic'))
    expect(t.take(105, 100)).toBe(false)
    t.observe(read('epic'))
    expect(t.take(100 + CHARACTER_SHIFT_MIN_GAP_SEC, 100)).toBe(true)
  })

  it('keeps a shift that lands while the caller is suppressed (observe runs, take does not)', () => {
    const t = new CharacterShiftTrigger()
    t.observe(read('dreamy'))
    t.observe(read('driving'))
    t.observe(read('driving'))
    t.observe(read('driving'))
    expect(t.take(200, 0)).toBe(true)
  })

  it('a shift already answered by another trigger does not fire again', () => {
    const t = new CharacterShiftTrigger()
    t.observe(read('melancholic'))
    t.observe(read('uplifting'))
    t.consume()
    expect(t.take(300, -Infinity)).toBe(false)
  })

  it('an invalid read (warm-up, silence, new source) clears state instead of comparing across it', () => {
    const t = new CharacterShiftTrigger()
    t.observe(read('serene'))
    t.observe(read(null, false))
    t.observe(read('aggressive'))
    expect(t.take(400, -Infinity)).toBe(false)
    t.observe(read('tender'))
    expect(t.take(401, -Infinity)).toBe(true)
  })

  it('reset forgets the previous song', () => {
    const t = new CharacterShiftTrigger()
    t.observe(read('serene'))
    t.reset()
    t.observe(read('tense'))
    expect(t.take(500, -Infinity)).toBe(false)
  })
})
