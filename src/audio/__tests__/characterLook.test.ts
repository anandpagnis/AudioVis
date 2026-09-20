import { describe, expect, it } from 'vitest'
import { CHARACTER_PRIORS } from '../characterPriors'
import { CHARACTER_MOODS, createEmptyCharacterState, type CharacterMood, type CharacterState } from '../characterTypes'
import { CHARACTER_VIZ_SHARE, LookVizTracker, lookOf, lookState, type Viz } from '../characterLook'
import { LEGACY_MAP } from '../moodTaxonomy'
import { MOOD_STATES, createEmptyMood, type MoodState } from '../types'

void CHARACTER_PRIORS

function cs(primary: CharacterMood | null, over: Partial<CharacterState> = {}): CharacterState {
  return { ...createEmptyCharacterState(), valid: primary !== null, primary, arousal: 0.5, pulse: 0.5, ...over }
}

describe('lookState', () => {
  it('silence stays silence and an unready character read leaves the old state untouched', () => {
    expect(lookState('silence', cs('euphoric'))).toBe('silence')
    for (const s of MOOD_STATES) {
      expect(lookState(s, cs(null))).toBe(s)
      expect(lookState(s, cs('euphoric', { valid: false }))).toBe(s)
    }
  })

  it('real energy events pass through: a build or a drop is the old detector\'s call', () => {
    expect(lookState('building', cs('serene'))).toBe('building')
    expect(lookState('peak', cs('serene'))).toBe('peak')
  })

  it('character supplies the flavour at mid intensity: the same "groove" moment looks different per song', () => {
    expect(lookState('groove', cs('serene'))).toBe('ambient')
    expect(lookState('groove', cs('melancholic'))).toBe('mellow')
    expect(lookState('groove', cs('euphoric'))).toBe('peak')
    expect(lookState('groove', cs('tense'))).toBe('building')
    expect(lookState('groove', cs('groove'))).toBe('groove')
  })

  it('a quiet moment caps the look at groove, so a breakdown in an epic song gets no peak effects', () => {
    for (const legacy of ['ambient', 'mellow'] as MoodState[]) {
      for (const m of CHARACTER_MOODS) {
        const look = lookState(legacy, cs(m))
        expect(['building', 'peak', 'aggressive']).not.toContain(look)
      }
      expect(lookState(legacy, cs('epic'))).toBe('groove')
      expect(lookState(legacy, cs('serene'))).toBe('ambient')
    }
  })

  it('an aggressive moment stands only when the character agrees it is intense', () => {
    expect(lookState('aggressive', cs('serene', { arousal: 0.9 }))).toBe('aggressive')
    expect(lookState('aggressive', cs('serene', { arousal: 0.3 }))).toBe('ambient')
  })

  it('always returns a valid MoodState, and songs of different character get different looks', () => {
    const looks = new Set<MoodState>()
    for (const legacy of MOOD_STATES) {
      for (const m of CHARACTER_MOODS) {
        const l = lookState(legacy, cs(m))
        expect(MOOD_STATES).toContain(l)
        if (legacy === 'groove') looks.add(l)
      }
    }
    // The old detector alone would show ONE look for a groove moment; character opens it up.
    expect(looks.size).toBeGreaterThanOrEqual(5)
    expect(new Set(Object.values(LEGACY_MAP)).size).toBeGreaterThanOrEqual(5)
  })
})

describe('lookOf', () => {
  it('falls back to the raw state until the engine has computed a look', () => {
    const m = createEmptyMood()
    m.state = 'groove'
    expect(lookOf(m)).toBe('groove')
    m.look = 'peak'
    expect(lookOf(m)).toBe('peak')
  })
})

describe('LookVizTracker', () => {
  const legacy: Viz = { intensity: 1.0, speed: 1.0, reactivity: 1.1 }
  const run = (state: CharacterState, seconds: number, leg: Viz = legacy) => {
    const t = new LookVizTracker()
    const out: Viz = { intensity: 0, speed: 0, reactivity: 0 }
    for (let x = 0; x < seconds; x += 1 / 60) t.update(state, leg, 1 / 60, out)
    return out
  }

  it('passes the old multipliers through untouched until the character read is valid', () => {
    const out = run(cs(null), 2)
    expect(out).toEqual(legacy)
  })

  it('hot, pulsing music gets bigger, faster, more reactive visuals than calm music', () => {
    const calm = run(cs('serene', { arousal: 0.05, pulse: 0.1 }), 30)
    const hot = run(cs('euphoric', { arousal: 0.95, pulse: 0.9 }), 30)
    expect(hot.intensity).toBeGreaterThan(calm.intensity + 0.3)
    expect(hot.speed).toBeGreaterThan(calm.speed + 0.4)
    expect(hot.reactivity).toBeGreaterThan(calm.reactivity + 0.2)
  })

  it('stays inside the old table\'s range and blends in the old state (so a drop still punches)', () => {
    const hot = run(cs('euphoric', { arousal: 1, pulse: 1 }), 60, { intensity: 1.32, speed: 1.25, reactivity: 1.4 })
    expect(hot.intensity).toBeLessThanOrEqual(1.32 + 1e-9)
    expect(hot.speed).toBeLessThanOrEqual(1.4 + 1e-9)
    const calmMusicDrop = run(cs('serene', { arousal: 0.05, pulse: 0.1 }), 60, { intensity: 1.32, speed: 1.25, reactivity: 1.4 })
    const calmMusicQuiet = run(cs('serene', { arousal: 0.05, pulse: 0.1 }), 60, { intensity: 0.78, speed: 0.6, reactivity: 0.9 })
    expect(calmMusicDrop.intensity).toBeGreaterThan(calmMusicQuiet.intensity)
    // The old state's share is exactly what is left over after the character's.
    expect(calmMusicDrop.intensity - calmMusicQuiet.intensity).toBeCloseTo((1 - CHARACTER_VIZ_SHARE) * (1.32 - 0.78), 5)
  })

  it('moves slowly: a sudden change in character does not jump the multipliers', () => {
    const t = new LookVizTracker()
    const out: Viz = { intensity: 0, speed: 0, reactivity: 0 }
    for (let x = 0; x < 20; x += 1 / 60) t.update(cs('serene', { arousal: 0.05, pulse: 0.1 }), legacy, 1 / 60, out)
    const before = out.intensity
    t.update(cs('euphoric', { arousal: 1, pulse: 1 }), legacy, 1 / 60, out)
    expect(Math.abs(out.intensity - before)).toBeLessThan(0.01)
  })

  it('never produces NaN, even for garbage character values', () => {
    const out = run(cs('epic', { arousal: Number.NaN, pulse: Number.POSITIVE_INFINITY }), 5)
    for (const v of Object.values(out)) expect(Number.isFinite(v)).toBe(true)
    const t = new LookVizTracker()
    const o: Viz = { intensity: 0, speed: 0, reactivity: 0 }
    t.update(cs('epic'), legacy, -1, o)
    t.update(cs('epic'), legacy, Number.NaN, o)
    for (const v of Object.values(o)) expect(Number.isFinite(v)).toBe(true)
  })

  it('reset() re-seeds instead of easing from the previous song', () => {
    const t = new LookVizTracker()
    const out: Viz = { intensity: 0, speed: 0, reactivity: 0 }
    for (let x = 0; x < 30; x += 1 / 60) t.update(cs('euphoric', { arousal: 1, pulse: 1 }), legacy, 1 / 60, out)
    t.reset()
    t.update(cs('serene', { arousal: 0, pulse: 0 }), legacy, 1 / 60, out)
    expect(out.intensity).toBeLessThan(0.95)
  })
})
