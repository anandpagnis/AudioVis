# Document 5 — Scene Architecture

> **Audience:** scene developers, plugin authors.  
> **Status:** contract stable; 11 reference implementations.  
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

Reference implementations — **`wireframe` is `SCENES[0]`**, the load-bearing fallback `getScene()`
returns for any unregistered id, so keep it cheap and safe:

| Scene | File | Technique |
|-------|------|-----------|
| Wireframe Hero | `WireframeHeroScene.tsx` | Line2/LineMaterial — `SCENES[0]`, the fallback |
| Plasma Filament | `PlasmaFilamentScene.tsx` | Custom particle vertex shader |
| Dissolve Cage | `DissolveCageScene.tsx` | Particles + wireframe cage |
| Chrome Form | `ChromeFormScene.tsx` | MeshPhysicalMaterial + PMREM |
| Flow Ribbons | `FlowRibbonScene.tsx` | Vertex-shader triangle strips through a curl field, tracing `midWaveform` |
| Network Constellation | `NetworkConstellationScene.tsx` | Fullscreen-quad jittered node web (only non-`wireframe` scene with `background`/`accent`/`overlay` roles too) |
| PCD LIDAR Scan | `PointCloudScanScene.tsx` | 60k-point deterministic procedural cloud (fixed seed) |
| Inversion Machine | `InversionMachineScene.tsx` | Raymarched sphere-inversion fractal |
| Fold Path | `FoldPathScene.tsx` | Fixed-step heightfield flythrough, IFS-fold fractal texture |
| Torus Fold | `TorusFoldScene.tsx` | Mandelbox-style folded-space fractal ∩ torus |
| Julia Wings | `JuliaWingsScene.tsx` | 2D Julia-set variant, moth/butterfly-wing symmetry |

`Schematic` and `Liquid Form` were both removed from the roster (see `docs/HANDOFF.md` §2 item 17)
— if you find either referenced elsewhere in the docs or in old presets/URLs, it's stale; `wireframe`
took over the `SCENES[0]` fallback role Schematic used to hold.

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
  anim: AnimationSignals      // pulse, breathe, inflate, twist, ripple,
                              // explode, dissolve, oscillate, flash, kick/snare/hihat
  b: { sub, bass, mid, presence, high, vocal, air, energy,
       transient, pulse, kick, snare, hihat }   // reactivity-scaled
  col: { a, b, c }            // blended palette
  vis: number                 // crossfade × mood intensity, floored + clamped
  params: VisualParams
  state: Readonly<PerformanceState>   // director decisions; NEVER write
}

// Per-scene readability tuning:
useSceneFrame(cb, { visCeiling: 1.6, visFloor: 0.5 })
```

`useSpin()` covers the accumulate-an-angle pattern that rotating scenes share.

**What the context deliberately does *not* do** is decide which band drives which visual property. That routing is the art direction (see Algorithms below) and stays per-scene — the context prepares values, the scene decides what they mean.

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
    compatibleWith: ['wireframe', 'plasma'],
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
| `voice` | Sustained/melodic lead — e.g. ribbon width in Flow Ribbons |
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
