import { afterEach, describe, expect, it, vi } from 'vitest'
import { advanceEffects, effectPropensity } from '../EffectDirector'
import { createLookProfile, type LookProfile } from '../look/lookRow'
import type { ActiveEffect } from '../performanceState'
import { TIER_BUDGET_MS, slotCostMs } from '../slotBudget'
import { getEffectScenes, type SceneDef } from '../../scenes'

/**
 * The mood look profile reaching the effect director: each effect scene's odds in the weighted pick are multiplied
 * by its propensity (`fxShock` / `fxFlare` / `fxSpark` / `fxStrobe`), a propensity of 0 excludes it, and nothing
 * else about firing changes. The legacy behaviour (look omitted) is pinned by effectLifecycle.test.ts.
 */

/** A profile with exactly these propensities. NOT marked valid: `advanceEffects` gates on the argument being passed. */
function lookWith(fx: { shock?: number; flare?: number; spark?: number; strobe?: number }): LookProfile {
  const look = createLookProfile()
  look.fxShock = fx.shock ?? 0
  look.fxFlare = fx.flare ?? 0
  look.fxSpark = fx.spark ?? 0
  look.fxStrobe = fx.strobe ?? 0
  return look
}

const ALL_ONE = lookWith({ shock: 1, flare: 1, spark: 1, strobe: 1 })

const advance = (over: Partial<Parameters<typeof advanceEffects>[0]>) =>
  advanceEffects({
    active: [],
    fired: [],
    candidates: getEffectScenes(),
    now: 100,
    budget: TIER_BUDGET_MS[0],
    tier: 0,
    committedMs: slotCostMs('synthetic-primary', 0, 'primary', false, 'low'),
    lastFiredAt: new Map(),
    // 'peak' rates shock .95 and strobe .90, so with equal propensity the two are close to even.
    mood: 'peak',
    recentIds: [],
    ...over,
  })

/** A deterministic uniform stream, so the weighted pick's own randomness is reproducible. */
function seededRandom(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

const idsOf = (out: ActiveEffect[]) => out.map((e) => e.id)

/** Fraction of `n` drops answered by shock (the other drop effect is strobe). */
function shockShare(look: LookProfile | undefined, n = 4000): number {
  vi.spyOn(Math, 'random').mockImplementation(seededRandom(20240607))
  let shock = 0
  for (let i = 0; i < n; i++) {
    const out = advance({ fired: ['drop'], look })
    expect(out).toHaveLength(1)
    if (out[0].id === 'shock') shock++
  }
  return shock / n
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('effectPropensity', () => {
  it('reads each effect scene from its own profile field', () => {
    const look = lookWith({ shock: 0.1, flare: 0.2, spark: 0.3, strobe: 0.4 })
    expect(effectPropensity('shock', look)).toBe(0.1)
    expect(effectPropensity('flare', look)).toBe(0.2)
    expect(effectPropensity('spark', look)).toBe(0.3)
    expect(effectPropensity('strobe', look)).toBe(0.4)
  })

  it('leaves an effect the profile has no field for unweighted, and never treats garbage as an exclusion', () => {
    expect(effectPropensity('some-future-effect', lookWith({}))).toBe(1)
    const bad = lookWith({ shock: NaN, flare: -2, spark: Infinity })
    expect(effectPropensity('shock', bad)).toBe(1)
    expect(effectPropensity('flare', bad)).toBe(0)
    expect(effectPropensity('spark', bad)).toBe(1)
  })
})

describe('advanceEffects with a look profile', () => {
  it('excludes an effect whose propensity is 0, whatever the draw', () => {
    // Both drop effects are eligible on a drop. Includes rolls of exactly 0 and just under 1, the edges where a
    // zero-WEIGHT candidate could still be returned by a bare boost.
    for (const roll of [0, 0.001, 0.25, 0.5, 0.75, 0.999]) {
      vi.spyOn(Math, 'random').mockReturnValue(roll)
      expect(idsOf(advance({ fired: ['drop'], look: lookWith({ shock: 0, strobe: 1 }) })), `roll ${roll}`).toEqual(['strobe'])
      expect(idsOf(advance({ fired: ['drop'], look: lookWith({ shock: 1, strobe: 0 }) })), `roll ${roll}`).toEqual(['shock'])
      vi.restoreAllMocks()
    }
  })

  it('fires nothing when every effect the trigger could fire has propensity 0', () => {
    for (const roll of [0, 0.5, 0.999]) {
      vi.spyOn(Math, 'random').mockReturnValue(roll)
      expect(advance({ fired: ['drop'], look: lookWith({ shock: 0, strobe: 0, flare: 1, spark: 1 }) })).toEqual([])
      vi.restoreAllMocks()
    }
    // A silent passage (the intensity gate is 0, so all four are): no trigger fires anything.
    const silent = lookWith({})
    expect(advance({ fired: ['drop', 'sectionChange', 'buildPeak', 'transient'], look: silent })).toEqual([])
  })

  it('orders the effects by propensity: a higher one is picked more often', () => {
    const heavyShock = shockShare(lookWith({ shock: 1.5, strobe: 0.2 }))
    vi.restoreAllMocks()
    const even = shockShare(ALL_ONE)
    vi.restoreAllMocks()
    const heavyStrobe = shockShare(lookWith({ shock: 0.2, strobe: 1.5 }))

    expect(heavyShock).toBeGreaterThan(even)
    expect(even).toBeGreaterThan(heavyStrobe)
    // And close to the odds the weights predict (moodFit x propensity): .95 x 1.5 vs .90 x .2, and so on.
    expect(heavyShock).toBeCloseTo((0.95 * 1.5) / (0.95 * 1.5 + 0.9 * 0.2), 1)
    expect(even).toBeCloseTo(0.95 / (0.95 + 0.9), 1)
    expect(heavyStrobe).toBeCloseTo((0.95 * 0.2) / (0.95 * 0.2 + 0.9 * 1.5), 1)
  })

  it('is the original pick when look is omitted, undefined, or every propensity is 1', () => {
    const run = (look: LookProfile | undefined, omit: boolean): string[] => {
      vi.spyOn(Math, 'random').mockImplementation(seededRandom(7))
      const ids: string[] = []
      for (let i = 0; i < 300; i++) {
        const out = omit ? advance({ fired: ['drop'] }) : advance({ fired: ['drop'], look })
        ids.push(out[0]?.id ?? 'none')
      }
      vi.restoreAllMocks()
      return ids
    }
    const legacy = run(undefined, true)
    expect(new Set(legacy).size).toBeGreaterThan(1) // the comparison is not vacuous
    expect(run(undefined, false)).toEqual(legacy)
    expect(run(ALL_ONE, false)).toEqual(legacy)
  })

  it('does not thin a trigger that has a single answer — a weight reorders candidates, it does not gate them', () => {
    // `transient` is answered by spark alone. Any non-zero propensity still fires it; 0 does not.
    expect(idsOf(advance({ fired: ['transient'], look: lookWith({ spark: 0.05 }) }))).toEqual(['spark'])
    expect(advance({ fired: ['transient'], look: lookWith({ spark: 0 }) })).toEqual([])
    expect(idsOf(advance({ fired: ['sectionChange'], look: lookWith({ flare: 0.1 }) }))).toEqual(['flare'])
    expect(advance({ fired: ['sectionChange'], look: lookWith({ flare: 0 }) })).toEqual([])
  })

  it('does not weigh effects it has no field for', () => {
    const burst = {
      id: 'burst',
      name: 'burst',
      component: (() => null) as unknown as SceneDef['component'],
      metadata: {
        roles: ['effect'],
        moods: ['groove', 'peak'],
        bands: ['energy'],
        intensity: 'high',
        performanceCost: 'low',
        compatibleWith: [],
        effect: { triggers: ['drop'], durationSec: 2 },
      },
    } as SceneDef
    // Every propensity 0: the four known effects are excluded, the unknown one is not.
    expect(idsOf(advance({ fired: ['drop'], candidates: [...getEffectScenes(), burst], look: lookWith({}) }))).toEqual(['burst'])
  })

  it('keeps cooldowns, durations, the one-at-a-time cap and the budget exactly as they are', () => {
    const look = lookWith({ shock: 1, strobe: 1, flare: 1, spark: 1 })

    // Duration comes from the picked scene's own spec.
    const started = advance({ fired: ['drop'], look })
    expect(started).toHaveLength(1)
    const spec = getEffectScenes().find((s) => s.id === started[0].id)!.metadata.effect!
    expect(started[0].durationSec).toBe(spec.durationSec)
    expect(started[0].startedAt).toBe(100)

    // One at a time: a live effect blocks any new one, propensity or not.
    const live: ActiveEffect[] = [{ id: 'shock', startedAt: 99, durationSec: 4, key: 1 }]
    expect(idsOf(advance({ active: live, fired: ['drop'], look }))).toEqual(['shock'])

    // Per-effect cooldown: both drop effects fired moments ago, so neither is eligible.
    const lastFiredAt = new Map([
      ['shock', 99],
      ['strobe', 99],
    ])
    expect(advance({ fired: ['drop'], look, lastFiredAt })).toEqual([])
    // ...and a cooled-down one still fires while the other stays on cooldown.
    const oneCooled = new Map([
      ['shock', 99],
      ['strobe', 50],
    ])
    expect(idsOf(advance({ fired: ['drop'], look, lastFiredAt: oneCooled }))).toEqual(['strobe'])

    // Triggers: a drop never fires the transient effect, however heavily it is weighted.
    expect(idsOf(advance({ fired: ['drop'], look: lookWith({ spark: 1.5, shock: 0.1, strobe: 0.1 }) }))).not.toContain('spark')

    // Budget: nothing fits a frame already at its ceiling.
    expect(advance({ fired: ['drop'], look, committedMs: 999 })).toEqual([])
  })

  it('records the firing so the cooldown applies to the next one', () => {
    const lastFiredAt = new Map<string, number>()
    const out = advance({ fired: ['drop'], look: lookWith({ shock: 1, strobe: 0 }), lastFiredAt })
    expect(out[0].id).toBe('shock')
    expect(lastFiredAt.get('shock')).toBe(100)
    expect(lastFiredAt.has('strobe')).toBe(false)
  })
})
