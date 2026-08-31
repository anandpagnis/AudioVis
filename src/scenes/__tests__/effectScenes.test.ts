import { describe, expect, it } from 'vitest'
import { getEffectScenes } from '../index'
import type { EffectTrigger } from '../index'

/**
 * The three scenes that claim the `effect` role (c6 / F20's second close).
 *
 * Component-level rendering is deliberately NOT tested here, matching this
 * codebase's own split: the pure decision logic (`advanceEffects`,
 * `effectEnvelope`, registry validation) is unit-tested, the WebGL-touching
 * scene component is not, exactly like every other scene in the roster. This
 * file covers the part that IS this project's own logic rather than
 * three.js/R3F plumbing: what each scene declares about itself.
 */
describe('the licensed effect roster (shock / flare / spark)', () => {
  it('is exactly three scenes, none of them the withheld orbs', () => {
    const ids = getEffectScenes().map((s) => s.id)
    expect(ids.sort()).toEqual(['flare', 'shock', 'spark'])
    expect(ids).not.toContain('orbs')
  })

  it('is entirely original-licensed — the whole reason this could ship', () => {
    // F20 was reopened specifically because `orbs`' Shadertoy provenance was
    // unverified. A regression here would silently reintroduce that exposure
    // for a build that ships this slot.
    for (const s of getEffectScenes()) {
      expect(s.metadata.license, s.id).toBe('original')
    }
  })

  it('together cover every trigger family exactly once', () => {
    const ALL_TRIGGERS: EffectTrigger[] = ['drop', 'buildPeak', 'sectionChange', 'transient']
    const covered = new Map<EffectTrigger, string[]>()
    for (const s of getEffectScenes()) {
      for (const t of s.metadata.effect!.triggers) {
        covered.set(t, [...(covered.get(t) ?? []), s.id])
      }
    }
    for (const t of ALL_TRIGGERS) {
      expect(covered.get(t), `no effect scene answers "${t}"`).toBeDefined()
    }
  })

  it('drop and transient are answered by exactly one scene each', () => {
    // Two scenes racing for the same rare, high-value trigger would mean
    // `pickVariedScene`'s weighting decides which one a drop actually gets,
    // rather than it being a deliberate one-to-one mapping.
    const byTrigger = (t: EffectTrigger) =>
      getEffectScenes().filter((s) => s.metadata.effect!.triggers.includes(t))
    expect(byTrigger('drop')).toHaveLength(1)
    expect(byTrigger('transient')).toHaveLength(1)
  })

  it('the frequent trigger (transient) carries the longest cooldown', () => {
    // The mitigation for firing on a common event is throttling how often it
    // can repeat, not shortening the effect below the roster's own 1-8s
    // lifetime floor (see effectLifecycle.test.ts).
    const spark = getEffectScenes().find((s) => s.id === 'spark')!
    const shock = getEffectScenes().find((s) => s.id === 'shock')!
    expect(spark.metadata.effect!.cooldownSec).toBeGreaterThan(2)
    expect(spark.metadata.effect!.cooldownSec!).toBeLessThan(shock.metadata.effect!.cooldownSec!)
  })

  it('is priced from a real SCENE_COST_MS row, not the high-cost unknown fallback', async () => {
    // Regression guard for the slotBudget/sceneCost registry invariants this
    // roster addition had to satisfy: `isSceneCostMeasured` must be true for
    // all three, or every composition budget check treats them as an
    // 8ms-per-tier unknown, which is wildly pessimistic for a few exp() calls.
    const { isSceneCostMeasured } = await import('../../engine/sceneCost')
    for (const s of getEffectScenes()) {
      expect(isSceneCostMeasured(s.id), s.id).toBe(true)
    }
  })
})
