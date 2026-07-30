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

Shared utilities: `CameraRig.ts`, `useDispose.ts`, `moodParams.ts`, `audioResponse.ts`, `glsl.ts`, `shaderLib.ts`.

---

## Interfaces

### Scene contract (implicit TypeScript interface)

```typescript
/**
 * A scene is a React component mounted by SceneManager inside R3F Canvas.
 * No props required — reads globals below.
 */
interface Scene {
  // Lifecycle: React mount/unmount
  // Required hooks:
  //   useFrame(() => { const f = audioEngine.features; ... })
  //   useContext(SceneFade) for fade multiplier
  //   useDispose(materials, geometries, textures)
  // Optional:
  //   CameraRig instance for camera motion
  //   PaletteBlender for smooth palette colors
}

interface SceneDef {
  id: string
  name: string
  component: ComponentType
  metadata: SceneMetadata
}
```

### Registration

```typescript
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
- Output levels: target **0–1 range** on hero elements — blown additive breaks PostFX (see [09_Rendering_Engine.md](09_Rendering_Engine.md)).
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
