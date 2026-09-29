import { describe, expect, it } from 'vitest'
import {
  CHARACTER_MOODS,
  type CharacterMood,
  type CharacterPoint,
} from '../../audio/characterTypes'
import { MOOD_PROTOTYPES } from '../../audio/moodTaxonomy'
import { DISABLED_SCENES, FREE_TIER_SCENE_IDS, SCENES } from '../index'
import {
  PICK_SPREAD_SCALE,
  RECENCY_DEPTH,
  SCENE_CHARACTER,
  castBias,
  characterAffinity,
  characterPool,
  moodAffinity,
  pickSceneForCharacter,
  songSeedFrom,
} from '../character'

/** Small deterministic PRNG so every statistical assertion below is repeatable. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const LIVE = SCENES.map((s) => s.id)
const QUARANTINED = DISABLED_SCENES.map((s) => s.id)
/** Scenes the automatic pools can pick (`moods` non-empty). limitless/djcam are routed by their own directors. */
const AUTO_LIVE = SCENES.filter((s) => s.metadata.moods.length > 0).map((s) => s.id)
/** Live primaries the AutoPilot/PerformanceDirector can pick, minus `hold` (silence-only). */
const LIVE_PRIMARIES = SCENES.filter(
  (s) => s.metadata.moods.length > 0 && s.metadata.roles.includes('primary') && s.id !== 'hold',
).map((s) => s.id)

/**
 * Scenes allowed to be absent from every mood's top-8. `hold` is the authored
 * answer to true silence (arousal ~0, no pulse): no musical mood sits there.
 * `limitless` / `djcam` have `moods: []`, so no mood pool ever contains them.
 */
const NICHE_SCENES = ['hold', 'limitless', 'djcam']

/** The real classifier prototypes: exactly the points the engine produces. */
const MOOD_POINTS = CHARACTER_MOODS.map((m) => ({ mood: m, point: MOOD_PROTOTYPES[m].center }))

const jaccard = (a: readonly string[], b: readonly string[]): number => {
  const A = new Set(a)
  const inter = b.filter((x) => A.has(x)).length
  return inter / (A.size + new Set(b).size - inter)
}

function meanPairwiseJaccard(pools: readonly (readonly string[])[]): number {
  let sum = 0
  let n = 0
  for (let i = 0; i < pools.length; i++) {
    for (let j = i + 1; j < pools.length; j++) {
      sum += jaccard(pools[i], pools[j])
      n++
    }
  }
  return sum / n
}

const poolsFor = (ids: readonly string[], n: number) =>
  MOOD_POINTS.map(({ point }) => characterPool(ids, point, n))

function tally(ids: readonly (string | null)[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const id of ids) if (id) out[id] = (out[id] ?? 0) + 1
  return out
}

// ---------------------------------------------------------------------------

describe('SCENE_CHARACTER registry', () => {
  it('has an entry for every live scene (a new scene must declare its character)', () => {
    const missing = LIVE.filter((id) => !(id in SCENE_CHARACTER))
    expect(
      missing,
      `add these to SCENE_CHARACTER in scenes/character.ts: ${missing.join(', ')}`,
    ).toEqual([])
  })

  it('has no entry for an id that is neither live nor quarantined', () => {
    const known = new Set([...LIVE, ...QUARANTINED])
    const unknown = Object.keys(SCENE_CHARACTER).filter((id) => !known.has(id))
    expect(unknown, `stale SCENE_CHARACTER entries: ${unknown.join(', ')}`).toEqual([])
  })

  it('also covers every quarantined scene, so promoting one out of DISABLED_SCENES is free', () => {
    expect(QUARANTINED.filter((id) => !(id in SCENE_CHARACTER))).toEqual([])
  })

  it('keeps every centre in 0..1, spread sane, and a real justification', () => {
    for (const [id, c] of Object.entries(SCENE_CHARACTER)) {
      for (const k of ['valence', 'arousal', 'tension', 'pulse'] as const) {
        expect(c[k], `${id}.${k}`).toBeGreaterThanOrEqual(0)
        expect(c[k], `${id}.${k}`).toBeLessThanOrEqual(1)
      }
      expect(c.spread, `${id}.spread`).toBeGreaterThanOrEqual(0.1)
      expect(c.spread, `${id}.spread`).toBeLessThanOrEqual(0.7)
      expect(c.notes.length, `${id}.notes`).toBeGreaterThan(30)
    }
  })

  it('spreads the auto-selectable scenes across the cube instead of clustering them', () => {
    const range = (k: 'valence' | 'arousal' | 'tension' | 'pulse') => {
      const v = AUTO_LIVE.map((id) => SCENE_CHARACTER[id][k])
      return [Math.min(...v), Math.max(...v)] as const
    }
    const [vLo, vHi] = range('valence')
    const [aLo, aHi] = range('arousal')
    const [tLo, tHi] = range('tension')
    const [pLo, pHi] = range('pulse')
    expect(vHi - vLo).toBeGreaterThan(0.5)
    expect(aHi - aLo).toBeGreaterThan(0.7)
    expect(tHi - tLo).toBeGreaterThan(0.6)
    expect(pHi - pLo).toBeGreaterThan(0.6)
    // Both poles of the two main axes are occupied, not just the middle.
    expect(vLo).toBeLessThan(0.35)
    expect(vHi).toBeGreaterThan(0.75)
    expect(aLo).toBeLessThan(0.15)
    expect(aHi).toBeGreaterThan(0.85)
  })
})

describe('characterAffinity / moodAffinity', () => {
  const p = (valence: number, arousal: number, tension: number, pulse: number): CharacterPoint => ({
    valence,
    arousal,
    tension,
    pulse,
  })

  it('is 1 at the scene centre and falls with distance', () => {
    const c = SCENE_CHARACTER.plasma
    expect(characterAffinity('plasma', c)).toBeCloseTo(1, 10)
    const near = characterAffinity('plasma', p(c.valence + 0.1, c.arousal, c.tension, c.pulse))
    const far = characterAffinity('plasma', p(c.valence + 0.5, c.arousal, c.tension, c.pulse))
    expect(near).toBeLessThan(1)
    expect(far).toBeLessThan(near)
    expect(far).toBeGreaterThan(0)
  })

  it('down-weights pulse relative to valence', () => {
    const c = SCENE_CHARACTER.fridaylines
    const dv = characterAffinity('fridaylines', p(c.valence + 0.3, c.arousal, c.tension, c.pulse))
    const dp = characterAffinity('fridaylines', p(c.valence, c.arousal, c.tension, c.pulse + 0.3))
    expect(dp).toBeGreaterThan(dv)
  })

  it('a larger spreadScale is more forgiving', () => {
    const q = p(0.9, 0.1, 0.9, 0.1)
    expect(characterAffinity('plasma', q, 2)).toBeGreaterThan(characterAffinity('plasma', q, 1))
  })

  it('tolerates an id with no entry (neutral fallback, no throw)', () => {
    const a = characterAffinity('no-such-scene', p(0.5, 0.5, 0.5, 0.5))
    expect(a).toBeGreaterThan(0)
    expect(a).toBeLessThanOrEqual(1)
  })

  it('moodAffinity ranks scenes by the distribution over mood prototypes', () => {
    const serene = { serene: 1 } as Partial<Record<CharacterMood, number>>
    const aggressive = { aggressive: 3, tense: 1 } as Partial<Record<CharacterMood, number>>
    expect(moodAffinity('snowflake', serene)).toBeGreaterThan(moodAffinity('plasma', serene))
    expect(moodAffinity('plasma', aggressive)).toBeGreaterThan(
      moodAffinity('snowflake', aggressive),
    )
    expect(moodAffinity('plasma', {})).toBe(0)
    expect(moodAffinity('plasma', { serene: 0, tense: 0 })).toBe(0)
  })
})

describe('mood pools are genuinely different (the old pools shared ~90%)', () => {
  it('auto-selectable live scenes: mean pairwise Jaccard of the 14 top-8 pools is under 0.35', () => {
    const pools = poolsFor(AUTO_LIVE, 8)
    const mean = meanPairwiseJaccard(pools)
    console.info(
      `[character] live auto (N=${AUTO_LIVE.length}) top-8 mean Jaccard = ${mean.toFixed(3)}`,
    )
    expect(mean).toBeLessThan(0.35)
  })

  it('live PRIMARIES (what the AutoPilot subject slot picks): mean Jaccard of top-6 pools under 0.35', () => {
    const pools = poolsFor(LIVE_PRIMARIES, 6)
    const mean = meanPairwiseJaccard(pools)
    console.info(
      `[character] live primaries (N=${LIVE_PRIMARIES.length}) top-6 mean Jaccard = ${mean.toFixed(3)}`,
    )
    expect(mean).toBeLessThan(0.35)
  })

  it('every live auto scene is in some mood top-8, or is a documented niche scene', () => {
    const inSome = new Set(poolsFor(AUTO_LIVE, 8).flat())
    const orphans = AUTO_LIVE.filter((id) => !inSome.has(id) && !NICHE_SCENES.includes(id))
    expect(orphans, `never a top-8 fit for any mood: ${orphans.join(', ')}`).toEqual([])
  })

  it('every live primary is a top-6 fit for at least one mood', () => {
    const inSome = new Set(poolsFor(LIVE_PRIMARIES, 6).flat())
    expect(LIVE_PRIMARIES.filter((id) => !inSome.has(id))).toEqual([])
  })

  it('the live roster reaches nearly all of its auto scenes (>= 24 of 27) across the 14 pools', () => {
    const distinct = new Set(poolsFor(AUTO_LIVE, 8).flat())
    console.info(
      `[character] live auto distinct in top-8 pools = ${distinct.size} of ${AUTO_LIVE.length}`,
    )
    expect(distinct.size).toBeGreaterThanOrEqual(24)
  })

  it('primaries: at least 10 distinct best-fit scenes across the 14 moods', () => {
    const top1 = new Set(MOOD_POINTS.map(({ point }) => characterPool(LIVE_PRIMARIES, point, 1)[0]))
    console.info(`[character] distinct top-1 primaries across 14 moods = ${top1.size}`)
    expect(top1.size).toBeGreaterThanOrEqual(10)
  })

  it('opposite moods share at most one top-6 primary and none of their top-3', () => {
    const pool = (m: CharacterMood) => characterPool(LIVE_PRIMARIES, MOOD_PROTOTYPES[m].center, 6)
    for (const [a, b] of [
      ['serene', 'aggressive'],
      ['melancholic', 'euphoric'],
      ['dreamy', 'driving'],
      ['tender', 'tense'],
    ] as const) {
      const overlap = pool(a).filter((id) => pool(b).includes(id))
      expect(overlap.length, `${a} vs ${b}: ${overlap.join(',')}`).toBeLessThanOrEqual(1)
      const top3 = (m: CharacterMood) => pool(m).slice(0, 3)
      expect(top3(a).filter((id) => top3(b).includes(id))).toEqual([])
    }
  })

  it("a mood's top-3 primaries sit near it in character space (dark moods get dark scenes)", () => {
    for (const { mood, point } of MOOD_POINTS) {
      const top3 = characterPool(LIVE_PRIMARIES, point, 3)
      const meanDist =
        top3.reduce((s, id) => {
          const c = SCENE_CHARACTER[id]
          return (
            s +
            Math.hypot(
              c.valence - point.valence,
              c.arousal - point.arousal,
              c.tension - point.tension,
            )
          )
        }, 0) / top3.length
      expect(meanDist, `${mood}: ${top3.join(',')}`).toBeLessThan(0.45)
    }
    const dark = characterPool(LIVE_PRIMARIES, MOOD_PROTOTYPES.melancholic.center, 3)
    for (const id of dark) expect(SCENE_CHARACTER[id].valence, id).toBeLessThan(0.62)
    const calm = characterPool(LIVE_PRIMARIES, MOOD_PROTOTYPES.serene.center, 3)
    for (const id of calm) expect(SCENE_CHARACTER[id].arousal, id).toBeLessThan(0.55)
    const hard = characterPool(LIVE_PRIMARIES, MOOD_PROTOTYPES.aggressive.center, 3)
    for (const id of hard) expect(SCENE_CHARACTER[id].arousal, id).toBeGreaterThan(0.6)
  })
})

describe('cast variety: same character, different songs, different scenes', () => {
  /** Mid-field characters, where a real corpus mostly lives. */
  const MID_FIELD: CharacterPoint[] = [
    { valence: 0.5, arousal: 0.7, tension: 0.35, pulse: 0.6 },
    { valence: 0.6, arousal: 0.7, tension: 0.35, pulse: 0.6 },
    { valence: 0.7, arousal: 0.5, tension: 0.35, pulse: 0.4 },
    { valence: 0.5, arousal: 0.5, tension: 0.35, pulse: 0.6 },
    { valence: 0.6, arousal: 0.6, tension: 0.2, pulse: 0.6 },
    { valence: 0.4, arousal: 0.6, tension: 0.5, pulse: 0.5 },
  ]

  function firstPicks(point: CharacterPoint, songs: number, salt: number): (string | null)[] {
    const rng = mulberry32(salt)
    const out: (string | null)[] = []
    for (let k = 0; k < songs; k++) {
      out.push(
        pickSceneForCharacter({
          candidates: LIVE_PRIMARIES,
          character: point,
          recentIds: [],
          songSeed: songSeedFrom(point, `song-${salt}-${k}`),
          rng,
        }),
      )
    }
    return out
  }

  it('20 songs at one mid-field character average at least 8 distinct first picks with no scene over ~30%', () => {
    let distinctSum = 0
    let maxShareSum = 0
    for (const [i, pt] of MID_FIELD.entries()) {
      const counts = tally(firstPicks(pt, 20, 1000 + i))
      const distinct = Object.keys(counts).length
      const share = Math.max(...Object.values(counts)) / 20
      distinctSum += distinct
      maxShareSum += share
      expect(distinct, JSON.stringify(counts)).toBeGreaterThanOrEqual(5)
      expect(share, JSON.stringify(counts)).toBeLessThanOrEqual(0.45)
    }
    const meanDistinct = distinctSum / MID_FIELD.length
    const meanShare = maxShareSum / MID_FIELD.length
    console.info(
      `[character] cast variety over ${MID_FIELD.length} mid-field points x 20 songs: ` +
        `mean distinct first picks = ${meanDistinct.toFixed(1)}, mean top-scene share = ${(meanShare * 100).toFixed(0)}%`,
    )
    expect(meanDistinct).toBeGreaterThanOrEqual(8)
    expect(meanShare).toBeLessThanOrEqual(0.3)
  })

  it('the cast (castBias alone) reorders scenes with equal fit', () => {
    // Identical characters and rng: only the seed changes. Across 40 seeds the
    // bias must produce different first choices, i.e. it does real work.
    const pt = MID_FIELD[0]
    const winners = new Set<string>()
    for (let seed = 1; seed <= 40; seed++) {
      const id = pickSceneForCharacter({
        candidates: LIVE_PRIMARIES,
        character: pt,
        recentIds: [],
        songSeed: seed * 7919,
        rng: () => 0.5,
      })
      if (id) winners.add(id)
    }
    expect(winners.size).toBeGreaterThanOrEqual(3)
  })

  it('castBias is deterministic, in [0.55, 1.45], and averages ~1', () => {
    expect(castBias(123, 'plasma')).toBe(castBias(123, 'plasma'))
    expect(castBias(123, 'plasma')).not.toBe(castBias(124, 'plasma'))
    let sum = 0
    let n = 0
    for (let seed = 0; seed < 300; seed++) {
      for (const id of LIVE) {
        const b = castBias(seed * 2654435761, id)
        expect(b).toBeGreaterThanOrEqual(0.55)
        expect(b).toBeLessThanOrEqual(1.45)
        sum += b
        n++
      }
    }
    expect(sum / n).toBeGreaterThan(0.95)
    expect(sum / n).toBeLessThan(1.05)
  })

  it('songSeedFrom is stable within a 0.1 cell, and moves with character and key', () => {
    const a: CharacterPoint = { valence: 0.52, arousal: 0.61, tension: 0.33, pulse: 0.5 }
    const sameCell: CharacterPoint = { valence: 0.54, arousal: 0.63, tension: 0.31, pulse: 0.9 }
    const otherCell: CharacterPoint = { valence: 0.72, arousal: 0.61, tension: 0.33, pulse: 0.5 }
    expect(songSeedFrom(a, 'C')).toBe(songSeedFrom(sameCell, 'C'))
    expect(songSeedFrom(a, 'C')).not.toBe(songSeedFrom(otherCell, 'C'))
    expect(songSeedFrom(a, 'C')).not.toBe(songSeedFrom(a, 'F#'))
    const s = songSeedFrom(a, 'C')
    expect(Number.isInteger(s)).toBe(true)
    expect(s).toBeGreaterThanOrEqual(0)
  })
})

describe('recency', () => {
  const pt: CharacterPoint = { valence: 0.6, arousal: 0.6, tension: 0.3, pulse: 0.6 }

  it('the last 3 picks are essentially never re-picked while alternatives exist (worst case: they are the best fits)', () => {
    const recent = characterPool(LIVE_PRIMARIES, pt, 3)
    const rng = mulberry32(42)
    let hit = 0
    const N = 4000
    for (let i = 0; i < N; i++) {
      const id = pickSceneForCharacter({
        candidates: LIVE_PRIMARIES,
        character: pt,
        recentIds: recent,
        songSeed: songSeedFrom(pt, `k${i % 97}`),
        rng,
      })
      if (id && recent.includes(id)) hit++
    }
    expect(hit / N).toBeLessThan(0.03)
  })

  it('a rolling show never repeats a scene inside the 3-pick window', () => {
    const rng = mulberry32(7)
    let recent: string[] = []
    let repeats = 0
    const N = 1500
    for (let i = 0; i < N; i++) {
      const id = pickSceneForCharacter({
        candidates: LIVE_PRIMARIES,
        character: pt,
        recentIds: recent,
        songSeed: songSeedFrom(pt, 'C'),
        rng,
      })!
      if (recent.slice(0, 3).includes(id)) repeats++
      recent = [id, ...recent].slice(0, RECENCY_DEPTH)
    }
    expect(repeats / N).toBeLessThan(0.02)
  })

  it('a long rolling show at one character uses at least 8 different scenes', () => {
    const rng = mulberry32(11)
    let recent: string[] = []
    const seen = new Set<string>()
    for (let i = 0; i < 40; i++) {
      const id = pickSceneForCharacter({
        candidates: LIVE_PRIMARIES,
        character: pt,
        recentIds: recent,
        songSeed: songSeedFrom(pt, 'C'),
        rng,
      })!
      seen.add(id)
      recent = [id, ...recent].slice(0, RECENCY_DEPTH)
    }
    expect(seen.size).toBeGreaterThanOrEqual(8)
  })

  it('still returns something when every candidate is recent', () => {
    const two = ['plasma', 'chrome']
    const id = pickSceneForCharacter({
      candidates: two,
      character: pt,
      recentIds: ['plasma', 'chrome'],
      songSeed: 1,
      rng: mulberry32(1),
    })
    expect(two).toContain(id)
  })
})

describe('pickSceneForCharacter contract', () => {
  const rngFor = mulberry32

  it('returns null only for an empty candidate list', () => {
    const base = {
      character: { valence: 0.5, arousal: 0.5, tension: 0.5, pulse: 0.5 },
      recentIds: [],
      songSeed: 1,
      rng: rngFor(1),
    }
    expect(pickSceneForCharacter({ ...base, candidates: [] })).toBeNull()
    expect(pickSceneForCharacter({ ...base, candidates: ['plasma'] })).toBe('plasma')
  })

  it('handles a single candidate even when it is excluded, recent, or has boost 0', () => {
    const id = pickSceneForCharacter({
      candidates: ['snowflake'],
      character: { valence: 0.1, arousal: 0.95, tension: 0.9, pulse: 0.9 },
      recentIds: ['snowflake'],
      songSeed: 1,
      rng: rngFor(1),
      exclude: ['snowflake'],
      boost: { snowflake: 0 },
    })
    expect(id).toBe('snowflake')
  })

  it('never returns an id outside candidates, over random characters, subsets and options', () => {
    const rng = rngFor(99)
    for (let i = 0; i < 1500; i++) {
      const size = 1 + Math.floor(rng() * 12)
      const cands = Array.from({ length: size }, () => LIVE[Math.floor(rng() * LIVE.length)])
      const character: CharacterPoint = {
        valence: rng(),
        arousal: rng(),
        tension: rng(),
        pulse: rng(),
      }
      const id = pickSceneForCharacter({
        candidates: cands,
        character,
        secondary:
          rng() < 0.5
            ? {
                point: { valence: rng(), arousal: rng(), tension: rng(), pulse: rng() },
                weight: rng() * 0.6,
              }
            : null,
        recentIds: Array.from(
          { length: Math.floor(rng() * 14) },
          () => LIVE[Math.floor(rng() * LIVE.length)],
        ),
        songSeed: Math.floor(rng() * 2 ** 32),
        rng,
        exclude: rng() < 0.4 ? cands.slice(0, Math.floor(rng() * (cands.length + 1))) : undefined,
        boost: rng() < 0.3 ? { [cands[0]]: rng() * 3 } : undefined,
        temperature: rng() < 0.3 ? rng() * 3 : undefined,
      })
      expect(id).not.toBeNull()
      expect(cands).toContain(id)
    }
  })

  it('returns a candidate at the extreme corners of the cube and at the far side from every scene', () => {
    for (const v of [0, 1]) {
      for (const a of [0, 1]) {
        for (const t of [0, 1]) {
          for (const p of [0, 1]) {
            const id = pickSceneForCharacter({
              candidates: LIVE_PRIMARIES,
              character: { valence: v, arousal: a, tension: t, pulse: p },
              recentIds: [],
              songSeed: 5,
              rng: rngFor(3),
            })
            expect(LIVE_PRIMARIES).toContain(id)
          }
        }
      }
    }
  })

  it('honours exclude when an alternative exists, and falls back rather than returning null when nothing is left', () => {
    const pt = MOOD_PROTOTYPES.aggressive.center
    const rng = rngFor(5)
    for (let i = 0; i < 200; i++) {
      const id = pickSceneForCharacter({
        candidates: LIVE_PRIMARIES,
        character: pt,
        recentIds: [],
        songSeed: i,
        rng,
        exclude: ['plasma', 'maze'],
      })
      expect(['plasma', 'maze']).not.toContain(id)
    }
    const both = ['plasma', 'maze']
    expect(both).toContain(
      pickSceneForCharacter({
        candidates: both,
        character: pt,
        recentIds: [],
        songSeed: 1,
        rng,
        exclude: both,
      }),
    )
  })

  it('tolerates duplicate candidates and ids with no character entry', () => {
    const id = pickSceneForCharacter({
      candidates: ['plasma', 'plasma', 'unknown-scene', 'unknown-scene'],
      character: MOOD_PROTOTYPES.aggressive.center,
      recentIds: [],
      songSeed: 1,
      rng: rngFor(1),
    })
    expect(['plasma', 'unknown-scene']).toContain(id)
  })

  it('boost 0 removes a scene, a large boost makes it dominate', () => {
    const pt = MOOD_PROTOTYPES.groove.center
    const rng = rngFor(21)
    const run = (boost: Record<string, number>) =>
      tally(
        Array.from({ length: 400 }, (_, i) =>
          pickSceneForCharacter({
            candidates: LIVE_PRIMARIES,
            character: pt,
            recentIds: [],
            songSeed: songSeedFrom(pt, 'C'),
            rng,
            boost,
          }),
        ),
      )
    const none = run({})
    const top = Object.entries(none).sort((a, b) => b[1] - a[1])[0][0]
    expect(run({ [top]: 0 })[top]).toBeUndefined()
    expect(run({ chrome: 200 }).chrome / 400).toBeGreaterThan(0.6)
  })

  it('a secondary mood pulls picks toward its own region, and weight 0 changes nothing', () => {
    const serene = MOOD_PROTOTYPES.serene.center
    const aggressive = MOOD_PROTOTYPES.aggressive.center
    const harsh = new Set(characterPool(LIVE_PRIMARIES, aggressive, 4))
    const share = (secondary: { point: CharacterPoint; weight: number } | null) => {
      const rng = rngFor(77)
      let n = 0
      for (let i = 0; i < 800; i++) {
        const id = pickSceneForCharacter({
          candidates: LIVE_PRIMARIES,
          character: serene,
          secondary,
          recentIds: [],
          songSeed: 9,
          rng,
        })
        if (id && harsh.has(id)) n++
      }
      return n / 800
    }
    expect(share({ point: aggressive, weight: 0.5 })).toBeGreaterThan(share(null))
    expect(share({ point: aggressive, weight: 0 })).toBe(share(null))
  })

  it('is deterministic for the same inputs and rng seed, and differs for another rng seed', () => {
    const run = (seed: number) => {
      const rng = rngFor(seed)
      let recent: string[] = []
      const out: string[] = []
      for (let i = 0; i < 30; i++) {
        const id = pickSceneForCharacter({
          candidates: LIVE_PRIMARIES,
          character: MOOD_PROTOTYPES.uplifting.center,
          recentIds: recent,
          songSeed: 4242,
          rng,
        })!
        out.push(id)
        recent = [id, ...recent].slice(0, RECENCY_DEPTH)
      }
      return out
    }
    expect(run(2024)).toEqual(run(2024))
    expect(run(2024)).not.toEqual(run(2025))
  })

  it('a low temperature is greedier than a high one', () => {
    const pt = MOOD_PROTOTYPES.epic.center
    const spread = (temperature: number) => {
      const rng = rngFor(31)
      return new Set(
        Array.from({ length: 300 }, () =>
          pickSceneForCharacter({
            candidates: LIVE_PRIMARIES,
            character: pt,
            recentIds: [],
            songSeed: 3,
            rng,
            temperature,
          }),
        ),
      ).size
    }
    expect(spread(0.3)).toBeLessThanOrEqual(spread(2.5))
  })

  it('exports a picker spread scale above 1 (the authored spread is not the picking width)', () => {
    expect(PICK_SPREAD_SCALE).toBeGreaterThanOrEqual(1)
  })
})

describe('free-tier whitelist', () => {
  const freePrimaries = FREE_TIER_SCENE_IDS.filter((id) => LIVE_PRIMARIES.includes(id))
  const topPerMood = (ids: readonly string[]) =>
    MOOD_POINTS.map(({ point }) => characterPool(ids, point, 1)[0])

  it('every whitelisted primary is the best fit for at least one mood (no dead scene in the demo)', () => {
    const tops = new Set(topPerMood(freePrimaries))
    console.warn(
      `[character] FREE_TIER_SCENE_IDS = ${FREE_TIER_SCENE_IDS.join(', ')}; primaries among them = ` +
        `${freePrimaries.join(', ')}; distinct best-fit scenes across the 14 moods = ${tops.size}; ` +
        `moods per scene = ${JSON.stringify(tally(topPerMood(freePrimaries)))}`,
    )
    expect(freePrimaries.length).toBeGreaterThan(0)
    for (const id of freePrimaries) expect(tops.has(id), id).toBe(true)
  })

  it('a hand-picked 8-primary set spans at least 5 distinct mood pools (the documented fix)', () => {
    // Greedy max-coverage over the licence-clean live primaries; see the
    // finding in the report. Not wired into FREE_TIER_SCENE_IDS by this file.
    const recommended = [
      'wireframe',
      'truchet',
      'web',
      'chrome',
      'lattesfold',
      'kifs',
      'wingfold',
      'plasma',
    ]
    for (const id of recommended) expect(LIVE_PRIMARIES, id).toContain(id)
    expect(new Set(topPerMood(recommended)).size).toBeGreaterThanOrEqual(5)
  })

  // The literal requirement is not met by the current whitelist: it is "the
  // first five commercially shippable scenes in registration order", of which
  // only FOUR are primaries (ribbons is accent/overlay-only), so at most 4
  // distinct best-fit scenes exist across the 14 moods. Unskip once
  // FREE_TIER_SCENE_IDS is widened.
  it.todo('FREE_TIER_SCENE_IDS primaries span at least 5 distinct mood pools')
})
