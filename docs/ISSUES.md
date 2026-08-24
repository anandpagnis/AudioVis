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

- [ ] **F02 · The "AI" tier depends on the customer's own localhost** —
      `src/engine/textureGenerator.ts`
      `generative: true` is the default and the layer polls `http://127.0.0.1:8787`
      for the sd-turbo server in `backend/server.py`. No paying customer will run
      that. Either host inference behind an authenticated endpoint, or default the
      toggle off and label it a developer feature.

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

## Image feedback, the post-chain budget, and the fullscreen crash (2026-08-25)

Found while porting lilim's feedback pass and chasing a report of the app
hanging. Measurements below were taken under **SwiftShader (software GL)** in a
headless browser unless stated otherwise — treat them as *ratios between
configurations*, never as anyone's real frame rate.

- [ ] **F46 · `performanceState.fog` is inert on 15 of the 16 scenes** — *verified,
      not fixed*
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

- [ ] **F47 · Vignette is applied but reads as inert on most scenes** — *partly
      diagnosed*
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

- [ ] **F50 · The full engine renders behind the start card** — *known, not fixed*
      `src/routes/Visualizer.tsx`
      `<Stage/>` is mounted unconditionally, so every director, the scene, and the
      whole post chain run at full cost while the user is still looking at the audio
      source picker. Bisected: removing only the post chain took that screen from
      133 ms to **16.7 ms per frame**, so it is ~87% of the cost of a screen that is
      showing a dialog.
      Gating `<Stage/>` (or at least `<EffectsDirector/>`) on `status === 'running'`
      is the lever. The cheaper half-measure — dropping bloom's `mipmapBlur` while
      idle — changes the effect list, which per this component's own header rebuilds
      the merged shader, so gating the mount is the safer shape.

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

- [ ] **F52 · `trails` has no director, and its control surface is scaffolding** —
      *by design, needs following up*
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

- [ ] **F54 · The lens rack pays one fullscreen blit that never switches off** —
      *by construction, needs a better answer*
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

- [ ] **F55 · Both optical racks are invisible to the frame budget** — *open,
      and it must close before any director drives them*
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

- [ ] **F56 · Neither optical rack has a director** — *by design, same posture as
      F52*
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

## Verification status

`npm run check` passes: typecheck, lint (0 errors, 0 warnings), **537 tests**, build.

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
