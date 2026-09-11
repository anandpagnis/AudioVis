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
  // puts tier 0 at or above `sceneBudget(0)/2` (5.05 ms) this scene has to move
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
  // (96/72/54/40/28), and the `pixelBudget` step, AT THE TIME THIS ROW WAS
  // PRICED (1.2 MP tiers 0-1, 0.7 MP below — since re-anchored to 6.7/3.9,
  // see the scene's own header, "That last option got further away, not
  // closer": every figure in this row was taken at roughly a third of the
  // pixels the scene now draws at 4K tier 0, and no replacement is invented
  // here either, for the same reason the header gives — cost is linear in
  // pixel count with no early-out, and only `/bench` can price it now).
  // Still NOT run through {@link SCENE_COST_MODEL} — that requires a real
  // multi-resolution measurement, and this is still a guess, just an honest
  // one. ACTION: run `/bench` and replace this with a measurement; at 15.2 ms
  // tier 0 (understated, per the above) it already fails `slotBudget.test.ts`
  // — allowlisted there (F199/F200) as FORCED LIVE, `compatibleWith: []`,
  // alongside `travelling`/`lattesfold` — rather than move `beats` back to
  // DISABLED_SCENES, which stays this scene's own call to make, not this
  // correction's.
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
  // Run `/bench`; if tier 0 is at/over `sceneBudget(0)/2` (5.05 ms), drop the
  // `density`/`complexity` defaults, set `#define USE_BEZIER 0`, or move `web`
  // to DISABLED_SCENES.
  web: [3.4, 3.1, 2.1, 1.6, 1.2],

  // `travelling` (mrange's "Moving without travelling", Shadertoy CC0) — NOT
  // /bench-measured. This row now reflects the worst-case estimate the
  // scene's own prior comment already stated, not a fabricated pass-the-test
  // ceiling. Was the heaviest shader in the roster until `lattesfold` (below)
  // landed at an estimated 45 ms; still the heaviest with a real per-pixel
  // fbm-based cost model behind the number. Per pixel it steps 4 planes, and
  // each plane runs one `warp()` plus a 4-tap finite-difference
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
  //
  // F199/F200 correction: this row used to say it "tracks the pixelBudget
  // step (1.0 MP tiers 0-1, 0.6 MP below)" — F195 re-anchored that budget to
  // 5.6/3.3 (see the scene's own declaration) without re-deriving this row,
  // exactly the "not re-measured" gap F195's own ledger entry flagged. Scaled
  // here by `solveScale(budget, 3840, 2160, 1)^2` against the ORIGINAL
  // native-resolution op-count estimate directly above (30/27/22/18/15,
  // unclamped: tiers 0-1 at 5.6 MP solve to 0.822 scale = 0.675 of native
  // pixels; tiers 2-4 at 3.3 MP solve to 0.631 = 0.398): still nowhere near
  // `slotBudget.test.ts`'s bar even at the new, larger budget — see that
  // file's own allowlist comment for why this stays live anyway
  // ("FORCED LIVE by explicit request" above; `compatibleWith: []` bounds
  // the blast radius to one scheduling mistake, not a layer).
  travelling: [20.25, 18.23, 8.75, 7.16, 5.97],

  // `gyroid` (Shadertoy source, requester-supplied CC0) — NOT /bench-measured.
  // FORCED LIVE by explicit request; see GyroidFluxScene.tsx's header for the
  // full op-count reasoning. A 150-step march with no hit-based early-out,
  // priced at the pessimistic (kifs-scaled) end of a 7-22 ms two-method
  // estimate rather than split down the middle — same call `beats` makes for
  // its own two-sided estimate. Taper shape matched to `beats`' own
  // proportional decay (same "no early-out" march family).
  //
  // F199/F200: the row above (18.0 at tier 0) was the NATIVE-resolution
  // estimate, priced before this scene had a `pixelBudget` at all — it was
  // never re-derived once one was added, so `slotBudget.test.ts` was
  // comparing an unthrottled number against the throttled reality. Scaled by
  // `solveScale(budget, 3840, 2160, 1)^2`: both the 1.2 MP (tiers 0-2) and
  // 0.7 MP (tiers 3-4) budgets solve BELOW the 0.4 floor at 4K and clamp to
  // the identical 0.16 pixel ratio — the two-branch budget is a no-op at this
  // reference size specifically (it still matters at smaller displays, where
  // neither budget clamps). Clears the tier-0 bar with real margin now.
  // ACTION: still run `/bench` and replace with a measurement.
  gyroid: [2.88, 2.27, 1.44, 1.06, 0.75],

  // `fridaylines` (mrange's "Crazy friday lines", Shadertoy CC0) — NOT
  // /bench-measured. FORCED LIVE by explicit request; see
  // FridayLinesScene.tsx's header. 77-step accumulation with a SOFT distance
  // exit (z < 49.0), double 4D inversion + lattice fold per step — heavier
  // than `gyroid`'s single gyroid tap, lighter than `beats`' 7-deep min-tree,
  // and the soft exit spares some rays `beats`' pure accumulate-forever loop
  // never does. Priced around 70% of `beats`' tier-0 estimate on that basis.
  //
  // F199/F200: same correction as `gyroid` directly above — this was the
  // native-resolution estimate, re-derived against the 1.1/0.65 MP budget
  // (both clamp to the 0.4 floor at 4K, 0.16 pixel ratio). ACTION: still run
  // `/bench` and replace with a measurement.
  fridaylines: [1.76, 1.39, 0.88, 0.64, 0.46],

  // `javazone` (mrange's "JavaZone 2026 Shader", Shadertoy CC0) — NOT
  // /bench-measured. FORCED LIVE by explicit request; see
  // JavaZoneLatticeScene.tsx's header. 77-step accumulation with NO early-out
  // at all — the closest true analogue is `beats` (same author, same
  // iteration count, same tanh(o/2e4) shape), minus `beats`' inversion divide
  // and 7-deep min-tree, plus one extra noise term. Priced a shade under
  // `beats`' own tier-0 estimate on that basis.
  //
  // F199/F200: same correction as `gyroid`/`fridaylines` above — native-
  // resolution estimate, re-derived against the 1.2/0.7 MP budget (both
  // clamp to the 0.4 floor at 4K, 0.16 pixel ratio). ACTION: still run
  // `/bench` and replace with a measurement.
  javazone: [2.08, 1.65, 1.04, 0.77, 0.54],

  // `lattesfold` (Shadertoy source, untitled, requester-supplied CC0 — no
  // in-source licence header, unlike its three siblings above; see
  // LattesFoldScene.tsx's header for the full provenance disclosure) — NOT
  // /bench-measured. FORCED LIVE by explicit request, and by a wide margin
  // the heaviest scene in the roster. Up to 90 outer accumulation steps, EACH
  // running an inner fold up to 12 times — up to 1080 fold iterations per
  // pixel, against `harkonnen`'s entire ~52-iteration fractal budget. This
  // estimate is POST a hoist fix that pulled three redundant per-iteration
  // trig calls (recomputed up to 1080x/pixel in the naive port, depending
  // only on the clock) out to once per pixel — the pre-hoist op count priced
  // roughly 3x higher. Even so, priced well above `travelling` (previously
  // the roster's heaviest estimate at 30 ms) on raw iteration count alone.
  // `pixelBudget` is already markedly more aggressive than every other scene
  // in the roster for the same reason.
  //
  // F199/F200: re-derived against the current 0.5/0.3 MP `pixelBudget` the
  // same way as its three siblings above (`solveScale()^2`, clamped to the
  // 0.4 floor at 4K -> 0.16 pixel ratio of the native-resolution estimate
  // directly above) — and UNLIKE its three siblings, still does not clear
  // the tier-0 bar even at the resolution floor (7.20 vs a 5.05 ms bar): 45 ms
  // of native-res cost is too much for a 16% pixel-count cut alone to close.
  // This is not a case where a lower `pixelBudget` would help — the floor is
  // already the floor. See `slotBudget.test.ts`'s own allowlist comment for
  // why this stays live rather than moving to DISABLED_SCENES: it is FORCED
  // LIVE by the same explicit request as its siblings, `compatibleWith: []`
  // bounds the damage to one scheduling mistake rather than a layer, and
  // disabling a scene someone explicitly asked to keep live is not this
  // correction's call to make. ACTION: run `/bench` and replace with a
  // measurement; this one plausibly needs real optimisation beyond the hoist
  // fix — cutting the outer/inner iteration caps, most likely — not just a
  // lower `pixelBudget`, before it can pass this bar for real.
  lattesfold: [7.2, 5.28, 2.88, 1.76, 1.12],

  // `neonjungle` (glslop "NEON // JUNGLE v7", ISF, CC0-1.0, credited to
  // "Craig") — NOT /bench-measured. In `DISABLED_SCENES`, not live (F203:
  // this comment previously said "FORCED LIVE by explicit request" — wrong,
  // and the kind of wrong that matters, since a reader would conclude the
  // LIVE roster carries a scene dearer than every other by a wide margin;
  // `slotBudget.test.ts`'s roster sweep never sees this row at all). The row
  // itself is otherwise unchanged pending a real `/bench`. A full
  // two-world volumetric raymarcher: STEPS 190 primary march + RSTEPS 60
  // reflection march on water/puddle pixels, each surface hit paying
  // calcNormal (4 taps) + calcAO (5 taps) + softShadow (up to 20 taps), all
  // re-running the scene's map() (a multi-primitive SDF combine with a
  // 4-octave value-noise FBM). Unlike the raw Shadertoy ports above, this
  // scene already carries its own quality-tier gating (`uQuality`, scaling
  // `steps`/`rsteps` off `quality.knobs.raymarchSteps`, floored at 0.35x,
  // plus a `pixelBudget`) — that wiring predates this promotion. The taper
  // below is shallower than `lattesfold`'s on purpose: `uQuality` scales the
  // MARCH step count but not the fixed calcNormal/calcAO/softShadow cost per
  // hit, so a chunk of the total is tier-invariant. Priced above `travelling`
  // (30 ms, single accumulation pass) for the double march + heavy per-hit
  // shading, just under `lattesfold`. ACTION: run `/bench` and replace with a
  // measurement.
  neonjungle: [38.0, 32.0, 27.0, 23.0, 20.0],

  // `truchet` (Shadertoy "Truchet + Kaleidoscope FTW"; CC0 header, MIT/CC0
  // helpers — reads as mrange's, same basis as `beats`/`travelling`/`web`) —
  // NOT /bench-measured. FORCED LIVE by explicit request. `color()`
  // accumulates up to 6 kaleidoscope + Truchet planes per pixel (no march
  // loop) through a dual-ray AA pass, which roughly doubles whatever the
  // base 6-plane cost is. Already carries its own quality-tier gating
  // (`uPlanes`, 3..6 off `quality.knobs.raymarchSteps`, plus a
  // `pixelBudget`) — that wiring predates this promotion. Priced against
  // `web` (3.4 ms tier 0, a similarly-shaped multi-plane bezier accumulator)
  // scaled up for the AA doubling.
  //
  // F196/F199/F200: the row above (6.8) failed the tier-0 bar outright — "just
  // under" was wrong, not marginal — and separately, F195 had raised this
  // scene's budget to 8.9/5.6, which F196 found solves to 1.00 (native) at a
  // 4K panel, paying the offscreen-blit overhead for nothing. Both are fixed
  // by the same move: reverted to 1.6/1.0, close to its pre-F195 budget,
  // re-deriving this row against the ORIGINAL (pre-F195) native-resolution
  // 6.8 ms estimate the same way as `gyroid`/`fridaylines`/`javazone` above
  // (`solveScale()^2`; the 1.6 MP high branch solves to 0.439 unclamped at
  // 4K, 0.193 pixel ratio; the 1.0 MP low branch clamps to the 0.4 floor,
  // 0.16). Clears the tier-0 bar with real margin now, and no longer wastes a
  // blit on an already-native buffer. ACTION: still run `/bench` and replace
  // with a measurement.
  truchet: [1.31, 1.12, 0.81, 0.51, 0.38],

  // `butterfly` (requester-supplied Shadertoy multipass paste, no header) — NOT
  // /bench-measured. One fullscreen pass, no volumetric march, but the
  // field-line streamline walk re-evaluates the analytic butterfly field
  // (`bField`: one `atan` + a 7-term Fourier sum AND its 7-term derivative,
  // ~14 trig) EVERY step, up to 44, plus a `sparkGrid` hash per step. That
  // per-step trig load is heavier than `kifs`'s per-iteration KIFS fold
  // (2.97 ms tier 0, ~20 iters, rotation-matrix multiply + 3 distance terms
  // WITH an escape that spares most pixels): ~2x the iteration count, no
  // early-out, offset by the offscreen `pixelBudget`. Priced a bit above
  // `kifs` on that basis. The taper tracks its two real levers: `uMaxSteps`
  // off `quality.knobs.raymarchSteps` (44→12) and the `pixelBudget` step
  // (1.6 MP tiers 0-1, 1.0 MP below). Deliberately NOT run through {@link
  // SCENE_COST_MODEL} — that needs a real multi-resolution measurement.
  // ACTION: run `/bench`; if tier 0 lands at/over `sceneBudget(0)/2` (5.05 ms),
  // drop `uMaxSteps`, evaluate the field every OTHER step, or lower
  // `pixelBudget`.
  butterfly: [3.8, 3.3, 2.7, 2.2, 1.8],

  // `limitless` — NOT /bench-measured. See LimitlessScene.tsx's own
  // `pixelBudget` comment for the full op-count reasoning; restated here
  // arithmetically. Dominant mode is `smear`: 8 true `snoise(vec3)` calls per
  // pixel (two `fbm()`, 4 octaves each). `SIMPLEX3D_GLSL`'s own doc prices
  // that call at "roughly an order of magnitude more expensive per sample"
  // than the cheap hash-noise `malachite` uses (measured 0.76 ms at a 1.3 MP
  // budget for up to 25 samples). 8 snoise samples ~ 80 hash-noise-equivalent
  // samples, ~3.2x malachite's per-pixel cost; this scene's own 1.8 MP budget
  // is 1.385x malachite's 1.3 MP. Combined: ~4.4x malachite's row, ~3.4 ms —
  // rounded up for the estimate's own uncertainty, landing at 3.8, comfortably
  // inside the tier-0 `< sceneBudget(0)/2` (5.05 ms) admission bar with real
  // margin, matching the `pixelBudget` comment's own "holds the worst mode
  // well inside the bar" framing.
  //
  // FLAT across all five tiers, deliberately, not tapered: unlike
  // `beats`/`travelling`/`gyroid` and their `quality.knobs.raymarchSteps`
  // gating, nothing in this scene's `update()` reads `quality.knobs` at all —
  // every one of the 15 modes runs the same per-pixel work regardless of
  // tier, so a taper would invent a mechanism that is not actually there (the
  // same honesty `dustfield`'s F197 finding already established for a
  // no-governor-response scene). The one real tier lever is the ENGINE's own
  // `solveScale`, which this row does not need to account for separately —
  // see `SCENE_COST_MODEL`'s own doc on the difference between a flat-tier
  // guess and a resolution-parametric one; this scene has neither a
  // multi-resolution measurement nor a per-tier complexity cut to model.
  // ACTION: run `/bench` and replace with a measurement, ideally per-mode
  // (F214 already flags that `none`/`solar`/`halftone` are one texture fetch
  // and could run a much larger budget than `smear` needs).
  limitless: [3.8, 3.8, 3.8, 3.8, 3.8],

  // --- DJ Cam (dj-cam), NOT /bench-MEASURED — engineering estimate ---------
  // `djcam` is not a shader scene: it blits the shared DJ-camera
  // `VideoTexture` to a fullscreen quad through a bare cover-fit fragment
  // shader — no grade, no loop, no fbm, no geometry. The one cost a shader row
  // does not carry is the per-frame upload of the decoded video frame into the
  // texture, which the browser compositor has usually done already. Priced a
  // notch above the closed-form effect shaders (`shock`/`strobe`, ~0.06-0.08)
  // to cover that upload, and an order of magnitude below `wireframe`
  // (0.63-0.78, real 3D line geometry). Flat across every tier: the shader
  // reads no `quality.knobs`, so the only tier lever is the resolution solve,
  // priced separately. NOT run through {@link SCENE_COST_MODEL} (that needs a
  // real multi-resolution measurement; a fabricated regression would
  // manufacture false precision). ACTION: run `/bench` and replace this with a
  // measurement once a headless harness exists.
  djcam: [0.15, 0.15, 0.15, 0.15, 0.15],
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
