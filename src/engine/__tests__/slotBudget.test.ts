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
import { SCENES } from '../../scenes'

/**
 * Fixed per-frame cost: the post chain, plus the feedback pass when trails are
 * actually running. `TIER_BUDGET_MS` is TOTAL frame capacity, so anything
 * reasoning about what is left for scenes has to subtract this — which is
 * exactly what PerformanceDirector passes to `composeLayers`.
 */
const FIXED = POST_CHAIN_MS + FEEDBACK_MS
/** The budget a composition actually gets at `tier`, as production computes it. */
const sceneBudget = (tier: number) => TIER_BUDGET_MS[tier] - FIXED

/** Two ends of the measured roster, used throughout. */
// Both must be scenes still in the LIVE roster: the licence sweep (F105) took
// `synthgrid` and `orbs` out, and an unregistered id prices from the pessimistic
// fallback rather than from its measurement, which quietly changes what these
// tests are testing.
//
// Repointed after the 2026-08-27 sweep. `ribbons` was the dearest scene at
// 13.11 ms and is now the second CHEAPEST at 0.72 — nearly all of that 13.11
// was a phantom CPU surcharge read off whole-frame wall clock, which the new
// sweep finds no trace of (see sceneCost.ts). A fixture that inverted that hard
// is not a fixture worth keeping pointed at the same name.
const EXPENSIVE = 'kifs' // 2.97 ms at tier 0 — dearest licensed scene
const CHEAP = 'maze' // 0.42 ms, and declared `high`, which is its own point

/**
 * A primary that genuinely cannot fund a layer at any tier.
 *
 * Deliberately a QUARANTINED scene, and that is safe here for the one reason
 * the note above cares about: `synthgrid` still has its measured row in
 * `SCENE_COST_MS` (a disabled scene keeps its metadata so re-enabling it is
 * moving one entry back), so it prices from 22.35 ms of measurement rather than
 * from a label.
 *
 * It has to come from outside the live roster because **nothing inside it is
 * expensive enough any more**. The dearest licensed scene is now 2.97 ms
 * against an 8 ms tier-0 composition budget, so every live scene can fund a
 * layer at every tier. That is a real and welcome change, pinned by its own
 * test below — but it leaves the "budget outranks pool" branch with no live
 * scene able to exercise it.
 */
const OVER_BUDGET = 'synthgrid'

describe('slotCostMs', () => {
  it('charges the measured cost in the primary slot', () => {
    expect(slotCostMs(EXPENSIVE, 0, 'primary')).toBe(SCENE_COST_MS[EXPENSIVE][0])
    expect(slotCostMs(CHEAP, 0, 'primary')).toBe(SCENE_COST_MS[CHEAP][0])
  })

  it('prices the label out of the decision entirely', () => {
    // The finding that motivated the whole change, restated against the
    // 2026-08-27 sweep. The old evidence (`synthgrid` ~190x dearer than
    // `pointcloud` while carrying a cheaper label) is gone with the phantom CPU
    // surcharge, but the inversion it was evidence FOR survives intact and is
    // now inside the live roster:
    //
    //   wingfold  declared `low`   measures 2.54 ms
    //   maze      declared `high`  measures 0.42 ms
    //
    // Same label, 6x apart, and the labels point the wrong way round. A budget
    // cannot mean anything on top of that.
    expect(slotCostMs('wingfold', 0, 'primary')).toBeGreaterThan(
      slotCostMs('maze', 0, 'primary') * 5,
    )
  })

  it('has no live scene dear enough to forbid a layer', () => {
    // The headroom the measurement bought, stated as a fact rather than left
    // implicit in fixtures. Every licensed scene now fits inside a tier-0
    // composition budget with room to spare for a second one — which is why
    // OVER_BUDGET above has to reach outside the roster.
    for (const scene of SCENES) {
      const solo = slotCostMs(scene.id, 0, 'primary')
      expect(solo, scene.id).toBeLessThan(sceneBudget(0) / 2)
    }
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
/**
 * The background and effect slots have content now (F18, F20). This block used
 * to assert the opposite — that both pools were empty and the whole composition
 * machinery was therefore a visual no-op. That was an accurate record of the
 * state, and the state changed on purpose.
 */
/**
 * The background slot survived the licence sweep, and did it the right way.
 *
 * `orbs` held the role (F18) and F105 quarantined it as unverified Shadertoy
 * provenance — but `malachite`, one of the port's own original scenes, declares
 * `background` too. So the slot went from being filled by a scene that could
 * not be sold to being filled by one that can, without passing through empty.
 */
describe('composition with the background slot filled', () => {
  it('registers at least one background scene, and a licensed one', () => {
    const bg = SCENES.filter((s) => s.metadata.roles.includes('background'))
    expect(bg.length).toBeGreaterThan(0)
    for (const s of bg) expect(s.metadata.license, s.id).not.toBe('noncommercial')
  })

  it('fills the background under a cheap primary', () => {
    // The slot has the most considered treatment of any — a 0.40 default gain
    // and section-boundary-only recompose — and until now it was permanently
    // empty, so none of that had ever run.
    const out = composeLayers({
      primaryId: CHEAP,
      primaryCost: 'low',
      budget: sceneBudget(0),
      tier: 0,
      pools: {
        background: SCENES.filter((s) => s.metadata.roles.includes('background')),
      },
      mood: 'groove',
      recentIds: [],
    })
    expect(out.background).not.toBeNull()
  })

  it('still refuses it under a primary that leaves no room', () => {
    // The budget outranks the pool. `synthgrid` is 22 ms measured; a ground
    // layer under it is not a composition, it is a dropped frame.
    const out = composeLayers({
      primaryId: OVER_BUDGET,
      primaryCost: 'medium',
      budget: sceneBudget(4),
      tier: 4,
      pools: {
        background: SCENES.filter((s) => s.metadata.roles.includes('background')),
      },
      mood: 'groove',
      recentIds: [],
    })
    expect(out.background).toBeNull()
  })

  it('runs a genuinely expensive primary solo at every tier', () => {
    // The old version of this test said "a HIGH primary runs solo from tier 2
    // down", which was a statement about a label. It is now a statement about
    // 22 ms of measured GPU: `synthgrid` leaves nothing for a layer anywhere on
    // the ladder, including tier 0.
    for (let tier = 0; tier < TIER_BUDGET_MS.length; tier++) {
      const out = composeLayers({
        primaryId: OVER_BUDGET,
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
    // 2.03 ms, a quarter of the tier-0 composition budget. At the SURVIVAL tier
    // it can still carry a layer.
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
