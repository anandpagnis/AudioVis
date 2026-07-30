# Document 6 — Camera Director

> **Audience:** scene authors, cinematography designers.  
> **Status:** per-scene CameraRig implemented; centralized director planned.  
> **Spec:** [specs/camera_director_spec.md](specs/camera_director_spec.md)

---

## Overview

Camera motion in AudioVis is **musically driven** — beats pull the lens, bars sway elevation, section changes can hard-cut angle. Today each scene owns a `CameraRig` instance and calls a mode per frame. The roadmap introduces a **Camera Director** that selects moves from a metadata catalog based on mood and scene.

---

## Goals

- Motion derived from **musical timing**, not wall clock.
- Reusable moves: orbit, hover, cut.
- Section changes feel like **VJ jumps** — intentional, not nauseating.
- Smooth enough for projection; reactive enough for drops.

---

## Responsibilities

| Current | Planned |
|---------|---------|
| Per-scene CameraRig calls | Central Camera Director |
| Beat/bar reactive orbit | Mood-mapped move selection |
| Section-change cut | Transition-aware camera blends |
| lookAt origin/subject | Collision avoidance (simple) |

---

## Non-Goals

- Cinematic keyframe authoring UI (cue system covers look snapshots, not camera paths).
- Physics-based camera collision with scene geometry.
- Multi-camera broadcast switching.

---

## Architecture

```text
CameraRig (src/engine/CameraRig.ts)
  ├── orbit(camera, features, opts)
  ├── hover(camera, features, opts)
  └── cut(delta)

Scene useFrame:
  rig.orbit(camera, audioEngine.features, { radius, elev, speed, react })
```

**Consumers:** Schematic, Wireframe, Plasma, Chrome → `orbit`; Dissolve → `hover`.

---

## Data Flow

```text
AudioFeatures (beat, bar, energy, sectionChange)
  → beatPulse(f) helper
  → CameraRig mode
  → camera.position + lookAt
```

No separate camera state in store today.

---

## Components

### CameraRig.orbit

- Slow orbit around origin (`angle += delta * speed * (1 + energy * 0.6)`).
- Beat pulse pulls camera **in** (radius decreases).
- 2-bar sine sway on elevation.
- `sectionChange` → `cut()` — instant π/2 angle jump.

**Defaults:** radius 13, elev 4.5, elevSwing 1.6, speed 0.05, react 1.

### CameraRig.hover

- Fixed base position with beat/sub bob.
- Used for framed subjects (Dissolve Cage).

**Defaults:** pos [0, 6.5, 26], look [0, 3.5, 0], bob 1.

### CameraRig.cut

- Instant angle offset — VJ-style reframe on section boundary.

---

## Interfaces

```typescript
class CameraRig {
  angle: number
  orbit(camera: THREE.Camera, f: AudioFeatures, opts?: OrbitOpts): void
  hover(camera: THREE.Camera, f: AudioFeatures, opts?: HoverOpts): void
  cut(delta?: number): void
}
```

Planned:

```typescript
interface CameraMetadata {
  id: string
  style: 'orbit' | 'hover' | 'static' | 'dolly'
  moodAffinity: MoodState[]
  energyRange: [number, number]
  performanceCost: 'low' | 'medium'
}
```

---

## Data Models

See planned `CameraMetadata` in [14_Data_Models.md](14_Data_Models.md).

---

## Algorithms

### Beat pulse (shared)

From `AudioEngine.beatPulse(f)` — combines `beatProgress`, `beatStrength`, and tuning subdivision (½×/1×/2×/4×).

### Orbit radius modulation

```typescript
const pulse = beatPulse(f)
const dist = radius - (f.energy * 2.2 + pulse * 1.2) * react
```

### Section cut

On `f.sectionChange` rising edge inside orbit → `this.cut()` — no blend today (hard cut).

---

## State Machines

```text
[orbiting] ──sectionChange──► cut(angle += π/2) ──► [orbiting at new angle]
```

Planned: `[move A] ──phrase boundary──► [blend 2 beats] ──► [move B]`

---

## Update Frequency

60 Hz — inside scene `useFrame`, after audio tick.

---

## Performance Constraints

- Camera math is negligible vs GPU cost.
- Avoid allocating `Vector3` per frame — use scratch or direct `.set()`.

---

## Failure Modes

| Issue | Mitigation |
|-------|------------|
| Disorienting cuts | Future: rate-limit cuts; mood-gated |
| Subject out of frame | Scene-specific lookAt targets |
| react too high on drop | Expose react in scene opts |

---

## Testing

- Visual: section change during orbit → visible angle jump
- Visual: beat pulse → subtle radius breathe
- Compare Dissolve hover vs Plasma orbit feel

---

## Future Improvements

- **Camera metadata catalog** in Visual Knowledge Base.
- **Camera Director** chooses move when scene mounts.
- **Smooth blends** between moves over 2 beats (quaternion slerp).
- **Mood mapping:** ambient → slow wide orbit; peak → tight reactive orbit.
- **Look-at smoothing** — exponential damping on target.
- **Priority system:** cue snapshot overrides director override overrides scene default.

See [15_Implementation_Roadmap.md](15_Implementation_Roadmap.md) Phase 2.
