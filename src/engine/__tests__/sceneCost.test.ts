import { describe, expect, it } from 'vitest'
import {
  COST_TIERS,
  FALLBACK_COST_MS,
  isSceneCostMeasured,
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
