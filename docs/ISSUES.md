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

- [x] **F02 · The "AI" tier depends on the customer's own localhost** —
      `src/engine/textureGenerator.ts` *(deleted)*
      `generative: true` was the default and the layer polled `http://127.0.0.1:8787`
      for the sd-turbo server in `backend/server.py`. No paying customer would run
      that, and it had never been used even in development. Resolved by deleting
      the feature outright — `backend/`, `GenerativeLayer.tsx`, `textureGenerator.ts`,
      the `generative` store field, and every touchpoint (frame-budget accounting,
      the `G` shortcut, the debug readout) — rather than gating it behind auth.

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

- [ ] **F14 · 256-iteration CPU waveform decimation runs while invisible** —
      `src/scenes/FlowRibbonScene.tsx`
      The oscilloscope loop and its texture upload run every frame regardless of
      `vis`. Same class of bug as F05, cheaper per instance, but it applies to every
      layer instance. Deliberately left out of the F05 pass to keep that change
      scoped to the three offscreen-pass scenes.

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

- [ ] **F18 · The background slot has no content**
      Zero scenes declare the `background` role, so the most structural slot — with a
      considered 0.40 gain and section-boundary-only recompose logic — is permanently
      empty. `orbs` is documented in its own comment as the obvious candidate, and
      would also widen the layer pool (see F19a).

- [ ] **F19 · Two primaries produce no layers at all**
      With `plasma` or `network` as the subject, no compatible scene carries a layer
      role, so the composition silently collapses to a single scene. Layer presence is
      an accident of the compatibility graph rather than a decision.

- [ ] **F20 · The effect slot is fully built and completely empty**
      `EffectDirector`, the pinned-entry lifecycle, `slotProgress`, trigger edges and
      `syncEffectEntries` all exist and are tested; `getEffectScenes()` returns
      nothing. The cheapest available upgrade to how a drop *feels* — the machinery is
      finished and waiting on one authored scene.

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

- [ ] **F33 · The bench mismeasured the particle scenes** — *fixed, needs a re-run*
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
      **Re-run `/bench` and retag `plasma` / `dissolve` / `pointcloud`.**

- [ ] **F34 · The bench frames scenes with the wrong camera** — *known limitation*
      It uses the default Canvas camera at `[0,3,13]`, not CameraDirector. Scenes that
      read the real camera (`chrome`, `inversion`, `torusfold`) are measured from an
      unrepresentative distance — `torusfold`'s anchor is 3.3 units, so at 13 it is
      mostly empty space and marches out cheaply. Treat their numbers as a floor.

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

- [ ] **F42 · Four scenes ignore the quality governor entirely** — *diagnosed, not
      fixed*
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

- [ ] **F25 · No attribution for frame-time spikes** — *not started*
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

---

## Verification status

`npm run check` passes: typecheck, lint (0 errors, 0 warnings), **314 tests**, build.

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
