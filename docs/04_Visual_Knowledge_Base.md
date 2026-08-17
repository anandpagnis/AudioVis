# Document 4 — Visual Knowledge Base

> **Audience:** content authors, scene developers, AI agents selecting assets.  
> **Status:** scene + palette metadata live; shader/effect catalog partial.  
> **Spec:** [specs/visual_knowledge_base_spec.md](specs/visual_knowledge_base_spec.md)

---

## Overview

Every visual asset in AudioVis is described by **metadata**, not just a filename. The Visual Knowledge Base (VKB) is how AutoPilot, PerformanceDirector, and future ML planners choose compatible looks. Scenes, palettes, camera rigs, transitions, and effects all become queryable records.

---

## Goals

- Enable **automatic composition** without hard-coded scene lists.
- Support **marketplace/community** scenes with self-describing manifests.
- Allow **genre/mood/energy** filtering without reading shader code.
- Keep metadata **human-editable** alongside code registration.

---

## Responsibilities

- Define schema for scenes, palettes, cameras, transitions, effects.
- Maintain the active roster catalog (11 registered scenes).
- Document culled legacy scenes (deleted, not left unregistered — see below).
- Provide lookup helpers (`getScenesForMood`, `getPrimaryScenesForMood`, `getCompatibleScenes`,
  `pickVariedScene`).

---

## Non-Goals

- Asset binary storage (scenes are code; textures in backend cache).
- Full DAM integration (Dropbox/S3) in current phase.

---

## Architecture

```text
SceneDef { id, name, component, metadata: SceneMetadata }
Palette { id, name, colors, bg }
CameraDirector modes { orbit, hover, push, pull, spiral, handheld, locked, topdown, cinematic } — per-scene cameraModes
Transitions — SceneManager crossfade + hard-cut (see 08)
Effects — EffectsDirector chain entries
```

Registration: `registerScene()`, `registerPalette()` at boot.

---

## Data Flow

Directors query VKB → rank candidates → store actions → SceneManager renders winner.

---

## Components

| Asset type | Schema location | Query API |
|------------|-----------------|-----------|
| Scenes | `SceneMetadata` in `src/scenes/index.ts` | `getScenesForMood`, `getCompatibleScenes`, `getScene` |
| Palettes | `Palette` in `src/engine/palettes.ts` | `getPalette`, `MOOD_PALETTES` in AutoPilot |
| Cameras | `CameraMode` catalog | Declared in scene metadata (`cameraAnchor` + `cameraModes`) |
| Transitions | SceneManager fade | Implicit crossfade |
| AI textures | Mood×palette×variant keys | `textureGenerator.ts` cache |

---

## Interfaces

```typescript
interface SceneMetadata {
  roles: SceneRole[]           // background | primary | accent | overlay
  moods: MoodState[]
  bands: SceneBand[]           // bass | mid | high | vocal | energy
  intensity: SceneIntensity    // calm | medium | high
  compatibleWith: string[]
  performanceCost: ScenePerformanceCost  // low | medium | high
  moodFit?: Partial<Record<MoodState, number>>  // 0..1
}
```

---

## Data Models

### Registered scene catalog


#### Wireframe Hero (`wireframe`)

```yaml
Name: Wireframe Hero
Themes: GitS, Technical, Line Art
Mood: Ambient → Aggressive
Genres: Techno, Minimal, Cyberpunk
Energy: 0.3–0.95
Bands: bass, mid, presence, high, energy
Camera: Orbit
Negative Space: High
Performance Cost: Low
Roles: primary, accent
Compatible: plasma, dissolve, chrome
moodFit: building 0.86, groove 0.80
Technique: WireframeGeometry2 + LineMaterial
```

#### Plasma Filament (`plasma`)

```yaml
Name: Plasma Filament
Themes: Particle, Chromatic, Filament
Mood: Groove, Building, Peak, Aggressive
Genres: Peak-time Techno, Industrial
Energy: 0.7–1.0
Bands: bass (core), high (filaments), energy
Camera: Orbit
Negative Space: Medium
Performance Cost: High
Roles: primary, accent, overlay
Compatible: wireframe, dissolve, chrome
moodFit: peak 0.94, aggressive 0.90
Technique: 70k curl-noise particles
```

#### Dissolve Cage (`dissolve`)

```yaml
Name: Dissolve Cage
Themes: Organic, Frame, Deconstruction
Mood: Mellow, Groove, Building, Peak
Genres: Melodic Techno, Progressive
Energy: 0.4–0.85
Bands: bass, mid, energy
Camera: Hover
Negative Space: High
Performance Cost: Medium
Roles: primary
Compatible: wireframe, plasma, chrome
moodFit: building 0.88, groove 0.82
```

#### Chrome Form (`chrome`)

```yaml
Name: Chrome Form
Themes: Hero Object, Specular, Stage
Mood: Ambient, Mellow, Groove, Building, Peak
Genres: House, Melodic, Live PA
Energy: 0.3–0.8
Bands: bass, high, energy
Camera: Orbit
Negative Space: High
Performance Cost: Medium
Roles: primary
Compatible: wireframe, plasma, dissolve
moodFit: mellow 0.84, ambient 0.70
Technique: MeshPhysicalMaterial + PMREM IBL
```

### Palette catalog

| ID | Name | Character | Mood affinity |
|----|------|-----------|---------------|
| aurora | Aurora | Cyan/violet/mint | groove, building |
| ember | Ember | Orange/red/gold | peak, aggressive |
| violet | Violet Haze | Purple/pink/indigo | mellow, groove |
| ocean | Deep Ocean | Blue/teal | ambient, mellow |
| mono | Monolith | White/grey | aggressive, ambient |
| solar | Solar Flare | Yellow/orange | building, peak |

### Culled legacy scenes

The pre-pivot 17-scene roster (`nebula`, `galaxy`, `tunnel`, `fluid`, `monolith`, `noisefield`,
`clouds`, `crystal`, `angelcore`, `cathedral`, `fractaltunnel`, `neural`, `particles`, `fluidsim`,
and others) failed the subject/negative-space/hard-edges rubric from [00_Vision.md](00_Vision.md) and
were **deleted outright** (in git history if ever wanted — see `docs/HANDOFF.md` §2 item 13), not
left unregistered on disk. Note `ribbons` and `ocean`/`aurora` are no longer in this list: `ribbons`
is now the registered "Flow Ribbons" scene (a different implementation from its legacy namesake), and
`ocean`/`aurora` are palette ids, not scene ids — the overlap in naming predates the cull.

---

## Algorithms

### Mood-fit ranking

```typescript
getScenesForMood(mood, role?) → filter moods.includes(mood) && (!role || roles.includes(role))
  → sort by moodFit[mood] ?? 0.5 descending
```

`getPrimaryScenesForMood(mood)` is the `role: 'primary'` shorthand — always prefer it (or pass
`role` directly) over the unfiltered call when picking what to show as the primary scene: several
scenes are layer-only (`ribbons` is `['accent', 'overlay']`) and can outrank primary-capable scenes
on `moodFit`, so an unfiltered pick can install one as the subject it was authored to composite over.
`pickVariedScene(candidates, mood, recentIds, boost?)` is the weighted-random-with-recency-decay
picker both `AutoPilot` and `PerformanceDirector` call on top of the filtered pool — see
`docs/03_AI_Performance_Director.md`.

### Compatibility filter

```typescript
getCompatibleScenes(id) → map compatibleWith → filter registered
  → silent drop of stale IDs
```

---

## State Machines

N/A — metadata is static at runtime except `registerScene()` mutations.

---

## Update Frequency

Metadata read on every director evaluation (~60 Hz reads, zero writes).

---

## Performance Constraints

Metadata lookups are O(n) over 11 scenes today — trivial. Marketplace scale needs indexed queries (future).

---

## Failure Modes

| Issue | Mitigation |
|-------|------------|
| Missing moodFit | Default 0.5 |
| Stale compatibleWith id | Filtered silently |
| Invalid registerScene | `validateSceneDef()` throws at boot |

---

## Testing

- `validateSceneDef()` on all registered scenes
- Manual: verify AutoPilot picks mood-appropriate scenes from debug mood readout

---

## Future Improvements

- YAML manifest files co-located with scenes (import at build time).
- Tag ontology: themes, genres, energy ranges, negative-space score.
- Negative constraints: "don't use with ambient breakdown."
- Community marketplace schema + royalty metadata.
- Automated metadata suggestion from shader analysis (LLM offline).

See [15_Implementation_Roadmap.md](15_Implementation_Roadmap.md) Phase 2.
