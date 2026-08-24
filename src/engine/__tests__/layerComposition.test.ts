import { describe, expect, it } from 'vitest'
import { composeLayers } from '../PerformanceDirector'
import { resolveLayerIds } from '../SceneManager'
import type { SceneDef, SceneRole, ScenePerformanceCost } from '../../scenes'

/**
 * Layer-composition invariants.
 *
 * The originals here covered a two-slot, mutually-exclusive model where the
 * only failure mode was "a slot never got cleared" (which showed up as a scene
 * playing on top of everything). With three slots that can be occupied at once,
 * the collision rule becomes all-pairs — two LAYERS can now duplicate each
 * other, which was structurally impossible before.
 */
/**
 * A synthetic scene of an exact cost, for the admission tests below.
 *
 * Those tests are about the ADMISSION LOGIC — does the budget refuse what it
 * cannot fund, does the cap refuse what it should not stack — and they used to
 * reach into the real registry for scenes of a convenient cost. That coupled
 * them to art direction: retagging `ribbons` low→medium and `network` low→high
 * from benchmark data broke a test that had nothing to do with either scene,
 * and would equally have let a wrong tag slip through as a green suite.
 *
 * `resolveLayerIds` above still uses real ids, correctly — those tests are
 * about identity collisions and never look at cost.
 */
function fake(id: string, cost: ScenePerformanceCost, roles: SceneRole[]): SceneDef {
  return {
    id,
    name: id,
    component: () => null,
    metadata: {
      roles,
      moods: ['groove'],
      bands: ['energy'],
      intensity: 'medium',
      compatibleWith: [],
      performanceCost: cost,
      moodFit: { groove: 0.8 },
    },
  }
}

const lowA = fake('lowA', 'low', ['accent'])
const lowB = fake('lowB', 'low', ['overlay'])
const lowBg = fake('lowBg', 'low', ['background'])

describe('resolveLayerIds — all-pairs collision', () => {
  it('drops a layer that duplicates the committed primary', () => {
    const out = resolveLayerIds(
      { background: null, accent: 'wireframe', overlay: null },
      'wireframe',
      null,
    )
    expect(out.accent).toBeNull()
  })

  it('drops a layer that duplicates a pending primary', () => {
    // The collision can appear *after* the layer mounted, when the primary
    // switches to that same scene — the case a creation-time-only guard misses,
    // leaving the scene mounted twice and compositing over itself.
    const out = resolveLayerIds(
      { background: null, accent: 'wireframe', overlay: null },
      'chrome',
      'wireframe',
    )
    expect(out.accent).toBeNull()
  })

  it('drops a later slot that duplicates an earlier one', () => {
    // New with three slots: nothing stopped two layers naming the same scene.
    const out = resolveLayerIds(
      { background: 'ribbons', accent: 'ribbons', overlay: 'ribbons' },
      'wireframe',
      null,
    )
    expect(out).toEqual({ background: 'ribbons', accent: null, overlay: null })
  })

  it('keeps distinct, non-colliding layers', () => {
    const out = resolveLayerIds(
      { background: 'network', accent: 'ribbons', overlay: null },
      'wireframe',
      'chrome',
    )
    expect(out).toEqual({ background: 'network', accent: 'ribbons', overlay: null })
  })

  it('passes empty slots straight through', () => {
    expect(
      resolveLayerIds({ background: null, accent: null, overlay: null }, 'wireframe', null),
    ).toEqual({ background: null, accent: null, overlay: null })
  })
})

describe('composeLayers', () => {
  const base = {
    mood: 'groove' as const,
    recentIds: [] as string[],
    budget: 8,
  }

  it('leaves a slot unfilled when its pool is empty', () => {
    // The steady state today: no background scenes are registered at all.
    const out = composeLayers({
      ...base,
      primaryCost: 'low',
      pools: { background: [], accent: [lowA] },
    })
    expect(out.background).toBeNull()
    expect(out.accent).toBe('lowA')
  })

  it('fills accent and overlay together — they are no longer exclusive', () => {
    const out = composeLayers({
      ...base,
      primaryCost: 'low',
      pools: { accent: [lowA], overlay: [lowB] },
    })
    expect(out.accent).toBe('lowA')
    expect(out.overlay).toBe('lowB')
  })

  it('runs a heavy primary solo at a tight budget', () => {
    // high primary = 4 units, budget 4 → nothing left over.
    const out = composeLayers({
      ...base,
      budget: 4,
      primaryCost: 'high',
      pools: { accent: [lowA], overlay: [lowB] },
    })
    expect(out).toEqual({ background: null, accent: null, overlay: null })
  })

  it('honours the priority override when only one slot fits', () => {
    // low primary (1) + budget 2 leaves room for exactly one low layer.
    const pools = { accent: [lowA], overlay: [lowB] }
    const accentFirst = composeLayers({ ...base, budget: 2, primaryCost: 'low', pools })
    expect(accentFirst.accent).toBe('lowA')
    expect(accentFirst.overlay).toBeNull()

    const overlayFirst = composeLayers({
      ...base,
      budget: 2,
      primaryCost: 'low',
      pools,
      priority: ['background', 'overlay', 'accent'],
    })
    expect(overlayFirst.overlay).toBe('lowB')
    expect(overlayFirst.accent).toBeNull()
  })

  it('never returns a scene the pool did not contain', () => {
    const pool: SceneDef[] = [lowA]
    const out = composeLayers({ ...base, primaryCost: 'low', pools: { accent: pool } })
    expect([null, 'lowA']).toContain(out.accent)
  })
})

/**
 * The editorial cap, which is deliberately a SEPARATE rule from the cost budget
 * above.
 *
 * The budget answers "can the GPU carry this?" and always answered it
 * correctly; it was never asked "does this many things in one frame read as
 * composed?". Measured over 40k simulated compositions, 57% filled both accent
 * and overlay — three scenes on screen, four mid-crossfade, every one blending
 * additively. No budget number fixes that, because at a comfortable tier two
 * low-cost layers genuinely do fit.
 */
describe('composeLayers — editorial layer cap', () => {
  const base = {
    mood: 'groove' as const,
    recentIds: [] as string[],
    // Deliberately the richest budget: the cap must bind on its own, not as a
    // side effect of running out of units.
    budget: 8,
  }

  it('allows two detail layers over a light primary', () => {
    const out = composeLayers({
      ...base,
      primaryCost: 'low',
      pools: { accent: [lowA], overlay: [lowB] },
    })
    expect(out.accent).toBe('lowA')
    expect(out.overlay).toBe('lowB')
  })

  it('allows only one over a heavy primary, even when both are affordable', () => {
    // 4 (high primary) + 1 + 1 = 6 of 8 units. The budget would admit both;
    // the cap is what refuses the second, because a heavy primary has already
    // filled the frame and a second layer is noise over noise.
    const out = composeLayers({
      ...base,
      primaryCost: 'high',
      pools: { accent: [lowA], overlay: [lowB] },
    })
    const filled = [out.accent, out.overlay].filter(Boolean)
    expect(filled).toHaveLength(1)
  })

  it('drops the LOWER-priority slot when the cap bites', () => {
    // The cap takes a prefix of the admitted list, which arrives in the
    // caller's priority order — so the slot the material actually favours is
    // the one kept.
    const pools = { accent: [lowA], overlay: [lowB] }
    const accentLed = composeLayers({ ...base, primaryCost: 'high', pools })
    expect(accentLed.accent).toBe('lowA')
    expect(accentLed.overlay).toBeNull()

    const overlayLed = composeLayers({
      ...base,
      primaryCost: 'high',
      pools,
      priority: ['background', 'overlay', 'accent'],
    })
    expect(overlayLed.overlay).toBe('lowB')
    expect(overlayLed.accent).toBeNull()
  })

  it('does not count the background against the cap', () => {
    // Background is the ground the composition sits on, not one of the detail
    // layers stacking over the subject — and it carries a 0.40 default gain
    // precisely so it reads as behind rather than alongside.
    const out = composeLayers({
      ...base,
      primaryCost: 'low',
      pools: { background: [lowBg], accent: [lowA], overlay: [lowB] },
    })
    expect(out.background).toBe('lowBg')
    expect(out.accent).toBe('lowA')
    expect(out.overlay).toBe('lowB')
  })

  it('still lets the budget refuse a layer the cap would have allowed', () => {
    // The two rules compose: whichever is stricter wins. Here the budget is
    // the binding one (high primary = 4 of 4), and the cap changes nothing.
    const out = composeLayers({
      ...base,
      budget: 4,
      primaryCost: 'high',
      pools: { accent: [lowA] },
    })
    expect(out.accent).toBeNull()
  })
})

/**
 * Render-time budget enforcement.
 *
 * The budget used to be checked only where decisions were made, never before
 * the frame was actually drawn — so a legal decision could be pushed over the
 * line afterwards and nothing noticed. Two routes did it constantly: a
 * crossfade (composeLayers reserves ONE primary, so mid-fade it offers the
 * outgoing scene's share to the layers as though it were free) and a tier drop
 * (layers admitted at capacity 11 stay mounted when the governor steps to 7).
 */
describe('resolveLayerIds — budget enforcement', () => {
  const ids = { background: 'orbs', accent: 'ribbons', overlay: 'network' }
  /** Every layer costs 2 units, so the arithmetic is easy to read. */
  const unitsFor = () => 2

  it('admits everything when capacity allows', () => {
    const out = resolveLayerIds(ids, 'wireframe', null, { remaining: 6, unitsFor })
    expect(out).toEqual(ids)
  })

  it('sheds the least structural layer first', () => {
    // 4 units buys two of the three. LAYER_ROLES order is background, accent,
    // overlay — so overlay is the one that goes, and the ground layer stays.
    const out = resolveLayerIds(ids, 'wireframe', null, { remaining: 4, unitsFor })
    expect(out.background).toBe('orbs')
    expect(out.accent).toBe('ribbons')
    expect(out.overlay).toBeNull()
  })

  it('drops everything when the frame is already full', () => {
    // What a heavy crossfade plus fixed costs leaves at tier 0.
    const out = resolveLayerIds(ids, 'wireframe', null, { remaining: 0, unitsFor })
    expect(out).toEqual({ background: null, accent: null, overlay: null })
  })

  it('never exceeds the capacity it was given', () => {
    for (let remaining = 0; remaining <= 6; remaining++) {
      const out = resolveLayerIds(ids, 'wireframe', null, { remaining, unitsFor })
      const spent = Object.values(out).filter(Boolean).length * 2
      expect(spent, `remaining ${remaining}`).toBeLessThanOrEqual(remaining)
    }
  })

  it('still fits a cheap layer where an expensive one did not', () => {
    // Skipping rather than breaking: refusing the overlay too would shed more
    // than the frame actually needs.
    const out = resolveLayerIds(ids, 'wireframe', null, {
      remaining: 1,
      unitsFor: (id) => (id === 'network' ? 1 : 4),
    })
    expect(out.background).toBeNull()
    expect(out.accent).toBeNull()
    expect(out.overlay).toBe('network')
  })

  it('still resolves collisions while enforcing the budget', () => {
    // The two rules compose: a layer duplicating the primary is dropped for
    // identity reasons, and its budget is not consumed by the corpse.
    const out = resolveLayerIds(
      { background: 'wireframe', accent: 'ribbons', overlay: 'network' },
      'wireframe',
      null,
      { remaining: 4, unitsFor },
    )
    expect(out.background).toBeNull()
    expect(out.accent).toBe('ribbons')
    expect(out.overlay).toBe('network')
  })

  it('is unlimited when no budget is supplied', () => {
    expect(resolveLayerIds(ids, 'wireframe', null)).toEqual(ids)
  })
})
