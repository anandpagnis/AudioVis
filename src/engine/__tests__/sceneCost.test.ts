import { describe, expect, it } from 'vitest'
import {
  COST_TIERS,
  FALLBACK_COST_MS,
  isSceneCostMeasured,
  SCENE_COST_MODEL,
  SCENE_COST_MS,
  sceneCostMs,
} from '../sceneCost'
import { DISABLED_SCENES, SCENES, type ScenePerformanceCost } from '../../scenes'

describe('the table itself', () => {
  it('gives every measured scene one price per tier', () => {
    for (const [id, row] of Object.entries(SCENE_COST_MS)) {
      expect(row.length, id).toBe(COST_TIERS)
      for (const ms of row) expect(ms, id).toBeGreaterThan(0)
    }
  })

  it('names only scenes that still exist somewhere in the roster', () => {
    // A stale row is worse than a missing one: it prices a scene that no longer
    // exists and silently stops pricing the one that replaced it.
    //
    // DISABLED_SCENES counts. The licence sweep (F105) moved ten measured
    // scenes out of the live roster without deleting them — files, loaders and
    // metadata all stay, so re-enabling one is moving its entry back. Dropping
    // their measurements would mean re-running the bench for a scene that has
    // not changed a line.
    const known = new Set([...SCENES, ...DISABLED_SCENES].map((s) => s.id))
    for (const id of Object.keys(SCENE_COST_MS)) expect(known.has(id), id).toBe(true)
  })

  it('leaves the fallbacks pessimistic relative to what was measured', () => {
    // An unmeasured scene must earn its way into a composition rather than be
    // admitted on the strength of a label. Every fallback sits above the median
    // measured scene, which is 0.16 ms.
    const median = 0.16
    for (const row of Object.values(FALLBACK_COST_MS)) {
      for (const ms of row) expect(ms).toBeGreaterThan(median)
    }
  })

  it('keeps the fallbacks monotone down the ladder as well', () => {
    for (const [label, row] of Object.entries(FALLBACK_COST_MS)) {
      for (let t = 1; t < row.length; t++) {
        expect(row[t], `${label} tier ${t}`).toBeLessThanOrEqual(row[t - 1])
      }
    }
  })
})

describe('sceneCostMs', () => {
  it('reads the measured row when there is one', () => {
    expect(sceneCostMs('synthgrid', 0)).toBe(SCENE_COST_MS.synthgrid[0])
    expect(sceneCostMs('synthgrid', 4)).toBe(SCENE_COST_MS.synthgrid[4])
  })

  it('prefers the measurement over the declared label', () => {
    // `synthgrid` declares `medium`, whose fallback is 3 ms. It measures 22.35.
    // If this ever inverts, the label is back in charge of the budget.
    expect(sceneCostMs('synthgrid', 0, 'medium')).toBeGreaterThan(FALLBACK_COST_MS.medium[0])
  })

  it('falls back to the label for an unmeasured scene', () => {
    for (const label of ['low', 'medium', 'high'] as ScenePerformanceCost[]) {
      expect(sceneCostMs('not-benched', 2, label)).toBe(FALLBACK_COST_MS[label][2])
    }
  })

  it('charges an unlabelled unknown scene the most expensive fallback', () => {
    expect(sceneCostMs('who-knows', 0)).toBe(FALLBACK_COST_MS.high[0])
  })

  /**
   * Total, deliberately. A budget that throws is worse than a budget that is
   * wrong — the throw takes the whole show down, and this runs inside the frame
   * loop where there is nothing to catch it.
   */
  it('returns a usable number for every garbage tier', () => {
    for (const tier of [-1, 0.4, 4.6, 99, NaN, Infinity, -Infinity]) {
      const ms = sceneCostMs('synthgrid', tier)
      expect(Number.isFinite(ms), `tier ${tier}`).toBe(true)
      expect(ms, `tier ${tier}`).toBeGreaterThan(0)
    }
  })

  it('clamps a tier past the end of the ladder rather than reading undefined', () => {
    expect(sceneCostMs('synthgrid', 99)).toBe(SCENE_COST_MS.synthgrid[COST_TIERS - 1])
    expect(sceneCostMs('synthgrid', -5)).toBe(SCENE_COST_MS.synthgrid[0])
  })
})

describe('isSceneCostMeasured', () => {
  it('tells the truth about which scenes have been weighed', () => {
    expect(isSceneCostMeasured('synthgrid')).toBe(true)
    expect(isSceneCostMeasured('never-benched')).toBe(false)
  })

  it('leaves no registered scene priced from a fallback', () => {
    // A tripwire, not a threshold. Every registered scene priced from a label
    // is a scene the budget is guessing at, and the whole point of this module
    // is that the labels do not correlate with cost (F88). Adding a scene
    // without benching it should fail here.
    //
    // This spent one commit relaxed to an explicit five-name list while the
    // scenes from the lilim port went unmeasured (F106). They were swept on
    // 2026-08-27, so it is back to demanding zero.
    const missing = SCENES.filter((s) => !isSceneCostMeasured(s.id)).map((s) => s.id)
    expect(missing).toEqual([])
  })

  it('does not price the disabled scenes it was never asked to', () => {
    // `tunnel` and `panic` live in DISABLED_SCENES, so they cannot be composed
    // and were not in the sweep. They must still price if either is promoted —
    // through the fallback, pessimistically.
    for (const id of ['tunnel', 'panic']) {
      expect(isSceneCostMeasured(id), id).toBe(false)
      expect(sceneCostMs(id, 0, 'high')).toBe(FALLBACK_COST_MS.high[0])
    }
  })
})

/**
 * The eleven scenes swept 2026-08-27, as distinguished in sceneCost.ts's own
 * comments from the ten quarantined rows swept 2026-08-26 under a different,
 * documented-contaminated methodology.
 */
const MEASURED_2026_08_27 = [
  'chrome',
  'dissolve',
  'kifs',
  'malachite',
  'matrix',
  'maze',
  'plasma',
  'pointcloud',
  'ribbons',
  'wingfold',
  'wireframe',
].sort()

describe('SCENE_COST_MODEL — the ms/MP fit (F162/F164 audit)', () => {
  it('models exactly the eleven scenes swept 2026-08-27, no more and no fewer', () => {
    // The ten quarantined rows carry a documented CPU-timing contamination —
    // fitting a slope to a number already known to be wrong would manufacture
    // false precision on top of it, so they must not gain a model.
    expect(Object.keys(SCENE_COST_MODEL).sort()).toEqual(MEASURED_2026_08_27)
  })

  it('never has a negative fixed cost or a negative marginal cost', () => {
    // A negative fixedMs or msPerMP would mean "renders faster with more
    // pixels" or "costs less than nothing at 0 MP" — both unphysical, and both
    // would have meant the least-squares fit was left unclamped.
    for (const [id, m] of Object.entries(SCENE_COST_MODEL)) {
      expect(m.fixedMs, id).toBeGreaterThanOrEqual(0)
      expect(m.msPerMP, id).toBeGreaterThanOrEqual(0)
    }
  })

  it('agrees with SCENE_COST_MS at every tier, within the error the fit allows', () => {
    // Not exact equality — a LINE cannot pass through five independent points
    // exactly (which is the reason the old table needed superseding at all:
    // it was not a line, it was five contradictory single-resolution facts).
    // What the fit owes the measured table is staying in its neighbourhood: at
    // every tier's reconstructed resolution, the model's prediction should sit
    // within 20% (or 0.15 ms, whichever is larger — several rows have a genuine
    // measured value under 1 ms, where a percentage alone is too strict) of
    // what /bench actually measured for that scene at that tier.
    const BUDGET_BY_COST = { low: 20.0, medium: 16.0, high: 12.5 } as const
    const TIER_SCALES = [1.0, 0.72, 0.49, 0.34, 0.23]
    const FLOOR = 0.4
    const fullMP = 8.294
    const costLabel: Record<string, 'low' | 'medium' | 'high'> = {
      wireframe: 'low',
      plasma: 'high',
      chrome: 'medium',
      dissolve: 'medium',
      matrix: 'low',
      maze: 'high',
      pointcloud: 'high',
      ribbons: 'medium',
      kifs: 'high',
      malachite: 'low',
      wingfold: 'low',
    }
    const reconstructMP = (budgetMP: number, tierScale: number) => {
      const raw = Math.sqrt((budgetMP * tierScale) / fullMP)
      const scale = Math.round(Math.min(1, Math.max(FLOOR, raw)) * 100) / 100
      return fullMP * scale * scale
    }

    for (const id of MEASURED_2026_08_27) {
      const row = SCENE_COST_MS[id]
      const model = SCENE_COST_MODEL[id]
      const budget = BUDGET_BY_COST[costLabel[id]]
      row.forEach((measuredMs, tier) => {
        const mp = reconstructMP(budget, TIER_SCALES[tier])
        const predicted = model.fixedMs + model.msPerMP * mp
        const tolerance = Math.max(0.15, measuredMs * 0.2)
        expect(
          Math.abs(predicted - measuredMs),
          `${id} tier ${tier}: predicted ${predicted.toFixed(3)} vs measured ${measuredMs}`,
        ).toBeLessThanOrEqual(tolerance)
      })
    }
  })

  it('the two scenes SCENE_COST.ts documents as flat fit with zero slope', () => {
    // "show no cost response to the tier at all" is a claim about ribbons and
    // wingfold (among others) made in prose elsewhere in the file. If the
    // fitted model recovers a non-zero slope for either, the prose and the
    // data disagree and one of them is wrong.
    expect(SCENE_COST_MODEL.ribbons.msPerMP).toBe(0)
    expect(SCENE_COST_MODEL.wingfold.msPerMP).toBe(0)
  })
})

describe('sceneCostMs — internalMP-aware pricing', () => {
  it('is byte-identical to the legacy call when internalMP is omitted', () => {
    // The whole point of making this parameter optional: every call site that
    // has not been updated must keep working exactly as it always has.
    for (const tier of [0, 1, 2, 3, 4]) {
      expect(sceneCostMs('maze', tier)).toBe(SCENE_COST_MS.maze[tier])
    }
  })

  it('prices a fill-bound scene higher at a higher resolution', () => {
    const cheap = sceneCostMs('kifs', 2, undefined, 2.0)
    const expensive = sceneCostMs('kifs', 2, undefined, 8.29)
    expect(expensive).toBeGreaterThan(cheap)
  })

  it('reproduces the exact failure this was built to fix: maze at 8.29 MP', () => {
    // The 08-31 session log: maze priced at a flat 0.42 ms from the tier table
    // while actually running at 8.29 MP and stalling. The MP-aware price must
    // read materially higher than the flat number the old lookup gave — this
    // does not have to match the browser's wall-clock stall (that periodic 5Hz
    // hitch is F164's still-open, separate finding), only to stop UNDER-pricing
    // maze at a resolution /bench's own GPU timer says costs more.
    const flatPrice = SCENE_COST_MS.maze[0] // 0.42 — what every caller saw before this fix
    const atRuntimeMP = sceneCostMs('maze', 0, undefined, 8.29)
    expect(atRuntimeMP).toBeGreaterThan(flatPrice)
  })

  it('a flat-fit scene (msPerMP = 0) prices the same at every resolution', () => {
    const low = sceneCostMs('wingfold', 1, undefined, 1.5)
    const high = sceneCostMs('wingfold', 1, undefined, 8.29)
    expect(low).toBe(high)
    expect(low).toBeCloseTo(SCENE_COST_MODEL.wingfold.fixedMs, 6)
  })

  it('falls through to the legacy table for a scene the MP model does not cover', () => {
    // synthgrid is quarantined — no SCENE_COST_MODEL entry — so passing
    // internalMP must not silently invent a price for it.
    expect(sceneCostMs('synthgrid', 0, undefined, 8.29)).toBe(SCENE_COST_MS.synthgrid[0])
  })

  it('is total for a garbage internalMP: falls back rather than producing NaN', () => {
    for (const mp of [0, -1, NaN, Infinity, -Infinity]) {
      const ms = sceneCostMs('maze', 0, undefined, mp)
      expect(Number.isFinite(ms), `MP ${mp}`).toBe(true)
      expect(ms, `MP ${mp}`).toBeGreaterThan(0)
    }
  })

  it('never returns a negative price at an extreme MP', () => {
    expect(sceneCostMs('maze', 0, undefined, 1e6)).toBeGreaterThan(0)
    expect(sceneCostMs('maze', 0, undefined, 1e-6)).toBeGreaterThanOrEqual(0)
  })
})
