import { describe, expect, it } from 'vitest'
import { MOOD_PROTOTYPES } from '../../audio/moodTaxonomy'
import { CHARACTER_MOODS } from '../../audio/characterTypes'
import { pickPaletteWithRecall } from '../AutoPilot'
import { PALETTES, registerPalette } from '../palettes'
import { paletteAffinity, paletteCharacters, palettePool, pickPaletteByCharacter } from '../paletteCharacter'

const ids = () => PALETTES.map((p) => p.id)
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length

function pick(over: Partial<Parameters<typeof pickPaletteByCharacter>[0]> = {}) {
  return pickPaletteByCharacter({
    character: { valence: 0.6, arousal: 0.5, tension: 0.3 },
    current: '',
    recentIds: [],
    keyFamily: '',
    songSeed: 1,
    rotation: 0,
    ...over,
  })
}

describe('paletteCharacters (derived from colours)', () => {
  it('places every palette in 0..1 on all three axes and spreads the roster over the range', () => {
    const m = paletteCharacters()
    expect(m.size).toBe(PALETTES.length)
    for (const axis of ['valence', 'arousal', 'tension'] as const) {
      const vals = [...m.values()].map((c) => c[axis])
      for (const v of vals) {
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(1)
      }
      // Rank-normalised: the roster reaches both ends instead of bunching in a band.
      expect(Math.min(...vals)).toBeLessThan(0.08)
      expect(Math.max(...vals)).toBeGreaterThan(0.92)
    }
  })

  it('matches colour intuition: hot palettes are more arousing than cool ones, complementary ones more tense', () => {
    const m = paletteCharacters()
    const a = (id: string) => m.get(id)!.arousal
    const t = (id: string) => m.get(id)!.tension
    expect(a('ember')).toBeGreaterThan(a('glacial'))
    expect(a('solar')).toBeGreaterThan(a('ocean'))
    expect(a('sodium')).toBeGreaterThan(a('aurora'))
    expect(a('neon')).toBeGreaterThan(a('pearl'))
    expect(a('mono')).toBeLessThan(0.15)
    expect(t('cobalt')).toBeGreaterThan(t('ocean'))
    expect(t('prism')).toBeGreaterThan(t('glacial'))
  })

  it('places a palette registered later automatically', () => {
    const before = paletteCharacters().size
    registerPalette({
      id: '__test_hot',
      name: 'test',
      family: 'bold',
      slots: { bg: '#000000', shadow: '#200000', mid: '#ff2000', accent: '#ff8000', glow: '#ffff00' },
    })
    const after = paletteCharacters()
    expect(after.size).toBe(before + 1)
    expect(after.get('__test_hot')!.arousal).toBeGreaterThan(0.6)
  })
})

describe('pickPaletteByCharacter', () => {
  it('never returns the palette already showing and is deterministic', () => {
    for (let rot = 0; rot < 80; rot++) {
      const p = pick({ current: 'aurora', rotation: rot, songSeed: rot * 7 })
      expect(p).not.toBe('aurora')
      expect(ids()).toContain(p)
      expect(pick({ current: 'aurora', rotation: rot, songSeed: rot * 7 })).toBe(p)
    }
  })

  it('follows the music: a calm, dark passage and a hot, tense one get clearly different palettes', () => {
    const calm = { valence: 0.7, arousal: 0.08, tension: 0.1 }
    const hot = { valence: 0.5, arousal: 0.97, tension: 0.6 }
    const arousalOf = (c: typeof calm) => {
      const m = paletteCharacters()
      const picks: number[] = []
      for (let rot = 0; rot < 120; rot++) picks.push(m.get(pick({ character: c, rotation: rot, songSeed: rot })!)!.arousal)
      return mean(picks)
    }
    expect(arousalOf(hot) - arousalOf(calm)).toBeGreaterThan(0.3)
    const a = new Set(palettePool(calm, 4))
    const b = new Set(palettePool(hot, 4))
    expect([...a].filter((id) => b.has(id))).toHaveLength(0)
  })

  it('different moods want different palettes: low overlap across the 14 mood prototypes, wide roster coverage', () => {
    const pools = CHARACTER_MOODS.map((m) => new Set(palettePool(MOOD_PROTOTYPES[m].center, 4)))
    let sum = 0
    let pairs = 0
    for (let i = 0; i < pools.length; i++) {
      for (let j = i + 1; j < pools.length; j++) {
        const inter = [...pools[i]].filter((x) => pools[j].has(x)).length
        sum += inter / (pools[i].size + pools[j].size - inter)
        pairs++
      }
    }
    expect(sum / pairs).toBeLessThan(0.4)
    const covered = new Set(pools.flatMap((p) => [...p]))
    expect(covered.size).toBeGreaterThanOrEqual(16)
  })

  it('recently shown palettes are avoided when alternatives exist', () => {
    const recent = palettePool({ valence: 0.6, arousal: 0.5, tension: 0.3 }, 3)
    let hits = 0
    for (let rot = 0; rot < 200; rot++) {
      if (recent.includes(pick({ recentIds: recent, rotation: rot, songSeed: rot })!)) hits++
    }
    expect(hits).toBeLessThan(200 * 0.2)
  })

  it('two songs with the same character favour different palettes (per-song seed)', () => {
    const firsts = new Set<string>()
    for (let song = 0; song < 30; song++) firsts.add(pick({ songSeed: song * 104729 + 3 })!)
    expect(firsts.size).toBeGreaterThanOrEqual(4)
  })

  describe('moodTarget (colour-target bonus)', () => {
    const c = { valence: 0.5, arousal: 0.5, tension: 0.5 }
    const warm = { sat: 1.3, temp: 1, contrast: 1 }
    const cool = { sat: 0.75, temp: -1, contrast: 1 }
    /** Isolates the bonus itself: dividing out the (unaffected) V/A/T base fit. */
    const bonusRatio = (id: string, target: Parameters<typeof paletteAffinity>[2]) =>
      paletteAffinity(id, c, target) / paletteAffinity(id, c)

    it('omitted, paletteAffinity and pickPaletteByCharacter are unchanged (regression guard)', () => {
      for (const id of ids()) {
        expect(paletteAffinity(id, c, undefined)).toBe(paletteAffinity(id, c))
      }
      for (let rot = 0; rot < 40; rot++) {
        const o = { character: c, current: 'aurora', recentIds: [], keyFamily: '', songSeed: rot * 13, rotation: rot }
        expect(pickPaletteByCharacter({ ...o, moodTarget: undefined })).toBe(pickPaletteByCharacter(o))
      }
    })

    it('a palette whose intrinsic colour matches the target gets a bigger bonus than a mismatched one', () => {
      // ember: the roster's most saturated-and-warm palette (by construction, hot orange/red/gold lit slots).
      // glacial / mono: cool, low-warmth palettes at the other end.
      expect(bonusRatio('ember', warm)).toBeGreaterThan(bonusRatio('glacial', warm))
      expect(bonusRatio('ember', warm)).toBeGreaterThan(bonusRatio('mono', warm))
      expect(bonusRatio('glacial', cool)).toBeGreaterThan(bonusRatio('ember', cool))
      expect(bonusRatio('mono', cool)).toBeGreaterThan(bonusRatio('ember', cool))
    })

    it('is a bonus only (never below 1) and bounded (never above the documented ceiling)', () => {
      const targets = [warm, cool, { sat: 1, temp: 0, contrast: 1 }, { sat: 0.9, temp: 0.4, contrast: 1.1 }]
      for (const id of ids()) {
        for (const target of targets) {
          const r = bonusRatio(id, target)
          expect(r).toBeGreaterThanOrEqual(1 - 1e-9)
          // MOOD_BONUS_MAX (1.15): see paletteCharacter.ts's own doc for why this magnitude was chosen
          // against KEY_FAMILY_BONUS (1.3).
          expect(r).toBeLessThanOrEqual(1.15 + 1e-9)
        }
      }
    })

    it('cannot override a decisive V/A/T mismatch: a poor-fit palette with a perfectly matching target still loses to a good-fit palette with a mismatched one', () => {
      // A character point squarely at ember's own derived position: ember is a ~perfect V/A/T fit there,
      // glacial/mono are decisively poor fits (orders of magnitude below, per the roster-coverage test above).
      const eChar = paletteCharacters().get('ember')!
      const cEmber = { valence: eChar.valence, arousal: eChar.arousal, tension: eChar.tension }
      // ember gets the WRONG (cool) colour target; glacial/mono get the matching one at max bonus.
      expect(paletteAffinity('ember', cEmber, cool)).toBeGreaterThan(paletteAffinity('glacial', cEmber, cool))
      expect(paletteAffinity('ember', cEmber, cool)).toBeGreaterThan(paletteAffinity('mono', cEmber, cool))
    })

    it("nudges pickPaletteByCharacter's distribution toward the top fit's own colour without excluding the rest", () => {
      // A moodTarget built to EXACTLY match the top-fit palette's own intrinsic colour (converting its
      // rank-normalised sat/warmth back into moodTarget units) gives it the maximum possible bonus, while its
      // rivals in the pool — which have their own, different colours — get a smaller one on average. The pick
      // is a deterministic function of (songSeed, rotation), so this is a fixed, reproducible comparison, not
      // a statistical one that could flip between runs.
      const bestFit = palettePool(c, 1)[0]
      const ch = paletteCharacters().get(bestFit)!
      const exact = { sat: 0.75 + ch.intrinsicSat * 0.55, temp: ch.intrinsicWarmth * 2 - 1, contrast: 1 }
      const rate = (target: typeof warm | undefined) => {
        let n = 0
        const N = 3000
        for (let rot = 0; rot < N; rot++) {
          const pick = pickPaletteByCharacter({ character: c, current: '', recentIds: [], keyFamily: '', songSeed: rot * 31, rotation: rot, moodTarget: target })
          if (pick === bestFit) n++
        }
        return n / N
      }
      const withoutTarget = rate(undefined)
      const withTarget = rate(exact)
      expect(withTarget).toBeGreaterThan(withoutTarget)
      // Still a NUDGE, not an override: the rest of the pool is not excluded from the rotation.
      const seen = new Set<string>()
      for (let rot = 0; rot < 200; rot++) {
        const pick = pickPaletteByCharacter({ character: c, current: '', recentIds: [], keyFamily: '', songSeed: rot * 31, rotation: rot, moodTarget: exact })
        if (pick) seen.add(pick)
      }
      expect(seen.size).toBeGreaterThan(1)
    })
  })

  it('the key family is a nudge: it helps a close call but cannot force a poor fit', () => {
    const c = { valence: 0.5, arousal: 0.5, tension: 0.5 }
    const bestFit = palettePool(c, 1)[0]
    const worst = ids()
      .map((id) => [id, paletteAffinity(id, c)] as const)
      .sort((a, b) => a[1] - b[1])[0][0]
    const rate = (family: string, target: string) => {
      let n = 0
      for (let rot = 0; rot < 600; rot++) if (pick({ character: c, keyFamily: family, rotation: rot, songSeed: rot * 31 })! === target) n++
      return n / 600
    }
    // A nudge on a good palette raises its rate modestly...
    const without = rate('', bestFit)
    const withKey = rate(bestFit, bestFit)
    expect(withKey).toBeGreaterThan(without)
    expect(withKey).toBeLessThan(without * 2)
    // ...but the key can NOT drag in a palette that fits the music badly (the old code's key override did).
    expect(rate(worst, worst)).toBeLessThan(0.05)
  })
})

describe('pickPaletteWithRecall (character hook)', () => {
  const pool = ids()
  it('uses the character pick when there is no recall, and falls back to the mood pool when it returns null', () => {
    const recall = new Map<string, string>()
    expect(pickPaletteWithRecall(pool, 'aurora', '', '', 0, '', recall, undefined, () => 'neon')).toBe('neon')
    const fallback = pickPaletteWithRecall(['ocean', 'ember'], 'ember', '', '', 0, '', recall, undefined, () => null)
    expect(fallback).toBe('ocean')
  })

  it('a recalled palette for a repeated section still wins over the character pick', () => {
    const recall = new Map<string, string>([['A', 'ocean']])
    expect(pickPaletteWithRecall(pool, 'aurora', '', '', 0, 'A', recall, undefined, () => 'neon')).toBe('ocean')
    // ... and it records what it picked for a first-seen label.
    const fresh = new Map<string, string>()
    expect(pickPaletteWithRecall(pool, 'aurora', '', '', 0, 'B', fresh, undefined, () => 'neon')).toBe('neon')
    expect(fresh.get('B')).toBe('neon')
  })

  it('the original behaviour is unchanged when no character hook is passed', () => {
    const recall = new Map<string, string>()
    const p = pickPaletteWithRecall(['ocean', 'ember'], 'ember', '', '', 0, '', recall)
    expect(p).toBe('ocean')
  })
})
