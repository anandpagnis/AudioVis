import type { ScenePerformanceCost } from '../scenes'

/**
 * What each scene actually costs, in milliseconds of frame time, per quality
 * tier.
 *
 * ## Why this file exists
 *
 * The budget used to spend an invented currency. `slotBudget.ts` priced every
 * scene from a hand-written `performanceCost` label through
 * `{ low: 1, medium: 2, high: 4 }`, and the tier ladder handed out `[11, 9, 7,
 * 6, 5]` of those units. Nothing in that chain had ever been weighed.
 *
 * The `/bench` sweep (16 scenes x 5 tiers, GPU-timer-instrumented, real
 * display, each scene's own `pixelBudget` solve) says the labels were not
 * merely imprecise, they were unrelated to cost:
 *
 *   - `synthgrid` is labelled **medium** and is the single most expensive scene
 *     in the roster — 18.4 ms of GPU on its own, more than a whole 60 Hz frame.
 *     It was charged 2 units of 11.
 *   - `pointcloud` is labelled **high** and costs **0.12 ms**. It was charged 4.
 *     So the roster's cheapest-but-one scene was charged twice what its most
 *     expensive one was.
 *   - Inside the single `medium` label the spread is 0.03 ms to 18.4 ms — a
 *     factor of **650**.
 *
 * A budget cannot mean anything on top of that. So the currency is now
 * milliseconds, and the prices are measurements.
 *
 * ## The two columns, deliberately treated differently
 *
 * **GPU time varies with the tier**, because that is precisely what the tier
 * knobs are for, so it is kept per tier — but *monotonised*. The raw sweep is
 * not monotone: `juliawings` measured 12.5 / 5.5 / 7.4 / 8.7 / 7.8 ms across
 * tiers 0-4, so dropping a tier could make a scene *dearer*. A budget with that
 * property is unusable — "shed load to fit" would sometimes add load. Each
 * entry is therefore the running maximum from the bottom of the ladder upward,
 * which is both monotone and pessimistic.
 *
 * **CPU time is modelled as one constant per scene**, not per tier, and this is
 * the more interesting decision. Two scenes are CPU-bound rather than fill
 * bound — `ribbons` spent **68 ms per frame on the CPU at tier 0** while using
 * 0.03 ms of GPU, and `chrome` spent 43.6 ms at tier 4 against 0.06 ms of GPU.
 * Both were invisible to the old budget, which models fill only. But the
 * evidence also says the ladder does not *control* this cost: `chrome` gets
 * roughly 5x WORSE from tier 0 to tier 4. Pretending a tier drop helps would be
 * fiction, so the CPU term is a flat per-scene surcharge and the anomalies are
 * logged as scene bugs (F86, F87) rather than budgeted around.
 *
 * Only the overrun past vsync is counted, and only when the mean *and* the tail
 * are both elevated. A single 161 ms shader-compile hitch moved `plasma`'s
 * tier-1 mean but not its p95, and charging one stall as a permanent cost would
 * be exactly the kind of invented number this file replaces.
 *
 * ## What this table is NOT
 *
 * It is one GPU. Every number scales with the machine, and a device three times
 * slower carries three times these costs while the table still reads the same.
 *
 * That is survivable because the *tier* is the runtime adaptation: a slower
 * machine sits lower on the ladder and is priced from the lower row. It is not
 * a substitute for measuring, and it is the reason {@link TIER_BUDGET_MS}
 * still tapers down the ladder at all — see the note there.
 *
 * Provenance: `/bench` full sweep, 2026-08-26, 120 CPU frames + ~135 GPU
 * samples per cell. Re-run it and regenerate this table whenever a scene's
 * shader work changes materially.
 */

/** Tiers, richest to survival. Every row in the table has exactly this many entries. */
export const COST_TIERS = 5

/**
 * Measured cost per scene per tier, in milliseconds.
 *
 * Sorted by name rather than by cost so a regenerated table diffs cleanly.
 */
export const SCENE_COST_MS: Readonly<Record<string, readonly number[]>> = {
  chrome: [9.25, 9.25, 9.25, 9.25, 9.25],
  dissolve: [0.11, 0.11, 0.1, 0.09, 0.04],
  foldpath: [14.09, 13.03, 12.6, 12.6, 11.53],
  heap: [5.94, 5.94, 5.89, 5.89, 0.3],
  inversion: [0.16, 0.16, 0.16, 0.16, 0.16],
  juliawings: [13.48, 9.69, 9.69, 9.69, 8.77],
  kaleido: [0.38, 0.38, 0.38, 0.38, 0.36],
  network: [22.42, 20.75, 20.75, 15.51, 14.05],
  orbs: [0.06, 0.06, 0.06, 0.06, 0.06],
  plasma: [1.01, 1.01, 0.19, 0.14, 0.06],
  pointcloud: [0.12, 0.1, 0.08, 0.07, 0.06],
  ribbons: [13.11, 13.11, 13.11, 13.11, 13.1],
  synthgrid: [22.35, 16.94, 15.46, 12.91, 9.91],
  torusfold: [0.11, 0.1, 0.1, 0.1, 0.1],
  trail: [0.76, 0.76, 0.7, 0.7, 0.69],
  wireframe: [0.16, 0.16, 0.15, 0.15, 0.06],
}

/**
 * Price for a scene the sweep never reached.
 *
 * Every scene in `SCENES` is measured today, so nothing in the live roster is
 * priced from here. It is the path for `DISABLED_SCENES` (`tunnel`, `panic`) if
 * either is ever promoted, and for any scene added after the sweep.
 *
 * Deliberately **pessimistic** relative to the measured medians of each label:
 * an unmeasured scene should have to earn its way into a composition, not be
 * admitted on the strength of a label that this very file exists because nobody
 * could trust. The correct fix for any scene priced from here is to bench it.
 * See F88.
 */
export const FALLBACK_COST_MS: Readonly<Record<ScenePerformanceCost, readonly number[]>> = {
  low: [0.5, 0.45, 0.4, 0.35, 0.3],
  medium: [3, 2.6, 2.2, 1.8, 1.5],
  high: [8, 7, 6, 5, 4],
}

/** Charged for a scene with neither a measurement nor a usable label. */
const UNKNOWN_COST_MS = FALLBACK_COST_MS.high

/**
 * Cost of one scene at one tier, in milliseconds.
 *
 * Total: every argument shape returns a usable number. A budget that throws is
 * worse than a budget that is wrong, because the throw takes the show with it.
 */
export function sceneCostMs(sceneId: string, tier: number, declared?: ScenePerformanceCost): number {
  const row =
    SCENE_COST_MS[sceneId] ?? (declared ? FALLBACK_COST_MS[declared] : undefined) ?? UNKNOWN_COST_MS
  const t = Number.isFinite(tier) ? Math.max(0, Math.min(COST_TIERS - 1, Math.round(tier))) : 0
  return row[t] ?? row[row.length - 1]
}

/** Has this scene actually been weighed, or is it running on a fallback? */
export function isSceneCostMeasured(sceneId: string): boolean {
  return sceneId in SCENE_COST_MS
}
