# AudioVis — Project Handoff

## 0. Start here

Orientation for picking this up cold. Everything below is current as of the
last session; §2 item numbers are a running history, so read this section first
and treat it as the summary of record.

**What it is.** A browser-based AI VJ engine: it listens to live music,
interprets structure (tempo, beats, phrases, drops, mood, key, voice) and
performs a deliberate visual journey. React 19 + React Router 7 +
React Three Fiber + Three.js + Zustand for the app; Essentia.js (WASM) +
TensorFlow.js running in background Web Workers for the music-intelligence
layer beyond core DSP (see §2 item 19, `docs/02_Music_Intelligence.md`).
Public-facing gateway landing page at `/`, the visualizer itself at `/app`
(mobile/WebGL-gated — see `src/App.tsx`). Deployed to Cloudflare Workers
(`wrangler.jsonc`, committed — do not delete it, see §2 item 19). Also runs
purely locally: `npm run dev` → <http://localhost:5183/app>.

**The two rules that override everything else**

1. **Buttery smooth beats visual ambition.** Frame-time variance matters more
   than richness. A scene that hitches is a failed scene no matter how it looks.
   *Measure the frame cost of anything heavy before declaring it done* — this
   has been violated twice (see §2 item 16) and both times the scene shipped
   unusable at 10 fps.
2. **Crystal-cut, not glow-soup.** Subject + negative space + hard edges, on
   dead black. Target exposure is roughly ≤15% of frame lit, mean luma <20, and
   **0% blown to white**. Full rationale in `docs/09_Rendering_Engine.md`.

**Current roster (11, all primary-capable)**

| id | name | technique |
|---|---|---|
| `wireframe` | Wireframe Hero | `Line2`/`LineMaterial` true edge geometry — **this is `SCENES[0]`, the fallback** |
| `plasma` | Plasma Filament | 70k curl-noise points, screen-space streaks |
| `dissolve` | Dissolve Cage | particle form scattering inside a wireframe cage |
| `chrome` | Chrome Form | `MeshPhysicalMaterial` + PMREM env map |
| `ribbons` | Flow Ribbons | vertex-shader strips that **trace the synth waveform** |
| `network` | Network Constellation | fullscreen-quad jittered node web (also the only non-`wireframe` scene that can run as accent/overlay/background, not just primary) |
| `pointcloud` | PCD LIDAR Scan | 60k-point deterministic procedural cloud (fixed seed — reproducible recordings) |
| `inversion` | Inversion Machine | raymarched sphere-inversion fractal ("Kali tiling") |
| `foldpath` | Fold Path | fixed-step heightfield flythrough, recursive IFS-fold fractal texture |
| `torusfold` | Torus Fold | Mandelbox-style folded-space fractal intersected with a torus |
| `juliawings` | Julia Wings | 2D Julia-set variant with moth/butterfly-wing symmetry |

Six of these (`network` through `juliawings`) are ports of Shadertoy pieces, several unattributed by
the original source — see each scene file's header comment for the credit/license note before reusing
outside this project.

**Architecture in one line.** Audio → `AudioFeatures` → *decide* band writes
`performanceState` → *execute* band (Camera/Animation/Effects directors +
scenes) reads it. The decide/execute boundary is the whole design; see §3.

**Before handing off any change:** `npm run check` (typecheck + lint + 222 tests
+ build) and the checklist in §8.

**Biggest open gap:** almost nothing here has been verified against *real
music*. Exposure, geometry, band response and frame cost are all measured, but
"does it feel right on a track you'd actually play" is untested — the preview
browser is backgrounded, which throttles the render loop. That is the single
most valuable thing to do next.

---

## 1. Product vision

AudioVis is a browser-based audio-visual performance engine. Its purpose is not merely to draw a
single waveform-reactive animation; it should interpret the structure of a song and perform a
visual journey through it. A quiet intro should have room to breathe, a build should accumulate
motion and density, a drop should land with a clear visual event, and later sections should feel
like deliberate chapters rather than a random scene carousel.

The long-term product is a modular visual instrument:

- a user can manually choose a scene, palette, and response intensity;
- the app can direct a complete song automatically;
- one performance can combine a primary scene with accent and overlay scenes;
- a custom scene can be registered with metadata and immediately participate in mood selection,
  compatibility filtering, composition, and presets;
- audio response is expressive enough to distinguish sub/bass, mid, vocal presence, highs,
  transients, beats, drops, and builds;
- the visual result remains performant and usable as an OBS source, fullscreen installation, or
  live VJ tool.

## 2. Current implementation status

### Implemented

1. **Audio input and analysis**
   - System/tab audio capture through `getDisplayMedia`.
   - Microphone/line-in capture through `getUserMedia`.
   - A reusable `startWithStream(MediaStream)` extension point for future virtual cables,
     network streams, OSC/MIDI bridges, and synth inputs.
   - FFT, RMS, adaptive energy normalization, onset flux, BPM estimation, beat grid, phrase
     novelty detection, drop/build heuristics, silence detection, and mood estimation.

2. **Musical understanding**
   - Seven committed moods: silence, ambient, mellow, groove, building, peak, aggressive.
   - Hysteresis prevents per-frame mood whiplash.
   - Predicted mood and estimated beats-to-transition support pre-queuing.
   - Beat, bar, measure, phrase, section-change, drop, and build flags are available to scenes.

3. **Scene registry and metadata**
   - Five scenes are registered in `src/scenes/index.ts` — see the table in §0.
     `SCENES[0]` (`wireframe`) is the load-bearing fallback: `getScene()` returns
     it for any unknown id, so a stale persisted `sceneId`, preset, cue, or
     `?scene=` param degrades instead of breaking. Keep it cheap and safe.
   - Each scene declares roles, mood affinity, audio-band affinity, intensity, compatibility, and
     rough performance cost.
   - `registerScene()` and lookup helpers provide the extension contract for custom scenes.

4. **Audio response contract**
   - `AudioFeatures` now includes `sub`, `bass`, `mid`, `presence`, `high`, `vocal`, `energy`,
     `transient`, and structural timing values.
   - `getAudioResponse()` in `src/engine/audioResponse.ts` exposes stable visual envelopes for
     custom scenes without requiring FFT knowledge.

5. **Musical transitions and automation**
   - Manual scene requests commit on a trusted downbeat, with a safety timeout when the grid is
     unavailable.
   - Scene crossfades last roughly two beats.
   - `AutoPilot` reacts to committed/predicted moods and selects scenes/palettes.
   - `PerformanceDirector` makes phrase/section-level choices based on mood, compatibility, and
     dominant audio bands.

6. **Composition layers**
   - The primary scene can run with one accent and one overlay scene.
   - Layer changes fade independently from primary scene transitions.
   - Layer choices are exposed in the presets panel and persist with presets/local storage.
   - The automatic director conservatively adds an accent or overlay during appropriate sections.

7. **Visual framework**
   - Palette blending, mood-driven parameter multipliers, shared camera/light rigs, beat-reactive
     post effects, optional local AI texture overlay, adaptive quality scaling, and disposal
     helpers are in place.
   - The 17 pre-pivot legacy scenes were deleted outright (in git history if ever
     wanted); `docs/09_Rendering_Engine.md` explains the cull and why the
     "small roster" constraint has since been lifted.

8. **Persistence and operation**
   - Scene, layers, palette, visual parameters, quality, automation toggles, favorites, user
     presets, and microphone selection persist in `localStorage`.
   - URL parameters support OBS/wallpaper deployments.
   - Presets support save, favorite, delete, import, and export.

9. **Authored song performances (Phase 5)**
   - A cue timeline: `captureCue()` snapshots the complete current look (scene, layers,
     palette, params, layer FX) anchored to the beat counter; cues persist, live in presets,
     and survive share URLs. Re-capturing within ±1 beat replaces the old cue.
   - `CueTimeline` plays cues back as their beats arrive (through the normal downbeat-commit
     pipeline) while `cueState.governed` suppresses AutoPilot and the PerformanceDirector;
     automation resumes 32 beats after the final cue. "Follow" toggle + cue list with delete
     and clear live in the presets panel; `C` captures live.
   - Imported presets validate cue scene IDs and silently drop cues for unregistered scenes.

10. **Richer musical inputs (Phase 7)**
    - Local audio files are a first-class source: they play through the speakers while
      driving the full analysis pipeline — ideal for rehearsing and authoring cue timelines.
    - `BpmEstimator.setExternalTempo(bpm, beatTime, now)` safely overrides the estimator
      (onset tracking pauses; control returns automatically ~2 s after the clock stops).
    - A Web MIDI clock adapter (`src/audio/MidiClock.ts`) averages 0xF8 ticks into a tempo
      and re-anchors phase on Start — enabled by the "MIDI clock" toggle in the tune panel.
    - Virtual audio cables (BlackHole/VB-Cable) work through the existing mic-device path.

11. **Export (Phase 8)**
    - Canvas recording (`R` / the ● rec chip): canvas at 60 fps plus the analyzed audio
      (a dedicated recording tap on the audio graph) into a downloadable .webm.
    - PNG screenshots (`S`); the renderer runs with `preserveDrawingBuffer`.
    - Shareable look URLs: the presets panel "share" button encodes scene, layers, palette,
      params, layer FX, and cues into `#look=<base64url>`; opening the link restores it all
      (validated through the preset sanitizer).

12. **Deeper visual response and quality control (Phase 6)**
   - Each composition layer has an intensity slider (0–1.5× on its fade weight) and a blend
     mode (`add`, `screen`, `normal`, `multiply`); both persist and are captured in presets.
   - Declarative band routing: up to six `source → parameter` mappings (sub/bass/mid/presence/
     high/vocal/energy/transient/beatPulse → intensity/speed/reactivity) with signed amounts,
     applied inside `getEffectiveParams()` so every scene and the post chain respond.
   - Response shaping: band attack/release multipliers and beat-subdivision control
     (½×/1×/2×/4× pulses per grid beat) via `audioEngine.tuning`, editable in the tune panel.
   - Code-splitting: each built-in scene and the AI texture layer are lazy chunks
     (`preloadScene()` fires on request, so chunks arrive before the downbeat commit);
     three.js/react/postprocessing ship as separate long-cacheable vendor chunks.
   - GPU telemetry in the debug panel: draw calls, triangles, geometry/texture counts, and
     shader program count from `renderer.info`, alongside fps and render scale.

13. **Wider audio detection + numeric analytics/testing**
    - `AudioFeatures` gained four additive signals, none of which touch the six original bands'
      calibration: `air` (~9–16 kHz shimmer/cymbal-wash, above where `high` stops), `spectralFlatness`
      (tonal vs. noisy texture), `spectralRolloff` (a brightness cue robust to one dominant bin),
      and `crestFactor` (peak/RMS — pushed/brickwalled vs. dynamic material). All four feed new,
      clearly-labeled additive terms in `MoodEstimator.score()` — existing state weights are
      untouched. The heavy per-bin spectral loop moved to a pure, unit-tested function,
      `src/audio/spectralFeatures.ts`.
    - Three signals that were already computed but silently discarded are now exposed: beat-grid
      tracking accuracy (`AudioFeatures.beatGridAccuracy`, from `BpmEstimator`'s internal
      `hitScore`), continuous section-boundary strength (`AudioFeatures.sectionChangeStrength`,
      the un-thresholded value behind the boolean `sectionChange`), and the full 7-state mood
      score distribution plus a derived ambiguity score (`MoodMomentum.scores` /
      `MoodMomentum.ambiguity`).
    - A live **Analytics panel** (`Y` key / `analytics` chip) replaces "watch the debug panel and
      eyeball it" with rolling numeric readouts: beat-tracking accuracy, mood confidence/ambiguity
      trends, the live mood-score bar chart, section-change strength against its firing threshold,
      frame-time percentiles (not just the FPS average), and a recent-transitions table comparing
      target vs. actual crossfade duration and frame-time p95 during the fade. Backed by a shared
      `RollingWindow` utility (`src/engine/RollingWindow.ts`) and two new instrumentation modules,
      `analyticsMetrics.ts` and `transitionMetrics.ts` — the latter taps a new (and previously
      nonexistent) transition-lifecycle hook in `SceneManager`.
    - A Vitest suite (`npm run test`, folded into `npm run check`) unit-tests the pure DSP layer
      directly — `BpmEstimator` (synthetic click tracks, on-grid vs. jittered `hitScore`, tempo-change
      persistence), `PhraseDetector`, `MoodEstimator`, `spectralFeatures`, and `RollingWindow` — 28
      tests, no browser or real audio file required since these classes take plain data. A GitHub
      Actions workflow (`.github/workflows/ci.yml`) runs `npm run check` on every push and PR to
      `main`.
    - Deliberately not built: any AI/ML involvement. The mood system stays pure heuristic DSP by
      design (see `docs/02_Music_Intelligence.md`); if "does it pick up the vibe correctly" ever
      needs an outside opinion, the recommended shape is an optional, manual, offline calibration
      script — never in the render hot path, never gating CI.
    - Also removed in this pass: `audiovis-core/` (a frozen duplicate snapshot of `src/audio` +
      parts of `src/engine`/`src/scenes`, never part of the build), and the superseded root docs
      `ART_DIRECTION_ROADMAP.md` / `PHASE_IMPLEMENTATION_GUIDE.md` / `VISION.md` (content merged into
      `docs/00_Vision.md` and `docs/09_Rendering_Engine.md`).

14. **AI Performance Engine refactor — Phases 1–2 of 6**
    - **`PerformanceState`** (`src/engine/performanceState.ts`) is the new seam.
      Above it, creative systems decide what the show wants; below it, executors
      do what it says. Single-writer by convention, mutable singleton for the
      same zero-allocation reason as `audioEngine.features`. A future ML
      director, or a non-Three renderer, plugs in at this one object.
    - **`CameraDirector`** owns all camera motion (9 modes: orbit/hover/push/
      pull/spiral/handheld/locked/topdown/cinematic). Scenes now declare only a
      `cameraAnchor` (subject centre, distance, height) and which `cameraModes`
      suit them — no scene moves the camera. This also deleted the per-scene
      `fade.value >= lastFade` crossfade arbitration: with one writer, two
      mounted scenes can no longer fight for the lens.
    - **`AnimationDirector`** publishes reusable primitives as normalized
      signals, computed once centrally. See item 18 — as originally built it had
      twelve, half of them duplicating `SceneFrame.b`, and *no consumers at all*.
    - **`EffectsDirector`** replaces `PostFX.tsx` — same fixed chain, but it now
      reads `performanceState.bloom`/`.glitch` and makes no decisions of its own.
    - **Percussion tier**: kick / snare / hi-hat are detected independently via
      band-limited onset detection (`src/audio/PercussionDetector.ts`), so
      separate visual layers can respond to separate parts of the kit instead of
      everything keying off one broadband `transient`. Deterministic DSP, no ML.
    - The 17 unregistered legacy scenes and `CameraRig.ts` were deleted.
15. **AI Performance Engine refactor — Phases 3–4**
    - **`useSceneFrame`** (`src/engine/sceneFrame.ts`) gives every scene a
      prepared per-frame context: reactivity-scaled bands, animation primitives,
      blended palette, resolved visibility, and read-only access to
      `performanceState`. This deleted the six-line preamble every scene used to
      open with (resolve params, pull reactivity, blend palette, compute pulse,
      scale each band, derive fade) — five copies, five chances to drift.
      `useSpin()` covers the accumulate-an-angle pattern four scenes shared.
    - All five scenes converted. A scene is now geometry, materials, and a
      mapping from context values onto them — no envelope math, no camera, no
      palette plumbing, no post.
    - **What deliberately did NOT move:** the band→job routing (bass=mass,
      mid=hue/rotation, presence=stroke weight, high=air/dedicated elements).
      That mapping is the art direction, and it is per-scene on purpose. The
      context prepares values; the scene decides what each one means.
    - **Post decisions are now semantic.** Bloom has a per-mood resting level
      (`BLOOM_BASE`) that the music modulates around, rather than a hardcoded
      0.65 — so a breakdown reads calm even with sharp transients and a peak
      reads hot between hits. Glitch is gated on tension and drops. `fog`,
      previously declared but inert, now deepens as the mix thins (tinted to the
      palette background, mutated in place so it never invalidates the material
      shader cache). *This item also claimed `distortion` "now does something";
      it did not — see item 18.*
    - **Not yet done (Phases 5–6):** SceneManager still owns both lifecycle and
      some commit policy, and the creative directors still write the store
      rather than `performanceState` directly. `PerformanceStateBridge` is the
      adapter that keeps Phase 6 an inversion rather than a rewrite.

15. **Fluid scenes + a usable vocal signal**
    - **`voice`** — the raw `vocal` band was computed every frame and consumed by
      *nothing*, because as a plain 250 Hz–5 kHz energy sum it fires on hats and
      distortion as readily as on a singer. Gating it by tonality
      (`vocal × (1 - spectralFlatness)`) leaves what is actually pitched. Exposed
      as `AudioResponse.voice` / `SceneFrame.b.voice`. An estimate, not a stem.
    - **Liquid Form** (`liquid`) — raymarched SDF metaballs. Voice drives the
      `opSmoothUnion` blend radius, so a sustained line visibly pulls the lobes
      *into* the core (measured: +99% lit area, core share 94%→53%) while a
      percussive bar leaves them as separate drops. Finally puts the previously
      orphaned `shaderLib.ts` to work, and honours the governor's step/octave caps.
    - **Flow Ribbons** (`ribbons`) — vertex-shader triangle strips through a curl
      field. Mid sets curl amplitude, voice sets ribbon width (+381% coverage
      from quiet to strong vocal), hats put travelling glints along the arc.
    - Both were verified by compiling *and linking* the GLSL on a real driver and
      reading back pixels — 0% blown, mean luma 6–8, matching the roster's
      hot-subject-on-dead-black target. Two composition bugs were caught only
      this way: ribbons splayed radially when streamed toward the camera, and all
      of them widened coplanar into "venetian blinds" until each got its own
      width plane. Neither is visible to typecheck, lint, or the test suite.
    - Raymarch scenes now read the real camera via `SceneFrame.camera`, so
      CameraDirector drives fullscreen-quad scenes too instead of skipping them.
    - Scene shader sources are exported (`VERT`/`FRAG`) specifically so GLSL can
      be compiled outside the app — it is otherwise completely unchecked.

16. **Liquid Form rebuilt, and layering for mids/vocals**
    - **The raymarched Liquid Form was a mistake and has been replaced.** It ran
      at **10 fps** (86 ms mean, p95 100 ms) — 96 march steps × 6 normal samples
      × multi-octave fbm — and read as a glowing orange lump rather than metal.
      Exposure and band response had been verified; frame cost had not. *Measure
      frame cost on any new heavy scene before calling it done.*
    - Rebuilt on three.js's **`MarchingCubes`**: the field is polygonised on the
      CPU and drawn as ordinary geometry, so it uses `MeshPhysicalMaterial` with
      the shared env map and looks like real mercury. Grid resolution per tier is
      set from measurement, not guesswork (res 40 = 14.2 ms of a 16.7 ms budget,
      so the top tier is capped at 28 ≈ 5 ms).
    - Voice drives `isolation` and ball count, so a sung line gathers scattered
      beads into one body. Tuned to stop short of *total* fusion — driving it all
      the way collapsed the form into a featureless egg; the visible lobes and
      necks are what read as liquid.
    - **`HarmonicAuraLayer`** (`aura`) — an accent/overlay **layer**, not a
      subject. Mid-band FFT bins are uploaded to a data texture and read by
      angle, so the ring's silhouette *is* the harmonic content (a chord grows a
      jagged crown, one note grows one spike). Voice adds a breathing halo and
      expanding rings. ~90% empty by construction so it composites over any
      primary instead of washing it out. This is the right shape for the problem:
      a vocal/mid readout that every look gains, rather than one more scene that
      only helps while it is on screen.
    - `getSharedEnvMap()` extracted to `src/engine/envMap.ts` — Chrome Form and
      Liquid Form now share one PMREM generation.

17. **Roster trim + ribbons trace the synth waveform**
    - **Removed:** Schematic, Liquid Form, and the Harmonic Aura layer. Schematic
      was `SCENES[0]`, so the fallback moved to `wireframe`; the store default,
      `performanceState` defaults, the "Drafting Table" builtin preset, every
      `compatibleWith` list, and one camera test were all repointed. If you
      remove a scene, grep for its id — it is referenced in more places than the
      registry.
    - **`AudioFeatures.midWaveform`** — a second `AnalyserNode` fed through a
      band-pass (≈1.1 kHz, wide Q) gives the time-domain wave of the lead/synth
      range. The full-mix `waveform` is dominated by kick and bass, so tracing it
      draws the drums; this one is dominated by sustained tonal material. It is a
      filter, **not** source separation — snare cracks still leak through.
    - **Flow Ribbons now trace that wave.** It is uploaded to a data texture and
      sampled along each ribbon's arc, displacing the spine across the flow, so
      the ribbon is a literal oscilloscope of the synth line bent through the
      curl field. Verified visually: flat in silence, broad undulations for a
      pad, tight ripples for an arpeggio. Decimation keeps the **extreme** per
      bucket, not the mean — averaging a waveform flattens it toward zero, which
      is exactly how a trace turns into a straight line.

18. **The execute band was built but not connected — now it is**
    Items 14–15 describe Camera/Animation/Effects directors reading
    `performanceState`. Most of that was written, documented and unit-tested, but
    **not wired to anything**: it computed values every frame that no consumer
    read. Three separate instances, all invisible to typecheck, lint, tests and
    build, because unread code still compiles and still passes.

    - **Camera mode was pinned to `cameraModes[0]`**, so six of the nine modes
      (`push`, `pull`, `spiral`, `handheld`, `locked`, `topdown`) never ran
      outside the test file, and `cutCamera()` — the section-change VJ cut its own
      docstring promises — had no caller. Now `pickCameraMode()` chooses from the
      modes a scene declares, by mood, with high tension promoting `push`/`spiral`.
      Peak and aggressive are exempt from that override: tension peaks on the drop
      that *releases* a build, and overriding there shot the release exactly like
      the build. Re-taken at section boundaries and on scene change, never per
      frame — the camera eases toward its target, so the target has to hold still.
      Runs regardless of AutoPilot. Wireframe gained `push`, Chrome and Ribbons
      gained `pull`, and a test now fails if any mode becomes unreachable again.
    - **`AnimationDirector`'s twelve primitives had zero consumers.** Six were
      deleted rather than wired: `pulse`, `flash`, `kick`, `snare`, `hihat`
      duplicated `SceneFrame.b.*` at a different scale factor, and `breathe`
      would have put every scene's idle sway in lockstep. The remaining six each
      have a consumer now (inflate→Chrome, twist→Wireframe, ripple→Ribbons,
      explode→Plasma+Wireframe, dissolve+oscillate→Dissolve Cage). `explode` and
      `dissolve` are the only path by which `visualTension` reaches the screen —
      the anticipation before a drop is in no band envelope, because the music
      there is often quiet. `applyToObject()` was deleted: it wrote absolute
      scale/position from a captured rest pose, so no scene could call it without
      surrendering the transform it already sets each frame.
    - **`distortion`, `complexity` and `particleDensity` had no readers**, while
      the scenes that should have consumed `particleDensity` reached around the
      seam to `quality.knobs.particleFraction` directly. Scenes now read the
      seam; `distortion` and `complexity` are deleted. **The rule, now recorded in
      `performanceState.ts`: a field with no reader gets deleted, not kept for
      later.** Declared-but-inert is worse than absent — it reads as wired and
      gets documented as working, which is exactly what happened here.

    Shaders were compiled *and linked* on a real driver, and the harness itself
    was checked against a sentinel with a stripped uniform declaration. There is
    still no committed tool for this (§8 mandates the check but ships nothing to
    run it) — worth adding.

19. **Essentia music intelligence, gateway landing page, and deploy fix — merged from two long-diverged branches**

    Two branches forked from the same commit and were developed independently for
    a long time before this merge: one added the Essentia.js/TensorFlow.js music
    intelligence layer, the other added the public gateway page, mobile gating,
    and a `pickVariedScene`-based role-aware scene picker. Reconciling them
    surfaced two competing implementations of the same "pick a good scene"
    problem, described below.

    - **Essentia.js (WASM) + TensorFlow.js music intelligence**, running in two
      background Web Workers so a slow model inference can never stall the beat
      grid: `essentia.worker.ts` (rhythm confirmation, key, danceability) and
      `voice.worker.ts` (a MusiCNN model for voice presence and a 4-head mood
      read — happy/aggressive/party/relaxed). `EssentiaBridge`/`VoiceBridge`
      (`src/audio/essentia/`) tap a mono PCM ring buffer via an inline
      `AudioWorklet`, schedule jobs on a slow cadence, and hold the latest async
      result for `AudioEngine.update()` to drain each frame — additive and
      degrade-gracefully: a dead/unsupported worker or unfetched model weights
      (`public/models/`, gitignored, converted via
      `scripts/convert-essentia-models.md`) just leaves those fields at their
      neutral default, and the pre-existing heuristic DSP estimators are
      unaffected. Full detail in `docs/02_Music_Intelligence.md`.
    - **Key-aware palette tracking** — `keyPaletteTracker`
      (`src/engine/keyPalette.ts`) accumulates key votes into a harmonic
      "family" that `AutoPilot`'s new `pickPalette()` prefers when it survives
      the anti-repeat filter, and section-boundary-triggered recolouring
      (`PALETTE_MIN_SEC` floor) runs independently of the scene-switch trigger
      so colour can mark structure even when the mood doesn't change. See
      `docs/07_Palette_System.md`.
    - **Voice-aware camera framing and post** — `CameraDirector` eases
      `vocalPresence` into `voiceFocus` and prefers intimate modes
      (`locked`/`push`) above a threshold, ranked below the existing tension
      override (a sung build still shoots as a build); `PerformanceStateBridge`
      folds `moods.aggressive`/`moods.relaxed` into glitch/fog as small
      additive terms. See `docs/06_Camera_Director.md`.
    - **Public gateway + routing.** `App.tsx` is now a router/gate, not a direct
      renderer: mobile/WebGL-unsupported devices see `UnsupportedScreen`;
      everyone else gets an audio-reactive tunnel landing page (`/`,
      `src/landing/`) that leads into the visualizer at `/app`
      (`src/routes/Visualizer.tsx`, which still just mounts `Stage` +
      `TacticalHUD` + `HUD` as before). Uses `react-router` 7.
    - **Cloudflare Workers deploy fix.** `wrangler.jsonc` is now committed
      (previously absent, which made every deploy re-run Cloudflare's
      auto-setup wizard from scratch — slow, non-deterministic, and the reason
      a prior `_redirects` fix silently failed to take on the next deploy).
      `wrangler` is pinned as a devDependency instead of being fetched fresh by
      `npx` on every deploy. **Do not delete `wrangler.jsonc` or let it drift
      back out of git** — that regresses exactly this bug.
    - **Role-aware scene picking, consolidated.** `getScenesForMood(mood, role?)`
      can now filter to a role (`'primary'`, etc.) directly; `pickVariedScene()`
      (`src/scenes/index.ts`) is the shared weighted-random-with-recency-decay
      picker both `AutoPilot` and `PerformanceDirector` call — floors every
      candidate's weight above zero (so nothing is ever fully unreachable),
      decays the last 4 recently-shown scenes, and accepts an optional `boost`
      multiplier. `PerformanceDirector` uses `boost` for dominant-audio-band
      matching; `AutoPilot` uses it for essentia's `vocalPresence` (favoring
      scenes tagged for the `'vocal'` `SceneBand` once the classifier is
      confident a voice is present). This replaced two independently-written,
      non-scaling pickers (each hardcoded to rotate between only the top 2
      candidates for a mood, regardless of roster size) that had drifted into
      different algorithms across the two branches before the merge.
      `resolveLayerSlots()` (`PerformanceDirector.tsx`) and `resolveLayerId()`
      (`SceneManager.tsx`) are two complementary bug fixes that both survived
      the merge — the first stops a layer scene from staying mounted after a
      slot switch (accent → overlay left the old accent running forever); the
      second stops a layer from duplicating the primary when the primary
      switches onto the same scene.

### Recent correctness fixes

- Starting/stopping a source now resets beat, phrase, mood, onset, energy, and normalization
  history so a second track does not inherit timing or analysis state from the first track.
- Primary scene transitions no longer accidentally fade out or duplicate accent/overlay layers.
- Automatic palette changes no longer count as manual input and suppress automation.
- Automatic layer changes no longer trigger the manual 45-second hold; actual user changes still do.

## 3. Runtime architecture

The frame pipeline is intentionally one-way:

```text
MediaStream
  → AudioEngine.update()
  → AudioFeatures + MoodMomentum
  → AutoPilot / PerformanceDirector
  → Zustand scene/layer state
  → SceneManager beat-locked commits and fades
  → React Three Fiber scenes
  → shared lights, camera, post effects, optional generative overlay
```

In parallel, off the main thread: an `AudioWorklet` PCM tap feeds
`essentia.worker.ts` (rhythm/key/danceability) and `voice.worker.ts`
(voice presence + 4-head mood) on a slow cadence; `EssentiaBridge`/
`VoiceBridge` hold the latest async result and `AudioEngine.update()` drains
it into the same `AudioFeatures` object each frame — nothing in the hot path
above ever waits on a worker. See `docs/02_Music_Intelligence.md`.

Important frame priorities:

- `SceneManager` at `-100`: updates audio first and owns scene transitions.
- `AutoPilot` at `-90`: reacts to mood changes and predictions.
- `CueTimeline` at `-88`: plays authored cues, overriding the automatic directors while governing.
- `PerformanceDirector` at `-85`: makes phrase/section composition decisions.
- Scene components: read the already-updated mutable `audioEngine.features` object.

Scenes must not access Web Audio directly. They should read `audioEngine.features`, use
`getAudioResponse()` when helpful, multiply visibility by `SceneFade`, respect the global visual
parameters, and dispose manually-created GPU resources.

## 4. How to operate the app

| Control | Behavior |
| --- | --- |
| `1`–`9`, `0` | Request a registered scene by position — covers the first 10 of the 11 scenes now registered (see §0); `juliawings` (position 11) has no hotkey slot and is only reachable via the presets panel or `?scene=juliawings` |
| `A` | Toggle automatic mood-driven direction |
| `C` | Capture a performance cue (current look at the current beat) |
| `R` | Start/stop recording the canvas + audio to .webm |
| `S` | Save a PNG screenshot |
| `M` | Toggle mood multipliers over user parameters |
| `G` | Toggle the optional local AI texture layer |
| `P` | Cycle palette |
| `B` | Open presets and composition layers |
| `T` | Open visual tuning controls |
| `D` | Open analyzer/debug panel |
| `J` | Toggle the tactical HUD overlay |
| `Y` | Open the numeric analytics panel (beat accuracy, mood confidence, transition timing) |
| `F` | Toggle fullscreen |
| `H` | Hide/show the interface |

To test audio, start with a browser tab or screen that has “Share audio” enabled, or choose a
microphone/line-in device. `/` is the public gateway landing page (mobile/WebGL-gated); the
visualizer itself lives at `/app`. For OBS, use a URL such as:

```text
http://localhost:5183/app?scene=wireframe&palette=ember&ui=hidden&quality=low&autopilot=1
```

## 5. Custom scene workflow

1. Create a React Three Fiber component under `src/scenes/`.
2. Read `audioEngine.features` in `useFrame`.
3. Use `getAudioResponse(features)` for portable sub/bass/mid/presence/high/vocal/transient
   envelopes.
4. Read `SceneFade` and multiply final visibility by `fade.value`.
5. Apply `getEffectiveParams()` so intensity, speed, reactivity, mood drive, and user tuning
   remain consistent.
6. Register the scene with complete metadata in `src/scenes/index.ts` or call `registerScene()`
   before mount.
7. List compatible scenes and the roles the scene can occupy.
8. Add disposal for all custom materials, geometries, render targets, and event listeners.
9. Run `npm run check` (typecheck + lint + test + build) before handing it off.

## 6. Known limitations and risks

- The bundle is code-split (scenes, AI layer, vendor chunks); the remaining >500 kB warning is
  three.js itself, which is expected and long-cacheable. Further shrinking would require a
  custom three build or tree-shaken imports.
- Composition supports one accent and one overlay slot, each with intensity and blend mode. A
  future layer graph should support multiple weighted layers and explicit phrase ranges.
- Per-layer blend modes are applied by rewriting the layer's material blending in place;
  `normal` can occlude layers behind fullscreen scenes (their shaders write alpha 1), and
  `multiply` darkens by design. `add`/`screen` are the workhorse modes.
- Automatic direction is heuristic. It does not yet understand lyrics, song metadata, exact
  sections, or user-authored musical markers.
- Vocal energy has two readings now, neither source-separated: `voice` is a fast per-frame
  tonality-gated frequency estimate, `vocalPresence` is essentia's slower MusiCNN classifier read
  (see item 19, `docs/02_Music_Intelligence.md`). A true vocal signal would still require an
  isolating stem model or an external source input.
- Preset imports accept scene IDs but do not yet provide a user-facing migration/error report for
  scenes that are no longer registered.
- A Vitest suite unit-tests the pure DSP layer (BPM/phrase/mood estimators, spectral feature math,
  the rolling-window utility, and — since item 19 — the essentia/voice bridges and key/layer/scene
  helpers) — 222 tests across 27 files. No automated *browser* test suite exists: visual QA still
  requires running the app with a real audio source and checking transitions, source stop/restart,
  fullscreen, mobile layout, and GPU quality changes. The live Analytics panel (`Y`) makes several of
  those checks numeric rather than purely visual, but doesn't replace them. The merge that landed
  item 19 was itself only verified by `npm run check` and a static browser smoke test — nobody has
  yet run a real track through it end to end with AutoPilot/PerformanceDirector live; treat that as
  outstanding, same as item 1 in §7 below.
- The 11-scene roster (item 19 fixed the count here after it drifted stale) has only 10 number-key
  slots (`1`–`9`, `0`); see §4.
- AI textures require the optional local backend and are intentionally disabled when unavailable.
- Essentia's TF.js model weights are gitignored and fetched at runtime (converted via
  `scripts/convert-essentia-models.md`); a machine that has never run the conversion step gets no
  key/voice/mood signal and no error — everything degrades to the pre-essentia heuristic silently.

## 7. Remaining roadmap

### Next up, in order

1. **Play real music through it.** Everything recent is verified numerically and
   in offline shader harnesses, but essentially nothing has been judged against
   a track you would actually play. Specifically worth watching: does `voice`
   track the lead on your material, do the ribbons' waveform ripples read at
   performance distance, does the quality governor hold 60 fps on a real set,
   and does AutoPilot's scene choice feel musical. **This gates most of the
   tuning below** — the project's own rule is calibrate against real audio,
   never an idle frame.
2. **Merge `AutoPilot` and `PerformanceDirector` into one planner.** They both
   call `requestScene` in the same frame; `PerformanceDirector` guards on
   `pendingSceneId` and `AutoPilot` does not, so AutoPilot can override a pending
   pick and send `SceneManager` down its stale-warm path — discarding the
   pre-warmed shader the warm gate exists to protect. One planner emitting one
   decision per frame removes that by construction. Add the `Decision` record
   `docs/03_AI_Performance_Director.md` already types, and the four constraints
   that doc marks ❌ (no-repeat, ≤3 dramatic transitions per 60 s, no heavy
   visuals in a breakdown, fatigue avoidance).

3. **Finish the director refactor (Phases 5–6).** `SceneManager` still owns both
   scene lifecycle *and* some commit policy, and the creative directors still
   write the Zustand store rather than `performanceState` directly.
   `PerformanceStateBridge` is the temporary adapter that keeps this an
   inversion rather than a rewrite — collapsing it is the last structural step,
   after which a new decision-maker (or a whole new renderer) plugs in at one
   object. Note the bridge now takes the camera-mode decision (item 18); that
   moves into the planner when it lands.

4. **More scenes.** The contract is now cheap: geometry + metadata +
   `useSceneFrame`. Camera, animation primitives, and post are no longer
   per-scene code. Follow `docs/05_Scene_Architecture.md`, keep to the exposure
   targets in §0, and give each new scene a distinct band-to-job routing so it
   is separable by eye from the others. Lower priority than it looks: 11
   scenes across nine camera modes is already a lot of variety — and the
   11th (`juliawings`) already has no number-key slot (§4/§6), so the next
   scene should come with a plan for scene selection UI, not just a 12th hotkey.

5. **Mood-scoring calibration.** The texture-based score nudges (item 13) are
   principled but untuned by ear.

### Ideas worth considering

- **Layers, not just subjects.** The composition system supports accent +
  overlay, and a layer is often the better answer than another primary — a
  readout added as a layer improves *every* look instead of only helping while
  its own scene is on screen. (An earlier vocal/mid layer was built and then
  removed on preference; the architectural point still stands.)
- **AI as an offline calibration aid** (recommended, never built as such — see
  note below): if "does it pick up the vibe correctly" ever needs an outside
  opinion, the shape that fits this project's DSP-first, no-ML-in-hot-path
  design is a manual offline script — feed fixture tracks through the
  estimator classes (plain data, no browser), ask an external model for an
  independent read, diff the two. The agreed reasoning is in the "fast DSP
  owns timing, model owns understanding" split: per-hit timing must stay DSP
  because stem models add 100–500 ms; only slow-changing *understanding* can
  tolerate that latency. Never in the render loop or CI, which must stay
  deterministic. **Note:** item 19's essentia/MusiCNN integration is the
  "model owns understanding" half of this split *already built and live* (not
  offline) — it runs off-thread in the browser, on a slow cadence, and never
  blocks the beat grid, which satisfies the same latency constraint this idea
  was reasoning toward. What's still missing is the *offline, no-browser*
  variant specifically: a script to diff the DSP+essentia read against an
  independent external model over a fixture set, for calibration rather than
  runtime enrichment.

### Lower-value refinements

- **Mood-scoring calibration against real tracks**: the new texture-based score nudges (item 13)
  are principled but untuned by ear yet — the project's own rule is "calibrate against real audio,
  never an idle frame" (`docs/09_Rendering_Engine.md`).
- **AI as an offline calibration aid** (recommended, not built): if "does it pick up the vibe
  correctly" ever needs an outside opinion beyond self-consistency signals, the shape that fits
  this project's DSP-only, no-ML-in-hot-path philosophy is a manual, offline script — feed fixture
  tracks through the estimator classes directly (they're plain data, no browser needed), ask an
  external model for an independent read, diff the two. Never wired into the render loop or `npm
  run check`/CI, which must stay deterministic.
- **Cue editing depth**: adjust a cue's beat position after capture, duplicate cues, and a
  visual timeline strip (cues currently support capture/replace/delete/clear).
- **WebRTC input adapter** and an **OSC/Ableton Link bridge** (needs a small local relay —
  the `setExternalTempo` API is the integration point; MIDI clock already uses it).
- **Deterministic seeds** for generative scenes so recordings/screenshots are reproducible
  (scenes currently seed from `Math.random` in mount-time memos).
- **Plugin packaging**: `registerScene` + `validateSceneDef` exist; a manifest format and a
  loader for external bundles would complete the story.
- **Cloud sync / preset gallery** if the project ever leaves local-only use.
- **Import migration report**: preset/cue import silently drops entries for unregistered
  scenes; a user-facing report would make that visible.

## 8. Verification checklist

Before shipping a meaningful change:

- `npm run check` — typecheck + lint + **test** (222) + build in one pass (or run them individually
  via `npm run typecheck`, `npm run lint`, `npm run test`, `npm run build`)
- `npm run format` — Prettier over `src/`
- If you touched `BpmEstimator`/`PhraseDetector`/`MoodEstimator`/`spectralFeatures`/the essentia
  bridges, run `npm run test:watch` while iterating — the suite catches a scoring/tempo/bridge
  regression immediately
- If you touched `wrangler.jsonc` or the deploy setup, run `npx wrangler deploy --dry-run` after
  `npm run build` and confirm it reads the full `dist/` file count with no config errors — see item
  19; this is exactly the check that would have caught the prior `_redirects` deploy regression.
- **If you wrote or changed GLSL, compile it.** Shaders are strings: typecheck,
  lint, tests and the build all pass on a broken shader. Compile *and link* it in
  a throwaway WebGL context and check `getShaderInfoLog`. Scene shader sources
  are exported (`VERT`/`FRAG`) precisely so this is possible. Two real
  composition bugs were caught only this way.
- **If you added anything heavy, measure its frame cost before calling it done.**
  Render it standalone and time it against the 16.7 ms budget. Reading back
  pixels also gives objective exposure numbers (lit %, mean luma, % blown) to
  check against the §0 targets — far better than eyeballing a screenshot.
- Open the Analytics panel (`Y`) during a real track and confirm beat-tracking accuracy trends
  toward 1.0 as the tempo locks, and that switching scenes adds a row to the transitions table
  with actual duration close to target and a clean (unflagged) frame-time p95
- Start the dev server and test system audio plus microphone input.
- Stop and restart audio; confirm beat/mood state starts cleanly.
- Switch scenes manually during silence and during a beat-rich track.
- Enable automation and verify manual controls get a 45-second hold.
- Toggle accent/overlay layers while the primary scene is transitioning.
- Change a layer's blend mode and intensity while it is visible.
- Add a band mapping (e.g. bass → intensity) and confirm the response follows the music.
- Save, reload, import, export, and apply a layered preset.
- Play an audio file, capture cues, reload, and confirm cue playback with "follow" on.
- Record a short clip (R) and confirm the .webm downloads with audio.
- Copy a share URL and open it in a fresh tab; confirm the look and cues restore.
- Test `ui=hidden`, fullscreen, low quality, and a narrow viewport.
- Watch the debug panel for BPM confidence, section flags, drops, FPS, and render scale.

## 9. Key files

- `src/audio/AudioEngine.ts` — source graph and per-frame analysis.
- `src/audio/spectralFeatures.ts` — pure, unit-tested band/texture-cue math.
- `src/audio/PercussionDetector.ts` — independent kick/snare/hi-hat detection.
- `src/audio/essentia/EssentiaBridge.ts` / `VoiceBridge.ts` — main-thread schedulers for the two
  music-intelligence workers; hold the latest async result for `AudioEngine.update()` to drain.
- `src/audio/essentia/essentia.worker.ts` / `voice.worker.ts` — the actual Essentia.js/TF.js
  inference, off the main thread.
- `src/engine/keyPalette.ts` — `keyPaletteTracker`, key votes → harmonic palette family.
- `src/engine/performanceState.ts` — **the seam**; read this first.
- `src/engine/sceneFrame.ts` — `useSceneFrame()`, the per-frame context every scene uses.
- `src/engine/CameraDirector.tsx` — all camera motion (9 modes), `pickCameraMode()`, and voice-aware
  framing (`voiceFocus` → `locked`/`push`).
- `src/engine/AnimationDirector.ts` — the six animation primitives `SceneFrame.b` cannot supply.
- `src/audio/types.ts` — scene-facing feature contract, including `vocalPresence`/`moods`/`moodsValid`.
- `src/engine/audioResponse.ts` — reusable response envelopes.
- `src/engine/SceneManager.tsx` — primary/layer mounting, fades, transition telemetry, and
  `resolveLayerId()` (a layer must never duplicate the primary).
- `src/engine/AutoPilot.tsx` — mood-triggered scene/palette automation, `pickPalette()`.
- `src/engine/PerformanceDirector.tsx` — phrase-level composition decisions, `resolveLayerSlots()`
  (a layer slot switch must clear the slot it left).
- `src/scenes/index.ts` — registry, metadata, role-aware lookup helpers
  (`getScenesForMood(mood, role?)`, `getPrimaryScenesForMood`), and `pickVariedScene()` — the shared
  weighted-random-with-recency-decay scene picker both directors use.
- `src/engine/RollingWindow.ts` / `analyticsMetrics.ts` / `transitionMetrics.ts` — the
  live-analytics instrumentation layer.
- `src/ui/AnalyticsPanel.tsx` — the numeric accuracy/smoothness readout (`Y`).
- `src/store.ts` — persisted application and performance state.
- `src/engine/presets.ts` — preset schema and import sanitization.
- `src/ui/HUD.tsx` — controls, presets, layers, and operation chrome.
- `src/App.tsx` — router/gate: mobile/WebGL check, then `/` (gateway landing, `src/landing/`) vs.
  `/app` (`src/routes/Visualizer.tsx`, the actual visualizer).
- `wrangler.jsonc` — committed Cloudflare Workers deploy config; do not delete (see §2 item 19).
- `scripts/convert-essentia-models.md` / `fetch-test-tracks.mjs` / `setup-tfjs-wasm.mjs` — one-time
  offline setup for essentia model weights, test audio, and the TF.js WASM backend.
- `../README.md` — quick start and user-facing feature overview.
- `ARCHITECTURE.md` — implementation-oriented extension guide.

