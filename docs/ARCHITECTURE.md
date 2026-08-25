# AudioVis Architecture & Extension Guide

AudioVis is built as a reusable creative-coding platform, not a single-purpose visualizer.
This document maps the extension points that keep new scenes, audio inputs, authored performances,
WebGPU work, and AI visuals additive rather than rewrites. For the full product handoff and
remaining roadmap, see [HANDOFF.md](HANDOFF.md).

## Layer map

```
src/audio/    AudioEngine → BpmEstimator, PhraseDetector,
              MoodEstimator                                   (musical understanding)
src/engine/   SceneManager, AutoPilot, PerformanceDirector,
              CameraDirector, AnimationDirector, EffectsDirector,
              LightRig, PerfMonitor, performanceState,
              palettes, presets, moodParams                   (visual framework)
src/scenes/   5 registered scenes (+16 unregistered) + registry (content)
src/ui/       HUD, BpmReadout, DebugPanel                     (chrome)
src/store.ts  zustand store (persisted)                       (state)
```

The one-way data flow: **audio in → `AudioFeatures` (one mutable object, updated once per
frame) → scenes**. Scenes never touch the Web Audio API; the UI never touches Three.js.

## Mood system

`MoodEstimator` (src/audio) runs after the beat/phrase trackers each frame and writes
`features.mood`: a committed state (7 classes, hysteresis-gated so scenes aren't
whipsawed), trend velocities, a predicted next state with `beatsTillTransition`, and
smoothed visual multipliers. Downstream consumers, all independent and individually
toggleable:

- **`moodParams.getEffectiveParams()`** — the single choke point scenes use instead of
  reading `params` off the store; returns user params × mood multipliers.
- **`AutoPilot`** (useFrame priority -90, right after the engine tick) — maps moods to
  ranked scene lists from scene metadata and palette lists from its local table, then calls
  `requestScene(id, { auto: true })`, which skips the manual-hold timestamp. Manual actions
  set `lastManualAt`; autopilot backs off 45 s.
- **`PerformanceDirector`** (useFrame priority -85) — at phrase/section boundaries, chooses a
  compatible next scene whose metadata matches the dominant audio band, then queues it through
  `SceneManager` for the next musical downbeat. This is the automatic multi-scene journey layer;
  manual selection still takes precedence.
- **`audioResponse.getAudioResponse()`** — converts normalized analyzer bands into a stable
  scene-facing vocabulary: sub, bass, mid, presence, high, vocal, energy, transient, beat, drop,
  and build envelopes.
- **Composition layers** — `SceneManager` can keep a primary scene plus independent accent and
  overlay entries. Layer choices live in the store and presets, so a custom performance can be
  authored without changing scene code.
Tuning lives in two places: state scores + hold times in `MoodEstimator.score()` /
`holdFor()`, and scene/palette affinities + cooldowns in `AutoPilot.tsx`.

## Extension points

### Add a scene
Create a component following any existing scene's pattern, then one line in
`src/scenes/index.ts` — or from outside the core bundle:

```ts
import { registerScene } from './scenes'

registerScene({
  id: 'myscene',
  name: 'My Scene',
  component: MyScene,
  metadata: {
    roles: ['primary'],
    moods: ['groove', 'peak'],
    bands: ['mid', 'high', 'energy'],
    intensity: 'medium',
    compatibleWith: ['nebula', 'galaxy'],
    performanceCost: 'medium',
    moodFit: { groove: 0.8, peak: 0.6 },
  },
})
```

A scene's contract: read `audioEngine.features` inside `useFrame`, multiply visibility by
`useContext(SceneFade).value` and `params.intensity`, respect `params.speed`/`reactivity`,
blend palette colors via `PaletteBlender`, keep idle motion during silence, and pass any
self-created materials/geometries to `useDispose`. Declare a `cameraAnchor` in metadata
and let CameraDirector own camera motion (never move the camera yourself), and use
plain `MeshStandardMaterial` if you want the `LightRig` to light you.

Scene metadata is the contract future composers use to combine scenes:

- `roles`: whether the scene can act as a `background`, `primary`, `accent`, or `overlay`.
- `moods` / `moodFit`: where it belongs musically, and how strongly it fits each state.
- `bands`: which audio features the scene visually expresses best (`bass`, `mid`, `high`,
  `vocal`, `energy`).
- `intensity`: calm, medium, or high visual density.
- `compatibleWith`: scenes that should layer or transition well with it.
- `performanceCost`: how much of the frame's *composition* budget the scene occupies — what
  decides whether it can be layered.
- `fillBound` (optional, default `true`): whether the scene's cost is per-pixel. Leave it
  alone unless your scene is genuinely resolution-indifferent (a handful of meshes, a flat
  fill) — declaring `false` on a scene that *is* fill-bound removes it from quality
  governance entirely, which is how a single scene takes a venue down.
- `pixelBudget` (optional): overrides the internal-megapixel budget the engine would
  otherwise DERIVE from `performanceCost` (see `BUDGET_BY_COST` in `engine/renderScale.ts`).
  Almost every scene should omit this — the derived default already decouples resolution
  from the live display via `scale = sqrt(budget / fullResMP)`. Reach for an explicit value
  only when a scene genuinely doesn't behave like its cost class; a scene registered from
  outside the repo has its claim capped rather than trusted (`UNTRUSTED_MAX_BUDGET`).
- `contract`: Scene Contract v1 - what the scene can be TOLD. See below.

### Make a scene steerable (Scene Contract v1)

Metadata says what a scene *is*. `metadata.contract` says what it can be *told*, in
seven names that mean the same thing in every scene: `speed`, `shape`,
`complexity`, `density`, `fill`, `tilt`, `contrast` - all normalised 0..1, plus
optional named modes.

```ts
metadata: {
  // ...
  contract: {
    version: 1,
    modes: ['wide', 'tight'],          // optional; first entry is the default
    params: { speed: 0.5, complexity: 0.5, density: 0.5 },
    paramLabels: {
      '*': { density: 'fold' },        // your word for it, shown to humans
      tight: { density: null },        // inert in this mode: hidden, writes dropped
    },
  },
}
```

Then read them:

```ts
useSceneFrame(({ p, params }) => {
  u.uRate.value = drastic(p.speed) * params.speed   // magnitude: 0.25x..4x
  u.uFold.value = bipolar(p.density, 0.5)           // signed, 0 at 0.5
})

// Geometry instead of a uniform? Those are built during render, which ctx.p
// never triggers - and useSceneParamSteps only changes at bucket boundaries,
// so a slider drag does not rebuild per frame.
const detail = useSceneParamSteps('complexity', 0, 2)
const mode = useSceneMode()
```

Rules worth knowing before you declare anything:

- **Declaring a parameter is a promise you read it.** A visible dial that does
  nothing is worse than a missing one. Declare the subset you honour; the rest
  read as neutral and cost nothing.
- **The seven names are fixed.** A control that does not fit picks the closest and
  relabels it. There is no eighth name, because every generic caller would have to
  special-case it.
- **0.5 must be your authored look.** `drastic`, `bipolar` and `steps` are all the
  identity at 0.5, so calibrate your spans such that the declared defaults render
  exactly what you would have shipped without a contract. If your natural default
  is not neutral, declare it (`chrome` declares `contrast: 0.85`).
- **A malformed contract is refused.** `registerScene` runs `validateContract` and
  throws - wrong version, unknown name, default outside 0..1, a label for
  something undeclared, a parameter inert in every mode.

What you get for it, without writing any of it yourself: the AI Performance
Director steers your scene against musical structure; the tune panel builds rows
labelled in your own words; presets capture and restore your dials, and survive
being pointed at a different scene; and `sceneContracts()` publishes your control
surface to external consumers (MIDI/OSC maps, Resolume, Max for Live, a
marketplace listing) the day you register.

Three layers decide a live dial - your default, then the director's steer, then
the user's own position. The user wins any dial they touch. The director never
touches `shape` or `tilt`, so those two are always a human's.

### Add an audio input
`audioEngine.startWithStream(stream)` accepts **any MediaStream** — virtual audio cables
(BlackHole, VB-Cable), OBS audio, WebRTC/network streams, or a WebAudio synth driven by
MIDI/OSC (pipe it through `MediaStreamAudioDestinationNode`). `startWithFile(file)` plays
a local file while analyzing it. Everything downstream — BPM, beats, phrases, scenes —
works unchanged. External timing sources call
`bpmEstimator.setExternalTempo(bpm, beatTime, now)` (the MIDI clock adapter in
`src/audio/MidiClock.ts` is the reference implementation); the override expires ~2 s
after the clock stops and onset tracking resumes.

### Cues and automation precedence
Per-frame priority order: engine tick (−100) → AutoPilot (−90) → CueTimeline (−88) →
PerformanceDirector (−85) → scenes. While `cueState.governed` is true (a cue fired and
either another lies ahead or <32 beats have passed), both automatic directors stand down.
Manual input suppresses the directors for 45 s but not authored cues.

### Add a palette / preset
`registerPalette({...})`, or ship presets as JSON (the import pipeline validates and
merges; see `sanitizePreset`).

### OBS / wallpaper mode
URL parameters configure a chromeless instance (see `src/urlParams.ts`):
`?scene=wireframe&palette=ember&ui=hidden&quality=low&reactivity=1.4`

### Parameters
Global visual params live in the store (`intensity`, `speed`, `reactivity`). New params:
add a key to `VisualParams`, a slider row in the HUD, and read it in scenes — the preset
and URL systems pick it up via the same objects. `getEffectiveParams()` composes, in
order: user sliders × mood multipliers × declarative band mappings (store.bandMappings),
then clamps. Response shaping (band attack/release, beat subdivision) lives on
`audioEngine.tuning`, synced from the persisted store.

### Composition layers
`SceneManager` mounts accent/overlay entries with a per-entry weighted fade
(fade × `layerFx[role].intensity`) handed to scenes through the same `SceneFade`
context, and a `BlendedLayer` wrapper that rewrites the layer's material blending
(`add`/`screen`/`normal`/`multiply`) by traversal for a few frames after mount or a
blend change.

### Code splitting
Built-in scenes are `React.lazy` chunks behind `<Suspense fallback={null}>`;
`preloadScene(id)` (called by `requestScene`/`setLayer`) starts the fetch before the
downbeat commit. The AI texture layer loads only when first enabled. Vendor chunks
(`three`, `react`, `fx`) are pinned in `vite.config.ts`.

## Performance model (Phase 6)

- **Dynamic quality scaling**: `PerfMonitor` tracks an EMA of frame time; in `auto`
  quality it walks a 5-step resolution ladder (down fast below ~50 fps, up slowly after
  4 s of >80 fps headroom). Fixed low/medium/high pin the ratio; low also drops the
  chromatic-aberration pass.
- **GPU instancing**: Monolith debris and Crystal shards are `InstancedMesh`; Galaxy
  (30k stars) and Ribbons (48×72 strips) are single draw calls with all animation in
  vertex shaders.
- **Memory**: every scene disposes its hand-built materials/geometries on unmount
  (`useDispose`); analysis buffers (`Float32Array`s) are allocated once and reused; the
  per-frame hot path allocates nothing.
- **Frustum culling** is deliberately disabled on fullscreen quads and shader-displaced
  geometry (their vertex positions are computed on the GPU, so CPU-side bounds would
  mis-cull); everything else uses Three.js defaults.

## Future-facing notes

- **WebGPU**: scenes talk to Three.js, not WebGL directly. Migrating means swapping the
  renderer in `Stage.tsx` and porting GLSL chunks (`engine/glsl.ts`) to TSL/WGSL — scene
  logic, audio, UI, and state are untouched.
- **AI-generated scenes/shaders**: `registerScene` + the scene contract is the target an
  AI generator would emit against; fragment-shader-only scenes need just a FRAG string
  dropped into the fullscreen-quad template (see `NebulaScene`).
- **Recording/export**: the canvas is a standard WebGL canvas — `canvas.captureStream()`
  + `MediaRecorder` can be added as a UI feature without engine changes.
- **Multiplayer/cloud sync**: all shareable state (scene, palette, params, presets) is
  already serialized through the persisted store partialize — a sync layer would ship
  that same object.
