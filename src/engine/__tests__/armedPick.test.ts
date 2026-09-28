import { describe, expect, it } from 'vitest'
import { createEmptyCharacterState, type CharacterState } from '../../audio/characterTypes'
import type { SceneDef } from '../../scenes'
import { SCENE_CHARACTER } from '../../scenes/character'
import { getSceneTraits } from '../../scenes/sceneTraits'
import {
  armableCandidates,
  armedFit,
  armTrend,
  BPM_SWING,
  bpmFactor,
  bpmTarget01,
  COLD_ARM_MAX_TIER,
  COST_COLD_WEAK_TIER,
  COST_COMPILED_BONUS,
  COST_HEAVY_FALLING,
  COST_HEAVY_MID_TIER,
  costFactor,
  describeChoice,
  pickNextScene,
  rankCandidates,
  scoreScene,
  targetPoint,
  TREND_FALL_AROUSAL,
  TREND_RISE_AROUSAL,
  type ArmCandidate,
  type ArmContext,
  type TrendInput,
} from '../armedPick'

const calm: TrendInput = {
  structureValid: false,
  isSustain: false,
  isBreakdown: false,
  beatsTillDrop: -1,
  buildUp: false,
  moodBuilding: false,
  moodDecaying: false,
  moodMelting: false,
  moodState: 'groove',
  predictedState: 'groove',
  beatsTillTransition: -1,
}
const t = (over: Partial<TrendInput>): TrendInput => ({ ...calm, ...over })

function character(over: Partial<CharacterState> = {}): CharacterState {
  return { ...createEmptyCharacterState(), valid: true, primary: 'groove', valence: 0.5, arousal: 0.5, tension: 0.4, pulse: 0.5, ...over }
}

const IDS = Object.keys(SCENE_CHARACTER).slice(0, 16)
const cand = (id: string, over: Partial<ArmCandidate> = {}): ArmCandidate => ({ id, cost: 'medium', compiled: false, ...over })
const CANDS = IDS.map((id) => cand(id))

function ctx(over: Partial<ArmContext> = {}): ArmContext {
  return {
    character: character(),
    trend: 'steady',
    tempoOctaves: 0,
    bpmConfidence: 1,
    tier: 0,
    look: undefined,
    sceneId: 'none',
    recentIds: [],
    ...over,
  }
}

const byTempo = [...IDS].sort((a, b) => getSceneTraits(a).tempo - getSceneTraits(b).tempo)
const slowest = byTempo[0]
const fastest = byTempo[byTempo.length - 1]

describe('armTrend', () => {
  it('reads steady with nothing going on', () => {
    expect(armTrend(calm)).toBe('steady')
  })

  it('rising: a confirmed build, the fast build flag, a building mood, a drop projected soon, a hot mood imminent', () => {
    expect(armTrend(t({ structureValid: true, isSustain: true }))).toBe('rising')
    expect(armTrend(t({ buildUp: true }))).toBe('rising')
    expect(armTrend(t({ moodBuilding: true }))).toBe('rising')
    expect(armTrend(t({ structureValid: true, beatsTillDrop: 12 }))).toBe('rising')
    expect(armTrend(t({ predictedState: 'peak', beatsTillTransition: 4 }))).toBe('rising')
    expect(armTrend(t({ predictedState: 'aggressive', beatsTillTransition: 0 }))).toBe('rising')
  })

  it('falling: a breakdown, a decaying or melting mood, a calm mood imminent', () => {
    expect(armTrend(t({ structureValid: true, isBreakdown: true }))).toBe('falling')
    expect(armTrend(t({ moodDecaying: true }))).toBe('falling')
    expect(armTrend(t({ moodMelting: true }))).toBe('falling')
    expect(armTrend(t({ predictedState: 'mellow', beatsTillTransition: 3 }))).toBe('falling')
  })

  it('an unvalidated structure read never counts (a section read that was never real)', () => {
    expect(armTrend(t({ isSustain: true }))).toBe('steady')
    expect(armTrend(t({ isBreakdown: true }))).toBe('steady')
    expect(armTrend(t({ beatsTillDrop: 4 }))).toBe('steady')
  })

  it('a drop projected far away, or a predicted change not yet imminent, is not rising', () => {
    expect(armTrend(t({ structureValid: true, beatsTillDrop: 40 }))).toBe('steady')
    expect(armTrend(t({ predictedState: 'peak', beatsTillTransition: 30 }))).toBe('steady')
    expect(armTrend(t({ predictedState: 'peak', beatsTillTransition: -1 }))).toBe('steady')
  })

  it('rising wins over falling (the hot moment is what the armed scene must be ready for)', () => {
    expect(armTrend(t({ buildUp: true, moodDecaying: true }))).toBe('rising')
  })
})

describe('targetPoint', () => {
  const p = { valence: 0.3, arousal: 0.5, tension: 0.2, pulse: 0.6 }

  it('rising lifts arousal and tension to at least the hot floor, never lowers them', () => {
    expect(targetPoint(p, 'rising')).toEqual({ valence: 0.3, arousal: TREND_RISE_AROUSAL, tension: 0.5, pulse: 0.6 })
    expect(targetPoint({ ...p, arousal: 0.95, tension: 0.9 }, 'rising')).toMatchObject({ arousal: 0.95, tension: 0.9 })
  })

  it('falling lowers them to at most the calm ceiling, never raises them', () => {
    expect(targetPoint(p, 'falling')).toMatchObject({ arousal: TREND_FALL_AROUSAL, tension: 0.2 })
    expect(targetPoint({ ...p, arousal: 0.1, tension: 0.05 }, 'falling')).toMatchObject({ arousal: 0.1, tension: 0.05 })
  })

  it('steady leaves the point alone, and valence / pulse are never touched', () => {
    expect(targetPoint(p, 'steady')).toEqual(p)
    for (const trend of ['rising', 'falling'] as const) {
      expect(targetPoint(p, trend).valence).toBe(0.3)
      expect(targetPoint(p, trend).pulse).toBe(0.6)
    }
  })
})

describe('BPM', () => {
  it('maps 60 / 120 / 240 BPM onto the 0..1 tempo trait scale, and garbage to neutral', () => {
    expect(bpmTarget01(-1)).toBe(0)
    expect(bpmTarget01(0)).toBe(0.5)
    expect(bpmTarget01(1)).toBe(1)
    expect(bpmTarget01(5)).toBe(1)
    expect(bpmTarget01(NaN)).toBe(0.5)
  })

  it('does nothing without a trustworthy beat read', () => {
    for (const id of IDS) {
      expect(bpmFactor(id, 0.7, 0)).toBe(1)
      expect(bpmFactor(id, 0.7, 0.1)).toBe(1)
      expect(bpmFactor(id, 0.7, NaN)).toBe(1)
    }
  })

  it('favours a fast-tempo scene on a fast song and a slow-tempo scene on a slow one', () => {
    expect(getSceneTraits(fastest).tempo).toBeGreaterThan(getSceneTraits(slowest).tempo)
    expect(bpmFactor(fastest, 0.6, 1)).toBeGreaterThan(bpmFactor(slowest, 0.6, 1))
    expect(bpmFactor(slowest, -0.6, 1)).toBeGreaterThan(bpmFactor(fastest, -0.6, 1))
    // and the same scene is worth more on the song that suits it
    expect(bpmFactor(fastest, 0.6, 1)).toBeGreaterThan(bpmFactor(fastest, -0.6, 1))
  })

  it('stays inside 1 +- BPM_SWING and eases in with confidence', () => {
    for (const id of IDS) {
      for (const o of [-1, -0.4, 0, 0.4, 1]) {
        const f = bpmFactor(id, o, 1)
        expect(f).toBeGreaterThanOrEqual(1 - BPM_SWING - 1e-9)
        expect(f).toBeLessThanOrEqual(1 + BPM_SWING + 1e-9)
      }
    }
    const half = bpmFactor(fastest, 0.8, 0.325)
    const full = bpmFactor(fastest, 0.8, 1)
    expect(Math.abs(half - 1)).toBeLessThan(Math.abs(full - 1))
  })
})

describe('cost', () => {
  it('prefers a scene compiled this session', () => {
    expect(costFactor(cand('a', { compiled: true }), 0, 'steady')).toBe(COST_COMPILED_BONUS)
    expect(costFactor(cand('a'), 0, 'steady')).toBe(1)
  })

  it('discourages a heavy scene on weaker tiers and in a breakdown', () => {
    expect(costFactor(cand('a', { cost: 'high', compiled: true }), 2, 'steady')).toBeCloseTo(COST_COMPILED_BONUS * COST_HEAVY_MID_TIER, 9)
    expect(costFactor(cand('a', { cost: 'high', compiled: true }), 0, 'falling')).toBeCloseTo(COST_COMPILED_BONUS * COST_HEAVY_FALLING, 9)
    expect(costFactor(cand('a', { cost: 'high', compiled: true }), 0, 'steady')).toBe(COST_COMPILED_BONUS)
  })

  it('discourages a scene that would need a first compile on a weak tier', () => {
    expect(costFactor(cand('a'), 3, 'steady')).toBe(COST_COLD_WEAK_TIER)
    expect(costFactor(cand('a', { compiled: true }), 3, 'steady')).toBe(COST_COMPILED_BONUS)
  })

  it('armableCandidates: every scene up to the cold-arm tier; only compiled or cheap ones above it', () => {
    const list = [cand('cold-heavy', { cost: 'high' }), cand('cold-low', { cost: 'low' }), cand('warm-high', { cost: 'high', compiled: true })]
    expect(armableCandidates(list, COLD_ARM_MAX_TIER).map((c) => c.id)).toEqual(['cold-heavy', 'cold-low', 'warm-high'])
    expect(armableCandidates(list, COLD_ARM_MAX_TIER + 1).map((c) => c.id)).toEqual(['cold-low', 'warm-high'])
    expect(list).toHaveLength(3) // not mutated
  })
})

describe('scoring and ranking', () => {
  it('ranks best first, never includes the scene on screen, and is deterministic', () => {
    const ranked = rankCandidates(CANDS, ctx({ sceneId: IDS[0] }))
    expect(ranked.map((r) => r.id)).not.toContain(IDS[0])
    expect(ranked).toHaveLength(IDS.length - 1)
    for (let i = 1; i < ranked.length; i++) expect(ranked[i - 1].fit).toBeGreaterThanOrEqual(ranked[i].fit)
    expect(rankCandidates(CANDS, ctx({ sceneId: IDS[0] }))).toEqual(ranked)
  })

  it('a rising trend arms a hotter scene than a falling one, for the same music', () => {
    const c = ctx({ character: character({ arousal: 0.5, tension: 0.4 }) })
    const rise = rankCandidates(CANDS, { ...c, trend: 'rising' })[0].id
    const fall = rankCandidates(CANDS, { ...c, trend: 'falling' })[0].id
    expect(SCENE_CHARACTER[rise].arousal).toBeGreaterThan(SCENE_CHARACTER[fall].arousal)
  })

  it('the BPM term moves the same scene\'s fit: a fast scene is worth more on a fast song', () => {
    const fast = scoreScene(cand(fastest), ctx({ tempoOctaves: 0.7 }))
    const slow = scoreScene(cand(fastest), ctx({ tempoOctaves: -0.7 }))
    expect(fast.fit).toBeGreaterThan(slow.fit)
    expect(fast.aff).toBe(slow.aff) // only the BPM term differs
  })

  it('a compiled scene outranks an identical cold one', () => {
    const cold = scoreScene(cand(IDS[3]), ctx())
    const warm = scoreScene(cand(IDS[3], { compiled: true }), ctx())
    expect(warm.fit / cold.fit).toBeCloseTo(COST_COMPILED_BONUS, 9)
  })

  it('at a weak tier a cold heavy scene is never ranked at all', () => {
    const list = IDS.map((id, i) => cand(id, { cost: i % 2 ? 'high' : 'low' }))
    const ranked = rankCandidates(list, ctx({ tier: 3 }))
    expect(ranked.every((r) => list.find((c) => c.id === r.id)!.cost === 'low')).toBe(true)
  })

  it('armedFit: the best candidate fits fully, an unknown id fits not at all', () => {
    const c = ctx({ sceneId: 'none' })
    const best = rankCandidates(CANDS, c)[0]
    const a = armedFit(best.id, CANDS, c)
    expect(a.armed).toBeCloseTo(best.fit, 12)
    expect(a.best).toBeCloseTo(best.fit, 12)
    const gone = armedFit('not-a-scene', CANDS, c)
    expect(gone.armed).toBe(0)
    expect(gone.best).toBeCloseTo(best.fit, 12)
  })

  it('armedFit: an armed scene that suited calm music stops fitting when the music turns hot', () => {
    const calmCtx = ctx({ character: character({ arousal: 0.15, tension: 0.15 }) })
    const calmBest = rankCandidates(CANDS, calmCtx)[0].id
    const still = armedFit(calmBest, CANDS, calmCtx)
    expect(still.armed).toBeCloseTo(still.best, 12)
    const hot = armedFit(calmBest, CANDS, ctx({ character: character({ arousal: 0.95, tension: 0.8 }), trend: 'rising' }))
    expect(hot.armed).toBeLessThan(0.45 * hot.best) // ARM.refitRatio: it would be re-picked
  })

  it('describeChoice is short, readable and NaN-free', () => {
    const s = describeChoice(scoreScene(cand(IDS[2], { compiled: true }), ctx({ trend: 'rising', tempoOctaves: 0.3 })), 'rising')
    expect(s).toMatch(/^rise aff\S* bpm[+-]\S* look x\S+ cost x\S+$/)
    expect(s).not.toMatch(/NaN|Infinity/)
    expect(s.length).toBeLessThan(60)
  })
})

describe('pickNextScene', () => {
  const scenes = IDS.map((id) => ({ id }) as unknown as SceneDef)
  const facts = new Map(IDS.map((id) => [id, cand(id, { compiled: true })]))
  const seeded = (seed: number) => {
    let a = seed >>> 0
    return () => {
      a = (a + 0x6d2b79f5) >>> 0
      let x = Math.imul(a ^ (a >>> 15), 1 | a)
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296
    }
  }
  const pick = (over: Partial<ArmContext> = {}, extra: Partial<Parameters<typeof pickNextScene>[0]> = {}) =>
    pickNextScene({ scenes, facts, ctx: ctx(over), key: 'C', now: 10, rng: seeded(7), ...extra })

  it('returns a scene that is not the one on screen and not an excluded one', () => {
    for (let seed = 1; seed < 40; seed++) {
      const s = pickNextScene({ scenes, facts, ctx: ctx({ sceneId: IDS[0] }), key: 'C', now: 10, exclude: [IDS[1]], rng: seeded(seed) })
      expect(s).not.toBeNull()
      expect([IDS[0], IDS[1]]).not.toContain(s!.id)
    }
  })

  it('returns null while the character read is not ready (the caller falls back to the mood-label pick)', () => {
    expect(pick({ character: character({ valid: false }) })).toBeNull()
    expect(pick({ character: character({ primary: null }) })).toBeNull()
  })

  it('is reproducible for a given random source', () => {
    expect(pick()?.id).toBe(pick()?.id)
  })

  it('a rising trend picks hotter scenes on average than a falling one', () => {
    const mean = (trend: 'rising' | 'falling') => {
      let sum = 0
      for (let seed = 1; seed <= 60; seed++) {
        const s = pickNextScene({ scenes, facts, ctx: ctx({ trend }), key: 'C', now: 10, rng: seeded(seed) })!
        sum += SCENE_CHARACTER[s.id].arousal
      }
      return sum / 60
    }
    expect(mean('rising')).toBeGreaterThan(mean('falling'))
  })

  it('recent scenes are avoided', () => {
    const recent = IDS.slice(0, 3)
    let hits = 0
    for (let seed = 1; seed <= 60; seed++) {
      const s = pickNextScene({ scenes, facts, ctx: ctx({ recentIds: recent, sceneId: 'none' }), key: 'C', now: 10, rng: seeded(seed) })!
      if (recent.includes(s.id)) hits++
    }
    expect(hits).toBeLessThan(6)
  })

  it('at a weak tier it only ever picks a scene that is already compiled or cheap', () => {
    const cold = new Map(IDS.map((id, i) => [id, cand(id, { compiled: i < 5, cost: i < 5 ? 'high' : 'medium' })]))
    for (let seed = 1; seed <= 40; seed++) {
      const s = pickNextScene({ scenes, facts: cold, ctx: ctx({ tier: 3 }), key: 'C', now: 10, rng: seeded(seed) })!
      expect(IDS.indexOf(s.id)).toBeLessThan(5)
    }
  })

  it('a scene with no facts reads as cold and medium rather than throwing', () => {
    expect(() => pickNextScene({ scenes, facts: new Map(), ctx: ctx(), key: 'C', now: 10, rng: seeded(3) })).not.toThrow()
  })

  it('returns null for an empty pool', () => {
    expect(pickNextScene({ scenes: [], facts, ctx: ctx(), key: 'C', now: 10 })).toBeNull()
  })
})
