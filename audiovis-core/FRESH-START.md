# AudioVis Core — fresh-start handoff

You are rebuilding **AudioVis**: a real-time audio-visual performance engine that
listens to live music, understands its structure and mood, and autonomously
drives a WebGL visual show with **no operator**. Target users are DJs (bedroom →
club), live bands, and venues. The product thesis is *visuals a DJ never has to
touch*, not a manual VJ tool like Resolume.

This folder contains the **working, battle-tested core** from the previous build.
The UI, state store, and app shell are being rewritten from scratch. The audio
intelligence and the scene roster are **not** — they are the accumulated value.

---

## 1. The one rule

**Copy `audio/`, `engine/`, and `scenes/` in verbatim. Do not rewrite, "clean
up", or reimplement them.**

Every non-obvious line in these files is load-bearing — most exist because
something specific broke. §7 lists the landmines explicitly. Read it before
touching anything in these folders. Build the new UI and store *around* this
core, against the contracts in §4 and §6.

If you think a file here is over-engineered, assume you are missing context and
read §7 first.

---

## 2. What the audio intelligence actually is

**There is no ML and no AI in this pipeline.** It is real-time DSP plus
hand-tuned heuristics, running entirely client-side at ~2ms/frame with zero
server dependency. That is a genuine competitive advantage (no latency, works
offline, no per-user cloud cost) — do not replace it with a cloud API.

`audio/` has **zero internal imports beyond `./types`** — it is fully
self-contained and portable.

### `audio/AudioEngine.ts` — capture + feature extraction
Owns the Web Audio graph. Three sources: system/tab audio (`getDisplayMedia`),
microphone/line-in (`getUserMedia`), and local file. Exposes one mutable
`features: AudioFeatures` object, updated once per frame.

Per frame, from a 2048-point FFT (browser smoothing disabled — it does its own):
- **7 bands**: `sub` 20–80Hz, `bass` <160Hz, `mid` 160Hz–2kHz, `presence`
  2–5kHz, `high` 2–9kHz, `vocal` 250Hz–5kHz, plus `rms`
- **Adaptive normalization** (`norm()`): each band tracks its own slowly-decaying
  peak (~4%/s) and reports `raw/peak`. This is why a quiet jazz track and a
  wall-of-sound DJ set both yield usable 0–1 values with no gain staging.
- **Attack/release smoothing**, user-tunable (attack ~22, release ~5)
- **Spectral centroid** (perceived brightness), **spectral flux** (bass-weighted,
  feeds onset detection), **transient** (fast ~50ms envelope)
- **Silence**, **drop** (sudden jump >1.55× recent baseline with heavy bass),
  **build-up** (sustained energy slope over ~6s)

### `audio/BpmEstimator.ts` — tempo + beat grid
Inter-onset-interval histogram over a sliding 12s window:
- Onsets fire on bass-flux spikes above an adaptive threshold (mean + 1.6σ)
- Every onset pair votes for a tempo, with **harmonic folding** (an interval
  spanning N beats also votes for period/N)
- Gaussian prior toward common tempi (~120 BPM centre)
- A **phase-locked loop** pulls the grid toward real onsets, so it stays aligned
  while playing and free-runs through quiet sections
- Confidence = how reliably onsets land on the predicted grid
- Re-evaluated 2×/s, so it tracks live tempo changes; a new tempo must persist
  before it jumps, which avoids chasing noise
- `setExternalTempo()` lets a MIDI clock override it, auto-expiring after ~2s

**Critical property:** the grid is derived from `AudioContext.currentTime`, not
the render clock — `idx = floor((now - phase) / period)`. Dropped frames cannot
desync it. It also advances by however many beats actually elapsed
(`Math.min(idx - lastGridIndex, 4)`), capped so a tempo re-lock can't inject
phantom beats. **Do not make beat timing frame-count-based.**

### `audio/PhraseDetector.ts` — musical structure
Samples a compact spectral profile (bass/mid/high/centroid) at 10Hz. On each
downbeat, compares the last ~1.2s against the preceding few seconds; a large
weighted shift (bass weighted highest) means a new section — verse→chorus,
breakdown, drop. Boundaries re-anchor the phrase grid so `phraseProgress`
completes on musically real boundaries instead of drifting. Max one boundary per
8 beats.

### `audio/MoodEstimator.ts` — the "creative brain"
Seven states, calm → hype:
`silence → ambient → mellow → groove → building → peak → aggressive`

Each frame every state gets a hand-tuned score from energy level, trend
velocities (energy/bass/brightness over 2.5–3.5s), onset density, bass weight,
BPM, and the drop/build flags. Then:
- **Hysteresis**: a candidate must hold 0.7–2.0s before committing (hype states
  commit faster; a drop commits in 0.05s). This is what stops scene whiplash.
- **Prediction**: projects the energy slope to estimate `predictedState` and
  `beatsTillTransition`, so visuals can land a crossfade *on* the drop rather
  than after it.
- **Visual multipliers**: each mood eases `viz.{intensity,speed,reactivity}`
  slowly, so mood shifts feel like weather, not switches.

---

## 3. The directors (autonomy layer)

- **`engine/AutoPilot.tsx`** — mood-driven scene selection. Purely event-driven,
  no time cooldown (SceneManager's downbeat commit is the natural rate limiter).
  Priority: a drop cuts immediately to a high-energy scene → an imminent
  predicted transition pre-stages the next scene → a committed mood change
  switches. Also nudges the palette into the mood's family. **Backs off 45s
  whenever the user touches anything manually** — keep this behaviour.
- **`engine/PerformanceDirector.tsx`** — phrase-level composition. On a real
  section change (or every 16 beats as fallback) it recomposes the layer stack,
  picking a primary plus an accent/overlay based on which band currently
  dominates, and respecting the quality governor's layer budget.
- **`engine/CueTimeline.tsx`** — optional authored cues, beat-anchored. When cues
  are governing, both directors stand down.

---

## 4. `AudioFeatures` — the contract

The single interface between intelligence and visuals. **Scenes never touch Web
Audio.** Full definition in `audio/types.ts`; ~45 fields including:

| Group | Fields |
|---|---|
| Time | `time`, `delta` |
| Raw | `waveform`, `spectrum` |
| Bands | `rms`, `energy`, `sub`, `bass`, `mid`, `presence`, `high`, `vocal` |
| Spectral | `centroid`, `flux`, `transient` |
| Beat | `bpm`, `beat`, `beatStrength`, `beatProgress`, `beatInBar`, `beatIndex`, `bar`, `measure`, `confidence`, `nextBeatTime` |
| Structure | `phrase`, `phraseProgress`, `sectionChange`, `drop`, `buildUp`, `silence` |
| Mood | `mood.{state, predictedState, confidence, beatsTillTransition, changed, changeCount, energyVel, bassVel, brightVel, level, brightness, isBuilding, isPeaking, isDecaying, isMelting, viz}` |

Also `beatPulse(f, sharpness)` — a punchy 1→0 envelope inside each beat, weighted
by confidence and honouring the user's subdivision setting. Scenes use this for
beat reactivity rather than reading `beat` directly.

**Frame order matters** (R3F `useFrame` priorities):
`SceneManager -100` (calls `audioEngine.update()` first) → `AutoPilot -90` →
`CueTimeline -88` → `PerformanceDirector -85` → scenes (default).

---

## 5. Scene contract

Every scene is an R3F component that:
1. Reads `audioEngine.features` inside `useFrame` — never in render
2. Calls `getEffectiveParams()` for `{intensity, speed, reactivity}` — the mood
   and band-routing choke point. **Do not read `params` or mood off the store
   directly.**
3. Consumes `useContext(SceneFade)` → `{value}` (0–1.5) for crossfade weight
4. Tints via `PaletteBlender` from the live palette — no hardcoded colours
5. Uses one `CameraRig` mode (`.orbit()` / `.hover()`), guarded by
   `fade.value >= lastFade.current` so an outgoing scene stops fighting for the
   camera mid-crossfade
6. Passes **every** self-constructed geometry/material/render-target to
   `useDispose(...)` — otherwise each scene switch leaks GPU resources
7. Reads `quality.knobs` if heavy (see §6)
8. Registers in `SCENES[]` with honest metadata, especially `performanceCost`

### The five scenes (keep all, they are the finished set)

| Scene | Technique | Cost | Reference |
|---|---|---|---|
| `schematic` | Barycentric wireframe + `fwidth` for resolution-independent 1px edges | low | Ghost-in-the-Shell schematic |
| `wireframe` | `WireframeGeometry2`/`Wireframe`/`LineMaterial` — true edge-only geometry, real thickness, dashed annotation ring | low | GitS blueprint |
| `plasma` | 70k closed-form curl-noise particles + screen-space streak orientation (sprites elongate along the flow) | high | red/cyan particle art |
| `dissolve` | Area-weighted surface sampling; staggered formed↔scattered transport with a `sin(t·π)` envelope, inside a wireframe cage | medium | particle-dissolve face in wire cube |
| `chrome` | `PMREMGenerator` + `RoomEnvironment` IBL on `MeshPhysicalMaterial` | medium | chrome stage figure |

### Art direction (non-negotiable — this is why the roster is small)
- **One readable hero subject** per frame. No screen-filling soup.
- **~60%+ of the frame stays near-black.** Negative space is the look.
- **One edge language per scene** — hard wireframe *or* soft volumetric, never
  muddily blended.
- **2–3 colours per moment.** No rainbow.
- Every subject needs deliberate separation from the black ground (rim light,
  depth fade, or additive glow).
- **Brightness is floored, not gated.** A line-art hero must stay readable
  through quiet passages — mood modulates it but never crushes it away. An
  earlier roster gated everything on energy and scenes vanished in breakdowns.

The rubric for any new scene: *does it have a subject, can it hold negative
space, can it carry hard edges?* Fullscreen haze fails all three.

### Band assignment — give each band a distinct job
Do not wire every band to brightness; you just get a louder kick response. The
current split, which reads clearly:

| Band | Job |
|---|---|
| `bass` | mass — scale, breathing, camera dip |
| `mid` | hue shift, rotation speed, swirl width |
| `presence` | **stroke weight / edge definition** |
| `high` | dedicated elements only (annotation ring, ground grid, sparkle) |
| `transient` | instant flash / jitter |

**Prefer `presence` over `high` for anything that must snap.** `high` averages
2–9kHz across ~325 mostly-noise-floor FFT bins, so it has visibly compressed
dynamic range after normalization; `presence` covers 2–5kHz in ~140 bins and
actually punches. Reserve `high` for smooth "air" roles.

### The one AI component (optional, inert by default)
`engine/GenerativeLayer.tsx` + `engine/textureGenerator.ts` are included for
completeness. This is the **only** AI in the codebase: it fetches mood-matched
textures from a local `sd-turbo` backend on `:8787` and washes them over the
scene additively, crossfading between them in-shader.

It is entirely optional and peripheral. With no backend running, its alpha stays
at zero and nothing is lost — `Stage.tsx` also only mounts it once the
`generative` flag has been enabled, then keeps it mounted so toggling off fades
gracefully. The backend is **not** part of this bundle. Safe to delete both files
plus the `generative` flag if you don't want it; nothing else depends on them.

---

## 6. Smoothness architecture

Butter-smooth playback is the top-priority product quality. Four mechanisms:

**`engine/quality.ts` — the governor.** Five tiers (0 richest → 4 survival),
each bundling `renderScale`, `raymarchSteps`, `noiseOctaves`, `fluidJacobi`,
`particleFraction`, `maxHeavyLayers`. Walks tiers from EMA frame time with
hysteresis (down >20ms, up <12ms after 4s of headroom).

It scales **complexity, not just resolution** — that is the whole point. Fixed
GPU work (particle counts, per-pixel loop counts, solver iterations) is invisible
to DPR scaling. Heavy scenes must read `quality.knobs` directly, e.g.
`geometry.setDrawRange(0, Math.floor(COUNT * quality.knobs.particleFraction))`.

**Shader pre-warm.** A shader compiles on first visible render and can stall for
hundreds of ms. `SceneManager` mounts the incoming scene as soon as it's
*requested*, renders it a few frames to compile, then hides it — so the
transition promotes an already-warm shader instead of stalling on the downbeat.
The warm countdown only advances once `isSceneLoaded(id)` is true, so the window
is spent compiling rather than waiting on the chunk download.

**Beat-locked transitions.** Switches commit on the next downbeat when the grid
is trusted (`confidence > 0.25 && !silence`), immediately otherwise, with a 2.5s
safety timeout. Crossfade spans ~2 beats.

**Heavy-layer budget.** When both outgoing and incoming scenes are
`performanceCost: 'high'` and the governor allows only one heavy layer, it
hard-cuts instead of crossfading — cheaper, and the more deliberate look anyway.

**Context-loss recovery.** `Stage.tsx` prevents the default on
`webglcontextlost` (without this the context is gone permanently) and remounts
resource-holding subtrees on restore via a keyed epoch.

---

## 7. Landmines — read before editing the core

**7.1 The post-processing grade. Two failed attempts.**
A filmic chain (AgX + BrightnessContrast + HueSaturation + Scanline + Noise) was
built and reverted twice. Root causes, each verified by reading real canvas
pixels:
- AgX is a **display transform and must come last**. Grading after it blew 39%
  of the frame to pure white.
- `BrightnessContrast.brightness` is an **additive offset, not exposure**. A
  negative value (used to crush blacks) drives black negative, and negative input
  to AgX's log transform returns a **lifted mid-grey ~193** — a full-frame grey
  wash even with all scene output forced to zero. **Never set it below 0.**
- **The real blocker was the scenes.** They rendered additively and *hot* (most
  of the frame at or above 1.0), so any tone mapper parked the image at its
  rolloff knee and flattened it. Bloom at threshold 0.18 then bloomed everything.
  **A grade cannot be fixed in post — scene exposure has to be sane first.**

The five scenes here were authored to that constraint (thin additive coverage;
`chrome` uses small localized speculars), so a grade is now *viable* — but
introduce it carefully, last in the chain, and calibrate against real audio.

**7.2 The effect list must be structurally FIXED.** Adding/removing an effect
rebuilds the composer's merged shader — a multi-hundred-ms stall that, repeated,
lost the WebGL context outright. Modulate by uniform instead: low quality zeroes
the chromatic-aberration offset rather than removing the pass.

**7.3 Initialize effect opacities at mount**, not only in `useFrame`. Grain and
scanline default to full strength, so any frame before the first tick shows them
at 100%.

**7.4 Calibrate against real audio.** An idle frame is not representative —
scene brightness is driven by bass/energy, which are zero at idle. Every blind
calibration attempt failed.

**7.5 Non-black default colour uniforms.** Initialize colour uniforms to real
colours, never `new THREE.Color()` (which is black). Otherwise the scene renders
black-on-black until the first `useFrame` copies the palette in.

**7.6 `LineMaterial` specifics.**
- `resolution` must track the live drawing-buffer size **every frame** — the DPR
  changes whenever the quality tier steps, so a mount-time value goes wrong under
  load.
- Its alpha caps at 1.0, so `color × opacity` cannot exceed 1 — brightness has to
  come from **overdriving the colour past 1.0** (three does not clamp colour
  uniforms). Reserve `opacity` for fade/mood.
- Dashed lines need `.computeLineDistances()`.

**7.7 `chrome`: assign the env map to `material.envMap`, never
`scene.environment`.** `scene.environment` is a single global on the Scene, and
SceneManager routinely has an outgoing scene, an incoming scene, and layers
mounted simultaneously — a global assignment leaks into all of them. Also, the
PMREM env map is a **session-lifetime singleton cached at module scope**;
deliberately do *not* dispose it on unmount.

**7.8 Audio teardown: bind only to `getAudioTracks()`.** `getDisplayMedia` also
returns a video track that is never used. Binding teardown to *every* track meant
Chrome ending the incidental video surface tore down the whole session and the
start card reappeared mid-set.

**7.9 Start-flow cancellation.** Neither `getDisplayMedia` nor `getUserMedia`
accepts an `AbortSignal`, so a pending permission prompt genuinely cannot be
cancelled. The engine uses a `startToken` invalidation counter: every start
captures it and re-checks at each await, and a stale token means "stop the tracks
you were granted and commit nothing." Without this, a late grant either clobbers
a newer session or leaves a **live capture running with nothing able to stop it**.
`start()` therefore resolves *without connecting* when superseded — check
`audioEngine.running`, never infer success from resolution.

**7.10 The new UI must never trap the user during `starting`.** The previous UI
disabled all three source buttons with only a "Waiting for permission…" label, no
cancel and no escape, against a 60s timeout — an effective hard freeze. Always
give a visible Cancel plus `Escape`.

**7.11 `preserveDrawingBuffer: true`** is set on the canvas (needed for
screenshots/recording). Side effect: the canvas retains its last drawn frame, so
a stalled render loop shows a **stale image rather than going black** — which
makes visual debugging deeply misleading. Trust measured frame counters, not
screenshots, when diagnosing whether rendering is live.

---

## 8. What to build fresh

Everything not in `audio/`, `engine/`, or `scenes/`:

- **State store.** The core needs a small, well-defined slice — implement these
  or the core won't compile:
  - Fields: `sceneId`, `pendingSceneId`, `accentSceneId`, `overlaySceneId`,
    `paletteId`, `params: {intensity, speed, reactivity}`, `layerFx`, `quality`,
    `autoPilot`, `moodDrive`, `bandMappings`, `status`, `lastManualAt`
  - Actions: `requestScene(id, {auto})`, `commitScene()`,
    `setPalette(id, {auto})`, `setLayer(role, id, {auto})`
  - `requestScene` must call `preloadScene(id)` and set `pendingSceneId` (never
    `sceneId` directly — SceneManager owns the downbeat commit), and must stamp
    `lastManualAt` when not `{auto: true}` so AutoPilot backs off.
  - Zustand + `persist` worked well; any store is fine if the contract holds.
- **UI / HUD** — source picker, scene bar, palette picker, tune panel, debug
  readout. Free rein, but honour 7.10.
- **App shell**, routing, URL params (`?scene=`, `?palette=`, `?quality=`,
  `?ui=hidden` for OBS/kiosk), presets, recording, share links.

## 9. Setup

React 19 + `@react-three/fiber` v9 + `three` 0.178 + `@react-three/postprocessing`
+ TypeScript + Vite. `three`'s addons come from `three/examples/jsm/...`
(equivalently `three/addons/...`). `@react-three/drei` is **not** used — `chrome`
gets image-based lighting from three core's `PMREMGenerator` + `RoomEnvironment`
instead, so there is no extra dependency.

```bash
npm create vite@latest . -- --template react-ts
npm i three @react-three/fiber @react-three/postprocessing postprocessing zustand
npm i -D @types/three
```

Copy `audio/`, `engine/`, `scenes/` into `src/`. Set `noUnusedLocals: false` in
`tsconfig.json` (the registry keeps loader bindings for unregistered scenes).

**Verify:** `tsc -b --noEmit` and a production build must both pass, then run
each scene at `?scene=<id>&quality=low` and `&quality=high` **with real music**
and confirm sustained frame time under 20ms. Test a breakdown that drops the kick
but keeps hats — the highs-driven elements should stay lit while everything else
goes quiet. That single test proves the band separation is working.

---

## 10. Do not do these

- Rewrite the audio analysis, the directors, or the quality governor
- Build a custom renderer (considered and rejected twice — the GPU, not the host
  language, sets the ceiling; a rewrite moves nothing)
- Make beat timing frame-count-based instead of audio-clock-based
- Add scenes for variety's sake — the small roster is the art direction
- Wire every band to brightness
- Re-add the full grade chain without reading §7.1 first
