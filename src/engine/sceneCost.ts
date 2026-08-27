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
 * ## What a number here is
 *
 * `gpu.meanMs + js.meanMs`, per tier, monotonised. GPU time comes from real
 * timer queries; `js` is the time the scene's own frame callback holds the main
 * thread. They are added rather than maxed because the frame budget this feeds
 * is a serial millisecond allowance, and the JS term is small enough (0.13 ms at
 * its worst, `malachite` and `maze`) that the choice barely moves a row.
 *
 * **Monotonised** — the running maximum from the bottom of the ladder upward.
 * The raw sweep is not monotone: `wingfold` measured 0.79 / 2.27 / 2.39 / 2.35 /
 * 2.54 ms across tiers 0-4, so dropping a tier could make a scene *dearer*. A
 * budget with that property is unusable, because "shed load to fit" would
 * sometimes add load. Each entry is therefore the worst cost at that tier or any
 * tier below it, which is both monotone and pessimistic.
 *
 * ## The CPU surcharge is gone, and that is a correction
 *
 * The previous table carried a flat per-scene CPU term, on the evidence that
 * `ribbons` "spent 68 ms per frame on the CPU at tier 0" and `chrome` 43.6 ms.
 * That priced `ribbons` at 13.11 ms and `chrome` at 9.25 ms — between them a
 * fifth of a tier-0 budget, for work this sweep finds no trace of.
 *
 * **It does not reproduce.** Across all 55 cells the CPU mean is 16.666 ms —
 * vsync, to three decimals, on every single one — with a p95 never above 17.7.
 * There is no overrun to charge. The `js` column, which is the number those
 * earlier figures were reaching for, tops out at 0.13 ms.
 *
 * The two readings are reconcilable and the old one was wrong: `/bench`'s CPU
 * column is whole-frame wall clock, so on a vsync-locked run it reports the
 * frame interval no matter what the scene costs, and on a run that is stalling
 * for any reason at all it reports the stall. It was never a measurement of the
 * scene. `ribbons` and `chrome` therefore drop to 0.72 and 1.58 ms, and F86 and
 * F87 — both of which existed to explain that phantom cost — close with them.
 *
 * ## What the ladder can and cannot shed
 *
 * Six of the eleven live scenes show no cost response to the tier at all
 * (`chrome`, `malachite`, `matrix`, `maze`, `ribbons`, `wingfold` are flat or
 * inverted), and four read no quality knob whatsoever — `wireframe`, `chrome`,
 * `matrix` and `kifs` never touch `quality.knobs`, so their ONLY tier lever is
 * the resolution solve. Worth knowing before trusting a tier drop to rescue a
 * frame: on more than half the roster it will not, and F111 tracks it.
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
 * A second distortion, and this one bites the profile metrics harder than the
 * costs: **the bench runs with no audio source**. For a scene whose visible
 * output is audio-gated that is not a quiet show, it is a black frame —
 * `ribbons` measures `fill` at 0.009 / 0.015 / 0.001 / 0 / 0 across the ladder,
 * which is not a scene degrading with tier but a scene sitting on the noise
 * floor at all five. Its COST rows are still valid (it draws the same geometry
 * either way, at ~0.7 ms); its profile rows mean nothing. See F112.
 *
 * Provenance: `/bench` full sweep, 2026-08-27, 120 CPU frames + ~135 GPU
 * samples per cell, 11 live scenes x 5 tiers. Measured BEFORE F107 raised the
 * pixel budgets, so fill-bound scenes were sampled at a lower internal
 * resolution than the app now renders them at — these rows are a floor for
 * those, not a ceiling. Re-run and regenerate whenever a scene's shader work
 * changes materially.
 */

/** Tiers, richest to survival. Every row in the table has exactly this many entries. */
export const COST_TIERS = 5

/**
 * Measured cost per scene per tier, in milliseconds.
 *
 * Sorted by name rather than by cost so a regenerated table diffs cleanly.
 */
export const SCENE_COST_MS: Readonly<Record<string, readonly number[]>> = {
  // --- Live roster, swept 2026-08-27 --------------------------------------
  chrome: [1.58, 1.58, 1.58, 1.58, 1.55],
  dissolve: [1.29, 1.15, 1.04, 1.01, 0.88],
  kifs: [2.97, 2.73, 2.69, 2.53, 2.35],
  malachite: [0.76, 0.72, 0.72, 0.72, 0.72],
  matrix: [2.05, 2.05, 2.05, 2.05, 1.97],
  maze: [0.42, 0.42, 0.42, 0.42, 0.37],
  plasma: [1.83, 1.66, 1.36, 1.26, 1.09],
  pointcloud: [2.03, 1.62, 1.46, 1.22, 1.06],
  ribbons: [0.72, 0.72, 0.72, 0.72, 0.72],
  wingfold: [2.54, 2.54, 2.54, 2.54, 2.54],
  wireframe: [0.78, 0.7, 0.69, 0.67, 0.63],

  // --- Quarantined (F105), swept 2026-08-26 --------------------------------
  // Different methodology: these rows carry a per-scene CPU surcharge that the
  // 2026-08-27 sweep found no evidence for (see the note above). Do NOT compare
  // a number here against one above - `network` at 22.42 and `kifs` at 2.97 were
  // not measured the same way. Re-bench any scene promoted back into the roster.
  foldpath: [14.09, 13.03, 12.6, 12.6, 11.53],
  heap: [5.94, 5.94, 5.89, 5.89, 0.3],
  inversion: [0.16, 0.16, 0.16, 0.16, 0.16],
  juliawings: [13.48, 9.69, 9.69, 9.69, 8.77],
  kaleido: [0.38, 0.38, 0.38, 0.38, 0.36],
  network: [22.42, 20.75, 20.75, 15.51, 14.05],
  orbs: [0.06, 0.06, 0.06, 0.06, 0.06],
  synthgrid: [22.35, 16.94, 15.46, 12.91, 9.91],
  torusfold: [0.11, 0.1, 0.1, 0.1, 0.1],
  trail: [0.76, 0.76, 0.7, 0.7, 0.69],
}

/**
 * Price for a scene the sweep never reached.
 *
 * Every scene in `SCENES` is measured today, so nothing in the live roster is
 * priced from here. It is the path for a `DISABLED_SCENES` entry that never got
 * swept (`tunnel`, `panic`) if either is ever promoted, and for any scene added
 * after the sweep.
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
