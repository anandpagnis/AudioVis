# AudioVis — Open Issues

Running register of everything found in the codebase audit of 2026-08-21, plus
anything found since. **This file is the source of truth for what is fixed.**

Each entry keeps its original ID (`F01`…`F21`) so it stays traceable to the
audit and to commit messages. Tick the box when the fix lands *and* is verified
— a change that typechecks is not the same as a change that works.

Severity: **Blocker** ships nothing without it · **High** hurts the product now
· **Medium** real but survivable · **Low** cleanup.

Status legend: `[x]` done · `[ ]` open · `[~]` partly done, see the note.

---

## Blockers

- [ ] **F01 · Absent licence defaults to "shippable"** — `src/scenes/index.ts`
      `nonCommercialSceneIds()` treats a missing `license` field as `original`, so 15
      scenes with no declared provenance pass the commercial filter. The type's own
      doc comment says the opposite: *"anything not marked original or attribution
      should be assumed unshippable."* Invert the default, trace every ported scene to
      its source, and add a build-time gate.
      **Today only 3 scenes are provably safe to sell.**

- [x] **F02 · The "AI" tier depended on the customer's own localhost** —
      *resolved 2026-08-26 by deleting the feature*
      `generative: true` was the default and the layer polled
      `http://127.0.0.1:8787` for the sd-turbo server in `backend/server.py`. No
      paying customer would run that.

      The two survivable fixes were "host inference behind an authenticated
      endpoint" or "default the toggle off and label it a developer feature" —
      but the deciding fact was that the feature had never actually been used.
      What shipped was a standalone FastAPI + uvicorn process holding a ~2.5 GB
      diffusion model in GPU memory, never started or stopped by `npm run dev`,
      with no shutdown path tied to the frontend's lifetime. A visualizer whose
      whole problem is GPU headroom does not get to keep an unused 2.5 GB
      resident alongside it.

      Removed: `backend/` (server, runner, requirements), `GenerativeLayer.tsx`,
      `textureGenerator.ts`, the `generative` store flag and its `G` binding, the
      `gen` URL param, the "AI textures" chip, the DebugPanel readout, and
      `GENERATIVE_UNITS`. The frame budget's fixed cost drops from 4 units to 2
      at rest — see the F84 note, where that unit is what decides whether a
      crossfade can carry two primaries.

- [ ] **F03 · No account, entitlement or billing surface exists** — `wrangler.jsonc`
      Cloudflare static assets with SPA fallback: no Worker routes, no auth, no
      licence check, no payments. Everything persists to `localStorage`. There is
      currently no mechanism by which a subscription could gate anything.

- [x] **F04 · Quality governor could not see the hitches it exists to prevent** —
      `src/engine/quality.ts`, `src/engine/PerfMonitor.tsx`
      `tick()` now takes a third argument, the p95 of raw frame times over the last
      10 s. Either axis can force a step down; **both** must be clear to climb back.
      `PerfMonitor` recomputes the percentile 4×/s (not per frame — `percentile()`
      allocates and sorts) and publishes it as `perf.p95`.
      Covered by `src/engine/__tests__/qualityGovernor.test.ts`.

## High

- [x] **F05 · Invisible scenes still rendered their offscreen passes** —
      `TrailLineScene`, `SynthGridScene`, `KernelPanicScene`
      `node.visible = false` removes a subtree from the main traversal but has no
      effect on a manual `gl.setRenderTarget()` + `gl.render()` inside the frame
      callback, so a pending scene paid full cost for up to the 2.5 s commit timeout
      while drawing nothing. All three now return early on `vis <= 0.001`, after
      writing their display fade. Clocks freeze with them, so a resumed scene
      continues rather than jumping forward through its own script.

- [x] **F06 · Fog toggle triggered a full shader recompile** —
      `src/engine/EffectsDirector.tsx`
      Whether a scene has fog is part of Three's program cache key, and `p.fog` eases
      exponentially so it crossed the old `0.001` threshold once in each direction per
      ambient transition — two whole-scene recompiles at exactly the musical moments
      that must stay smooth. The fog object is now attached once for the session and
      density alone carries the range (`FogExp2` at density 0 is a no-op).

- [x] **F07 · Two independent definitions of the tier budget ladder** —
      `src/engine/slotBudget.ts`, `src/engine/quality.ts`
      `TIER_BUDGET` carried the calibration comments and was imported by nothing;
      the enforced values lived in a second array inside `quality.ts`. They matched
      by coincidence. `quality.ts` now builds `layerBudget` from `TIER_BUDGET`, so
      the numbers the code enforces and the numbers the comments describe are the
      same array. Closed while rebasing the ladder for F43.

- [x] **F08 · Layers had no dwell floor** — `src/store.ts`
      `requestScene` enforced `MIN_SUBJECT_DWELL_BEATS` (32); `setLayer` enforced
      nothing, so layers could be replaced every 8 beats while the subject held for
      32. Added `MIN_LAYER_DWELL_BEATS = 16` and `canAutoSwitchLayer`, with per-slot
      commit stamps in `layerCommitBeats`. Manual picks and slot *clears* are exempt.

- [x] **F09 · `preserveDrawingBuffer` was always on** — `src/engine/Stage.tsx`
      Removed entirely. It forced a framebuffer retain on every frame of the session
      to serve a feature used a handful of times. Screenshots now go through
      `recorder.captureIfRequested()`, called from a `useFrame(…, 2)` inside the
      Canvas — after `EffectComposer` (priority 1) composites, while the buffer is
      still valid. Video recording never needed the flag; `captureStream()` taps the
      compositor directly.
      **Debugging note:** a stalled render loop now goes black instead of showing its
      last good frame.

- [x] **F10 · Full-viewport 2D overlay redrew every frame, by default** —
      `src/ui/TacticalHUD.tsx` *(deleted)*
      148 canvas2d ops per frame including a per-frame gradient allocation and text
      rendering, at up to 3840×2160 backing store, on its own rAF competing with the
      render loop. Removed along with its store flag and menu chip. The BPM readout,
      the `auto` chip and the ☰ menu are what remain.
      Its `J` keybinding was freed and is now the fps meter — see Verification.
      Recoverable from git history if the look is ever wanted back — as a throttled,
      DPR-1 component.

- [x] **F10b · BPM readout had the same per-frame DOM cost** — `src/ui/BpmReadout.tsx`
      Now the only always-on per-frame DOM surface, so it inherited the problem.
      Text and width fields refresh at 10 Hz and are diffed against the last written
      value, so a steady tempo does zero layout work. The beat dot stays at 60 fps
      because it animates only `opacity`/`transform` — compositor-only, no layout, no
      paint.

## Medium

- [x] **F11 · Rolling windows allocated and memmoved every frame** —
      `src/engine/RollingWindow.ts`
      Rewritten as a ring buffer over two `Float64Array`s. All three costs are gone:
      no `{t,v}` object per push (~300 allocations/s, and the GC pauses that sweeping
      them caused), no `splice(0,i)` memmove — pruning now advances one index instead
      of shifting up to 1,800 elements — and `percentile()` sorts into one reused
      scratch buffer, memoized, so repeated calls between pushes cost an array read.
      The ring grows if it fills while samples are still in-window (so a 144 Hz
      display is fine) and drops the oldest at a hard cap rather than growing without
      bound if a caller's clock never advances.
      `values(): readonly {t,v}[]` is replaced by `timeAt(i)` / `valueAt(i)` —
      materialising that array would have re-created the garbage in the *reader*, and
      `AnalyticsPanel` calls it once a frame while open. Panel updated to match.
      Covered by 7 new cases in `RollingWindow.test.ts` (wrap ordering, growth, stale
      memo, scratch reuse, the never-advancing-clock guard).

- [ ] **F12 · Analytics sampled every frame whether or not anything reads it** —
      `src/engine/SceneManager.tsx`, `src/engine/analyticsMetrics.ts`
      `sampleAnalytics` and `sampleTransitionFrame` run unconditionally; the panels
      they feed are closed by default. Gate on `analyticsOpen`.

- [x] **F13 · Landing page and visualizer shipped in one chunk** — `src/App.tsx`
      `/app` is now `React.lazy` behind a `Suspense fallback={null}`, with the loader
      in `src/routes/lazyRoutes.ts`.
      Entry chunk **368 kB → 308.87 kB** (119.89 → 100.23 kB gzipped); the visualizer
      is a separate 46.17 kB (15.89 kB gzip) chunk that a bouncing visitor never
      requests — verified absent from the landing HTML in a preview build.
      Two judgement calls worth knowing:
      - **Landing is deliberately NOT split.** Splitting it was tried and measured:
        same bytes for a landing visitor, plus a round trip of blank screen, because
        the second request cannot start until the entry has parsed. It is the entry
        point; everyone needs it.
      - `Landing` prefetches the `/app` chunk on `requestIdleCallback`. The CTA fades
        to black *before* navigating, so a cold fetch would land inside the fade and
        the fade-in could reveal an empty route.
      **Route splitting cannot go much further.** `three` (699 kB) and the
      postprocessing chunk (239 kB) stay shared because the landing tunnel is itself a
      WebGL scene with its own post chain, and those dominate the payload.

- [x] **F14 · 256-iteration CPU waveform decimation ran while invisible** —
      *fixed 2026-08-27*
      `src/scenes/FlowRibbonScene.tsx`
      The decimation and its texture upload now return early when `vis` is at
      rest. `ribbons` is layer-capable, so a faded-out copy was paying for a
      trace nobody could see, once per mounted instance.
      The smoothing state is deliberately NOT reset on the way out: it is a 26/s
      exponential follower that re-converges within a frame or two of coming
      back, and clearing it would snap visibly on fade-in.

- [ ] **F15 · `EffectDirector` and `EffectsDirector` are different subsystems** —
      `src/engine/`
      One owns event-triggered effect *scenes*, the other owns the post-processing
      chain. Both are mounted in `Stage`, one character apart. Rename the post chain
      to `PostChain`.

- [ ] **F16 · `budgetLedger` is unreached Phase-7 scaffolding** —
      `src/engine/streaming/budgetLedger.ts`
      111 lines plus a 250-line test suite; `ceilingForTier` and `evaluateLedger` are
      imported only by that test. It is the VRAM-budget mechanism the uncapped render
      targets actually need — wire it up or delete it, but do not leave a tested
      no-op.

## Low

- [ ] **F17 · Six exported symbols with no production caller**
      `CAMERA_MODES`, `DEFAULT_ANCHOR`, `LOADER_KEYS`, `isResident`,
      `resetParallelCompileProbe`. `registerPalette` is a documented extension point
      like `registerScene` and should stay.

- [x] **F18 · The background slot has no content** — *fixed 2026-08-27*
      `src/scenes/index.ts`
      `orbs` now declares it, which its own comment had nominated it for. The
      stated reason for declining — "nothing selects `background`" — was
      circular: `PerformanceDirector` selects it at section boundaries and
      `composeLayers` funds it, so the pool was empty only because nobody had
      gone first.
      It is also the right scene on the numbers rather than only on the prose:
      0.06 ms at every tier, the cheapest in the roster by a wide margin, which
      is what a permanently-present ground layer has to be.
      Observed filling the slot in a 120 s live show.

- [~] **F19 · Two primaries produce no layers at all** — *narrowed; the
      duplicate-slot half is fixed, the pool half is not*
      `src/engine/PerformanceDirector.tsx`
      **Fixed:** a scene could hold two slots at once. The pools overlap heavily
      — `orbs` carries background, accent and overlay between them — so the same
      scene was picked twice and `resolveLayerIds` dropped the later one at
      mount for being a duplicate. Observed live as `acc orbs / ov orbs`: the
      composition the director chose and the one that rendered were different,
      which is precisely the flicker this entry describes. Picks now exclude
      already-taken scenes from the POOL rather than filtering afterwards, so
      the later slot gets a genuine second choice instead of losing its turn.
      **Still open:** with `plasma` or `network` as the subject the accent pool
      is still thin, because only `ribbons`, `orbs` and those two scenes carry
      layer roles at all. That is the same root cause as Issue 3 and wants
      authored layer-only scenes, not more role declarations — most of the
      roster is documented as correctly primary-only, with reasons.

- [x] **F20 · The effect slot is fully built and completely empty** — *fixed
      2026-08-27; the slot has now fired for the first time*
      `src/scenes/OrbitGlowScene.tsx`, `src/scenes/index.ts`
      `orbs` claims the role with `triggers: ['drop']`, a 4.2 s lifetime (just
      over two bars at 120 BPM) and a 14 s cooldown. Drops only to begin with:
      `transient` would fire it several times a bar and turn punctuation into
      texture, which is the failure mode this slot is most exposed to.
      The one requirement that had kept the role unclaimed is now met.
      `SceneManager` retires an effect entry the instant `slotProgress` reaches
      1 and does NOT fade it out, so a scene still bright there simply vanishes.
      `effectEnvelope` gives it a fast rise (so it lands ON the transient that
      fired it), a brief hold and a long decay that is exactly zero at 1 — the
      decay dominating the lifetime is what makes a drop read as a hit followed
      by a room rather than as a shape that came and went.
      Read `slotProgress` only in the effect role: it is 0 for a normal layer
      and the envelope is 0 at 0, so an unconditional read would have made the
      scene invisible everywhere else.
      Observed live: two firings in a 120 s set, 85 s apart, both retiring
      cleanly.

- [ ] **F21 · Docs regressed in the force-push**
      Overwriting `main` dropped `9e6fd90`, so `docs/HANDOFF.md` still describes a
      five-scene roster and 61 tests against an actual 18 and 314. Recover with
      `git cherry-pick 9e6fd90` from `backup/main-20260820`.

---

## Frame-time control loop

- [x] **F22 · The quality governor measured its own actuation and ran away** —
      `src/engine/frameSampler.ts` *(new)*, `src/engine/PerfMonitor.tsx`
      **Introduced by F04.** Stepping the tier down changes DPR, which resizes the
      renderer and reallocates the post chain's mip pyramid — a multi-hundred-ms
      stall that was fed straight back into the p95 that caused it. With one shared
      10 s window and a 2 s `SETTLE_SEC`, the governor re-decided five times inside
      its own pollution and stepped down each time, each step firing another resize.
      One legitimate spike drove tier 0 to tier 4 in about ten seconds and pinned it
      there. This is what "goes amber or straight up red on heavy scenes" was.
      Fixed by three rules, all in `frameSampler.ts` so they are testable:
      - **Two windows.** The display window (10 s, unfiltered) feeds the fps meter
        and analytics — a scene change really does drop frames and the instrument
        must say so. The governor reads a separate filtered window.
      - **The governor never sees a known one-off.** `suspend()` hides frames caused
        by a DPR resize, a scene commit (compile + crossfade), or a context restore.
      - **Governor window (2 s) ≤ `SETTLE_SEC` (2 s),** so a spike can influence at
        most one decision even if something slips past the suspension. Pinned by a
        test.
      Also: `governorP95()` returns 0 (= "no signal") below 15 samples, so the
      governor is agnostic rather than confident just after a suspension.

- [x] **F23 · Render scale changed on every tier step** — `src/engine/PerfMonitor.tsx`
      A tier bundles cheap knobs and one expensive one. Complexity (raymarch steps,
      iterations, particle fraction) is free — scenes read `quality.knobs` live.
      DPR is not: it resizes and reallocates. Applying both together meant every
      step paid the stall that caused the next step.
      Now split: complexity applies instantly, render scale waits for the tier to
      hold `RENDER_SCALE_HOLD_SEC` (3 s). A show oscillating between two tiers pays
      nothing for it. A user-pinned quality change still applies immediately — that
      is an instruction, not a guess. The fps meter shows `T3›2` while DPR trails.

- [x] **F28 · JuliaWings supersampled a transcendental-heavy loop at 3x** —
      `src/scenes/JuliaWingsScene.tsx`
      The dominant cost in the roster, and the direct cause of the reported red on
      this scene. `juliaFractal` runs up to `uMaxIter` (64) iterations, and EVERY
      iteration does an `atan`, a `log` and three `length()` square roots — roughly
      320 transcendental/sqrt ops per pixel per call. `uExtraTaps` made three such
      calls, so ~960 per pixel, and it was enabled for tiers 0, 1 AND 2 — three of
      the five tiers. At tier 1 on a retina laptop that is ~6M pixels paying it,
      purely for antialiasing.
      Taps are now tier 0 only. Resolution is the cheaper way to buy edge quality:
      `renderScale` trades it smoothly where this knob only has 1x and 3x.

- [x] **F29 · TorusFold rebuilt a constant rotation 600x per pixel** —
      `src/scenes/TorusFoldScene.tsx`
      `p.xz *= rot2(uTime)` sat inside the 6-iteration fold, itself inside the
      100-step march — building `mat2(cos, -sin, sin, cos)` from a uniform, so the
      same value, for every pixel, 600 times. Now a `uFoldRot` mat2 uniform computed
      once per frame on the CPU. Bit-for-bit identical output.
      Caveat: a competent driver hoists loop-invariant pure code after inlining, so
      this may already have been free on some GPUs. It is one cos and one sin per
      frame either way, so it is not worth leaving to chance.

- [x] **F30 · Heavy fullscreen scenes render at full canvas DPR** — *resolved
      narrowly, and the broad fix was rejected on evidence*
      The proposal was to downscale every `high`-cost fullscreen scene, or cap base
      DPR globally. **The benchmark killed both.** Most of those scenes are cheap:
      `synthgrid` 2.2 ms (its own 0.6x buffer already works), `torusfold` 2.0,
      `inversion` 3.1. Downscaling them would have cost real image quality to solve
      a problem they do not have — a good argument for measuring before optimising.
      Exactly one scene needed it: **`foldpath`, at 16.0 ms**, against a 16.67 ms
      budget, alone, before post. Its `uMaxSteps` knob was inert (600 → 175 across
      the tiers moves cost 19%) because the march early-exits long before the cap —
      the cost is per-step work, so the governor had no lever on the one scene that
      needed one. Now renders to an offscreen buffer at `RENDER_SCALE = 0.5` of the
      device resolution (a quarter of the pixels), mirroring SynthGrid's proven
      pattern, plus the F05 visibility gate it was missing.

- [x] **F32 · JuliaWings supersampling removed outright** —
      `src/scenes/JuliaWingsScene.tsx`
      Follow-on to F28, now with numbers: 14.00 ms with the 3 taps, 4.69 ms without
      — 2.98x, exactly as the op-count predicted, for antialiasing alone. Tier-gating
      it was a half-measure; the taps are gone. If the wing veins alias too hard, the
      replacement is resolution (an offscreen buffer, as FoldPath now uses), which is
      a continuous knob rather than a 3x cliff.

- [x] **F33 · The bench mismeasured the particle scenes** — *fixed, re-run, folded into the cost table*
      `plasma` read 2.43 ms in one cell and 0.48 ms in the next, which no quality knob
      explains. Two causes, both now fixed in `src/bench/BenchStage.tsx`:
      - `performanceState.particleDensity` is written by `PerformanceStateBridge`,
        which the bench does not mount, so it stayed pinned at 1 and the particle
        scenes never responded to the tier. Now set from `quality.knobs` per cell.
      - Their geometry is built on a worker and held at `setDrawRange(0, 0)` until it
        lands, so a mounted-but-unfilled scene measures nearly free. The runner now
        refuses to sample until the frame actually drew something
        (`triangles + points + lines > 0`) — summing all three because point and line
        scenes legitimately draw zero triangles forever.
      **Re-run done 2026-08-26** — and it is the run `engine/sceneCost.ts` was
      built from, so those two guards are baked into every number in the table.
      `plasma` now reads a clean 1.01 → 0.06 ms across the ladder (a 14x
      response, where before it was noise), `dissolve` 0.11 → 0.04 and
      `pointcloud` 0.12 → 0.06. None of the three is `high` by any reading; the
      labels are gone entirely, which is the retag.

- [x] **F34 · The bench framed scenes with the wrong camera** — *fixed
      2026-08-27; the affected rows need a re-run*
      `src/bench/BenchStage.tsx`
      It used the default Canvas camera at `[0,3,13]` for everything, so scenes
      that read the real camera (`chrome`, `inversion`, `torusfold`) were
      measured from a distance no viewer sees them at — `torusfold`'s anchor is
      3.3 units, so at 13 it is mostly empty space and marches out cheaply.
      The camera now sits on the scene's own declared `cameraAnchor`, held
      still. Deliberately NOT `CameraDirector`: its modes orbit and drift, so
      the framing would differ between the warmup frames and the measured ones,
      and between two runs of the same cell. A benchmark wants the
      representative distance, not the movement.
      **`engine/sceneCost.ts` still carries the old numbers for those three
      rows** and says so at the definition. Re-run `/bench` to replace them.

- [x] **F31 · Chrome punched an invisible hole in other scenes** —
      `src/scenes/ChromeFormScene.tsx`
      Reported as "chrome blips in and out" and "invisible but hides the background,
      so it's visible in the negative". Both are the same cause.
      `ChromeForm` is the ONLY scene in the roster that writes depth — every other
      material sets `depthWrite: false`, and `MeshPhysicalMaterial` defaults it to
      true. `transparent: true` does NOT change that, which is the trap: at low
      opacity the knot contributed almost no colour while still stamping its full
      silhouette into the depth buffer.
      Two situations hit it constantly:
      - **Warm-up.** `EntryGroup` deliberately keeps a warming entry visible (that is
        how its shader compiles) while its fade sits at 0 — so every time chrome was
        queued, an opacity-0 knot occluded the current scene for a few frames.
      - **Crossfades.** Half-faded chrome occluded whatever it was fading to/from.
      Affected the scenes that still depth-test: `ribbons`, `plasma`, `pointcloud`,
      and one of `dissolve`'s two materials. The fullscreen-quad scenes set
      `depthTest: false` and were immune, which is why it looked scene-specific.
      Fixed with `heroMat.depthWrite = vis > 0.98` — correct self-occlusion when
      settled, no hole when faint.

- [x] **F35 · A downbeat could commit onto an uncompiled scene** —
      `src/engine/SceneManager.tsx`
      **The main cause of stalling transitions.** `resolveCommit` waited for the
      incoming shader only on the drop path; a normal beat-locked switch committed
      on the downbeat regardless of whether the scene was warm. The window is easy
      to hit — `requestScene` fires on a mood change, and if the next downbeat is a
      frame or two later there has been no time for the chunk to arrive, let alone
      for the program to link. The commit promoted a cold entry and the driver
      compiled it on its first real draw: a multi-hundred-ms freeze landing exactly
      on the beat, which is the one place the warm-up machinery exists to protect.
      It also explains why the stalls looked random rather than scene-specific — it
      depends only on where in the bar the request happened to land.
      Now `onDownbeat && warmEnough`, with `incomingWarm === null` (nothing warming)
      and the existing `waited > 2.5` backstop both preserved so the gate can never
      deadlock. Skipping a downbeat costs one bar.
      The old suite missed this because its fixture had `incomingWarm: true`, so no
      case ever exercised a cold downbeat. Six regression tests added.

- [x] **F36 · AutoPilot discarded in-flight warm work** — `src/engine/AutoPilot.tsx`
      A pending scene has an entry mounted and warming, and `retainPending` allows
      only one candidate (`MAX_PENDING = 1`). AutoPilot excluded the pending scene
      from its own candidate list but would happily pick a DIFFERENT one and call
      `requestScene`, evicting the warming entry and throwing away its banked
      compile work — so the replacement started cold and was likelier to still be
      cold at its own downbeat, compounding F35. Now returns early when a switch is
      already in flight, unless this is a drop.

- [x] **F37 · PerformanceDirector composed layers against a phantom primary** —
      `src/engine/PerformanceDirector.tsx`, `src/store.ts`
      `requestScene` refuses silently when the subject dwell floor has not elapsed,
      and the director assumed it had succeeded — so on every refused request the
      layers were composed against a scene that was never going to appear. That
      picks `compatibleWith` partners for the wrong subject and can select the scene
      that IS currently primary, which `resolveLayerIds` then nulls at render time.
      A layer chosen and immediately dropped reads as a failed transition.
      `requestScene` now returns whether it accepted the request.

- [x] **F24 · Thresholds sat in a vsync dead zone, so the governor never fired** —
      `src/engine/quality.ts`, `src/engine/PerfMonitor.tsx`
      Not cosmetic after all — this was why nothing improved. A field panel read
      `mean 18.7 ms p95 32.3 ms` with the tier sitting still. Those are the exact
      numbers of a 60 Hz display dropping about one frame in eight, and the gates
      were `mean > 20` and `p95 > 34`: **both just above the failure they existed to
      catch.** rAF is vsync-locked, so frame time is quantised (16.7 / 33.3 / 50.0 at
      60 Hz) and no value can land between — the thresholds described a continuous
      signal that does not exist.
      Now expressed as multiples of the measured refresh interval: step down above
      1.1x mean or 1.5x p95, climb only under 1.05x / 1.25x. `PerfMonitor` measures
      the interval from the **10th percentile** of frame times — rAF frames can be
      late but essentially never early, so the fast tail is the interval even on a
      machine dropping most of its frames, where a median would drift upward exactly
      when it matters. Clamped to 4-21 ms so a throttled background tab cannot pin
      the tier.
      Also fixes the high-refresh case: 20 ms is three dropped frames on a 144 Hz
      panel and the old absolute gates called it healthy.

- [x] **F43 · Three claimants, three partial views of one budget** —
      `src/engine/frameLoad.ts` *(new)*, EffectDirector, PerformanceDirector,
      SceneManager, slotBudget, quality
      The general form of F41. The frame budget had three independent claimants and
      each reserved against a different subset of the same frame:
      | claimant | reserved | blind to |
      |---|---|---|
      | `composeLayers` | primary | effects, post chain, generative |
      | `EffectDirector` | primary + live effects | **layers**, post chain, generative |
      | `canFundOverlap` | both primaries (+ layers, after F41) | effects, post chain, generative |
      And **nothing at all** accounted for the two costs present in every frame: the
      post chain (bloom mip pyramid + CA + vignette) and `GenerativeLayer`, which
      `Stage` keeps mounted for the session once ever enabled — and `generative`
      defaults to true. Each claimant was individually correct; the sum was not.
      `frameLoad.ts` is now the single source of truth. `SceneManager` publishes the
      live breakdown each frame (it is the only component that knows every mounted
      entry, and it distinguishes a warm entry that is still drawing from one that
      has compiled and gone quiet); everyone else reserves against
      `committedUnits()`.
      **The ladder was rebased 3 units up** — `[8,6,4,3,2]` → `[11,9,7,6,5]`. Those
      figures were calibrated when the fixed costs were reserved at zero, so the cost
      was implicitly baked in; subtracting it explicitly without rebasing would have
      charged twice and cut the scene budget to `[5,3,1,0,0]`, stripping layers from
      the show entirely at tier 2 and below. Verified arithmetically neutral: the
      composition budget is unchanged at every tier, while the previously-blind
      claimants now see the whole frame.

- [x] **F45 · The budget was checked at decision time, never before drawing** —
      `src/engine/SceneManager.tsx`
      The committed load could still exceed the tier's capacity, which is what kept
      transitions lagging even with the accounting fixed. Every check happened where
      a decision was MADE — `composeLayers` at a phrase boundary, `EffectDirector` on
      a trigger, `canFundOverlap` at a commit — and nothing verified the total before
      actually rendering it. Two routes pushed a legal decision over the line
      afterwards:
      - **A crossfade.** `composeLayers` reserves ONE primary, so mid-fade it offered
        the outgoing scene's share to the layers as though it were free. Two heavy
        primaries plus fixed costs already fill tier 0 exactly (4+4+3 = 11); the
        layers admitted on top took the frame to ~15 against 11.
      - **A tier drop.** Layers admitted at tier 0 (capacity 11) stayed mounted when
        the governor stepped to tier 2 (capacity 7). Nothing re-examined them until
        the next phrase boundary, up to 16 beats later.
      `resolveLayerIds` now takes the remaining capacity and sheds layers in reverse
      structural order — overlay first, then accent, keeping the ground layer. It
      already ran every frame and already decided what mounts, so it was the natural
      enforcement point. Self-correcting in both directions: when capacity returns the
      layer is simply admitted again on a later frame, with no state to unwind.
      Skips rather than breaks, so a cheap overlay still fits where an expensive
      accent did not — shedding more than the frame needs is its own failure.

- [ ] **F44 · The two fixed costs are estimates, not measurements** — *open*
      `POST_CHAIN_UNITS = 2` and `GENERATIVE_UNITS = 1` are reasoned (a bloom mip
      chain is roughly a fullscreen pass and a half; the generative overlay is one
      fullscreen fbm quad) but **not measured**. `/bench` deliberately excludes the
      post chain so scene costs compare cleanly, which means the one cost present in
      every single frame is the one number never measured.
      Add a bench mode that measures an empty scene with and without the post chain
      (and with and without the generative overlay); the difference is the fixed
      cost. Then set these two constants from data and re-check the ladder rebase.

- [x] **F41 · The overlap budget ignored the layers** — `src/engine/slotBudget.ts`,
      `src/engine/SceneManager.tsx`
      Source of the 33-35 ms transition frames. `canFundOverlap` asked only
      `incomingUnits * 2 <= budget`, so at tier 0 `network` + `heap` (4 + 4 = 8 of 8)
      counted as affordable — while `ribbons` and an overlay were also rendering, for
      11 units of real load against a budget of 8, or ~14 ms of scene work before the
      post chain. Layers deliberately survive a primary switch, so they are always
      part of the overlap and were never counted.
      The `bothHeavy` conjunct compounded it: a `high` + `medium` pair plus layers was
      never even tested for affordability.
      Now a straight sum of everything on screen — outgoing + incoming + live layers.
      A fade makes neither scene cheaper (it is a multiply at the end of the fragment
      shader, so a scene at 5% opacity costs full price), which is why the honest test
      is the total. Pairs that do not fit hard-cut, which costs nothing.

- [~] **F42 · Four scenes ignore the quality governor entirely** — *partly fixed*
      `network`, `chrome`, `orbs` and `panic` read no quality knob at all, so their
      cost is FIXED at every tier — the governor cannot relieve them and neither can
      the transition discount. The bench shows it plainly: `network` measures
      5.78 / 6.26 / 6.26 / 6.19 / 6.26 ms across tiers 0-4, completely flat, and it is
      the second most expensive scene in the roster.
      `network`'s knob is obvious — `NUM_LAYERS = 4.0`, each layer running a 9-cell
      hash grid (~36 evaluations per pixel). Making it a governed early-break (as
      TorusFold does with `uMaxSteps`) would scale it 4 → 2 layers and roughly halve
      the cost. GLSL ES 1.00 needs a constant loop bound, so it has to be
      `for (int i = 0; i < 4; i++) { if (i >= uLayers) break; ... }`.
      Deliberately NOT done blind: it visibly changes the scene's depth density, and
      three unverified visual changes are already queued (FoldPath's half-resolution
      buffer, JuliaWings' removed AA, Chrome's depth write). Land those, look at them,
      then do this one.

      **Update (2026-08-25).** `network` now has the `uLayers` early-break described
      above (4 layers at tier 0 down to 2 at the survival tier, dropped from the back
      so the most distant already-faded copy goes first). Separately, every scene now
      declares a `pixelBudget` and the engine solves the internal resolution from it
      — see `src/engine/renderScale.ts` — which is the governor lever `chrome` and
      `orbs` were missing: both are purely fill-bound, so resolution is the only
      honest knob they have and it is now applied whether they cooperate or not.
      `panic` additionally sizes its four offscreen feedback passes through
      `bufferScale()`, so the half of that scene which is invisible to canvas DPR is
      finally inside the budget too (`trail` and `synthgrid` got the same treatment).
      **Still open:** none of this is verified against real music on real hardware,
      and `network`'s depth-density change has not been looked at by a human.

- [x] **F39 · The analytics flagged every hard cut as a failure** —
      `src/engine/SceneManager.tsx`, `src/ui/AnalyticsPanel.tsx`
      `beginTransition` recorded `targetDurationSec = crossfadeDuration(bpm)` even
      when the transition was a deliberate hard cut, which lands in ~0.0 s. The panel
      then computed `off = |0.0 - 0.9| / 0.9 = 1.0` and flagged it — so **every hard
      cut showed red, always, by construction**, including perfectly healthy ones
      with a 17 ms p95. The instrument was reporting a feature as a fault, and it
      sent this investigation chasing performance that was already fine.
      A cut now records a target of 0 (that IS its target), and the panel skips the
      duration check for cuts entirely — only frame cost is meaningful there.

- [x] **F40 · The transition discount was degrading the show far more than it
      helped** — `src/engine/quality.ts`, `src/engine/SceneManager.tsx`
      Self-inflicted, introduced by F38. Reported as "the ms didn't rise but it still
      lagged" — and nothing WAS slow; the picture was just quietly getting worse.
      Three faults, all now fixed:
      - **Wrong scope.** It keyed on `dir === 0`, but a warming candidate is only
        kept visible until `isWarmComplete` (~5 frames); after that it renders
        nothing. With F35's warm gate a switch can sit pending for a whole bar, so
        the discount held for seconds at a time with no second scene on screen. Now
        `dir === -1 || (dir === 0 && !isWarmComplete(e))`.
      - **It snapped.** A 2-tier step applied on a single frame is a visible pop at
        both ends of every transition. Now an eased 0..1 amount (~0.15 s constant);
        the governor lerps between tiers rather than switching.
      - **It removed particles.** `particleFraction` drives `setDrawRange`, so
        discounting it made points literally vanish — 44% of `plasma`'s 70k cloud at
        tier 1. Excluded outright; the discount now touches loop bounds only, which
        change fine detail rather than the existence of anything.
      The knobs object is mutated in place so easing allocates nothing.

- [x] **F38 · Every crossfade rendered two full scenes** — `src/engine/quality.ts`,
      `src/engine/SceneManager.tsx`
      Reported as "literally every transition" lagging — and structural, not random.
      A crossfade renders BOTH primaries at full cost for its whole duration (~1 s at
      120 BPM), and a warming candidate renders beside the current scene too. So for
      about a second per switch the frame carries twice the scene work it was tiered
      for. The `bothHeavy && !fundsOverlap` hard-cut does not cover it: at tier 0 the
      budget is 8 and two `high` scenes cost 4 each, so `canFundOverlap` passes and
      even the heaviest pair crossfades; every medium/low pair always does.
      `quality.setTransitionDiscount()` now drops complexity by 2 tiers while two
      primaries share the frame, so two discounted scenes cost about what one
      undiscounted scene did. Touches complexity ONLY — `renderScale` would mean a
      renderer resize at the start of every crossfade, and `layerBudget` would drop
      layers mid-fade. Nobody can resolve fine raymarch detail through a one-second
      dissolve, which is what makes it the cheapest quality in the frame to sell.
      Also found: the `governorAt` test helper mapped tiers 1 and 3 onto tier 4
      (`setMode` only reaches 4/2/0), so any test using them asserted against the
      wrong starting point. Now uses `pinTier`.

- [~] **F25 · No attribution for frame-time spikes** — *the scene half is
      done; the spike half is not*
      `/bench` now separates **JS** (time inside the scene's own per-frame
      callback) from **CPU** (whole-frame wall clock). That is the attribution
      that matters most often, and its absence produced a confidently wrong
      diagnosis — see F87. `useSceneFrame` accumulates it and the profiler is
      off outside `/bench`, because a profiler that always runs is one nobody
      trusts.
      Still missing: attribution for a spike *during a show*, where the question
      is "what was on screen when that 60 ms frame happened". The pieces exist
      (`frameLoad` knows the composition, `transitionMetrics` knows the fades) —
      nothing correlates them with the sampler's tail.

      Original entry:
      There is still no way to tell whether a heavy scene is steadily expensive or
      whether the red is transitions. Keep the worst ~20 frames of the window, each
      tagged with tier, DPR, primary + layer scene ids, and flags for
      commit / crossfade / compile / layer-mount / DPR-change; show in the analytics
      panel and make it copyable. **Phase 3.**

- [ ] **F26 · No GPU timing, and no headroom signal at all** — *not started*
      `delta * 1000` is wall-clock between rAF callbacks. Until the budget is blown
      it reads exactly one refresh interval whether the GPU was at 10% or 95%, so
      the only signal available today is a binary "already too late".
      `EXT_disjoint_timer_query_webgl2` gives real GPU ms. **Phase 3.**

- [x] **F27 · `performanceCost` was assigned by eye** — *measured and retagged*
      `/bench` run on 2026-08-22. **10 of 16 tags were wrong, in both directions.**
      Retagged from tier-1 GPU means (thresholds documented on
      `ScenePerformanceCost` in `src/scenes/index.ts`):
      | scene | measured | was | now |
      |---|---|---|---|
      | network | 6.26 ms | low | **high** |
      | heap | 5.24 ms | low | **high** |
      | juliawings | 4.69 ms | high | high |
      | kaleido | 3.15 ms | low | medium |
      | inversion | 3.06 ms | high | medium |
      | synthgrid | 2.22 ms | high | medium |
      | ribbons | 2.14 ms | low | medium |
      | torusfold | 1.99 ms | high | medium |
      `network` mattered most: it is a LAYER, so its cost lands on top of a primary,
      and the budget believed `foldpath + network` cost 5 of 6 units when it really
      cost ~22 ms of a 16.7 ms frame.
      `plasma` / `dissolve` / `pointcloud` were NOT retagged — the first run caught
      their worker-built geometry partly unfilled (see F33). Re-run and re-tag.
      Side effect: the admission tests in `layerComposition.test.ts` were coupled to
      real scene costs and broke on the retag. Now built on synthetic scene defs, so
      they test the logic rather than the current art direction.

---

## The three reported look/feel problems

- [x] **Issue 1 · Overlaying more than two scenes looks tacky**
      Measured: 57% of 40k simulated compositions filled both accent and overlay —
      three scenes on screen, four mid-crossfade, all additive at gain 1.0.
      Two fixes, deliberately kept as separate rules:
      - `MAX_LAYERS_BY_PRIMARY_COST` in `PerformanceDirector.tsx` — 1 layer over a
        `high`-cost primary, 2 otherwise. The cost budget stays the GPU guard; this is
        the art-direction guard. Background is exempt (it is ground, not a stack
        layer).
      - `defaultLayerFx` in `store.ts` — accent 1.0 → **0.55**, overlay 1.0 → **0.40**,
        a descending ladder rather than three independent numbers. Persist bumped to
        v2 with a migration that rewrites a stored `1.0` (nobody chose it) but leaves
        any other value alone (somebody did).

- [~] **Issue 2 · RAM / frame cost too high** — *all six CPU/GPU causes fixed;
      one memory cause remains*
      Done: F04 (governor blind to variance), F05 (invisible offscreen passes),
      F06 (fog recompile), F09 (`preserveDrawingBuffer`), F10 (tactical overlay),
      F10b (BPM readout), F11 (GC pressure from rolling windows).
      Still open: the render targets in Trail/SynthGrid/KernelPanic are sized in CSS
      pixels and so cannot be shrunk by the quality tier — KernelPanic holds ~100 MB
      at 1080p, Trail ~33 MB. That is what **F16**'s budget ledger was built for.
      Also still open: **F12** (analytics sampled while closed) and **F14** (ribbons'
      CPU waveform loop running while invisible).

- [~] **Issue 3 · Ribbons too aggressive and overused** — *mitigated, not solved*
      Measured: ribbons appeared in 38.1% of compositions, the highest in the roster,
      *after* its moodFit was already cut from 0.97 to 0.68. The weights were never
      the constraint — **the pool is**. Only four scenes declare a layer role and two
      of them are primaries doing double duty, so for several primaries the accent
      pool is literally `{network, ribbons}`.
      Done: **(b)** layer dwell floor (F08), **(c)** `visCeiling` 1.2 → 1.0 in
      `FlowRibbonScene` plus the new 0.55/0.40 slot gains.
      **Not done — and this is the actual fix: (a) author 3–4 genuine layer-only
      scenes** so the pool is 7–8 wide. Everything above is mitigation until then.
      Note this pulls against Issue 1's cap on frame cost, so it lands after the
      remaining perf work.
      **Update 2026-08-27.** Two of the three mitigations this entry lists as
      missing are no longer the binding constraint. The measured cost table
      (F91) shows nine scenes under 1.1 ms, so the budget no longer refuses
      cheap layers the way the label ladder did — and `orbs` at 0.06 ms now
      carries three roles. The remaining fix is unchanged and is still (a):
      authored layer-only scenes. Most of the roster is documented as correctly
      primary-only with stated reasons (`wireframe` and `kaleido` would fight
      the subject; `trail` pays for a render-target pair), so widening the pool
      by re-declaring roles is largely exhausted.

---

## Image feedback, the post-chain budget, and the fullscreen crash (2026-08-25)

Found while porting lilim's feedback pass and chasing a report of the app
hanging. Measurements below were taken under **SwiftShader (software GL)** in a
headless browser unless stated otherwise — treat them as *ratios between
configurations*, never as anyone's real frame rate.

- [x] **F46 · `performanceState.fog` was inert on 15 of the 16 scenes** —
      *fixed 2026-08-27 by moving atmosphere into the post chain*
      `src/engine/GradePass.ts`, `src/engine/EffectsDirector.tsx`
      Option (b) from the analysis below, for the reason it gives: per-material
      fog can never reach a fullscreen quad, and sixteen hand-written copies of
      the same term is sixteen chances to drift.
      It is **veiling glare, not distance fog**, because distance is not
      available — the quad scenes write no usable depth. Veiling is what
      atmosphere looks like anyway (light scattered out of the subject into the
      air in front of it), and unlike a depth ramp it acts on a black field,
      which is what this roster mostly is. Two terms: blacks lift in proportion
      to how much light is actually in the frame, and contrast collapses toward
      that same scattered level. `uLuma` is the exposure servo's own whole-frame
      mean, already measured every 0.18 s for another purpose, so this costs a
      uniform rather than a pass. The haze takes the palette's `bg` slot,
      because scattered light is the colour of what it scatters through.
      **Measured on `wireframe`** — the scene `scene.fog` reached nothing on —
      edge luminance 8.4 → 26.8 → 74.6 across the dial, centre only 122 → 168.
      That ratio is the point: the subject stays clearly readable above the
      haze. The first calibration lifted the edge to 119 of 255, which is
      erasure rather than atmosphere, and the director genuinely reaches fog 1.0
      on a sparse ambient passage, so both constants were halved.
      The zero-density `FogExp2` stays attached and is simply never written now:
      detaching it would change three's program cache key and recompile every
      material in the scene, and a future scene wanting real depth fog will find
      it already there.

      Original diagnosis:
      `src/engine/EffectsDirector.tsx`, every scene file
      The plumbing is correct end to end: the `FogExp2` instance is attached to the
      scene for the whole session (`sceneFogAttached: true` when probed live) and
      `fog.current.density` tracks `performanceState.fog` exactly. What does not
      happen is any of it reaching a pixel, because **three only applies `scene.fog`
      to materials that opt in, and no scene opts in.** `ShaderMaterial.fog` defaults
      to `false` (three's own source, `ShaderMaterial.js:167`), `LineMaterial`
      extends `ShaderMaterial` and inherits that default despite compiling the fog
      chunks in, and `grep -rn "fog: true"` across `src/scenes/` returns nothing.
      The only fog-capable material in the roster is `ChromeFormScene`'s
      `MeshPhysicalMaterial`, where `Material.fog` defaults to `true`.
      So a director moving `fog` is steering something that answers on exactly one
      scene — the honest half of the Scene Contract's own rule that a dial which is
      visible but dead is worse than no dial.
      **Fix is a design decision, not a one-liner.** Either (a) set `fog: true` on
      the materials that can support it and accept that fullscreen-quad scenes still
      cannot participate, or (b) drop `scene.fog` entirely and make atmosphere a
      post-chain effect (a depth-driven or purely radial haze), which would reach
      every scene uniformly and is the only option that makes the dial honest across
      the roster. Do not "fix" this by wiring fog into each shader by hand — that is
      sixteen copies of the same term with sixteen chances to drift.

- [x] **F47 · Vignette reads as inert on most scenes** — *A/B finished
      2026-08-27; the suspicion was right, and the dial gained a second term*
      `src/engine/GradePass.ts`
      The A/B the entry below asks for, run on the output window's real pixels
      (sampled in-frame, since a canvas without `preserveDrawingBuffer` only
      holds pixels inside the frame that drew it):

        kaleido  (fills the frame)   edge/centre  0.85 → 0.31   at vignette 0 → 1
        wireframe (subject on black) edge/centre  0.041 → 0.004

      **The vignette was never broken.** On a scene that fills the frame it
      darkens the periphery 2.7x relative to the centre, exactly as intended. On
      `wireframe` the edge sits at 4% of centre BEFORE it touches anything, and
      multiplying black by a smaller number is still black. The exposure
      discipline that makes this show look the way it does is precisely what
      leaves a vignette nothing to act on.
      So the dial keeps the vignette and gains a term that works on a black
      field: a small inward scale. Pushing in magnifies the subject, which reads
      as the frame closing whatever is in the corners. Deliberately **4%** at
      full — anything a viewer can identify as a zoom stops reading as tension
      and starts reading as a camera move, which `CameraDirector` already owns.
      Verified wired by amplifying it 10x, where whole-frame luminance jumps
      23 → 32 and 18 → 48 as magnification pushes the subject across more of the
      frame.

      Original diagnosis:
      `src/engine/EffectsDirector.tsx`
      Confirmed by live probe that the value reaches the shader: with the debug
      override at 0, `performanceState.vignette` is 0 **and** the effect's own
      `darkness` uniform is 0, so nothing is being dropped between the director and
      the GPU. The suspicion is that it is working and simply has nothing to act on.
      postprocessing's DEFAULT vignette technique is
      `color *= smoothstep(0.8, offset*0.799, d*(darkness+offset))` — a *multiply*.
      Most of this roster is a small bright subject centred on true black (which is
      the deliberate exposure discipline in `docs/09_Rendering_Engine.md`), so the
      periphery the vignette darkens is already black and multiplying it changes
      nothing visible. On the subject itself `d` is small enough that the term is
      close to 1.
      **Not confirmed.** The A/B that would settle it — hold a fullscreen scene
      (`network`, `kaleido`) and step `vignette` 0 → 1 — was started and not
      finished. Do that before changing anything. If it is confirmed, the question is
      whether a vignette is the right instrument at all for a black-field show, or
      whether the intent ("the frame tightens through a build") wants a different
      mechanism.

- [ ] **F48 · `EffectsDirector` crashes the whole Canvas if it ever re-renders** —
      *trigger removed, hazard still latent*
      `src/engine/EffectsDirector.tsx`
      `@react-three/postprocessing` memoises each wrapped effect's constructor args
      on `JSON.stringify(props)`. Under **React 19 `ref` is an ordinary prop**, so
      those props include `{ current: <effect instance> }` — and once mounted that
      instance carries R3F's `__r3f` bookkeeping, whose `parent`/`children` form a
      cycle. The stringify throws `Converting circular structure to JSON`, React
      unwinds, the Canvas unmounts, and the app is **black permanently** because
      nothing remounts it. It survives the first render only because the refs are
      still `null` then.
      This shipped as a real user-visible bug: a `size` selector was added to the
      component, so entering fullscreen re-rendered it and blacked out the app. The
      selector is gone and the constraint is now written into the component's header
      as a numbered rule, because it is completely invisible from the code.
      **A comment is not a fix.** The durable options are upgrading
      `@react-three/postprocessing` past the `JSON.stringify` memo key, or wrapping
      that subtree in an error boundary that remounts the composer. Until one of
      those lands, any future `useThree`/`useStore` selector, `useState`, or changing
      prop in that component is a black screen.

- [ ] **F49 · Intermittent `isReady` crash out of three's `compileAsync`** —
      *pre-existing, unattributed*
      `src/engine/streaming/shaderPrewarm.ts`
      `TypeError: Cannot read properties of undefined (reading 'isReady')` thrown from
      `checkMaterialsReady` inside three's `compileAsync` polling loop. Observed
      roughly once in six headless runs, always under heavy load (100 ms+ frames),
      never on an idle page. Almost certainly a race between the prewarm promise and
      a material being disposed by a scene switch that lands mid-poll.
      It reaches `window.onerror` as an unhandled rejection, so it is a pageerror
      even when the show survives it. Reproduce by driving scene switches under an
      artificially low frame rate, then either guard the poll or drop `compileAsync`
      on drivers without `KHR_parallel_shader_compile` — where, per this file's own
      header, its resolution is a lie anyway.

- [x] **F50 · The full engine rendered behind the start card** — *fixed and
      measured 2026-08-26*
      `src/engine/Stage.tsx`
      `<Stage/>` was mounted unconditionally, so every director, the scene, and the
      whole post chain ran at full cost while the user was still looking at the
      audio source picker. Bisected: removing only the post chain took that screen
      from 133 ms to **16.7 ms per frame**, so it was ~87% of the cost of a screen
      that is showing a dialog.

      **The gate is `PostChain` in `Stage.tsx`**, which mounts `EffectsDirector`
      and `ExposureSampler` only while `status` is `starting` or `running`.

      Three decisions worth recording:

      1. **The scene keeps rendering.** `.overlay` is a translucent scrim
         (0.25–0.72 black), so the stage behind the card is deliberately visible
         — an idling preview is the product's first impression. Since the post
         chain is 87% of the cost, shedding it alone reaches 60 fps without going
         black.
      2. **`starting`, not just `running`.** Building the composer allocates its
         buffers and compiles the merged effect shader; doing that on the
         transition to `running` would land the stall on the first bar. `starting`
         covers permission, decode and analysis warm-up — long enough to hide the
         build, and a moment where a wait is already expected.
      3. **The governor's idle history is discarded, not carried.** `PerfMonitor`
         fed every picker-screen frame to the quality governor, so a 133 ms idle
         screen walked the tier to survival *before a note played* and the show
         opened already pinned — which is the mechanism behind F84. On the
         transition to live the gate now calls `resetExposure()`,
         `frameSampler.reset()` and `frameSampler.suspend(120)`, the same
         treatment the context-restore path gets, for the same reason: nothing
         measured before describes the frame about to be rendered.

      **Measured** (Playwright + SwiftShader, 1400x900 — software GL, so read the
      idle figure as a ratio and the running figure as a floor):

        start screen   16.7 ms mean / 16.8 p95 / 60 fps   (was 133 ms)
        tier at t=14s on the picker screen   1   (budget 9)
        tier 1.5 s after the show starts     2   (budget 7)

      The show now opens at tier 2 with real headroom instead of pinned at the
      survival tier. Under SwiftShader it still settles to tier 4 during playback
      at ~17 fps, which is the software renderer, not the gate.

- [ ] **F51 · `POST_CHAIN_PIXEL_BUDGET` is another reasoned estimate** — *extends
      F44*
      `src/engine/renderScale.ts`
      The post chain now declares its own pixel budget and joins the reciprocal sum,
      which is what stopped a DPR-2 display from pushing 5.2 MP through an
      eighteen-pass bloom pyramid (measured 512 ms → 167 ms per frame at 2946x1760,
      a 3.31x reduction in fill work that the arithmetic predicts exactly). But
      **2.5 MP is chosen, not measured** — the same gap F44 already records for
      `POST_CHAIN_UNITS` and `GENERATIVE_UNITS`, and `FEEDBACK_UNITS` now joins them.
      Fold this into F44's bench mode: measure an empty scene with and without the
      post chain, at two resolutions, and set the budget from the resolution at which
      the chain actually fits a frame. Until then the number is defensible but
      unproven, and it is now load-bearing for every high-DPI display.

- [x] **F52 · `trails` has no director** — *fixed 2026-08-27,
      `src/engine/opticalDirector.ts`*
      Driven from mood and **flux**, not energy: onset density is what decides
      whether history persistence reads as a trail or as mud, and quiet-but-busy
      is still busy. Highest on sustained ambient material, near zero on a peak —
      a peak wants a clean legible frame, not a blurred one.
      Observed across a 90 s set: 0.068 to 0.275, dropping on `groove` and
      rising on `mellow`, exactly the intended shape.
      The Post FX debug section is now a genuine override rather than the only
      thing that moves this, and stays for that reason.

      Original entry:
      `src/engine/performanceState.ts`, `src/ui/HUD.tsx`,
      `src/engine/PerformanceStateBridge.tsx`
      The feedback pass is fully wired and defaults to `trails: 0`, where it disables
      itself entirely (skipped before the composer's buffer swap, so it costs
      nothing). Nothing decides when it should rise — no mood, no phrase, no tension
      term. The only thing that moves it is the **Post FX (debug)** menu section,
      which overrides five director-owned fields wholesale and is explicitly
      temporary: it is excluded from `partialize` so it never persists, and it should
      be deleted or demoted once a real director drives `trails`.
      Deciding *when* a show should reach for trails is the actual work here, and it
      is the same shape as every other `performanceState` field's history — bloom,
      vignette and fog all shipped as executors before anything had an opinion about
      when to move them.

- [ ] **F53 · ~2.4 s from picking a source to the first frame** — *not investigated*
      Measured repeatedly: the start card takes about 2.4 s to clear after an audio
      file is selected, and that is *after* the post-chain budget fix took it down
      from 6.4 s (the earlier figure was mostly the 2 fps render loop starving the
      main thread). The remainder is audio-pipeline init, and the obvious suspect is
      the **2.5 MB `essentia-wasm` bundle** plus the 488 kB voice worker, both of
      which are fetched and instantiated on the start path.
      Worth confirming with a profile before optimising — it may be instantiation
      rather than transfer, in which case streaming compilation or deferring the
      voice model until first use are different fixes.

---

## Optical racks and the palette contract (2026-08-25)

Found while porting lilim's mirror rack, lens rack and five-slot palettes.
Frame-time figures are **SwiftShader (software GL)** in a headless browser —
ratios between configurations, never anyone's real frame rate.

- [x] **F54 · The lens rack pays one fullscreen blit that never switches off** —
      *fixed — the better answer arrived with the exposure servo*
      `src/engine/LensPass.ts`
      `MirrorPass` and `FeedbackPass` follow the rule the racks were built to:
      always mounted, defaulted to inert, `enabled` as the only branch, zero cost
      at rest. `LensPass` cannot, because it is the LAST pass in the composer and
      `EffectComposer` flags the last-added pass as the one that renders to
      screen. A disabled final pass means nothing writes to the framebuffer and
      the canvas **freezes on the last frame it presented** — not black, not an
      error, just stuck. (Confirmed directly: a cold start with the rack off gave
      28 kB of black PNG; toggling it on gave 97 kB of content; toggling it back
      off left the previous frame frozen at 93 kB.)
      So it stays enabled and degrades to a straight `MeshBasicMaterial` copy
      when inert — one fullscreen blit per frame that did not exist before.
      Cheap next to bloom's mip pyramid, but not free, and it is paid in every
      session including ones that never touch the rack.
      The alternative considered and rejected: moving the pass ahead of the
      merged Bloom/CA/Vignette effect, which costs nothing but stops
      `anamorphic`'s streak gather (threshold `-0.55`) from ever seeing a bloomed
      frame to gather from. A better fix is a cheap always-on final pass that
      earns its keep — the grade/exposure pass lilim has as `finishPass` and this
      chain does not — at which point the lens can go back to a plain `enabled`
      branch like the other two.

      **Fixed exactly that way.** `GradePass` now sits last and is genuinely
      always-on (it applies the exposure servo's gain), so the presentation duty
      belongs to something that earns it and `LensPass` is back to a plain
      `enabled` branch costing nothing at rest. **Net frame cost is unchanged** —
      the blit moved rather than being added.

- [x] **F55 · Both optical racks were invisible to the frame budget** —
      *closed 2026-08-27, immediately before F56 as required*
      `src/engine/frameLoad.ts`
      `mirrorRackMs` and `lensRackMs` price from the racks' live settings, with
      `anamorphic` charged double for the 24 extra taps its streak gather costs.
      Zero at rest is still exact — both racks set their own `enabled` and the
      composer skips a disabled pass — but switched on they are now reserved.
      Observed working: the frame's fixed cost tracked 3.8 ms → 4.6 ms as the
      director engaged `anamorphic`.
      The magnitudes are **estimates**, in the same family as `POST_CHAIN_MS`
      and folded into F90.

      Original entry:
      `src/engine/frameLoad.ts`
      `OPTICAL_RACK_UNITS = 0`, which is honest today and dangerous tomorrow.
      At rest the mirror rack genuinely costs nothing (skipped before the swap)
      and the lens costs one blit; switched on, the mirror is a UV remap plus a
      tap and the lens is three taps, with `anamorphic` adding 24 more for its
      streak gather. None of that is reserved.
      It is defensible only while the sole thing that turns a rack on is a human
      moving a slider — a human can see the frame rate. The moment a director
      does it, `composeLayers` will admit a layer on top of a rack it does not
      know is running, which is precisely the class of bug F43 exists to record.
      Fold into F44's bench task: measure a rack on and off at two resolutions,
      set real units, and re-check the ladder.

- [x] **F56 · Neither optical rack has a director** — *fixed 2026-08-27,
      after F55 as the ordering required*
      `src/engine/opticalDirector.ts`
      Choices and magnitudes are separated deliberately. The mirror segment
      count and the lens material are **choices** — 4 and 6 segments have
      nothing meaningful between them, and a material is the look of the frame
      rather than an amount of it — so they are re-taken only at a section
      boundary and then held. The lens amount is a magnitude and eases.
      Seeded from a section counter rather than `Math.random()`, so a set is
      deterministic and a recording reproduces.
      The mirror is peak-or-high-tension only and then roughly one eligible
      section in three, because a kaleidoscope during a verse reads as an effect
      that got stuck on. It deliberately never fired in the 90 s observation run
      — the track never reached peak — which is the restraint working, and it is
      pinned by unit test rather than by that run.
      **One correction found by watching it.** Driving the lens amount straight
      from tension gave a measured peak of 0.045 across the set: a lens nobody
      can see attached to a cost everybody pays. An effect that is always
      slightly on is the worst of both. Engagement became a per-section choice
      with a visible floor, which measured 0.21 with materials cycling and whole
      sections sitting it out.

      Original entry:
      Both default to inert and are moved only by the **Post FX (debug)** panel.
      Nothing decides when a show should reach for a kaleidoscope or a lens
      material, which is the actual creative work and is the same shape as
      `trails` in F52 — and as bloom/vignette/fog before them, which all shipped
      as executors first.
      Note the ordering dependency: F55 has to land **before** this one, not
      after.

- [ ] **F57 · Five of the seven lens materials are unverified by eye** —
      *shipped on weaker evidence than the other two*
      All seven compile and run: every material was driven through the debug
      panel with no shader-compile error and no page error, which rules out the
      failure that actually breaks a port. But only `glitch` (slice tears, block
      dropouts, scanline shading all clearly present) and `glass ribs` (visible
      flute refraction) were confirmed by looking at the result.
      `glass fan`, `anamorphic`, `melt`, `pixels` and `fly eye` were captured but
      not inspected — and `melt` is the one to check first, because its
      kick-spawned plume ring is the only material with state that a
      compile-clean run would not exercise. Look at all five against real music
      before treating the rack as done.

- [ ] **F58 · No scene reads the new `shadow` or `bg` slots** — *contract
      exists, benefit not yet realised*
      `src/engine/palettes.ts`, every scene file
      The five-slot palette is in and every palette declares all five, but the
      roster still reads only the three lit slots through the deprecated
      `col.a/b/c` aliases. `shadow` and `bg` — the two a scene previously had to
      invent, and therefore the two that actually collide across authors — are
      available and unused.
      So the coherence claim ("a mixed-authorship set stops being a colour
      collision") is **currently unproven in this codebase**: nothing yet
      demonstrates it. Migrating the existing roster is per-scene art direction
      and is deliberately not done, since these scenes are slated for
      replacement — but the replacements should be authored against
      `mid`/`accent`/`glow`/`shadow`/`bg` from the start, and the aliases should
      be removed once nothing reads them.

- [ ] **F59 · Twenty-four of the thirty palettes cannot be reached by
      automation** — *real gap, introduced by the port*
      `src/engine/AutoPilot.tsx`, `src/engine/keyPalette.ts`
      `MOOD_PALETTES` and `FAMILY_BY_MAJOR_TONIC` both name palette ids as
      strings, and between them they name exactly the six `signature` palettes.
      The twenty-four ported ones are therefore **manual-selection only**: no
      mood, no key, and no autopilot rotation can ever choose one.
      That makes the roster look four times richer than the autonomous show
      actually is, which is the wrong way round for a product whose pitch is that
      it performs unattended.
      The fix is not simply pasting more ids into two tables — the `family` field
      now exists precisely so those tables can select a *family* and let a varied
      pick choose within it, the same shape `pickVariedScene` already uses for
      scenes. Doing it that way also makes the key-driven selection meaningful
      again, since `keyPalette`'s whole design is about collapsing keys onto
      families.

- [ ] **F60 · The `Palette` shape change is breaking for third-party callers** —
      *known, accepted, undocumented*
      `src/engine/palettes.ts`
      `Palette.colors` and `Palette.bg` are gone, replaced by `Palette.slots`.
      `registerPalette` is public API documented in README.md / ARCHITECTURE.md,
      so any out-of-tree caller breaks at compile time (which is the good
      failure). The in-repo consumers were all updated.
      Nothing has been written down for the people this affects: README and
      ARCHITECTURE still describe the old three-colour shape. Update both, and
      state the slot contract there rather than only in the source — it is the
      thing a scene author most needs to read before writing anything.

- [ ] **F61 · `paletteFromImage` not ported** — *available, not taken*
      lilim extracts a five-slot palette from an image: quantise to a 48x48
      grid, bucket by 4-bit-per-channel key, take the 40 most common, greedily
      pick 5 mutually distant colours, sort by luminance into `bg`→`glow`, then
      force `bg` near-black and lift `glow` toward white.
      It ports directly onto `PaletteSlots` now that the slot shape matches, and
      it is the cheapest route to "the show matches the artwork" — but it needs a
      home in the UI and a decision about whether an extracted palette is
      session-scoped or persisted alongside the built-ins, so it was not done
      blind.

---

## Transitions (2026-08-25)

Opened by a report that transitions feel jerky and sudden. Five distinct
causes; two fixed here, one is the likely dominant one and is still open.

- [x] **F62 · The crossfade curve was linear, with no ease at either end** —
      `src/engine/SceneManager.tsx`
      `fade.value += delta / duration` went straight to `out.value` and to a
      scene's `vis`. A linear alpha ramp changes at the same rate at its start,
      middle and end, which is what reads as mechanical — and it is frame-rate
      independent, so it looked abrupt at any fps.
      The raw `fade.value` is still a linear clock, because the lifecycle reads
      it (prune at <= 0, complete at >= 1, `sampleTransitionFrame` measures
      against it); only the value scenes and the compositor see is eased.
      Safe for the additive majority for a specific reason: smoothstep is
      symmetric, `S(1-t) === 1 - S(t)`, so out and in still sum to exactly 1 at
      every point of the fade. Total light is unchanged; only its distribution
      across the two pictures is eased. An equal-power curve — correct for audio
      and for opaque blends — would have overshot here. 17 of 18 scenes are
      additive; `chrome` is the lone exception.

- [x] **F63 · `approach()` snapped outright at low frame rates** —
      `src/engine/performanceState.ts`, `src/engine/palettes.ts`,
      `src/engine/SceneManager.tsx`
      It was `current + (target - current) * Math.min(1, delta * rate)` while its
      own doc comment claimed to be frame-rate independent. Once
      `delta * rate >= 1` the clamp fires and the value jumps to the target: at
      rate 7 (the transition discount) any frame under 7fps, at 2.5 (palette
      blending) under 2.5fps, at 3 (camera distance) under 3fps. So the easing
      that exists to hide a change stopped easing exactly when the frame rate
      made it most visible, and the camera teleported. It was also frame-rate
      *dependent* above the clamp, so a move tuned on one machine was a
      different move on another.
      Now `1 - exp(-delta * rate)`: identical for small `delta * rate` so every
      existing rate stays tuned, asymptotic so it can never snap. Applied to the
      shared helper (17 call sites, including the whole camera system), to
      `PaletteBlender.update`, and to the transition discount ease.
      This is the same correction `TrailLineScene`'s header already spelled out
      for its own decay — the lesson had never reached the shared helper.

- [x] **F64 · Every transition becomes a hard cut once the tier drops** —
      *fixed: the budget now shortens the fade instead of deleting it*
      `src/engine/SceneManager.tsx`
      `hardCut = immediate || !fundsOverlap`. When the frame budget cannot fund
      two primaries the crossfade is replaced by an instantaneous cut — so
      transitions turn sudden exactly when the machine is already struggling. A
      performance mechanism is producing an editorial result.
      **Observed, not theorised.** Instrumenting the live transition state under
      a software renderer (~6fps, governor pinned near the survival tier) showed
      a real scene change (`wireframe` -> `ribbons`) completing with the primary
      count never exceeding 1 and `transition.active` never once true: the fade
      was skipped entirely, every time. At `TIER_BUDGET[4] = 5` against fixed
      costs of 4 (post chain 2 + feedback 1 + generative 1), there is
      essentially never room for a second primary, so `fundsOverlap` fails
      always.
      Consequence for the work above: F62 and F63 are correct and unit-tested,
      but their on-screen effect **cannot be observed on a machine in this state**,
      because no crossfade ever runs. Anyone verifying transition feel must
      first confirm the tier is not pinned low.
      **Fixed by separating the two conditions that were conflated.**
      `hardCut = immediate || !fundsOverlap` let a performance constraint decide
      the edit. A drop cutting is an editorial decision and stays; an
      unaffordable overlap is a cost problem, and the answer to a cost problem is
      to spend less, not to change the edit.
      The budget path now shortens the fade to `CONSTRAINED_FADE_SEC` (0.2 s)
      rather than removing it — the guard's real concern is how LONG the frame
      carries two subjects, and a cut takes that to zero where this takes it to
      ~12 frames at 60fps, already covered by the two-tier complexity discount
      that runs during any overlap. A deliberate, bounded overcommit in exchange
      for never snapping.
      The duration is committed once at commit time and carried on
      `performanceState.transition.durationSec`, so a fade cannot change speed
      while the viewer is watching it, and layers keep the musical ~two beats —
      a constrained subject swap is no reason for a background to arrive faster
      than the music. `targetDurationSec` in the telemetry records the committed
      duration rather than the musical ideal, or the panel would flag every
      constrained fade as a failure (the same mistake as F39).
      Verified under load: three forced scene changes each ran a real crossfade
      at `style=dissolve, duration=0.2s` with progress advancing 0.25 -> 0.6 ->
      0.8. Before the fix the same test showed `transition.active` never once
      true.

- [x] **F65 · Transition styles are debug-only and undriven** — *already done
      when the transition vocabulary landed; confirmed 2026-08-27*
      `pickTransitionStyle` is wired in `PerformanceStateBridge`, re-picked on a
      mood change or inside the section window rather than every frame, and
      `smear` was observed running three times in a twelve-change set. The entry
      below predates that work.

      Original entry:
      `src/engine/transitions.ts`
      Six styles exist (`cut`, `dissolve`, `dipToBlack`, `smear`, `melt`,
      `collapse`) and three of them drive the racks rather than the mix, so they
      cost nothing beyond passes that already run. Nothing chooses between them:
      `performanceState.transitionStyle` is set only by the Post FX debug panel
      and defaults to `dissolve`.
      Choosing a transition per musical moment — a cut on a drop, a dip at a
      section boundary, a smear through a breakdown — is the actual creative
      work, and it is what stops a long set feeling flat. Blocked behind F64 for
      the reason given there.

- [ ] **F66 · Nothing verifies transition feel at a real frame rate** —
      *tooling gap*
      Everything in this section was reasoned from the maths and confirmed by
      unit test; the one attempt to watch a real transition end to end failed
      because of F64. The headless renderer used for verification runs at
      5-10fps, which independently makes any transition look stepped regardless
      of curve — a 0.9 s fade at 8fps is roughly seven discrete steps.
      Until there is a way to capture a transition at a real frame rate — a
      GPU-backed capture, or a deterministic offline render of the fade — "does
      it feel smooth" cannot be answered in this repo, only "is the curve
      correct".

---

## Adaptive exposure (2026-08-25)

A slow closed loop on the final frame's luminance, ported from lilim. Landed
with `GradePass` (the chain's first real finishing stage) and an async
`createImageBitmap` readback.

- [x] **F67 · Nothing measured the frame the audience actually sees** —
      `src/engine/exposure.ts`, `src/engine/ExposureSampler.tsx`,
      `src/engine/GradePass.ts`
      Additive scenes plus feedback plus bloom drift over tens of seconds, and
      no scene can fix that because none of them can see the composite. There is
      now a servo (tau ~2.3 s, far slower than any musical event, so dynamics
      pass through untouched) with three regimes — washout, hot, muddy — and an
      energy gate so a dark screen over quiet audio is read as the product
      working rather than as a fault.
      Readback is `createImageBitmap`, not `drawImage` off the WebGL canvas:
      lilim measured the synchronous path at **117 ms every eleventh frame** at
      3200x1800, enough on its own to halve a scene's frame rate. A sample
      already in flight is skipped rather than queued, so back-pressure cannot
      build on the frames that are already slow.
      Verified running against a real track: gain rode 1.01 -> 0.68 over 30 s on
      a frame measuring mean 0.09-0.19 against a 0.078 target, monotone and with
      no hunting.

- [x] **F68 · The muddy guard read the wrong statistic and pinned the gain** —
      `src/engine/exposure.ts`
      First implementation gated the muddy regime on the 85th percentile at 0.5,
      reasoned from this project's documented "<=15% lit" budget. Sound
      reasoning, wrong constant: **this roster is far sparser than 15%**, so p85
      measures how much black is in the frame rather than how bright the subject
      is. Measured live, p85 ranged **0.006 to 0.67** purely with scene
      sparsity — on a wireframe it read 0.01, the servo concluded "no
      highlights, must be muddy", and drove the gain to its ceiling on a picture
      that was working as authored.
      p99 measured **0.80 to 0.94** across the same frames, because it tracks the
      subject rather than the subject-to-background ratio. The guard now uses p99
      against 0.7. Both percentiles are still shown in the debug panel; watching
      them diverge is what makes scene sparsity legible.
      Caught only by running the servo and reading its own telemetry, which is
      the calibration docs/09_Rendering_Engine.md says is the only valid kind.

- [ ] **F69 · The exposure targets still need a calibration pass on real
      hardware** — *derived and partly measured; not signed off*
      `TARGET_MEAN` comes straight from the documented budget (20/255).
      `TARGET_HIGHLIGHT`, `BLOWN_TOLERANCE`, `GAIN_MIN`/`GAIN_MAX` and the step
      are reasoned, and only `TARGET_HIGHLIGHT` has been checked against
      measurements — taken under a software renderer at ~6fps, on two scenes,
      on one track.
      What is untested: how the loop behaves across the whole roster, over a
      full track with real dynamics, and on a GPU.
      The frame-counted sample interval noted here originally — which made the
      real time constant scale with frame rate, ~2.3 s at 60fps but ~23 s at
      6fps — **is fixed**: the interval is now wall-clock
      (`SAMPLE_INTERVAL_SEC = 0.18`, which is what 11 frames came to at 60fps),
      so the documented constant is true at any frame rate.

- [ ] **F70 · The filmic grade is now unblocked but not attempted** —
      *deliberate*
      `src/engine/GradePass.ts`
      docs/09_Rendering_Engine.md records the grade being built and reverted
      twice, and names the real blocker: the scenes render hot, so any tone
      mapper parks the image on its rolloff knee and flattens it. The servo is
      the mechanism that addresses that blocker — it brings the level down from
      measurement rather than from hoping every scene behaves — and `GradePass`
      is where a curve would go (after the multiply, last in the pipeline, which
      that document is explicit about).
      Not attempted here because the same document is equally explicit that
      exposure constants are only valid when calibrated against a real playing
      track, and F69 is that calibration. Do F69 first; a curve fitted on top of
      unverified exposure is the third revert.
      One trap already recorded and worth repeating: `BrightnessContrast.brightness`
      is an ADDITIVE offset, not exposure. A negative value drives black negative
      and AgX returns it as lifted mid-grey. Exposure is a multiply.

- [x] **F71 · Two debug-panel rows were drawing on top of each other** —
      `src/ui/DebugPanel.tsx`
      The render-scale readout added with the pixel-budget work took y=48, which
      the mood row — drawn later, by a separate block in the same file — already
      used. The later draw simply painted over the earlier one, which looks like
      a missing readout rather than a collision, and it went unnoticed because
      the two blocks are ~40 lines apart.
      Rows are now on an explicit 12px grid documented at the `H` constant, and
      every y is unique.

---

## Exposure readback cost, and transition telemetry (2026-08-25)

- [x] **F72 · The exposure sampler cost 60% of the frame rate** —
      `src/engine/ExposureSampler.tsx`
      Reported as "the transitions have slowed down by a lot", and it was not the
      transitions — everything had slowed, so a fade that already had few frames
      to work with had far fewer.
      Measured by A/B on the same build: **128 ms/frame with the sampler, 80 ms
      without** — 7.8fps against 12.5fps, a 48 ms average cost per frame.
      The cause was mine and the header's own claim was wrong.
      `createImageBitmap(canvas)` was called on the FULL canvas and the downscale
      to 24x16 then happened on the CPU in `drawImage`. The expensive part was
      never the downscale: it was copying an entire framebuffer out of the GPU,
      several times a second. "Asynchronous" only meant the JS thread was not
      blocked; the work was still done and still had to be paid for.
      Fixed by resizing DURING snapshot —
      `createImageBitmap(canvas, { resizeWidth, resizeHeight, resizeQuality })` —
      so 384 pixels cross the boundary instead of the whole frame. Re-measured at
      **78.8 ms against 80.0 ms with the sampler removed entirely**: free within
      noise.
      Lesson worth keeping: an async API that returns a promise is not
      automatically cheap. It moves *when* the cost lands, not *whether*.

- [x] **F73 · Transition records did not say which style ran** —
      `src/engine/transitionMetrics.ts`, `src/ui/AnalyticsPanel.tsx`
      `TransitionRecord` captured from/to, downbeat, hard-cut, waited, target vs
      actual duration and frame time during the fade — but not the style. With
      six styles now, and three of them switching on a post-chain rack for the
      duration (`smear` -> feedback, `melt` -> lens, `collapse` -> mirror), a
      frame-time spike in the history was unattributable and "which of the six is
      expensive" could not be answered from the data at all.
      The record now carries `style`, and the panel prints it in place of the
      old fixed `fade` label. A `cut` in that column is also now distinguishable
      as a style the director chose versus one the budget guard imposed, which
      `hardCut` alone could not express.

- [ ] **F74 · No style has been measured against the others** — *the point of
      F73, not yet acted on*
      The telemetry to answer this now exists, and nothing has been recorded with
      it. Expected shape, worth confirming rather than assuming: `cut` and
      `dissolve` free, `dipToBlack` free, `smear` the cost of the feedback pass
      for the fade's duration, `melt` the cost of the lens rack's most expensive
      material, `collapse` the mirror rack plus a tiling multiply.
      `collapse` is the one to watch — it drives `mirrorTiles`, and tiling
      re-samples the frame per cell.
      **Unblocked by F64 and F83** — styled transitions now run and a director
      chooses them, so the comparison is finally possible. Note that under a
      constrained budget the rack styles are deliberately downgraded to
      `dissolve`, so measuring them needs a machine that can fund an overlap. Note the constrained fade is
      0.2 s, so a rack style has less time to show itself than at full length;
      measure both constrained and unconstrained.

---

- [x] **F75 · The exposure servo applied a permanent darkness effect** —
      `src/engine/exposure.ts`
      Two compounding bugs, both mine, both in the first implementation.

      **It aimed at an art-direction budget instead of a fault threshold.** The
      servo targeted this project's documented "mean luma < 20 of 255" (0.078)
      and treated 1.4x of it as hot. But the composited frame **measures
      0.09-0.19 in normal operation**, so it sat above the hot threshold nearly
      always and corrected content that was working — pulling the whole show
      down by roughly half. A budget is a goal for scene authors; a servo
      threshold has to describe a FAULT. An auto-exposure that enforces an
      aspiration is just a dimmer.

      **The dead zone ratcheted.** Zero error meant the gain stayed wherever it
      had been left, so there was no restoring force: every hot passage dragged
      it down and nothing ever brought it back. That is the "permanent" part —
      one bright moment darkened the rest of the session, and it accumulated
      across a set.

      Fixed on both counts. `HOT_MEAN = 0.30` and `MUDDY_MEAN = 0.02` are placed
      in the gap between measured normal operation (0.09-0.19) and a real
      washout (docs/09_Rendering_Engine.md records one at mean 0.65), so ordinary
      content falls in a wide dead zone and the servo does nothing at all. And
      zero error now eases the gain back toward unity at a quarter of the
      correction rate, so a sustained fault still wins while a brief one is
      forgiven over a few seconds rather than forever.
      Verified live: gain held at exactly 1.00 across a full run on real content
      (mean 0.026-0.059, blown 0-1.3%). Regression tests pin both halves —
      the seven measured normal means all produce zero error, and a corrected
      gain returns to unity once the fault clears.

---

## Scene modes (2026-08-25)

- [x] **F76 · Modes existed but no director could select one** —
      `src/scenes/index.ts`, `src/engine/AutoPilot.tsx`, `src/store.ts`
      Scene Contract v1 already shipped a complete mode primitive: declared
      `modes`, `useSceneMode`, `resolveSceneMode`, per-mode `paramLabels`
      (including `null` for a parameter that is inert in that mode), and a
      mode-scoped `summarizeContract` explicitly built for marketplace listings.
      **`setSceneMode` had exactly one caller: a click handler in the HUD.**
      So a scene with three authored looks showed one of them for the entire
      life of an autonomous show, and the other two existed only for someone who
      opened the menu and found them.
      Same shape as F59 for palettes — a capability the roster declares that the
      autonomy cannot reach. `AutoPilot` now picks a mode alongside the scene,
      deterministically from its own rotation counter (a recorded set has to
      replay identically), never returning the mode already showing. `auto: true`
      keeps it out of the manual-backoff path, as automatic palette changes
      already are.
      One edge worth keeping: `pickVariedMode` deliberately does NOT go through
      `getSceneContract`, which falls back to `SCENES[0]` for an unknown id. That
      fallback is right for rendering — a stale persisted id must still draw
      something — and wrong for a selector, which would otherwise answer with a
      mode belonging to a different scene and store it against the bogus id. A
      selector should decline where a renderer degrades.

- [ ] **F77 · Modes cannot widen the LAYER pool, because roles are per-scene** —
      *the premise that does not hold; needs a decision*
      `src/scenes/index.ts`
      Modes were proposed as a cheaper fix for the four-scene layer pool than
      authoring new scenes. They are a cheaper unit of authorship and they do
      widen variety — but not in the layer slots, and the reason is structural:
      **`roles` is declared on `SceneMetadata`, not per mode.** A mode of a
      primary-only scene is still primary-only, so adding five modes to
      `synthgrid` adds five looks to the PRIMARY pool and zero layer candidates.
      Measured on the current roster: 16 primary-capable scenes, **4
      layer-capable** (`plasma`, `ribbons`, `network`, `orbs`), and **0
      background-capable** — which is F18 restated from the data.
      Two ways forward, and they are genuinely different products:
      (a) **Per-mode roles.** One scene contributes to both pools — `synthgrid`
      as a horizon is a primary, as a bare grid is an overlay. This is what makes
      modes a layer-pool fix, and it is a contract change: `roles`, and probably
      `performanceCost` and `pixelBudget` with it, become per-mode. It also
      sharpens the marketplace story, since one submission could list under both.
      (b) **Just declare layer roles on more existing scenes.** Far cheaper, no
      new mechanism, and it is the actual F19 fix — but it does nothing for
      authorship economics.
      Not chosen unilaterally: (a) is a real extension to a contract that
      external scenes will be written against.

- [ ] **F78 · Only one scene of eighteen declares modes** — *content work,
      unblocked by F76*
      `wireframe` has three (`crystal`, `shard`, `cage`); every other scene has
      none, so the roster is 18 scenes and 20 looks. Now that a director can
      select them, adding modes is the cheapest variety available.
      The candidates named as carrying four or five each are `SynthGridScene`
      (588 lines) and `KernelPanicScene` (296 plus 683 lines of GLSL).
      **Implement them as a uniform branch, not a `#define`.** Both compile every
      branch into one program, so switching costs no recompile — which is the
      constraint this codebase treats as paramount (`EffectsDirector`'s header,
      F48). A `#define` would be a smaller shader and a recompile per switch,
      which is the wrong trade here. Note `wireframe` is not that pattern: it
      rebuilds geometry in a `useMemo` on mode change, which is bounded but is a
      real rebuild, and is why the mode is picked BEFORE the scene is requested
      rather than after it commits.

---

- [x] **F79 · The whole show rendered ~5x too dark: no output colour-space
      conversion** — `src/engine/GradePass.ts`
      Reported as "it's still dark always", after the servo's own gain had
      already been fixed to hold at 1.00 — so the darkness was not the servo.
      The composer works in **linear**; the display is **sRGB**; the last pass in
      the chain owns that conversion. postprocessing's own shaders all end with
      `#include <colorspace_fragment>`, so for as long as its merged `EffectPass`
      was last, it did the conversion on everyone's behalf. **Every pass this
      project wrote omits that line**, which was harmless until one of ours took
      the final position — first `LensPass` during the optical-rack work, then
      `GradePass`. At that moment the conversion silently disappeared and linear
      values went straight to an sRGB framebuffer.
      Measured: canvas mean **0.024-0.063 before, 0.158-0.394 after** the include
      was added — about 5x, exactly what the missing transform predicts (a linear
      0.05 should display near 0.24).
      Nothing in any individual file looked wrong, which is why this survived
      several passes of review: the bug lived in which file happened to be last.
      **The rule, now written into GradePass's header: whatever is final in the
      chain owns the output conversion.** That is the second duty the final
      position carries, alongside never being skipped (F54).

- [x] **F80 · The exposure constants were calibrated through the broken
      pipeline** — `src/engine/exposure.ts`
      Direct consequence of F79, and worth its own entry because the failure mode
      is general. `HOT_MEAN` and `BLOWN_TOLERANCE` had been derived from live
      telemetry — the right method — but every one of those samples came through
      a pipeline rendering 5x too dark, so the constants were wrong in the same
      direction as the bug that produced them.
      Re-measured after the fix, across 89 samples: mean **0.07-0.46**
      (median 0.19), blown **0-13.8%** (median **2.6%**).
      Both constants were badly placed against that: `HOT_MEAN = 0.30` sat
      *inside* the normal range, and `BLOWN_TOLERANCE = 0.02` was **below the
      median blown share**, so the harshest regime in the servo would have fired
      on more than half of all healthy frames.
      Now `HOT_MEAN = 0.55` (above the observed max of 0.459, below the recorded
      washout at 0.65) and `BLOWN_TOLERANCE = 0.20` (above the observed max of
      0.138, below the recorded washout's 0.39). Verified live: gain holds at
      exactly 1.00 across a full run.
      Lesson recorded in the source: the discipline is not "measure" but "a
      measurement is only as good as the pipeline it was taken through" — a
      constant derived from instrumentation must be re-derived whenever that
      pipeline changes. Notably, lilim's looser 0.30 blown tolerance was closer
      to correct than the budget-derived 0.02, for the same reason its mean
      target was: it had been measured rather than aspired to.

- [ ] **F81 · Three other passes omit the colour-space conversion** — *latent,
      correct today by position only*
      `MirrorPass`, `FeedbackPass` and `LensPass` are all ShaderMaterials with no
      `colorspace_fragment` include. That is correct while they render to
      intermediate linear buffers and something else is last — but it means the
      chain is only correct because of the current ORDER, and reordering it (or
      disabling `GradePass`) reintroduces F79 silently.
      Options: give every pass the include and make it conditional on
      `renderToScreen`, or add a test/assert that the final pass is one that
      converts. The second is cheaper and catches the real mistake, which is a
      reorder rather than a missing line.

---

- [x] **F82 · `cut` disabled as a selectable style** — `src/engine/transitions.ts`,
      `src/ui/HUD.tsx`
      Reported as too jarring. Disabled as a **choice**, not as a fallback:
      `SceneManager` still forces a cut when the frame budget cannot fund two
      primaries and on a drop, and those paths assign the style directly rather
      than going through `resolveTransitionStyle`, so they are unaffected.
      Kept in `TRANSITION_STYLES` rather than deleted — the value is stored in
      cues and recorded in transition telemetry, so removing the name would
      orphan saved shows and make old records unreadable. `resolveTransitionStyle`
      now maps it to `dissolve`, which is what makes the disable real for a cue
      saved while it was still available rather than only hiding it from the
      picker. The chip is shown struck-through and inert, with a tooltip saying
      it is still used automatically — a control that silently vanishes reads as
      a bug.
      **This will not, on its own, stop hard cuts appearing.** See F64.

- [x] **F83 · Nothing selects a transition style — there is no algorithm** —
      *fixed: there is one now*
      Asked directly: which algorithm decides the transition? There is none.
      `performanceState.transitionStyle` defaults to `dissolve` and its only
      writer is the Post FX debug panel. No mood, no section, no phrase, no
      tension term feeds it, so an autonomous show uses `dissolve` for every
      change it is allowed to make.
      Compounding that, F64 means the style is overridden entirely whenever the
      budget cannot fund an overlap — which under load is every transition. So
      the observed behaviour is "everything is a cut, and none of the other
      styles ever appear", from two independent causes:
        1. nothing ever *chooses* anything but `dissolve` (this entry), and
        2. what is chosen is then *overridden* to `cut` (F64).
      **Both causes are now fixed.** F64 stopped the override; this entry adds
      the choice.
      `pickTransitionStyle` lives in transitions.ts as a pure function and is
      called from `PerformanceStateBridge` (the decide band). Per-mood preference
      LISTS rather than one style each — a fixed mapping means every breakdown
      gets the same transition, which is the flatness the vocabulary exists to
      remove — with rotation and no-repeat, deterministic so a recorded set
      replays. `smear` for the quiet moods (a trail reads as drifting rather than
      being replaced), `collapse` for a build (geometric, reads as pressure),
      `melt` at the top end (woozy, where a fold would be noise on noise),
      `dissolve` neutral and the only thing `silence` ever does. Disabled styles
      are filtered out, so a disable reaches the autonomy and not just the picker.

      Two things found by running it rather than reasoning about it:

      **The section override latched.** `dipToBlack` marks a section boundary,
      but a boundary is a single-frame edge while the scene change it should
      punctuate commits on the next downbeat. Setting the style on the edge meant
      it never cleared: five consecutive changes all ran `dipToBlack` from one
      boundary long past. It is now a bounded WINDOW
      (`SECTION_DIP_WINDOW_SEC`, ~2 s, about a bar at 120bpm), and the style is
      re-picked when the window closes as well as when it opens.

      **A rack style is downgraded when the budget is constrained.** A rack style
      switches on an extra fullscreen pass for the fade's length, and the worst
      moment to add one is a machine that already could not fund the overlap —
      where the fade is 0.2 s anyway, too brief for a smear to read as anything
      but a flicker. `SceneManager` falls back to `dissolve` in that case.
      Verified live: the director chose `smear` and `dipToBlack` across six
      forced changes, `dipToBlack` ran as chosen, and `smear` was correctly
      downgraded to `dissolve` under load.

---

## The rack transition styles never appear (2026-08-26)

- [x] **F84 · `smear`, `melt` and `collapse` never ran in practice** — *fixed
      2026-08-26 by repricing the budget in milliseconds; see the section below*
      `src/engine/SceneManager.tsx`, `src/engine/slotBudget.ts`
      The director now picks them (F83) and the fade now runs (F64), but the
      three rack styles are downgraded to `dissolve` whenever the frame budget
      could not fund a two-primary overlap. That downgrade is deliberate and
      right in isolation — a rack style switches on an extra fullscreen pass for
      the fade's duration, and the worst moment to add one is a machine that
      already said it could not afford the overlap. The problem is how often the
      condition fires.

      **The arithmetic, which is the actual finding.**
      `canFundOverlap` asks `outgoing + incoming + layers + fixed <= budget`.
      Fixed costs were `POST_CHAIN(2) + FEEDBACK(1) + GENERATIVE(1, on by
      default) = 4`. So per tier, with no layers:

        tier 0  budget 11  ->  outgoing + incoming <= 7
        tier 1  budget  9  ->  <= 5
        tier 2  budget  7  ->  <= 3
        tier 3  budget  6  ->  <= 2
        tier 4  budget  5  ->  <= 1

      **VERIFIED FIXED 2026-08-26.** `smear` now runs. Twelve forced scene
      changes driven through the real app (Playwright + SwiftShader, 1280x800,
      tier 3 falling to 4 — i.e. the worst case this issue is about):

        dissolve 4 · dipToBlack 5 · **smear 3**
        5 of 12 fades ran at full duration; before, every one was constrained.

      The three `smear` fades ran at 0.87-1.10 s, not the 0.2 s constrained
      fade, so the rack pass was genuinely funded rather than downgraded. Note
      which ones: `smear` was picked when the destination was cheap (`wireframe`
      0.16 ms, `torusfold` 0.11, `plasma` 1.01) and the fade was constrained
      when it was expensive (`ribbons` 13.1, `foldpath` 14.1, `chrome` 9.25,
      `network` 22.4). That is the budget discriminating per scene instead of
      globally, which is exactly the behaviour the old currency could not
      express.

      `melt` and `collapse` did not appear in this run. That is now a question
      about **selection frequency**, not about funding — `smear` proves the rack
      path is affordable, and all three are gated by the same `usesRack` /
      `canFundOverlap` branch. Tracked separately if it persists.

      **Update 2026-08-26 — two of those four units are now gone.** F85 made the
      feedback reservation conditional (0 while trails are at rest, the common
      case) and F02's removal deleted `GENERATIVE_UNITS` outright, so a quiet
      frame's fixed cost is `POST_CHAIN(2)` alone. The same table becomes:

        tier 0  budget 11  ->  outgoing + incoming <= 9
        tier 1  budget  9  ->  <= 7
        tier 2  budget  7  ->  <= 5
        tier 3  budget  6  ->  <= 4
        tier 4  budget  5  ->  <= 3

      Two `medium` scenes cost 4, so an overlap is now fundable from tier 3 up
      rather than tier 1 up, and even tier 4 can carry a `low` + `medium` pair.
      That should make the three rack styles reachable on most machines. **Not
      yet verified in a foregrounded browser** — the observation that opened this
      issue was six forced changes with every one constrained, and that
      measurement has not been repeated. Leaving it open until it has been.

      Two primaries cost at least 1 + 1 = 2, so **at tier 4 an overlap is
      arithmetically impossible even for the two cheapest scenes in the roster**,
      and at tier 3 only a `low` + `low` pair fits. Most of the roster is `medium`
      (2) or `high` (4): two mediums need a budget of 8, i.e. tier 1 or better.
      Observed directly — six forced scene changes, every one constrained, every
      rack style downgraded.

      **Partly improved by F85**, which freed one of those four fixed units when
      the feedback pass is bypassed: the survival tier now allows
      `outgoing + incoming <= 2` instead of `<= 1`, so a `low` + `low` overlap is
      possible. Re-tested afterwards and the rack styles were still downgraded —
      correctly, because the scenes involved were `medium`/`high` (2 + 2 = 4),
      still over the ceiling. The fix is real and insufficient on its own.

      So this is not really a transition bug. It is the frame budget being pinned
      low, and the transition vocabulary is just the first feature to visibly
      depend on having headroom. Anything else gated on `canFundOverlap` is
      equally dark. Fixing it means one of: raising real frame rate so the
      governor stops pinning the tier, reducing the fixed reservations (see F85),
      or making the downgrade finer-grained than all-or-nothing — for instance
      allowing `smear` specifically, since the feedback pass is already mounted
      and its cost is two fullscreen draws rather than a new program.

- [x] **F85 · `FEEDBACK_UNITS` is reserved even while the pass is bypassed** —
      *fixed*
      `src/engine/frameLoad.ts`, `src/engine/SceneManager.tsx`
      `FeedbackPass` sets `enabled = false` whenever `trails` is 0 — which is the
      default and the overwhelmingly common case — and `EffectComposer` skips a
      disabled pass entirely, so it costs nothing. But the fixed-cost sum adds
      `FEEDBACK_UNITS` unconditionally: `POST_CHAIN + FEEDBACK + (generative ?
      ...)`.
      At tier 4 that is **1 of only 5 budget units reserved for work that is not
      happening** — 20% of the frame's entire capacity — and it is exactly the
      unit that decides whether `outgoing + incoming <= 1` or `<= 2`, i.e.
      whether any overlap at all is possible.
      This contradicts the reasoning already written into `OPTICAL_RACK_UNITS`,
      which is 0 precisely because those racks bypass themselves at rest. The
      same argument applies here and I did not apply it.
      Fixed with `feedbackUnitsFor(trails)`, which shares one predicate —
      `isFeedbackActive` — with the pass itself, so the budget and the pass can
      no longer disagree about whether it is running. That disagreement was the
      entire bug.
      Measured live: fixed costs dropped **4 -> 3** and the room for two
      primaries doubled **1 -> 2** at the survival tier, which makes a `low` +
      `low` overlap possible where it had been arithmetically impossible.
      The ordering subtlety is documented at the call site rather than left to be
      discovered: the reservation is computed in `SceneManager` at priority -100
      and `trails` is written by the bridge at -95, so the value read is one frame
      stale. Acceptable for a reservation — the pass cannot switch on and cost a
      full unit within one frame of the director deciding to use it.

---

## The budget spent an invented currency (2026-08-26)

The `/bench` sweep was finally run across all 16 registered scenes x 5 tiers.
It did not refine the cost model; it retired it.

- [x] **F91 · Scene cost was a label, and the label was unrelated to cost** —
      *fixed; the budget is now denominated in milliseconds*
      `src/engine/sceneCost.ts` (new), `src/engine/slotBudget.ts`,
      `src/engine/frameLoad.ts`, `src/engine/quality.ts`
      `slotCost()` priced every scene from a hand-written `performanceCost`
      label through `{ low: 1, medium: 2, high: 4 }`, and `TIER_BUDGET` handed
      out `[11, 9, 7, 6, 5]` of those units. Nothing in that chain had been
      weighed. What the sweep found:

      | scene | declared | measured (tier 0) | charged | should have been |
      |---|---|---|---|---|
      | `synthgrid` | medium | **22.4 ms** | 2 units | the dearest thing on the roster |
      | `network` | high | 22.4 ms | 4 units | ✓ |
      | `ribbons` | medium | 13.1 ms (CPU-bound) | 2 units | refused as a layer |
      | `pointcloud` | high | **0.12 ms** | 4 units | nearly free |
      | `orbs` | low | 0.06 ms | 1 unit | ✓ |

      The roster's second-cheapest scene was charged **twice** what its most
      expensive one was. Inside the single `medium` label the spread is 0.03 ms
      to 22.4 ms — a factor of 650. No budget can mean anything on top of that.

      Fixed by making the currency milliseconds and the prices measurements:
      `TIER_BUDGET_MS = [11, 9.5, 8.5, 7.5, 6.5]` now reads as "of a 16.67 ms
      frame, the composition may claim 11", which is a claim that can be
      checked. `layerBudget` → `frameBudgetMs`, `slotCost` → `slotCostMs`,
      `committedUnits` → `committedMs`, `POST_CHAIN_UNITS` → `POST_CHAIN_MS`:
      renamed rather than reinterpreted, because a field named `units` holding
      milliseconds is precisely how the next bug gets written.

      Two judgements inside the table, both recorded at its definition:
      **GPU cost is monotonised** (the raw sweep is not monotone — `juliawings`
      measured 12.5 / 5.5 / 7.4 / 8.7 / 7.8 across the ladder — and a budget
      where dropping a tier can make a scene dearer would have "shed load"
      sometimes adding load), and **CPU cost is one constant per scene** rather
      than per tier, because the evidence says the ladder does not control it
      (see F86).

- [x] **F92 · The tier ladder charged for the same reduction twice** —
      *fixed with F91; this is what actually unblocked F84*
      `src/engine/slotBudget.ts`
      Dropping a tier made every scene genuinely cheaper (pixel scale 1.0 →
      0.23, raymarch steps 96 → 28) **and** shrank the wallet those cheaper
      scenes had to fit inside (11 → 5), while their prices stayed flat. One
      piece of evidence, two punishments. At tier 4 that left 1 unit for scenes
      after fixed costs, so two primaries could not overlap at any price and
      three of the six transition styles were unreachable (F84).

      Prices are per-tier measurements now, so the first reduction is already in
      the price. The ladder still tapers — 1.7x rather than 2.2x — but for a
      stated and different reason: `sceneCost.ts` is one machine's table, and
      the tier is the only evidence available about how far from that machine
      the current one is. The taper is a margin against that unknown.

      Measured effect: at **every** tier, at least half the roster can now
      crossfade with itself, versus effectively none at tier 4 before. Pinned by
      a test rather than a comment (`slotBudget.test.ts`).

- [ ] **F86 · `chrome` gets ~5x MORE expensive as quality drops** — *scene bug,
      exposed by the sweep*
      `src/scenes/ChromeFormScene.tsx`
      CPU mean per frame, tiers 0→4: **21.3 / 19.9 / 16.7 / 27.8 / 43.6 ms**,
      with p95 reaching 72 ms. GPU is a flat 0.06 ms throughout, so this is
      entirely CPU and entirely backwards — the governor's response to a slow
      frame is to drop a tier, which on this scene makes it worse.

      Non-monotone in the middle too (fine at tier 2, bad on both sides), which
      smells like a per-mount rebuild — a PMREM/envMap prefilter, or geometry
      regenerated from a knob — rather than a smooth cost curve. Until it is
      found, `sceneCost.ts` charges chrome a flat 9.25 ms at every tier, which
      is honest but blunt: it refuses chrome as a layer everywhere.
      **Same caveat as F87**: that CPU figure is whole-frame wall clock and
      cannot on its own show the cost is on the main thread. `/bench` now has a
      JS column; re-run it before hunting. `chrome` is also one of the three
      scenes F34's camera fix changes, so its numbers move for that reason too.

- [~] **F87 · `ribbons` shows a 68 ms frame at tier 0** — *my diagnosis was
      wrong; the instrument to settle it now exists*
      `src/scenes/FlowRibbonScene.tsx`
      CPU mean tiers 0→4: 68.4 / 27.1 / 16.7 / 19.9 / 16.7 ms, against 0.03 ms
      of GPU.

      **"All of this is JS" was not supportable and is not true.** `/bench`'s CPU
      column is `delta * 1000` — the whole frame's wall clock, including the
      vsync wait and back-pressure from a GPU still finishing the previous frame.
      It cannot distinguish scene JavaScript from anything else. And `ribbons`
      builds its geometry once in a `useMemo` (22 ribbons x 90 segments x 2 =
      3,960 vertices, ~7,700 triangles) and its per-frame loop runs about 1,300
      iterations. Whatever costs 68 ms there, it is not that.
      The more likely candidate on the evidence available: `DoubleSide` +
      `AdditiveBlending` overdraw, which is fill the GPU timer may be
      under-reporting.

      The instrument now separates them — `/bench` has a **JS** column
      (time inside the scene's own callback) beside the CPU one, so a re-run
      answers this outright. High CPU with low JS is a scene waiting on the GPU;
      high CPU with high JS is a scene doing too much on the main thread.
      **Re-run `/bench` and read the JS column for `ribbons` and `chrome`.**
      F14 (the decimation running while invisible) was in this file and is
      fixed regardless, since it was wrong on its own terms.

- [ ] **F88 · The cost table is one machine's measurements** — *known
      limitation, stated at the definition*
      `src/engine/sceneCost.ts`
      Every number came off one GPU. A device three times slower carries three
      times these costs while the table reads identically, so the budget would
      overcommit it by 3x. The tier is the runtime adaptation — a slow machine
      sits lower and is priced from the lower row — and `TIER_BUDGET_MS` keeps a
      taper specifically as margin against this, but neither is calibration.
      The real fix is a short startup probe (render a known scene, compare
      against its table entry, scale the whole table by the ratio) or shipping
      per-GPU-class tables. Until then the model is right and the constants are
      local.

- [ ] **F89 · `roleScalable` is declared by exactly zero scenes** —
      *the discount has never once been applied*
      `src/scenes/index.ts`, `src/engine/slotBudget.ts`
      `slotCostMs` discounts a scene outside the primary slot only if it
      declared `roleScalable`, meaning it actually reads `ctx.role` and reduces
      its own shader work. Grepping all 16 registered scenes: **not one does.**
      It is an optional field on the type and nothing else, so every layer is
      charged full primary price in every slot.
      Two ways out, and the choice is real: implement it in the scenes that are
      plausibly layerable (a background at 0.6x its work is a genuine saving on
      the six expensive scenes), or delete the parameter and stop implying a
      discount that cannot happen. Do not leave it as decoration.

- [ ] **F90 · The post chain and the feedback pass are the last invented
      numbers** — *supersedes the F43/F44/F51 estimate notes*
      `src/engine/frameLoad.ts`
      `POST_CHAIN_MS = 2` and `FEEDBACK_MS = 1` are the only costs in the budget
      that have not been measured, and the post chain is the one cost present in
      **every single frame**. `/bench` deliberately excludes it so scene costs
      compare cleanly, which is why the most universal cost is the least known
      one.
      Sanity check says 2 ms is not absurd — `plasma` renders a full particle
      field for 0.87 ms on the bench GPU, so 2 ms buys roughly two
      fullscreen-equivalents for a nine-level mip pyramid plus two cheap passes
      — but "not absurd" is not "measured". Extend `BenchStage` with a cell that
      runs an empty scene with and without `EffectsDirector`; the difference is
      the number. Same run can price the mirror and lens racks, which are
      currently reserved at zero (`OPTICAL_RACK_MS`) on the grounds that nothing
      autonomous switches them on — true today, and a trap the moment a director
      does.

---

- [ ] **F93 · `compileAsync` can throw from a timer, where the try/catch cannot
      reach it** — *observed once during F84 verification; not investigated*
      `src/engine/streaming/shaderPrewarm.ts`
      One `pageerror` during twelve rapid forced scene changes:
      `Cannot read properties of undefined (reading 'isReady')`.

      `prewarmShaders` wraps `await gl.compileAsync(...)` in a try/catch, and
      that catch is why the error reached the page rather than the fallback:
      three polls `program.isReady()` from an internal timer callback, not from
      the awaited chain, so a throw inside the poll escapes the promise
      entirely. The catch cannot see it. If the warming scene is disposed while
      its poll is still in flight — which rapid switching on a slow renderer
      makes likely — the program is gone and the poll dereferences undefined.

      **Whether this predates the budget rework is not established.** It was
      seen under conditions the app does not normally produce (twelve switches
      in ~55 s under SwiftShader), and nothing in that change touches the
      prewarm path, but that is reasoning rather than evidence. Reproduce on the
      pre-change build before assuming either way.
      Likely fix: a `window.onerror`/`unhandledrejection` guard around the warm
      path, or track the in-flight prewarm per entry and abandon it explicitly
      on dispose rather than leaving three's poll pointed at a dead program.

---

## The output projector window (2026-08-26)

> **Superseded the same day.** F94 shipped a projector that ran a SECOND full
> engine, which doubled the cost of the heavy scenes (F97). It was replaced by
> the two-window split in the next section: the output window is now the only
> renderer and the control window holds no engine at all. F95, F96 and F97 died
> with that design and are struck through below.

- [x] **F94 · No chrome-free output surface for OBS or a second screen** —
      *shipped 2026-08-26, replaced by F98 the same day*
      `src/engine/projector.ts` (new), `src/routes/Visualizer.tsx`,
      `src/engine/Stage.tsx`, `src/engine/SceneManager.tsx`, `src/ui/HUD.tsx`
      Ported from lilim's `?output` tab. `O` opens a second window at
      `?output`; it renders the same show with no HUD, no start card, no
      keyboard map, a pointer that hides after 2 s and a first click that goes
      fullscreen. State crosses on a `BroadcastChannel`.

      **Verified with two live windows** (Playwright, one browser context so the
      channel connects). After opening the projector mid-track and then cycling
      the palette on the leader:

        LEADER    scene wireframe · palette ember · bloom 1.631 · bpm 129 · beat 32
        PROJECTOR scene wireframe · palette ember · bloom 1.631 · bpm 129 · beat 32
        HUD nodes: leader 2, projector 0 · page errors: 0
        projector screenshot 206 KB (drawing, not blank)

      Three design decisions worth keeping in view:

      1. **Roles are asymmetric.** A follower never publishes and a leader never
         applies, so the echo problem cannot arise at all — no origin tags, no
         loop suppression. lilim needs those because every tab there is a peer.
      2. **The scene lifecycle stays local.** `scene`, `activeScene`, `layers`
         and `transition` are NOT on the wire; the follower's own SceneManager
         computes them from the same `sceneId` and the same beat grid. Sending
         them would mean one window driving another's mount lifecycle, warm
         gates and fade clocks across a channel with no ordering guarantee
         against the frames interleaved with it.
      3. **The join handshake is not optional.** The look publishes on CHANGE,
         so a projector opened mid-set would otherwise sit on boot defaults
         forever — lilim's own log records exactly that. The follower asks at
         module load, before React mounts, and the leader answers a snapshot
         addressed to that joiner.

- [x] ~~**F95 · Two control windows on one machine is ambiguous** — *known, and
      narrowed rather than solved*~~  *(design retired with F94; see F98)*
      `src/engine/projector.ts`
      Any window without `?output` is a leader. Open the app twice and both
      publish frames and both answer a join, so a projector would take whichever
      message arrived last — a 60 Hz flicker between two shows.
      Narrowed by gating both publishing and the join answer on
      `status === 'running'`, which covers the realistic case (a second tab
      sitting on the start card cannot stamp its defaults over a live set). It
      does not cover two tabs actually playing.
      Proper fix: a leader election on the channel — announce on join, lowest id
      wins, demote the rest to followers. Worth doing before this is a feature
      anyone relies on in front of an audience.

- [x] ~~**F96 · A projector's clock jumps when its leader dies** — *edge case,
      one frame*~~  *(design retired with F94; see F98)*
      `src/engine/projector.ts`, `src/audio/AudioEngine.ts`
      While frames arrive, `features.time` is the leader's `AudioContext` clock.
      After `STALE_MS` the follower falls back to `audioEngine.update()`, whose
      no-context branch sets `time` from `performance.now() / 1000`. Those are
      different epochs, so `time` jumps on the changeover.
      `delta` is clamped to 0.1 s so nothing integrating it will explode, but a
      scene using `time` directly as an absolute phase will visibly skip once.
      Only reachable when a leader stops publishing, which is already a degraded
      state — but the fix is small: hold an offset at the moment of changeover
      and keep the clock continuous.

- [x] ~~**F97 · The projector is a second full render of the same show** —
      *by design, and the cost should be stated somewhere a user can see it*~~  *(design retired with F94; see F98)*
      Two windows means two WebGL contexts, two scene instances, two post
      chains. On the bench GPU most of the roster is under 0.2 ms so this is
      free, but `synthgrid` at 22 ms or `network` at 22 ms is being paid TWICE
      when a projector is open, and each window runs its own quality governor
      with no knowledge of the other.
      A mirror (leader renders once, projector blits the pixels) would avoid it
      but needs a transferable stream — `captureStream` into a `MediaStream`
      handed over, or an `OffscreenCanvas` — and loses the ability for the
      projector to run at its own resolution. Measure the two-window cost on the
      heavy scenes before deciding; today the governor's response would be to
      quietly drop BOTH windows a tier, which is the correct behaviour but not
      an obvious one.

---

## Two windows, one render (2026-08-26)

- [x] **F98 · The console/output split** — *shipped and verified 2026-08-26*
      `src/engine/outputLink.ts` (new), `src/ui/Console.tsx` (new),
      `src/styles/console.css` (new), `src/routes/Visualizer.tsx`,
      `src/store.ts`, `src/audio/AudioEngine.ts`, `src/engine/Stage.tsx`
      The output window **is the app**: it owns the audio device, runs every
      director, mounts the scenes and draws the frame. The control window runs
      no engine at all — it is a console plus a `<video>` of the output
      window's own canvas.

      **The constraint that forced the shape** was "the main processing should
      only happen once". F94's projector rendered the show twice, once per
      window, doubling exactly the scenes that can least afford it
      (`synthgrid` and `network` are ~22 ms each). Here the mirror is a
      `captureStream()` off the canvas that already drew the frame, so the
      operator's preview costs a frame copy rather than a frame.

      **Three transport primitives were probed before any of it was written**,
      because the whole design rests on them:

        MediaStream + File by direct reference into an opened window  live, intact
        captureStream from window B  ->  <video> in window A          readyState 4,
                                                                      frames advancing
        ImageBitmap over BroadcastChannel (unused fallback)           works

      Live objects go by direct reference because neither a `MediaStream` nor an
      open `File` handle survives a structured clone — this is not the faster
      path, it is the only one. State goes over `BroadcastChannel`: the look
      downward, a telemetry packet upward at 10 Hz.

      **Audio is acquired in the control window and analysed in the output
      window.** `getDisplayMedia` and `getUserMedia` need transient user
      activation and a freshly opened window has none, so the control window
      prompts inside the click that also opens the output window, then hands
      the live stream across (`acquireSource` is now public on AudioEngine for
      exactly this).

      **Verified with two live windows:**

        control canvases          0     (the show renders once, elsewhere)
        output canvases           1
        output chrome nodes       0
        mirror                    1280x720, readyState 4, t 8.45 -> 19.05
        scene press               wireframe -> plasma in the output window
        palette press             Ember on both
        readouts                  BPM 120->130, mood silence->mellow, tier, ms, scene

      Two bugs found and fixed during that verification:

      1. **`captureStream(0)` never emits a frame.** 0 does not mean "on every
         canvas change" — it means frames are produced only when something calls
         `track.requestFrame()`. The mirror arrived with `readyState` 4 and
         `currentTime` pinned at 0 forever. Omitting the argument is what gives
         a frame per canvas update.
      2. **A scene press changed nothing.** `requestScene` sets
         `pendingSceneId`, and only `sceneId` was on the wire — so the request
         never left the control window and the output sat on `wireframe` through
         every press. The two windows own different halves of a scene change:
         the control window owns the REQUEST, the output window owns the
         COMMITMENT (it alone knows when the incoming scene has warmed and where
         the next downbeat is), so `pendingSceneId` now travels down and the
         committed `sceneId` travels back up on telemetry.

- [~] **F99 · Most of the old HUD has not been ported to the console** —
      *narrowed 2026-08-26: post FX and screenshot are in*
      `src/ui/HUD.tsx`, `src/ui/Console.tsx`
      The console covers what a set needs: source/transport, recording,
      screenshot, the scene grid, all 30 palettes as real five-slot swatches,
      intensity/speed/reactivity, quality, layer slots, autopilot, mood drive,
      and now the **whole post chain** — bloom, threshold, glitch, vignette,
      fog, trails, the five mirror-rack controls, lens amount and material, and
      the next transition style.

      **All three diagnostic panels are now on the console too** — audio debug,
      fps meter, analytics — behind buttons in the bottom-left tool row. They
      are the ORIGINAL components, unmodified: the output window ships the
      singletons they read and the control window mirrors them into its own idle
      copies, so `DebugPanel` still reads `audioEngine.features` and `FpsMeter`
      still reads `frameLoad` exactly as before.

      That packet is an order of magnitude heavier than the base telemetry (a
      512-bin spectrum and two 1024-sample waveforms), so it is **sent only
      while a panel is open**. Verified: with every panel closed the control
      window's `features` are empty and stay frozen; opening one fills them with
      live values; closing them all freezes them again.

      Frame times ride the packet RAW rather than as `perf.ms`, which is
      smoothed — a p95 computed over means understates the tail precisely where
      the analytics panel exists to show it.

      **Still not ported:** presets (built-in + saved, favourites, import and
      export), the cue timeline, MIDI learn and MIDI sync, and per-layer FX
      (gain/blend). `HUD.tsx` still exists and still works — it is simply not
      mounted, so nothing is lost and the port can continue against a reference.

- [x] **F101 · The diagnostic panels overlaid the console columns** — *fixed
      2026-08-27 by docking them*
      `src/styles/console.css`, `src/ui/Console.tsx`
      All three panels were authored for the full-screen HUD, where the only
      thing under them was the canvas, and all three anchor to `top: 84px` on
      the same two corners. On the console they landed on top of each other and
      on top of the transport.
      They are now docked inline in the header, in the gap between the BPM
      readout and the mood pill — the one piece of horizontal space nothing else
      wants. Three things had to be got right for that to work:
        - `.console-top` is `align-items: start`, not `stretch`. A 370px-tall
          dock stretched the mirror cell to match until it filled half the
          screen.
        - The middle column is `minmax(0, 1fr)` and `.readouts` gets
          `min-width: 0`. A grid item defaults to `min-width: auto`, which
          refuses to shrink below its content, so a wide dock pushed the Post FX
          column off the right edge of the window.
        - The panels stack in a scrolling COLUMN, not a row. Side by side they
          want ~850px, more than the gap has, so the third was clipped
          horizontally while still reserving its 352px of height — an empty band
          under the two that fit.

- [x] **F102 · "output down" while displaying that output's own telemetry** —
      *found from a user screenshot, reproduced, fixed 2026-08-27*
      `src/engine/outputLink.ts`
      The console reported `output down` in the same breath as it displayed the
      output window's tier, frame time and current scene, offered "Open output
      window" for a window that was already open, and — the damaging part —
      refused to hand over an acquired audio source, stopping the stream with
      "No output window".

      `outputIsOpen()` read `!!outputWindow && !outputWindow.closed`, and
      `outputWindow` is module state. **Any reload of the control window loses
      it** — every HMR update in dev, any refresh in production — while the
      output window carries on rendering and publishing perfectly happily.
      `handSource()` used the same dead handle.

      Fixed in two parts. Presence now comes from telemetry: a packet inside
      `TELEMETRY_STALE_MS` is proof the window is alive, and the handle is only
      a secondary signal for the moment before its first frame. And the handle
      is recovered rather than mourned — `window.open('', 'audiovis-output')`
      returns an existing named window without navigating it, guarded on
      telemetry because with no such window that same call would create a blank
      popup.

      Reproduced exactly (open output, reload the console, hand over a file):
      before, `output down` and a dead hand-off; after, `output live`, no
      spurious open button, and the output window running the track
      (`contextState: running`, energy 0.62).

- [x] **F104 · Every capture start was cancelled by the output window's own
      telemetry** — *the real cause of "it is not picking up audio at all";
      found, bisected and fixed 2026-08-27*
      `src/store.ts`, `src/engine/outputLink.ts`

      The sequence, which is worth reading slowly because every step looks
      reasonable on its own:

        1. The console sets `status: 'starting'` and calls `getDisplayMedia`.
           The share picker opens and the operator sits in it for seconds.
        2. The output window — idle, nothing handed to it yet — publishes
           telemetry every 100 ms saying `status: 'idle'`.
        3. `adoptOutputStatus` wrote that over the console's `'starting'`.
        4. The picker resolved. `startAudio`'s cancellation guard asked
           `status !== 'starting'`, read `'idle'`, concluded the operator had
           backed out, **stopped the tracks and returned silently.**

      No error, no status change, the console back on its source buttons, and an
      output window that was never handed anything. Exactly "not picking up the
      audio at all".

      **The file path never hit it**, because nothing is awaited between
      claiming `starting` and handing over — which is why every test written for
      this feature passed while the path a person actually uses was broken.

      Two fixes, and the bisect separates what each one does:

      - **The cancellation guard now uses a local token**, not `status`. A guard
        built on a field another window writes is not a guard. This is the fix
        that actually rescues the hand-off.
      - **Telemetry no longer overwrites `status` while a hand-off is in
        flight** (`shouldAdoptStatus`, unit-tested). This is the fix that stops
        the console flipping back to its source buttons mid-prompt. The
        exemption ends the moment the output reports `hasSource`, so evidence
        always beats the timer.

      Bisected to prove it rather than assert it: with the adoption guard
      disabled, the console's status is observably stomped to `idle` at t+1s
      through t+4s of a 4 s prompt — which is the branch the old code cancelled
      on. Restored, it holds `starting` throughout and reaches `running`, with
      the output window on a live graph (`contextState: running`, `running:
      true`).

      Also fixed alongside: `openOutput()` no longer steals focus on the start
      path. The very next thing after it is a capture prompt owned by the
      control window, and pulling focus away from that window first is asking
      for trouble.

- [~] **F103 · A silent output window could not say why** — *diagnosed and made
      legible; F104 turned out to be the actual cause of the report*
      `src/audio/AudioEngine.ts`, `src/engine/outputLink.ts`,
      `src/routes/Visualizer.tsx`, `src/ui/Console.tsx`
      Reported as "I share screen and audio, it says output down, and after I
      fullscreen it still is not displaying — debug and analytics show it is not
      picking up audio."

      F102 covers the `output down` half and the failed hand-off it caused. The
      silence half has a second candidate that the two-window split introduced
      and nothing was reporting: **the output window is opened
      programmatically, so it may never have received a user gesture, and an
      AudioContext created there starts `suspended`.** That reads as perfect
      silence with no error anywhere — a flat 120 BPM and empty meters, which is
      exactly what the screenshot showed.
      `connectStream` already installs a resume-on-gesture listener, but only
      once a graph exists; there was nothing covering the window before that.

      Now: `audioEngine.resumeContext()` fires on every pointer-down in the
      output window (the same handler that requests fullscreen), and telemetry
      carries `audioState` and `hasSource` so the console can tell the two
      silences apart — "click the output window to start audio" versus "output
      has no audio source". They need different things from the operator, and
      showing neither was the actual defect.

      **Not confirmed**: a real screen-share cannot be driven from the test
      harness, so the system-audio path specifically has not been reproduced
      end to end. What is verified is the file path through the same hand-off,
      and that the console now names the failure instead of showing a plausible
      idle state.

- [x] **F100 · Two control windows fought, and the transport acted on the wrong
      engine** — *both fixed and verified 2026-08-26*
      `src/engine/outputLink.ts`, `src/ui/Console.tsx`, `src/store.ts`

      **The transport was pressing buttons in the wrong window.** `Stop`,
      `Record` and `cancel` called the control window's own store, whose
      `AudioContext` is idle, whose `MediaRecorder` does not exist and whose
      canvas is empty. Nothing stopped and nothing recorded, while the button
      lit up as though it had. Worse, the control window set its own status to
      `running` the moment it handed the source over — optimism rather than
      knowledge, so a track ending in the output window left the console showing
      a live transport indefinitely.

      Fixed with a command message (`stop`, `cancel-start`, `toggle-record`,
      `screenshot`) going down, and the output window's REAL `status`,
      `sourceType` and `recording` coming back on telemetry, which the control
      window adopts. Hand-off now sets `starting`, not `running`: whether the
      show actually started is a fact only the output window has.
      Verified: output `running` → `idle` on a Stop pressed in the console, and
      the console followed to `idle` and returned to its source buttons.

      **Two consoles both published.** The look wire is broadcast, so the output
      window took whichever message landed last — the show flickering between
      two people's idea of it. Now every console announces itself on the channel
      and the lowest id drives; the rest go passive and say so in a banner. No
      handshake and no leader term: every controller evaluates the same rule
      from the same evidence, and one that closes stops announcing and ages out
      after 2.5 s. The cost of being wrong for one interval is one duplicated
      look message, which is idempotent.
      Verified with two consoles: exactly one stood down, and closing the active
      one promoted the survivor within the TTL.

      One thing NOT verified: whether `screenshot` actually writes a file. The
      command reaches the output window and `saveScreenshot()` runs there, but a
      download initiated from a popup was not confirmed end to end.

---

## Visuals and performance pass (2026-08-27)

Worked through the visual and performance half of the ledger. What landed:
**F14**, **F33**, **F34**, **F46**, **F47**, **F52**, **F55**, **F56**, **F65**,
and **F25** in part. **F87** was corrected rather than fixed — the diagnosis in
it was mine and was not supportable.

Three things are worth carrying forward from it.

**An instrument that cannot distinguish two causes will eventually be read as
whichever one you expected.** `/bench`'s CPU column is whole-frame wall clock;
I read it as scene JavaScript and wrote F87 accordingly, about a scene that
builds its geometry once and loops 1,300 times. The column that settles it now
exists, and both F86 and F87 are one bench run from an answer.

**A dial that is visible but dead is worse than no dial**, and two of them had
been dead for weeks in ways nobody could see from the code: fog reached one
scene of sixteen because `ShaderMaterial.fog` defaults to false, and the
vignette was working perfectly on a periphery that was already black. Both were
found by measuring pixels, not by reading source.

**An effect that is always slightly on is the worst of both.** The lens rack's
first director drove its amount from tension and measured a peak of 0.045
across a 90-second set — invisible, and charged for. Engagement became a
per-section choice with a floor.

### The empty slots, done next (2026-08-27)

**F18** and **F20** are closed and **F19** is narrowed. `orbs` now carries
background and effect alongside accent and overlay — the scene its own comment
had nominated for both, declined on reasons that had expired. "Nothing selects
`background`" was circular; the pool was empty because nobody had gone first.
And the effect slot's one real requirement, that a scene drive itself to visual
zero by `slotProgress` 1, is met by an envelope in the scene.

**The effect slot has now fired for the first time**: two firings in a 120 s
set, 85 s apart, both retiring cleanly.

Watching it run also turned up a defect the ledger had predicted in the
abstract: the same scene held two slots at once (`acc orbs / ov orbs`), because
the pools overlap and nothing deduplicated the picks. `resolveLayerIds` dropped
the later one at mount, so the composition the director chose and the one that
rendered were different — F19's "a layer chosen and immediately dropped".

### Still not started

- **Issue 3 / the rest of F19** — the accent pool is still thin under `plasma`
  and `network`, and the fix is authored layer-only scenes rather than more role
  declarations. Most of the roster is documented as correctly primary-only with
  stated reasons: `wireframe` and `kaleido` would fight the subject, `trail`
  pays for a render-target pair. Re-declaring roles is largely exhausted.
- **F57** — five of the seven lens materials still unverified by eye. They now
  run autonomously (F56), so they will be seen; that is when to judge them.
- **F58 / F59** — no scene reads the `shadow` or `bg` slots, and 24 of 30
  palettes are unreachable by autopilot. The five-slot rewrite is still half
  delivered visually.
- **F78** — one scene of eighteen declares modes.

---

## Automating role assignment for a marketplace (2026-08-27)

**Not an issue — a design decision recorded before it is acted on.** Raised as:
role assignment is manual today, a marketplace with third-party scenes cannot
be, so how does it get automated? Options considered were an AI engine that
reads scene semantics, staying manual until MVP, or driving everything from
DSP.

### The finding

Every manual role call in the roster was decided on **pixels**, not semantics.
The reasons are already written in `src/scenes/index.ts`:

- `orbs` → background: *"nowhere near enough structure to carry a frame as the
  subject, but composites beautifully over one"*, plus cheapest in the roster.
- `kaleido` → primary only: *"a centred mandala owns the middle of the frame by
  construction; composited over another subject the two symmetries fight, and
  behind one it is entirely hidden by its own dark centre."*
- `wireframe` → primary only: *"two subjects fighting for the same frame."*
- `trail` → primary only: it pays for a render-target pair.

Coverage, spatial distribution, occlusion, cost. All four are **measurable from
rendered frames**. None required knowing what the scene means. So the
automation this wants is a *measurement*, not an inference.

### The proposal: extend `/bench` into a scene profiler

Most of it exists. `/bench` already mounts any scene in isolation at any tier
with the right camera and renders it; `ExposureSampler` already reads back a
downsampled frame and computes mean, p85, p99 and blown share; the in-frame
readback technique used for the F47 vignette A/B already samples centre versus
edge. What a role profile adds on top:

- **Fill** — fraction of pixels above a luminance threshold. Separates "subject
  on black" from "wash".
- **Radial distribution** — centre / mid / edge luminance. This is the statistic
  that would have caught `kaleido` on its own.
- **Temporal variance** — does it change per beat or per phrase? Accent
  (punctuating) versus background (sustained).
- **Occlusion** — composite the scene over a known reference field and measure
  how much of the reference survives. "Two subjects fighting" is exactly this,
  quantified, and it is the direct test of *can this be a layer*.
- **Cost** — already measured, per tier, with the JS/GPU split.

Run at submission time, cache in the manifest. One admission step covering
performance, role eligibility and licence rather than three.

### Where AI does belong

Narrowly, and not here. `moodFit` is genuinely semantic and hard to measure
(though even it could be learned from how a scene's output responds to audio
features). Metadata, naming and marketplace copy. Source review for licence
provenance and unsafe shader patterns.

**Not role assignment.** An LLM reading shader source would be guessing at
something measurable — slower, non-deterministic, unauditable, and when a
marketplace scene is mis-roled "the model thought it was a background" is not a
debuggable answer.

### Why DSP is a different axis

"Wire everything to DSP" is already what the directors do — mood, tension,
flux, phrase and section all drive the choices. But DSP answers *when*, and this
problem is *which scene is eligible for what*. Audio analysis cannot tell you
whether a scene occludes what is behind it.

### Sequencing, and why it is not "after MVP"

There are sixteen hand-made role decisions in the roster **with written
reasons** — a labelled validation set with rationales, which is a rare thing to
have. Build the profiler while it still exists and it can be checked against
them: does it independently reach "kaleido is primary-only"? Where it disagrees,
one of the two is wrong and that is cheap to find out. Defer it and the same
thing gets built later against a replaced roster with no ground truth.

  1. Write the role criteria down as a measurable contract. No machinery.
  2. Extend `/bench` with the four statistics plus the occlusion test. Output a
     profile per scene, wired to nothing.
  3. Validate against the sixteen. Tune. This is where the idea is proved or not.
  4. Only then, have `registerScene` derive role eligibility from the profile
     for untrusted scenes.

**A declared role is a claim the profile may VETO, never one it grants.**
Declaration is intent; measurement is a safety check. Same posture
`trusted: false` already takes on cost claims.

### Step 3 result — validated against the sixteen (2026-08-27)

Steps 1 and 2 are done: `docs/10_Scene_Roles.md` is the contract,
`src/bench/sceneProfile.ts` is the implementation, and `/bench?profile` sweeps
tier 0 only so the whole roster can be profiled in one run.

Profiled all sixteen and compared the verdicts to the hand-made role calls.
**13/16 agree.** The profile is a veto, so the disagreements that count are
declared roles it REFUSES — three of them:

  scene        fill   centre   conflict   declared -> refused because
  plasma      0.019     0.89       1.65   accent/overlay/primary -> conflict, and fill
  ribbons     0.000     0.79       1.40   accent/overlay         -> conflict
  trail       0.018     0.39       0.91   primary                -> fill 0.018 < 0.02

It also independently reached several of the calls it was being checked
against: `kaleido` conflicts (0.53) far more than `orbs` (0.42) or `network`
(0.37); `synthgrid` and `juliawings` are refused as layers on fill alone (0.65
and 0.76); `orbs` clears every background threshold, which is the call the
roster's own comment had reasoned to in prose.

**Two real defects, found by running it rather than by thinking about it.**

1. **The profile is measured with no post chain, and it needs one.** `BenchStage`
   deliberately excludes the post chain so scene COSTS compare cleanly — a
   constant added to every scene shrinks the ratios that are the point. But a
   profile is about what a viewer sees, and bloom plus the exposure servo change
   fill and conflict enormously. `ribbons` profiling at `fill 0.000` is not a
   scene with nothing on screen; it is a scene whose output sits below the lit
   threshold until bloom and gain reach it. Cost wants no post chain, profile
   wants one, and the profiler was built on the cost harness. They have to be
   separate passes.

2. **`fill` is thresholded and `conflict` is energy-weighted, so they disagree
   about a dim scene.** `ribbons` reads `fill 0.000` (nothing above threshold)
   and `conflict 1.40` (strongly centred) in the same breath. Both are
   internally correct and together they are incoherent. Either fill becomes an
   energy share, or conflict gains a presence gate, or the field is normalised
   before either is taken.

**Step 4 is deliberately NOT started.** Wiring `registerScene` to a profile that
cannot see the post chain would refuse legitimate scenes for being dim, and the
first thing it would refuse is `ribbons` — a scene that has been a working layer
for the entire life of the project. The thresholds are also not worth tuning yet:
tuning them to reach 16/16 against sixteen points is overfitting, and the two
defects above would still be there underneath.

This is what step 3 was for. The idea holds in shape — the statistics do
separate subjects from layers, and they reached several calls independently —
and it is not yet trustworthy enough to give a veto over anyone's submission.

### The agreed fixes for both defects (2026-08-27, not yet built)

**Defect 1 — a second pass, not a flag.** Cost and profile want opposite things
from the same harness and cannot share a run.

- *Cost pass*: no post chain, exactly as now. A constant added to every scene
  shrinks the ratios that are the entire point of comparing scenes.
- *Profile pass*: post chain mounted, exposure servo settled, palette applied.
  `/bench?profile` is already a separate mode and is the natural home. It needs
  a longer warmup than the cost pass — the servo's time constant is ~2.3 s, and
  profiling before it settles measures the wrong gain.

Accepted consequence, deliberately: the profile then depends on the palette and
on the servo. That is not contamination. A scene that only reads through bloom
is a scene that only reads through bloom, and a role profile should say so.

**Defect 2 — normalise the field before measuring.** Three options were
considered:

  (a) make `fill` energy-based — coherent with `conflict`, but loses the thing
      `fill` is good at, which is a genuinely threshold question: bright subject
      on black versus dim wash.
  (b) gate `conflict` on presence — cheap, but moves the incoherence into a
      discontinuity, and `ribbons` would then have no reading rather than a
      wrong one.
  (c) **chosen** — scale each frame so its 99th-percentile luminance maps to a
      fixed reference, then take both statistics off the normalised field.

(c) makes `fill` mean "how much of the frame is lit relative to this scene's own
brightest content", which is the question that was always intended, while
`conflict` keeps its energy weighting. A dim scene and a bright scene with the
same composition then profile identically — which is correct, because
**brightness is the engine's job** (the exposure servo and the slot gains), not
the scene's. The profile should describe COMPOSITION. Keep raw `meanLuma`
alongside as its own field so absolute brightness is still visible where it
matters.

**Order: (c) first.** It is self-contained, pure, and testable against the same
synthetic fields. It may also absorb part of defect 1 on its own, since
normalising is close to what bloom plus gain does to a dim scene — so re-run the
validation after it and see how much of the post-chain gap is actually left
before building a second bench pass for it.

### Two things genuinely uncertain

- Whether the occlusion test generalises across palettes — a dark palette
  occludes differently from a bright one.
- Whether `effect` can be profiled at all. It is a *contract* (drive yourself to
  visual zero by `slotProgress` 1), not a property, so it probably has to stay
  declared-and-verified rather than inferred.

---

## Verification status

`npm run check` passes: typecheck, lint (0 errors, 0 warnings), **659 tests**, build.

Not yet verified against real music. The eight reference tracks in `testfolder/`
have not been run end-to-end in a foregrounded browser since these changes, and
frame-time p95 per track per tier has not been captured. Per `docs/HANDOFF.md`
§0 that remains the single most valuable thing to do next — none of the
performance fixes above can be called confirmed until it happens.

**The instrument for that now exists:** press `J` for the fps meter (fps, mean
ms, p95 ms, quality tier). Watch the p95 rather than the fps — the fps figure
comes off an EMA and cannot represent a stall, so a stuttering show still reads
as a steady 60. The p95 turns amber at 22 ms (the governor will no longer climb)
and red at 34 ms (it is actively shedding load), so the colour tells you what the
governor is about to do. `D` still opens the full analysis panel, which now
prints the same four numbers; prefer `J` while measuring, since that panel is a
per-frame canvas heavy enough to distort the reading.
