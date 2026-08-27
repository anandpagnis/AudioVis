import { describe, expect, it } from 'vitest'
import { advanceEffects, TriggerEdges } from '../EffectDirector'
import { syncEffectEntries } from '../SceneManager'
import { TIER_BUDGET_MS, slotCostMs } from '../slotBudget'
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
    budget: TIER_BUDGET_MS[0],
    tier: 0,
    // A cheap subject already on screen. Synthetic ids price through
    // FALLBACK_COST_MS, so this is the documented 0.5 ms `low` fallback.
    committedMs: slotCostMs('synthetic-primary', 0, 'primary', false, 'low'),
    lastFiredAt: new Map(),
    mood: 'groove',
    recentIds: [],
    ...over,
  })

/**
 * The effect slot has content now (F20). It shipped finished and empty for a
 * long time, so what these pin is the CONTRACT — the one requirement that kept
 * the role unclaimed is the one a future effect scene will also forget.
 */
describe('the effect roster', () => {
  it('is empty again after the licence sweep', () => {
    // `orbs` was the only effect scene (F20) and F105 quarantined it as
    // unverified Shadertoy provenance. The slot is finished, tested and once
    // more has nothing to fire — recorded rather than demanded, so this flips
    // back the moment a licensed scene claims the role.
    expect(getEffectScenes().length).toBe(0)
  })

  it('gives every effect scene a trigger and a finite lifetime', () => {
    for (const s of getEffectScenes()) {
      expect(s.metadata.effect, s.id).toBeDefined()
      expect(s.metadata.effect!.triggers.length, s.id).toBeGreaterThan(0)
      expect(s.metadata.effect!.durationSec, s.id).toBeGreaterThan(0)
    }
  })

  it('keeps effect lifetimes musical rather than momentary', () => {
    // Under about a second reads as a dropped frame rather than as
    // punctuation; over about eight it stops being punctuation at all and
    // becomes a second subject the composition never budgeted for.
    for (const s of getEffectScenes()) {
      expect(s.metadata.effect!.durationSec, s.id).toBeGreaterThan(1)
      expect(s.metadata.effect!.durationSec, s.id).toBeLessThan(8)
    }
  })

  it('does not fire an effect on every transient', () => {
    // The failure mode the slot is most exposed to: punctuation that happens
    // several times a bar is texture, and texture belongs in a layer.
    for (const s of getEffectScenes()) {
      if (s.metadata.effect!.triggers.includes('transient')) {
        expect(s.metadata.effect!.cooldownSec ?? 0, s.id).toBeGreaterThan(2)
      }
    }
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
        budget: TIER_BUDGET_MS[4],
        tier: 4,
        // A genuinely expensive subject at the survival tier: 8.77 ms measured,
        // against a 6.5 ms total frame budget. Nothing else may be admitted.
        committedMs: slotCostMs('juliawings', 4, 'primary'),
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
 * plus the post chain, while believing the frame held
 * one scene. Three claimants each reserving against a different partial view of
 * one budget is how it confidently overcommitted; see frameLoad.ts.
 */
describe('advanceEffects — reserves against the whole frame', () => {
  const scenes = [fx('burst', { performanceCost: 'medium' })]

  it('fires when the frame genuinely has room', () => {
    expect(
      advance({ fired: ['drop'], candidates: scenes, budget: TIER_BUDGET_MS[0], committedMs: 2 }),
    ).toHaveLength(1)
  })

  it('refuses once layers and fixed costs have taken the budget', () => {
    // Same tier, same effect — but the frame is already carrying a primary, two
    // layers and the post chain. The old signature
    // could not express this at all.
    expect(
      advance({ fired: ['drop'], candidates: scenes, budget: TIER_BUDGET_MS[0], committedMs: 10 }),
    ).toHaveLength(0)
  })

  it('does not double-count the effects already firing', () => {
    // `committedMs` includes live effects, so the caller must not add them
    // again — doing so would make each successive effect harder to fire the
    // longer the previous one ran, which is a rate limit disguised as a budget.
    const active: ActiveEffect[] = [{ id: 'other', startedAt: 9, durationSec: 5, key: 1 }]
    const out = advance({
      active,
      fired: ['drop'],
      candidates: scenes,
      budget: TIER_BUDGET_MS[0],
      committedMs: 3,
    })
    // MAX_ACTIVE is 1, so the existing effect is kept and no new one is added —
    // the point here is that it is refused by the ACTIVE cap, not by a budget
    // that counted `other` twice.
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('other')
  })
})
