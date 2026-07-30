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
   - Built-in scenes cover nebula, galaxy, tunnel, fluid, monolith, noise field, clouds, ribbons,
     crystal growth, and digital aurora aesthetics.

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
- `PerformanceDirector` at `-85`: makes phrase/section composition decisions.
- Scene components: read the already-updated mutable `audioEngine.features` object.

Scenes must not access Web Audio directly. They should read `audioEngine.features`, use
`getAudioResponse()` when helpful, multiply visibility by `SceneFade`, respect the global visual
parameters, and dispose manually-created GPU resources.

## 4. How to operate the app

| Control | Behavior |
| --- | --- |
| `1`–`9`, `0` | Request one of the ten registered scenes |
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
- No automated browser test suite exists yet. Visual QA still requires running the app with a real
  audio source and checking transitions, source stop/restart, fullscreen, mobile layout, and GPU
  quality changes.
- AI textures require the optional local backend and are intentionally disabled when unavailable.

## 7. Remaining roadmap

The numbered phases are complete. What remains are refinements, roughly by value:

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

- `npm run check` — typecheck + lint + build in one pass (or run them individually
  via `npm run typecheck`, `npm run lint`, `npm run build`)
- `npm run format` — Prettier over `src/`
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
- `src/audio/types.ts` — scene-facing feature contract.
- `src/engine/audioResponse.ts` — reusable response envelopes.
- `src/engine/SceneManager.tsx` — primary/layer mounting and fades.
- `src/engine/AutoPilot.tsx` — mood-triggered scene/palette automation.
- `src/engine/PerformanceDirector.tsx` — phrase-level composition decisions.
- `src/scenes/index.ts` — registry, metadata, and extension helpers.
- `src/store.ts` — persisted application and performance state.
- `src/engine/presets.ts` — preset schema and import sanitization.
- `src/ui/HUD.tsx` — controls, presets, layers, and operation chrome.
- `README.md` — quick start and user-facing feature overview.
- `ARCHITECTURE.md` — implementation-oriented extension guide.

