# AudioVis — Project Handoff

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
   - Five scenes are registered in `src/scenes/index.ts`: `schematic`, `wireframe`,
     `plasma`, `dissolve`, `chrome`. Sixteen earlier scenes remain on disk with
     their loader entries intact but are absent from `SCENES[]`, so nothing can
     reach them; re-registering one is a single array entry.
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
   - Sixteen legacy scenes (nebula, galaxy, tunnel, fluid, monolith, noise field, clouds, ribbons,
     crystal growth, digital aurora, and others) remain on disk with their loader entries intact
     but are unregistered — see item 3 and `docs/09_Rendering_Engine.md` for why the roster was
     culled to five.

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
| `1`–`9`, `0` | Request a registered scene by position (five registered today; digits past the roster size are no-ops) |
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
microphone/line-in device. For OBS, use a URL such as:

```text
http://localhost:5183/?scene=wireframe&palette=ember&ui=hidden&quality=low&autopilot=1
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
9. Run `npm run check` (typecheck + lint + build) before handing it off.

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
- Vocal energy is an estimated frequency range, not source-separated vocals. A real vocal signal
  would require a heavier model or an external stem/source input.
- Preset imports accept scene IDs but do not yet provide a user-facing migration/error report for
  scenes that are no longer registered.
- A Vitest suite unit-tests the pure DSP layer (BPM/phrase/mood estimators, spectral feature math,
  the rolling-window utility) — see item 13. No automated *browser* test suite exists: visual QA
  still requires running the app with a real audio source and checking transitions, source
  stop/restart, fullscreen, mobile layout, and GPU quality changes. The live Analytics panel (`Y`)
  makes several of those checks numeric rather than purely visual, but doesn't replace them.
- AI textures require the optional local backend and are intentionally disabled when unavailable.

## 7. Remaining roadmap

The numbered phases are complete. Current priority order (user-set, July 2026):

1. ~~Wider audio-feature detection for mood accuracy~~ — done, see item 13.
2. ~~Numeric testing and analytics~~ — done, see item 13.
3. **More scenes** — deliberately last: land a solid system before adding content on top of it.
   When picked back up, new scenes follow the existing `registerScene()` contract
   (`docs/05_Scene_Architecture.md`) and the crystal-cut rubric in `docs/09_Rendering_Engine.md`
   (subject, negative space, hard edges) — not scored against the pre-cull 21-scene roster.

Beyond that, lower-value refinements:

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

- `npm run check` — typecheck + lint + **test** + build in one pass (or run them individually
  via `npm run typecheck`, `npm run lint`, `npm run test`, `npm run build`)
- `npm run format` — Prettier over `src/`
- If you touched `BpmEstimator`/`PhraseDetector`/`MoodEstimator`/`spectralFeatures`, run
  `npm run test:watch` while iterating — the suite catches a scoring/tempo regression immediately
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
- `src/audio/types.ts` — scene-facing feature contract.
- `src/engine/audioResponse.ts` — reusable response envelopes.
- `src/engine/SceneManager.tsx` — primary/layer mounting, fades, and transition telemetry.
- `src/engine/AutoPilot.tsx` — mood-triggered scene/palette automation.
- `src/engine/PerformanceDirector.tsx` — phrase-level composition decisions.
- `src/engine/RollingWindow.ts` / `analyticsMetrics.ts` / `transitionMetrics.ts` — the
  live-analytics instrumentation layer.
- `src/ui/AnalyticsPanel.tsx` — the numeric accuracy/smoothness readout (`Y`).
- `src/scenes/index.ts` — registry, metadata, and extension helpers.
- `src/store.ts` — persisted application and performance state.
- `src/engine/presets.ts` — preset schema and import sanitization.
- `src/ui/HUD.tsx` — controls, presets, layers, and operation chrome.
- `../README.md` — quick start and user-facing feature overview.
- `ARCHITECTURE.md` — implementation-oriented extension guide.

