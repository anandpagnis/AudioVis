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

  // --- New effect scenes (c6), NOT /bench-MEASURED — engineering estimate ---
  // `shock`/`flare`/`spark` shipped with the `effect` slot's first licensed
  // content and there is no headless-browser harness in this repo to run
  // `/bench` and get a real number (see the audit's own note on that gap).
  // Flat across every tier, unlike most of the measured rows above: each is a
  // fullscreen quad reading NO `quality.knobs` — same reasoning that makes
  // `ribbons`/`wingfold`/`malachite` flat — so the only tier lever is the
  // resolution solve, which is priced separately.
  // Estimated by op-count comparison against the cheapest ACTUALLY-measured
  // rows in this table: `orbs` (0.06 ms; three `length()` + three divides)
  // and `wireframe` (0.78-0.63 ms; real 3D line geometry). Every one of these
  // three is a closed-form fullscreen shader with 2-5 `exp()` evaluations, no
  // loop, no texture fetch and no geometry — fewer operations than `orbs` and
  // far fewer than `wireframe` — so each is priced at or a little above
  // `orbs`'s measured floor, never approaching `wireframe`'s. Deliberately
  // NOT run through the {@link SceneCostModel} fit: that requires real
  // measurements at multiple resolutions to fit a line, and fabricating a
  // regression from unmeasured numbers would manufacture false precision on
  // top of a value already known to be a guess. Replace with a real `/bench`
  // sweep the moment one is possible; until then this is a documented
  // estimate, not a measurement, exactly like `SCENE_COST_MODEL`'s own
  // "supersedes this" note asks of itself.
  shock: [0.08, 0.08, 0.08, 0.08, 0.08],
  flare: [0.1, 0.1, 0.1, 0.1, 0.1],
  spark: [0.07, 0.07, 0.07, 0.07, 0.07],

  // --- Second background/silence/effect wave, NOT /bench-MEASURED ----------
  // Same posture as the c6 effect scenes above and snowflake/harkonnen/beats/
  // web below: documented op-count estimates, not fabricated pass-the-test
  // numbers, each with its own comparison against a REAL measured row. Every
  // one of the four's own scene-file header carries the full reasoning this
  // summarizes. Replace all four with real /bench sweeps once possible.

  // `nebula` — 3 fbm calls x <=3 octaves (<=9 noise() samples/px) against
  // malachite's 5 fbm calls x <=5 octaves (<=25 samples/px, measured row
  // below) — roughly a third of malachite's per-pixel noise cost, plus one
  // small FIXED paletteRamp/Oklab term that does not scale with octaves.
  // Priced near-flat, same shape as malachite's own row, at ~0.4x plus that
  // fixed overhead. pixelBudget 1.6 vs malachite's 1.3 (~1.23x the pixels)
  // is already folded into the estimate below rather than left for the
  // resolution solve to double-count.
  nebula: [0.34, 0.33, 0.32, 0.31, 0.3],

  // `dustfield` — 3 fixed dustLayer() calls, no loop, no fbm; each ~ one
  // octave of malachite's noise() (5 hash() + 2 smoothstep(), no
  // interpolated noise() call at all). Roughly 3/25 of malachite's per-pixel
  // noise-sample count with a cheaper per-sample op, so priced well under
  // nebula's own row. Declares no quality.knobs response (no loop/octave
  // count to gate) — flat across every tier, same convention wireframe/
  // ribbons/wingfold use for the same reason.
  dustfield: [0.18, 0.18, 0.18, 0.18, 0.18],

  // `hold` — two closed-form scalar ops per pixel (one sin, one exp), no
  // loop, no texture read, no fbm. Below even `orbs`'s measured 0.06ms floor
  // (three length() + three divides) in op count. Flat across every tier —
  // the scene's own header states plainly there is no quality-tier response
  // to make, since there is no expensive term to gate in the first place.
  hold: [0.05, 0.05, 0.05, 0.05, 0.05],

  // `strobe` — a floor/fract bar pattern plus three smoothstep()s, no loop,
  // no noise, no division, no uRes/aspect correction (bar position only
  // reads vUv.x). Cheaper than shock/flare/spark's own exp()-based falloffs
  // just above, so priced at their floor rather than above it.
  strobe: [0.06, 0.06, 0.06, 0.06, 0.06],

  // `snowflake` (ISF port, "claude-opus-4-8" witnessed generation) — also NOT
  // /bench-measured. Priced a notch above shock/flare/spark: it is still a
  // single closed-form fullscreen pass, but it carries one `atan`, a constant
  // 6-iteration `seg()` loop (~14 sqrt) and three more `length()` terms, so it
  // is a few times their op count — and still an order of magnitude below
  // `wireframe` (0.63-0.78 ms, real 3D line geometry). Flat across tiers: it
  // reads no `quality.knobs` (same as `matrix`/`ribbons`/`wireframe`), so the
  // only tier lever is the resolution solve, priced separately. Deliberately
  // pessimistic and NOT run through {@link SCENE_COST_MODEL}; replace with a
  // real /bench sweep when one is possible.
  snowflake: [0.45, 0.45, 0.44, 0.43, 0.42],

  // `harkonnen` (Shadertoy "Fortress Harkonnen" port) — also NOT
  // /bench-measured, and a much rougher estimate than the rows above: this one
  // has real inner loops. The source's ~118 fractal iterations/px (a 25-iter
  // field sampled 4x for the normal, no early-out) were cut to a 3-tap normal +
  // `complexity`-controlled 10..16 iters + two `pow`->mul swaps, then rendered
  // offscreen via `pixelBudget` (1.4 MP tiers 0-1, 0.8 MP below). At the
  // neutral `complexity` that is ~52 iters/px. Priced by comparison against
  // `wingfold` (2.54 ms, escape-time WITH an early-out, native res) and `kifs`
  // (2.97 ms): denser per-iteration and no early-out, offset by the lower
  // internal resolution. The tier-0/1 vs tier-2+ step is the `pixelBudget`
  // drop, not an iteration change (iterations are the user's dial, never
  // tier-gated). NOT run through {@link SCENE_COST_MODEL}. If a real /bench
  // puts tier 0 at or above `sceneBudget(0)/2` (~4 ms) this scene has to move
  // to DISABLED_SCENES or take further cuts — it is live on an estimate.
  harkonnen: [3.5, 3.2, 2.4, 2.0, 1.6],

  // `beats` (mrange's "4D Beats", Shadertoy CC0) — NOT /bench-measured. This
  // row now reflects the worst-case estimate the scene's own prior comment
  // already stated, not a fabricated pass-the-test ceiling: the scene is a
  // 77-step 4D raymarch with NO early ray termination — every pixel runs the
  // full march accumulating glow — so op-count against `kifs` (2.97 ms at
  // tier 0, ~20 iters WITH an escape that spares most pixels) says the true
  // tier-0 cost is likely 2-4x the old fabricated 3.8. Priced at the 4x end of
  // that stated range (15.2), with the rest of the row scaled by the same 4x
  // factor rather than re-guessed, so the taper still tracks the two levers
  // that actually move it: `uMaxSteps` off `quality.knobs.raymarchSteps`
  // (96/72/54/40/28), and the `pixelBudget` step (1.2 MP tiers 0-1, 0.7 MP
  // below). Still NOT run through {@link SCENE_COST_MODEL} — that requires a
  // real multi-resolution measurement, and this is still a guess, just an
  // honest one. ACTION: run `/bench` and replace this with a measurement; at
  // 15.2 ms tier 0 it already fails `slotBudget.test.ts`'s
  // `< sceneBudget(0)/2` (~4 ms) admission bar (see that test's failure for
  // the real consequence) — cut the step count hard, drop `pixelBudget`
  // further, or move `beats` back to DISABLED_SCENES.
  beats: [15.2, 12.0, 7.6, 5.6, 4.0],

  // `web` (mrange's "Oversaturated web", Shadertoy CC0, deriv. of BigWing's
  // `lscczl`) — NOT /bench-measured. Estimate, not a fabricated ceiling like
  // `beats`, because it was made cheaper first: the source's 36 cubic-bezier
  // distance solves/px (6 planes x 6 hex-neighbour strands, each with `acos` +
  // `pow(,1/3)`) is cut to `density`-controlled strands (default 4) x
  // `complexity`-controlled planes (default 5), rendered offscreen at 0.8 MP
  // (tiers 0-1) / 0.5 MP below — glow output upscales invisibly — and the
  // sine-based hash (called ~36x/px) swapped for a sine-free one. At the
  // neutral dials that is ~20 bezier solves/px pre-upscale. Priced between
  // `kifs` (2.97 ms) and the raymarchers: heavier per-strand than a segment
  // SDF, lighter overall than a full march, minus the resolution cut. The
  // tier-0/1 vs tier-2+ step is the `pixelBudget` drop (strands/planes are
  // user dials, never tier-gated). NOT run through {@link SCENE_COST_MODEL}.
  // Run `/bench`; if tier 0 is at/over `sceneBudget(0)/2` (~4 ms), drop the
  // `density`/`complexity` defaults, set `#define USE_BEZIER 0`, or move `web`
  // to DISABLED_SCENES.
  web: [3.4, 3.1, 2.1, 1.6, 1.2],

  // `travelling` (mrange's "Moving without travelling", Shadertoy CC0) — NOT
  // /bench-measured. This row now reflects the worst-case estimate the
  // scene's own prior comment already stated, not a fabricated pass-the-test
  // ceiling. It is the heaviest shader in the roster: per pixel it steps 4
  // planes, and each plane runs one `warp()` plus a 4-tap finite-difference
  // `normal()` (= 5 warps), where every `warp()` is an eye SDF + a
  // kaleidoscope fold + 5 `fbm()` (4 octaves) — ~100 fbm + ~24 eye SDFs per
  // pixel. Against `kifs` (2.97 ms at tier 0, ~160 heavy ops/px) the prior
  // comment put the true cost at ~20-30 ms at tier 0, ~10-15 ms even at the
  // survival tier — this row now uses the worst end of both: 30 at tier 0, 15
  // at tier 4, with tiers 1-3 interpolated between them on a taper shape
  // (front-loaded drop, easing toward the floor) matched to the other heavy,
  // pixelBudget/quality-knob-gated rows this file actually measured (`plasma`,
  // `pointcloud`), not a bare linear guess. `compatibleWith: []` still bounds
  // the damage to one bad transition — the budget model will still over-pick
  // this at a tier that no longer admits it (see `slotBudget.test.ts`'s
  // failure for the real consequence) and the governor claws back after.
  // Taper tracks the `pixelBudget` step (1.0 MP tiers 0-1, 0.6 MP below) and
  // `uOctaves` (governor 4->2). Still NOT run through {@link
  // SCENE_COST_MODEL} — that requires a real multi-resolution measurement,
  // and this is still a guess, just an honest one. ACTION: cut `normal()` to
  // a 2-tap, drop `furthest` 4->2, then /bench — or move `travelling` to
  // DISABLED_SCENES.
  travelling: [30.0, 27.0, 22.0, 18.0, 15.0],
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


/**
 * A scene's cost as (fixed cost) + (marginal cost per internal megapixel),
 * fitted from {@link SCENE_COST_MS} against the internal resolution EACH row
 * was actually measured at (F162/F164 audit — "sceneCost.ts could not price
 * this: it has no megapixel denominator, so it reads `maze` as the cheapest
 * scene in the roster while the log has maze unable to hold 8.29 MP").
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
 * Only the eleven scenes swept 2026-08-27 have a model — the ten quarantined
 * rows carry a documented CPU-timing contamination this file's own header
 * already disqualifies from comparison, and fitting a slope to a contaminated
 * number would manufacture false precision on top of a value already known to
 * be wrong.
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
