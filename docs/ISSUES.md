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

- [~] **F01 · Absent licence defaults to "shippable"** — `src/scenes/index.ts`
      `nonCommercialSceneIds()` treats a missing `license` field as `original`, so 15
      scenes with no declared provenance pass the commercial filter. The type's own
      doc comment says the opposite: *"anything not marked original or attribution
      should be assumed unshippable."* Invert the default, trace every ported scene to
      its source, and add a build-time gate.
      **Today only 3 scenes are provably safe to sell.**
      Partly done, see F46: every scene traced to its source and correctly marked
      (`original` / `attribution` / `noncommercial` / `unverified`), and everything
      that wasn't provably `original` or `attribution` moved OUT of `SCENES` into
      `DISABLED_SCENES` — so it cannot ship OR run, not merely fail a filter someone
      forgot to call. Still open: the default itself is unchanged (`?? 'original'` in
      `nonCommercialSceneIds()`), so a NEW scene added later with no `license` field
      still passes the filter silently. Inverting that default is a separate,
      deliberately-not-bundled change: it requires every one of the 6 still-live,
      genuinely original scenes to gain an explicit `license: 'original'` field first
      (right now their safety is real but implicit), and it rewrites a test
      (`sceneLicensing.test.ts`) that currently asserts the opposite philosophy on
      purpose. Both are mechanical; neither is done here.

- [x] **F105 · Pre-commercial licence sweep: 12 scenes moved to `DISABLED_SCENES`** —
      `src/scenes/index.ts`. Direct follow-up to F01, run because the product is
      moving toward a commercial launch and every scene of unconfirmed or
      non-commercial provenance needed to be unreachable, not just excluded from
      one filter function.
      Audited every registered scene's own header comment against its declared
      `metadata.license` and found the two had drifted apart for 10 of them —
      the header knew the scene was a Shadertoy port or explicitly NC-licensed,
      but the metadata field was simply absent, which the codebase's OWN
      documented policy (see F01) says should never be trusted as safe.
      Moved out of `SCENES` into `DISABLED_SCENES`, not deleted — files, lazy
      loaders and components all stay live and typecheck/build, so re-enabling
      one later is moving its entry back:
        - **Confirmed non-commercial** (`license: 'noncommercial'`): `network`
          (header states CC BY-NC-SA 3.0 by name), `synthgrid` (same, was
          already marked but still sitting in the live roster), `panic`
          (already disabled for an unrelated reason, now also correctly marked).
        - **Unverified / presumptive non-commercial** (`license: 'unverified'`):
          `inversion`, `foldpath`, `torusfold`, `juliawings`, `orbs`, `kaleido`,
          `trail` — all Shadertoy-derived with no licence attached to the
          source. Shadertoy's own default for an unmarked upload is CC
          BY-NC-SA 3.0, so these are treated as blocked until someone actually
          confirms otherwise with the original author. `tunnel` (already
          disabled) got the same marking for the same reason, independent of
          why it was already out of the roster.
        - **Genuinely licensed, held out anyway** (`license: 'attribution'`):
          `heap` — CC BY 4.0 actually permits commercial use conditioned on
          crediting the author, so this one is NOT in the same bucket as the
          rest. Pulled on request as a product decision pending where that
          credit would live, not because permission is missing.
      `network` added to `KNOWN_NC_SOURCE_IDS` (confirmed-NC tracking,
      independent of roster membership — see that constant's own doc comment).
      **Renumbered from F46 on merge** — that number was already taken on the
      engine side by the `scene.fog` finding, and two entries under one id is a
      ledger nobody can cite from.
      Live roster after the merge is 11 scenes: `wireframe`, `plasma`,
      `dissolve`, `chrome`, `ribbons`, `pointcloud`, `malachite`, `matrix`,
      `kifs`, `maze`, `wingfold` — the branch's own text predated its second
      commit, which added `wingfold` and renamed `ink` to `malachite`. Two pieces of
      fallout fixed alongside: `ink`/`matrix` had `compatibleWith` entries
      referencing now-disabled ids (`registry.test.ts` catches this — the fix
      is trimming the list, not weakening the test), and one `slotBudget.test.ts`
      fixture pinned to `getScene('orbs')`, which now silently degrades to
      `SCENES[0]` (`wireframe`) per the documented fallback — swapped for
      `matrix`, which is both `low`-cost like `orbs` was AND genuinely
      layer-role-eligible, so the fixture is honest again rather than just
      numerically lucky.
      `npm run check`: 41 files, 459 tests, clean build.

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

- [x] **F12 · Analytics sampled every frame whether or not anything reads it** —
      *fixed 2026-08-29* `src/engine/SceneManager.tsx`, `src/engine/analyticsMetrics.ts`
      `sampleAnalytics` and `sampleTransitionFrame` run unconditionally; the panels
      they feed are closed by default. Gate on `analyticsOpen`.
      **Fixed `sampleAnalytics` only.** Grepped every reader of its four
      `RollingWindow`s (`analytics.bpmAccuracy/moodConfidence/moodAmbiguity/
      sectionStrength`): `AnalyticsPanel.tsx`, mounted only while
      `analyticsOpen`, and nothing else — safe to gate outright. Now
      `if (useStore.getState().analyticsOpen) sampleAnalytics(f)`; the windows
      simply stop advancing while the panel is closed and pick back up the
      instant it opens.
      **Left `sampleTransitionFrame` alone, deliberately.** Read its actual
      cost: it no-ops immediately unless a transition it's watching is in
      flight, and even then only does real work (sort/mean/p95) on the ONE
      frame a fade completes — already negligible, not the "every frame"
      cost this entry was about. Gating it would also be a regression, not a
      cleanup: it feeds `transitionMetrics.history`, which a DJ can review
      AFTER the fact — freezing it while the panel happens to be closed would
      silently drop transitions from the very history the panel exists to
      show. `npm run check` clean (764 tests, build passes).

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

- [x] **F15 · `EffectDirector` and `EffectsDirector` are different subsystems** —
      *fixed 2026-08-29* `src/engine/`
      One owns event-triggered effect *scenes*, the other owns the post-processing
      chain. Both are mounted in `Stage`, one character apart. Rename the post chain
      to `PostChain`.
      **The proposed target name was taken by then.** `Stage.tsx` grew its own
      `PostChain` component since this was written (F50, the mount gate that
      holds `EffectsDirector`/`ExposureSampler` off until the show is
      `starting`/`running`) — renaming `EffectsDirector` to `PostChain` as
      literally proposed would have collided with it.
      **Renamed to `PostFXChain` instead.** Shares no root with either
      sibling (`EffectDirector`'s "Effect", `PostChain`'s own name), and drops
      "Director" — the file's own header already says this component is a
      *pure executor*, explicitly not a decision-maker like `CameraDirector`/
      `AnimationDirector`/`EffectDirector`, so keeping that suffix was its own
      small ongoing confusion. `git mv EffectsDirector.tsx PostFXChain.tsx`,
      the exported function, both import/usage sites (`Stage.tsx`,
      `BenchStage.tsx`), and every comment reference across 9 more files
      (`FeedbackPass.ts`, `frameLoad.ts`, `MirrorPass.ts`, `feedbackParams.ts`,
      `opticalRack.ts`, `SynthGridScene.tsx`, `performanceState.ts`,
      `PerformanceStateBridge.tsx`, `transitions.ts`) — grepped clean
      afterward except the two lines that intentionally explain the rename
      (`BenchStage.tsx`, `PostFXChain.tsx`'s own header). Also updated
      `PostFXChain.tsx`'s F48 constraint while touching it anyway: it still
      recommended never re-rendering the component as a "hard constraint"
      against a black-screen crash that F48 (same day) already fixed —
      corrected to describe the crash as historical and the no-re-render
      discipline as a perf preference now, not a safety rule. `npm run check`
      clean (764 tests, 0 lint errors/warnings, build passes).

- [~] **F16 · `budgetLedger` is unreached Phase-7 scaffolding** — *partly
      fixed 2026-08-29 — real data now flows in, nothing acts on it yet, by
      design*
      `src/engine/streaming/budgetLedger.ts`
      111 lines plus a 250-line test suite; `ceilingForTier` and `evaluateLedger` are
      imported only by that test. It is the VRAM-budget mechanism the uncapped render
      targets actually need — wire it up or delete it, but do not leave a tested
      no-op.
      **Confirmed worse than described first.** Grepped `reportByteSize`
      (the ONE thing that would feed real numbers into this ledger): zero
      production callers, only its own test exercises it directly — so
      `resourceCache.totalBytes()` read 0 in the live app, meaning the
      disconnect wasn't just "the ledger's verdict is never read", the
      ledger never had real data to evaluate in the first place. A full
      wire-up needs three separate pieces: (1) real GPU byte sizes at every
      allocation site, (2) mapping `SceneManager`'s Entry system onto
      `budgetLedger`'s richer `SceneLifecycleStatus`, and (3) actually
      acting on eviction candidates — a genuine multi-file feature.
      **Did (1) for real, deliberately stopped short of (2)/(3).**
      `resourceCache` gained `reportExternalByteSize()` — a plain size
      ledger entry for GPU resources whose LIFECYCLE is owned elsewhere (the
      render targets in `createShaderScene.tsx`'s own `WeakMap` caches,
      F138/F144/F147, which deliberately never go through `acquire()`/
      `release()` — refcounting a resource nothing ever frees is bookkeeping
      with no decision behind it). `createShaderScene.tsx` now reports every
      budgeted render target's real byte size (HalfFloat RGBA, no mipmaps —
      `width * height * 8`) whenever it grows; `envMap.ts`'s shared PMREM
      texture — the one resource that WAS already routed through
      `resourceCache.acquire()` — had never had its size reported either
      (stuck at 0 since the day it was added), fixed the same pass. Wired a
      real `evaluateLedger()` call into `PerfMonitor.tsx` (every 2s — VRAM
      only moves on a grow, no reason to check every frame), publishing
      `perf.vramMB`/`perf.vramCeilingMB` and a `console.warn` naming
      eviction candidates if ever over.
      **Left (2)/(3) undone, on purpose, not from running out of time.**
      Every ledger entry maps to a synthetic `'ACTIVE'`/`'BACKGROUND'`
      status (current primary vs. everything else) rather than a real
      `SceneLifecycleStatus`, and the verdict is published, never acted on.
      Two independent reasons a real eviction path isn't safe to add
      unverified: `ceilingForTier`'s numbers are an explicitly untuned
      guess (its own doc comment says so) with nothing in today's roster
      remotely close to them, so there is no live case to test eviction
      against even if it existed; and forcing a resident scene's render
      target to tear down and rebuild mid-show is exactly the reallocation
      stall F147 spent this same session eliminating for maze — wiring an
      automated trigger for that, in a codebase this session has already
      caught it in twice, without a live browser to confirm it lands
      safely, would be trading one hazard for another rather than fixing
      one. A visible, honest, real number is the actual deliverable here;
      taking action on it is real, separate, harder work for whenever it's
      backed by both a tuned ceiling and a way to verify the eviction path
      live. `npm run check` clean (764 tests, 0 lint errors/warnings, build
      passes) — including the existing `resourceCache.test.ts` suite,
      unmodified and still green against the new external-entries path.

## Low

- [ ] **F17 · Six exported symbols with no production caller**
      `CAMERA_MODES`, `DEFAULT_ANCHOR`, `LOADER_KEYS`, `isResident`,
      `resetParallelCompileProbe`. `registerPalette` is a documented extension point
      like `registerScene` and should stay.
      **2026-08-29: audited all six individually rather than batch-deleting.**
      `DEFAULT_ANCHOR` is no longer dead — `BenchStage.tsx` now imports and
      uses it; this finding is simply stale. `CAMERA_MODES` and `isResident`
      are production-unused but genuinely exercised by real tests
      (`CameraDirector.test.ts`'s reachability check, `lifecycle.test.ts`'s
      `isResident`/`isEvictable` pair) — working, correct, documented public
      API surface for systems that just haven't grown a second caller yet,
      not the kind of tested no-op F16 above warns against leaving.
      `resetParallelCompileProbe` is a deliberate test seam (its own doc
      comment says so) resetting module-level driver-probe state between
      `shaderPrewarm.test.ts` cases — removing it would break test isolation
      for no gain. **Fixed:** `LOADER_KEYS` (`src/engine/streaming/
      resourceCache.ts`) had zero references anywhere, test or production —
      a hardcoded gltf/draco/ktx2 key map for a resource type nothing in the
      current shader-only roster (post-F105 licence sweep) loads. Deleted;
      `acquireSingleton` itself (the general mechanism it would have used)
      stays, since it's real, tested, general infra any future scene can
      call with its own key. `npm run check` clean.

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
      2026-08-27, reopened the same day by the licence sweep, re-fixed 2026-09-01*
      **Re-fixed.** Three new scenes claim the role directly rather than
      reviving `orbs`: `src/scenes/ShockRingScene.tsx` (drop), `SectionFlareScene.tsx`
      (sectionChange/buildPeak) and `TransientSparkScene.tsx` (transient) — one per
      trigger family, all `license: 'original'`, all written for this project from
      scratch with closed-form, singularity-free math (Gaussian rings and beams,
      `amt/(d²k+1)` spark falloff — no `1/d` term anywhere, unlike `orbs`'s own
      glow). Registered in the live `SCENES` roster, not `DISABLED_SCENES`.
      Reuses the exact `effectEnvelope` contract the original fix proved out —
      pulled into its own module (`src/scenes/effectEnvelope.ts`) so all three
      new scenes and `OrbitGlowScene` share one tested implementation of the
      "must reach visual zero by `slotProgress` 1" rule instead of each
      re-deriving it.
      `transient`'s effect (`spark`) initially shipped at a 0.32s duration and
      1.4s cooldown; `effectLifecycle.test.ts`'s own "keeps effect lifetimes
      musical" (1-8s) and "does not fire on every transient" (cooldown >2s)
      invariants — written when the slot had no content to check them against —
      caught both violations immediately. Retuned to 1.2s / 2.5s: the mitigation
      for a frequent trigger is the cooldown, not a sub-second duration, and
      `effectEnvelope`'s decay-dominated shape still reads as a quick pop at 1.2s.
      Priced in `sceneCost.ts`'s `SCENE_COST_MS` as a documented, clearly-labelled
      engineering ESTIMATE (0.07-0.10 ms flat, by op-count comparison against
      `orbs` at 0.06 ms measured) rather than a `/bench` measurement — no headless
      browser exists in this repo to run the real sweep. `registry.test.ts`,
      `sceneCost.test.ts` and `slotBudget.test.ts` all have blanket loops over
      the live roster that would otherwise price an unmeasured scene from the
      pessimistic 8ms/tier unknown-fallback; adding the estimate (rather than
      weakening those tests) keeps their invariant intact.
      **Previously reopened.** `orbs` was the scene that claimed the role, and
      F105 quarantined it as unverified Shadertoy provenance. `getEffectScenes()`
      returned nothing and the slot was inert.
      Nothing about the original fix was wrong and none of it was lost: the
      `effectEnvelope` contract, its tests, and the `slotProgress` exit rule all
      stood and are what the next effect scene had to satisfy. What was missing
      was a LICENSED scene willing to claim the role. `malachite` did exactly this
      for `background` (F18 stayed closed because a licensed scene picked the
      role up), which is the pattern the re-fix above follows.

      Original entry:

- [x] **F20 (original) · The effect slot is fully built and completely empty** — *fixed
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

- [~] **F21 · Docs regressed in the force-push** — *partial fix 2026-08-29*
      Overwriting `main` dropped `9e6fd90`, so `docs/HANDOFF.md` still describes a
      five-scene roster and 61 tests against an actual 18 and 314. Recover with
      `git cherry-pick 9e6fd90` from `backup/main-20260820`.
      **The prescribed recovery no longer works.** `9e6fd90` is itself from
      2026-08-16 (`222 tests`, a mid-merge roster) — cherry-picking it now
      would swap one stale snapshot for a different, still-stale one; the
      real target has moved twice since this entry was written (today: 11
      live scenes post-F105, 764 tests). Fixed the two actively-misleading
      numbers directly from live source instead: `docs/HANDOFF.md` §0's
      roster table (now all 11 current ids, each with a one-line description
      pulled from that scene's own header comment) and its `61 tests`
      reference (now `764`), plus the one echo of the old count in §2 item 3.
      A staleness banner in §0 flags that everything below it (§1-§8 prose,
      the numbered history, the checklist) has NOT been re-audited in this
      pass and may carry the same drift — a full pass through five docs is
      real content work distinct from this fix, not attempted here.
      `docs/00_Vision.md`, `01_System_Architecture.md`,
      `02_Music_Intelligence.md`, `04_Visual_Knowledge_Base.md` (the other
      four `9e6fd90` touched) not checked at all this pass.

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
      *(Update, F02: `GenerativeLayer` and its `GENERATIVE_UNITS` reservation were
      later deleted outright — the feature had never been used. `frameLoad.fixed`
      is back down to just `POST_CHAIN_UNITS`; the ladder was left at its rebased
      values rather than re-shrunk, which leaves scenes with one extra unit of real
      headroom per tier.)*

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

- [ ] **F44 · The fixed cost is an estimate, not a measurement** — *open*
      `POST_CHAIN_UNITS = 2` is reasoned (a bloom mip chain is roughly a
      fullscreen pass and a half) but **not measured**. `/bench` deliberately
      excludes the post chain so scene costs compare cleanly, which means the
      one cost present in every single frame is the one number never measured.
      (`GENERATIVE_UNITS`, the other fixed cost this issue originally covered,
      no longer exists — the AI-texture overlay it accounted for was deleted
      outright; see F02.)
      Add a bench mode that measures an empty scene with and without the post
      chain; the difference is the fixed cost. Then set this constant from data
      and re-check the ladder rebase.

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

- [x] **F48 · `EffectsDirector` crashes the whole Canvas if it ever re-renders** —
      *fixed 2026-08-29 by upgrading past the hazard — trigger removed, root
      cause now removed too*
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
      **Took the first durable option.** Confirmed by downloading and reading
      the actual source (`npm pack @react-three/postprocessing@3.1.1`) rather
      than trusting the changelog: `JSON.stringify` is gone from the whole
      package (`grep` for it comes back empty), replaced by
      `createEffectComponent`, which registers each effect as a real R3F
      intrinsic (`extend({key: EffectClass})`) and lets R3F's own reconciler
      own construction/prop-application/disposal — the same machinery
      `<mesh>`/`<meshStandardMaterial>` already use safely with a `ref` prop
      every day. `ref` is destructured out before anything gets memoised, so
      it can never reach a stringify call again, circular or not. Verified
      every effect this codebase actually uses still fits the new shape
      before upgrading, by reading each wrapper's source directly:
      `Bloom`/`ChromaticAberration`/`Vignette` (all via `createEffectComponent`,
      matching this codebase's exact prop usage — `intensity`, `mipmapBlur`,
      `radius`, `offset`, `eskil`, `darkness`) and `EffectComposer` itself
      (`ref`/`multisampling`/imperative `.setSize()` all still present,
      confirmed against source, not assumed from the type declarations alone).
      Bumped `@react-three/postprocessing` `^3.0.4` → `^3.1.1` and its now-
      required peer `@react-three/fiber` `^9.2.0` → `^9.7.0` (both semver-
      compatible with what this repo already declares). `npm run check`
      clean (764 tests, 0 lint errors/warnings, build passes) — the
      strongest evidence available without a live browser in this
      environment; not re-verified by actually forcing a fullscreen-toggle
      re-render live.

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

      Update 2026-08-29: the specific disposal race this entry names -
      "a material being disposed by a scene switch that lands mid-poll" -
      no longer exists for the dominant caller. F144 (same day) changed
      every shader scene's material from create-and-dispose-per-mount to a
      cached, non-disposed-until-context-loss object (`getSceneMaterial` in
      `src/engine/createShaderScene.tsx`), which both production call
      sites of `prewarmShaders` compile against - `SceneManager`'s per-mount
      warm-render and F145's new boot-time prewarm. Neither can race a
      disposal that no longer happens on a scene switch. Not closing this:
      the underlying three.js hazard (`checkMaterialsReady`'s unguarded
      `properties.get(material).currentProgram.isReady()`, verified in
      `node_modules/three`'s source - throws from a detached `setTimeout`
      no `try/catch` around `compileAsync` can reach) is still real for
      anything NOT covered by that cache - a genuine context loss, or any
      future `compileAsync` caller on a `useDispose`-owned material (the
      post chain's own `LensPass`/`MirrorPass`/`GradePass` materials are
      exactly that shape today, though none of them currently call
      `compileAsync`). Substantially less likely to fire than when this was
      written; not eliminated. Same root cause as F93 below.

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

- [x] **F81 · Three other passes omit the colour-space conversion** — *fixed
      2026-08-29 — latent, correct today by position only*
      `MirrorPass`, `FeedbackPass` and `LensPass` are all ShaderMaterials with no
      `colorspace_fragment` include. That is correct while they render to
      intermediate linear buffers and something else is last — but it means the
      chain is only correct because of the current ORDER, and reordering it (or
      disabling `GradePass`) reintroduces F79 silently.
      Options: give every pass the include and make it conditional on
      `renderToScreen`, or add a test/assert that the final pass is one that
      converts. The second is cheaper and catches the real mistake, which is a
      reorder rather than a missing line.
      **Took the cheaper option**, but as a runtime check rather than a unit
      test — `EffectsDirector.tsx` has no test file (nothing in this codebase
      unit-tests an R3F component tree directly; the closest precedent is
      source-text parsing, which is fragile against a prettier reformat and
      not worth introducing new). Instead, inside the component's own
      `useFrame` (which already reads `composerRef.current` every frame for
      the DPR-resize block right above it): once per mount, checks that
      `composerRef.current.passes[passes.length - 1] === gradePass` — the
      COMPOSED pass list three actually built, not the JSX source, so it
      catches the mistake regardless of how a reorder happened. `gradePass`
      mounts via `<primitive object={gradePass} />` (a raw `Pass`, not a
      merged `Effect`), confirmed by reading `@react-three/postprocessing`'s
      `buildPasses` — so it lands in `composer.passes` at its own JSX
      position, unmerged, making direct identity comparison meaningful.
      `console.error`, not a throw: a wrong chain order is a real bug worth
      surfacing loudly, but this component's own header (F48) already
      establishes that staying up matters more than failing fast here.
      Warns at most once per mount (a ref flag), so a real regression is
      still loud without spamming the console every frame. Zero behavior
      change when the chain is correct, which it is today. `npm run check`
      clean (764 tests, 0 lint errors/warnings, build passes).

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

- [x] **F86 · `chrome` gets ~5x MORE expensive as quality drops** — *fixed
      2026-08-29 — scene bug, exposed by the sweep*
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

      **Found the per-mount rebuild the "smells like" line guessed at — the
      exact F144 mechanism, just outside F144's fix.** `ChromeFormScene`
      predates `createShaderScene` and was never migrated to it: `heroGeo`/
      `heroMat` were built in a component-scoped `useMemo` and freed via
      `useDispose` on every unmount, same as every `createShaderScene` scene
      was doing before F144. Disposing a `MeshPhysicalMaterial` fires the same
      `WebGLPrograms.releaseProgram()` → `program.destroy()` chain F144 traced
      for maze, so chrome recompiled its (genuinely large — clearcoat is a
      second specular lobe and a second env-map sample) program from scratch
      on every single mount. `/bench`'s non-monotone numbers are exactly the
      shape of that stall landing unpredictably inside a per-tier measurement,
      not a real per-fragment cost curve — the same false signal F137's
      `MAX_STEPS` mitigation gave for maze before F144 found the actual cause.
      **Fixed** the same way: `getChromeAssets(gl)` caches `{geometry,
      material}` per renderer in a `WeakMap`, built once and never disposed
      except on context loss. `useDispose(heroGeo, heroMat)` is gone — there
      is nothing left for a mount to own. `releaseSharedEnvMap()` still fires
      on every unmount (unchanged) even though `getSharedEnvMap()` inside
      `getChromeAssets` now only runs once per renderer — confirmed safe by
      reading `resourceCache.release()`: the entry is pinned, so an "extra"
      release just clamps its refcount at 0 instead of disposing, identical
      to never releasing at all. `npm run check` clean (764 tests, build
      passes). Not re-run through `/bench` in this environment (no browser
      automation available) — the mechanism and fix are the same as F144's,
      which IS live-confirmed, but this specific scene's numbers are not yet
      re-measured.

      **Found the same pattern in 15 more scenes while looking for this one**
      (`FoldPathScene`, `InversionMachineScene`, `JuliaWingsScene`,
      `KaleidoPulseScene`, `TorusFoldScene`, `TrailLineScene`,
      `OrbitGlowScene`, `FlowRibbonScene`, `TunnelDriftScene`,
      `SynthGridScene`, `NetworkConstellationScene`, `HeapCorruptionScene`,
      `PointCloudScanScene`, `PlasmaFilamentScene`, `DissolveCageScene` — each
      calls `useDispose` on a `useMemo`'d material) — every bespoke,
      non-`createShaderScene` scene in the roster likely pays this same
      per-remount recompile tax to some degree, exactly as F144 itself
      predicted ("a general bug affecting every scene in the roster... other
      scenes pay the same tax in a few milliseconds and nobody could see
      it") — chrome and now the maze/malachite pair are just the ones with
      shaders complex enough to make it visible. NOT fixed here: each of
      those 15 has its own geometry/material construction logic, and some
      may legitimately need per-mount (or `useSceneParamSteps`-bucket)
      regeneration for reasons specific to that scene rather than being a
      pure bug — applying chrome's exact fix to all 15 blind, in one pass,
      without reading each one individually first, is a bigger and riskier
      change than this entry's scope. Flagging as the natural next
      systemic follow-up to F144, not attempting it here.

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

- [x] **F89 · `roleScalable` is declared by exactly zero scenes** — *fixed
      2026-08-29 — the discount had never once been applied*
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
      First pass (same day): investigated, left as-is — confirmed the
      mechanism was real and tested but unclaimed, and declined to pick
      scenes/rewrite shaders unreviewed, the same discipline F42 already
      established for visible depth-density changes.
      **Implemented for the two scenes it was actually safe to pick**,
      instead of either extreme. Of the live (post-F105) roster, only four
      scenes carry a layer role at all (`plasma`, `ribbons`, `malachite`,
      `matrix`); of those, `malachite`/`matrix` are already `performanceCost:
      'low'`, where a further cut buys almost nothing (matching this entry's
      own framing — "a genuine saving on the SIX EXPENSIVE scenes"). `plasma`
      (`'high'`, `roles: ['primary','accent','overlay']`) and `ribbons`
      (`'medium'`, `roles: ['accent','overlay']` — never primary at all) are
      exactly the candidates it named. Both already had a genuine, existing,
      already-proven lever to hook into — `state.particleDensity`-driven
      `geometry.setDrawRange()`, the SAME quality-governor knob both scenes
      already use for tier-based thinning — so this wasn't new complexity-
      reduction logic, just a role-based multiplier (`0.6`, matching
      `ROLE_SCALED_FRACTION`) on a mechanism already live and trusted.
      `setDrawRange` is a genuine GPU cost cut, not a cosmetic one: fewer
      particles/ribbons is fewer vertex-shader invocations and less fill,
      unlike a uniform that only changes appearance — so the discount
      `roleScalable: true` now claims is actually earned, not aspirational.
      `ribbons` is never primary, so its cut is now unconditional (matching
      what a scene that ONLY ever plays a secondary role should cost).
      Left the two low-cost, background/overlay-only scenes (`malachite`,
      `matrix`) and everything primary-only alone — no shader-rewrite risk
      taken anywhere; both changes are pure multipliers on numbers that
      already existed. `npm run check` clean (764 tests, 0 lint
      errors/warnings, build passes). Not re-run through `/bench` or a live
      session — no browser automation available in this environment — so the
      actual ms saved is not yet measured, only the mechanism verified
      correct by reading it.

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

      Update 2026-08-29: same finding as F49's update above (this is the
      same bug, opened twice) - F144 made the materials both production
      `prewarmShaders` callers compile against session-cached and no longer
      disposed on a scene switch, which was exactly the disposal this entry
      names as the trigger. Substantially less likely now, not eliminated -
      see F49 for what's still exposed.

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
      spectrum — 512 bins then, 1024 since F154 — and two 1024-sample
      waveforms), so it is **sent only while a panel is open**. Verified: with every panel closed the control
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

### Step 3 result, after both fixes — 13/16 (2026-08-27)

Five sweeps. The final numbers, and what each disagreement means:

  scene      fill   centre  conflict   declared          verdict
  ribbons   0.026    0.74      1.27    accent,overlay    VETOED on conflict
  plasma    0.116    0.57      1.10    accent,overlay    VETOED on conflict
  orbs      0.632    0.18      0.48    accent,bg,overlay VETOED on fill

**`conflict` is the statistic that works.** It orders the whole roster cleanly —
`ribbons` 1.27 at the centred end down to `juliawings` 0.27 at the peripheral
end — and that ordering matches what the scenes look like.

Its two vetoes are the interesting result of this whole exercise. It says
`ribbons` and `plasma` fight a centred subject. **Issue 3 in this ledger is a
human complaint that `ribbons` is "too aggressive and overused" as a layer**, and
the profiler reached that from pixels without being told. It may be disagreeing
with the DECLARATION while agreeing with the REPORT — which would make it right
and the roster stale. Somebody should look at those two as layers and decide who
is wrong before step 4 ships.

**`orbs` is the profiler still being wrong**, and the reason is known rather than
mysterious: the thresholds in `T` were calibrated against pre-post-chain profiles
and now sit on a completely different distribution. Every scene's `fill` moved
once bloom entered the measurement. Re-deriving them is legitimate, but it has to
be done against more than sixteen points or it is just overfitting with extra
steps — which is exactly what two of these five sweeps taught.

**Step 4 remains unstarted, deliberately.** Not because the tool is bad — it is
useful as a submission report today — but because a veto needs to be right about
`orbs`, and it currently is not.

### Step 3 result — first attempt, before either fix (2026-08-27)

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

### Both defects fixed (2026-08-27)

Built as planned below, with three corrections the tests forced.

**Defect 1.** `/bench?profile` now mounts `EffectsDirector`. It also skips
`BenchDriver`'s own `gl.render` in that mode — the composer draws at priority 1
too, and two renderers at one priority both run — and moves the readback to
priority 2, which is the first moment the COMPOSITED frame exists. A readback
taken alongside the draw would have sampled the frame before bloom, grade and
gain, which is the exact blind spot the pass exists to remove. Warmup goes
60 → 240 frames because the exposure servo has a ~2.3 s time constant, and
profiling a gain that is still travelling makes a scene's profile depend on
what the previous cell left behind.

**Defect 2.** The field is normalised before any composition statistic is
taken — but to its **RANGE**, [p5, p99], not to its top.

That correction cost a whole validation run and is the most useful thing this
work produced. Normalising to p99 alone, with the post chain now mounted, took
`orbs` from `fill 0.021` to `fill 0.963` and `kaleido` from 0.061 to 0.992.
Every scene in the roster came out above 0.83 and `fill` stopped discriminating
at all — agreement fell from 13/16 to 12/16, worse than before either fix.

The two fixes had interacted. With the post chain there is no true black any
more: bloom's halo and the fog veil lift the floor. Normalising to the top then
multiplies that lifted floor up, and a threshold calibrated for raw frames
counts all of it as lit. The tell was `orbs` being vetoed as a background — the
scene the whole roster agrees is the best one — which is a metric being wrong
rather than a roster being wrong.

**A flat field has no range**, so range-normalisation reports it as having no
structure. That is true and it opened a hole: judged on shape alone a mid-grey
wash looks like an empty frame and would be admitted as a layer, where it would
destroy everything under it. `canBeLayer` therefore also consults **absolute**
`meanLuma` — the one place level is still checked, and it has to be.

Three further things the tests changed:

  - `normaliseScale` returns **0**, not 1, for an effectively empty frame. A
    distinct signal rather than a scale, because returning 1 left `conflict`
    energy-weighting sensor-floor noise into a confident 0.26 on a field whose
    brightest pixel was 0.0016. An empty frame now reports empty in every
    statistic, not only in `fill`.
  - **Motion is measured on the RAW field**, like `meanLuma` and unlike
    everything else. Normalising every frame to the same level made a scene that
    pulses in brightness read as perfectly still — exactly wrong for the
    question motion is asked for, which is whether something can sit under a
    composition for a whole section without pulling the eye.
  - p99 from a 256-bin histogram, so the scale is quantised; equality
    assertions between a dim and a bright version of the same field had to
    become a tolerance.

### The plan these were built from (2026-08-27)

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

## Merging the lilim scene port into main (2026-08-27)

The branch diverged at PR #9 and carried 2 commits; main carried 28. The
instruction was to keep main's engine and take the branch's scenes, and that is
what the merge does — but the two sides had independently built **three
parallel designs for the same things**, which is where all the real work went.

| both branches built | main's form | lilim's form | kept |
|---|---|---|---|
| per-scene params + modes | `contract: { version, params, modes, paramLabels }` | flat `params` / `modes` / `paramLabels` | **main's** — the versioned envelope exists for exactly the third-party case |
| five palette slots | named `slots.bg/shadow/mid/accent/glow` | `PaletteRamp` 5-tuple + `resolveRamp` | **main's** — nothing in production used the tuple form |
| the params resolver | `scenes/contract.ts` | `engine/sceneParams.ts` | **both**, repointed: lilim's resolver now reads the envelope |

Lilim's six parameter keys are a subset of main's seven, so the transformation
was lossless — only the nesting changed.

**What the merge deliberately did NOT take:** lilim's edits to `frameLoad.ts`,
`slotBudget.ts`, `SceneManager`, `Stage`, `PerformanceDirector`, `EffectDirector`
and their tests. Every one was a comment-only change removing the AI-texture
overlay, which main had already done *and* then rewritten past — those files are
denominated in milliseconds on this side.

**Two things went wrong and were caught by tests rather than by review:**

  - Taking lilim's SCENES array wholesale replaced the metadata of scenes BOTH
    branches carry, silently dropping main's Scene Contracts from `wireframe`,
    `chrome`, `orbs` and `kaleido`. `wireframe` lost its three modes outright.
    The `pickVariedMode` tests caught it; all four are restored, including the
    two now quarantined — a disabled scene keeps its metadata precisely so
    re-enabling is moving one entry back.
  - `slotBudget.test.ts` used `synthgrid` and `orbs` as its cost fixtures, and
    both left the live roster. An unregistered id prices from the pessimistic
    fallback rather than its measurement, which quietly changes what the test is
    testing. Repointed at `ribbons` and `dissolve`.

- [x] **F106 · Five scenes in the live roster have never been benched** —
      `src/engine/sceneCost.ts`
      `malachite`, `matrix`, `kifs`, `maze` and `wingfold` arrived with the port
      and price from `FALLBACK_COST_MS` — pessimistically, which is the safe
      direction, but pessimistic is not measured. Meanwhile ten measured scenes
      left the roster, so the cost table is now about half stale in one
      direction and half absent in the other.
      *(fixed 2026-08-27)* Swept and regenerated. `sceneCost.test.ts` is back
      to demanding zero unmeasured scenes rather than naming five.
      The five came in at: `kifs` 2.97, `wingfold` 2.54, `matrix` 2.05,
      `malachite` 0.76, `maze` 0.42 ms at tier 0. See F113 for what else the
      sweep turned up - the table changed by far more than five rows.

- [x] **F107 - Nothing in the roster ever rendered a native pixel, on any
      display** - `src/engine/renderScale.ts` *(fixed 2026-08-27)*
      Reported as "why does everything look so low res? the pointcloud looks
      like cotton balls instead of dots". It was not the scene: `PCD_FRAG` hard
      discards outside a circle and has no soft falloff, so those dots are
      exactly as crisp as the shader can make them. They were being drawn at
      **0.69 linear on a plain 1080p monitor at the BEST quality tier** and
      bilinearly stretched back over the panel - 47% of the pixels.
      Tabulated the solve across the whole roster with the real functions
      before touching anything. Every scene, every display, at tier 0:

          scene                    |   1080p   1440p  4K@1.5    5K@1
          wireframe          low   |    0.86    0.65    0.43    0.40
          plasma             high  |    0.69    0.51    0.40    0.40
          pointcloud         high  |    0.69    0.51    0.40    0.40
          dissolve/chrome/ribbons  |    0.78    0.58    0.40    0.40

      Not one scene reached 1.00 anywhere. The doc comment in that same file
      promised "a 1080p display still solves to scale 1 and is untouched"; it
      was written when `wireframe` declared `fillBound: false`, and nothing in
      the roster declares that any more, so the promise had quietly become
      false for all eleven scenes.
      **Root cause: `POST_CHAIN_PIXEL_BUDGET` was calibrated against a software
      renderer.** The 2.5 MP figure was justified by a measurement of "512 ms
      per frame at 5.2 MP" - that is ~28 ms per fullscreen pass across an
      eighteen-pass chain, which is SwiftShader, not a GPU. The RATIO that
      paragraph draws from it (4x the pixels, 4x the cost) is sound; the
      absolute it anchored on was not, and a budget is an absolute. The
      constant's own comment already said "**ESTIMATE - not measured on real
      hardware**" and "raise it for a sharper picture".
      Because `combinePixelBudgets` is a reciprocal sum, and a reciprocal sum is
      always smaller than its smallest term, a 2.5 MP post chain capped every
      frame below 2.5 MP no matter what the scene asked for. A `high` scene at
      1.6 MP landed on 0.98 MP - sub-720p - before the tier ladder multiplied it
      down again.
      Fixed by re-anchoring the table on what a scene gets AFTER the combine,
      which is the only number that ever reaches the canvas:
        - `POST_CHAIN_PIXEL_BUDGET` 2.5 -> 12
        - `BUDGET_BY_COST` high 1.6 -> 5.5, medium 2.5 -> 7.0, low 4.0 -> 9.0
        - `UNTRUSTED_MAX_BUDGET` 4.0 -> 8.0 - it has to move with the table or
          it stops being a ceiling and becomes a penalty: against the new
          defaults a 4 MP cap would be lower than every in-repo scene's, making
          any third-party scene the blurriest thing on the bill regardless of
          what it actually cost.
      Every scene now renders **native through 1440p** and starts scaling at 4K,
      which is the display class the module's own opening paragraphs say the
      governor was built for. Both load-shedding levers are intact and were
      re-tabulated to prove it: layering still costs resolution (two `high`
      scenes plus the chain resolve to 2.24 MP, so a 1440p panel drops to 0.78),
      and the tier ladder still does (a `high` scene on 1080p runs
      1.00 / 1.00 / 0.94 / 0.79 / 0.65 across the five tiers).
      One test had to be repointed rather than renumbered, and it is the reason
      this shipped green for so long: `registry.test.ts` solved its 5K guarantee
      from `scenePixelBudget(scene)` **alone**, a budget the renderer never uses
      because the post chain is always folded in first. It was pinning a
      quantity that does not exist in the pipeline. Now solves from the combined
      budget and asserts a FRACTION of the panel (< 40%) rather than an absolute
      megapixel count - an absolute silently re-tunes its own meaning every time
      the budget table moves, which is exactly when the test should object.
      Side benefit for F106: `/bench` solves its DPR from the scene budget alone
      while production solves from the combined one, so the cost pass used to
      measure `pointcloud` at 0.88 while the app ran it at 0.69. Under the new
      constants both are 1.00, so the table F106 regenerates will finally be
      measured at the resolution the app actually renders at.

      **Second pass, same day: the 1440p anchor was not enough.** Reported
      immediately - "this is plasma filament, looks so blurry and bad... im
      currently running it on a 4k monitor, my cofounder on a 1080". The first
      pass fixed the 1080p machine (1.00) and left the 4K one at 0.67, because
      the anchor was a 1440p frame.
      The deeper problem was the SHAPE of the decision, not the constant. The
      solve is a pure function of (budget, display, tier) with no feedback from
      measured frame time - the module documents that as a feature - so a static
      table was deciding up front that a machine could not have full resolution
      and nothing downstream could revisit it. A 4K user was permanently soft
      whether or not their GPU had the headroom.
      Re-anchored on what the top of the ladder MEANS: **tier 0 renders a 4K
      panel natively**, and the tier ladder - which does measure frame time, and
      has hysteresis - is what takes resolution away. Predict-then-commit
      becomes start-high-and-measure.
        - `POST_CHAIN_PIXEL_BUDGET` 12 -> 24
        - `BUDGET_BY_COST` high 5.5 -> 12.5, medium 7 -> 16, low 9 -> 20
        - `NATIVE_PIXEL_BUDGET` 16 -> 32, `MAX_PIXEL_BUDGET` 32 -> 64,
          `UNTRUSTED_MAX_BUDGET` 8 -> 16. Native has to stay the LARGEST budget
          in the module or "my cost is not per-pixel" would ask for fewer pixels
          than `low` does.
      Verified with the real functions across the whole roster. Every licensed
      scene now solves to 1.00 on 1080p, 1440p AND 4K at tier 0. The ladder for
      a `high` scene:

          1080p   1.00 / 1.00 / 1.00 / 1.00 / 0.95
          1440p   1.00 / 1.00 / 1.00 / 0.87 / 0.72
          4K      1.00 / 0.84 / 0.70 / 0.58 / 0.48
          5K      0.75 / 0.63 / 0.52 / 0.44 / 0.40

      Smooth descent on the big panels rather than one cliff, and layering still
      costs resolution (two `high` scenes on 4K resolve to 0.77).
      The cost is real and stated rather than hidden: a weak machine on a large
      panel now spends its first second or two at native before the ladder
      demotes it, where the old table would have started it soft. A brief wrong
      guess that corrects itself, instead of a permanent one that cannot. The
      narrowing of the ladder's range on small displays is F111.
      `registry.test.ts` moved its 5K guarantee from tier 0 to the SURVIVAL tier
      for the same reason - a big panel being downscaled at tier 0 is no longer
      the promise; what must hold is that the ladder has somewhere to go. A new
      test pins 4K native at tier 0 so this cannot regress silently.

- [x] **F110 - `POST_CHAIN_MS` is a fixed reservation that does not scale with
      resolution** - `src/engine/frameLoad.ts` *(fixed 2026-08-27)*
      Direct consequence of F107, logged rather than guessed at. The post chain
      now renders ~2.1x the pixels on a 1080p/1440p panel (0.69 -> 1.00 linear),
      but its frame-budget reservation is a flat `POST_CHAIN_MS = 2` with no
      resolution term, so it is now understated by roughly that factor.
      Deliberately NOT adjusted. Both 2 and any replacement are guesses -
      `/bench` excludes the post chain, so F106's sweep will not settle it
      either - and the two failure modes are not symmetric. Under-reserving
      admits work the frame cannot afford and the tier ladder catches it from
      measured frame time; over-reserving permanently starves the layer and
      transition budget for work that may not cost that much. The one with a
      safety net is the right side to err on until the chain is actually
      weighed.
      **Fixed the same day, because 4K made it urgent rather than academic.**
      Reported as "4k is lagging a lot, p95 is 66.6 to 80" - 12-15 fps.
      Every fixed cost in that file is a FULLSCREEN DRAW - the post chain, the
      feedback pass, and both optical racks - and a fullscreen draw costs one
      unit of work per pixel. All four are therefore linear in the internal
      resolution, and a flat millisecond reservation is only ever correct at one
      resolution. That was survivable while the budgets held every display near
      1080p; F107 made a 4K panel render 8.29 MP at the top tier, four times the
      frame these numbers were reasoned about, so the chain reserved 2 ms for
      something costing nearer 8 - and the budget then admitted layers into a
      frame that was already over, which is the exact failure `remainingMs`
      exists to prevent.
      Added `fillScale(internalMP)` - the ratio to a 1080p reference frame - and
      multiplied the whole fixed term by it in SceneManager. Still an ESTIMATE
      (`/bench` excludes the post chain, so F43/F90 stand), but an estimate with
      the right SHAPE degrades correctly at both ends: it charges a 4K frame
      four times what it charges a 1080p one, and it gets cheaper the moment the
      ladder takes resolution away, which is exactly when the budget should
      loosen again.
      `PerformanceDirector`'s composition budget is now floored at 0 - a 4K
      frame at tier 0 can legitimately reserve more than the whole tier budget,
      and the right response is to admit nothing rather than hand a negative
      number to the slot arithmetic.

- [x] **F114 - The render-scale hold sat out a crisis for twenty seconds** -
      `src/engine/PerfMonitor.tsx` *(fixed 2026-08-27)*
      Found while chasing the 4K lag above, and it is most of why the ladder
      appeared not to rescue anything.
      `RENDER_SCALE_HOLD_SEC = 3` delays applying a tier's resolution so a
      reallocation is not paid for a change that might reverse. Sound at the
      margin. But the hold is per STEP and the ladder has five rungs, so a
      machine that has to fall all the way to the bottom waits out
      `SETTLE_SEC + 3` five times over - on the order of twenty seconds -
      rendering the whole time at a resolution it has already been told it
      cannot afford.
      The apply path's own comment makes that sound harmless: the frame is
      "getting cheaper this instant either way, since scenes read the complexity
      knobs live". **That is false for six of the eleven live scenes** (F111),
      four of which read no quality knob at all. For those, nothing whatsoever
      happens between the tier changing and the resize landing. Twenty seconds
      of an unchanged frame - reported, exactly, as "it looks great but lags".
      Added `SCALE_EMERGENCY_RATIO = 3`: when the p95 is past three times the
      refresh interval (50 ms at 60 Hz - three dropped frames in a row) the hold
      is abandoned and the scale applies on the spot. One reallocation is
      unarguably cheaper than what that frame is already paying. Measured off
      the p95 rather than the EMA because the EMA is smoothed over seconds and
      this is the case where seconds are the whole problem.

- [x] **F108 - Mirror tiles and slice retired** -
      `src/engine/opticalDirector.ts` *(done 2026-08-27)*
      Requested directly: turn both off completely. `tiles` is the `wallpaper`
      mode (an n x n mirror-repeat) and `slice` is `shear` (alternating shear
      slabs).
      Four separate things could turn them on, which is why this is not a
      one-line change:
        1. `mirrorForSection`'s mode pools - both removed.
        2. The `collapse` transition in `transitions.ts`, which set
           `mirrorTiles: arc > 0.35 ? 2 : 0` alongside its twist. A transition
           is the one place a retired effect would still have surfaced, two
           beats at a time and unattributable, so this had to go too.
        3. The debug/console override path in `PerformanceStateBridge`.
        4. **The persisted store** - the one that actually needed a gate.
           `debugPostFx` goes through zustand's `persist`, and store.ts is
           explicit that "a persisted value always beats a changed default", so
           anyone who had ever dragged the tiles slider held a non-zero value in
           localStorage that removing the slider would strand rather than clear.
      Gated to zero in `PerformanceStateBridge` as the last writer in the decide
      band, which covers all four. Zeroing there rather than at the pass also
      keeps `isMirrorActive` and `mirrorRackMs` honest - they read the same
      state, so a retired mode cannot leave the pass enabled or keep charging
      the frame budget for a draw that now renders an identity transform.
      Sliders removed from both control surfaces (`Console.tsx`, `HUD.tsx`): a
      control that moves and changes nothing reads as a broken renderer rather
      than as a deliberate absence.
      Found while doing it: **the mode pools had a permanently unreachable
      entry.** `mirrorForSection` returns early on `seed % 4 === 3`, so
      `seed % 4` at the selection line only ever yields 0, 1 or 2 - with
      four-entry pools, index 3 was dead. `shear` sat at index 2 in the hot pool
      and the `kaleido` behind it had never once been selected. Pools are now
      written at their real length of three.
      Type, switch cases and the shader are all kept, and the `wallpaper`
      coarseness test is `.skip`ped rather than deleted - left running it would
      have passed vacuously, which is the worse failure mode. Re-enabling is
      putting the modes back in the pools and lifting the gate.

- [x] **F109 - Lens rack turned down** - `src/engine/opticalDirector.ts`
      *(done 2026-08-27)*
      Requested: reduce the lens sensitivity. `lensAmountTarget` was 0.2 -> 0.4
      soft and 0.3 -> 0.62 hard. Those came from a correction in the other
      direction - the amount had been driving straight off tension and peaked at
      0.045 across a 90-second run, i.e. invisible - and that correction
      overshot. Past roughly a third the material stops modifying the image and
      starts replacing it: anamorphic smears the subject away, melt plumes
      detach from what spawned them, glitch tears read as a dropped frame.
      Now 0.15 -> 0.24 soft and 0.2 -> 0.38 hard: **~40% off the ceiling, ~25%
      off the floor.** The asymmetry is the point and the test caught it - the
      first cut took the floor to 0.12 and `opticalDirector.test.ts` objected
      that an engaged lens below ~0.15 does not read at all, which would have
      recreated the exact "not visible, not free" defect the previous correction
      existed to fix. The loud end comes down, the quiet end stays legible,
      which is also what "less sensitive" means for a magnitude that swells with
      tension - the complaint lives at the top of the swell.
      Engagement frequency untouched at one section in three. If the lens should
      appear less OFTEN rather than less strongly, that dial is the `seed % 3`
      in `lensForSection`.

- [x] **F113 - The CPU surcharge in the cost table was a phantom; six scenes do
      not respond to the tier at all** - `src/engine/sceneCost.ts`
      *(fixed 2026-08-27)*
      Found while regenerating for F106. The table carried a flat per-scene CPU
      term on the evidence that `ribbons` "spent 68 ms per frame on the CPU at
      tier 0" and `chrome` 43.6 ms, which priced them at 13.11 and 9.25 ms -
      between them a fifth of a tier-0 budget.
      **It does not reproduce.** Across all 55 cells of the new sweep the CPU
      mean is 16.666 ms - vsync, to three decimals, on every single one - with a
      p95 never above 17.7. There is no overrun to charge. The `js` column,
      which is the number those figures were reaching for, tops out at 0.13 ms
      (`malachite`, `maze`).
      The readings reconcile and the old one was wrong: `/bench`'s CPU column is
      whole-frame wall clock, so on a vsync-locked run it reports the frame
      interval whatever the scene costs, and on a stalling run it reports the
      stall. It was never a measurement of the scene. **F86 and F87 close with
      it** - both existed to explain a cost that was not there.
      Consequences, all of them large:
        - `ribbons` 13.11 -> 0.72 ms. It went from dearest scene in the roster
          to second cheapest.
        - `chrome` 9.25 -> 1.58 ms.
        - **No live scene is expensive enough to forbid a layer any more.** The
          dearest is `kifs` at 2.97 ms against an 8 ms tier-0 composition
          budget, so every licensed scene can fund a second one at every tier.
          Pinned by a new test; `slotBudget.test.ts` had to reach outside the
          roster (to the still-priced `synthgrid` row) to exercise the "budget
          outranks pool" branch at all.
        - The label/cost inversion that justifies this whole module survives and
          is now *inside* the live roster: `wingfold` is declared `low` and
          measures 2.54 ms, `maze` is declared `high` and measures 0.42 - same
          two labels, 6x apart, pointing the wrong way round.
      **Also found, not fixed:** six of eleven live scenes show no cost response
      to the quality tier (`chrome`, `malachite`, `matrix`, `maze`, `ribbons`,
      `wingfold` are flat or inverted), and four read no quality knob whatsoever
      - `wireframe`, `chrome`, `matrix` and `kifs` never touch `quality.knobs`,
      so their only tier lever is the resolution solve. `wingfold` measured
      0.79 / 2.27 / 2.39 / 2.35 / 2.54 across the ladder: three times DEARER
      below the top tier, unexplained. Monotonisation makes the budget safe
      regardless, but see F111.

- [~] **F111 - The tier ladder cannot shed load on most of the roster** -
      `src/scenes/*` *(partly fixed 2026-08-27)*
      Six of eleven live scenes do not get cheaper when the tier drops (F113),
      and four never read `quality.knobs` at all. For those, dropping a tier
      buys nothing except whatever the resolution solve gives - and after F107
      raised the budgets, resolution now holds at 1.00 through tier 3 on a 1080p
      panel, so on that display the ladder has nothing left to take.
      That is a real narrowing of the load-shedding range, accepted knowingly as
      the price of full quality on capable hardware: the machines that need
      tiers 1-2 are by definition ones where the frame nearly fits, and a 4K or
      5K panel still gets a smooth resolution descent at every rung.
      **`kifs` fixed.** It is the dearest scene in the roster (2.97 ms) and it
      already HAD the mechanism - `uIterCount` is a real loop bound its shader
      breaks on - it was simply driven by the user's complexity slider and
      nothing else. Now capped by `quality.knobs.raymarchSteps` as well, exactly
      as WingfoldJuliaScene does it, so the slider still spans its full range
      and the tier decides where the top of that range sits. The floor of 6
      folds is where the rose still reads as a rose.
      **`matrix`, `chrome` and `wireframe` are correctly knob-less**, which was
      worth establishing rather than assuming. `matrix` has no loop at all - it
      is a pure fill-bound fragment shader. `chrome` is a MeshPhysicalMaterial,
      also fill-bound. `wireframe` draws instanced screen-space quads, and
      cutting the count would make edges literally VANISH, which is the same
      argument quality.ts already makes about not discounting `particleFraction`
      through a transition. For all three, resolution IS the correct lever and
      the absence of a knob is a design decision rather than an omission.
      **`maze` fixed by F128** - its `pixelBudget` was a spec-time constant
      that never varied with tier, which was the entire "does not bite"
      story for that scene. Still open, and still the more interesting half:
      `wingfold` and `malachite` also read quality knobs (`raymarchSteps`,
      `noiseOctaves`) and still show no measurable cost response - `wingfold`
      is 3x DEARER below tier 0. The wiring exists and does not bite. That
      needs a targeted measurement, not another knob - and F128's fix does
      not generalise here automatically, since the cause may not be the same
      fixed-pixelBudget shape.

- [x] **F112 - The bench runs with no audio, so audio-gated scenes profile as
      empty** - `src/bench/BenchStage.tsx` *(fixed 2026-08-27)*
      `ribbons` measures `fill` at 0.009 / 0.015 / 0.001 / 0 / 0 across the five
      tiers, with `centre`, `mid`, `edge` and `conflict` all exactly 0 at the
      bottom two. That reads like a scene going black at tier 3, and it is not:
      BenchStage never starts an audio source, and `ribbons` is a waveform trace
      whose visible output is audio-gated. It is sitting on the noise floor at
      all five tiers, and the tier-to-tier wobble is noise, not degradation.
      Its COST rows are unaffected - it draws the same geometry either way, at
      ~0.7 ms - but its PROFILE rows are meaningless, and so is any role
      assignment derived from them. The same trap waits for every future scene
      that gates on audio.
      Fixed with `driveSyntheticAudio` in BenchStage: a deterministic analysis
      frame written after `audioEngine.update()` each tick. Synthetic rather
      than a real file because a benchmark cell must be comparable to every
      other cell, and a real track is not - two scenes swept a minute apart
      would be measured against different material and the difference would land
      in the numbers as though it were a property of the scenes. This is a pure
      function of `f.time`, so a re-run reproduces a previous run exactly.
      Deliberately a mid-energy groove (120 BPM carrier, 8 s phrase swell) and
      not a peak: the goal is to get audio-gated scenes DRAWING so their profile
      means something, not to measure them at their loudest. A sweep pinned at
      full level would price every scene at its most expensive state and profile
      it at its brightest - a different distortion, not an absence of one.
      Waveforms carry real harmonic content rather than a sine so a trace scene
      has a shape to draw, and the spectrum falls with a tilt because that is
      what most material actually looks like.
      **The cost rows from the 2026-08-27 sweep predate this**, so `ribbons` and
      any other audio-gated scene are priced from a silent frame and should be
      re-benched.

- [x] **F115 - No instrument existed for the running show, only for one scene
      in isolation** - `src/engine/sessionLog.ts` *(added 2026-08-27)*
      Requested directly, after the 4K lag report (F110/F114) kept being
      diagnosed through a human relaying two numbers off a panel: "p95 is 66 to
      80", "I can't see the demotions". Not a fault of the report - a fault of
      the instrument. `/bench` cannot answer these questions and was never meant
      to: it sweeps one scene in isolation, with no audio (F112), no
      transitions, no layering and no director. Everything left unresolved is
      about the engine RUNNING - a real track, real section changes, real
      crossfades, real load.
      A session recorder, toggled from a new button in the console's diagnostics
      dock (next to Debug / FPS / Analytics). Records nothing until pressed;
      writes three files and copies a summary to the clipboard when pressed
      again:
        - **Every raw frame time**, into a preallocated 120k-entry ring (~33 min
          at 60Hz) - not just its average. A hitch is a single-frame event, and
          averaging it away is exactly how a stuttering show reads as a steady
          60, which is the mistake `perf.p95` was already built to avoid
          (PerfMonitor.tsx's own header explains it) and this extends across a
          whole session rather than a 10s window.
        - **Everything else at 4Hz** - finer than the governor can act on
          (`SETTLE_SEC` is 2s) - covering frame budget, render scale, audio
          features, scene/mood/layer state, every post-fx value, and transition
          progress.
        - **Events, derived by diffing state rather than by instrumenting call
          sites** - a tier change, a scale change, a scene change, a transition
          starting/ending (flagged ABORTED if progress never reached ~1), a
          layer arriving or leaving, silence starting or ending. Diffing means
          nothing else in the engine had to be touched, and nothing visible in
          state can be missed by a call site nobody remembered to update.
        - **A contact sheet**: periodic canvas thumbnails into a 64-tile PNG grid
          that halves its own density and doubles its interval every time it
          fills, so a 3-minute and a 30-minute recording both cover the WHOLE
          session rather than front-loading. Read in the same tick a frame
          composited, same constraint `ScreenshotCapture` already documents for
          `preserveDrawingBuffer: false`.
      The summary is the part meant to be pasted: frame-time percentiles, time
      spent at each tier and each render scale with every transition logged,
      **frame time attributed to whatever scene was actually on screen** (the
      one thing no other instrument in the codebase can produce, since `/bench`
      never runs two scenes together and never runs audio), frame-budget
      overrun rate, transition completion rate, and the worst dozen 4Hz samples
      with everything that was true at that instant.
      Runs in the OUTPUT window over the BroadcastChannel command already used
      for record/screenshot (`toggle-session-log`), because that is where every
      singleton it samples actually lives (`perf`, `frameLoad`,
      `performanceState`, the canvas). The console only owns the button; its
      label and elapsed time come off telemetry from the window doing the
      recording, not off the button's own belief about it - the same class of
      bug F100/F102 exist to describe, avoided by construction here rather than
      re-discovered.
      14 new tests, run against the real singletons in vitest's `node`
      environment rather than mocks - `document` is undefined there, which is
      exactly the condition the thumbnail path's guards exist for, so the test
      suite doubles as a check that recording never throws headless.
      **Not yet verified against a real set.** Typechecks, is unit-tested, and
      was checked statically against the telemetry prune path that has broken
      twice before (F102, F104) - `logging`/`logSec` ride the flat `Telemetry`
      packet as a whole-object replace, the same as `bpm`/`mood`, not through
      `mirrorInto`'s field-by-field merge. No Playwright in this environment to
      drive an actual browser session, so the next real recording IS the
      verification.

- [x] **F116 - "high" quality silently disabled the entire adaptive governor** -
      `src/engine/quality.ts` *(fixed 2026-08-27)*
      **The actual cause of the 4K lag**, and the first thing the session
      recorder (F115) found on its first run.
      The recording: 77 s on a 4K panel, p95 80-96 ms, `mean 27.2 / p50 22.1 /
      p99 96.3 / max 179.3`, 70% of frames over 16.7 ms - and **`tier changes:
      0`**, tier 0 for the whole session. Computing the governor's own inputs
      from the recorded frame times gave `refreshMs` = 8.1 ms, so its demote
      threshold was `ema > 8.9 ms` against a measured ema of 20-45 ms. It was
      not reacting slowly. It was never consulted.
      `setMode` set `auto = false` for any fixed quality, and `tick()` returns
      on its first line when that is false. With `FIXED_TIER.high = 0`, picking
      "high" meant "pin tier 0 and never adapt again" - which is not what anyone
      choosing a quality PREFERENCE is asking for, and nothing in the UI said
      the safety net had been switched off.
      Fixed by making a fixed mode a **ceiling** rather than a pin: `auto` stays
      on, the governor keeps measuring and keeps its authority to shed load, and
      the setting caps only how far back UP it may climb. `high` now means "give
      me tier 0 when the machine can hold it", which is what it always claimed
      to mean. A machine that cannot hold it gets rescued.
      Worth recording plainly: **every earlier theory about this lag was
      secondary.** The post-chain reservation (F110), the render-scale hold
      (F114) and the scenes that ignore the quality knobs (F111) are all real
      defects and all were correctly diagnosed - but none of them could matter
      while the ladder was inert. Three rounds of reasoning from a relayed p95
      never got near this; one recording did, immediately.
      `qualityGovernor.test.ts` had a test named "does nothing at all while
      pinned to a fixed quality" asserting exactly this behaviour. That
      assertion WAS the bug, and it is now inverted: a 300 ms frame must never
      be something the governor is contractually obliged to ignore.

- [x] **F117 - Hot moods could only ever reach the two warm palettes** -
      `src/engine/AutoPilot.tsx` *(fixed 2026-08-27)*
      Reported off the recorder's contact sheet as "it is using the entire
      colour palette available? i dont think it is" - every one of 64 thumbnails
      came out the same orange.
      `peak` was `[ember, solar, violet]` and `aggressive` was
      `[ember, solar, mono]`. Both LEAD with the same two warm palettes, and
      `pickPalette` excludes whatever is already showing, so an energetic track
      simply alternated ember and solar. The session spent 53 s of 77 in
      peak+aggressive: two palettes out of six, for the whole set.
      Not a taste decision so much as an unnoticed consequence of ordering.
      Widened so every mood reaches at least four of the six and the hot moods
      each keep a cool option, so a peak can arrive as a COLOUR CHANGE rather
      than as more of the same orange. Order still carries the intent - first
      entry is what the mood wants most - so the moods stay distinct.

- [x] **F118 - The scene-switch gate was unreachable** -
      `src/engine/AutoPilot.tsx` *(fixed 2026-08-28)*
      Reported as "it seems to not change the scene for like 15-20 secs upon
      start". The recording confirms it and sharpens it: first scene commit at
      **39.6 s**, then 56.3 s and 72.6 s - so steady state is ~16 s and only the
      opening is wrong.
      Ruled out from the data rather than guessed at:
        - **Not the dwell floor.** `lastCommitBeat` starts at `-Infinity`, so
          `canAutoSwitch` returns true immediately; the 32-beat floor cannot
          block the first switch.
        - **Not silence.** Audio resumed at 6.5 s.
        - **Not a missing mood change.** Mood moved at 7.2 s, 18.5 s and 33.3 s
          and no scene followed any of them.
      That leaves the confidence/ambiguity gate in AutoPilot
      (`MOOD_CHANGE_MIN_CONFIDENCE` 0.4, `MOOD_CHANGE_MAX_AMBIGUITY` 0.6) or the
      request-to-commit handoff - **and the recorder captured neither**, which
      is its own finding. A flight recorder that logs a decision's RESULT but
      not its INPUTS can only ever confirm that something did not happen.
      Deliberately NOT guess-fixed. Loosening the gate is a one-line change that
      would trade a static opening for scene thrash on an unsure read, and there
      is no evidence yet for which is happening.
      Instrumented instead - the next recording answers it outright:
        - `confidence`, `ambiguity` and `moodChanges` per sample, plus a summary
          line giving the % of samples that FAIL the switch gate.
        - `pendingScene`, and a `requested X` event, so a slow DECISION and a
          slow request-to-commit HANDOFF stop looking identical (the commit can
          trail the request by seconds while the shader warms and a downbeat is
          waited for).
        - `palette` per sample plus palette-change events (the F117 gap - the
          first recording could not answer a colour question at all).
        - `qualityMode` and `autoPilot`, which is what would have made F116
          obvious in one line instead of needing the frame times re-derived.

      **Answered by the next recording, outright.** Across 155 s of real music
      `confidence` peaked at **0.392** and averaged 0.259, against a gate
      demanding >= 0.4. **Zero of 600 samples passed.** So this was never a
      threshold that occasionally held the show back - it was outside the
      estimator's range entirely, and `AutoPilot` has not once driven a scene
      change in its life. Every switch in that session came from
      `PerformanceDirector`'s section boundaries instead, which is exactly why
      the pacing read as structural rather than musical.
      Lowered to 0.25, just under the observed mean. The blast radius is already
      bounded: `MIN_SUBJECT_DWELL_BEATS` (32 beats, ~12.6 s at 152 BPM) throttles
      the rate and the `pendingSceneId` guard stops a second request evicting a
      warming one. `MOOD_CHANGE_MAX_AMBIGUITY` deliberately NOT touched in the
      same change - loosening two gates at once makes the next recording
      impossible to read.
      **Left open:** a confidence that never exceeds 0.39 on clearly-structured
      music suggests the estimator's scale is itself suspect. Re-tuning a
      threshold is not the same as fixing that. See F121.

- [x] **F119 - The governor demoted a machine holding a perfect 60 fps** -
      `src/engine/quality.ts` *(fixed 2026-08-28)*
      Second recording, and the reason the picture still looked soft after F116
      woke the ladder up. The frame times were excellent - p95 18.6 ms, 59.5
      effective fps, 0.5% of frames over 33 ms - and the show still spent **69%
      of the session at tier 4**, rendering 1.33-2.51 MP on an 8.29 MP display.
      `PerfMonitor` estimates the display interval from the 10th percentile of
      frame times, on the stated reasoning that "rAF is vsync-locked, so a frame
      can be LATE but essentially never early - the fast tail is therefore the
      interval". **The second half is false**, and the recording measures how
      false: 13.3% of frames came in under 16.0 ms, and 76% of those immediately
      followed a late one. That is the compositor catching up, so the fast tail
      sits BELOW the interval rather than on it. Measured p10: **15.70 ms against
      a true 16.67**.
      A 6% underestimate is fatal at these gates. `refreshMs = 15.70` puts the
      demote line at 17.27 ms and the STEADY line at **16.48 - below the vsync
      interval itself**, so a machine hitting a flawless 60 fps can never be
      judged steady and sits 0.6 ms under the demote line indefinitely. The
      recording shows the endpoint of that reasoning: a demotion logged at
      `ema 16.67`, on hardware that was never once late.
      Fixed by snapping the estimate onto the grid of rates a display can
      actually run at (240/165/144/120/90/75/60 Hz), within a 12% tolerance.
      The p10 is still the right ESTIMATOR - it is what resists a machine
      dropping most of its frames, where a median would report the achieved rate
      instead of the interval - it just needed rounding. Anything not near a
      known rate passes through untouched, so an unusual panel degrades to the
      old behaviour rather than being snapped to a rate it is not running at.

- [x] **F120 - The console's stale palette clobbered every automatic pick** -
      `src/engine/outputLink.ts` *(fixed 2026-08-28)*
      Reported as the palette not using its full range, and the second recording
      shows the mechanism frame by frame: `violet -> ocean` at 107.20 s and
      `ocean -> violet` at 107.30 s; `violet -> mono` at 120.26 s and back at
      120.28 s. One frame later, every time, and every revert landing on the
      same colour - which is why `violet` held **100 of 155 seconds** while the
      mood pool offered four.
      A genuine feedback loop, and `adoptCommittedScene` is one half of it.
      `AutoPilot` runs inside the Canvas, so it runs in the OUTPUT window, and
      it is what picks palettes. The console never learned about those picks -
      but the console is the look LEADER, so its `paletteId` is what
      `snapshotLook` publishes. Adopting a committed scene changes the console's
      `sceneId`; `sceneId` is a `LOOK_FIELD`; so the adoption publishes a look
      carrying the console's stale palette straight back to the output, which
      applies it.
      Telemetry already carried `palette` - the console simply never adopted it.
      Added `adoptOutputPalette`, same shape and same reasoning as
      `adoptCommittedScene`: the output owns what it committed, the controller
      follows. The console's snapshot stops being stale, so the look it
      publishes agrees with what is on screen.
      Worth noting the class: this is the third bug (F100, F102, now F120) where
      the control window's belief and the output window's reality diverged. The
      pattern each time is a field the OUTPUT owns being published by the
      CONSOLE. Anything auto-driven inside the Canvas is in that category.

- [~] **F121 - Mood confidence never exceeds 0.39, and BPM flips octave** -
      `src/audio/*` *(structural fixes landed 2026-08-30; final constants pending
      a corpus run - see below)*
      Two findings from the same recording, both about the audio read rather
      than the engine.
      **Confidence.** Across 155 s of clearly-structured music the mood
      estimator's `confidence` peaked at 0.392 and averaged 0.259, with
      `ambiguity` averaging 0.555 and touching 0.999. F118 lowered the gate to
      match the observed range, which unblocks the show, but a confidence that
      cannot exceed 0.39 on material like this is a statement about the
      estimator's scale, not about the music.
      **Fixed structurally:** `MoodEstimator.update()` built `confidence` from
      the RAW score margin (`margin*2 + ...`) while the `ambiguity` line right
      above it used the NORMALIZED one (`1 - margin/bestScore`). `score()`
      outputs sit in a compressed ~0.1..0.8 band, so `margin*2` could never
      reach 1. `confidence` is now `0.65*(1 - ambiguity) + 0.2*dwell +
      0.15*winnerHeld` - a decisive read reaches ~0.9. `AutoPilot`'s
      `MOOD_CHANGE_MIN_CONFIDENCE` was re-baselined 0.25 -> 0.5 (interim; final
      from `corpus/eval-report.md`).
      *Measurement caveat: `sessionLog.ts` was recording the BEAT-TRACKER
      `f.confidence` under the "mood confidence" label, so the "0.392 peak"
      figure's magnitude was never confirmed for `mood.confidence` specifically.
      Fixed too - a real `moodConfidence` sample field now exists.*
      Related: the read sat on `mellow` for **139 of 155 seconds** while energy
      averaged 0.481 and bass regularly passed 0.8.
      **Fixed structurally:** `score()` tested `m.level` against energy windows
      drawn for a 0..1 scale, but `m.level` is post-`RESPONSE_GAMMA` and
      compressed low (bandNormalizer records `level < 0.55` on 80% of frames),
      so `mellow`'s window sat where the music lives and `groove`/`peak` barely
      opened. `score()` is now per-mood checklists keyed on
      `e = m.level ** ENERGY_SHAPE_EXP`, which restores the scale; `mellow` also
      gained a real suppressive bass gate (was `1 - bass*0.5`, only halved).
      **BPM octave.** The tempo read flips between ~76 and ~152 within the same
      track - 8% of samples at the half-tempo reading.
      **Fixed structurally:** the octave correction was recomputed from scratch
      every 0.5 s with no memory, and `gridFit`'s occupancy term structurally
      *rewarded* the half-tempo grid whenever onsets were sparse (a verse where
      the kick plays every other beat). Added `BpmEstimator.octaveLock` (0..1
      metrical-level memory), made the octave switch asymmetric around the
      locked level (pulling back is cheap, leaving costs `octaveLock*0.9` extra
      margin), density-gated the occupancy *reward* (penalty kept, so
      double-time rejection is intact), and added a `lockedIn` gate on the
      persist-before-jump path. A `multifeature` second opinion
      (`EssentiaBridge` `rhythm-hq`, 20 s cadence) and a pure `reconcileModelBpm`
      helper fold a degara wrong-octave read onto the locked level.
      **Still open:** the interim constants (`ENERGY_SHAPE_EXP`, the mood band
      edges, `MOOD_CHANGE_MIN_CONFIDENCE`, the `octaveLock` rates) are set by
      reasoning, not measurement. `corpus/` + `npm run calibrate` runs the real
      estimators over a ~1-2 k-track MTG-Jamendo corpus and regenerates
      `corpus/distributions.json` / `corpus/eval-report.md`; the constants get
      their final values from that, and `MOOD_CHANGE_MAX_AMBIGUITY` is
      re-checked against the post-rewrite ambiguity distribution.

- [x] **F122 - Nothing ever put back the detail the render scale takes away** -
      `src/engine/GradePass.ts` *(fixed 2026-08-28)*
      Reported as "it still looks a bit ass ... I think we may have to implement
      upscaling", and the arithmetic backs it up: the governor lowers the
      DRAWING BUFFER and leaves the canvas's CSS size alone, so the browser
      stretches the result with plain bilinear filtering and nothing else. On a
      2560x1440 panel at scale 0.40 that is **1536x864 blown up to 2560x1440** -
      a 1.67x linear stretch with no reconstruction at any stage.
      The ladder itself is not the fault and was not touched: shedding pixels is
      how the frame gets cheap, and the recordings show that working. What was
      missing is that the pixels were never reconstructed on the way back up.
      Added contrast-adaptive sharpening (AMD's CAS, 5-tap) as the last thing
      before display scaling - which is exactly where FSR1 puts its RCAS stage
      and exactly the problem it solves.
      **Folded into GradePass rather than added as a pass.** A separate pass
      would be another full-frame read/write, and F110 exists precisely because
      fullscreen draws dominate this chain. GradePass is already last and
      already samples this texture, so the filter costs FOUR EXTRA TAPS instead.
      The taps run at the INTERNAL resolution, so the pass gets cheaper exactly
      when the sharpening is needed most.
      Adaptive rather than a fixed unsharp mask, because a fixed one would ruin
      the frames it is meant to help - it rings on high-contrast edges, and half
      this roster (wireframe, pointcloud, kifs) is nothing but high-contrast
      edges. CAS measures local contrast and sharpens inversely to it.
      `sharpenForScale` is exported and tested: zero at native (so the shader
      branch skips the taps entirely and a native frame pays nothing), ramping
      to a cap of 0.85 at `RENDER_SCALE_FLOOR`. Capped below 1 deliberately -
      past ~0.85 CAS stops recovering detail and starts manufacturing edges, and
      a false edge on a wireframe scene is worse than a soft real one.
      **Not the full fix.** The architecturally correct version decouples the
      SCENE resolution from the POST-CHAIN resolution - bloom, vignette, CA and
      fog are all low-frequency and would look identical at half resolution,
      while points and edges would stay native. That is a composer rewrite and
      touches the code path that has produced F48 three times. This recovers
      most of the perceived sharpness for a fraction of the risk; the rewrite
      stays on the table if a recording says it is still not enough.

- [x] **F123 - Draw-call telemetry measured the post chain's last quad, not the
      show** - `src/engine/PerfMonitor.tsx` *(fixed 2026-08-28)*
      Found in a session recording, and unmissable once the data was in one
      place: **all 600 samples reported `drawCalls: 1, triangles: 2`** -
      identically, for a raymarched fragment shader, an instanced wireframe and
      a 200-segment torus knot alike. Two triangles is a fullscreen quad.
      `renderer.info` resets itself on every `render()` call and the post chain
      makes many per frame, so the value read was always whatever the composer
      drew last. Both fields have therefore been meaningless for as long as they
      have existed, in the FPS panel as well as the recorder.
      Fixed with `info.autoReset = false` plus an explicit `reset()` after the
      read, which is the standard three.js pattern for measuring across multiple
      render calls. PerfMonitor runs at priority 0 and the composer at 1, so the
      value read is the previous frame complete - one frame stale, which for a
      draw-call readout is not a distinction anyone can perceive.

- [x] **F124 - The worst-frame report could not see a hitch** -
      `src/engine/sessionLog.ts` *(fixed 2026-08-28)*
      The summary's "worst samples" section was built from the 4 Hz state
      samples, which is one frame in fifteen. A recording showed what that
      costs: **p99 21.5 ms and a max of 139.6 ms, while the worst thing the
      list could find was 21.9 ms.** Three frames over 100 ms in that session
      were invisible to the section whose entire purpose is to find them.
      The raw per-frame ring was already being recorded for exactly this reason
      (see the F115 note on why hitches are single-frame events) - the summary
      simply was not reading it. Added a "worst single frames" section sourced
      from the ring, with each frame matched to the nearest 4 Hz sample so it
      still says which scene and tier were live. Times are reconstructed from
      frame index rather than stamped, so they are good to about a second -
      enough to line a hitch up against the event list, which is what it is for.

- [x] **F125 - 24 of the 30 palettes were unreachable by the running show** -
      `src/engine/AutoPilot.tsx` *(fixed 2026-08-28)*
      `palettes.ts` defines **30** palettes across five families. `MOOD_PALETTES`,
      the table the auto-pilot picks from, named **six** of them - the
      `signature` set. The other 24, 80% of that file, could only ever be
      reached by a human clicking one, which on an auto-piloted set means never.
      Nothing failed and nothing warned; the show simply drew from a fifth of
      the colour it had.
      This is also the ceiling F117 kept hitting. Widening `peak` and
      `aggressive` off their shared warm pair was a real fix, but it was
      redistributing six palettes when thirty existed.
      All 30 are now assigned by temperature and energy - colds and neutrals in
      `ambient`, muted earths in `mellow`/`building`, the `rainbow` family only
      in `groove`/`peak`/`aggressive` since lit slots spanning distant hues read
      as busy and would fight a quiet passage. Signature palettes keep the first
      seat in each pool; the rest widen the pool rather than replace it.
      Simulated over 600 picks against the real `pickPalette`: **all 30 appear**,
      the key anchor holds ~17% and everything else lands at 5-7%. Against the
      64% single-palette domination in the session log that is the whole point.
      **The test is the actual fix.** `paletteCoverage.test.ts` asserts every
      `PALETTES` id appears in some mood pool, so palette 31 cannot be stranded
      the way these 24 were. A table that indexes another file drifts from it
      unless something checks - that is how this happened in the first place.

- [x] **F126 - The melt transition read as boiling white goop, not liquefying** -
      `src/engine/LensPass.ts` *(fixed 2026-08-28)*
      The melt lens material added a `sheen` highlight on top of its runnel
      noise (`col += sheen * (col + 0.25)`), peaking near `n = 1` at roughly
      0.6-0.7 additive brightness. Anywhere the noise pattern peaked, the
      result clipped to white - so the "liquefying" look was a bright white
      blob boiling across the frame rather than the image running to shadow.
      Removed the sheen entirely and pushed `shade` darker instead
      (`0.55 * smoothstep(0.35, 1.0, n) + 0.6 * plume`, was `0.28 *
      smoothstep(0.55, 1.0, ...)`), so the runnels and kick plumes now read as
      the frame melting into black rather than glowing.

- [~] **F127 - A cold scene chunk can freeze the frame for over two seconds** -
      `src/engine/SceneManager.tsx`, `src/scenes/index.ts`, `src/routes/Visualizer.tsx`
      *(mitigated 2026-08-28)*
      A session log (2026-08-27) caught the worst single frame of the run at
      **2286.6 ms** - not a hitch, a 2.3-second freeze - landing in the gap
      between `scene: requested maze` (t=102.72s) and the transition actually
      starting (t=105.27s). That 2.55s gap matches the `waited > 2.5`
      backstop F35 added specifically so a cold commit could never deadlock -
      which means this *is* that backstop firing, on a scene whose cold
      `import()` + first shader compile took longer than the 2.5s window F35
      assumed was generous. F35's own description called the failure mode
      "multi-hundred-ms"; this is an order of magnitude past that.
      **Root cause found:** nothing prefetches a scene's chunk until
      `requestScene`/`setLayer` actually decide on it. AutoPilot's own
      "imminent transition" prediction only starts that download up to 4
      beats ahead - at the session's ~114 BPM that is about 2.1s of head
      start, already short of the 2.5s backstop before `maze`'s JS fetch +
      parse + first shader compile even begin. A scene never shown yet in a
      session was structurally likely to race the backstop.
      Fixed the download half: `preloadAllScenes()` fires every scene's
      `import()` from the output window on `requestIdleCallback` (`Landing`'s
      existing pattern for the `/app` chunk, same shape), so by the time
      AutoPilot first asks for `maze` its module is already resolved from the
      browser's cache and `import()` returns near-instantly - only GPU shader
      compile is left on the critical path, which is what the warm gate was
      actually designed to cover.
      **Marked mitigated, not fixed** - this removes the JS-fetch-and-parse
      component with high confidence but does not by itself prove the
      remaining shader-compile time fits inside the warm window on the
      hardware that hit the original 2286.6 ms. Needs a fresh session
      recording with a cold `maze` load to confirm the freeze is gone rather
      than just shortened.

- [x] **F128 - Maze traded away structure at t2->t3, not just resolution** -
      `src/scenes/MazeFlightScene.tsx`, `src/engine/createShaderScene.tsx`
      *(fixed 2026-08-28)*
      User report: t2/t3 "reduces the complexity so much it looks bad." Traced
      to two compounding bugs, one of them the "wiring exists and does not
      bite" half of F111 that was still open for `maze`.
      **The nesting cliff.** `detailCap` was `steps >= 50 ? 0.7 : 0.24` - tier
      ~2 (steps 54) and tier ~3 (steps 40) landed in different buckets, but
      0.24 clears NEITHER the CELL/3 nor the CELL/9 refinement threshold, so
      tier ~3 rendered the bare CELL=3 grid with zero nested detail. The maze
      did not get blurrier at that boundary, it stopped being a fractal - a
      structural loss, not a resolution one. Added a `steps >= 36 ? 0.5`
      rung so tier ~3 keeps the CELL/3 level; only the emergency tier (~4)
      goes flat.
      **The resolution knob was wired but dead.** `pixelBudget: 0.9` was a
      spec-time constant - it never varied with tier, which is exactly the
      "does not bite" complaint F111 recorded for this scene. `pixelBudget`
      now also accepts a function, resolved every frame in
      `createBudgetedScene` (a resize only fires when the solved size
      actually changes, so a same-value function costs nothing extra over the
      old fixed number). `maze` drops its budget 0.9 -> 0.55 below tier ~2 -
      paying for the reinstated nesting level with resolution instead of
      structure, which the scene's own doc comment already argued is the
      right trade: the third nesting level was measured as "mostly sub-pixel"
      at the OLD 0.47 render scale, so losing more of it to a smaller buffer
      costs less than losing a whole level costs structurally. Net: tier ~3
      should read as noticeably more detailed and cost roughly the same or
      less, not more - resolution is linear in pixel count per the scene's own
      profiling, and the reinstated level costs about 25 percentage points
      against a ~39% pixel-count cut.
      No dedicated tests - `createShaderScene.tsx` has none today, matching
      its existing convention (R3F component, no harness). Verified by
      `npm run check` (764 tests, unaffected) and reasoning through the
      pixel-math; not yet re-benched against real music.
      **F111 addendum:** `maze`'s "wiring exists and does not bite" half is
      fixed by this. `wingfold` and `malachite` are still open and still need
      the targeted measurement F111 originally asked for - this fix does not
      generalise to them without checking whether the same fixed-pixelBudget
      shape is the cause there too.

- [x] **F129 - The quality tier thinned fractal detail on top of resolution,
      not instead of it** -
      `src/scenes/KifsRoseScene.tsx`, `WingfoldJuliaScene.tsx`,
      `CrystalFoldScene.tsx`, `TorusFoldScene.tsx`, `KaleidoPulseScene.tsx`,
      `JuliaWingsScene.tsx`, `FoldPathScene.tsx`, `InversionMachineScene.tsx`
      *(fixed 2026-08-28)*
      User request, direct follow-up to F111/F128: "remove [tier's control
      of fractals] completely from the demoting list, let it reduce the
      resolution but it shouldn't touch fractals."
      All eight raymarched/escape-time fractal scenes tied their fold count,
      escape-time iteration cap, or march-step budget to
      `quality.knobs.raymarchSteps` (F111's fix for `kifs`/`wingfold`, and
      the pre-existing convention every scene ported after them copied). That
      was one lever too many: `engine/renderScale.ts` already scales every
      scene's canvas resolution by tier through the `performanceCost`/
      `pixelBudgetScale` system (confirmed - none of the eight declare a
      `pixelBudget` override, so they all already ride that global governor).
      Also thinning the fractal itself at low tiers meant a demoted frame
      lost structure - fewer KIFS folds, a shallower Julia escape count, a
      shorter Mandelbox march - on top of the resolution cut the global
      system was already making, which is what read as scenes "losing
      petals" rather than just going soft.
      Fix, applied identically across all eight: the tier-derived cap/scale
      factor is gone: `uIterCount`/`uMaxIter`/`uMaxSteps`/`uIters` are now
      pinned at each shader's own maximum (the value tier 0 already produced)
      and only the performer's own complexity/density dial moves them.
      `InversionMachineScene` dropped its `applyQualityUniforms(u)` call
      entirely (its only tier-read uniform was `uMaxSteps`); the other seven
      each lost a `quality.knobs.raymarchSteps`-or-`noiseOctaves` read.
      Resolution is untouched by this fix - it was never the thing being
      changed here, only the second, redundant complexity cut layered on
      top of it.
      No dedicated tests for any of the eight (matching the roster's existing
      convention - none of these R3F/shader-scene components have a test
      harness). Verified by `npm run check` (764 tests, unaffected, build
      clean); not yet re-benched against real music, so whether the eight
      scenes now cost more at low tiers than the ladder's frame budget
      allows is unconfirmed - the global resolution scaling should absorb it
      per `renderScale.ts`'s own math, but that is reasoning, not a
      measurement.

- [x] **F130 - The collapse transition lost its four-corner fold** -
      `src/engine/transitions.ts` *(fixed 2026-08-28)*
      User report from a fresh session log: collapse "was supposed to like
      mirror into 4 corners and then join again." Traced to F108: `tiles: arc
      > 0.35 ? 2 : 0` was one of four places that STANDING wallpaper mode
      (`mirror.tiles`) got zeroed when that mode was retired, and the
      transition's own use of it — riding the twist, not a standing mode at
      all — went with it as collateral rather than being kept.
      Restored `mirrorTiles: arc > 0.35 ? 2 : 0` in the `collapse` case only.
      Safe to restore alone because F108's actual gate (`p.mirror.tiles = 0`
      in `PerformanceStateBridge`) only zeroes the PERSISTED/directed value;
      `EffectsDirector` reads `transitionRack().mirrorTiles` straight into a
      local scratch mirror state for the duration of the transition and never
      round-trips it through `performanceState.mirror`, so the gate was never
      actually in this code path — F108 removed the VALUE, not a value a gate
      would have blocked anyway. Restoring the value alone therefore cannot
      reopen the standing wallpaper mode F108 targeted; that gate, the pool
      removals, and the debug-panel slider removal are all untouched.
      `transitions.test.ts`'s "drives mirror tiles past the shader gate or not
      at all" test already covered this shape (it was passing vacuously with
      tiles pinned at 0) and needed no changes — it now exercises real values.
      Verified by `npm run check` (764 tests, clean build); not yet watched
      live.

- [x] **F131 - Mirror segments and trails, more often, and not on the
      already-kaleidoscopic scenes** -
      `src/engine/opticalDirector.ts`, `src/engine/PerformanceStateBridge.tsx`
      *(fixed 2026-08-28)*
      Requested directly: raise how often the mirror rack and trails show up,
      except on `kifs`, `maze` and `wingfold` — all three are kaleidoscopic or
      heavily patterned by their own geometry already, so a standing mirror
      fold or a persistence trail on top of them doubles the same gesture
      rather than adding one.
      **Occurrence**, `opticalDirector.ts`:
        - `mirrorForSection`'s off-gate loosened from one section in four to
          one in six (`seed % 4 === 3` -> `seed % 6 === 5`).
        - `trailsTarget`'s per-mood bases raised a third time (groove
          0.82->0.9, building 0.9->0.97, peak 0.68->0.78, aggressive
          0.58->0.68; `ambient`/`mellow` untouched, already at the 1.0
          ceiling) and the busy-mix floor lifted 0.6->0.68.
      **Exclusion**, `PerformanceStateBridge.tsx`: a new
      `MIRROR_TRAILS_EXCLUDED_SCENES` set (`kifs`, `maze`, `wingfold`), read
      against `p.activeScene` (what the viewer can actually see, not the
      pending request) every frame rather than only at the section boundary —
      so switching into an excluded scene mid-section drops the rack
      immediately instead of waiting out whatever the previous scene's
      section had chosen. `segments`/`tiles` snap to 0 (they were already
      snap-not-ease values); `twist`/`slice` ease down through the existing
      `approach()`; `trails`' target goes to 0 and eases down through its own
      existing `approach()`. The debug-panel override still runs after this
      and still wins, unchanged from before — a human forcing a value in the
      panel is not the case this gate is for.
      Verified by `npm run check` (764 tests, clean build) — the existing
      `opticalDirector.test.ts` assertions on `mirrorForSection`'s firing rate
      and `trailsTarget`'s mood ordering are threshold/ordering checks, not
      values pinned to the old constants, so both held with no test edits.
      Not yet watched live for how the excluded-scene transition reads in
      practice.

- [x] **F132 - Worst-frame spikes cluster at scene-transition renderScale
      collisions** - `src/engine/PerfMonitor.tsx` *(fixed 2026-08-28)*
      User report: "still lagging a bit." The fresh session log's own "worst
      single frames" table names it precisely - every one of the five worst
      frames (136.3ms/chrome, 129.0ms/wireframe, 116.2ms/pointcloud,
      110.1ms/chrome, 84.0ms/wireframe - all 5-8x the 16.7ms budget) lands
      within about a second of a scene commit, and every one of those windows
      also shows 2-4 separate `renderScale` changes stacked in the same
      second in the events log (e.g. t=74.4-74.6s: DEMOTE, then scale
      0.59->0.72, right as `wireframe -> chrome` commits and its melt
      transition starts).
      Traced to `PerfMonitor.tsx`'s scale-decision block: "the scale has three
      inputs and two urgencies" - a TIER-driven scale change is held for
      `RENDER_SCALE_HOLD_SEC` (3s) before it resizes anything, but a
      COMPOSITION-driven change (`renderScale.pairKey` changing, which is
      exactly what a scene switch does) calls `applyRenderScale()`
      immediately, every time, with no hold and no coalescing. Each call
      reallocates render-target textures (the composer's and any per-scene
      budgeted target, e.g. `createBudgetedScene`'s), which is a real
      GPU-side allocation cost - and a scene commit already has its own cost
      that frame (even a prewarmed one), so several allocations landing in
      the same ~1s window is plausibly exactly where 60-136ms frames come
      from.
      Confirmed by reading further rather than guessing: `applyRenderScale()`
      already suspends the FILTERED sampler the tier logic reads
      (`frameSampler.governorP95`, 30-frame window), so the emergency-ratio
      escape hatch was not double-firing off its own resize cost - that loop
      was already closed. The real source is `renderScale.pairKey`
      (`budgetMP.toFixed(3)|fullMP.toFixed(3)`), which reacts to the
      COMBINED budget of every currently-drawing layer - and a transition's
      own layer add/remove events (an overlay swapping in, an accent
      dropping out, both visible in the same log windows as the worst
      frames) each change that combined budget, so `pairKey` was capable of
      differing on nearly every frame of a ~1s crossfade, not just once at
      commit - and the call site re-checked it every frame with no gate at
      all.
      Fixed with `RESIZE_COALESCE_SEC` (0.2s): a floor under the gap between
      any two actual `applyRenderScale()` calls, applied uniformly to all
      three trigger paths (composition, tier-emergency, tier-held) rather
      than only the composition one, since the underlying cost - a
      render-target reallocation - is identical regardless of which of the
      three asked for it. Does not change WHEN a resize is judged necessary,
      only rate-limits how often the expensive part actually runs; a call
      blocked by the gate is not dropped; it re-checks every subsequent
      frame and fires as soon as the gate clears, reading whatever is live
      at that moment (`applyRenderScale()` has no captured/stale state) - so
      the final resolution a burst settles on is unchanged, only the
      redundant intermediate reallocations are removed.
      Verified by `npm run check` (764 tests, clean build); not yet
      re-measured against a real session log, so the actual before/after
      worst-frame numbers are unconfirmed.

- [x] **F133 - Maze's deeper fractal levels intermittently render as flat
      background colour** - `src/scenes/MazeFlightScene.tsx`
      *(fixed 2026-08-28)*
      User report, specifically distinguished from a resolution complaint:
      "not rendering the whole thing sometimes, like it's replacing the
      deeper fractals with just pure background colour... b4 we implemented
      the logging and resolution fix, it looked great."
      "Looked great before" points squarely at F128, and reading the shader
      confirms the mechanism: a raymarch step that runs out of budget before
      converging (`i >= uMaxSteps`) reports a miss (`hit = false`), and a
      missed pixel paints straight fog/background colour - not a blurrier
      wall, an ABSENT one. `uMaxSteps` was `clamp(steps, 28, 150)`, reusing
      the same tier proxy `detailCap` reads, and F128 specifically restored
      the CELL/3 nesting level at tier ~3 (`steps` = 40) without raising
      that march budget to match it. The file's own profiling header says
      march-step count barely matters for cost ("96 -> 48: -5%, inside
      measurement noise") because "almost every ray hits a wall within a few
      steps" - true of the FLAT tier-~3 geometry that shipped before F128,
      not of the same tier now carrying a second nested scale, whose tighter
      recesses need more steps to converge. The two F128 changes were
      individually reasoned and individually tested; this is the interaction
      between them that neither one's own measurement would have caught.
      Fixed by flooring `uMaxSteps` at 64 (not the raw tier value) whenever
      `detailCap > 0.25`, i.e. whenever any nesting level is switched on;
      tiers 0-2 already exceed 64 and are unaffected, tier ~4 has nesting off
      already (flat by design, not a miss) and stays at its 28 floor. Per
      the profiling note above this should cost close to nothing at the one
      tier it changes (~3, steps 40 -> 64).
      No dedicated test - this scene has no test harness, matching the
      roster's convention for shader-scene components. Verified by
      `npm run check` (764 tests, clean build); not yet watched live against
      real music, so whether 64 steps is actually enough to eliminate the
      misses (versus just reducing them) is unconfirmed - a number picked
      from the profiling table's reasoning, not from re-measuring hit rate.

- [x] **F134 - Mirror rack ended abruptly, on a beat count instead of a
      musical event** - `src/engine/PerformanceStateBridge.tsx`
      *(fixed 2026-08-28)*
      User report: the rack "activate[s] well but it seems to end abruptly and
      too soon... they should run a bit longer and end on a proper change in
      song mood or energy." Root cause: the phrase-edge re-decision (added
      earlier because tying the rack to section boundaries alone left it
      "live in about one sample in eight") re-rolled
      `mirrorForSection` on every 16-beat phrase UNCONDITIONALLY - a fixed
      beat-count timer, not a musical one - so a fold that had just committed
      could be overwritten (often by `MIRROR_OFF`) exactly one phrase later
      regardless of whether anything about the music had actually moved.
      Fixed by gating the re-roll: a section boundary always commits (the one
      unambiguous "the music changed" signal), off-to-on always commits (no
      live look to cut short), and otherwise a currently-engaged rack now
      holds through the phrase edge unless the mood changed, the tension moved
      a real step (bucketed to a fifth, so beat-to-beat jitter doesn't count),
      or `MIRROR_MAX_PHRASES` (3, ~24s at 125 BPM) phrases have passed with
      neither moving - a backstop for a mood/tension pair that never budges,
      not the normal exit.
      Verified by `npm run check` (764 tests, clean build); not yet watched
      live for how the held-longer duration reads against real structure.

- [x] **F135 - Cold-start scene switching can stall well past what a listener
      reads as "the song changed"** - `src/engine/AutoPilot.tsx`
      *(fixed 2026-08-28)*
      User report, closely echoing F118's own original report: "doesn't seem
      to change scenes for like 15-20 secs despite the changes in the song
      like buildup and such." F118 already lowered `MOOD_CHANGE_MIN_CONFIDENCE`
      from an unreachable 0.4 to 0.25 for exactly this complaint, and a prior
      session log showed that fix holding on its own terms. The mechanism
      diagnosed here is different and F118 did not touch it: `AutoPilot` only
      ever acts on an EDGE - `m.changed` (a one-frame flag `MoodEstimator`
      sets only when the committed state actually flips) or `f.sectionChange`
      (a phrase-detected boundary). If a track's classified mood is already
      correct from early on and never crosses a category line, `m.changed`
      never fires; if a buildup happens inside the FIRST section,
      `f.sectionChange` hasn't fired either yet. Both triggers can go quiet
      for the length of an intro even while the music is audibly moving,
      because "energy is rising" is not itself an edge either function
      watches for.
      Fixed with `STALE_TARGET_SEC` (25s): a third path in the same
      if/else-if chain as the drop and mood-changed triggers, aiming at
      whatever mood is currently committed (`m.state`) - not a guess, just
      the estimator's own best read - the moment 25s pass with neither of the
      other two firing. Deliberately above the 15-20s that read as broken, so
      a track where the edges fire normally never trips it at all; every
      downstream guard (`MIN_SUBJECT_DWELL_BEATS`, the `pendingSceneId`
      single-flight lock) still applies exactly as it does for any other
      trigger.
      Verified by `npm run check` (764 tests, clean build). NOT yet confirmed
      live: `MoodEstimator.ts`'s hysteresis/confidence timing carries explicit
      prior warnings against re-tuning without a fresh measured recording
      (see F118's own comment), which is why this is a new trigger path
      rather than a threshold nudge - but the one live session log gathered
      since (`audiovis-session-2026-08-28-11-54-47.json`, confidence mean
      0.18, ambiguity mean 0.72 - a genuinely hard-to-classify track) never
      went 25s between scene changes (max gap ~17.5s, likely carried by
      `PerformanceDirector`'s section-boundary path instead), so this
      fallback has not yet been observed actually firing.

- [x] **F136 - The cold-open scene skips the warm-mount pipeline every other
      scene switch gets** - `src/engine/SceneManager.tsx` *(fixed 2026-08-28)*
      User report: "maze still looks bad in the starting 5 secs and also it
      still lags to load." F128/F133 already fixed maze's steady-state
      structure and march-step correctness; this is a different bug, specific
      to the FIRST scene shown at app launch. Every subsequent scene switch
      mounts its incoming scene at `dir: 0` (invisible, "warming") and holds
      it there until `prewarmShaders` confirms or `WARM_FRAMES` of hidden
      rendering have passed, only THEN promoting it to visible - the whole
      point being that shader compile and first-frame cost happens
      off-screen. `SceneManager`'s lazy initializer mounted the very first
      scene with `makeEntry(initialId, 'primary', 1)` - `dir: 1`, visible
      immediately, no warm phase at all - so the cold-open scene paid its
      full first compile live, on screen, at the same moment the quality
      governor was still at its conservative startup tier and render scale
      was still ramping up: three cold-start costs stacking on the one scene
      that never got the warm-mount protection every other transition relies
      on.
      Fixed by mounting the initial entry at `dir: 0` like any other warming
      candidate and adding a one-shot promotion (`coldBootPromoted` ref) that
      flips it to `dir: 1` the instant `isWarmComplete` is true - the same
      signal every later switch already uses, just with no outgoing scene to
      cross-fade from, so it fades in from black via the fade-easing loop's
      existing plain-`smoothstep` branch (taken whenever no `outgoingPrimary`
      is present) rather than needing new transition machinery. Confirmed
      safe: `performanceState.activeScene` is written directly from
      `s.sceneId` in `PerformanceStateBridge`, not derived from the entries'
      `dir`, so nothing downstream that reads `activeScene` was affected by
      the mount-timing change.
      Verified by `npm run check` (764 tests, clean build) AND live: the user
      ran the app and supplied a fresh session log
      (`audiovis-session-2026-08-28-11-54-47.json`) whose cold-open scene
      (`wingfold`, not `maze` this run - the boot scene is whatever
      `sceneId` resolves to, not hardcoded) shows a clean fade-in with no
      freeze in its first several seconds of `frameTimesMs`. See F137 below
      for a real, severe compile stall this same log surfaced on a LATER,
      ordinary scene switch into `maze` - a different bug from this one.

- [x] **F137 - Maze's shader compile itself can freeze the whole app for
      nearly 2 seconds, on an ordinary (non-cold-open) scene switch** -
      `src/scenes/MazeFlightScene.tsx` *(fixed 2026-08-28, unverified)*
      Surfaced by the user's live session log
      (`audiovis-session-2026-08-28-11-54-47.json`) taken right after F136
      shipped: `frameTimesMs` contains a single 1877.8ms frame landing exactly
      on `kifs -> maze`'s commit (t=29.98s in the events log), with the
      transition's own tracker separately reporting "completed in 2.58s,
      worst frame 109.7ms" - two different measurements of the same event,
      neither telling the whole story on its own.
      This is NOT the warm-mount scheduling bug F136 fixed - `maze` was not
      the cold-open scene this run (`wingfold` was, and its own boot was
      clean) - and it is not a bug in `shaderPrewarm.ts` either: that file
      already refuses to trust `WebGLProgram.isReady()` on exactly this
      user's driver stack (ANGLE/D3D11, no `KHR_parallel_shader_compile`) and
      correctly falls back to the visible-warm-frame path rather than lying
      about readiness. The real problem is one level down: the warm-frame
      path forces the ACTUAL synchronous `compileShader`/`linkProgram` call
      to happen during the hidden warm window - and because that call is
      genuinely synchronous and single-threaded, if the compile itself takes
      ~1.8s, the ENTIRE app (including the already-visible outgoing scene)
      freezes for that long regardless of which scene's contribution is
      hidden. No amount of mount-timing or warm-frame-count tuning can hide a
      stall that blocking - only a faster compile can.
      Fixed (attempted): `MAX_STEPS`, the shader's static march-loop bound,
      lowered from 150 to 96. `uMaxSteps` is clamped to
      `quality.knobs.raymarchSteps`, whose highest real value is 96 (tier 0) -
      the loop's compile-time bound had never been reached by any runtime
      value since being set to 150, so this is a zero-runtime-effect change
      (every tier's actual step count is unchanged) on the chance that a
      smaller static loop bound gives ANGLE's D3D11 backend less to compile
      or optimize.
      Verified by `npm run check` (764 tests, clean build) only - the
      *runtime* behavior is provably unchanged, but whether this actually
      cuts D3D11 compile time is UNVERIFIED without a fresh live session log
      re-triggering a `-> maze` switch. If it does not help, the next lever
      is splitting `map()`'s three nested `carveScale()` calls or reducing
      `MAX_AO`/`edgeGlowAt`'s own `map()` fan-out, in that order - both add
      real compile surface on top of the march loop.
      **Update 2026-08-28, next session's log**: partial. Both `-> maze`
      transitions in the new session (`audiovis-session-2026-08-28-12-06-20.json`)
      still spike - 259.8ms at t=44.5s and 264.7ms at t=117.0s - well down
      from the 1877.8ms this fix was written against, but not gone, and NOT
      shrinking on the second occurrence within the same session, which a
      pure compile-cache theory would predict. See F138: the recompile
      likely was not the only cost, or not the dominant one.

- [x] **F138 - Every "budgeted" (offscreen-render) scene allocates a fresh
      GPU render target, scene graph, and second shader from scratch on
      every mount, uncached** - `src/engine/createShaderScene.tsx`
      *(fixed 2026-08-28, unverified live)*
      Follows directly from F137: if maze's ~260ms mount-time freeze were
      purely the raymarch shader recompiling, the SECOND `-> maze` mount in
      the same session (t=117.0s, same log) should have been fast - three's
      `WebGLPrograms` cache reuses an already-compiled program for
      byte-identical shader source, and maze's source doesn't change between
      mounts. It wasn't faster (264.7ms, if anything slightly worse than the
      first mount's 259.8ms), which means the shader recompile is not the
      only expensive thing happening, or not the dominant one.
      Reading `createBudgetedScene` (the wrapper every `pixelBudget`-declaring
      scene goes through, maze included) explains why: on every mount it
      `useMemo`s a SECOND `THREE.ShaderMaterial` (`displayMaterial`, the blit
      that composites the offscreen buffer onto screen - trivial shader,
      unlikely to be the cost) AND a `THREE.WebGLRenderTarget` (HalfFloatType,
      no depth/stencil) plus a nested `THREE.Scene`/`Mesh`/
      `OrthographicCamera` to render into it. None of this is cached across
      mounts - a fresh React mount means a fresh `useMemo`, meaning a fresh
      GPU texture + framebuffer allocation every time, sized to whatever the
      solved scale resolves to on the first `useSceneFrame` tick. Real texture
      allocation is known to be capable of synchronous driver-side cost on
      D3D11/ANGLE, independent of and additional to shader compilation, and
      unlike a compiled shader program there is no cache making the second
      allocation cheaper than the first.
      Fixed by hoisting the render target, its offscreen scene/camera, and
      the blit `displayMaterial` out of the component's `useMemo` into a
      module-level `getBudgetedRT(gl, spec.id, blending)`, cached in a
      `Map` keyed by scene id inside a `WeakMap` keyed by the renderer
      itself. A mount now looks up (or, once per scene id per renderer,
      creates) the shared target instead of allocating a new one; the
      offscreen mesh's `geometry`/`material` are repointed at the current
      mount's instances every time (those two remain per-mount and are still
      disposed on unmount via `useDispose`, unchanged). Context loss remounts
      `SceneManager` under a brand new `WebGLRenderer`, so the old renderer —
      and everything cached under it — simply becomes unreachable and is
      garbage collected; no explicit invalidation needed, and skipping
      `.dispose()` on that path costs nothing real since the lost context
      already invalidated the GPU resources first. Never evicted on the live
      path either, matching the existing "pay once, keep it" treatment
      `SceneManager` already gives pinned effect scenes — the budgeted scenes
      are a fixed, small set.
      Verified by `npm run check` (764 tests, clean build) only. UNVERIFIED
      live: whether this actually removes the repeat freeze needs a fresh
      session log with a second `-> maze` (or any other budgeted scene)
      transition to compare against this session's 259.8ms/264.7ms pair.

      Update 2026-08-28, still unverified: two rounds of post-fix session
      logs (`...17-35-06`, `...17-48-50`) still showed ~1.8-1.9s maze
      freezes, looking like a regression - traced instead to the user
      testing against stale dev servers left running on ports 5183/5184
      from earlier in the day (neither had today's commits). Killed both,
      confirmed only the correct server (5185, `44ecdd7` onward) was left
      running. A third log (`...18-05-27`), confirmed by the user to be
      from 5185, is clean of any giant freeze (worst frame 212.6ms all
      session) - but its scene rotation (wireframe, pointcloud, chrome,
      plasma, wingfold, dissolve, kifs) never once visited `maze` or
      `malachite`, the only two scenes that declare `pixelBudget` and
      therefore the only two this fix touches. `chrome`'s repeat-mount
      cheapness in that log was initially misread as indirect confirmation
      - checked against `scenes/index.ts` and `ChromeFormScene.tsx` before
      writing it up, and chrome has no `pixelBudget`, so it never goes
      through `createBudgetedScene`/`getBudgetedRT` at all. Its cheap
      repeats are just three's ordinary compiled-program cache, unrelated
      to this fix. F137/F138 remain completely unverified either way -
      still need one live session log that actually lands on maze or
      malachite after a prior scene has already played.

      Update 2026-08-28, mount-time freeze CONFIRMED FIXED: a fourth log
      (`...18-23-22`, confirmed 5185) finally lands a `matrix -> maze`
      transition at t=131.66s. The mount itself is clean - the very next
      sample (t=131.81s) reads 16.57ms, no spike at all. That is the
      direct, live confirmation this fix was waiting on. See F139 below,
      though, for a second and much worse freeze that hits the same scene
      about 2.3s later, unrelated to the mount.

- [x] **F139 - `MazeFlightScene`'s hard `raymarchSteps >= 50` pixelBudget
      threshold sits exactly on a tier boundary, so a normal DEMOTE snaps
      its render target through a discontinuous cut in one frame - lands
      on a confirmed 2.1s stall, worse than the original bug, though the
      full mechanism behind that magnitude is still unverified** -
      *(resolved 2026-08-29 - root cause was F144, not this entry's own
      cliff theory; see the closing update below and F144 itself)* -
      `src/scenes/MazeFlightScene.tsx:424`, `src/engine/quality.ts`,
      `src/engine/createShaderScene.tsx:416-429`
      *(found 2026-08-28, correlation confirmed, not fixed)*
      Originally opened as a vaguer "worst frames cluster on tier/scale
      changes" observation with no maze data. The `...18-23-22` log
      (confirmed 5185) supplies the maze case directly, and it's the worst
      single frame recorded in ANY session this whole investigation:
      **2102.6ms** at t=133.5s (raw `frameTimesMs`, not the sampled
      tracker - the tracker only caught the *next* 4Hz sample at 120.9ms,
      a 17x undercount). It lands exactly on the `tier DEMOTE 2->3` event
      at t=133.95s, which fires `scale: 0.57 -> 0.42` in the same tick.
      The scene's own transition tracker confirms real main-thread
      blocking, not just a slow composite: the `matrix -> maze` `smear`
      transition, targeted for 1.05s, is logged as `transition-end ...
      completed in 3.03s` - something froze the frame loop itself for
      roughly two seconds.
      Root cause, found by reading `quality.ts` next to
      `MazeFlightScene.tsx`: the five tiers' `raymarchSteps` are
      `[96, 72, 54, 40, 28]` (tier 0..4), and tier transitions interpolate
      it continuously (`d.raymarchSteps = Math.round(mix(base, cheaper))`
      in `quality.ts`). But maze's `pixelBudget` spec reads that knob
      through a hard cutoff: `() => (quality.knobs.raymarchSteps >= 50 ?
      0.9 : 0.55)`. Tier 2 (54) sits just above the cutoff, tier 3 (40)
      just below it - so the ONE demote that everyone else's smooth
      `mix()` interpolates gently, maze turns into a discontinuous ~1.6x
      cut to internal megapixels (0.9 -> 0.55 budget) delivered as a
      single `target.setSize()` call, exactly on that tick. That resize -
      landing on a scene that also has `background: malachite` /
      `accent: ribbons` layers active and is mid-cross-fade with the
      previous scene - is what's taking upwards of two seconds, though
      the exact mechanism inside that (driver-level texture reallocation,
      a synchronous shader step, or a GC pause from the resulting
      garbage) hasn't been isolated yet; that's the next thing to check
      if a fix here doesn't fully resolve it.
      Two smaller corroborating maze stalls same session: 130.8ms at
      t=138.8s (near the following `promote 3->2`, recrossing the same
      50-step boundary the other direction) and 67.5ms at t=144.4s (near
      a `DEMOTE 1->2` + scale change while still in maze).
      Not fixed yet. Caveat found while drafting the obvious fix (replacing
      the hard `>= 50` cutoff with a lerp over the tier 2/3 `raymarchSteps`
      range, 40..54): checked `quality.ts`'s `applyKnobs()` and that
      `mix()` interpolation only runs while `this.discount > 0` (an
      active crossfade). A bare `setTier()` - which is what `DEMOTE 2->3`
      actually is here - sets `this.knobs = base` directly, so
      `raymarchSteps` jumps straight from 54 to 40 in one synchronous
      step with no intermediate frames outside a crossfade. A lerp over
      that range would map both endpoints to the exact same 0.9/0.55
      values as today and change nothing for this specific event - it
      would only help the crossfade-blended case, which isn't the one
      that stalled here. `pixelBudget()` itself is also read fresh every
      frame with no smoothing anywhere in `createShaderScene.tsx`
      (confirmed: `budget = pixelBudget()` then an immediate
      `rt.target.setSize()` the instant width/height changes), so a real
      fix needs to smooth the OUTPUT budget over wall-clock time (e.g. a
      per-mount ref that lerps toward the target, rate-capped per
      second) rather than the raymarchSteps input, decoupling resize rate
      from how discretely the tier itself changes.
      That still wouldn't explain why the resize costs ~2s in the first
      place, though - `WebGLRenderTarget.setSize()` plus a lazy
      `texImage2D` reallocation on next render should cost low
      milliseconds even at several megapixels, not seconds. Smoothing the
      jump would likely mask the symptom by spreading it across more,
      smaller frames, but the actual expensive operation underneath
      (driver-level reallocation, a synchronous shader step, or a GC
      pause) hasn't been isolated. Needs a real profile (Chrome
      performance recording) captured while reproducing a maze tier
      2->3 demote before committing to a fix here.

      Update 2026-08-29, partial hard fix (user directive, not a profiled
      root-cause fix): the user asked that maze's fractal density,
      complexity, and nesting never degrade under quality load, full stop
      - independent of whether that's confirmed to be the stall's actual
      cost driver. Implemented in `MazeFlightScene.tsx`'s `update()`:
      `uDetail.value` (nesting depth, gated `if (uDetail > 0.25)` /
      `if (uDetail > 0.75)` in the shader for the CELL/3 and CELL/9
      levels) now reads straight from `P.complexity`, the user's own dial,
      with the tier-derived `detailCap` ladder deleted outright.
      `uDensity` was already untouched by tier (`P.density * 1.5` only),
      so it needed no change. `marchStepsFloor` still exists (F132's
      correctness floor, needed whenever nesting is on so rays converge in
      the tighter recesses a nested scale carves) but now keys off the
      unconditional `uDetail.value` instead of the deleted `detailCap`.
      `npm run check` clean (764 tests, build passes).
      This does NOT touch `pixelBudget` (`src/scenes/MazeFlightScene.tsx:
      424`) - the tier-50 cutoff that actually fires the resize believed
      to cause the 2.1s stall is still in place, untouched, out of scope
      for this pass per the user's explicit request ("implement that as a
      hard fix first" - complexity/density/fractals first, resolution
      later if at all). So: maze's GEOMETRY can no longer flatten under
      load, but the stall itself is still unverified as fixed - the
      profile this entry called for is still the way to confirm whether
      resolution alone (now the only degrading axis left) still triggers
      it, or whether removing the complexity coupling was enough to avoid
      whatever the pixelBudget jump was actually triggering.

      Update 2026-08-29, newest log (`...18-45-39`, captured AFTER both the
      complexity fix above and F141) - the stall recurred, worse: **1872.4ms**
      at t=124.8s, `maze t3 x0.57`. So neither fix touched it, as expected
      (this entry never claimed they would). But this log isolates the cause
      more precisely than `...18-23-22` did, and the isolation points AWAY
      from the pixelBudget-cliff-crossing theory above, not toward it:
        - `chrome -> maze` (`transition-start dissolve (1.04s)`) fires at
          t=122.87s. Cross-referencing every `scene` event this session:
          that is maze's ONLY appearance as a primary, start to finish - it
          was never mounted earlier in these 136s.
        - The 1872.4ms frame lands at t=124.8s, ~1.9s INTO that dissolve,
          not on it starting. `tier DEMOTE 2->3` - the event this entry's
          cliff theory blames - doesn't fire until t=125.06s, ~260ms AFTER
          the giant frame. Given tier decisions react to recently-observed
          frame times, the more likely direction is the stall caused the
          demote, not the other way around - the opposite of what was
          assumed above.
        - Raw `frameTimesMs` around the spike (indices 7177-7299,
          checked directly, not just the summary table): a clean run of
          ~16.7ms frames, ONE frame at 1872.4ms, then immediate recovery
          (61.2ms, 6.7ms, 9.2ms, back to ~16-20ms within ten frames). A
          resize-driven or per-pixel-cost theory predicts sustained
          elevation at the new budget/resolution, not a single isolated
          spike with instant recovery - this shape is the signature of a
          one-shot blocking call (a pipeline/shader compile, a synchronous
          allocation, or a GC pause), not an ongoing per-frame cost.
        - Checked whether the complexity fix above made maze's shader more
          expensive to COMPILE (as opposed to more expensive to run) -
          it doesn't: `if (uDetail > 0.25)` / `if (uDetail > 0.75)` in the
          fragment shader are ordinary uniform-gated runtime `if`s, not
          `#if` preprocessor branches, so both nested-detail code paths
          were already present in every compiled build of this shader
          regardless of what `uDetail` holds at runtime. Ruled out.
      Current best explanation: a cold GPU pipeline compile/link stall on
      maze's first real, full-resolution, visible draw call this session -
      plausible on this session's ANGLE/D3D11 backend (`env.gpu`:
      "ANGLE (NVIDIA... Direct3D11 vs_5_0 ps_5_0, D3D11)"), which is known
      to sometimes defer real shader compilation past `linkProgram` to the
      first draw call that actually exercises the program at production
      settings. If so, `SceneManager`'s warm-mount (F136/F141) isn't fully
      covering primaries the way it's meant to - either the warm phase
      renders into a placeholder-sized target that doesn't force the same
      driver-side compile a full-size draw does, or `WARM_FRAMES` finishes
      (`isWarmComplete`) before the actual compile has settled. Unconfirmed
      - this is a hypothesis consistent with the evidence above, not a
      profiled root cause. No browser-profiling tool is available in this
      environment (checked: no puppeteer/playwright in `package.json` or
      `node_modules/.bin`) to capture one directly.
      Next step, unchanged in kind from before but now sharper: a Chrome
      DevTools Performance recording spanning one `chrome -> maze` (or any
      cold-primary) switch, to see whether the 1.8s+ block shows as
      "Compile Shader" / "Program Link" in the GPU track, a long JS task, or
      a GC pause - needed before writing any fix, since the three would be
      fixed in completely different places (driver/compile-ahead scheduling
      vs. `createShaderScene.tsx`'s resize path vs. allocation pressure
      somewhere in the scene's own `update()`).

      Update 2026-08-29: the "compile stall" branch of this guess is now the
      confirmed one. F143 shipped the resize fix this entry's other branch
      called for, and a fresh log still shows the full ~1.9s stall landing
      BEFORE any resize event under F143's code - the resize-cliff theory
      this entry originally centered on is disproven, not just superseded.
      Full trace, and what's actually left to do about it, is in F144.

      Closed 2026-08-29: F144 found and fixed the actual mechanism (every
      scene's compiled shader PROGRAM was destroyed on every unmount and
      rebuilt from scratch on every remount - invisible for cheap shaders,
      the exact multi-second freeze here for maze's raymarching one), and a
      live 180s/10448-frame log confirmed clean across 8 remounts of 4
      other scenes, with the session's only remaining stall landing on a
      scene's first-ever mount - exactly what F144's fix was never going to
      touch by definition. F145 (same day) moved that unavoidable first-
      compile cost to boot for maze specifically, off the critical path
      entirely. This entry's own cliff/resize theory is disproven per the
      update above; closing here rather than leaving it open under a root
      cause it never actually had.

- [ ] **F140 - Worst frame times cluster on tier-DEMOTE / render-scale-change
      events on an already-mounted scene, not on scene mounts** -
      `src/engine/renderScale.ts`, `src/engine/createShaderScene.tsx`
      *(found 2026-08-28, not fixed)*
      In the clean `...18-05-27` log (confirmed on the correct 5185 server,
      no giant freezes), the four worst single frames of the session -
      212.6ms (t=20.8s, chrome, tier DEMOTE 1->2 mid-`dipToBlack`, scale
      0.60->0.75), 185.2ms (t=144.3s, dissolve, scale 0.41->0.50, DEMOTE
      3->4 half a second later), 142.3ms (t=102.3s, wireframe, scale
      change + DEMOTE 3->4 landing ~0.8s later), 94.3ms (t=153.6s, chrome,
      scale jump 0.43->0.63 right before a scene-switch request) - all sit
      next to a render-scale or tier change on a scene that was NOT being
      freshly mounted. This session also ran `qualityMode: "auto"`, far
      chattier than the "high" logs seen earlier (49 tier changes / 57
      scale changes in 195s, vs a handful before), and spent 47% of frames
      over its own frame-time budget, both notably worse than prior "high"
      logs (12-16% over budget).
      Originally guessed this was `WebGLRenderTarget.setSize()` cost, the
      same class of allocation F138 found at mount time - but checked
      against `scenes/index.ts`: chrome, dissolve, and wireframe are NOT
      `pixelBudget` scenes (only maze and malachite are, per the earlier
      correction in the F138 update above), so none of these four frames
      go through `createBudgetedScene`'s offscreen render target at all.
      Whatever is costing 100-200ms here on plain (non-budgeted) scenes at
      a tier/scale change must be something shared by every scene instead
      - the main canvas resize / DPR change, or a cost generic to the
      tier-demote step itself (e.g. a uniform/branch change forcing a
      shader recompile on affected scenes). Separately, F139 below found
      and confirmed the budgeted-scene case directly, with a much larger
      (2.1s) stall and a concrete root cause specific to `pixelBudget`
      scenes - this entry's four frames are NOT explained by that fix and
      remain a distinct, smaller, still-open question about plain scenes.
      Needs: profile a tier-demote on a non-budgeted scene (e.g. chrome)
      directly to see what's actually expensive - canvas resize, DPR
      change, or something tier-change-specific - since the render-target
      theory that motivated this entry doesn't apply to these particular
      frames.

      Update 2026-08-29: F147 (same day, `src/engine/createShaderScene.tsx`)
      found and fixed the render-target-reallocation-on-DPR-change hazard
      for maze's OWN offscreen target - `RenderTarget.setSize()`, verified
      directly in three's source, unconditionally `.dispose()`s and forces
      a real GPU teardown-and-recreate whenever width/height actually
      change. That fix was scoped to one scene's one render target, but the
      SAME hazard applies, at a much larger scale, to every buffer the
      shared `EffectComposer` owns - `inputBuffer`, `outputBuffer`, the
      depth target, Bloom's whole mip pyramid, the feedback pass's history
      buffer, the mirror/lens racks' own targets - because `postprocessing`'s
      `EffectComposer.setSize()` (verified in `node_modules/postprocessing`)
      unconditionally calls `.setSize()` on every one of those on every
      invocation, and each one independently reallocates the instant the
      renderer's drawing-buffer size (CSS size x DPR) actually differs from
      what it already has. Every scene in the roster shares one composer,
      so THIS reallocation storm - not a per-scene one - is the "something
      shared by every scene" this entry went looking for, and it fires on
      literally every tier/render-scale step, budgeted scene or not, which
      lines up with the frequency this entry already measured (49 tier
      changes / 57 scale changes in 195s under `auto` mode).
      Not fixed here: unlike maze's single target, the composer's buffers
      live inside a third-party library (`postprocessing`, not
      `@react-three/postprocessing` - confirmed by reading both) - there is
      no exposed hook to make ITS `setSize()` grow-only the way F147 did for
      one target by hand, and the alternative (stop resizing the actual
      canvas/drawing-buffer on a DPR step and express render-scale purely
      via viewport/scissor across the whole post chain instead) is a
      genuinely bigger, engine-wide change to how `PerfMonitor`/`renderScale`
      apply resolution, not a contained fix like F147's. Flagging with the
      concrete mechanism now confirmed, for whoever picks this up next -
      it's very likely the single biggest remaining item in this whole
      performance investigation, bigger than anything F136-F147 individually
      found, precisely because it is paid on every scene's every tier step
      rather than one scene's occasional pixelBudget cliff.

      Update 2026-08-29 (later same day): went back to actually attempt
      F147's fix here before giving up on it, rather than assuming it
      wouldn't transfer. It doesn't, and the reason is structural, not a
      missing hook to find harder. F147 worked because `createBudgetedScene`
      had ALREADY built its own viewport/scissor sub-rect abstraction (the
      "active" rect vs. the "full" allocated target, with `uUvMax` sampling
      only the active part) - grow-only just meant "the full allocation can
      be bigger than currently needed, because the active rect already
      knows how to be smaller than the buffer it lives in." Read
      `postprocessing`'s pass hierarchy directly (`node_modules/
      postprocessing/build/postprocessing.js` and the base `Pass.setSize()`)
      looking for the same abstraction at the composer level: there isn't
      one. Every pass - `RenderPass`, `EffectPass`, Bloom's mip chain,
      the feedback/mirror/lens racks - assumes buffer size EQUALS render
      size throughout; `EffectComposer.setSize()` just forwards the new
      drawing-buffer size to every one of them with no sub-rect concept
      anywhere. A grow-only allocation with nothing downstream that knows
      how to render into only PART of it would either silently upscale the
      canvas past its own size or require building that whole sub-rect
      abstraction into a third-party library's rendering path by hand -
      not a targeted patch, a fork.
      Also refined, not just confirmed, why the frequency matters: each
      individual buffer's own `RenderTarget.setSize()` (verified in three's
      source, same as F147) only actually disposes/reallocates when its
      width/height differ from what it already has - so a `renderScale`
      change that rounds to the SAME integer pixel dimensions as before
      (plausible for a small scale delta) is a cheap no-op through this
      whole chain, not a reallocation. This entry's real reallocation count
      is therefore likely somewhat LOWER than "49 tier changes / 57 scale
      changes in 195s" taken at face value - some fraction of those land as
      no-ops - but the CASES that do change integer dimensions still pay
      the full multi-target reallocation storm, and there is no
      instrumentation in place to say what that fraction actually is
      without a live profile.
      **Staying open, not attempted:** the only two real options are
      patching/forking `postprocessing`'s render-pass hierarchy to add a
      sub-rect abstraction it was never built with, or redesigning how
      `PerfMonitor`/`renderScale` apply resolution engine-wide so the actual
      canvas/drawing-buffer stops resizing on a DPR step at all - both
      genuinely large, both touch every scene and every frame, and neither
      is verifiable without a live browser in this environment. Taking
      either on unverified would be a real risk to a render pipeline this
      session has already spent significant effort hardening (F136-F147),
      for a fix that could easily be wrong in a way `npm run check` cannot
      catch (a passing test suite proves nothing about whether a resize
      still looks correct on a real screen). Left for whoever picks this up
      with access to a real browser and a profiler - the mechanism is now
      fully understood; what's missing is verification, not diagnosis.

      **Update 2026-08-30: confirmed at 100%, and the missing number is now
      measured - it is 105 of 105.** Session
      `audiovis-session-2026-08-29-16-29-40` (320s, 18732 frames, quality
      setting `high`, same RTX 4060 / ANGLE-D3D11 machine): of the **213
      frames over 33ms, every single one - 213/213 - lands within 2s of a
      tier, render-scale or scene-commit event.** Nearest-event attribution
      is 134 tier changes, 60 scale changes, 19 scene commits. There is not
      one slow frame anywhere else in the session.

      The other half of the same measurement is what makes it decisive: in
      every window more than 1.5s away from any such event, frame time is a
      flat **16.66-16.70ms mean, p95 16.67-16.76** - vsync-locked 60fps -
      at every internal resolution from 1.3 MP to 7.8 MP. So on this
      hardware the roster does not have a steady-state cost problem at all.
      Everything the HUD shows as amber is this entry's reallocation storm
      and the governor's reaction to it.

      **The open question this entry ended on - what fraction of scale
      changes land on the same integer buffer dimensions and are therefore
      cheap no-ops - is zero.** All 105 scale changes in the session
      reallocate. `solveRenderScale()` quantises to 0.01 of LINEAR scale;
      on this 2560x1440 display at `baseDpr` 1.5 one such step is
      `2560 * 0.01 * 1.5 = 38px` of drawing-buffer width, so no two adjacent
      rungs can ever round to the same integer size. 27 distinct DPR values
      were applied over the session. The renderScale.ts doc comment's own
      justification for the 1/100 quantum - "a display measured one CSS
      pixel differently must not buy that [a full reallocation]" - holds for
      measurement wobble but does nothing for governor wobble, which is
      where all 105 of these came from.

      **A quantisation fix looked available here. It was measured, and it is
      not worth shipping** *(2026-08-30, same pass)*. The idea was to quantise
      the render scale to the DRAWING BUFFER's integer dimensions rather than
      to 0.01 of linear scale - snap the width to a multiple of 64 or 128px -
      so the governor's small oscillations became genuine no-ops through the
      whole `EffectComposer.setSize()` chain, without touching the
      third-party library. One pure function, existing test file.

      Replaying the session's own 105 scale changes through each candidate
      quantum says it barely does anything:

        quantum    1px (today)   105 reallocations
        quantum   32px           105
        quantum   64px           105
        quantum   96px           104
        quantum  128px           103
        quantum  192px           100
        quantum  256px            91

      Because the governor's moves are not small. They are 0.84 -> 1.00,
      1.00 -> 0.91, 0.91 -> 0.75 - deliberate tier steps, each one far wider
      than any quantum worth having. A 256px quantum on this display is 6.7%
      of linear scale, a visible resolution step, and it still only removes
      13% of the reallocations. The premise that these were rounding wobbles
      was wrong.

      **What the churn actually is: 97 of the 105 scale changes follow a TIER
      change within 3.6s** (the remaining 8 follow a scene commit or a layer
      change). `RENDER_SCALE_HOLD_SEC` is 3, so a tier change and the resize it
      causes are up to three seconds apart, which is why a naive co-occurrence
      window misses the link. The render-scale ladder is not an independent
      source of reallocations at all - it is the tier ladder's output. Cutting
      the count means making fewer TIER decisions, which is **F149**, and that
      is where this entry's frequency problem is now filed.

      **That last sentence is too strong, and the next session disproved it**
      *(2026-08-30, third pass)*. `...22-20-11` records **37 render-scale changes
      against ZERO tier changes** - a ladder that never moved, and 17.1 scale
      changes per minute anyway. So the render-scale ladder is NOT simply the
      tier ladder's output; with the tier ladder quiet, composition events (scene
      commits, layer admits and drops, each moving `combinePixelBudgets`) drive
      the churn entirely on their own.

      What survives is the part about COST, and it is the part that matters:

        session      scale changes   tier changes   frames >33 ms
        16-29-40     105 (19.7/min)  84 (15.8/min)  212
        22-12-12      35 (15.0/min)  17  (7.3/min)   26
        22-20-11      37 (17.1/min)   0  (0.0/min)    0

      Same reallocation rate in the last two rows; 26 bad frames against none.
      The reallocations that hurt are the ones the TIER ladder drives, because
      those are the ones that happen at 2.8-4.1 MP and land stacked on a frame
      that is already over budget. The composition's own resizes are frequent,
      cheap, and cost nothing measurable.

      That refines this entry rather than closing it: the frequency is not the
      defect, the frequency AT HIGH RESOLUTION UNDER LOAD is. F149 removed most
      of those, and F157 below is what is left of them.

- [x] **F141 - Composition layers (background/accent/overlay) skip the
      warm-mount system entirely and compile their shader live, on whatever
      frame the director happens to request them - which is usually the
      same frame as a primary crossfade and/or a tier change, stacking a
      cold compile on top of both** - `src/engine/SceneManager.tsx`
      *(fixed 2026-08-29)*
      Found by reading `SceneManager.tsx` end-to-end after a fifth session
      log (`...18-35-09`, post-F139-complexity-fix) showed its two worst
      frames - 276.8ms and 270.5ms, both worse than anything F139 predicted
      - landing on `chrome` and `maze`, neither a budgeted (`pixelBudget`)
      scene and neither near a maze tier-2/3 boundary. F139's fix (density/
      complexity locked to the user dial) is confirmed working - maze's
      worst frame all session was 43.1ms - but these two frames prove
      something else, bigger, was still there.
      Traced the 276.8ms frame to its events: `maze -> chrome` primary
      crossfade starts, `background: + malachite` fires 10ms later,
      `background: - malachite` fires 190ms after THAT (the director
      changed its mind almost immediately), and a `tier DEMOTE 2->3` lands
      in the same window - four unrelated systems' costs landing on the
      same handful of frames. The `270.5ms` frame is the same shape:
      `chrome -> pointcloud -> maze` (a transition re-targeted before the
      first one settled) plus a tier demote, all inside 400ms.
      Root cause: every OTHER mount in this file - the primary scene
      switch, at minimum - goes through a warm-then-promote handoff
      (`EntryGroup`/`WARM_FRAMES`/`prewarmShaders`, all keyed on
      `isWarmComplete`): mount invisibly, let the shader compile over a few
      frames, only then make it visible. `resolveLayerIds`'s caller pushed
      new background/accent/overlay entries straight in at `dir: 1` -
      immediately visible, first frame it exists, whatever frame that
      happens to be. That is exactly the failure mode F136's header
      comment describes for primaries ("a multi-hundred-millisecond
      freeze, landing exactly on the beat") - just never fixed for layers,
      because `resolveLayerIds`/`composeLayers` react to musical moments
      (mood/phrase changes) the same way tier changes and primary switches
      do, so a cold layer compile lands stacked on other real work far more
      often than chance would predict.
      Fixed by giving layers the identical warm-then-promote step
      primaries get (not the streamer bookkeeping - `sceneStreamer` stays
      primary-only, per the existing comment on why): a newly-wanted layer
      now mounts at `dir: 0`, and the loop that used to unconditionally
      push it at `dir: 1` instead waits for `isWarmComplete` before
      promoting it (fading in, retiring whatever currently holds the
      role). A stale warming candidate - the director changed the desired
      layer again before the old one finished compiling - is dropped
      outright, since it was never visible. No new machinery: `EntryGroup`
      already renders any `dir: 0` entry invisibly regardless of role, and
      the per-frame `warmFrames`/`sceneStreamer.noteLoaded` tick already
      runs over every `dir: 0` entry (idle pinned effects already relied on
      this) - the bug was purely that layers never entered that state.
      `npm run check` clean (764 tests, build passes). UNVERIFIED live:
      needs a session log with a `layer: +` event landing near a primary
      crossfade or tier change to confirm the stack no longer compounds.

- [x] **F142 - Lens rack hard-disabled by explicit request ("look so
      horrible")** - `src/engine/LensPass.ts` *(disabled 2026-08-29)*
      Not a bug - an art-direction kill switch. The lens materials
      (`opticalDirector.ts`'s `lensForSection`/`lensAmountTarget`) can be
      engaged from three independent places: the section director, the
      `melt` transition rack (`transitions.ts`), and the debug panel
      (`Console.tsx`/`HUD.tsx` writing `lensAmount`/`lensStyle` into the
      store). Rather than disabling each source separately, added a single
      `LENS_HARD_DISABLED` flag inside `LensPass.advance()` - the one choke
      point every source's resolved `LensRackState` flows through right
      before `this.enabled` is set for the render. With the flag on,
      `advance()` always sets `enabled = false` regardless of what any
      caller computed, so the pass costs nothing and never renders. The
      director/rack functions themselves are untouched (still fully tested
      by `opticalDirector.test.ts`/`transitions.test.ts`), so this is a
      one-line revert (`LENS_HARD_DISABLED = false`) whenever the look is
      revisited - no logic to reconstruct.
      `npm run check` clean (764 tests, build passes).

- [x] **F143 - `pixelBudget` resolution changes were resizing a LIVE,
      cached WebGLRenderTarget every tier/scale change - the actual cause
      of F139's multi-second maze stalls, and a regression from F138** -
      `src/engine/createShaderScene.tsx` *(fixed 2026-08-29)*
      Root cause, found by reading F138's own diff after the user pointed
      out the stalls only started once "the res" changed and weren't there
      before: before F138, every scene mount created a BRAND NEW
      `WebGLRenderTarget`, always at `(1,1)` then immediately `setSize()`'d
      to the right dimensions on its first frame - so nothing already
      resident on the GPU ever changed size; a "resize" was really a fresh,
      correctly-sized allocation every time. F138 (committed 2026-08-28
      18:17, to fix a DIFFERENT bug - a second mount of the same scene
      paying full allocation cost again) cached that render target per
      scene id and reused it across mounts. That's the right fix for
      re-mount cost, but it means the SAME `setSize()` call - still fired
      on every `pixelBudget`-driven tier/render-scale change, of which
      there are dozens a minute per the session logs - now resizes an
      existing, previously-rendered-into target instead of allocating a
      fresh one. Resizing a live WebGLRenderTarget forces the driver to
      tear down and recreate its backing texture/framebuffer, and on some
      backends that carries an implicit sync point - a well-documented
      class of WebGL hitch, and exactly the shape of what F139 found: one
      isolated 1000ms+ frame with instant recovery next frame, not a
      sustained per-pixel cost. This session runs ANGLE/D3D11
      (`env.gpu`), which is specifically called out in WebGL performance
      literature as prone to exactly this on framebuffer/texture
      recreation.
      Confirmed against the `...18-45-39` log's raw evidence (see F139's
      last update): the 1872.4ms frame is a single spike with instant
      recovery, and it lands on `chrome -> maze`'s dissolve, which is also
      maze's only mount all session - consistent with the FIRST tier/scale
      change maze sees after (re)acquiring its cached, differently-sized
      target from a previous browser-session mount.
      Fixed using the standard real-time-graphics technique for dynamic
      resolution scaling (confirmed against WebGL/three.js/Unity sources -
      see chat for citations): stop resizing the render target for budget
      changes at all. `getBudgetedRT`'s target is now sized to the FULL
      canvas (`size.width * dpr`, `size.height * dpr`) and only ever
      `setSize()`'d on a genuine canvas/DPR change - a rare, user-driven
      event, not a quality-governor one. A `pixelBudget` change instead
      writes `target.viewport`/`target.scissor` (both `Vector4`s three
      ships on every `RenderTarget` for exactly this) to the smaller
      active rectangle - `WebGLRenderer.setRenderTarget()` reads these
      directly with no texture/framebuffer work at all, confirmed by
      reading `RenderTarget.js`/`WebGLRenderer.js` in `node_modules/three`
      (v0.178.0) directly rather than assuming the API. The display/blit
      pass (`DISPLAY_FRAG`) gained a `uUvMax` uniform so it samples only
      the written sub-rectangle of the now-oversized texture, inset half a
      texel so linear filtering can't bleed into the stale remainder.
      Also found, NOT fixed (out of scope for this pass, flagged for
      follow-up): `FoldPathScene.tsx` and `SynthGridScene.tsx` each carry
      their own independent copy of a render-target-plus-`setSize()`
      pattern, outside `createShaderScene.tsx` entirely - grep for
      `rt.target.setSize` turns up both. Neither has been implicated in a
      logged stall yet, but they're the same shape of hazard and should
      get the same fixed-target-plus-viewport treatment if either shows up
      in a future log.
      `npm run check` clean (764 tests, build passes). UNVERIFIED live:
      needs a session log spanning a maze (or any pixelBudget scene)
      tier/scale change to confirm the multi-second stall is gone; the
      three.js API usage was verified by reading the library source, not
      by exercising it in a browser.

- [x] **F144 - Every scene's compiled shader PROGRAM was destroyed on every
      unmount and rebuilt from scratch on every remount - invisible for
      cheap shaders, the actual ~2s maze freeze once the trail led past
      F143's resize theory (disproven) and F137's compile-time theory
      (right diagnosis, no working fix yet)** - `src/engine/createShaderScene.tsx`
      *(fixed 2026-08-29)*
      A brand-new log (`...07-01-02`, captured well after F143 landed)
      still shows the full-magnitude stall: **1893.7ms** at t=77.6s,
      `kifs -> maze`. Checked the raw `frameTimesMs` directly: the
      blocking frame STARTS at t=76.114s (14ms after the `kifs -> maze`
      scene-switch event) and doesn't return until t=78.007s. The first
      `scale` event of this switch doesn't fire until t=78.06s - AFTER
      the stall has already resolved. Under F143's fix, no `pixelBudget`
      change resizes anything, so there is nothing left for that fix to
      have caught here even in principle - this single log both confirms
      F143 works as designed AND proves it was never going to fix this
      particular freeze.
      This sent the investigation back to F137, which turns out to have
      already diagnosed the actual mechanism correctly, in detail:
      `shaderPrewarm.ts` already refuses to trust `WebGLProgram.isReady()`
      on this exact driver (ANGLE/D3D11, no working
      `KHR_parallel_shader_compile`), so the warm-mount window forces a
      REAL synchronous `compileShader`/`linkProgram` call - and because
      that call is genuinely synchronous and single-threaded, a multi-
      second compile freezes the entire app (including whatever was
      already on screen) no matter which scene's shader is compiling or
      how the mount is scheduled. F137's own log evidence: the original
      1877.8ms stall, `MAX_STEPS` lowered 150 -> 96 as "the most
      defensible lever to try first" (explicitly flagged unverified), and
      a follow-up log did show a big drop - 259.8ms and 264.7ms, ~85%
      down from 1877.8ms.
      What's new here: that improvement did not last, and the shader
      source hasn't structurally changed since. `git log` on this file
      shows nothing between `eb764ba` (F137's fix, 2026-08-28 17:30) and
      `0454b22` (F139's complexity fix, 2026-08-29 00:03) except that one
      complexity commit - and that commit only changes what VALUE
      `uDetail` is assigned in `update()`, not the GLSL template string;
      both nesting branches (`if (uDetail > 0.25)` / `if (uDetail >
      0.75)`) were already compiled in either case (confirmed when writing
      F139's update above). So the shader `WebGLPrograms` would compile
      from has been byte-identical since F137 shipped - yet this session
      measured ~1900ms, not ~260ms. A code regression can be ruled out.
      Best remaining explanation, consistent with everything observed:
      Chromium/ANGLE keep a DISK-persisted shader compile cache alongside
      the in-memory one three.js manages. F137's "next session" log that
      measured ~260ms was very plausibly a warm-cache hit - the developer
      reloading the page repeatedly during that dev session, with the
      first cold compile of the day already paid before the log started
      recording - while a log capturing a genuinely fresh compile (cache
      evicted, a different profile, cache cleared, whatever the actual
      trigger) hits the true ~1.9-2.1s cold cost every time. This would
      explain both F137's real-looking 85% improvement AND its total
      disappearance without any further code change - and it would mean
      `MAX_STEPS` 150 -> 96 was never actually the fix; the "next session"
      log just happened to run warm. Not confirmed - would need to force
      a clean profile (or `chrome://gpu` cache clear) immediately before
      a repro to tell a real fix from a warm cache, and no tool for that
      is available in this environment.
      The above (everything through the disk-cache paragraph) was where this
      entry stood when it was presented to the user as a shader-complexity
      trade-off decision. The user pushed back with a sharp, correct
      question: maze worked without this freeze before "the res" work
      started, so why treat "reduce complexity" as the only lever. That
      pushback was right - re-reading the data instead of re-asserting the
      conclusion surfaced the actual bug.

      **The real mechanism, found by reading `useDispose` next to three's own
      source (`node_modules/three/src/renderers/webgl/WebGLPrograms.js` and
      `WebGLRenderer.js`), not by guessing:** `useDispose(material, geometry)`
      called `material.dispose()` on every unmount, correctly per its own doc
      comment (avoid leaking GPU resources). But disposing a material fires
      three's `onMaterialDispose` listener, which calls
      `WebGLPrograms.releaseProgram()` - and that function is explicit in its
      own source: `if (--program.usedTimes === 0) { ... program.destroy() }`.
      A scene's material is normally the ONLY user of its compiled program,
      so every unmount drops `usedTimes` to zero and three actually calls
      `gl.deleteProgram()` on the compiled shader. The next mount builds a
      brand-new `ShaderMaterial` with byte-identical source, but
      `acquireProgram`'s cache lookup (a linear scan for a matching
      `cacheKey` over the small resident `programs` array) finds nothing -
      the matching entry was just deleted - so it compiles from scratch:
      a genuine `compileShader`/`linkProgram` pair, on EVERY switch away
      from and back to a scene, for the life of the session, regardless of
      anything the warm-mount system does. Warm-mounting can only front-load
      a compile that's about to happen anyway; it cannot stop a live,
      already-compiled program from being deleted and rebuilt on every
      single switch. This is a general bug affecting every scene in the
      roster - it was only ever VISIBLE on maze because maze's raymarching
      shader is the one complex enough for a from-scratch compile to run
      into whole seconds; other scenes pay the same tax in a few
      milliseconds and nobody could see it.
      This also explains why F137's `MAX_STEPS` 150 -> 96 mitigation looked
      like an 85% win in one log and then evaporated with no further code
      change (the disk-cache paragraph above): it was never disproven, it
      was irrelevant - the dominant cost was always "delete and rebuild the
      whole program every switch," which a smaller loop bound inside that
      same program can shrink a little but can't remove, and whose
      MAGNITUDE was always going to look inconsistent run to run for
      reasons entirely outside this codebase (system load, NVIDIA's own
      separate driver-level shader cache, etc.) - not because the fix was
      or wasn't working.
      **Fixed** by giving materials the exact same treatment F138 already
      gave render targets: `getSceneMaterial()` caches the compiled
      `ShaderMaterial` + `PlaneGeometry` per (renderer, scene id) in a
      `WeakMap`, created once and never disposed until the renderer itself
      is torn down (a context-loss remount). `useShaderCore` now pulls
      from that cache instead of calling `useMemo(() => new
      THREE.ShaderMaterial(...), [])` fresh every mount, and the
      `useDispose(material, geometry)` calls in both `createDirectScene`
      and `createBudgetedScene` are gone - there is nothing left for a
      mount to own and dispose. Per-mount state (`elapsed`, `bound`,
      `audio`, `sceneState`) is untouched and still resets on every mount
      as before; only the GPU-expensive, content-addressable-by-scene-id
      objects are shared. Zero shader/GLSL changes, zero effect on maze's
      fractal density or nesting - this was never a complexity problem.
      `npm run check` clean (764 tests, build passes).
      **Update 2026-08-29, confirmed live**: a fresh 180s/10448-frame log
      (`...07-27-11`) mounted four different scenes more than once each -
      kifs (3x), dissolve (3x), plasma (2x), pointcloud (2x), 8 remounts
      total - and every single one came back clean (worst in-window frame
      19-135ms, nowhere near the old 1900-2100ms class). The session's
      ONLY multi-second stall (1812.6ms) landed on maze's first and only
      mount that session (`kifs -> maze`, t=39.28s) - confirmed against
      raw `frameTimesMs` to start at t=37.46s and resolve by t=39.28s,
      exactly the shape of a one-time cold compile with nothing yet to
      reuse, and exactly the one case this fix was never going to touch.
      Maze itself didn't happen to remount in this particular log, but
      the mechanism is scene-agnostic (same `getSceneMaterial` cache,
      keyed by `spec.id`, for every scene in the roster) and is now
      directly verified working for four others.
      The remaining cost - paying full compile once per scene per
      session, on whichever scene the director happens to pick first -
      is real but no longer compounding, and any further reduction from
      here is a genuinely separate question (e.g. pre-warming known-
      expensive scenes at boot) from the bug this entry fixed.

- [x] **F145 - The remaining cost F144 called out (first-ever compile of a
      heavy scene lands on whichever live frame the director first picks
      it) is now paid at boot instead** - `src/engine/createShaderScene.tsx`,
      `src/engine/SceneManager.tsx` *(first attempt 2026-08-29, confirmed
      NOT sufficient by the user's own session log same day, real fix
      shipped same day - see the update below)*

      F144 fixed the repeat-mount recompile but was explicit that a scene's
      very first compile that session is a separate, unavoidable cost that
      caching cannot remove - it can only be moved. For maze specifically
      that first compile is the one stall still visible in the F144
      confirmation log (1812.6ms, `kifs -> maze` at t=39.28s). Requested by
      the user directly: pre-warm maze at boot instead of eating it live the
      first time the director picks it.

      `createShaderScene()` now returns a `PrewarmableScene`: the same
      component as before, plus a `.prewarm(gl)` method that pulls the
      scene's material/geometry through the existing F144
      `getSceneMaterial()` cache (creating it if this is the first call for
      this renderer) and runs it through the same `prewarmShaders()` /
      `gl.compileAsync()` path `EntryGroup` already uses for warm-mounting a
      scene that's about to become visible. Calling `.prewarm()` more than
      once is cheap and safe - the second call just issues `compileAsync`
      against an already-linked program, which resolves immediately.

      `SceneManager` calls `.prewarm()` once per id in a small hand-picked
      `BOOT_PREWARM_IDS` list (currently just `['maze']`) in a `useEffect`
      that fires once on mount, entirely outside the Entry/slot/crossfade
      system - these scenes never actually mount as part of this effect,
      visibly or otherwise, so there's no fade/transition bookkeeping to
      collide with. Skips the prewarm if the id is already the cold-open
      primary scene (it's compiling anyway as the real first mount).
      Considered and rejected two designs that stayed inside the entry
      system - reusing `role: 'effect'` for a fake boot-entry, and adding a
      new `SlotName` variant - both worked out to real risk (semantic
      confusion, or several easy-to-miss touch points including a
      `layerFx[role].blend` lookup that throws on an unrecognized role) for
      no benefit over a mechanism that just bypasses the system outright.

      Zero effect on what renders or how any scene looks; only changes when
      maze's first compile happens (boot, off to the side, instead of
      mid-show on the director's first pick). `npm run check` clean (764
      tests, 0 lint errors/warnings, build passes). Not yet confirmed via a
      live session log with the prewarm actually in place - next log
      capture should show maze's first pick landing clean instead of at
      ~1.8s.

      **Update 2026-08-29, same day: the user's own next session log
      disproved this.** The exact stall is still there, completely
      unchanged - `kifs -> maze` at t=39.28s, worst frame in the whole
      180s session at **1812.6ms**, matching F144's original confirmation
      log almost to the millisecond. Boot prewarm ran (confirmed: maze was
      never the cold-open primary that session - `pointcloud` was, so the
      `sceneId` skip condition didn't apply) and did nothing.
      Read three's own `compile()` source (the function `compileAsync`
      calls internally) to find out why, rather than guessing again: it
      calls `prepareMaterial()` for every material in the scene graph and
      NEVER calls `render()` - `compileShader`/`linkProgram` happen, but no
      draw call is ever issued. F139 (2026-08-28, before this session)
      already carried an unconfirmed hypothesis for exactly this shape of
      stall - that this session's backend (ANGLE/D3D11, see `env.gpu` in
      the log) can defer the REAL HLSL-compile-and-link work past
      `linkProgram` to the first draw call that actually exercises the
      program with a concrete vertex layout, which a compile-only path
      never provides. The live log turns that from a hypothesis into a
      confirmed mechanism: a fix that does everything `compile()` can do
      and still stalls identically is direct evidence the missing piece is
      specifically "no draw call happened."
      **Fixed for real** by having `.prewarm()` also `gl.render()` the
      scene once into a throwaway 1x1 target (negligible fill cost, real
      draw call) after the existing `compileAsync` call, using the exact
      cached geometry/material pair the real mount will use. `npm run
      check` clean (764 tests, 0 lint errors/warnings, build passes).
      **Still not re-verified live** - no browser automation available in
      this environment, and this entry has already been wrong once behind
      a passing `npm run check`, so it stays open until a fresh session log
      shows maze's first pick landing clean. If it still stalls after
      this, the next thing to check is whether the throwaway render's 1x1
      viewport is itself sidestepping whatever the driver keys the deferred
      compile on (unlikely, but the honest next branch if this doesn't
      settle it).

      **Verified live 2026-08-30 - closed.** Two fresh session logs on the
      same machine and backend (`audiovis-session-2026-08-29-16-18-36`,
      165s, and `...-16-29-40`, 320s) both mount maze and neither stalls.
      Worst single frame of each whole session: **64.6ms** and **75.4ms**.
      In the 320s log maze is picked twice - `pointcloud -> maze` at
      t=132.55s and `wingfold -> maze` at t=182.00s - and both transitions
      complete with worst frames of 19.3ms and 16.7ms. Zero frames over
      100ms in 18732 frames.

      The comparison across all 21 captured sessions is unambiguous. Every
      earlier session that mounted maze paid the stall: 2286.6, 2102.6,
      1931.0, 1893.7, 1877.8, 1872.4, 1846.2, 1812.6 and 1778.7ms, then
      250.3ms once F148's roster-wide prewarm landed. The only two maze
      sessions without it are the two captured after `.prewarm()` began
      issuing a real draw call. Maze is now the CHEAPEST row in the
      by-scene frame-time table (mean 16.7-16.8ms, p95 16.7-17.4ms over 20s
      on screen), below every other scene in the roster.

      So the hypothesis this entry landed on - ANGLE/D3D11 defers the real
      HLSL compile-and-link past `linkProgram` to the first draw call that
      exercises the program with a concrete vertex layout - is confirmed by
      the fix working, and the 1x1 throwaway viewport was NOT sidestepping
      whatever the driver keys the deferred compile on.

- [x] **F146 - Maze's march-step / AO-tap / edge-glow / far-plane knobs were
      tier-gated (reduced under load) despite the scene's own profiling
      table saying that costs almost nothing - resolution is now the only
      knob the quality governor moves for this scene** -
      `src/scenes/MazeFlightScene.tsx` *(fixed 2026-08-29)*

      Same spirit as F139 (fractal nesting/density is never tier-gated,
      only the user's own `complexity` dial moves it) extended to the rest
      of the raymarch quality knobs, on explicit user request after seeing
      the tier ladder in the code: "steps and complexity were very less...
      max them, we'll only reduce res." The scene's own header comment
      already had the profiling data to justify it (Apple M1, ANGLE/Metal):
      march steps 96->48 costs ~5% (in measurement noise), AO taps 5->3
      costs ~6%, far-plane (`uTMax`) change costs ~0%, and only
      edge-glow-off is a real cost at ~14% - all small next to nesting
      depth (33-58% per level) and resolution (linear in pixel count). The
      table's own stated conclusion was "go after nesting levels and
      resolution, not the march."

      Replaced the tier-gated block in `update()` -
      `uMaxSteps`/`uAoSteps`/`uEdgeOn`/`uTMax` all previously scaled off
      `quality.knobs.raymarchSteps` - with fixed maximums: `uMaxSteps =
      MAX_STEPS` (96), `uAoSteps = MAX_AO` (5), `uEdgeOn = 1`, `uTMax = 48`
      (the value the old ladder only used above tier threshold 80).
      `pixelBudget` (`quality.knobs.raymarchSteps >= 50 ? 0.9 : 0.55`) is
      untouched and is now the *only* thing the quality governor still
      moves for this scene - per the user's "we'll only reduce res," cost
      scaling tier-to-tier now rides entirely on pixel count, which the
      header table already confirms is the honestly-linear lever anyway.
      Zero change to fractal density/nesting (already hard-fixed in F139).
      `npm run check` clean (764 tests, 0 lint errors/warnings, build
      passes). Visual/perf confirmation against a live session log with a
      tier-demote event on maze is still outstanding.

- [x] **F147 - Maze's budgeted render target reallocated (a real GPU
      teardown-and-recreate) on every DPR/render-scale step, not just on a
      genuine window resize - visible as a brief corner-anchored frame with
      black bezels, automatic and self-clearing, right after F146**
      - `src/engine/createShaderScene.tsx` *(fixed 2026-08-29)*

      Reported by the user directly, with a screenshot: content confined to
      a smaller rect at one corner with black filling the rest, happening
      on its own (not a manual window resize) and clearing after a moment.
      Coming right after F146 in the same session, "recent only, triggered
      by some change done today."

      Read `RenderTarget.setSize()` in three's own source
      (`node_modules/three/src/core/RenderTarget.js`) to confirm rather than
      guess: it unconditionally resets `.viewport`/`.scissor` to the FULL
      new size and calls `.dispose()` - a real framebuffer/texture
      teardown, lazily reallocated on the next `setRenderTarget()` + render
      - whenever width or height actually changes. `createBudgetedScene`'s
      own `useSceneFrame` calls this every time `fullW`/`fullH`
      (`size.width/height * dpr`) differ from the target's current size.

      Before F146, a scene under load got relief from the governor's free
      complexity-knob tier first (raymarch steps, AO taps, etc. - no GPU
      work, scenes just read them live), and only paid this reallocation on
      a genuine, comparatively rare canvas/DPR change - exactly the
      "well-known GPU stall hazard...confirmed here...a single isolated
      frame over a second long" F139/F143 already measured and designed
      around. F146 removed that free relief for maze specifically - DPR/
      pixelBudget became its only lever - so the governor now reaches for
      this reallocating path on nearly every step instead of rarely. This
      wasn't a resize bug at all: it was this already-known stall firing
      far more often, as a direct and foreseeable consequence of maxing
      maze's complexity knobs the way the user asked for in F146.

      **Fixed** by making the target's allocation grow-only: it now resizes
      up when the live canvas needs more room than it currently has, and
      simply stays at its largest-ever size otherwise - never shrinks back
      down and never reallocates on a DPR *decrease*, which is precisely
      the governor's main move for maze now. The active viewport/scissor
      and `uUvMax` blit (see the `DISPLAY_FRAG` header comment above) already
      render into and sample only a sub-rect of the target, so an
      oversized allocation costs a bounded amount of GPU memory for the
      session, not a stall - the same "pay once, keep it" trade F138/F144
      already made for this cache. `uUvMax`'s denominator switched from the
      freshly-computed `fullW`/`fullH` to the target's actual (now
      possibly-larger, sticky) `rt.target.width`/`.height`, so the blit
      stays correct regardless of whether this frame grew the allocation.
      Zero change to any complexity/quality knob or visual output - this is
      an allocation-lifecycle fix only. `npm run check` clean (764 tests, 0
      lint errors/warnings, build passes). Diagnosed from three's source and
      this codebase's own F139/F143 precedent, not from a live repro (no
      browser automation available in this environment) - awaiting the
      user's confirmation that the corner/black-bezel flash is gone.

---

## p95 goes amber on transitions and the controller chases it (2026-08-29)

- [~] **F148 - p95 amber is transition spikes plus the adaptive controller's
      reaction to them, not steady-state load** -
      `src/engine/SceneManager.tsx`, `src/engine/PerfMonitor.tsx`,
      `src/scenes/index.ts`
      Session recording `audiovis-session-2026-08-29-13-48-35`: steady state is
      green (nearly every `+layers` scene row sits at p95 16.7-17.1 ms), but the
      HUD p95 spends long stretches amber (>22 ms) and touches 24.9 ms. Sources,
      in order of size:
        1. **Cold shader compile on scene commit.** Worst single frame 250.3 ms
           at 55.8 s (`maze` transition-in), plus a cluster of 50-67 ms frames
           all landing within ~1 s of a commit; `programs` climbs 12 -> 26 over
           the session as each new scene links on screen.
        2. **Render-scale / tier thrash.** 22 tier changes and 30 scale changes
           in 132 s. F132's own note: 2-4 reallocations stack within a second of
           a commit. One 250 ms frame then keeps the 10 s display-window p95
           elevated for a full ten seconds - that is the "amber a lot".
        3. **Climb overshoot.** 124.5 s: render scale jumps `0.75 -> 1.00`
           (8.29 MP) in one frame when `wingfold` drops its layers, immediately
           cannot hold it, and demote-cascades tier 0 -> 4 with p95 -> 24.9.
        4. Autopilot switches scenes ~every 8 s (17 in 132 s), 94% of samples
           failing the `conf<0.4 / amb>0.6` gate - most switches are structural
           cadence, not confident reads, so much of the churn (and its spikes)
           is avoidable. This is the engine-side consequence of **F121**.
        5. Fixed per-frame cost is 8.14 ms of a ~10 ms budget (`frameLoad`
           "fixed" = the post chain + exposure sampler), so p95 has no room to
           absorb anything: 56% of frames already sit over 16.7 ms.

      **Done (2026-08-29):**
        - `SceneManager` `BOOT_PREWARM_IDS` **was a silent no-op.**
          `getScene(id).component` is the `React.lazy` wrapper and does not
          forward the `.prewarm` static `createShaderScene` sets on the real
          component, and at boot the chunk is not downloaded yet - so
          `scene.prewarm?.()` was always `undefined?.()`. That is why the sole
          listed scene (`maze`) still stalled 250 ms. New `prewarmScene(id, gl)`
          in `scenes/index.ts` goes through `load()` and reaches the resolved
          module default; list widened from `['maze']` to the whole primary
          roster (wireframe, dissolve, chrome, pointcloud, plasma, kifs, maze,
          wingfold), staggered `PREWARM_STAGGER_MS` apart so eight compiles
          don't block one boot macrotask. Once `entry.prewarmed` is set this
          also short-circuits the `WARM_FRAMES = 4` double-res warm render, so
          the 24-28 ms transition frames go too.
        - `PerfMonitor`: tier-driven resizes are now **frozen while
          `performanceState.transition.active`** (the hold timer keeps
          restarting for the length of the crossfade); the `pairKey` path and
          the `SCALE_EMERGENCY_RATIO` path are unaffected. `RESIZE_COALESCE_SEC`
          0.2 -> 0.5. New `MAX_RENDER_SCALE_STEP_UP = 1.25` ratchets upward
          resizes in `applyRenderScale` (downward never capped), with a
          convergence walk in the frame loop so a clamped climb finishes on the
          coalesce cadence. `npm run check` clean (764 tests, lint, build).

      **Open:**
        - **Autopilot churn / dwell floor.** Until **F121** is fixed the show
          paces off section boundaries, so raise `MIN_SUBJECT_DWELL_BEATS`
          (~32 -> ~48-64) so a scene holds through a spike-and-recover cycle.
          Interim mitigation only; the real fix is the mood estimator.
        - **Fixed per-frame cost (8.14 ms of a ~10 ms budget).** `MirrorPass` /
          `LensPass` are already skipped at rest (they set `enabled` from
          `isMirrorActive` / `isLensActive`), so the cost is elsewhere: Bloom's
          ~18-pass `mipmapBlur` pyramid (always on, "the single most fill-bound
          thing in the frame" per renderScale.ts), `FeedbackPass` (a full-frame
          read+write every frame `trails > 0`, and the session ran trails
          0.77-0.89 for long stretches), `GradePass` + CAS, and the
          `ExposureSampler` readback. The real fix is **F122's deferred half** -
          decouple post-chain resolution from scene resolution (bloom / vignette
          / CA / fog are low-frequency and identical at half res; points/edges
          want native). `/bench` still excludes the whole post chain, so step
          one is a GPU-timer path (`src/bench/gpuTimer.ts`) that measures it.
          Separately: **the mirror/lens racks are also starved** - `visualTension`
          only rises on `m.isBuilding` / predicted-peak / `f.drop`, so a session
          that never reaches `building` mood (F121) sits at tension ~0 and
          `mirrorForSection`'s gate never opens; and `tensionMoved` in
          `PerformanceStateBridge` re-picks (and usually tears down) an engaged
          mirror when the drop's tension spike decays. Broadening the tension
          floor and adding a min-hold before a downward re-pick is the fix
          there. See the notes handed to the user 2026-08-29.


      **Measured 2026-08-30 against `audiovis-session-2026-08-29-16-29-40`
      (320s, same machine, quality `high`):**

      *The shipped half worked.* Worst frame during any of the session's 30
      transitions is **24.8ms**, and 27 of the 30 are at or under 19.3ms -
      against 250.3ms in the log this entry was written from. The
      `programs` counter no longer climbs across the session (23-31, flat)
      instead of walking 12 -> 26, so the roster-wide `prewarmScene()` is
      reaching the real module default as intended. Source (1), cold shader
      compile on commit, is closed: there is not one frame over 100ms in
      18732 frames. Freezing tier-driven resizes while a crossfade is in
      flight also holds - scene commits are now the SMALLEST of the three
      slow-frame populations (19 of 213 frames over 33ms, against 134 for
      tier changes and 60 for scale changes).

      *Source (2), render-scale and tier thrash, is now the whole problem
      and it got worse, not better.* Normalised per minute against the
      132s log this entry cites: tier changes 10.0/min -> **15.8/min**,
      scale changes 13.6/min -> **19.7/min**, scene changes 7.7/min ->
      **11.4/min**. The transition-window freeze removed the spikes AT
      commits without reducing how often the ladder moves, because what
      moves it is not the commits - see **F149**, which found the actual
      driver: the ladder's top rung cannot be held on this hardware and the
      governor has no memory of that, so it re-attempts it 13 times in
      320s. Source (3), climb overshoot, is the same finding seen from the
      other end; `MAX_RENDER_SCALE_STEP_UP = 1.25` did not prevent it
      because the fatal step is only 0.91 -> 1.00, a ratio of 1.10.

      *Source (5) is wrong, at least on this machine, and this changes the
      priority order.* The claim was that fixed per-frame cost leaves p95
      no room. But in every window more than 1.5s from a tier/scale/scene
      event, frame time is a flat 16.66-16.70ms mean at every internal
      resolution up to 7.8 MP - vsync-locked, with headroom to spare. The
      8.14ms "fixed" figure is `frameLoad`'s own RESERVATION (`POST_CHAIN_MS`
      + `FEEDBACK_MS` scaled by `fillScale`), not a measurement, and the
      hardware plainly is not paying it: `/bench` still excludes the post
      chain, so that number remains the estimate F43/F90 flagged. **F122's
      deferred half is therefore not the bottleneck here** and should drop
      below F149 and F140 in priority - though it stays worth doing for
      weaker GPUs, and the GPU-timer path (`src/bench/gpuTimer.ts`) is still
      the only way to turn the estimate into a fact.

      *Source (4), autopilot churn, also got worse and is still F121.* The
      scene-switch gate now fails on **99%** of samples (was 94%), mood
      confidence mean fell 0.32 -> 0.18, and the show committed 30 scene
      changes in 320s. Different track, so this is not a clean A/B - but it
      is the same direction, and `effects fired: 0` again across the whole
      session, so the mirror/lens starvation described below is unchanged.
      Newly visible at this cadence: **F150**, layer mounts that live 20-90ms
      and are torn down on the same commit that created them.

      Not verified against real music - same standing caveat as the whole
      "Frame-time control loop" section.

---

## The quality ladder's top rung is unreachable, and the governor keeps trying it (2026-08-30)

Everything below comes from `audiovis-session-2026-08-29-16-29-40` - 320s,
18732 frames, store quality `high`, autopilot on, RTX 4060 laptop /
ANGLE-D3D11, 2560x1440 at `baseDpr` 1.5. It is the longest clean capture so
far and the first with no cold-compile stall anywhere in it (see F145, now
closed), which is exactly what makes the rest readable: with the 1.8s spikes
gone, what remains is visible for the first time.

- [x] **F149 - Render scale 1.00 (8.29 MP) is the one rung this machine cannot
      hold; the quality governor has no memory that it just failed, so it
      climbs back into it every ~25s for the whole session - 13 attempts, 13
      demotes, 0 successes** - `src/engine/quality.ts`,
      `src/engine/renderScale.ts` *(found 2026-08-30, not fixed)*

      **The cliff is real, and it is a cliff rather than a curve.** Frame time
      by internal resolution, all samples:

        6.87 MP   n=110   mean 17.08   p50 16.67   p95 19.55    17% of samples > 16.9ms
        7.33 MP   n=  4   mean 16.95   p50 17.18   p95 17.19    50%
        7.80 MP   n= 69   mean 17.45   p50 16.80   p95 20.65    38%
        8.29 MP   n=106   mean 20.78   p50 20.88   p95 23.96    95%

      A 6% increase in pixels (7.80 -> 8.29 MP) costs 24% of frame time, and
      the p50 moves from 16.80 to 20.88ms - which is 16.67 x 1.25, i.e. the
      frame has stopped riding vsync and settled into dropping one in four.
      That is a threshold, not fill-rate scaling. Below it the machine is
      genuinely idle: at tier 0, with every complexity knob at maximum, mean
      frame time is 16.67-16.97ms at 3.95, 4.30, 4.67, 5.44, 6.42 and 7.33 MP
      alike, and only 8.29 MP breaks it.

      **The complexity half of the ladder buys nothing here.** Holding
      resolution fixed at 4-5 MP and varying only the tier: tier 0 mean
      16.69ms (n=12), tier 1 16.67ms (n=36), tier 2 16.75ms (n=228). Three
      tiers of raymarch steps, noise octaves and particle counts are
      indistinguishable inside measurement noise. Every millisecond the
      governor has ever bought on this machine it bought with resolution -
      the same conclusion F146 reached for maze specifically, now apparently
      true for the whole roster - which means four of the five tiers are
      currently paying a reallocation (F140) for a knob change worth nothing.

      **The governor cannot learn this, by construction.** `QualityGovernor.tick()`
      climbs whenever `steady` has held for `CLIMB_HOLD_SEC = 4` and
      `tier > ceiling`; `FIXED_TIER.high = 0`, so the ceiling is 0 and the
      climb target is always the rung that just failed. Nothing in the class
      records that a rung was tried and lost. The result is a textbook limit
      cycle, and the log is one period repeated 13 times:

        entered tier 0 at   22.0s, held 3.2s      202.0s, held 3.2s
                            38.4s, held 3.3s      212.2s, held 3.2s
                            57.7s, held 6.9s      231.5s, held 2.0s
                            91.2s, held 3.7s      262.5s, held 3.2s
                           105.0s, held 2.0s      290.4s, held 3.2s
                           131.9s, held 8.0s      297.6s, held 3.2s
                           153.0s, held 3.3s

      Every one ends in `DEMOTE 0 -> 1`. Independently, all **13 of 13**
      render-scale climbs to 1.00 are followed by a tier demote within
      0.16-1.47s (median ~0.2s). The session spent 47s (15%) at tier 0 and
      every second of it was overloaded.

      **This is where the churn comes from.** 84 tier changes and 105 scale
      changes in 320s - one structural change every 3.8s and 3.0s
      respectively - and per F140 above, all 105 scale changes are real
      `EffectComposer` reallocations. There are 18 clusters of frames over
      40ms; 13 of the 18 contain a `scale -> 1.00` event and the rest sit at
      0.88-0.97. They are not single spikes either: the clusters at
      64.7-69.6s and 156.3-159.9s run 27 and 21 slow frames across 3-5
      seconds, because the demote cascade reallocates on the way back down
      too. A single 10s HUD p95 window covers all of that, which is the
      "amber a lot" F148 set out to explain.

      **Fix shape** (none of it done):
        1. **Failed-rung memory.** When a climb to rung N is followed by a
           demote within some window, latch N as unavailable - for the
           session, or with exponential back-off (retry after 30s, 60s,
           120s...). The standard AIMD answer, contained to `quality.ts`, and
           on this evidence it alone removes 12 of the 13 cycles.
        2. **Cap the top rung below the cliff.** `solveRenderScale` clamps to
           `Math.min(1, ...)`; the evidence puts the useful ceiling on this
           display at ~0.97 linear / 7.8 MP. A ceiling MEASURED per session is
           better than a new constant, since the cliff is a property of the
           (GPU, panel, post-chain) triple and not of the code.
        3. **Stop moving the complexity knobs at all** where they measure
           free, and let the tier ladder be a resolution ladder. Follows from
           the 4-5 MP table and from F146's precedent, but wants confirmation
           on a second, weaker GPU before it is generalised - on an
           integrated part those knobs may well earn their keep, and this
           session cannot say.
        4. Pairs with F140's newly-available quantisation fix: coarser rungs
           mean fewer reallocations per cycle even before the cycles stop.

      **Fix 1 shipped 2026-08-30** - `src/engine/quality.ts`. The governor now
      remembers, per rung, that a climb into it failed:

        - New `RUNG_PROOF_SEC = 10`. A demote that lands within that window of
          climbing INTO a rung is the rung failing a probe; a demote later than
          that is the workload changing, and is not held against it. Chosen
          against the observed data rather than in the abstract - all 13 of this
          session's tier-0 tenancies ended inside 8.0s.
        - A failed probe blocks re-entry to that rung for
          `RUNG_BACKOFF_SEC = 20`, doubling per consecutive failure to
          `MAX_RUNG_BACKOFF_SEC = 240`. Back-off rather than a permanent latch,
          because "unaffordable" is a claim about a moment: a smaller window or
          a cheaper scene moves the cliff, and a latch would be wrong forever
          when it was wrong. A rung that survives its probe window has its
          failure count cleared.
        - Blocking is per-rung and applies ONLY to climbing. Demotion stays
          unconditional, which is the same contract the quality ceiling has.
        - `setMode` and `pinTier` clear the memory. `PerfMonitor` re-runs
          `setMode` in the same effect that calls `renderScale.setDisplay`, so
          resizing the window or dragging it to another monitor already forgets
          a record that was only ever true for the old pixel count - no new call
          site needed.

        Replayed against this session's timeline the attempts land at roughly
        t, +20, +60, +140, +300 instead of every ~25s: 4 or 5 probes over 320s
        against 13, and 12 of the 13 demote cascades never happen. 7 new tests
        in `qualityGovernor.test.ts` cover the block, the re-probe, the
        doubling, the forgiveness, that demotion is never blocked, that one bad
        rung does not block the rest of the ladder, and that a mode/display
        change clears it. `npm run check` clean (773 tests, 0 lint, build).

      **Fix 2 deliberately not done.** A measured ceiling on `solveRenderScale`
      would be a second mechanism doing fix 1's job less generally: the rung
      memory already learns where the cliff is, wherever it sits, including for
      rungs that are not the top one. Two controllers competing over the same
      decision is how this file got its hardest bugs.

      **Fix 3 deliberately not done.** Retiring the complexity knobs needs a
      second, weaker GPU first, as noted below - on an integrated part they may
      well earn their keep, and one machine cannot say.

      **Fix 4 withdrawn - the premise was wrong.** See the correction in F140
      above: replaying the session's 105 scale changes through every candidate
      quantum removes at most 13 of them, and only at a quantum coarse enough
      to be a visible resolution step. The governor's moves are large
      deliberate steps, not rounding wobble. 97 of the 105 follow a tier change,
      so fix 1 is also the fix for F140's frequency problem.

      **Not verified live.** No browser automation in this environment, and this
      is a controller change whose whole point is what it does over minutes of a
      real show. The next session log should show tier changes well under this
      one's 84, scale changes under 105, and - the specific thing to look for -
      tier-0 tenancies that either hold or stop being attempted.

      **VERIFIED 2026-08-30** against `audiovis-session-2026-08-29-22-12-12`
      (140 s, same machine, same `high` setting) plus the run that followed it.

      Every one of the session's nine climbs lands where the back-off arithmetic
      says it should, to within 0.02 s:

        rung 2  climbed  9.45  failed 12.68 (3.2s)  -> blocked to 32.68
                climbed 32.68  <- exact
                        failed 35.93 (3.3s)         -> blocked to 75.93
                climbed 77.46  <- first frame past BOTH that block and
                                  CLIMB_HOLD_SEC after the 73.45 promote
                        failed 83.19 (5.7s)         -> blocked to 163.19
                never entered again (session ends at 140)

        rung 3  climbed 44.65  failed 53.43 (8.8s)  -> blocked to 73.43
                climbed 73.45  <- exact
                climbed 94.85  failed 98.83 (4.0s)  -> blocked to 138.83
                climbed 138.85 <- exact

      The controller has a fixed point now. Where the old governor took the same
      cliff 13 times in 320 s, this one takes it three times in 140 s and then
      stops.

        tier changes   15.8/min -> 7.3/min
        p99            38.5 ms  -> 21.7 ms
        max            75.4 ms  -> 59.3 ms
        frames >33 ms  212 (1.13%) -> 26 (0.31%)
        frames >50 ms  73          -> 9

      **The run after it is the real result.** `...22-20-11` (130 s) records
      **zero tier changes, zero frames over 33 ms**, max 31.4 ms, p99 20.0 ms -
      the first session in this corpus with no dropped-frame outlier of any kind.
      The ladder sat at tier 3 for the whole run. That is the shape the fix was
      aiming at: not a better climb, a ladder that stops climbing into a wall.

      **Two honest caveats.**

      (1) The price is resolution. This session occupied tiers 2-4 and never
      exceeded 4.06 MP internal; the pre-fix session reached 8.29 MP. That is the
      correct trade under the project's standing rule - buttery smooth beats
      visual ambition - and it is what a rung that cannot hold 60 fps SHOULD cost.
      It is still a real reduction in delivered pixels and should be re-judged by
      eye, not from this table.

      (2) Neither result is a controlled comparison. Different tracks, different
      durations, different starting tiers. The back-off arithmetic matching the
      timestamps to 0.02 s is the strong evidence here; the aggregate frame-time
      numbers are consistent with it rather than independent proof of it.

      **Caveat, and it matters:** every number here is one machine, one
      panel, one track. 8.29 MP is exactly what `baseDpr` 1.5 produces on a
      2560x1440 panel - a 4K internal frame, which is what F107 deliberately
      made tier 0 mean - so a different panel moves the cliff. Fixes 1 and 4
      are safe regardless, because they are about the controller's behaviour
      rather than about where the cliff sits; fix 2 has to measure rather
      than hardcode.

- [x] **F150 - 12 of the session's 22 composition-layer mounts live for 20-90ms
      and are then torn down - always on a scene commit** -
      `src/engine/SceneManager.tsx`, `src/engine/slotBudget.ts`
      *(found 2026-08-30, not fixed)*

      44 layer events in the session, of which these 12 are add/remove pairs
      where the remove follows the add within a frame or two:

        t=13.93  -> 14.02   (90ms)   accent: + ribbons
        t=81.00  -> 81.05   (50ms)   accent: + ribbons
        t=118.13 -> 118.18  (50ms)   accent: + ribbons
        t=126.40 -> 126.46  (60ms)   accent: + ribbons
        t=148.95 -> 148.97  (20ms)   accent: + ribbons  AND  overlay: + plasma
        t=196.50 -> 196.58  (80ms)   background: + malachite  AND  accent: + ribbons
        t=218.00 -> 218.07  (70ms)   accent: + ribbons
        t=275.16 -> 275.23  (70ms)   accent: + ribbons
        t=278.91 -> 278.99  (80ms)   background: + malachite
        t=304.28 -> 304.37  (90ms)   accent: + ribbons

      Every one of those timestamps is a scene-commit timestamp. So the layer
      set is being computed against the outgoing composition, applied, then
      recomputed and reverted the moment the new primary lands - most likely
      the slot budget admits the accent while the outgoing scene's cheap
      mid-fade cost is still what is on the books, and evicts it once the
      incoming scene's real cost registers.

      **Correction 2026-08-30, same pass: "visibly flickers" was wrong, and the
      log could not have told me either way.** `sessionLog` reads these events
      from `performanceState.layers`, which `PerformanceStateBridge` mirrors
      straight from the store's `layerSceneIds` - it is the director's DESIRE,
      not what is mounted, and certainly not what is drawn. Two gates sit
      between them: `resolveLayerIds` can refuse a layer that no longer fits the
      frame budget, and (since F141) an admitted layer mounts invisibly at
      `dir: 0` and is promoted to `dir: 1` only once `isWarmComplete`. A desire
      raised and withdrawn inside 20-90ms - one to five frames - most likely
      never reached `dir: 1` at all, so there was probably nothing on screen to
      see. The mount/unmount cost is real; the flicker was an assumption.

      **Instrumented rather than fixed** (`src/engine/performanceState.ts`,
      `src/engine/SceneManager.tsx`, `src/engine/sessionLog.ts`). New
      `performanceState.mountedLayers`, written by SceneManager from the
      `dir === 1` entry per role - what is actually being drawn - alongside the
      existing desire. The session log now emits a separate `layer-visible`
      event stream and the summary prints both counts
      (`layer changes: N wanted, M actually shown`) plus an explicit list of
      desires withdrawn within a second. The next capture answers the question
      this entry is actually asking, in one line, instead of leaving it to be
      inferred from timestamps.

      **Root cause still open.** Reading the code did not settle it either.
      `PerformanceDirector` already guards the obvious version of this - it
      composes against `s.pendingSceneId ?? s.sceneId`, and only aims at a new
      pick when `requestScene` actually ACCEPTED it, with a comment naming this
      exact failure ("A layer chosen and immediately dropped is exactly the
      flicker that looks like a failed transition"). Its own re-entry guard
      (`lastSwitchBeat`) should also make two composition passes 90ms apart
      impossible at 134 BPM, where a beat is 448ms. So the second write is
      coming from somewhere not yet found, and `store.setLayer`'s
      `if (id === get().sceneId) id = null` coercion - which fires against the
      CURRENT primary, not the pending one - is the best remaining suspect.
      Deliberately not guessed at further: this is a four-way interaction
      between the director, the store, the slot budget and the warm-mount
      lifecycle, `npm run check` cannot tell whether a change to it looks right
      on screen, and the instrumentation above costs one session to settle it
      properly.

      **ANSWERED 2026-08-30** by the instrumentation above, in the first session
      that carried it (`...22-12-12`). Both readings were half right, which is
      exactly what the two event streams were added to separate:

        40.48s  accent: + ribbons  ..  40.64s   160 ms   WAS DRAWN
        111.91s accent: + ribbons  ..  111.98s   70 ms   never drawn
        122.46s background: + malachite .. 122.55s 90 ms never drawn

      So the warm-mount gate does absorb most of it - two of three desires were
      raised and withdrawn without a pixel reaching the screen, costing a mount
      and an unmount and nothing visual. But not all of it: the 160 ms one
      reached `dir: 1` in 80 ms and was gone 80 ms later. A layer really did fade
      in and out inside a fifth of a second. The original claim was unsupported
      when it was written and is now supported for one case in three.

      Cheap enough to leave. Three short-lived desires in 140 s, one of them
      visible, against a fix that would have to reorder the director, the store's
      dwell floors and the warm-mount lifecycle. Re-open it if a session shows
      the count climbing, and note that the same instrumentation immediately
      found a LARGER flicker that nothing here predicted - F158 below.

- [x] **F151 - The session report hardcodes "(of 6 available)" for the palette
      pool; there are 13, and this session used 13** -
      `src/engine/sessionLog.ts` *(found 2026-08-30, not fixed)*

      The count in that line is a string literal, while `PALETTES` in
      `src/engine/palettes.ts` is well past 6 - the session's own palette
      table lists 13 distinct ids in use (nocturne, glacial, ember, orchid,
      umber, violet, reef, mono, carnival, solar, aurora, sage, ocean). So
      the report reads "palette changes: 18  (of 6 available)", which is not
      just stale but actively misleading about the one thing the line exists
      to answer: whether the show is exercising the palette pool or circling
      a corner of it.

      **Fixed 2026-08-30**: the denominator is `PALETTES.length`, read from the
      registry, so it cannot drift again.

- [x] **F152 - A backgrounded tab is recorded as a multi-second stall and
      lands at the top of "worst single frames"** - `src/engine/sessionLog.ts`
      *(found 2026-08-30, not fixed)*

      `audiovis-session-2026-08-29-16-15-09` reports `max 24295.4 ms`. That
      frame is at t=24.3s, has no scene/tier/scale event anywhere near it,
      and is immediately followed by `audio resumed` at t=24.7s with no
      events at all before it - the window was unfocused (rAF throttled)
      while the user set something up, then came back. It is not a stall.

      `PerfMonitor`'s deliberate no-ceiling policy is right for the live
      governor and says so in a comment: a genuine 150-300ms frame is exactly
      what the monitor exists to catch, and a backgrounding transient ages out
      of its windows on its own. But the session REPORT is a different
      consumer with a different lifetime - it keeps that frame forever, puts
      it at the top of "worst single frames", and poisons `max` and `p99`,
      which are the exact numbers this ledger has been citing session over
      session to track the maze stall (F144/F145). One alt-tab makes a
      capture unreadable.

      **Fixed 2026-08-30**, marking rather than dropping, and then treating
      the mark differently per consumer:

        - `SessionLog` keeps a `visibilitychange` listener for the life of a
          recording and latches a flag when the page goes hidden; the next
          `tick()` stamps that frame in a `hiddenFrames` ring parallel to the
          frame-time ring. Latched on the way OUT rather than sampled inside the
          frame, because by the time rAF resumes the page is visible again and
          an in-frame check would always answer "no".
        - The JSON keeps every frame, so the timeline stays whole.
        - The distribution (`mean/p50/p95/p99/max`, the over-16.7/33.3/50ms
          percentages) skips flagged frames and prints
          `excluded N frames spanning a hidden tab` when it did so - a throttled
          frame is not a measurement of anything the renderer did.
        - "Worst single frames" still prints them, labelled
          `(tab hidden - not a stall)`, so nothing disappears silently. That is
          the half that matters: deleting the frame outright is exactly the
          mistake `PerfMonitor`'s no-ceiling comment warns about.

      Two tests in `sessionLog.test.ts`, driven through a stubbed `document` so
      they exercise the real listener wiring rather than a hand-set flag: one
      that a 20s absence is kept in the JSON, excluded from `max`, and labelled;
      one that a genuine 200ms stall in a visible tab is untouched.

- [~] **F153 - No latched notion of where in the song we are; the director cuts
      mid-build and misses the drop** - `src/audio/*`, `src/engine/*`
      *(DSP path implemented 2026-08-30; not yet verified against real music)*

      **Complaint:** the visual director "sometimes transitions when it doesn't
      need to, and sometimes misses it - especially on buildups, where it should
      sustain the current look until the drop."

      **Root cause (verified in source):** every structural signal on
      `AudioFeatures` was *instantaneous* - `sectionChange` (one-frame boolean,
      spectral-novelty thresholded at 0.45), `drop` (0.6 s pulse), `buildUp`
      (noisy per-frame bool). `PerformanceDirector` recomposed on `sectionChange`
      OR a blind `beatIndex % 16 === 0` timer - that timer is what cut mid-build.
      `AutoPilot`'s `STALE_TARGET_SEC = 25` backstop also fired mid-build; its
      own doc said it existed *because no structural edge was available*. Drops
      were handled reactively (`dropEdge`), a beat late.

      **Decision:** a learned model was scoped and rejected. There is no
      directly-convertible MSA model (all-in-one is MIT + ~300K params but needs
      Demucs + madmom + NATTEN; SongFormer needs 600M of SSL features at
      inference), so it would be a teacher→student distillation - a multi-week
      offline pipeline needing a GPU, for a browser/streaming ceiling of only
      ~0.62 boundary F@±3s (vs a Foote-novelty ~0.45, human agreement ~0.90).
      Not worth it for this tool. The DSP path was taken instead: a real
      *segment* structure, not one-frame events, and the director rewiring that
      the complaint actually needs.

      **Implemented (DSP):**
        - `src/audio/types.ts` - `SECTION_STATES` + `SongSectionMomentum` on
          `AudioFeatures.songSection`, with `structureValid` (4-way ambiguous
          like `moodsValid`; consumers gate on it and fall back to
          `f.sectionChange`). Taxonomy is `intro / build / drop / breakdown /
          section / outro` - verse/chorus are NOT guessed without a model;
          `repetitionLabel` (A/B/C) separately marks returned material.
        - `src/audio/essentia/structure.worker.ts` - second essentia-WASM
          instance, NO tf. Rolling ~120 s window → beat-synchronous HPCP + MFCC
          + scalar cells → cosine SSMs → checkerboard (Foote) novelty → fused
          adaptive peak-pick → boundaries + greedy repetition letters + a
          minimal kind map. Plus a 5-slope riser detector for `build` /
          `beatsTillDrop`. Fails silent (`missing` → permanent disable).
        - `src/audio/essentia/structureDsp.ts` - the pure algorithm (13 tests).
        - `src/audio/essentia/StructureBridge.ts` - `VoiceBridge` clone: PCM
          ring off the shared AudioWorklet tap, ~15 s cadence self-throttled by
          `costMs`, next-frame drain (4 inert-fallback tests).
        - `src/audio/SectionTracker.ts` - pure synchronous fusion FSM: latches
          boundaries/segments, overlays `f.drop` / `f.buildUp`, hysteresis
          (`holdFor`/`dwellFor` like `MoodEstimator`), soft fizzle release for a
          build that never drops, drop latch. Bootstraps `structureValid` on the
          first real segmentation (11 tests).
        - Directors, each behind `f.structureValid` (additive-neutral otherwise):
          `PerformanceStateBridge.visualTension` gains a `structureTension` build
          ramp; `PerformanceDirector` returns early during `isBuild`, uses
          `songSection.boundaryChanged` instead of the `%16` timer, and filters
          `performanceCost:'high'` primaries + empties layer pools in a
          breakdown; `AutoPilot` suppresses discretionary triggers during
          `isBuild`, recolours on a structural boundary, and pre-arms the hype
          scene when `beatsTillDrop ≤ 3` so SceneManager commits it on the drop.
        - Observability: `DebugPanel` structure line (y=120); `structureBridge.status`
          in `outputLink` telemetry.

      `npm run check` green (28 new tests). **Not verified against real music** -
      needs a foregrounded browser with a real source to watch the section
      tracker latch through a build and release on the drop, and the pre-arm
      timing needs tuning by ear (no automated "did the cut land on the drop").

      **Deferred:** the distilled boundary model (teacher = all-in-one +
      SongFormer ensemble, student = MusiCNN-scale net in the worker, corpus =
      FMA commercial-OK subset). Research notes captured; blocked on nothing but
      the decision that ~0.62 F is worth a multi-week GPU pipeline.

- [x] **F154 - Audio DSP front-end sweep (items 4-8, 19 of the standalone
      `docs/DSP_AUDIT_CHECKLIST.md`)** - `src/audio/*` *(2026-08-30)*
      The FFT/analyser plumbing half of the 19-item audio-DSP audit that
      `DSP_AUDIT_CHECKLIST.md` tracks (items 1/2/3/14 are the F121 set, 18 is
      the doc refresh). Full per-item detail is in that file; the short version:
        - **19** - `f.spectrum` is now the full `FFT_SIZE/2` = 1024 bins to
          Nyquist (was the lower 512); loop bound and `createEmptyFeatures`
          length derive from the same source so they cannot drift into a silent
          OOB write.
        - **6** - a dedicated 8192-point analyser (~5.4 Hz/bin) feeds `f.sub`
          only; `f.bass` stays on the 2048 grid because the 8192 window's
          ~186 ms span would blunt kick energy that `beatStrength`/scene pulses
          read at the beat (adversarial finding - the audit's literal "sub/bass"
          was narrowed to "sub").
        - **4** - `centroid` integrates the whole spectrum now (was capped at
          9 kHz), gain re-derived `3 → 2.1` against the corpus to hold its
          distribution; `rolloff`/`flatness` deliberately left at the 9 kHz cap
          (a Nyquist reference kills rolloff's dynamic range for its harshness
          consumer and breaks a public 0..1 contract). New `sparkle` cue
          (16 kHz-Nyquist) computed + on the contract but NOT wired into scoring
          - the 96 kbps calibration corpus has nothing up there.
        - **5** - premise disproven empirically (`getFloatFrequencyData` is not
          clamped by `min`/`maxDecibels` in Chromium); no analyser-property
          change. `f.spectrum` bins are now clamped to the documented 0..1
          (hot masters reach ~1.6 linear), and a loudness-invariance regression
          test covers the real dB→band→normalizer path.
        - **7/8** - the onset + percussion stat windows are age-based (1 s) not
          a fixed 60-frame count, and detection is skipped on any frame where
          the FFT buffer is byte-identical to the last.
      Verified firing-rate-preserving against the 8-track reference set:
      5/8 tracks byte-exact mood breakdown vs the F121 baseline, `moodLevel`/
      `energy`/`bass`/`flatness`/`crest` p50 all exact, octave-flip count
      unchanged. `npm run check` green (828 tests). The calibrate harness was
      also taught to stream (no OOM on a full run) + `CALIB_*` iteration knobs.
      Not verified against real music in a foregrounded browser. See
      `docs/DSP_AUDIT_CHECKLIST.md`.

- [x] **F155 - EssentiaBridge scheduler made pure + tested (audit item 16), and
      three latent scheduling bugs fixed** - `src/audio/essentia/*` *(2026-08-31)*
      `pickJob` / `applyDispatch` / `ingestResponse` / `drainResults` moved to a
      pure `src/audio/essentia/scheduling.ts` over an injected `EssentiaSchedState`;
      the class keeps all I/O. `essentiaScheduling.test.ts` (35 cases) covers the
      priority ladder, the degara-only cadence self-throttle, the `hqBpm` capture
      guard, and every drain merge path. Bugs fixed in passing:
        - **A** - `rhythm-hq`'s "not the first job" guard was `lastJobAt >= 0`,
          which `pickJob`'s own first branch already guarantees - dead code that
          let the ~950 ms multifeature job fire as job #2, ~0.2 s into a track,
          before any degara grid had locked. Now gated on `RHYTHM_HQ_MIN_READS`
          (2) completed degara reads.
        - **B** - no `id` check on a worker response, so a job in flight at a
          source change resolved after `detach()`+`attach()` and merged track
          1's tempo/key/danceability onto track 2's freshly-`reset()` state -
          the exact thing `AudioEngine.ts`'s `essentiaBridge.detach()` comment
          says cannot happen. Now `inFlightId` (set at dispatch, cleared on
          `detach()`) drops the stale result.
        - **D** - `hqFresh` compared a dispatch-time clock (`lastHqAt`) with a
          receipt-time value (`hqBpm`); dispatching an hq job now clears `hqBpm`
          so a full-cycle-stale octave reference can't be labelled "fresh"
          during the ~950 ms run.
      **Still open - Bug C:** the cadence self-throttle only accounts for degara
      `ms`; there is no aggregate worker-time budget or rhythm preemption, so on
      a slow worker a single long `key`/`danceability`/`rhythm-hq` dispatch
      delays the next degara read past its 2.5 s cadence. Hidden on a fast
      machine by the slot budget; bites under load. Low priority - a
      "reserve the slot for rhythm if it's due within `expectedJobMs`" guard, or
      an aggregate budget.
      `npm run check` green (872 tests).

- [~] **F156 - No true loudness (LUFS) (audit item 12), Part A** -
      `src/audio/loudness.ts`, `src/audio/AudioEngine.ts` *(2026-08-31)*
      ITU-R BS.1770-4 K-weighting: `loudness.ts` derives the two biquads from
      the analog prototype (sample-rate-agnostic; matches the spec's 48 kHz
      table to 1e-6), with a denormal-flushed / NaN-guarded `KWeighting` filter
      and an `OfflineLoudness` windower for the calibrate harness. A dedicated
      `audiovis-loudness` AudioWorklet runs the IIR biquads on the *contiguous*
      stream (an AnalyserNode only gives gapped snapshots) and posts 400 ms /
      3 s K-weighted mean-squares at ~60 Hz. `f.lufsShortTerm` (raw ~-60..0,
      absolute - rises with input gain, so diagnostic ONLY, never in scoring)
      and `f.loudness` (BandNormalized momentary K-weighted RMS -> invariant
      0..1) are on the contract; both panels show LUFS. Worklet verified in a
      real `AudioWorkletGlobalScope` (full-scale 1 kHz sine -> -3.00 LUFS).
      **Part B (pending):** wire `f.loudness` into `energyTarget` (swap the
      crude `f.rms` term) - a full recalibration, blocked on the F154 corpus
      run finishing.

---


## The relief lags the decision, and the escape hatch is set too high (2026-08-30)

Two sessions after F149 landed. The ladder now stops climbing into rungs it
cannot hold, and the frame-time distribution improved accordingly, but the
outliers that remain are not spread across the session - they sit in one
specific window, and that window is a hold that was designed for the opposite
case.

- [x] **F157 - A tier DEMOTE waits out `RENDER_SCALE_HOLD_SEC` before the
      resolution actually drops, so the frame keeps costing the failed tier's
      money for up to 5 s. 22 of the 26 frames over 33 ms in
      `...22-12-12` live in that gap, which is 11% of the session.**

      `PerfMonitor`'s render-scale block has three branches. A composition change
      (`renderScale.pairKey` moved) applies now. A tier change waits
      `RENDER_SCALE_HOLD_SEC = 3`, restarting the hold on each further tier move
      and for as long as a crossfade is in flight. An emergency overrides the
      hold when `p95 > refreshInterval * SCALE_EMERGENCY_RATIO`.

      Measured, demote to the first scale reduction that followed it:

           12.68  DEMOTE 2 -> 3   relief at 17.70   5.02 s
           14.68  DEMOTE 3 -> 4   relief at 17.70   3.02 s
           35.93  DEMOTE 2 -> 3   relief at 37.48   1.55 s
           37.95  DEMOTE 3 -> 4   relief at 38.00   0.05 s
           53.43  DEMOTE 3 -> 4   relief at 54.93   1.50 s  (rode a scene commit)
           83.19  DEMOTE 2 -> 3   relief at 84.16   0.97 s
           85.20  DEMOTE 3 -> 4   relief at 85.20   0.00 s
           98.83  DEMOTE 3 -> 4   relief at 101.63  2.80 s  (rode a layer add)

      The fast ones are not the hold working. They are the frame getting lucky:
      a scene commit or a layer change moved `pairKey`, which took the FIRST
      branch and applied the pending resize as a side effect. When nothing
      structural happens to coincide, the frame carries the failed tier's
      resolution for the full three seconds - or five, when a second demote
      restarts the hold.

      **And the escape hatch cannot fire on this machine's failure mode.**
      `SCALE_EMERGENCY_RATIO = 3` puts the override at a p95 of 50 ms. The worst
      p95 anywhere in this session is 21.5 ms. The failure here is not a stall,
      it is a sustained 19-21 ms p95 with 50-59 ms outliers riding on top - a
      frame that has stopped holding vsync, which is precisely what the governor
      demoted for, and precisely what the emergency branch declines to treat as
      an emergency. The override is calibrated for a stall this GPU does not have.

      Where the bad frames are:

        frames > 33.3 ms                        26 of 8377
        inside a demote -> relief window        22
        the other 4                             one scene commit (67.7 s)

        worst: 59.3  58.2  56.8  54.8  52.3  51.7  50.9  50.1  50.0 ms
               all nine inside a window, all at render scale 0.70

      **The asymmetry is already written down elsewhere in the same file.**
      `MAX_RENDER_SCALE_STEP_UP` caps how fast the scale may CLIMB and explicitly
      does not cap the descent: *"Downward is never capped: shedding load must
      land the instant it is asked for."* That is the right principle and the
      hold does not follow it. A hold exists to stop the ladder thrashing itself
      into a resize storm; a thrash is two changes fighting, and a demote is not
      half of a thrash - it is the ladder conceding. Making the frame cheaper is
      never the move that needs damping.

      Fix, in order of confidence:

      (1) Make the hold directional. Apply it to a tier change that RAISES the
          solved scale; apply a demote's reduction on the next coalesce tick.
          `RESIZE_COALESCE_SEC = 0.5` still stops a burst from paying a realloc
          each, so this is not "resize every frame", it is "resize within half a
          second of deciding to". Small, local, and matches the principle already
          stated for the step-up cap.

      (2) Lower `SCALE_EMERGENCY_RATIO`, or measure it off the same signal the
          governor demoted on. A p95 at 3x the refresh interval is a stall; the
          governor's own `STEP_DOWN_P95_RATIO` is 1.5. Two thresholds on the same
          measurement, 2x apart, where the lower one decides that the frame is in
          trouble and the higher one decides whether to do anything about it
          quickly. If (1) lands, this may not be needed at all - but the gap
          between the two ratios is worth a comment either way.

      Not attempted here: this is a second controller change in the same pass as
      F149, on the same unmeasured axis, and stacking them would make the next
      session's log unreadable as evidence for either. F149's result should be
      confirmed on a second machine first.

      **Confirmed again, larger, on a resized window** *(2026-08-30,
      `audiovis-session-2026-08-30-09-47-58`, 147 s, buffer 1996x1123)*. This
      session's ladder reached tier 0 for the first time in the corpus, and the
      lag scaled with it:

           18.57  DEMOTE 1 -> 2   relief at 25.60   7.03 s
           20.57  DEMOTE 2 -> 3   relief at 25.60   5.03 s
           22.58  DEMOTE 3 -> 4   relief at 25.60   3.02 s
           55.41  DEMOTE 2 -> 3   relief at 58.52   3.11 s
           73.10  DEMOTE 0 -> 1   relief at 75.55   2.45 s
           75.12  DEMOTE 1 -> 2   relief at 75.55   0.43 s
           77.13  DEMOTE 2 -> 3   relief at 80.15   3.02 s
           89.06  DEMOTE 1 -> 2   relief at 92.31   3.25 s
           91.06  DEMOTE 2 -> 3   relief at 92.31   1.25 s
           93.08  DEMOTE 3 -> 4   relief at 96.10   3.02 s

        frames > 33.3 ms                     41 of 8780
        inside a demote -> relief window     35
        window seconds                       31.6 s of 147.5 (21%)

      **The 7.03 s case is the hold compounding.** Three demotes 2 s apart, and
      each one re-enters the `quality.tier !== heldTier.current` branch and
      restarts `heldSince`. The ladder conceded three whole rungs and the frame
      kept paying 4.67 MP throughout. A hold that resets every time the
      controller gives up more ground is not damping a thrash, it is refusing to
      believe a trend.

      **And the tier-0 excursion is the whole failure in one sequence:**

           67.42  promote 1 -> 0            (the climb)
           72.98  scale 0.91 -> 1.00        5.56 s later, the resize finally lands
           73.10  DEMOTE 0 -> 1             0.12 s after that, the frame blows up
           73.4-75.3                        75.6, 67.4, 64.7, 58.3, 50.1 ms
           75.55  scale 1.00 -> 0.75        relief, 2.45 s after the demote

      The scale spent five and a half seconds climbing to a resolution the
      machine held for one tenth of a second. Both halves of that are this
      entry: slow up is defensible, slow down is not.

      This raises fix (1)'s priority. It is now the single largest remaining
      source of dropped frames in the corpus, and it has been measured across
      three sessions and two window sizes.

      **Fixed 2026-08-30** - `src/engine/renderScale.ts`, `PerfMonitor.tsx`.

      The hold is now directional. The decision moved out of the frame loop into
      a pure `decideTierResize()` next to the solver, so the policy is testable
      without a GPU or a React tree:

        - A tier change that LOWERS the solved scale applies on the next
          coalesce tick. `RESIZE_COALESCE_SEC = 0.5` still gates the actual
          reallocation, so this is "resize within half a second of deciding to",
          not "resize every frame".
        - A tier change that RAISES it waits out `RENDER_SCALE_HOLD_SEC` exactly
          as before. Every word of the hold's justification is about a change
          that might reverse, and that only ever described a climb.
        - The compounding case is gone by construction rather than by tuning: a
          demote no longer reaches the hold branch, so there is no clock for a
          cascade to restart.
        - A crossfade still defers a shed. That is the one case where waiting
          wins - the commit has already reallocated through its own budget
          change, and stacking a second realloc on it was the biggest cluster of
          50-250 ms frames in the older logs. It resolves on the first frame
          after the fade rather than restarting a clock, so the wait is bounded
          by the transition (under a second) instead of by 3-7 s of hold.
        - The emergency branch is unchanged and still overrides everything.

      7 tests in `renderScale.test.ts`, including the sign-flip guard (a climb
      must not read as a shed) and the three-demote cascade that produced the
      7.03 s case. `npm run check` clean.

      **Fix (2), lowering `SCALE_EMERGENCY_RATIO`, deliberately not taken.** The
      50 ms line never fired on this machine's failure mode, which is what made
      it worth writing down - but with sheds now applying on sight, the
      emergency only has to cover a CLIMB that turns out to be catastrophic, and
      3x is a defensible line for that. Revisit only if a log shows a climb
      sitting through the hold at a p95 between 25 and 50 ms.

      **Not verified live.** Same caveat as F149: this is a controller change
      and the next session log is the evidence. What to look for - the
      demote-to-relief gaps in the table above collapsing to well under a
      second, and the frames-over-33 ms count falling with them.

- [ ] **F158 - A layer that nothing asked to change disappears for 90-120 ms at
      a scene request and comes back. The budget sheds it during the two-primary
      overlap. This is a real on-screen flicker and the director never knew.**

      Found immediately by F150's `layer-visible` stream, and invisible to every
      instrument before it - the director's desire never moved, so the old
      `layer` events show nothing at all at these timestamps:

        108.06  scene: requested kifs
        108.08  layer-visible: accent: - plasma      <- gone
        108.20  layer-visible: accent: + plasma      <- back, 120 ms later
                (no `layer` event anywhere near: the desire never changed)

        136.26  scene: requested pointcloud
        136.28  layer-visible: accent: - ribbons
        136.37  layer-visible: accent: + ribbons     <- back, 90 ms later

      Mechanism, and it is a clean one. `requestScene` puts a second primary in
      flight. `SceneManager` computes `nonLayerMs` over every mounted entry, and
      during the overlap that includes BOTH primaries - the commit block promotes
      by setting `outgoing.dir = -1` then `warm.dir = 1`, so at the commit frame
      the budget is genuinely charged for two subjects. `resolveLayerIds` gets
      `remaining = frameBudgetMs - nonLayerMs`, finds the accent no longer fits,
      and sheds it. A few frames later the outgoing primary retires, the money
      comes back, and the layer is re-admitted.

      Every step of that is individually correct. The frame really is carrying
      two subjects; the layer really does not fit; shedding it really is the
      right call for that frame. The result is still wrong, because the budget is
      being asked a question about a 100 ms transient as though it were the
      steady state, and the answer is applied to something the viewer can see.

      Two candidate fixes, and the first is much smaller:

      (1) Hysteresis on the shed, not on the admit. A layer that is already
          `dir: 1` should survive a budget shortfall that lasts less than the
          crossfade, on the same reasoning that gives a newly-wanted layer a warm
          mount before it is shown: the composition's visible state should change
          at composition speed, not at budget-arithmetic speed. Cheapest version:
          do not evict a visible layer while `performanceState.transition.active`.

      (2) Charge the overlap once. The two primaries are not two subjects for the
          viewer, they are one subject mid-dissolve, and `canFundOverlap` already
          has a view on what that costs. Bigger change, touches the thing F110
          and F148 have both already moved, and would want its own session.

      Related but distinct from F150: that entry is the DIRECTOR changing its
      mind, mostly below the visible threshold. This is the BUDGET overruling a
      decision the director never revisited, above it. Both were found by the
      same two event streams, which is the argument for having added them.


## Two costs the boot prewarm and the budget model both miss (2026-08-30)

From `audiovis-session-2026-08-30-09-47-58`, the first session in the corpus
whose ladder reached tier 0. Both of these were invisible until it did.

- [x] **F159 - `chrome`'s FIRST commit costs a 148 ms frame; its second costs
      17.4 ms. It is already in `BOOT_PREWARM_IDS`, so this is not a shader
      compile - it is the shared PMREM environment map, which is built lazily on
      that mount and nothing builds it at boot.**

      First commit of each scene, against the worst raw frame in the 1.5 s after:

           41.95s  wireframe     37.6 ms    1211 triangles
           55.26s  chrome       148.1 ms   11223 triangles
           69.82s  dissolve      26.8 ms   11331 triangles
           96.75s  pointcloud    20.5 ms     527 triangles
          103.35s  maze          30.8 ms    1273 triangles

      Repeat commits of the same scenes: chrome 17.4 ms, wireframe 19.8 ms,
      dissolve 27.4 ms. So the cost is paid exactly once, on chrome, and it is
      **8.5x the next worst first mount**.

      **It is not the geometry.** `dissolve` carries MORE triangles than chrome
      (11331 against 11223) and its commits cost 26.8 and 27.4 ms. Vertex-buffer
      upload does not produce a 148 ms frame at this size on this GPU.

      **It is the env map.** `getSharedEnvMap()` has exactly one caller in the
      codebase - `ChromeFormScene`, at material construction - and it is lazy:
      `resourceCache.acquire(ENV_MAP_KEY, factory, { pinned: true })` runs
      `new PMREMGenerator(gl)` plus `pmrem.fromScene(new RoomEnvironment(), 0.04)`
      inside the factory. A PMREM prefilter is a mip-pyramid of render passes
      over a generated scene, synchronous, on the render thread. Nothing calls it
      at boot, so the first frame that ever mounts chrome pays it in full.

      The codebase already believes otherwise. `TrailLineScene.tsx` cites
      `envMap.ts` as *"PMREM (one-shot prefilter at startup)"*, and envMap.ts's
      own header says the point of sharing is to not *"pay PMREM generation per
      mount"*. Both are half true: it is paid once rather than per mount, but
      that once lands mid-show on a scene commit rather than at startup, which is
      the expensive half of the problem.

      Fix, and it is small: call `getSharedEnvMap(gl)` from the boot prewarm
      alongside `BOOT_PREWARM_IDS`. It is already `pinned: true`, so the cache
      holds it for the process regardless of chrome's mount lifecycle, and
      `releaseSharedEnvMap` is documented as safe against a pinned entry.
      `PerfMonitor` already knows the key (`envMap:room` is called out there as a
      shared non-scene resource), so the accounting needs no change.

      Worth checking at the same time whether any other scene SHOULD be using it
      and is not - a lazily-built shared resource with one caller is one refactor
      away from being built at the worst possible moment for a second time.

      **Fixed 2026-08-30** - `src/engine/SceneManager.tsx`. `getSharedEnvMap(gl)`
      now runs from the boot prewarm pump, in its own slot before the first
      scene rather than sharing a macrotask with a compile - it is the single
      most expensive item there, and not stacking synchronous GPU work on one
      task is the whole reason `PREWARM_STAGGER_MS` exists. The entry is already
      `pinned: true`, so the cache holds it for the process however chrome's
      mount lifecycle behaves; the returned reference is dropped deliberately.

      No test: the assertion worth making is "the first chrome commit no longer
      costs 148 ms", and nothing in a node test environment can compile a PMREM.
      The next session log carries the evidence - chrome's first commit should
      land near its second, 17.4 ms.

- [ ] **F160 - At tiers 0 and 1 the fixed-cost RESERVATION alone exceeds the
      entire tier budget, so `remainingMs` floors to zero and no layer can be
      admitted at the top of the ladder. 42% of this session's samples.**

           tier   samples   mean fixedMs   tier budgetMs   mean internal MP
             0        22        12.61          11.0             6.87
             1        46        10.86           9.5             5.92
             2       335         7.22           8.5             4.38
             3        94         5.97           7.5             3.47
             4        72         4.61           6.5             2.78

      Worst single sample: `fixedMs 15.23` against `budgetMs 9.5`. 241 of 569
      samples (42%) have the post chain reserving more than the whole frame is
      allowed to cost.

      This is F110's linear scaling meeting the tier ladder head-on. `fillScale`
      makes the post chain, feedback pass and optical racks scale with internal
      megapixels, which is right - they are fullscreen passes. But the tier
      budget rises far more slowly than the resolution the same tier unlocks:
      going 4 -> 0 multiplies the budget by 1.7 and the pixels by 2.5, so the
      reservation crosses the budget somewhere around tier 2 and the top two
      rungs are arithmetically bankrupt before anything is drawn.

      Visible in this session as `layer changes: 6 wanted, 2 actually shown` -
      the largest desire/shown gap yet recorded, and the F150 instrumentation is
      what made it legible.

      **It does not mean the frame is genuinely over.** `fixedMs` is a
      reservation built from `POST_CHAIN_MS = 2` and `FEEDBACK_MS = 1`, both
      explicitly estimates that `/bench` has never measured (F43, F90) - the same
      correction F148 needed. A frame at tier 0 running 16.7 ms is not spending
      12.6 ms in the post chain. What the table shows is that the MODEL is
      self-contradictory at the top of its own ladder, not that the GPU is.

      Which makes the fix order clear: **measure the post chain first** (F90).
      Retuning either the reservation or the tier budgets against numbers nobody
      has taken would just move an invented constant around. If the measurement
      says the chain really is 12 ms at 6.9 MP, then the tier budgets are wrong;
      if it says 4 ms, then `fillScale`'s reference cost is.

      **Addressed 2026-08-30, by measuring rather than retuning.** This entry
      said the fix order was to price the post chain first (F90) because
      retuning either the reservation or the tier budgets against numbers nobody
      has taken would just move an invented constant around. So that is what
      shipped: the measurement, not a new guess.

      `/bench?postchain` is a third bench mode. It is the cost pass in every
      respect - same plan, same per-cell tier pin, same per-scene render-scale
      solve, same GPU timing, no profile readback - except that `PostFXChain` is
      mounted and the GPU timer brackets the composer's draw (priorities 0.5 and
      1.5, straddling the composer's 1) instead of a bare `gl.render`. Subtract
      a cost sweep from a post-chain sweep and the remainder is the chain.

      It has to be a difference: `EffectComposer` renders the scene into its own
      buffer before running the effects, so no timer can bracket the chain
      alone.

      **It could not reuse the existing profile pass**, which also mounts the
      chain and looks like a free second sample. That pass holds one DPR across
      every cell, does a `getImageData` readback every frame, and does not GPU-
      time anything at all ("GPU timings are meaningless in that pass and are not
      read"). Differencing against it would have billed the post chain for a
      canvas readback and a resolution change - a confidently wrong number,
      which is worse than none.

      Shipped with it:

        - `BenchResult.internalMP`, so a millisecond figure carries the
          resolution it was taken at. A fullscreen pass is priced per pixel and
          the omission of that denominator is the original sin `FILL_REFERENCE_MP`
          was invented to paper over.
        - `postChainDelta()` / `formatPostChainDelta()` in benchHarness.ts. Pure,
          8 tests, and every one of the interesting ones is a REFUSAL: it will
          not subtract a pair drawn at different resolutions, will not subtract
          when either pass lacks GPU timing (CPU time is vsync-locked, so both
          passes would read identical whatever the chain costs), and will not
          assume a resolution the harness never reported. It takes the MEDIAN
          ms/MP across cells and prints the spread, because per-cell agreement is
          the signal that the method worked.
        - `/bench` parks each completed sweep in localStorage under its pass
          name, so the second run finds the first across the reload the mode
          switch requires, and a "Copy post-chain cost" button appears with the
          ms-at-2.07-MP headline.

      **Still open, and this is the point:** nobody has run it yet. The entry
      stays unticked until there is a number. When there is one, it settles which
      half of the contradiction is wrong - if the chain really is ~12 ms at
      6.9 MP then the tier budgets are too small, and if it is nearer 4 then
      `POST_CHAIN_MS` and `fillScale`'s reference are. Either way F43, F90,
      F110's magnitude and F148's source (5) all resolve with it.

## The first log after F157/F159: the steady state improved, the tail got worse (2026-08-31)

From `audiovis-session-2026-08-31-16-47-12` - 119.3 s, 7056 frames, same RTX 4060
laptop, same 2560x1440 @ baseDpr 1.5. This is the evidence run F149, F157 and
F159 each said they were waiting for, so the confirmations come first and the
new entries after.

Against `...09-47-58` (147.5 s), normalised per minute:

                        08-30      08-31
      mean ms           16.80      16.90
      p95 ms            18.5       17.3    better
      p99 ms            23.0       26.0    worse
      max ms            148.1      234.2   worse
      frames > 33 ms    16.6/min   17.6/min
      frames > 50 ms     2.8/min    9.6/min   3.4x worse

That split - p95 down, p99 and max up - is the whole story of this log, and
F162 below is the reason.

**F157 confirmed live.** Demote to the first render-scale reduction that
followed it, all nine demotes:

      14.11  DEMOTE 1 -> 2   relief 14.49   0.38 s
      41.29  DEMOTE 0 -> 1   relief 41.65   0.36 s
      43.39  DEMOTE 1 -> 2   relief 43.39   0.00 s
      51.03  DEMOTE 1 -> 2   relief 51.03   0.00 s
      75.12  DEMOTE 2 -> 3   relief 75.50   0.38 s
     100.45  DEMOTE 0 -> 1   relief 100.45  0.00 s
     102.46  DEMOTE 1 -> 2   relief 102.46  0.00 s
     104.46  DEMOTE 2 -> 3   relief 104.46  0.00 s
     106.48  DEMOTE 3 -> 4   relief 106.48  0.00 s

Worst gap 0.38 s against 5.02 s before, and six of nine land on the deciding
frame. The prediction was "the demote-to-relief gaps collapsing to well under a
second"; they did. The second half of it - "the frames-over-33 ms count falling
with them" - did not, and that is F162.

**F149 confirmed live.** Two tier-0 probes in 119 s (38.11 s, held 3.18 s;
98.43 s, held 2.02 s), against 13 in 320 s before - the back-off is doing
exactly what `RUNG_PROOF_SEC` / `RUNG_BACKOFF_SEC` were written to do. Render
scale 1.00 was still reached twice and shed both times, within 0.16 s and
1.70 s. The rung is still unaffordable and the governor still pays to relearn
it, but it now pays twice instead of thirteen times.

**F159 confirmed live.** Chrome's first commit of the session (43.60 s) costs
19.6 ms - the transition's own worst frame - and its second (112.25 s) costs
21.1 ms. Last session the same first commit cost 148.1 ms and had a second
139.7 ms frame behind it. Prewarming `getSharedEnvMap` removed both. The
145.4 ms frame at 43.39 s in this log is *not* the mount: it lands 0.21 s
before the commit, on the frame that carried `DEMOTE 1 -> 2` and
`0.84 -> 0.70` together, and it belongs to F162.

**F158 reproduced, unchanged.** One clean instance, same mechanism, same shape:

      79.05  scene: requested wingfold
      79.06  layer-visible: background: - malachite
      79.18  layer-visible: background: + malachite    120 ms later
             (the `layer` desire does not move until 80.36)

**F160 improved but still live.** Samples where the fixed reservation alone
exceeds the whole tier budget: 113 of 459 (25%), down from 42%. Worst single
sample `fixedMs 12.61` against `budgetMs 11.0`. By target tier:

      tier   n    mean fixedMs   budgetMs   over   mean MP
        0    18       9.17         11.0      33%    6.77
        1    88       8.53          9.5      25%    5.77
        2   271       7.55          8.5      31%    4.67
        3    66       3.83          7.5       0%    2.85
        4    16       1.80          6.5       0%    1.33

Still waiting on the `/bench?postchain` number, which is the only thing that
settles which half of the contradiction is wrong. Nobody has run it yet.

**F150 mostly quiet.** Two layer desires withdrawn inside 60 ms (plasma and
ribbons, both at 112.3 s, both landing on the maze -> chrome request), against
12 of 22 mounts last time.

- [ ] **F161 - The worst frame of the session, 234 ms, has nothing next to it in
      any event stream. Forty consecutive 16.6-16.8 ms frames, one 234.2 ms
      frame, then instant recovery. No resize, no tier apply, no mount, no
      layer, no program-count change.**

      At 48.07 s, on `chrome`, mid-scene:

        47.66 .. 47.83   16.8 16.7 16.6 16.6 16.8 16.7 16.6 16.7 16.6 16.7
        48.07            234.2
        48.09 ..         25.2  7.2  16.7 16.6 16.7 16.7 16.7 18.3

      Everything the 4 Hz sampler records is identical on both sides of it:
      `appliedTier 2`, `renderScale 0.75`, `drawCalls 21`, `triangles 11223`,
      `programs 18`, `transitionActive false`, `effectCount 0`,
      `mirrorSegments 0`, `lensStyle 6`. No `scale` event within 2.6 s either
      side.

      The only two things that happen anywhere near it:

        47.40  tier: promote 2 -> 1   (`appliedTier` stays 2 until 50.42 -
                                       F157's hold correctly delays the CLIMB)
        47.66  palette: cobalt -> violet

      The promote LOOKED like the more interesting suspect of the two, because
      the tier's *resolution* half was held but its *complexity* half was not:
      `quality.knobs` swaps the instant `tick()` moves the tier, and only the
      render-scale solve waits. So between 47.40 and 50.42 the frame was running
      tier 1's `raymarchSteps` / `noiseOctaves` / `particleFraction` at tier 2's
      resolution - a state the ladder did not exist in before F157 made the hold
      directional.

      Both were chased in the codebase before this entry was written, and **both
      are dead or close to it**, which is the useful half of the finding:

      (1) *A knob compiled as a `#define`, relinking a program.* Dead. Nothing in
          `src/scenes` or `src/engine` feeds a `defines` object from
          `quality.knobs`, and more decisively `ChromeFormScene.tsx:42` states
          outright that "this scene reads no `quality.knobs` value, and that is
          correct rather than an oversight". The tier promote could not have
          changed a single thing about what chrome renders. `programs` staying
          at 18 across the frame agrees.
      (2) *A palette swap building or uploading a texture.* Very weak. The
          palette is applied by `PaletteBlender`, which EASES between palettes
          over `f.delta` (`LightRig.tsx:17-21`), and every consumer found so far
          is a `Color.set()` on a uniform or a light - `PostFXChain.tsx:229/252`,
          `GradePass.ts:317`. There is no discrete apply moment to be expensive,
          no `DataTexture`, no `needsUpdate`, no mipmap. Consistent with the
          other five palette changes in this session costing nothing at all:
          worst frame in the 0.6 s after each is 16.8, 16.9, 17.0 and 16.9 ms,
          and the sixth (100.40 s) is confounded by a demote on the same frame.
      (3) *Not ours - a driver shader-cache write, a GC, a compositor or
          power-management hitch.* Cannot be confirmed or excluded from a
          frame-time array, and the clean-approach / clean-recovery shape fits it
          as well as it fits anything. With (1) dead and (2) all but dead this is
          now the leading explanation by elimination, which is an uncomfortable
          place to leave the largest frame in the corpus.

      **What would settle it.** Nothing in the current instrument set can, which
      is the actionable part. Two cheap additions, both one line in code that
      already emits a neighbouring event:

        - an event at the frame where `quality.knobs` actually swaps, distinct
          from the frame where `tick()` decides the tier. F157 made the hold
          directional, so decision and application are now up to 3 s apart and
          nothing records the second one.
        - `performance.measure` marks around the composer draw and the scene
          draw, so a 234 ms frame can at least be attributed to inside-the-app
          or outside-it.

      If a rerun on this machine reproduces an isolated >100 ms frame with those
      marks showing the app doing nothing unusual, the entry closes as external
      and the p99 target moves accordingly.

      Second, weaker instance of the same shape at 94.42 s (39.1 ms, 0.39 s after
      `0.80 -> 0.97`), which may just be the tail of that resize.

      **Instrumented 2026-09-01, not explained.** The `knobs` event now exists —
      `sessionLog.ts` pushes one whenever the complexity bundle the scenes
      actually read changes value (steps / octaves / jacobi / particles /
      budget scale), which since F157 made the hold directional can be seconds
      away from the `tier` event that decided it. Suppressed inside a crossfade,
      where `TRANSITION_DISCOUNT_TIERS` eases the same knobs dozens of times for
      a reason the transition events already record; the question this exists to
      answer is what moved when nothing structural was happening.

      The second instrument the entry asked for — `performance.measure` marks
      bracketing the composer and scene draws, to split an app stall from an
      external one — is **not** shipped. It is the one that would actually close
      this entry, and it wants a browser session to validate against rather than
      a blind commit.

      Note what the `knobs` stream will and will not settle. If a `knobs` line
      lands on the 234 ms frame, hypothesis (1) is alive again despite the
      static read of the code. If the stream is silent there — which is what the
      code says to expect, since `chrome` reads no knob — then every in-app
      cause this session can distinguish is exhausted and (3) is the finding,
      not the fallback.


- [~] **F162 - F157 made the relief immediate, which also means a demote now pays
      the tier change AND the composer reallocation on the same frame. The steady
      state got better and the tail got three times worse: the two worst frames
      of the session are both demote frames.**

      This is the cost of the fix, and it was foreseeable from F140 - the entry
      F157 was careful not to stack itself on. Now that the shed applies on
      sight, the frame that decides to demote is also the frame that frees one
      `EffectComposer` and allocates another.

      All 35 frames over 33 ms, classified by what is within 0.3 s:

        render-scale change      20
        maze at 8.29 MP (F164)   11
        scene commit              2
        unexplained (F161)        2

      The scale-change 20, worst first, by the resolution they were leaving:

           t        ms      change                    demote on same frame?
         51.03    196.9     0.91 -> 0.75  (6.87 MP)   yes
         43.39    145.4     0.84 -> 0.70  (5.85 MP)   yes
         75.12    103.7     0.70 -> 0.59  (4.06 MP)   yes
         41.29     77.6     0.84 -> 1.00 climb, shed 0.16 s later
         14.11     66.1     0.80 -> 0.97 climb, shed 0.38 s later
        100.51     63.8     1.00 -> 0.84  (8.29 MP)   yes
         41.65     50.6     1.00 -> 0.84  (8.29 MP)   yes

      **The cost is in the resolution being left, not the one being entered, and
      shrinking is the expensive direction.** Every pair in this log runs that
      way:

           13.95  0.80 -> 0.97  climb     24.9 ms
           14.49  0.97 -> 0.80  shrink    57.0 ms
           41.13  0.84 -> 1.00  climb     30.7 ms
           41.65  1.00 -> 0.84  shrink    50.6 ms
           50.40  0.75 -> 0.91  climb     36.1 ms
           51.03  0.91 -> 0.75  shrink   196.9 ms

      and the changes made down at 0.40-0.60 cost 17-21 ms, so it scales with the
      buffer being torn down. A grow can hand the driver a fresh allocation and
      let the old one retire whenever; a shrink appears to be paying for the
      teardown synchronously.

      Note what this does NOT say. The old behaviour was worse: it carried the
      failed tier's resolution for up to 5 s, which cost 22 of 26 slow frames
      spread over seconds of visible stutter, and p95 has come down 18.5 ->
      17.3 ms because that is gone. Trading a smear for a spike is the right
      trade at equal area - but the area did not stay equal. Frames over 50 ms
      went from 2.8/min to 9.6/min.

      Fix shape, in order of confidence, all of it F140's territory:

      (1) **Do not reallocate; keep a pool.** Allocate the composer's targets at
          the largest size the session will use and render into a
          viewport-restricted sub-rectangle. This is the standard answer to
          dynamic-resolution rendering, and it deletes the whole class of frame
          rather than moving it. It is also the largest change.
      (2) **Retire the old target off the deciding frame.** If the shrink cost
          really is the teardown, dropping the reference and letting it be
          collected a frame or two later converts one 197 ms frame into a smaller
          cost now and an unknown cost later. Cheap to try, easy to measure
          against this log, and it may only relocate the stall.
      (3) **Separate the two events.** Apply the tier's complexity knobs on the
          deciding frame - that is the relief that costs nothing - and the resize
          on the next coalesce tick, 0-0.5 s later. Keeps F157's principle that
          the shed lands immediately while not billing one frame for both.
          Smallest of the three, and it interacts with F161's hypothesis (1).

      Whichever is taken, the measurement to hold it to is in this log: frames
      over 50 ms per minute, which must come back under 2.8.

      **Partly addressed 2026-09-01, and the smallest of the three shapes above
      is deliberately NOT the one taken.** Fix (3) — split the tier change off
      the resize — was written down as the cheapest, and looking at it with the
      code open it buys nothing: `quality.knobs` swaps on the decision either
      way, and on more than half the roster (`chrome`, `wireframe`, `matrix`,
      `kifs` read no knob at all, per `sceneCost.ts`'s own header) the tier's
      only lever IS the resolution. Splitting them would move a 197 ms frame
      half a second later, not make it cheaper. Fix (1), the pool, remains the
      only thing that deletes the cost, and it is a session of its own.

      What shipped instead attacks the COUNT rather than the price, on the one
      side of the asymmetry where the count is optional —
      `MIN_CLIMB_PIXEL_RATIO` / `worthReallocating` in `renderScale.ts`, gating
      `applyRenderScale`:

        - **A climb must buy at least 1.25x the pixels or it is refused.** Cost
          is linear in pixels, so the 0.97 -> 1.00 this session paid for at
          98.75 s added about 1 ms to a 16.7 ms frame and 3% of linear
          resolution — the clearest case in the file of a two-figure
          millisecond stall bought for a change below the threshold of
          perception.
        - **A shed is never gated.** Same asymmetry `MAX_RENDER_SCALE_STEP_UP`
          and `decideTierResize` already state: relief is not optional. This is
          the third and last place that could have paid for a resize nobody
          asked for.
        - **1.25 is not a free parameter.** It is bounded above by
          `MAX_RENDER_SCALE_STEP_UP` squared (1.5625): a gate stricter than the
          largest step the ratchet can take would deadlock the climb walk
          entirely. There is a test that pins that relationship rather than the
          number.
        - The gap is measured from the APPLIED scale, not the last solved one,
          so a slow drift accumulates into one resize instead of being refused
          forever.

      **Replayed against this session's 29 scale changes it refuses three**:
      0.70 -> 0.75 (1.148x), 0.75 -> 0.80 (1.138x) and 0.97 -> 1.00 (1.063x).
      That is a 10% reduction and it is not, by itself, worth writing home
      about. It is written down at this size on purpose: the honest claim is
      three fewer reallocations and one of them is the climb at 98.75 s that
      handed `maze` 8.29 MP and set off F164's cascade, not that the tail is
      fixed.

      **The pass/fail number stands and is not yet met.** Frames over 50 ms per
      minute went 2.8 -> 9.6 with F157; this change does not plausibly recover
      that on its own, and if the next log still shows ~9/min then fix (1) is
      the work and there is no point trying anything else first.

      7 tests in `renderScale.test.ts`. `npm run check` clean, 901 tests.


- [~] **F163 - A scene request vanished without committing and without a single
      line in any event stream saying so. The palette moved one frame later and
      stayed moved.** *(diagnosis corrected below — the two are not causally
      linked, and the original headline was wrong)*

        22.58  scene:   requested chrome
        22.60  palette: aurora -> violet
        22.60  sample:  scene chrome, activeScene wireframe, pendingScene chrome
        22.87  sample:  scene wireframe, activeScene wireframe, pendingScene null
               ^ the request is gone, and nothing recorded its going
        31.70  scene:   wireframe -> kifs        (still violet, 9.1 s later)

      `chrome` never mounts — `incomingMs` is 1.58 for exactly one sample and
      `triangles` never moves off wireframe's 1391 — so the request is dropped
      before the warm mount and costs nothing in frame time.

      **Correction, and it matters more than the original claim.** This entry
      first said the palette "hangs off the scene DESIRE rather than the scene
      COMMIT". **That is not what the code does.** `AutoPilot`'s palette block
      has its own trigger set — `sectionChange` or a latched
      `structureRecolour` — runs BEFORE any `requestScene` in the same tick, and
      its own `PALETTE_MIN_SEC` floor. The two subsystems fired one frame apart
      off the same section boundary and are otherwise unrelated; the other five
      palette changes in this session sit 1.5-4.5 s away from the nearest scene
      request. A coincidence at 4 Hz sampling read as a coupling, and the fix
      that followed from it would have changed code that was already correct.

      What survives the correction is smaller and still real: **a section
      boundary recoloured the show, the scene change that boundary also asked
      for was silently dropped, and no instrument would have told anyone.**
      `sessionLog.detectEvents` pushed an event when `pendingSceneId` became
      non-empty and updated its shadow copy silently when it cleared, so a
      commit and an abandonment looked identical — which is exactly the hole
      F118 closed for the request side and left open on the other.

      **Instrumented 2026-09-01** — `src/engine/sessionLog.ts`. A cleared
      `pendingSceneId` now pushes `scene: withdrew <id>` unless the store's own
      `sceneId` has become that id, which is the exact test for "it committed"
      (`commitScene` sets both together, so this cannot race SceneManager's
      crossfade the way a comparison against `activeScene` would).

      The summary's scene line was wrong in the same direction and is fixed with
      it: `scene changes: 15` was 8 requests plus 7 commits summed into one
      figure that read as fifteen cuts. It now prints
      `scene commits: N  requested: N  withdrawn: N`, and requests-minus-commits
      is the churn number this entry is actually about.

      **Still open** because the mechanism is unexplained. `commitScene` is the
      only writer that clears `pendingSceneId`, and it sets `sceneId` to the
      pending id in the same `set()` — yet the sample two frames later has
      `pendingSceneId: null` AND `sceneId: 'wireframe'`, which that path cannot
      produce. The remaining candidates are `outputLink`'s `adoptCommittedScene`
      (clears pending and adopts a foreign `sceneId`; should be inert with no
      output window open) and a store write from a path not yet found. The next
      log settles it: a `withdrew` line means a real abandonment to chase, and
      its absence means the request committed and something else moved `sceneId`
      back.

- [x] **F164 - Quality earned on a cheap scene is spent on the next one. The
      ladder promoted to tier 0 / 8.29 MP on `wingfold` (flat 16.7 ms) and 0.3 s
      later handed that setting to `maze`, which cannot hold it and spent 2.6 s
      hitching at a metronomic 5 Hz.**

        98.43  tier:  promote 1 -> 0          on wingfold, which had been flat
        98.73  scene: requested maze
        98.75  scale: 0.97 -> 1.00 (8.29 MP)
        98.75  scene: wingfold -> maze
        99.05 .. 101.69   17 frames over 33 ms

      The hitch is startlingly regular - 64.1, 71.9, 65.4, 60.1, 62.0, 62.6,
      60.0, 61.5, 63.8 ms at a mean interval of 0.198 s (5.05 Hz) - and each one
      is followed by two very short frames (3-8 ms) as the queue drains. It
      survives the demote cascade with its period intact and only its amplitude
      falling: ~62 ms at 8.29 MP, ~40 ms at 5.85 MP, gone by 4.06 MP. Whatever
      fires every 190 ms costs a fixed amount of fill.

      **It is the resolution, not the scene being new.** In `...09-47-58` maze
      mounted at tier 3 / 1.83 MP and ran dead flat at 16.66 ms for its whole
      tenancy, with a single frame over 28 ms. Same scene, same machine, 4.5x
      fewer pixels, no hitch. Maze is the scene F146 already established is pure
      fill on this GPU.

      Two separable problems, and the second is the structural one:

      (1) **What is periodic at 5 Hz?** Nothing in the sampler runs at that rate
          (the sampler itself is 4 Hz); the BPM at the time was 133.8, so the beat
          is 0.449 s and 0.198 s is not a clean subdivision of it; and
          `drawCalls` / `triangles` / `programs` are constant across the whole
          window. A per-N-frames job inside maze, a texture or SDF refresh, and a
          driver-side residency effect are all still open. Worth watching a maze
          pinned at tier 0 on the `D` panel before instrumenting anything.

      (2) **The governor's tier is global; the cost is per-scene.** It probes a
          rung against whatever happens to be on screen, and the roster's fill
          cost spans at least 4.5x - `wingfold` is flat at 8.29 MP, `maze` cannot
          hold 5.85. `sceneCost.ts` exists and `canFundOverlap` already consults a
          per-scene view for the crossfade, so the information is in the engine;
          the ladder just never consults it at a commit. The minimum version is a
          rule, not a model: **do not enter a scene at a tier the incoming scene
          has never held**, and re-probe from one rung down. That alone would have
          moved this mount to tier 1 and skipped a cascade of four tier changes
          and four resizes in six seconds - which per F162 is exactly where the
          expensive frames are.

      This also explains the per-scene table in the summary looking
      self-contradictory. `maze 7 s mean 19.2 p95 27.1` and `maze +layers 7 s
      mean 16.7 p95 16.7` are the same scene before and after the cascade dropped
      it to 0.40-0.47 scale. The layers are innocent; the resolution was the whole
      difference.

      **Fixed 2026-09-01** — `src/engine/quality.ts`, called from
      `SceneManager`'s commit block. `quality.enterScene(id, elapsed)` applies
      the minimum rule this entry asked for: **do not enter a scene at a tier
      that scene has never held.** A scene with a proven rung enters at it; a
      scene with no record enters one rung down from wherever the ladder sits
      and re-probes from there. It only ever moves the tier CHEAPER — entering
      richer is what the climb is for, and the climb has its own evidence.

      Three properties worth stating, because each is a way this could have gone
      wrong:

        - **It is not a ratchet.** `tick` climbs back out of the caution on its
          normal hysteresis, and the first time the scene holds a richer rung
          steadily for `RUNG_PROOF_SEC` that becomes its new record. A scene
          that only ever mounts on a busy machine is not condemned to tier 4
          forever.
        - **The caution is not charged to `blockedUntil`.** `enterScene` clears
          the probe, so a demote that follows it blames the rung the LADDER
          chose, not the one the commit imposed. There is a test for exactly
          this, because the opposite would have quietly poisoned F149's back-off
          with every scene change.
        - **It is cleared by `clearRungMemory`**, alongside F149's record and
          for the same reason: "maze cannot hold tier 0" is a claim about a
          pixel count, and a resized window invalidates it. The active scene id
          is forgotten with it, which suspends PROVING until the next commit —
          immediately after a resize the current tier has not been demonstrated
          at the new pixel count either.

      **It could not be priced from `sceneCost.ts`, and that is its own
      finding.** That table is per-scene per-TIER with no megapixel denominator,
      so it reads `maze` as the cheapest scene in the roster at 0.42 ms — on the
      strength of a sweep taken at maze's own low `pixelBudget` solve. Its
      header says as much ("these rows are a floor for those, not a ceiling").
      Consulting it here would have predicted the exact opposite of what
      happened, for the exact scene that failed. So the memory is observational,
      the same shape as F149's: it learns from what the machine has been seen
      doing. **The missing denominator is the same original sin F160 named for
      the post chain**, now visible in a second table, and it is what F88 should
      be widened to cover.

      8 tests in `qualityGovernor.test.ts`. `npm run check` clean, 901 tests.

      **Not verified live.** Same caveat as F149 and F157: this is a controller
      change and the next session log is the evidence. What to look for — a
      commit into a scene the ladder has not measured should show a `tier` event
      one rung cheaper within a frame or two of the `scene: X -> Y` line, and
      the maze cascade (four demotes and four resizes in six seconds) should not
      recur.

      Part (1) of this entry — **what is periodic at 5.05 Hz inside maze** — is
      untouched and stays open. Nothing above explains it; the fix only stops
      the ladder from putting maze somewhere the period is expensive.


## The first log since the audit pass: two new instruments confirmed, one mojibake bug, one worth-watching coincidence (2026-09-01)

`audiovis-session-2026-09-01-06-35-50` is the first recording taken since this
project ran a full pass against a competitive audit (Oklab palettes, VA-driven
selection, habituation, percentile exposure, camera shot taxonomy,
boundary-aware transitions, per-band clocks/beat oscillators as scene
uniforms, three effect scenes, the show-quality telemetry block, GPU timer
queries, and the consecutive-overbudget emergency demote). None of that had
been checked against a real track before this. Two things it confirms
working, one bug it exposed, one coincidence worth a second data point.

**Confirmed working.** The `--- gpu time ---` block reports real numbers for
the first time (`EXT_disjoint_timer_query_webgl2` is available on this
machine): mean 1.65 ms, p95 4.22 ms, 10% of frame time. Sane on its face —
frame time itself is pinned to the 16.7 ms vsync interval nearly the whole
session (mean 16.7, p50 16.7), so a GPU that is only 10% of that says the
session was vsync-bound, not GPU-bound, which is exactly the state a healthy
60 Hz session should be in. The `--- show quality ---` block also reports
real numbers for the first time: beat hit score 67% (cuts land within an
eighth note of *some* beat two times in three), beat coverage 5% (of 191
bars spanned, cuts landed near the *downbeat* specifically on about ten of
them), mirror duty cycle 18%, lens duty cycle 89%, scene/palette entropy
0.98/0.83. None of these are judged good or bad here — they exist now, which
is the whole point of the instrument — but the shapes are all physically
plausible (a show that is mostly vsync-bound, cuts that favour rhythm loosely
over hitting the bar precisely, a lens that is nearly always on and a mirror
that rarely is) rather than degenerate (all-zero, all-100%, NaN), which is
the first evidence any of c13/c11b's new arithmetic is wired correctly
end-to-end rather than only in its 52+16 unit tests.

- [x] **F165 · The GPU-share line's only punctuation mark corrupted to "â" in the downloaded report**
      The one non-ASCII character ever written into a `buildSummary()` line —
      an em dash in the new `--- gpu time ---` block's "GPU share of frame
      time: 10% — the rest is..." — came back as "10% â the rest is..." in
      both the `.txt` and the `summary` field of the `.json`, identically.
      Checked the source: `sessionLog.ts`'s own bytes are correct UTF-8
      (`e2 80 94`, confirmed with `xxd`), and every one of the roughly 150
      other lines `buildSummary()` emits has apparently never used a
      non-ASCII character before — grepped every `L.push(` call in the file
      and this em dash was the only one. Whether the corruption happens in
      `recorder.ts`'s `Blob([summary], { type: 'text/plain' })` (no
      `charset=utf-8` on the MIME type, though a `Blob` built from a JS
      string is UTF-8 by spec regardless of the declared type, so this is an
      unlikely culprit) or somewhere further downstream in how the file was
      later read back on this Windows machine could not be pinned down
      without a live repro, and doesn't need to be: the fix is to stop being
      the first line in the file's history to test that path. Replaced the
      em dash with a parenthetical, matching the ASCII-only convention every
      other line in this function already follows by construction rather
      than by rule. If a future line wants real Unicode, `recorder.ts`'s
      Blob call is the place to check first, and this entry is why.
      `npm run check` clean, 1149 tests (the fix touches no logic, only a
      string literal).

- [ ] **F166 · A climb one point under the reallocation cap still owned the session's worst frame**
      `MAX_RENDER_SCALE_STEP_UP` (F157, 1.25×) exists to stop a big budget
      jump from leaping straight to native and cascading demotes. At 111.75s
      here, `chrome` requested `plasma` with a new `matrix` overlay, and the
      render scale climbed 0.69 → 0.86 — a ratio of 1.246×, inside the cap —
      and the session's single worst frame (55.4 ms, more than 3× the 16.7 ms
      interval) landed seven hundredths of a second later, followed by two
      tier demotes (0→1, then 1→2) in the next 260 ms. The existing
      layer-churn telemetry (F150) already explains part of it — `matrix`
      is logged among the session's "layer desires withdrawn within 1s" at
      exactly `379ms @ 111.8s` — so this was a scale climb landing in the
      same instant as a warm-and-immediately-drop overlay mount, not the
      climb alone. One occurrence in one session is a data point, not a
      pattern: recorded here so a second session with the same shape (a
      climb just under 1.25× coinciding with a layer churning inside a
      second) is recognisable rather than re-discovered from scratch. Not
      actioned — there is no fix implied by a single sample, and the two
      already-shipped mitigations (the 1.25× cap itself, and F149/F164's
      rung memory) both did exactly what they were built to do: the ladder
      recovered within 260 ms and did not oscillate.


## Verification status

`npm run check` passes: typecheck, lint (0 errors, 0 warnings), **1149 tests**
(1 skipped, see F108), build.

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
