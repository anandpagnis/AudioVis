import { describe, expect, it } from 'vitest'
import { composeLayers } from '../PerformanceDirector'
import { admitSlots, canFundOverlap, slotCost, TIER_BUDGET } from '../slotBudget'
import { GENERATIVE_UNITS, POST_CHAIN_UNITS } from '../frameLoad'

/**
 * Fixed per-frame cost: the post chain, plus the generative overlay (on by
 * default). `TIER_BUDGET` is TOTAL frame capacity, so anything reasoning about
 * what is left for scenes has to subtract this — which is exactly what
 * PerformanceDirector passes to `composeLayers`.
 */
const FIXED = POST_CHAIN_UNITS + GENERATIVE_UNITS
/** The budget a composition actually gets at `tier`, as production computes it. */
const sceneBudget = (tier: number) => TIER_BUDGET[tier] - FIXED
import { getScene, SCENES, type ScenePerformanceCost } from '../../scenes'

const COSTS: ScenePerformanceCost[] = ['low', 'medium', 'high']

describe('slotCost', () => {
  it('charges declared cost in the primary slot', () => {
    expect(slotCost('low', 'primary')).toBe(1)
    expect(slotCost('medium', 'primary')).toBe(2)
    expect(slotCost('high', 'primary')).toBe(4)
  })

  it('charges full cost in a secondary slot unless the scene opted in', () => {
    // Discounting a scene that ignores ctx.role would budget for work it is
    // still doing — the governor would confidently overcommit the GPU.
    for (const cost of COSTS) {
      expect(slotCost(cost, 'background', false)).toBe(slotCost(cost, 'primary'))
    }
  })

  it('discounts one step for a roleScalable scene in a secondary slot', () => {
    expect(slotCost('high', 'background', true)).toBe(2)
    expect(slotCost('medium', 'accent', true)).toBe(1)
    expect(slotCost('low', 'overlay', true)).toBe(1)
  })

  it('never discounts below one unit', () => {
    for (const cost of COSTS) expect(slotCost(cost, 'effect', true)).toBeGreaterThanOrEqual(1)
  })
})

describe('admitSlots', () => {
  it('admits in priority order and stops when the budget runs out', () => {
    const admitted = admitSlots(8, 4, [
      { slot: 'background', units: 2 },
      { slot: 'accent', units: 2 },
      { slot: 'overlay', units: 2 },
    ])
    expect(admitted).toEqual(['background', 'accent'])
  })

  it('skips an unaffordable slot but keeps considering cheaper later ones', () => {
    // Greedy by priority, not all-or-nothing: an expensive background must not
    // starve a trivial accent that still fits.
    const admitted = admitSlots(6, 4, [
      { slot: 'background', units: 4 },
      { slot: 'accent', units: 1 },
    ])
    expect(admitted).toEqual(['accent'])
  })

  it('respects a caller-supplied order', () => {
    const requests = [
      { slot: 'accent' as const, units: 2 },
      { slot: 'overlay' as const, units: 2 },
    ]
    expect(admitSlots(4, 2, requests, ['background', 'overlay', 'accent'])).toEqual(['overlay'])
  })

  it('admits nothing once the primary has consumed the budget', () => {
    expect(admitSlots(4, 4, [{ slot: 'accent', units: 1 }])).toEqual([])
  })
})

describe('canFundOverlap', () => {
  const heavy = slotCost('high', 'primary')
  const low = slotCost('low', 'primary')

  it('funds two heavy primaries only at the top tier', () => {
    // 4 + 4 + 3 fixed = 11, which is exactly tier 0's total capacity.
    expect(canFundOverlap(TIER_BUDGET[0], heavy, heavy, FIXED)).toBe(true)
    for (const tier of [1, 2, 3, 4]) {
      expect(canFundOverlap(TIER_BUDGET[tier], heavy, heavy, FIXED), `tier ${tier}`).toBe(false)
    }
  })

  it('funds two low primaries at every tier', () => {
    for (let tier = 0; tier < TIER_BUDGET.length; tier++) {
      expect(canFundOverlap(TIER_BUDGET[tier], low, low, FIXED), `tier ${tier}`).toBe(true)
    }
  })

  it('counts the layers that stay on screen through the fade', () => {
    // The regression: two heavy primaries exactly fill the tier-0 budget, so
    // the old two-argument test called the overlap affordable — while `ribbons`
    // and an overlay were also rendering. 11 units of real load against 8.
    expect(canFundOverlap(TIER_BUDGET[0], heavy, heavy, FIXED)).toBe(true)
    expect(canFundOverlap(TIER_BUDGET[0], heavy, heavy, FIXED + 1)).toBe(false)
  })

  it('tests pairs the old bothHeavy conjunct never reached', () => {
    // high + medium + two layers = 4 + 2 + 3 = 9 > 8. Neither scene is `high`
    // on both sides, so the previous guard did not even evaluate this.
    const medium = slotCost('medium', 'primary')
    expect(canFundOverlap(TIER_BUDGET[0], heavy, medium, FIXED + 3)).toBe(false)
    expect(canFundOverlap(TIER_BUDGET[0], heavy, medium, FIXED + 2)).toBe(true)
  })

  it('treats a first-ever switch (no outgoing scene) as cheap', () => {
    // Nothing is fading out on the very first commit, so only the incoming
    // scene and the layers count.
    expect(canFundOverlap(TIER_BUDGET[4], 0, heavy, FIXED)).toBe(false)
    expect(canFundOverlap(TIER_BUDGET[4], 0, low, FIXED + 1)).toBe(true)
  })
})

/**
 * Phase-3 acceptance: with no background or effect scenes registered, the
 * composition machinery must behave exactly as the old two-slot model did —
 * merging it is a visual no-op.
 *
 * This is the state the code actually ships in, so it is the primary path, not
 * an edge case.
 */
describe('no-op acceptance with zero background/effect scenes', () => {
  it('registers no background or effect scenes', () => {
    for (const s of SCENES) {
      expect(s.metadata.roles, s.id).not.toContain('background')
      expect(s.metadata.roles, s.id).not.toContain('effect')
    }
  })

  it('never fills the background slot, at any quality tier', () => {
    for (let tier = 0; tier < TIER_BUDGET.length; tier++) {
      for (const cost of COSTS) {
        const out = composeLayers({
          primaryCost: cost,
          budget: sceneBudget(tier),
          // What PerformanceDirector actually passes today: the background pool
          // is whatever declares the role, which is nothing.
          pools: {
            background: SCENES.filter((s) => s.metadata.roles.includes('background')),
            accent: SCENES.filter((s) => s.metadata.roles.includes('accent')),
            overlay: SCENES.filter((s) => s.metadata.roles.includes('overlay')),
          },
          mood: 'groove',
          recentIds: [],
        })
        expect(out.background, `tier ${tier} / ${cost} primary`).toBeNull()
      }
    }
  })

  it('runs a heavy primary solo from tier 2 down, matching maxHeavyLayers', () => {
    // The old rule: allowLayer = maxHeavyLayers >= 2 || !primaryHeavy, with
    // maxHeavyLayers being 2 at tiers 0-1 and 1 at tiers 2-4.
    for (const tier of [2, 3, 4]) {
      const out = composeLayers({
        primaryCost: 'high',
        budget: sceneBudget(tier),
        pools: {
          accent: SCENES.filter((s) => s.metadata.roles.includes('accent')),
          overlay: SCENES.filter((s) => s.metadata.roles.includes('overlay')),
        },
        mood: 'groove',
        recentIds: [],
      })
      expect(out, `tier ${tier}`).toEqual({ background: null, accent: null, overlay: null })
    }
  })

  it('still composes a layer alongside a heavy primary at the top tier', () => {
    const out = composeLayers({
      primaryCost: 'high',
      budget: TIER_BUDGET[0],
      pools: { accent: [getScene('ribbons')] },
      mood: 'groove',
      recentIds: [],
    })
    expect(out.accent).toBe('ribbons')
  })

  it('is stricter than the old rule but never looser', () => {
    // The old rule allowed ANY layer cost once allowLayer was true, so a medium
    // primary at tier 3 could legally pull in a `high` layer. A cost budget
    // cannot reproduce that, and should not: every divergence must shed load,
    // never add it. `foldpath` is high-cost and overlay-incapable, so use a
    // synthetic high-cost accent request directly.
    // sceneBudget, not TIER_BUDGET: the composition is funded out of what is
    // left after the fixed per-frame costs, which is what production passes.
    const admitted = admitSlots(sceneBudget(3), slotCost('medium', 'primary'), [
      { slot: 'accent', units: slotCost('high', 'accent') },
    ])
    expect(admitted).toEqual([])
  })
})
