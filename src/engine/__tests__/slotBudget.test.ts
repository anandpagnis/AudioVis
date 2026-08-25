import { describe, expect, it } from 'vitest'
import { composeLayers } from '../PerformanceDirector'
import {
  admitSlots,
  canFundOverlap,
  ROLE_SCALED_FRACTION,
  slotCostMs,
  TIER_BUDGET_MS,
} from '../slotBudget'
import { FEEDBACK_MS, POST_CHAIN_MS } from '../frameLoad'
import { SCENE_COST_MS, sceneCostMs } from '../sceneCost'
import { SCENES, type ScenePerformanceCost } from '../../scenes'

/**
 * Fixed per-frame cost: the post chain, plus the feedback pass when trails are
 * actually running. `TIER_BUDGET_MS` is TOTAL frame capacity, so anything
 * reasoning about what is left for scenes has to subtract this — which is
 * exactly what PerformanceDirector passes to `composeLayers`.
 */
const FIXED = POST_CHAIN_MS + FEEDBACK_MS
/** The budget a composition actually gets at `tier`, as production computes it. */
const sceneBudget = (tier: number) => TIER_BUDGET_MS[tier] - FIXED

const COSTS: ScenePerformanceCost[] = ['low', 'medium', 'high']

/** Two ends of the measured roster, used throughout. */
const EXPENSIVE = 'synthgrid' // 22.35 ms at tier 0 — dearest scene registered
const CHEAP = 'orbs' // 0.06 ms at every tier

describe('slotCostMs', () => {
  it('charges the measured cost in the primary slot', () => {
    expect(slotCostMs(EXPENSIVE, 0, 'primary')).toBe(SCENE_COST_MS[EXPENSIVE][0])
    expect(slotCostMs(CHEAP, 0, 'primary')).toBe(SCENE_COST_MS[CHEAP][0])
  })

  it('prices the label out of the decision entirely', () => {
    // The finding that motivated the whole change. `synthgrid` is declared
    // `medium` and `pointcloud` is declared `high`, so the old ladder charged
    // pointcloud TWICE what synthgrid cost. Measured, synthgrid is ~190x
    // dearer. A budget cannot mean anything on top of that.
    expect(slotCostMs('synthgrid', 0, 'primary')).toBeGreaterThan(
      slotCostMs('pointcloud', 0, 'primary') * 100,
    )
  })

  it('charges full cost in a secondary slot unless the scene opted in', () => {
    // Discounting a scene that ignores ctx.role would budget for work it is
    // still doing — the governor would confidently overcommit the GPU.
    for (const id of [EXPENSIVE, CHEAP]) {
      expect(slotCostMs(id, 0, 'background', false)).toBe(slotCostMs(id, 0, 'primary'))
    }
  })

  it('discounts a roleScalable scene in a secondary slot', () => {
    expect(slotCostMs(EXPENSIVE, 0, 'background', true)).toBeCloseTo(
      SCENE_COST_MS[EXPENSIVE][0] * ROLE_SCALED_FRACTION,
      5,
    )
  })

  it('falls back to the declared label for a scene the sweep never reached', () => {
    // Nothing in SCENES needs this today. It is the path for DISABLED_SCENES if
    // one is promoted, and for any scene added after the sweep — and it must
    // price pessimistically, not freely. See FALLBACK_COST_MS.
    const measured = sceneCostMs(CHEAP, 0)
    expect(slotCostMs('tunnel', 0, 'primary', false, 'high')).toBeGreaterThan(measured)
  })

  it('prices an unknown scene as expensive rather than free', () => {
    // The failure that matters: an id with no measurement and no label must not
    // be admitted on the strength of costing nothing.
    expect(slotCostMs('does-not-exist', 0, 'primary')).toBeGreaterThan(1)
  })
})

/**
 * The property the whole budget rests on: shedding a tier may never make a
 * scene DEARER.
 *
 * The raw sweep is not monotone — `juliawings` measured 12.5 / 5.5 / 7.4 / 8.7 /
 * 7.8 ms across the ladder — so the table monotonises it. Without that, "drop a
 * tier to fit" would sometimes ADD load, and the governor's entire premise
 * inverts on the scenes that need it most.
 */
describe('cost is monotone down the ladder', () => {
  it('never charges more at a lower tier, for any measured scene', () => {
    for (const [id, row] of Object.entries(SCENE_COST_MS)) {
      for (let t = 1; t < row.length; t++) {
        expect(row[t], `${id} tier ${t}`).toBeLessThanOrEqual(row[t - 1])
      }
    }
  })

  it('holds through slotCostMs too, discount included', () => {
    for (const id of Object.keys(SCENE_COST_MS)) {
      for (let t = 1; t < TIER_BUDGET_MS.length; t++) {
        expect(slotCostMs(id, t, 'accent', true), `${id} tier ${t}`).toBeLessThanOrEqual(
          slotCostMs(id, t - 1, 'accent', true),
        )
      }
    }
  })
})

describe('admitSlots', () => {
  it('admits in priority order and stops when the budget runs out', () => {
    const admitted = admitSlots(8, 4, [
      { slot: 'background', ms: 2 },
      { slot: 'accent', ms: 2 },
      { slot: 'overlay', ms: 2 },
    ])
    expect(admitted).toEqual(['background', 'accent'])
  })

  it('skips an unaffordable slot but keeps considering cheaper later ones', () => {
    // Greedy by priority, not all-or-nothing: an expensive background must not
    // starve a trivial accent that still fits. With measured costs this is the
    // common case rather than a corner — most of the roster is under 0.2 ms
    // while a handful of scenes are over 10.
    const admitted = admitSlots(6, 4, [
      { slot: 'background', ms: 4 },
      { slot: 'accent', ms: 1 },
    ])
    expect(admitted).toEqual(['accent'])
  })

  it('respects a caller-supplied order', () => {
    const requests = [
      { slot: 'accent' as const, ms: 2 },
      { slot: 'overlay' as const, ms: 2 },
    ]
    expect(admitSlots(4, 2, requests, ['background', 'overlay', 'accent'])).toEqual(['overlay'])
  })

  it('admits nothing once the primary has consumed the budget', () => {
    expect(admitSlots(4, 4, [{ slot: 'accent', ms: 1 }])).toEqual([])
  })
})

describe('canFundOverlap', () => {
  const at = (id: string, tier: number) => slotCostMs(id, tier, 'primary')

  it('refuses to crossfade the roster’s two dearest scenes at any tier', () => {
    // `synthgrid` alone is 22.4 ms at tier 0 — more than a whole 60 Hz frame.
    // Fading it into `network` is over 44 ms of scene work. The old currency
    // valued that pair at 2 + 4 units and funded it at tiers 0 and 1.
    for (let tier = 0; tier < TIER_BUDGET_MS.length; tier++) {
      expect(
        canFundOverlap(TIER_BUDGET_MS[tier], at('synthgrid', tier), at('network', tier), FIXED),
        `tier ${tier}`,
      ).toBe(false)
    }
  })

  it('funds two cheap primaries at every tier, survival included', () => {
    // This is F84's fix, stated as a test. Under the old currency two `medium`
    // scenes cost 4 of a 5-unit tier-4 budget against 4 units of fixed cost, so
    // an overlap was arithmetically impossible and three of the six transition
    // styles were unreachable on any machine sitting at the bottom tier.
    for (let tier = 0; tier < TIER_BUDGET_MS.length; tier++) {
      expect(
        canFundOverlap(TIER_BUDGET_MS[tier], at(CHEAP, tier), at('kaleido', tier), FIXED),
        `tier ${tier}`,
      ).toBe(true)
    }
  })

  it('leaves most of the roster able to crossfade with itself at every tier', () => {
    // The headroom claim, checked rather than asserted in a comment. If this
    // ever drops back to a handful, the transition vocabulary is dark again.
    for (let tier = 0; tier < TIER_BUDGET_MS.length; tier++) {
      const ids = Object.keys(SCENE_COST_MS)
      const fundable = ids.filter((id) =>
        canFundOverlap(TIER_BUDGET_MS[tier], at(id, tier), at(id, tier), FIXED),
      )
      expect(fundable.length, `tier ${tier}`).toBeGreaterThanOrEqual(ids.length / 2)
    }
  })

  it('counts the layers that stay on screen through the fade', () => {
    // The original regression, now with the real numbers. `network` fading to
    // `heap` while `ribbons` was live measures 22.4 + 5.9 + 13.1 = 41.4 ms in a
    // 16.7 ms frame; the old currency called it 4 + 4 of 8 and funded it. That
    // is where the 33-35 ms transition frames came from.
    const live = at('ribbons', 0)
    expect(
      canFundOverlap(TIER_BUDGET_MS[0], at('network', 0), at('heap', 0), FIXED + live),
    ).toBe(false)
  })

  it('treats a first-ever switch (no outgoing scene) as cheaper', () => {
    // Nothing is fading out on the very first commit, so only the incoming
    // scene and the layers count — and that can be the difference.
    expect(canFundOverlap(TIER_BUDGET_MS[4], 0, at('heap', 4), FIXED)).toBe(true)
    expect(canFundOverlap(TIER_BUDGET_MS[4], at('heap', 4), at('heap', 4), FIXED)).toBe(true)
    expect(canFundOverlap(TIER_BUDGET_MS[4], 0, at('juliawings', 4), FIXED)).toBe(false)
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
    for (let tier = 0; tier < TIER_BUDGET_MS.length; tier++) {
      for (const cost of COSTS) {
        const out = composeLayers({
          primaryId: CHEAP,
          primaryCost: cost,
          budget: sceneBudget(tier),
          tier,
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

  it('runs a genuinely expensive primary solo at every tier', () => {
    // The old version of this test said "a HIGH primary runs solo from tier 2
    // down", which was a statement about a label. It is now a statement about
    // 22 ms of measured GPU: `synthgrid` leaves nothing for a layer anywhere on
    // the ladder, including tier 0.
    for (let tier = 0; tier < TIER_BUDGET_MS.length; tier++) {
      const out = composeLayers({
        primaryId: EXPENSIVE,
        primaryCost: 'medium', // its declared label, which is part of the point
        budget: sceneBudget(tier),
        tier,
        pools: { accent: [SCENES.find((s) => s.id === CHEAP)!] },
        mood: 'groove',
        recentIds: [],
      })
      expect(out, `tier ${tier}`).toEqual({ background: null, accent: null, overlay: null })
    }
  })

  it('now composes a layer under a primary the label called expensive', () => {
    // The headroom, demonstrated. `pointcloud` is declared `high` — 4 of 11
    // units, which with the fixed costs left almost nothing — and measures
    // 0.12 ms. At the SURVIVAL tier it can now carry a layer.
    const out = composeLayers({
      primaryId: 'pointcloud',
      primaryCost: 'high',
      budget: sceneBudget(4),
      tier: 4,
      pools: { accent: [SCENES.find((s) => s.id === CHEAP)!] },
      mood: 'groove',
      recentIds: [],
    })
    expect(out.accent).toBe(CHEAP)
  })

  it('sheds load rather than adding it, wherever it diverges from the old rule', () => {
    // The old rule allowed ANY layer cost once allowLayer was true, so a medium
    // primary at tier 3 could legally pull in a `high` layer. A cost budget
    // cannot reproduce that, and should not: every divergence must shed load,
    // never add it.
    // sceneBudget, not TIER_BUDGET_MS: the composition is funded out of what is
    // left after the fixed per-frame costs, which is what production passes.
    const admitted = admitSlots(sceneBudget(3), slotCostMs('heap', 3, 'primary'), [
      { slot: 'accent', ms: slotCostMs('foldpath', 3, 'accent') },
    ])
    expect(admitted).toEqual([])
  })
})
