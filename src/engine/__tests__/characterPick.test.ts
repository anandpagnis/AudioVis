import { describe, expect, it } from 'vitest'
import { createEmptyCharacterState, type CharacterState } from '../../audio/characterTypes'
import { getCharacterCandidates, getScene, SCENES } from '../../scenes'
import { pickByCharacter } from '../characterPick'

function character(over: Partial<CharacterState> = {}): CharacterState {
  return {
    ...createEmptyCharacterState(),
    valid: true,
    primary: 'groove',
    valence: 0.6,
    arousal: 0.5,
    tension: 0.2,
    pulse: 0.8,
    confidence: 0.7,
    ...over,
  }
}

/** Deterministic PRNG. */
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pool = getCharacterCandidates()
const base = { key: 'C', now: 100, recentIds: [] as string[] }

describe('getCharacterCandidates', () => {
  it('is every primary-capable scene that has a mood tag, regardless of which mood', () => {
    expect(pool.length).toBeGreaterThan(10)
    for (const s of pool) {
      expect(s.metadata.roles).toContain('primary')
      expect(s.metadata.moods.length).toBeGreaterThan(0)
    }
    // Wider than any single mood's pool: that filter is what caused the overlap.
    const ambient = SCENES.filter((s) => s.metadata.moods.includes('ambient') && s.metadata.roles.includes('primary'))
    expect(pool.length).toBeGreaterThan(ambient.length)
  })
})

describe('pickByCharacter', () => {
  it('returns null (so the caller falls back) until the character read is valid', () => {
    expect(pickByCharacter(pool, { ...base, character: character({ valid: false }) })).toBeNull()
    expect(pickByCharacter(pool, { ...base, character: character({ primary: null }) })).toBeNull()
    expect(pickByCharacter([], { ...base, character: character() })).toBeNull()
  })

  it('returns one of the candidates and honours exclude', () => {
    const ids = new Set(pool.map((s) => s.id))
    const r = rng(1)
    for (let i = 0; i < 60; i++) {
      const pick = pickByCharacter(pool, { ...base, character: character(), rng: r, exclude: [pool[0].id] })
      expect(pick).not.toBeNull()
      expect(ids.has(pick!.id)).toBe(true)
      expect(pick!.id).not.toBe(pool[0].id)
    }
  })

  it('different character picks different scenes: calm/dark vs frantic/bright', () => {
    const count = (c: Partial<CharacterState>) => {
      const r = rng(7)
      const tally = new Map<string, number>()
      for (let i = 0; i < 300; i++) {
        const s = pickByCharacter(pool, { ...base, now: 100 + i * 0.001, key: `k${i % 5}`, character: character(c), rng: r })
        if (s) tally.set(s.id, (tally.get(s.id) ?? 0) + 1)
      }
      return tally
    }
    const calm = count({ primary: 'melancholic', valence: 0.15, arousal: 0.2, tension: 0.35, pulse: 0.3 })
    const hot = count({ primary: 'euphoric', valence: 0.93, arousal: 0.9, tension: 0.15, pulse: 0.85 })
    const top = (t: Map<string, number>) => [...t.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id]) => id)
    const a = new Set(top(calm))
    const b = new Set(top(hot))
    const shared = [...a].filter((id) => b.has(id))
    expect(shared.length).toBeLessThanOrEqual(1)
  })

  it('recent scenes are avoided when alternatives exist', () => {
    const r = rng(3)
    const recent = pool.slice(0, 3).map((s) => s.id)
    let hits = 0
    for (let i = 0; i < 200; i++) {
      const s = pickByCharacter(pool, { ...base, character: character(), rng: r, recentIds: recent })
      if (s && recent.includes(s.id)) hits++
    }
    expect(hits).toBeLessThan(10)
  })

  it('minArousal lifts the arousal used for the pick (drop pre-arm)', () => {
    const r = rng(11)
    const arousalOf = (id: string) => getScene(id)
    const calm = character({ primary: 'serene', valence: 0.7, arousal: 0.1, tension: 0.1, pulse: 0.2 })
    let plain = 0
    let lifted = 0
    const n = 200
    for (let i = 0; i < n; i++) {
      const p = pickByCharacter(pool, { ...base, character: calm, rng: r })
      const l = pickByCharacter(pool, { ...base, character: calm, rng: r, minArousal: 0.9 })
      if (p) plain += 1
      if (l) lifted += 1
      expect(arousalOf((p ?? l)!.id)).toBeTruthy()
    }
    expect(plain).toBe(n)
    expect(lifted).toBe(n)
  })

  it('the per-song seed changes the cast on its own, and songs with the same character still vary', () => {
    const keys = ['C', 'D', 'E', 'F', 'G', 'A', 'B', 'Db']
    const pickFor = (song: number, seedMatters: boolean) => {
      // An invalid gap resets the per-song seed tracker, like a source change.
      pickByCharacter(pool, { ...base, character: character({ valid: false }) })
      return pickByCharacter(pool, {
        ...base,
        key: seedMatters ? keys[song % 8] : 'C',
        now: 100 + song,
        character: character({ valence: 0.6 + (song % 4) * 0.02 }),
        rng: () => 0.37, // frozen draw: any difference can only come from the song seed
      })
    }
    // (a) Seed alone (identical random draw) must change at least one outcome.
    const withSeed = new Set<string>()
    for (let song = 0; song < 24; song++) withSeed.add(pickFor(song, true)!.id)
    const withoutSeed = new Set<string>()
    for (let song = 0; song < 24; song++) withoutSeed.add(pickFor(song, false)!.id)
    expect(withSeed.size).toBeGreaterThanOrEqual(withoutSeed.size)
    expect(withSeed.size).toBeGreaterThanOrEqual(2)

    // (b) Realistic use (each song has its own random draws): a same-character song set is not one scene.
    const firstPicks = new Set<string>()
    for (let song = 0; song < 24; song++) {
      pickByCharacter(pool, { ...base, character: character({ valid: false }) })
      const s = pickByCharacter(pool, { ...base, key: keys[song % 8], now: 100 + song, character: character(), rng: rng(1000 + song) })
      if (s) firstPicks.add(s.id)
    }
    expect(firstPicks.size).toBeGreaterThanOrEqual(4)
  })

  it('a song keeps its cast steady: the seed does not re-roll on small character drift', () => {
    const r = () => 0.5 // no randomness: any difference would come from the seed
    pickByCharacter(pool, { ...base, character: character({ valid: false }) })
    const a = pickByCharacter(pool, { ...base, now: 10, character: character(), rng: r })
    const b = pickByCharacter(pool, { ...base, now: 40, character: character({ valence: 0.63, arousal: 0.52 }), rng: r })
    expect(a?.id).toBe(b?.id)
  })
})
