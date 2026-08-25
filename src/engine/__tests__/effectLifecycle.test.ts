import { describe, expect, it } from 'vitest'
import { advanceEffects, TriggerEdges } from '../EffectDirector'
import { syncEffectEntries } from '../SceneManager'
import { TIER_BUDGET, slotCost } from '../slotBudget'
import { getEffectScenes, validateSceneDef, type SceneDef } from '../../scenes'
import type { ActiveEffect } from '../performanceState'
import type { AudioFeatures } from '../../audio/types'

/**
 * Effect scenes do not exist yet, so this covers the machinery with synthetic
 * `SceneDef` fixtures. That is the point: the lifecycle has to be correct
 * before there is any content to observe it with, and the empty-roster path is
 * what actually ships today.
 */
const fx = (id: string, over: Partial<SceneDef['metadata']> = {}): SceneDef =>
  ({
    id,
    name: id,
    component: (() => null) as unknown as SceneDef['component'],
    metadata: {
      roles: ['effect'],
      moods: ['groove', 'peak'],
      bands: ['energy'],
      intensity: 'high',
      performanceCost: 'low',
      compatibleWith: [],
      effect: { triggers: ['drop'], durationSec: 2 },
      ...over,
    },
  }) as SceneDef

const feat = (over: Partial<AudioFeatures>): AudioFeatures =>
  ({ drop: false, buildUp: false, sectionChange: false, transient: 0, ...over }) as AudioFeatures

const advance = (over: Partial<Parameters<typeof advanceEffects>[0]>) =>
  advanceEffects({
    active: [],
    fired: [],
    candidates: [],
    now: 10,
    budget: TIER_BUDGET[0],
    committedUnits: slotCost('low', 'primary'),
    lastFiredAt: new Map(),
    mood: 'groove',
    recentIds: [],
    ...over,
  })

describe('the roster ships with no effect scenes', () => {
  it('getEffectScenes is empty, so every path below is inert in production', () => {
    expect(getEffectScenes()).toEqual([])
  })
})

describe('TriggerEdges', () => {
  it('fires a drop once, not for every frame the flag is held', () => {
    // f.drop stays true for 0.6s — firing on the level would machine-gun.
    const e = new TriggerEdges()
    expect(e.update(feat({ drop: true }))).toContain('drop')
    expect(e.update(feat({ drop: true }))).not.toContain('drop')
    e.update(feat({ drop: false }))
    expect(e.update(feat({ drop: true }))).toContain('drop')
  })

  it('fires buildPeak on the END of a build, not the start', () => {
    // The release is the moment worth punctuating; the onset is not.
    const e = new TriggerEdges()
    expect(e.update(feat({ buildUp: true }))).not.toContain('buildPeak')
    expect(e.update(feat({ buildUp: false }))).toContain('buildPeak')
  })

  it('treats sectionChange as the one-frame pulse it already is', () => {
    const e = new TriggerEdges()
    expect(e.update(feat({ sectionChange: true }))).toContain('sectionChange')
    expect(e.update(feat({ sectionChange: false }))).not.toContain('sectionChange')
  })
})

describe('advanceEffects', () => {
  it('fires a matching effect and retires it after its duration', () => {
    const scenes = [fx('burst')]
    const started = advance({ fired: ['drop'], candidates: scenes, now: 10 })
    expect(started).toHaveLength(1)
    expect(started[0].id).toBe('burst')

    // Still inside its lifetime.
    expect(advance({ active: started, candidates: scenes, now: 11.5 })).toHaveLength(1)
    // Past it.
    expect(advance({ active: started, candidates: scenes, now: 12.1 })).toHaveLength(0)
  })

  it('ignores triggers the effect did not declare', () => {
    const scenes = [fx('burst', { effect: { triggers: ['drop'], durationSec: 2 } })]
    expect(advance({ fired: ['sectionChange'], candidates: scenes })).toHaveLength(0)
  })

  it('holds at one concurrent effect', () => {
    const scenes = [fx('a'), fx('b')]
    const first = advance({ fired: ['drop'], candidates: scenes, now: 10 })
    expect(first).toHaveLength(1)
    const second = advance({ active: first, fired: ['drop'], candidates: scenes, now: 10.5 })
    expect(second).toHaveLength(1)
  })

  it('enforces a per-effect cooldown', () => {
    const scenes = [fx('burst', { effect: { triggers: ['drop'], durationSec: 1, cooldownSec: 10 } })]
    const lastFiredAt = new Map<string, number>()
    const first = advance({ fired: ['drop'], candidates: scenes, now: 10, lastFiredAt })
    expect(first).toHaveLength(1)
    // Expired, but still inside the cooldown.
    expect(advance({ fired: ['drop'], candidates: scenes, now: 12, lastFiredAt })).toHaveLength(0)
    expect(advance({ fired: ['drop'], candidates: scenes, now: 21, lastFiredAt })).toHaveLength(1)
  })

  it('refuses to fire when the budget cannot fund it', () => {
    const scenes = [fx('heavy', { performanceCost: 'high' })]
    // Heavy primary at the lowest tier leaves nothing over.
    expect(
      advance({
        fired: ['drop'],
        candidates: scenes,
        budget: TIER_BUDGET[4],
        committedUnits: slotCost('high', 'primary'),
      }),
    ).toHaveLength(0)
  })

  it('drops effects stranded by a source restart rewinding the clock', () => {
    const active: ActiveEffect[] = [{ id: 'burst', startedAt: 90, durationSec: 2, key: 1 }]
    // A new source restarts features.time at 0, leaving startedAt in the future.
    expect(advance({ active, candidates: [fx('burst')], now: 0.5 })).toHaveLength(0)
  })
})

describe('validateSceneDef — effect contract', () => {
  it('rejects an effect scene with no effect spec', () => {
    const bad = fx('bad')
    delete bad.metadata.effect
    expect(validateSceneDef(bad).join(' ')).toMatch(/effect. spec/)
  })

  it('rejects a zero or negative duration, which would never retire', () => {
    const bad = fx('bad', { effect: { triggers: ['drop'], durationSec: 0 } })
    expect(validateSceneDef(bad).join(' ')).toMatch(/durationSec/)
  })

  it('rejects an effect with no triggers, which could never fire', () => {
    const bad = fx('bad', { effect: { triggers: [], durationSec: 1 } })
    expect(validateSceneDef(bad).join(' ')).toMatch(/trigger/)
  })

  it('accepts a well-formed effect scene', () => {
    expect(validateSceneDef(fx('good'))).toEqual([])
  })
})

describe('syncEffectEntries', () => {
  const entry = (id: string) => ({
    key: 1,
    id,
    role: 'effect' as const,
    effect: null as ActiveEffect | null,
    dir: 0 as 1 | -1 | 0,
    warmFrames: 0,
    prewarmed: false,
    fade: { value: 0 },
    out: { value: 0, role: 'effect' as const, sceneId: id, gain: 1, progress: 0 },
  })

  it('activates a pinned entry when its effect fires', () => {
    const entries = [entry('burst')]
    syncEffectEntries(entries, [{ id: 'burst', startedAt: 1, durationSec: 2, key: 7 }])
    expect(entries[0].dir).toBe(1)
    expect(entries[0].effect?.key).toBe(7)
  })

  it('fades out a pinned entry when its effect retires — without unmounting', () => {
    const entries = [entry('burst')]
    entries[0].dir = 1
    entries[0].effect = { id: 'burst', startedAt: 1, durationSec: 2, key: 7 }
    syncEffectEntries(entries, [])
    expect(entries[0].dir).toBe(-1)
    // Pinning is the whole point: the entry must survive so the next firing
    // costs no shader compile.
    expect(entries).toHaveLength(1)
  })

  it('restarts cleanly when the same effect re-fires', () => {
    const entries = [entry('burst')]
    entries[0].dir = 1
    entries[0].effect = { id: 'burst', startedAt: 1, durationSec: 2, key: 7 }
    entries[0].fade.value = 0.6
    syncEffectEntries(entries, [{ id: 'burst', startedAt: 9, durationSec: 2, key: 8 }])
    expect(entries[0].effect?.key).toBe(8)
    expect(entries[0].fade.value).toBe(0)
  })

  it('leaves non-effect entries alone', () => {
    const primary = { ...entry('wireframe'), role: 'primary' as const, dir: 1 as const }
    const entries = [primary]
    syncEffectEntries(entries as never, [])
    expect(entries[0].dir).toBe(1)
  })
})

/**
 * The budget an effect reserves against must be the WHOLE frame.
 *
 * This claimant used to take `primaryUnits` — the subject alone — so an effect
 * could fire on top of a full background + accent + overlay composition, plus
 * the post chain, plus the generative overlay, while believing the frame held
 * one scene. Three claimants each reserving against a different partial view of
 * one budget is how it confidently overcommitted; see frameLoad.ts.
 */
describe('advanceEffects — reserves against the whole frame', () => {
  const scenes = [fx('burst', { performanceCost: 'medium' })]

  it('fires when the frame genuinely has room', () => {
    expect(
      advance({ fired: ['drop'], candidates: scenes, budget: TIER_BUDGET[0], committedUnits: 2 }),
    ).toHaveLength(1)
  })

  it('refuses once layers and fixed costs have taken the budget', () => {
    // Same tier, same effect — but the frame is already carrying a primary, two
    // layers, the post chain and the generative overlay. The old signature
    // could not express this at all.
    expect(
      advance({ fired: ['drop'], candidates: scenes, budget: TIER_BUDGET[0], committedUnits: 10 }),
    ).toHaveLength(0)
  })

  it('does not double-count the effects already firing', () => {
    // `committedUnits` includes live effects, so the caller must not add them
    // again — doing so would make each successive effect harder to fire the
    // longer the previous one ran, which is a rate limit disguised as a budget.
    const active: ActiveEffect[] = [{ id: 'other', startedAt: 9, durationSec: 5, key: 1 }]
    const out = advance({
      active,
      fired: ['drop'],
      candidates: scenes,
      budget: TIER_BUDGET[0],
      committedUnits: 3,
    })
    // MAX_ACTIVE is 1, so the existing effect is kept and no new one is added —
    // the point here is that it is refused by the ACTIVE cap, not by a budget
    // that counted `other` twice.
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('other')
  })
})
