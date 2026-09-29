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
 *   - `synthgrid` (since deleted, F274) was labelled **medium** and was the
 *     single most expensive scene in the roster — 18.4 ms of GPU on its own,
 *     more than a whole 60 Hz frame. It was charged 2 units of 11.
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
 * Several scenes below show no cost response to the tier at all (flat rows),
 * and a few read no quality knob whatsoever — their ONLY tier lever is the
 * resolution solve. Worth knowing before trusting a tier drop to rescue a
 * frame: on a real fraction of the roster it will not.
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
 * ## Provenance (F236, 2026-09-13/14 — the current live roster)
 *
 * Full re-sweep, `/bench` (no-chain) + `/bench?postchain`, on real user
 * hardware (RTX 4060-class GPU, Ryzen 7) — 30 scenes x 5 tiers, 120 CPU
 * frames + real GPU timer-query samples per cell. This is the sweep that
 * matters most in this file's history: it is the first real measurement for
 * every scene that shipped after 2026-08-27 without one, which by this point
 * was most of the live roster. The gap between the OLD op-count ESTIMATES
 * those rows carried and what this sweep actually measured ranged from
 * "close" to catastrophic:
 *
 *   - `beats`: estimated 15.2 ms at tier 0 (a "worst-case, no-early-out
 *     raymarch" op-count against `kifs`). Measured: **0.05 ms**. 304x over —
 *     and 15.2 ms alone exceeds `TIER_BUDGET_MS[0]` (11), so any composition
 *     including this scene refused every layer/effect/filter outright on a
 *     number with no relationship to what the GPU actually did.
 *   - `travelling` (253x), `web` (34x), `gyroid` (14x), `javazone` (10x),
 *     `fridaylines` (6x), `lattesfold` (~6x): the same failure mode, same
 *     family — every one of these was priced from a THEORETICAL worst-case
 *     per-pixel iteration count for a march with no explicit early-out.
 *     Real-world GPU behaviour and/or the resolution these scenes actually
 *     resolve to at their declared `pixelBudget` made the true cost a small
 *     fraction of that worst case.
 *   - The error runs the OTHER way for a handful of trivially cheap,
 *     closed-form effect shaders: `hold`, `strobe`, `shock`, `flare`, `spark`
 *     were priced near `orbs`' measured floor (0.06-0.10 ms) by op-count
 *     ("fewer operations than our cheapest measured scene"), and measured
 *     3-6x higher (0.31-0.35 ms monotonised) — a fixed per-draw-call
 *     overhead a pure instruction count has no way to see. `snowflake` is
 *     the largest single miss in this direction: estimated 0.45 ms,
 *     measured **3.70 ms**, ~8x under.
 *
 * The practical lesson, not just this file's own: op-counting is not a
 * conservative substitute for measurement, it is an UNCORRELATED one. It
 * fails in both directions, and the direction it fails in cannot be guessed
 * from the shader source alone — only a real timer query settles it. See
 * docs/ISSUES.md F236 for the full session, the raw per-cell data, and the
 * `slotBudget.test.ts` / `SCENE_COST_MODEL` follow-up this correction forced.
 *
 * **`SCENE_COST_MODEL` below is now STALE relative to this sweep** for the
 * eleven scenes it covers (chrome/dissolve/kifs/malachite/matrix/maze/
 * plasma/pointcloud/ribbons/wingfold/wireframe) — it was fitted from the
 * 2026-08-27 numbers this correction just replaced. Not re-fitted here: a
 * proper refit needs real per-cell `internalMP` (this sweep's report did not
 * capture it for the no-chain pass), and hand-deriving a new least-squares
 * fit without that would manufacture exactly the false precision this file's
 * own header already warns against. `sceneCostMs()` still prefers the model
 * over this table whenever a live `internalMP` is passed, so until it is
 * regenerated, those eleven scenes may be priced from the OLD fit at a
 * resolution the composition budget actually resolves to, even though the
 * flat per-tier table above is now correct. Regenerate `SCENE_COST_MODEL`
 * from a `/bench` run that records `internalMP` per cell before trusting
 * resolution-aware pricing for those eleven again.
 */

/** Tiers, richest to survival. Every row in the table has exactly this many entries. */
export const COST_TIERS = 5

/**
 * Measured cost per scene per tier, in milliseconds.
 *
 * Sorted by name rather than by cost so a regenerated table diffs cleanly.
 */
export const SCENE_COST_MS: Readonly<Record<string, readonly number[]>> = {
  // --- Live roster, swept 2026-09-13/14 (F236) — see the header for the full
  //     provenance and what replacing the old op-count estimates found -------
  beats: [0.21, 0.21, 0.21, 0.21, 0.21],
  butterfly: [0.61, 0.61, 0.61, 0.61, 0.61],
  chrome: [3.73, 3.73, 3.73, 3.73, 3.73],
  dissolve: [2.55, 2.36, 2.26, 2.1, 1.74],
  djcam: [0.35, 0.35, 0.35, 0.35, 0.32],
  dustfield: [0.36, 0.36, 0.36, 0.36, 0.33],
  flare: [0.38, 0.38, 0.38, 0.33, 0.33],
  fridaylines: [0.98, 0.98, 0.98, 0.98, 0.98],
  hold: [0.35, 0.35, 0.35, 0.33, 0.33],
  // `inkfluid` — NOT part of the F236 /bench sweep. Measured standalone
  // (2026-09-25) through the scene's own solver and render code on a real
  // three.js renderer at 1920x1080: one frame = the five solver passes (a
  // 364x205 lattice, a 1280x720 ink grid) plus the render pass at 1080p,
  // timed as the difference between 80 and 40 back-to-back frames, each run
  // synced by a 1x1 readPixels from the render target. 1.5-2.4 ms across the
  // three modes over five rounds; priced at the worst. The solver grids are
  // fixed-size, so only the render pass scales with the canvas (and only it
  // sheds cost down the tiers). Held flat across tiers: not measured there.
  // ACTION: /bench it in-app and replace this row.
  inkfluid: [2.5, 2.5, 2.5, 2.5, 2.5],
  javazone: [1.43, 1.43, 1.43, 1.43, 1.43],
  kifs: [4.8, 4.8, 4.8, 4.8, 4.8],
  lattesfold: [1.1, 1.1, 1.1, 1.1, 1.04],
  limitless: [0.27, 0.27, 0.27, 0.27, 0.24],
  malachite: [0.38, 0.34, 0.34, 0.34, 0.34],
  matrix: [0.87, 0.87, 0.87, 0.86, 0.86],
  maze: [0.15, 0.15, 0.14, 0.14, 0.14],
  // `mothwings` — NOT part of the F236 /bench sweep. Measured standalone
  // (2026-09-23), same method as `tribalentity`: the scene FRAG compiled behind
  // the real prelude + palette include with three's WebGL2 prefixes, drawn
  // fullscreen at 1920x1080 native, 30 warm-up draws, each timed draw synced by
  // a 1x1 readPixels (gl.finish is a no-op under ANGLE/Metal), sync baseline
  // subtracted: 8.3-9.6 ms net across three rounds at both morph poses and at
  // 0.7x zoom. Priced at the worst reading. The machine was loaded during that
  // run — `tribalentity` read 7.4-8.0 ms in the same rounds against its 7.2
  // row — so this likely sits a little high. 44 atan+log iterations with no
  // early-out that fires on a landscape canvas; no `pixelBudget`, so it scales
  // with canvas pixels (~4.6 ms/MP). Held flat across tiers: the lower tiers
  // were not measured.
  // ACTION: /bench it in-app and replace this row.
  mothwings: [9.6, 9.6, 9.6, 9.6, 9.6],
  nebula: [0.58, 0.56, 0.54, 0.52, 0.39],
  plasma: [4.57, 4.49, 3.67, 3.15, 2.66],
  pointcloud: [4.42, 3.68, 3.12, 2.77, 2.4],
  ribbons: [1.94, 1.69, 1.69, 1.53, 1.53],
  shock: [0.33, 0.33, 0.33, 0.31, 0.31],
  snowflake: [3.7, 3.7, 3.63, 3.63, 3.63],
  spark: [0.33, 0.32, 0.32, 0.32, 0.32],
  strobe: [0.32, 0.32, 0.32, 0.32, 0.32],
  travelling: [0.26, 0.26, 0.26, 0.22, 0.22],
  // `tribalentity` — NOT part of the F236 /bench sweep. Measured standalone
  // (2026-09-22) after the 84 -> 24 orbit-iteration cut: the scene FRAG
  // compiled behind the real prelude + palette include, drawn fullscreen at
  // 1920x1080 native, each draw synced by a 1x1 readPixels (gl.finish is a
  // no-op under ANGLE/Metal): 6.4-7.2 ms net across three runs and three zoom
  // levels (the 84-iteration build: 17.1 ms on the same rig and run). Priced at
  // the worst reading. The 2026-09-23 reactive/eyes rework measured +0.0-0.3 ms
  // against it, interleaved A/B on the same rig (the eye shading is gated to
  // the ~10% of the frame near the eyes). It declares no `pixelBudget`, so this
  // scales with canvas pixels (~3.4 ms/MP) — a 4K canvas costs ~4x. Held flat across tiers
  // on purpose — the lower tiers were not measured, and an unmeasured tier
  // should be priced pessimistically, not guessed down.
  // ACTION: /bench it in-app and replace this row.
  tribalentity: [7.2, 7.2, 7.2, 7.2, 7.2],
  truchet: [1.4, 1.4, 1.4, 1.4, 1.4],
  web: [0.25, 0.24, 0.22, 0.22, 0.22],
  wingfold: [4.23, 4.23, 3.9, 3.76, 3.76],
  wireframe: [1.73, 1.73, 1.73, 1.47, 1.47],
}

/**
 * Price for a scene the sweep never reached.
 *
 * Every scene in `SCENES` has a row today, so nothing in the live roster is
 * priced from here. It is the path for any scene added after the sweep, or
 * promoted out of `DISABLED_SCENES`, before it has been benched.
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


/**
 * A scene's cost as (fixed cost) + (marginal cost per internal megapixel),
 * fitted from {@link SCENE_COST_MS} against the internal resolution EACH row
 * was actually measured at (F162/F164 audit — "sceneCost.ts could not price
 * this: it has no megapixel denominator, so it reads `maze` as the cheapest
 * scene in the roster while the log has maze unable to hold 8.29 MP").
 *
 * **STALE as of F236 (2026-09-13/14) — see `SCENE_COST_MS`'s own header.**
 * Every coefficient below was fitted from the 2026-08-27 sweep, which F236
 * replaced for all eleven of these scenes with real numbers that in several
 * cases differ substantially (`chrome`, `kifs`, `plasma`, `pointcloud`,
 * `wireframe` were all underpriced by roughly 2x in that sweep). This model
 * was NOT refitted as part of F236 because a correct refit needs real
 * per-cell `internalMP`, which that sweep's report did not capture for the
 * no-chain pass — hand-deriving a new slope/intercept without it would
 * manufacture false precision, the exact failure mode F236 itself was about.
 * `sceneCostMs()` still prefers this model over the flat table above whenever
 * a live `internalMP` is passed (see that function), so until this is
 * regenerated, these eleven scenes may still be priced from the OLD,
 * now-known-wrong numbers whenever a caller has a live resolution to pass —
 * only the flat-tier lookup path benefits from F236 for these specific
 * scenes today. Regenerate from a `/bench` run that records `internalMP` per
 * cell before trusting resolution-aware pricing here again.
 *
 * ## Why a fit instead of a fifth column
 *
 * `SCENE_COST_MS` has one number per (scene, tier) — a single (ms, MP) point,
 * since each tier's `pixelBudgetScale` resolves to a definite internal
 * resolution for a given scene. Five tiers is five points, which is enough to
 * fit a line (`ms = fixedMs + msPerMP * internalMP`) rather than just label
 * one point with the resolution it came from. A fit is also what makes the
 * price VALID at a resolution the sweep never visited — interpolation and
 * modest extrapolation both fall out of the same two numbers, where five
 * disconnected (tier, ms) pairs would not extend past tier 4.
 *
 * ## Provenance of the resolution column
 *
 * `/bench`'s `BenchResult.internalMP` (shipped for the post-chain measurement,
 * F160) is the RIGHT way to get this and nobody has re-run the sweep with it
 * capturing scene cost yet. Absent that, this fit uses internal resolutions
 * RECONSTRUCTED from the same formula the engine itself runs during a sweep
 * (`BenchStage.tsx`: `renderScale.setSceneBudget(getScenePixelBudget(id))`,
 * `renderScale.solve()`, `renderScale.internalMP(scale)`) — i.e.
 * `resolvePixelBudget({ performanceCost })` (no live scene declares an
 * explicit `pixelBudget` or `fillBound`, so every one of the eleven measured
 * scenes resolves through `BUDGET_BY_COST` alone) combined with each tier's
 * `pixelBudgetScale` and `solveRenderScale`'s own clamp/floor, against
 * `fullMP = 8.294` — the display the 2026-08-27 sweep almost certainly ran on
 * (2560x1440 css @ 1.5 baseDpr, the exact machine and buffer size recorded in
 * every session log in `corpus/`, including the one this fix responds to).
 *
 * That reconstruction is honest about being a reconstruction, not a
 * measurement of a measurement: `internalMP = budgetMP * tierScale`
 * independent of `fullMP` UNLESS a rung's solve clamped to native (`scale ===
 * 1`) or to `RENDER_SCALE_FLOOR`, in which case the true MP does depend on
 * `fullMP` and a wrong guess there would misattribute which points in the fit
 * sit at native resolution. The fit is least-squares over the five
 * reconstructed points, with the slope floored at 0 (a scene's GPU cost
 * cannot fall as its resolution rises — a negative slope from noise is
 * clamped and refit as a flat mean instead) and the intercept floored at 0.
 * `ribbons` and `wingfold` fit EXACTLY flat (slope 0), agreeing with this
 * file's own earlier finding that they "show no cost response to the tier at
 * all" — the model recovers a fact the file already asserted in prose, from
 * data, which is the check that it is not nonsense.
 *
 * ## What supersedes this
 *
 * A real `/bench` run with per-cell `internalMP` recorded directly replaces
 * every number below with a measurement instead of a reconstruction — same
 * shape as F160's `postChainDelta()`, not yet run. Until then this is
 * FITTED-FROM-RECONSTRUCTED, not measured, and `SCENE_COST_MS` above remains
 * the actual measured artefact; this table is derived from it, not a
 * replacement for it.
 *
 * Only the eleven scenes swept 2026-08-27 have a model.
 */
export interface SceneCostModel {
  /** Ms this scene costs regardless of internal resolution. */
  fixedMs: number
  /** Additional ms per internal megapixel rendered. */
  msPerMP: number
}

/** Provenance and derivation: see the doc comment on {@link SceneCostModel}. */
export const SCENE_COST_MODEL: Readonly<Record<string, SceneCostModel>> = {
  chrome: { fixedMs: 1.538, msPerMP: 0.00535 },
  dissolve: { fixedMs: 0.639, msPerMP: 0.06486 },
  kifs: { fixedMs: 2.121, msPerMP: 0.08914 },
  malachite: { fixedMs: 0.7, msPerMP: 0.00385 },
  matrix: { fixedMs: 1.887, msPerMP: 0.02022 },
  maze: { fixedMs: 0.37, msPerMP: 0.00669 },
  plasma: { fixedMs: 0.72, msPerMP: 0.12041 },
  pointcloud: { fixedMs: 0.617, msPerMP: 0.14399 },
  ribbons: { fixedMs: 0.72, msPerMP: 0 },
  wingfold: { fixedMs: 2.54, msPerMP: 0 },
  wireframe: { fixedMs: 0.509, msPerMP: 0.02552 },
}

/** Charged for a scene with neither a measurement nor a usable label. */
const UNKNOWN_COST_MS = FALLBACK_COST_MS.high

/**
 * Cost of one scene at one tier, in milliseconds.
 *
 * Total: every argument shape returns a usable number. A budget that throws is
 * worse than a budget that is wrong, because the throw takes the show with it.
 */
export function sceneCostMs(
  sceneId: string,
  tier: number,
  declared?: ScenePerformanceCost,
  /**
   * The internal resolution this scene will ACTUALLY render at this frame —
   * `renderScale.internalMP(renderScale.applied)` at every real call site.
   *
   * Optional and additive: omitted, this returns EXACTLY what it always has
   * (the flat per-tier table, or the fallback), so a caller that has not been
   * updated to thread the live resolution through keeps its old behaviour
   * byte-for-byte. Passed, and a fitted {@link SCENE_COST_MODEL} exists for
   * this scene, the price is evaluated AT that resolution instead of at
   * whatever resolution the tier implies in isolation — which is the actual
   * defect this parameter exists to fix: a scene in a composition renders at
   * the COMBINED budget's resolution, not the one it was benched alone at, and
   * `maze` in `audiovis-session-2026-08-31-16-47-12` is the concrete case —
   * priced at 0.42 ms from a tier lookup, actually running at 8.29 MP.
   */
  internalMP?: number,
): number {
  if (internalMP !== undefined && isFinite(internalMP) && internalMP > 0) {
    const model = SCENE_COST_MODEL[sceneId]
    if (model) return Math.max(0, model.fixedMs + model.msPerMP * internalMP)
  }
  const row =
    SCENE_COST_MS[sceneId] ?? (declared ? FALLBACK_COST_MS[declared] : undefined) ?? UNKNOWN_COST_MS
  const t = Number.isFinite(tier) ? Math.max(0, Math.min(COST_TIERS - 1, Math.round(tier))) : 0
  return row[t] ?? row[row.length - 1]
}

/** Has this scene actually been weighed, or is it running on a fallback? */
export function isSceneCostMeasured(sceneId: string): boolean {
  return sceneId in SCENE_COST_MS
}
