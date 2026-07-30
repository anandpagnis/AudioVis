# Document 8 — Transition Engine

> **Audience:** engine developers, creative directors.  
> **Status:** crossfade + warm-up + hard-cut implemented.  
> **Spec:** [specs/transition_engine_spec.md](specs/transition_engine_spec.md)

---

## Overview

The Transition Engine controls **how** looks change — not **what** look comes next (that's the Performance Director). It guarantees beat-locked commits, shader pre-warm, smooth crossfades, and emergency hard-cuts when GPU budget is exceeded.

---

## Goals

- Never compile shaders **on the downbeat** — warm-up hides compile cost.
- Crossfade duration tied to **musical time** (~2 beats), not milliseconds.
- Support **hard cuts** for heavy scenes and Ikeda-style impact.
- Layer transitions independent from primary scene transitions.

---

## Responsibilities

- Queue pending scene from `requestScene()`.
- Preload lazy chunk; mount warming instance.
- Commit on downbeat (or timeout if grid untrusted).
- Animate fade weights via `SceneFade` context.
- Enforce heavy-scene overlap budget.
- Apply per-layer blend modes (`BlendedLayer`).

---

## Non-Goals

- Glitch/datamosh transition shaders (planned asset type).
- User-selectable transition per switch (directors pick; future override).
- TouchDesigner transition sync (see [10_TouchDesigner_Integration.md](10_TouchDesigner_Integration.md)).

---

## Architecture

**Owner:** `src/engine/SceneManager.tsx`

```text
requestScene(id)
  → preloadScene(id)
  → mount Entry { dir: 0, warmFrames: 0 }  // warming
  → chunk loaded + WARM_FRAMES rendered → hide (dir 0, fade 0)
  → downbeat → dir 1 incoming, dir -1 outgoing
  → ~2 beat crossfade
  → unmount outgoing
```

Constants: `WARM_FRAMES = 4`

---

## Data Flow

```text
Store.pendingSceneId
  → SceneManager entries[]
  → per-entry fade.value, out.value (fade × layerFx.intensity)
  → SceneFade context
  → scene multiplies visibility
```

---

## Components

| Mechanism | Purpose | Cost |
|-----------|---------|------|
| **Crossfade** | Default primary transition | Medium (two scenes briefly) |
| **Shader warm-up** | Compile before commit | 4 frames visible at request time |
| **Downbeat commit** | Musical alignment | Logic only |
| **Timeout commit** | Untrusted grid fallback | 2.5 s after request |
| **Hard cut** | Both scenes `performanceCost: high` + tight budget | Low (no overlap) |
| **Layer fade** | Accent/overlay independent | Medium |

---

## Interfaces

```typescript
// Context consumed by scenes
const SceneFade = createContext<{ value: number }>({ value: 1 })

// Store
requestScene(id: string, opts?: { auto?: boolean }): void
setLayer(role: 'accent' | 'overlay', id: string | null, opts?: { auto?: boolean }): void
```

---

## Data Models

```typescript
interface TransitionMetadata {
  id: string
  purpose: string
  durationBeats: [number, number]
  cost: 'low' | 'medium' | 'high'
  bestGenres: string[]
  avoidMoods: MoodState[]
}
```

### Transition catalog

#### Crossfade (default)

```yaml
Purpose: Smooth primary scene change
Duration: ~2 beats
Cost: Medium (dual render during overlap)
Best genres: All
Best moods: groove, building, mellow
Don't use: When both scenes are performanceCost high AND maxHeavyLayers < 2
Implementation: SceneManager fade dir ±1
```

#### Hard Cut

```yaml
Purpose: Avoid dual heavy-GPU overlap; Ikeda-style impact
Duration: 0 beats (instant on commit)
Cost: Low
Best genres: Industrial, Techno, Minimal
Best moods: peak, aggressive
Don't use: Ambient breakdowns (too jarring — planned constraint)
Trigger: quality.knobs.maxHeavyLayers budget exceeded
Implementation: SceneManager skips crossfade overlap
```

#### Shader Warm-up

```yaml
Purpose: Hide GPU shader compile stall
Duration: 4 rendered frames after chunk load
Cost: Low-Medium (single frame spike at request, not on beat)
Best genres: N/A (always on)
Implementation: Entry dir=0, visible during warm only
```

#### Layer Additive Blend

```yaml
Purpose: Overlay/accent appearance
Duration: Same crossfade machinery
Cost: Medium
Blend modes: add (default), screen, normal, multiply
Implementation: BlendedLayer traversal
```

#### Downbeat Commit

```yaml
Purpose: Musical alignment of visible switch
Duration: 0–1 beat wait from request
Cost: Logic only
Condition: features.confidence > 0.25
Fallback: 2.5 s timeout commit
```

### Planned transitions (not implemented)

| ID | Purpose | Duration | Notes |
|----|---------|----------|-------|
| glitch | Aggressive genre cuts | 0.5–2 beats | Chromatic + displacement burst |
| dip-to-black | Breakdown breathing room | 1 beat | Fade out/in |
| mirror-flip | Stage symmetry reference | 1 beat | Kaleidoscope post pass |
| beat-strobe | Drop accent | 0.25 beat | White flash — use sparingly |

---

## Algorithms

### Fade advance (per frame)

Crossfade duration ≈ 2 beats — fade rate derived from `beatProgress` delta and current BPM.

```typescript
entry.out.value = entry.fade.value * layerIntensity  // layers only
```

### Heavy overlap guard

```typescript
if (outgoing.cost === 'high' && incoming.cost === 'high'
    && quality.knobs.maxHeavyLayers < 2) {
  // hard cut — skip overlap fade
}
```

### Warm gate

Warm frame counter increments only when `isSceneLoaded(id)` — compile happens after chunk fetch, not during download wait.

---

## State Machines

See [01_System_Architecture.md](01_System_Architecture.md) scene transition state machine.

---

## Update Frequency

SceneManager runs at **−100 priority** every frame. Fade values mutate in refs — no React re-renders.

---

## Performance Constraints

- WARM_FRAMES kept small (4) to limit double-render window.
- Invisible warming scene must cost ~0 after hide (skip sim when fade ≈ 0 — FluidSim pattern).
- Never add/remove PostFX effects during transition (composer rebuild stall).

---

## Failure Modes

| Failure | Behavior |
|---------|----------|
| Slow chunk load | Warm counter waits — commit may delay past first downbeat |
| Grid untrusted | 2.5 s timeout commit |
| Layer normal blend | May occlude — documented in HUD |
| Pending never cleared | Outgoing eventually unmounts after fade complete |

---

## Testing

- Manual scene switch during beat-rich track → lands on downbeat
- Switch to plasma while plasma active → hard cut or single heavy per budget
- Toggle accent layer during primary crossfade → independent fade
- Stop audio mid-crossfade → no crash

---

## Future Improvements

- Transition metadata in Visual Knowledge Base — directors choose transition type.
- **Glitch** and **dip-to-black** shader passes (fixed composer slots).
- Beat-quantized transition length selection (1 vs 2 vs 4 beats).
- Constraint: max 3 dramatic transitions per 60 s ([03_AI_Performance_Director.md](03_AI_Performance_Director.md)).
- Preview transition in editor (offline).

See [specs/transition_engine_spec.md](specs/transition_engine_spec.md).
