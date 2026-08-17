# Document 1 — System Architecture

> **Audience:** engineers, coding agents.  
> **Status:** current as of August 2026 — reflects `src/` layout, including the essentia music-intelligence merge and Cloudflare Workers deploy.  
> **Spec:** [specs/system_architecture_spec.md](specs/system_architecture_spec.md)

---

## Overview

AudioVis is a browser-based audio-visual performance engine built on **React 19 + React Router 7 +
React Three Fiber + Three.js**, deployed to **Cloudflare Workers** (`wrangler.jsonc`). Data flows one
way: **audio in → `AudioFeatures` → directors → store → scenes → post**. Scenes never touch the Web
Audio API; the UI never touches Three.js directly. Music intelligence has two tiers: DSP stays in the
per-frame hot path (zero allocation, never blocked), while Essentia.js/TensorFlow.js run key/rhythm/
voice/mood inference off-thread in two Web Workers and feed the same `AudioFeatures` contract
asynchronously — see [02_Music_Intelligence.md](02_Music_Intelligence.md).

```
src/App.tsx     Router/gate: mobile+WebGL check, then '/' (gateway) vs '/app' (visualizer)
src/landing/    The public gateway landing page ('/')
src/routes/     Landing.tsx / Visualizer.tsx — the two routed pages
src/audio/      Musical understanding (DSP hot path + essentia/ off-thread ML workers)
src/engine/     Visual framework (directors, transitions, quality, post)
src/scenes/     Content (11 registered scenes)
src/ui/         Chrome (HUD, debug, tactical overlay)
src/store.ts    Zustand persisted state
backend/        Optional local sd-turbo texture server (:8787)
wrangler.jsonc  Cloudflare Workers deploy config (committed — do not delete)
```

---

## Goals

- One mutable `AudioFeatures` object per frame — zero allocation in the hot path.
- Beat-locked scene commits with shader pre-warm — no compile stalls on downbeats.
- Pluggable scenes via `registerScene()` without engine rewrites.
- Adaptive quality that scales **complexity**, not just resolution.
- Optional AI overlay that never blocks the render loop.

---

## Responsibilities

Map every subsystem: purpose, inputs, outputs, update frequency, dependencies.

---

## Non-Goals

- Custom WebGL2 renderer (abandoned).
- ML inference on the audio hot path — implemented, but strictly off-thread: Essentia.js/TF.js run in
  `essentia.worker.ts`/`voice.worker.ts`, never on the frame that ticks `audioEngine.update()`.
- Multiplayer sync (state is serializable; sync layer not built).

---

## Architecture

### Subsystem catalog

#### Audio Engine

| | |
|---|---|
| **Purpose** | Capture and analyze audio; publish `AudioFeatures` |
| **Location** | `src/audio/AudioEngine.ts` |
| **Input** | `MediaStream` (display media, mic, file, future: virtual cable, WebRTC) |
| **Output** | `AudioFeatures` (mutable singleton via `audioEngine.features`) |
| **Update frequency** | Once per frame (~60 Hz), driven by R3F `useFrame` in SceneManager |
| **Dependencies** | Web Audio API, `BpmEstimator`, `PhraseDetector`, `MoodEstimator` |

#### BPM Estimator

| | |
|---|---|
| **Purpose** | Live tempo tracking, beat grid, phase-locked loop |
| **Location** | `src/audio/BpmEstimator.ts` |
| **Input** | Onset timestamps, optional external tempo override |
| **Output** | `bpm`, `confidence`, `nextBeatTime`, beat flags |
| **Update frequency** | Every frame; histogram re-eval every 0.5 s |
| **Dependencies** | Onset detection from AudioEngine |

#### Phrase Detector

| | |
|---|---|
| **Purpose** | Section boundaries, phrase grid |
| **Location** | `src/audio/PhraseDetector.ts` |
| **Input** | Spectral profile on downbeats |
| **Output** | `phrase`, `phraseProgress`, `sectionChange` |
| **Update frequency** | On downbeats |
| **Dependencies** | Beat grid from BpmEstimator |

#### Mood Estimator

| | |
|---|---|
| **Purpose** | 7-state mood with hysteresis and prediction |
| **Location** | `src/audio/MoodEstimator.ts` |
| **Input** | Band energies, trend velocities |
| **Output** | `MoodMomentum` on `features.mood` |
| **Update frequency** | Every frame |
| **Dependencies** | AudioEngine band extraction |

#### Essentia Bridge / Voice Bridge

| | |
|---|---|
| **Purpose** | Schedule off-thread ML jobs (rhythm/key/danceability; voice presence + 4-head mood) and drain the latest async result into `AudioFeatures` |
| **Location** | `src/audio/essentia/EssentiaBridge.ts`, `VoiceBridge.ts` |
| **Input** | Mono PCM ring buffer from an inline `AudioWorklet` tap |
| **Output** | Corrections to `bpm`/adds `key`/`vocalPresence`/`moods`/`moodsValid` on `AudioFeatures` |
| **Update frequency** | Own slow cadence (2.5–20 s depending on job); drained once per frame, never blocking it |
| **Dependencies** | `essentia.worker.ts`/`voice.worker.ts` (separate workers so one slow inference can't stall the other), `BpmEstimator` (rhythm handoff) |

#### Scene Manager

| | |
|---|---|
| **Purpose** | Audio tick, scene mount/fade, layer composition, shader warm-up |
| **Location** | `src/engine/SceneManager.tsx` |
| **Input** | Store: `sceneId`, `pendingSceneId`, accent/overlay layers |
| **Output** | `SceneFade` context per mounted instance |
| **Update frequency** | Every frame; priority **−100** |
| **Dependencies** | `audioEngine`, scene registry, quality governor |

#### AutoPilot

| | |
|---|---|
| **Purpose** | Mood/drop-driven scene and palette selection |
| **Location** | `src/engine/AutoPilot.tsx` |
| **Input** | `MoodMomentum`, drop edge, store automation flags |
| **Output** | `requestScene()`, palette changes |
| **Update frequency** | Every frame; priority **−90** |
| **Dependencies** | Scene registry, store, CueTimeline governance |

#### Cue Timeline

| | |
|---|---|
| **Purpose** | Authored beat-anchored performance playback |
| **Location** | `src/engine/CueTimeline.tsx` |
| **Input** | `PerformanceCue[]`, current beat index |
| **Output** | Full look snapshots via normal commit pipeline |
| **Update frequency** | Every frame; priority **−88** |
| **Dependencies** | Store, preset sanitizer |

#### Performance Director

| | |
|---|---|
| **Purpose** | Phrase/section-level primary + layer composition |
| **Location** | `src/engine/PerformanceDirector.tsx` |
| **Input** | Section change, phrase fallback, mood, audio response |
| **Output** | `requestScene()`, `setLayer()` |
| **Update frequency** | Every frame; priority **−85** |
| **Dependencies** | Scene registry, quality governor, CueTimeline |

#### Quality Governor

| | |
|---|---|
| **Purpose** | Adaptive complexity tier (5 rungs) |
| **Location** | `src/engine/quality.ts` |
| **Input** | Frame-time EMA from PerfMonitor |
| **Output** | `quality.knobs` (renderScale, raymarchSteps, etc.) |
| **Update frequency** | Every frame |
| **Dependencies** | PerfMonitor |

#### Performance State

| | |
|---|---|
| **Purpose** | The single description of what the visuals *should* be doing — the seam between creative decisions and rendering |
| **Location** | `src/engine/performanceState.ts` |
| **Input** | Written by the decide band (today via `PerformanceStateBridge`) |
| **Output** | `performanceState` singleton; single-writer by convention |
| **Update frequency** | Once per frame, priority −95 |
| **Dependencies** | None — deliberately a plain data module |

#### Camera Director

| | |
|---|---|
| **Purpose** | Owns all camera motion; scenes declare anchors, never move the camera |
| **Location** | `src/engine/CameraDirector.tsx` |
| **Input** | `performanceState.cameraMode` + the active scene's `cameraAnchor` |
| **Output** | Camera position/orientation |
| **Update frequency** | Every frame; priority **−80** |
| **Dependencies** | Scene registry metadata |

#### Animation Director

| | |
|---|---|
| **Purpose** | Reusable animation primitives (pulse, breathe, inflate, twist, ripple, explode, dissolve, oscillate) as normalized signals |
| **Location** | `src/engine/AnimationDirector.ts` |
| **Input** | `AudioFeatures`, `performanceState.animationIntensity` |
| **Output** | `animationSignals`; `applyToUniforms()` for shader scenes, `applyToObject()` for mesh scenes |
| **Update frequency** | Once per frame, from SceneManager's tick |
| **Dependencies** | `audioResponse` |

#### Effects Director

| | |
|---|---|
| **Purpose** | Fixed post chain — bloom, chromatic aberration, vignette |
| **Location** | `src/engine/EffectsDirector.tsx` |
| **Input** | `performanceState.bloom` / `.glitch` — no audio, no decisions |
| **Output** | Composited framebuffer |
| **Update frequency** | Every frame (after scenes) |
| **Dependencies** | `@react-three/postprocessing` |

#### Generative Layer

| | |
|---|---|
| **Purpose** | Optional AI texture overlay |
| **Location** | `src/engine/GenerativeLayer.tsx`, `textureGenerator.ts` |
| **Input** | Mood, palette, backend health |
| **Output** | Additive fullscreen shader with crossfaded textures |
| **Update frequency** | Every frame; texture fetch async |
| **Dependencies** | `backend/server.py` (optional) |

#### Scene Registry

| | |
|---|---|
| **Purpose** | Lazy-loaded scene catalog + metadata |
| **Location** | `src/scenes/index.ts` |
| **Input** | `registerScene()` at boot |
| **Output** | `SceneDef[]`, lookup helpers |
| **Update frequency** | Static at runtime (mutations via register) |
| **Dependencies** | React.lazy chunks |

#### Store

| | |
|---|---|
| **Purpose** | Application and performance state |
| **Location** | `src/store.ts` |
| **Input** | User actions, directors, URL params |
| **Output** | Persisted Zustand state |
| **Update frequency** | Event-driven + per-frame reads via `getState()` |
| **Dependencies** | localStorage persist middleware |

---

## Data Flow

```text
MediaStream
  → AudioEngine.update()                    [−100 SceneManager tick]
  → AudioFeatures + MoodMomentum + percussion (kick/snare/hihat)
  → updateAnimationSignals()                 animation primitives, once centrally
      │
      ├─ DECIDE ─────────────────────────────────────────────
  → PerformanceStateBridge (−95) ─► performanceState
  → AutoPilot (−90) ──────────────► requestScene / setPalette
  → CueTimeline (−88) ────────────► applyCue (if governed)
  → PerformanceDirector (−85) ────► scene + layers
      │
      ├─ EXECUTE (read performanceState, never write) ───────
  → CameraDirector (−80) ─────────► camera, from the scene's anchor
  → SceneManager: warm-up, downbeat commit, crossfade
  → R3F scenes (features, animationSignals, SceneFade, quality.knobs)
  → GenerativeLayer (optional)
  → EffectsDirector ──────────────► bloom / aberration / vignette
  ▲
PerfMonitor → QualityGovernor → DPR + complexity knobs
```

### Frame priority order

Three bands, and the boundary between them is the architecture's central rule:
**anything in "decide" may write `performanceState`; nothing in "execute" may.**
Executors only read it and apply. That is what allows a new decision-maker — or
an entirely different renderer — to be added without touching the other side.

| Band | Priority | System | Role |
|---|---|---|---|
| analyse | **−100** | SceneManager | Ticks `audioEngine.update()` first, derives animation signals, owns scene lifecycle |
| decide | **−95** | PerformanceStateBridge | Composes `performanceState` for this frame |
| decide | **−90** | AutoPilot | Mood/drop reactions |
| decide | **−88** | CueTimeline | Authored cues override automation |
| decide | **−85** | PerformanceDirector | Phrase-level composition |
| execute | **−80** | CameraDirector | Applies the active camera mode |
| execute | **0** | Scene components | Read pre-updated features + animation signals |
| execute | post | EffectsDirector, PerfMonitor | Post chain, telemetry |

---

## Components

| Layer | Key files |
|-------|-----------|
| Routing | `App.tsx`, `src/routes/Landing.tsx`, `src/routes/Visualizer.tsx`, `src/landing/` |
| Audio (DSP) | `AudioEngine.ts`, `BpmEstimator.ts`, `PhraseDetector.ts`, `MoodEstimator.ts`, `MidiClock.ts`, `types.ts` |
| Audio (ML, off-thread) | `src/audio/essentia/EssentiaBridge.ts`, `VoiceBridge.ts`, `essentia.worker.ts`, `voice.worker.ts`, `protocol.ts`, `voiceProtocol.ts` |
| Engine | `Stage.tsx`, `SceneManager.tsx`, `performanceState.ts`, `PerformanceStateBridge.tsx`, `AutoPilot.tsx`, `PerformanceDirector.tsx`, `CueTimeline.tsx`, `CameraDirector.tsx`, `AnimationDirector.ts`, `EffectsDirector.tsx`, `quality.ts`, `LightRig.tsx`, `palettes.ts`, `keyPalette.ts`, `presets.ts`, `moodParams.ts`, `audioResponse.ts`, `GenerativeLayer.tsx`, `recorder.ts` |
| Scenes | 11 registered in `SCENES[]` — see the roster table in [HANDOFF.md](HANDOFF.md) §0 |
| UI | `HUD.tsx`, `TacticalHUD.tsx`, `DebugPanel.tsx`, `AnalyticsPanel.tsx`, `UnsupportedScreen.tsx` |

---

## Interfaces

Public extension APIs:

- `registerScene(def: SceneDef)` — `src/scenes/index.ts`
- `registerPalette(palette: Palette)` — `src/engine/palettes.ts`
- `audioEngine.startWithStream(stream: MediaStream)` — any audio source
- `bpmEstimator.setExternalTempo(bpm, beatTime, now)` — MIDI/OSC bridge point
- `preloadScene(id)` — warm lazy chunks before downbeat

See [13_API.md](13_API.md).

---

## Data Models

Core types live in `src/audio/types.ts`, `src/scenes/index.ts`, `src/store.ts`. See [14_Data_Models.md](14_Data_Models.md).

---

## Algorithms

Delegated to subsystem docs: [02_Music_Intelligence.md](02_Music_Intelligence.md), [03_AI_Performance_Director.md](03_AI_Performance_Director.md), [08_Transition_Engine.md](08_Transition_Engine.md).

---

## State Machines

### Scene transition state (SceneManager)

```text
[idle] ──requestScene──► [pending: warming dir=0]
                              │ chunk loaded + WARM_FRAMES
                              ▼
                         [pending: hidden, compiled]
                              │ downbeat OR 2.5s timeout
                              ▼
                         [crossfade: incoming dir=1, outgoing dir=-1]
                              │ fade complete
                              ▼
                         [idle: new primary]
```

### Automation governance

```text
autoPilot ON + cueState.governed OFF + manual hold expired
  → directors active

cue fires OR within 32 beats of final cue
  → cueState.governed ON → directors stand down

user manual action
  → lastManualAt updated → 45s director backoff
```

---

## Update Frequency

| Subsystem | Rate |
|-----------|------|
| Audio analysis | ~60 Hz (per frame) |
| BPM histogram | 2 Hz |
| Mood commit | Event-driven (hysteresis-gated) |
| Scene crossfade | ~2 beats duration |
| Quality tier change | Min 2 s settle; 4 s climb hold |
| AI texture fetch | Async; seconds to ~minute |

---

## Performance Constraints

- Target: stable **50–60 fps** at 1080p on M1-class hardware.
- Quality Governor drops tier above **20 ms** EMA; climbs below **12 ms** after **4 s** sustained headroom.
- Heavy scene crossfade budget: `maxHeavyLayers` from quality tier.
- Shader compile must occur during warm-up, not on downbeat.
- The EffectsDirector chain is **fixed** — never remount effects (GPU context loss risk).

---

## Failure Modes

| Failure | Behavior |
|---------|----------|
| Beat grid untrusted (`confidence ≤ 0.25`) | Scene commit after 2.5 s timeout instead of downbeat |
| WebGL context lost | `preventDefault()` + `glEpoch` remount in Stage |
| AI backend down | Health probe fails; GenerativeLayer alpha = 0 |
| Stale scene ID in preset/URL | `getScene()` falls back to `SCENES[0]` (`wireframe`) |
| Essentia model weights unfetched / worker dead / unsupported browser | Bridges stay at neutral defaults (`moodsValid: false`, no key/rhythm correction); DSP estimators unaffected — see [02_Music_Intelligence.md](02_Music_Intelligence.md) |
| No committed `wrangler.jsonc` (regression risk, not current state) | Every Cloudflare deploy re-runs the auto-setup wizard from scratch — slow, non-deterministic, and the root cause of a prior silent deploy failure; keep it committed |
| Source stop/restart | Full analysis reset (beat, mood, phrase, onset history) |

---

## Testing

- `npm run check` — typecheck + lint + test + build
- A Vitest suite unit-tests the pure DSP layer (BPM/phrase/mood estimators, spectral feature math);
  see [02_Music_Intelligence.md](02_Music_Intelligence.md#testing)
- Manual QA checklist in [HANDOFF.md](HANDOFF.md) §8
- No automated *browser* test suite yet — the live Analytics panel (`Y`) makes some of that
  checklist numeric, but doesn't replace it

---

## Future Improvements

- WebRTC input adapter
- OSC / Ableton Link bridge (via `setExternalTempo`)
- Plugin manifest loader for external scene bundles
- WebGPU renderer swap in `Stage.tsx` (scenes unchanged)
- Cloud sync of persisted store slice

See [HANDOFF.md](HANDOFF.md) §7 for the full, prioritized roadmap.
