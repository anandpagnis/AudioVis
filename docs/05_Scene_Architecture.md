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
  anim: AnimationSignals      // pulse, breathe, inflate, twist, ripple,
                              // explode, dissolve, oscillate, flash, kick/snare/hihat
  b: { sub, bass, mid, presence, high, vocal, air, energy,
       transient, pulse, kick, snare, hihat }   // reactivity-scaled
  col: { a, b, c }            // blended palette
  vis: number                 // crossfade × mood intensity, floored + clamped
  params: VisualParams        // GLOBAL response layer (multipliers around 1)
  p: ResolvedSceneParams      // THIS scene's contract dials, all seven, 0..1
  mode: string | undefined    // this scene's active mode, if it declares any
  state: Readonly<PerformanceState>   // director decisions; NEVER write
}

// Per-scene readability tuning:
useSceneFrame(cb, { visCeiling: 1.6, visFloor: 0.5 })
```

`useSpin()` covers the accumulate-an-angle pattern that rotating scenes share.

`params` and `p` are different systems that share the word `speed`. `params.speed`
is global - how fast the whole show moves, a multiplier around 1, the same for
every scene. `p.speed` is this scene's own rate dial, normalised 0..1. Both apply;
neither replaces the other.

---

### Scene Contract v1 - the parameter vocabulary

`SceneMetadata` declares what a scene **is**. `metadata.contract` declares what it
can be **told**: seven parameter names that mean the same thing in every scene,
plus optional named modes.

```typescript
speed        rate of the scene's own motion   (0.5 = its natural rate)
shape        which silhouette/layout, within one scene's family
complexity   detail, iterations, subdivision - how much structure
density      how many, how packed, how deep the stack
fill         how much of the frame it occupies; scale, coverage, length
tilt         signed viewpoint/orientation offset (0.5 = level)
contrast     tonal range, edge hardness, falloff
```

The seven names are fixed. A control that does not fit one of them picks the
closest and **relabels** it - `paramLabels` gives a scene its own word for a
parameter (`density` reads as "fold" in `kaleido`, "spread" in `orbs`), so a
human sees the scene's language while automation still addresses `density`. An
eighth name would be a name every generic caller has to special-case, which is
the ceiling the vocabulary exists to remove.

**Why it matters.** Without a shared vocabulary every knob is private, so nothing
outside a scene's own file can name one. That is fine while every caller is a
scene author, and a hard ceiling the moment one is not:

| Capability | Needs the vocabulary because |
| --- | --- |
| AI Performance Director steering the picture | it must move `complexity` without knowing which scene is mounted |
| Presets surviving a scene swap | `complexity: 0.8` has to mean something to both scenes |
| Marketplace listings | a listing is generated from the contract, not from someone reading source |
| MIDI / OSC / Resolume / Max for Live | one map addresses the whole roster, including scenes added later |
| Third-party scenes | a stranger's scene is steerable on the day it is registered |

**Normalisation.** Every parameter is 0..1, always, with no per-scene ranges - a
generic caller must be able to write 0.7 into any parameter of any scene without
a lookup table. Scenes expand that themselves:

```typescript
drastic(p)          // magnitude: 0.25x at 0, 1x at 0.5, 4x at 1
bipolar(p, span)    // signed offset in +/-span, 0 at 0.5
steps(p, min, max)  // even integer buckets, inclusive
```

**The default-neutral invariant.** At its declared defaults, a scene renders
*exactly* as it did before it had a contract. All three expansions are the
identity at 0.5, and a scene's coefficients are calibrated so its declared
defaults reproduce the authored look - `chrome` declares `contrast: 0.85` rather
than 0.5 for precisely this reason, and its spans are set against that number.
Adding a contract is therefore never a visual change.

**Inert parameters.** A `null` label means the scene ignores that parameter in
that mode. Then the panel hides it, `liveParamKeys` omits it, and a write to it
is **dropped rather than stored** - a stored inert value would come back to life
the moment the user switched modes. A dial that is visible but dead is worse than
a missing one, and a director that thinks it is steering something it is not will
keep pushing a parameter that cannot answer.

**Reading the dials.** Two ways, and the choice is not stylistic:

```typescript
// Uniforms and transforms - free, updates every frame, no re-render.
useSceneFrame(({ p, params }) => {
  u.uRate.value = drastic(p.speed) * params.speed
})

// GEOMETRY and buffer sizes - built in useMemo during render, which ctx.p
// never triggers. useSceneParamSteps only reports a new value at a bucket
// boundary, so a full slider sweep rebuilds twice, not a few hundred times.
const mode = useSceneMode()
const detail = useSceneParamSteps('complexity', 0, 2)
const geo = useMemo(() => build(mode, detail), [mode, detail])
```

`WireframeHeroScene` is the reference implementation of both halves.

**Three layers decide a live dial**, lowest first: the scene's authored default,
the director's steer (`engine/sceneSteer.ts`), the user's own position. **The user
always wins** any dial they have touched - a dial that argues back is not a dial.
The steer is also sparse by design: it declines `shape` (no musical quantity
behind it) and `tilt` (the CameraDirector already owns viewpoint), so there is
always something a human owns uncontested.

**Adoption is opt-in.** A scene with no contract is simply not steerable: `ctx.p`
hands it neutral for all seven, no panel rows appear, the director cannot perform
it. That is the pre-v1 behaviour, so the roster migrates one scene at a time -
the same shape `cameraAnchor` uses. Steerable today: `wireframe` (modes +
structural `complexity`), `chrome`, `kaleido`, `orbs`, `tunnel`.

**Validation.** `validateContract` runs inside `validateSceneDef`, so
`registerScene` throws on a malformed contract rather than producing a panel of
dead sliders. It rejects a wrong version, a name outside the vocabulary, a default
outside 0..1, a label for an undeclared parameter or an undeclared mode, and a
parameter that is inert in every mode.

**External consumers** call `sceneContracts()` for the whole roster's control
surface - canonical key, human label, default, per mode. It is built from
`commerciallyShippableScenes()`, because the callers are exactly the ones that
must not enumerate material the project is not allowed to ship.

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
    // performanceCost answers "how much of the frame's COMPOSITION budget do
    // I take" (can I be layered?). It also DERIVES your resolution governance
    // for free: the engine solves scale = sqrt(budget / fullResMP) per live
    // display from a pixelBudget it computes off this cost class, and applies
    // it whether you read it or not. Leave pixelBudget/fillBound unset unless
    // your scene genuinely isn't fill-bound (see engine/renderScale.ts).
    performanceCost: 'medium',
    moodFit: { groove: 0.8, peak: 0.6 },
    // Hands camera control to CameraDirector. Omit only if the scene
    // genuinely needs bespoke camera work.
    cameraAnchor: { target: [0, 0, 0], distance: 10, height: 1.5 },
    cameraModes: ['orbit', 'cinematic', 'hover'],
    // Scene Contract v1 - what this scene can be TOLD. Optional; declaring a
    // parameter is a promise that the scene actually reads it.
    contract: {
      version: 1,
      modes: ['wide', 'tight'],            // first entry is the default
      params: { speed: 0.5, complexity: 0.5, density: 0.5 },
      paramLabels: {
        '*': { density: 'fold' },          // this scene's word for it
        tight: { density: null },          // inert here: hidden, writes dropped
      },
    },
  },
})
```

---

## Data Models

See `SceneMetadata`, `SceneRole`, `SceneBand`, `SceneIntensity`, `ScenePerformanceCost` in [14_Data_Models.md](14_Data_Models.md).

Scene Contract v1 types live in `src/scenes/contract.ts`: `SceneContract`,
`SceneParamKey`, `SceneParams`, `ResolvedSceneParams`, `SceneParamLabels`,
`SceneContractSummary`.

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
