import { describe, expect, it } from 'vitest'
import { createEmptyCharacterState, type CharacterState } from '../../audio/characterTypes'
import { getCharacterCandidates, getScene, SCENES } from '../../scenes'
import { SCENE_CHARACTER } from '../../scenes/character'
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

/**
 * The lift: `minArousal` / `minTension` move the point the picker fits, so a build or a drop can reach scenes a
 * boost alone never could (affinity is raised to ^3.5 before any boost is applied).
 */
describe('pickByCharacter: lift (minArousal / minTension move the pick point)', () => {
  const picks = (o: Partial<Parameters<typeof pickByCharacter>[1]>, n = 400, seed = 21) => {
    // A new source resets the per-song seed tracker so each call sees the same cast.
    pickByCharacter(pool, { ...base, character: character({ valid: false }) })
    const r = rng(seed)
    const out: string[] = []
    for (let i = 0; i < n; i++) {
      const p = pickByCharacter(pool, { ...base, character: character(), rng: r, ...o })
      if (p) out.push(p.id)
    }
    return out
  }
  const mean = (ids: readonly string[], f: (id: string) => number) => ids.reduce((s, id) => s + f(id), 0) / ids.length
  const arousalOf = (id: string) => SCENE_CHARACTER[id].arousal
  const tensionOf = (id: string) => SCENE_CHARACTER[id].tension
  const calm = { primary: 'serene' as const, valence: 0.6, arousal: 0.1, tension: 0.1, pulse: 0.5 }
  const relaxed = { primary: 'groove' as const, valence: 0.6, arousal: 0.55, tension: 0.05, pulse: 0.6 }

  it('minArousal moves the point: a calm passage then picks high-arousal scenes', () => {
    const plain = picks({ character: character(calm) })
    const lifted = picks({ character: character(calm), minArousal: 0.9 })
    expect(mean(lifted, arousalOf)).toBeGreaterThan(mean(plain, arousalOf) + 0.2)
    // ...and the plain calm pick reaches essentially none of the frantic scenes.
    expect(plain.filter((id) => arousalOf(id) >= 0.75).length).toBeLessThan(10)
    expect(lifted.filter((id) => arousalOf(id) >= 0.75).length).toBeGreaterThan(100)
  })

  it('minTension moves the point: a relaxed passage then picks tense scenes', () => {
    const plain = picks({ character: character(relaxed) })
    const lifted = picks({ character: character(relaxed), minTension: 0.85 })
    expect(mean(lifted, tensionOf)).toBeGreaterThan(mean(plain, tensionOf) + 0.12)
    expect(lifted.filter((id) => tensionOf(id) >= 0.55).length).toBeGreaterThan(plain.filter((id) => tensionOf(id) >= 0.55).length + 60)
  })

  it('the two floors combine (a lifted point is both more aroused and more tense)', () => {
    const plain = picks({ character: character(calm) })
    const both = picks({ character: character(calm), minArousal: 0.8, minTension: 0.7 })
    expect(mean(both, arousalOf)).toBeGreaterThan(mean(plain, arousalOf) + 0.15)
    expect(mean(both, tensionOf)).toBeGreaterThan(mean(plain, tensionOf) + 0.1)
  })

  it('a floor at or below the actual value changes nothing (it only ever raises)', () => {
    const c = character({ arousal: 0.6, tension: 0.5 })
    const plain = picks({ character: c })
    expect(picks({ character: c, minArousal: 0.6, minTension: 0.5 })).toEqual(plain)
    expect(picks({ character: c, minArousal: 0.2, minTension: 0.1 })).toEqual(plain)
    expect(picks({ character: c, minTension: 0 })).toEqual(plain)
  })

  it('without minTension / liftSecondary the pick is exactly what it was (legacy path unchanged)', () => {
    // minArousal alone, the way the drop pre-arm uses it: identical draw for draw with an explicit undefined.
    const a = picks({ character: character(calm), minArousal: 0.85 })
    const b = picks({ character: character(calm), minArousal: 0.85, minTension: undefined, liftSecondary: undefined })
    const c = picks({ character: character(calm), minArousal: 0.85, liftSecondary: false })
    expect(b).toEqual(a)
    expect(c).toEqual(a)
  })

  it('liftSecondary also lifts the runner-up mood, which otherwise keeps pulling calm scenes in', () => {
    // Serene primary, a very calm runner-up carrying half the blend: unlifted it drags a lifted pick back to calm.
    const cs = character({ ...calm, secondary: 'melancholic', secondaryWeight: 0.5 })
    const primaryOnly = picks({ character: cs, minArousal: 0.85, minTension: 0.5 })
    const both = picks({ character: cs, minArousal: 0.85, minTension: 0.5, liftSecondary: true })
    expect(mean(both, arousalOf)).toBeGreaterThan(mean(primaryOnly, arousalOf) + 0.04)
    // Nothing about the runner-up is touched without the flag.
    expect(picks({ character: cs, minArousal: 0.85, minTension: 0.5, liftSecondary: false })).toEqual(primaryOnly)
  })

  it('still honours exclude and returns pool members under a lift', () => {
    const ids = new Set(pool.map((s) => s.id))
    pickByCharacter(pool, { ...base, character: character({ valid: false }) })
    const r = rng(5)
    for (let i = 0; i < 80; i++) {
      const p = pickByCharacter(pool, {
        ...base,
        character: character(calm),
        rng: r,
        exclude: ['plasma', 'beats'],
        minArousal: 0.9,
        minTension: 0.6,
        liftSecondary: true,
      })
      expect(p).not.toBeNull()
      expect(ids.has(p!.id)).toBe(true)
      expect(['plasma', 'beats']).not.toContain(p!.id)
    }
  })

  it('returns null under a lift while the character read is not valid (the caller falls back)', () => {
    expect(pickByCharacter(pool, { ...base, character: character({ valid: false }), minArousal: 0.9, minTension: 0.6 })).toBeNull()
  })
})
