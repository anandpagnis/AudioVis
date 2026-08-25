# Document 5 — Scene Architecture

> **Audience:** scene developers, plugin authors.  
> **Status:** contract stable; 5 reference implementations.  
> **Spec:** [specs/scene_architecture_spec.md](specs/scene_architecture_spec.md)

---

## Overview

A **scene** is a self-contained React Three Fiber component that renders one visual look. Scenes do not manage transitions, audio capture, or global state — they **read** musical features and **write** pixels. The scene interface is the contract between content authors and the engine.

---

## Goals

- One clear **scene contract** — any author can build a compatible scene.
- **Lazy loading** — scenes are code-split chunks.
- **Graceful fade** — scenes respect `SceneFade` during crossfades.
- **GPU hygiene** — `useDispose()` for all custom resources.
- **Quality awareness** — heavy scenes read `quality.knobs`.

---

## Responsibilities

| Owner | Responsibility |
|-------|----------------|
| Scene | Render look; map audio bands to visual params |
| SceneManager | Mount, warm, fade, unmount |
| Registry | Metadata, lazy load, validation |
| Directors | Which scene, not how it draws |

---

## Non-Goals

- Scenes choosing their own transition timing (SceneManager owns this).
- Scenes accessing Web Audio or Zustand directly (features + helpers only).
- Scenes managing palette store (read via `PaletteBlender` + store selector).

---

## Architecture

```text
SceneDef
  ├── id, name
  ├── component: React.FC (lazy)
  └── metadata: SceneMetadata

Scene component lifecycle:
  mount → useMemo (geometry/material) → useFrame (read features, update uniforms)
       → multiply by SceneFade → render
  unmount → useDispose
```

---

## Data Flow

```text
audioEngine.features ──► useFrame
getEffectiveParams() ──► intensity/speed/reactivity
PaletteBlender ──► colors
SceneFade.value ──► visibility multiplier
quality.knobs ──► complexity limits
```

---

## Components

Reference implementations:

| Scene | File | Technique |
|-------|------|-----------|
| Schematic | `SchematicScene.tsx` | ShaderMaterial + barycentric wireframe |
| Wireframe Hero | `WireframeHeroScene.tsx` | Line2/LineMaterial |
| Plasma Filament | `PlasmaFilamentScene.tsx` | Custom particle vertex shader |
| Dissolve Cage | `DissolveCageScene.tsx` | Particles + wireframe cage |
| Chrome Form | `ChromeFormScene.tsx` | MeshPhysicalMaterial + PMREM |
| Liquid Form | `LiquidFormScene.tsx` | Raymarched SDF metaballs, `opSmoothUnion` blend driven by voice |
| Flow Ribbons | `FlowRibbonScene.tsx` | Vertex-shader triangle strips through a curl field |

Shared utilities: `useDispose.ts`, `moodParams.ts`, `audioResponse.ts`, `AnimationDirector.ts`, `glsl.ts`, `shaderLib.ts`.

---

## Interfaces

### Scene contract (implicit TypeScript interface)

```typescript
/**
 * A scene is a React component mounted by SceneManager inside R3F Canvas.
 * No props required.
 *
 * Required:
 *   useSceneFrame(ctx => { ... })   // prepared per-frame context
 *   useDispose(materials, geometries, textures)
 *
 * A scene does NOT: move the camera (declare `cameraAnchor` in metadata),
 * touch post-processing (EffectsDirector owns it), blend the palette by hand
 * (ctx.col), or derive its own envelopes (ctx.b / ctx.anim).
 */
```

### The per-frame context

`useSceneFrame` replaces a scene's own `useFrame` and hands over everything prepared:

```typescript
interface SceneFrame {
  f: AudioFeatures            // raw, for anything not covered below
  dt: number
  anim: AnimationSignals      // inflate, twist, ripple, explode, dissolve, oscillate
  b: { sub, bass, mid, presence, high, vocal, voice, air, energy,
       transient, pulse, kick, snare, hihat }   // reactivity-scaled
  col: PaletteBlender         // a/b/c AND bg/shadow/mid/accent/glow — see doc 07
  vis: number                 // crossfade × slot gain × mood intensity, floored + clamped
  params: VisualParams        // GLOBAL sliders; per-scene params are separate, below
  camera: THREE.Camera        // read-only — CameraDirector owns the transform
  role: SlotName              // 'primary'|'background'|'accent'|'overlay'|'effect'
  roleGain: number            // this slot's gain WITHOUT the crossfade folded in
  slotProgress: number        // 0→1 across an effect's life; 0 elsewhere
  state: Readonly<PerformanceState>   // director decisions; NEVER write
}

// Per-scene readability tuning:
useSceneFrame(cb, { visCeiling: 1.6, visFloor: 0.5 })
```

`useSpin()` covers the accumulate-an-angle pattern that rotating scenes share.

**What the context deliberately does *not* do** is decide which band drives which visual property. That routing is the art direction (see Algorithms below) and stays per-scene — the context prepares values, the scene decides what they mean.

### Per-scene parameters

`ctx.params` is **global** (`intensity`, `speed`, `reactivity`). A scene's own
knobs come from the canonical vocabulary in `src/engine/sceneParams.ts`:

```typescript
const SCENE_PARAM_KEYS = ['speed','shape','complexity','density','fill','tilt','contrast']
const drastic = (p: number) => Math.pow(4, (p - 0.5) * 2)   // 0.25x / 1x / 4x

const P = useSceneParams('ink')   // fully populated; stable object, no re-renders
```

Seven names, the same seven in every scene — and the fixedness *is* the feature.
It is why one generic panel drives every scene, why a preset survives a scene
swap, and why anything wanting to reach inside a scene (a cue, a MIDI map, a
director wanting a scene *denser* rather than merely different) can address it
without knowing what the scene is.

Rules:

- A scene **declares only the keys it reads**, in `metadata.params`, at the values
  it was authored at. Presence is the declaration; the panel shows exactly those.
- `drastic()` is applied to **`speed` only**. Every other key is consumed raw as a
  0..1 factor by the scene. `speed` is the only key whose meaning is multiplicative.
- **Do not add an eighth key** to serve one scene. Express it as a mode instead.
- Overrides are stored sparsely per scene id (`store.sceneParams`), so changing a
  scene's authored default later still reaches every user who never touched that
  slider.

### Scene modes

`metadata.modes: string[]` declares named looks, dispatched through a `uMode` int
uniform. A new look costs a branch in a shader rather than a whole scene file, so
one scene with five modes fills a mood's pool the way five scenes would.

**Append-only per scene** — the index reaches a uniform and is persisted in
presets and cues, so reordering changes what a saved look renders. An unknown
stored mode name falls back to index 0 rather than leaving the shader on its
`else` branch. `metadata.paramLabels` relabels sliders per mode, and a `null`
label hides one. `validateSceneDef()` rejects inconsistent mode wiring, because
every failure in this area is silent at runtime.

### The fullscreen-shader scene factory

Most shader scenes are a fragment shader plus a uniform mapping, and
`createShaderScene()` (`src/engine/createShaderScene.tsx`) is the declaration
form for exactly that — no React, no resource lifecycle, no resize plumbing, no
fade arithmetic:

```typescript
export const InkFieldScene = createShaderScene<InkState>({
  id: 'ink',                               // MUST match the registry id
  frag: FRAG,                              // SHADER_SCENE_PRELUDE is prepended
  include: SIMPLEX3D_GLSL,
  uniforms: () => ({ uPhase: { value: 0 } }),
  state: () => ({ phase: 0, shock: 0 }),   // per-INSTANCE, never module scope
  pixelBudget: 1.5,                        // target internal megapixels
  update({ u, s, P, st, dt }) { /* ... */ },
})
```

Three things worth knowing:

- **`SHADER_SCENE_PRELUDE` already declares** `uRes`, `uAspect`, `uFade`, `uTime`,
  `uMode` and the five palette colours. Redeclaring any of them is a GLSL compile
  error — deleting those lines is the one edit every ported shader needs.
- **`state` is per mounted instance.** The same scene can be mounted twice at once
  (two slots, or both halves of a crossfade), so a module-level `let phase` would
  have both instances advancing one accumulator at double rate.
- **`pixelBudget` is engine-owned governance.** The scene declares a target and the
  engine solves `scale = sqrt(budget / fullMP)`; the scene never holds the dial and
  so cannot ignore it, unlike `quality.knobs` (which four scenes do ignore). Omit
  it for a scene cheap enough to run at full resolution — the offscreen path costs
  a fullscreen blit, and the factory renders the first few frames regardless of
  `vis` so the expensive program still compiles inside the warm window.

`s` is the audio state in the lilim vocabulary (`s.mids`, `s.onKick`, `s.specHi`),
built by `src/engine/lilimState.ts`. It exists so shader bodies tuned against
those exact names, ranges and ballistics port across without being silently
relandscaped at every use site.

### Registration

```typescript
interface SceneDef {
  id: string
  name: string
  component: ComponentType
  metadata: SceneMetadata
}

registerScene({
  id: 'myscene',
  name: 'My Scene',
  component: MyScene,
  metadata: {
    roles: ['primary'],
    moods: ['groove', 'peak'],
    bands: ['mid', 'high', 'energy'],
    intensity: 'medium',
    compatibleWith: ['schematic', 'wireframe'],
    performanceCost: 'medium',
    moodFit: { groove: 0.8, peak: 0.6 },
    // Hands camera control to CameraDirector. Omit only if the scene
    // genuinely needs bespoke camera work.
    cameraAnchor: { target: [0, 0, 0], distance: 10, height: 1.5 },
    cameraModes: ['orbit', 'cinematic', 'hover'],
  },
})
```

---

## Data Models

See `SceneMetadata`, `SceneRole`, `SceneBand`, `SceneIntensity`, `ScenePerformanceCost` in [14_Data_Models.md](14_Data_Models.md).

---

## Algorithms

### Audio band binding (required discipline)

Each scene must bind **distinct visual parameters** to bands so the audience can **see** separation:

| Band | Typical visual job |
|------|-------------------|
| `bass` | Mass, scale, core brightness |
| `mid` | Hue shift, rotation speed |
| `presence` | Line weight, stroke opacity |
| `high` | Dedicated high-frequency elements |
| `transient` | Instant flash, particle burst |
| `voice` | Sustained/melodic lead — merge, width, swell (see below) |
| `kick`/`snare`/`hihat` | Independent per-drum response |
| `energy` | Overall amplitude multiplier |

**Anti-pattern:** only binding `bass` and `energy` — mids/highs appear dead.

### Visibility composition

```typescript
const fade = useContext(SceneFade)
const params = getEffectiveParams()
const vis = fade.value * params.intensity
// Apply to opacity, uniform multipliers, or material opacity
```

### Quality integration

Raymarch scenes: `qualityUniforms()` + `applyQualityUniforms(u)` from `quality.ts`.  
Particle scenes: `setDrawRange(count * quality.knobs.particleFraction)`.  
Fluid scenes: Jacobi iteration count from `quality.knobs.fluidJacobi`.

---

## State Machines

### Scene instance in SceneManager

```text
not mounted → warming (dir=0, visible, compiling)
           → hidden (dir=0, warm complete, opacity 0)
           → fading in (dir=1)
           → active (dir=0, fade=1)
           → fading out (dir=-1)
           → unmounted
```

Layers follow the same fade machinery with additional `layerFx[role].intensity` multiplier.

---

## Update Frequency

Scenes update every frame in `useFrame` (~60 Hz). No React re-renders for audio-driven values — mutate uniforms directly.

---

## Performance Constraints

- Prefer single draw call or instancing for particle-heavy scenes.
- Read `quality.knobs` — never hard-code max particle count or raymarch steps.
- Dispose all GPU resources on unmount.
- Output levels: target **0–1 range** on hero elements — blown additive breaks the post chain (see [09_Rendering_Engine.md](09_Rendering_Engine.md)).
- Frustum culling: disable on fullscreen quads / GPU-displaced geometry.

---

## Failure Modes

| Issue | Mitigation |
|-------|------------|
| Black screen on HMR | Restart dev server; check uniform init ≠ black |
| Shader compile on beat | SceneManager warm-up (WARM_FRAMES=4) |
| Memory leak on switch | useDispose |
| uFade stuck at 0 | SceneFade context wiring |

---

## Testing

Per-scene checklist:
- [ ] Visible at idle (silence motion)
- [ ] Reacts to bass, mid, presence, high, transient distinctly
- [ ] Fades in/out during scene switch
- [ ] Palette cycle smooth (`P`)
- [ ] Quality drop reduces cost without crash
- [ ] `npm run check` clean

---

## Future Improvements

- Formal `Scene` TypeScript interface exported from engine.
- Scene template CLI/generator.
- Deterministic seeds for reproducible recordings.
- Fragment-shader-only scene template (drop-in FRAG string).
- Automated band-binding linter.

See [specs/scene_architecture_spec.md](specs/scene_architecture_spec.md) for folder layout and acceptance criteria.
