import { describe, expect, it } from 'vitest'
import { composeLayers } from '../PerformanceDirector'
import { admitSlots, canFundOverlap, slotCost, TIER_BUDGET } from '../slotBudget'
import { POST_CHAIN_UNITS } from '../frameLoad'

/**
 * Fixed per-frame cost: the post chain, the one cost present in every frame.
 * `TIER_BUDGET` is TOTAL frame capacity, so anything reasoning about what is
 * left for scenes has to subtract this — which is exactly what
 * PerformanceDirector passes to `composeLayers`.
 */
const FIXED = POST_CHAIN_UNITS
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
  /**
   * Some layers staying on screen through the fade, on top of the two
   * primaries. Deliberately its OWN constant rather than reusing `FIXED` from
   * above: this block is exercising `canFundOverlap`'s generic `layerUnits`
   * argument, a concept unrelated to frameLoad's fixed per-frame cost — the two
   * only ever shared a numeric value by coincidence. Derived, not hardcoded, so
   * `heavy + heavy + LAYER_UNITS` lands exactly on tier 0's capacity by
   * construction rather than by a magic number staying in sync with it.
   */
  const LAYER_UNITS = TIER_BUDGET[0] - heavy - heavy

  it('funds two heavy primaries only at the top tier', () => {
    expect(canFundOverlap(TIER_BUDGET[0], heavy, heavy, LAYER_UNITS)).toBe(true)
    for (const tier of [1, 2, 3, 4]) {
      expect(canFundOverlap(TIER_BUDGET[tier], heavy, heavy, LAYER_UNITS), `tier ${tier}`).toBe(
        false,
      )
    }
  })

  it('funds two low primaries at every tier', () => {
    for (let tier = 0; tier < TIER_BUDGET.length; tier++) {
      expect(canFundOverlap(TIER_BUDGET[tier], low, low, LAYER_UNITS), `tier ${tier}`).toBe(true)
    }
  })

  it('counts the layers that stay on screen through the fade', () => {
    // The regression: two heavy primaries exactly fill the tier-0 budget, so
    // the old two-argument test called the overlap affordable — while `ribbons`
    // and an overlay were also rendering.
    expect(canFundOverlap(TIER_BUDGET[0], heavy, heavy, LAYER_UNITS)).toBe(true)
    expect(canFundOverlap(TIER_BUDGET[0], heavy, heavy, LAYER_UNITS + 1)).toBe(false)
  })

  it('tests pairs the old bothHeavy conjunct never reached', () => {
    // Neither scene is `high` on both sides, so the previous guard did not
    // even evaluate this pair.
    const medium = slotCost('medium', 'primary')
    expect(canFundOverlap(TIER_BUDGET[0], heavy, medium, LAYER_UNITS + 3)).toBe(false)
    expect(canFundOverlap(TIER_BUDGET[0], heavy, medium, LAYER_UNITS + 2)).toBe(true)
  })

  it('treats a first-ever switch (no outgoing scene) as cheap', () => {
    // Nothing is fading out on the very first commit, so only the incoming
    // scene and the layers count.
    expect(canFundOverlap(TIER_BUDGET[4], 0, heavy, LAYER_UNITS)).toBe(false)
    expect(canFundOverlap(TIER_BUDGET[4], 0, low, LAYER_UNITS + 1)).toBe(true)
  })
})

/**
 * Background-slot acceptance.
 *
 * This block used to assert the opposite — that the slot was NEVER filled —
 * because the four-slot composition model shipped with no scene declaring the
 * role, so merging it had to be a provable visual no-op (F18). `ink` is the
 * first background scene, so the interesting property flipped: the slot must now
 * actually fill, must stay exempt from the editorial layer cap, and must still
 * be shed when the frame cannot fund it.
 *
 * The effect slot is still genuinely empty, and that assertion stays.
 */
const backgroundPool = () => SCENES.filter((s) => s.metadata.roles.includes('background'))

describe('background slot composition', () => {
  it('registers at least one background scene and no effect scenes', () => {
    expect(backgroundPool().length).toBeGreaterThan(0)
    for (const s of SCENES) {
      expect(s.metadata.roles, s.id).not.toContain('effect')
    }
  })

  it('fills the background slot from the pool when the budget allows', () => {
    const out = composeLayers({
      primaryCost: 'low',
      budget: sceneBudget(0),
      pools: { background: backgroundPool() },
      mood: 'groove',
      recentIds: [],
    })
    expect(out.background).not.toBeNull()
    expect(backgroundPool().map((s) => s.id)).toContain(out.background)
  })

  it('leaves the slot alone when the pool is empty', () => {
    // PerformanceDirector passes an empty background pool on every non-section
    // frame, and reads "empty pool" as "hold the current ground" rather than
    // "clear it". A background that recomposed every phrase would just be a
    // second primary.
    const out = composeLayers({
      primaryCost: 'low',
      budget: sceneBudget(0),
      pools: { background: [] },
      mood: 'groove',
      recentIds: [],
    })
    expect(out.background).toBeNull()
  })

  it('exempts the background from the editorial layer cap', () => {
    // MAX_LAYERS_BY_PRIMARY_COST allows exactly one layer over a `high`
    // primary. Ground is not a stack layer, so it must still land alongside
    // that one — otherwise a heavy subject can never have a floor under it.
    const accents = SCENES.filter((s) => s.metadata.roles.includes('accent'))
    const out = composeLayers({
      primaryCost: 'high',
      budget: TIER_BUDGET[0],
      pools: { background: backgroundPool(), accent: accents },
      mood: 'groove',
      recentIds: [],
    })
    expect(out.background).not.toBeNull()
  })

  it('sheds the background when the frame cannot fund it', () => {
    // The cost budget stays the GPU guard even though the art-direction cap
    // does not apply: a budget that funds nothing must fill nothing.
    const out = composeLayers({
      primaryCost: 'high',
      budget: 0,
      pools: { background: backgroundPool() },
      mood: 'groove',
      recentIds: [],
    })
    expect(out.background).toBeNull()
  })

  it('offers ground in every mood its scenes declare', () => {
    // A background pool that is empty at some moods reproduces the layer-pool
    // problem one slot over: the ground would blink out at exactly the moods
    // nobody tested.
    for (const mood of ['ambient', 'mellow', 'groove', 'building', 'peak'] as const) {
      const pool = backgroundPool().filter((s) => s.metadata.moods.includes(mood))
      expect(pool.length, `no background scene for ${mood}`).toBeGreaterThan(0)
    }
  })

  it('runs a heavy primary solo from tier 3 down, matching maxHeavyLayers', () => {
    // The old rule: allowLayer = maxHeavyLayers >= 2 || !primaryHeavy, with
    // maxHeavyLayers being 2 at tiers 0-1 and 1 at tiers 2-4. This block used to
    // cover tier 2 as well, back when the AI-texture overlay's now-deleted
    // GENERATIVE_UNITS reservation ate the one spare unit tier 2 has — see the
    // next test for what tier 2 actually does today.
    for (const tier of [3, 4]) {
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

  it('admits one cheap layer alongside a heavy primary at tier 2', () => {
    // Tier 2's budget (7) less a heavy primary (4) less the fixed cost (2)
    // leaves exactly 1 spare unit — enough for `orbs` (`low`, 1 unit) and
    // nothing costlier. This unit only exists because the AI-texture overlay's
    // GENERATIVE_UNITS reservation was removed outright rather than merely
    // disabled; real GPU headroom is honestly reflected here, not clawed back
    // to preserve a boundary that a phantom cost used to enforce.
    //
    // Pool pinned to exactly `orbs` rather than the whole roster: with more
    // than one candidate, `pickVariedScene` rolls `Math.random()` and could
    // land on a costlier accent scene the 1 spare unit can't fund, making the
    // assertion flaky through no fault of the budget logic under test.
    const out = composeLayers({
      primaryCost: 'high',
      budget: sceneBudget(2),
      pools: { accent: [getScene('orbs')] },
      mood: 'groove',
      recentIds: [],
    })
    expect(out).toEqual({ background: null, accent: 'orbs', overlay: null })
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
