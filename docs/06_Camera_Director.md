# Document 6 — Camera Director

> **Audience:** scene authors, cinematography designers.
> **Status:** centralized director implemented; scenes no longer own the camera.
> **Spec:** [specs/camera_director_spec.md](specs/camera_director_spec.md)

---

## Overview

Camera motion is **musically driven** — beats pull the lens, bars sway elevation, section changes can cut the angle — and it is owned by exactly one system.

Previously each scene instantiated its own `CameraRig` and moved the camera from inside its `useFrame`. That welded camera behaviour to geometry: you could not view the wireframe hero from a spiral, or reuse "slow push" elsewhere, without editing the scene. Worse, during a crossfade two mounted scenes both tried to drive the camera, which needed a `fade.value >= lastFade` guard in every single scene to arbitrate.

Now a scene declares only **where it can be looked at** (a `cameraAnchor`) and **which modes suit it** (`cameraModes`). `CameraDirector` decides how. One writer, so the crossfade arbitration problem disappears entirely rather than being managed.

---

## Goals

- Motion derived from **musical timing**, not wall clock.
- **Any mode on any scene** — camera behaviour is reusable content, not scene code.
- Section changes feel like **VJ jumps** — intentional, not nauseating.
- Mode and scene changes **ease**, never teleport.

---

## Responsibilities

| Owner | Responsibility |
|---|---|
| Scene | Declares `cameraAnchor` (subject centre, distance, height) and suitable `cameraModes` |
| CameraDirector | All camera position/orientation, mode easing, musical reactivity |
| PerformanceState | Which mode is active (`cameraMode`) |

---

## Non-Goals

- Cinematic keyframe authoring UI (the cue system snapshots looks, not camera paths).
- Physics-based collision with scene geometry.
- Multi-camera broadcast switching.

---

## Architecture

```text
Scene metadata
  ├── cameraAnchor: { target, distance, height }
  └── cameraModes: CameraMode[]        // the modes the director may choose from

performanceState.cameraMode ──┐
performanceState.activeScene ─┴─► CameraDirector (−80)
                                    → computeDesired(mode, anchor, …)
                                    → camera.position.lerp(desired)
                                    → camera.lookAt(anchor.target)
```

**Location:** `src/engine/CameraDirector.tsx`

Two details that matter:

- The director follows `activeScene` (committed and visible), **not** `scene` (requested). Using the requested scene would swing the lens to the next scene's framing while the current one is still on screen.
- A scene with **no** `cameraAnchor` is left completely alone. That opt-in switch is what allowed the migration to happen one scene at a time, and it is still the escape hatch for a scene that genuinely needs bespoke camera work.

---

## Data Flow

```text
AudioFeatures (beat, bar, energy, sectionChange, percussion.kick)
  + performanceState.cameraMode
  + active scene's cameraAnchor
      → computeDesired() → desired position + lookAt
      → eased lerp onto the shared camera
```

---

## Components — the mode catalog

Every mode is expressed **relative to the anchor**, which is what makes it work on any scene.

| Mode | Behaviour |
|---|---|
| `orbit` | Slow orbit; beats pull in, 2-bar sine sway on elevation |
| `hover` | Fixed framing with a subwoofer dip on beats |
| `push` | Slow continuous approach, resets on section boundaries |
| `pull` | Slow retreat, resets on section boundaries |
| `spiral` | Orbit with oscillating radius and height |
| `handheld` | Two out-of-phase sine stacks read as a human operator; kick adds a small kick |
| `locked` | Static framing, no motion |
| `topdown` | High angle looking down, slow rotation |
| `cinematic` | Long lazy arc with an eased dolly — deliberately slower than orbit |

### Mode selection: `pickCameraMode()`

Which mode plays is a **decision**, re-taken at section boundaries and on scene change (never per
frame — the camera eases toward its target, so the target has to hold still). Ranked in priority
order:

1. **Tension override.** Above `TENSION_THRESHOLD` (and the mood isn't `peak`/`aggressive` — tension
   peaks on the drop that *releases* a build, and overriding there shoots the release exactly like
   the build), `push`/`spiral` are promoted to the front of the preference list.
2. **Voice override**, only when tension didn't already win. Once essentia's `vocalPresence`, eased
   into `voiceFocus` (`PerformanceStateBridge`), clears `VOICE_FOCUS_THRESHOLD` (0.5), `locked`/`push`
   are promoted — a voice is the human element in a track, and closing distance is how film shoots
   one. Orbiting modes are excluded (circling a singer reads as restless) and `handheld` stays out for
   the same calm-mood invariant tension uses.
3. Otherwise, the mood's declared preference order (`MODE_PREFERENCE[mood]`), filtered to the modes
   the active scene actually declares (`declared[0]` if nothing in the ranked list is available).

**Location:** `src/engine/CameraDirector.tsx`, called from `PerformanceStateBridge`. A test asserts
every declared mode across every registered scene is reachable, so a mode can't silently regress to
unused code again (see `docs/HANDOFF.md` §2 item 18).

### Anchors in use

All 11 scenes anchor at the world origin (`target: [0, 0, 0]`); only distance/height and the declared
mode set vary, so the table below drops the redundant target column. `Schematic` (formerly `[0, 0.3,
0]` / 9 / 1.1, `hover`) was removed from the roster — see `docs/HANDOFF.md` §2 item 17.

| Scene | distance / height | Declared modes |
|---|---|---|
| Wireframe Hero | 9.5 / 1.6 | `orbit`, `cinematic`, `spiral`, `hover`, `push` |
| Plasma Filament | 17 / 2.4 | `orbit`, `spiral`, `handheld`, `cinematic` |
| Dissolve Cage | 11.5 / 1.1 | `hover`, `push`, `cinematic`, `locked` |
| Chrome Form | 8.2 / 1.2 | `orbit`, `cinematic`, `spiral`, `topdown`, `pull` |
| Flow Ribbons | 10 / 1.4 | `cinematic`, `spiral`, `orbit`, `handheld`, `pull` |
| Network Constellation | 14 / 1.5 | `orbit`, `spiral`, `cinematic`, `handheld`, `hover` |
| PCD LIDAR Scan | 11 / 1.4 | `orbit`, `cinematic`, `spiral`, `handheld`, `push` |
| Inversion Machine | 1.4 / 0.15 | `orbit`, `push`, `hover`, `handheld`, `cinematic` |
| Fold Path | 10 / 1.5 | `orbit`, `spiral`, `cinematic`, `handheld`, `hover` |
| Torus Fold | 3.3 / 0 | `orbit`, `push`, `hover`, `handheld`, `cinematic` |
| Julia Wings | 10 / 1.5 | `orbit`, `spiral`, `cinematic`, `handheld`, `hover` |

These reproduce the framing each scene was authored with; the original 5 scenes' equivalence to their
pre-refactor camera code is pinned by tests (see Testing) — the 6 newer scenes were authored directly
against `cameraAnchor`/`cameraModes` and have no pre-refactor baseline to pin against.

---

## Interfaces

```typescript
interface CameraAnchor {
  target: [number, number, number]  // subject centre in world space
  distance: number                  // comfortable viewing distance
  height: number                    // nominal eye height above target
}

type CameraMode =
  | 'orbit' | 'hover' | 'push' | 'pull' | 'spiral'
  | 'handheld' | 'locked' | 'topdown' | 'cinematic'

// In SceneMetadata — both optional; omitting cameraAnchor keeps the scene
// in charge of its own camera.
cameraAnchor?: CameraAnchor
cameraModes?: CameraMode[]

// Escape hatch for a VJ-style reframe.
export function cutCamera(delta?: number): void
```

---

## Algorithms

### Frame-rate-independent easing

`approach(current, target, rate, delta)` from `performanceState.ts` — used for distance and height so a mode switch eases instead of snapping. Position itself is lerped toward `desired` each frame, which is what makes even a hard mode change land smoothly.

### Beat reactivity (shared by all modes)

```typescript
const pull = (f.energy * 0.14 + pulse * 0.08) * anchor.distance
const baseDist = anchor.distance - pull
```

Distance scales with the anchor rather than using absolute units, so the same reactivity reads correctly on a scene framed at 8 units and one framed at 17.

---

## Update Frequency

60 Hz at priority **−80** — after the decide band has settled `cameraMode`, before scenes render.

---

## Performance Constraints

- Camera math is negligible next to GPU cost.
- The path **allocates nothing**: `desired` / `lookAt` are module-level scratch vectors.

---

## Failure Modes

| Issue | Mitigation |
|---|---|
| Disorienting cuts | Position lerp smooths even abrupt mode changes |
| Subject out of frame | Modes are anchor-relative; `lookAt` always targets the declared subject |
| Scene with no anchor | Director skips it entirely — the scene keeps its own camera |
| Mode/anchor combination produces NaN | Covered by a test across every registered scene × declared mode |

---

## Testing

`src/engine/__tests__/CameraDirector.test.ts` — pure math, no browser needed (it drives `computeDesired` directly with a synthetic `AudioFeatures`):

- Framing equivalence: `hover` on Schematic's anchor still resolves to `(0, 1.4, 9)`, the exact position the scene used pre-refactor; orbit radii still match 9.5 / 17 / 8.2.
- `lookAt` tracks an off-origin subject, and orbit orbits *the subject*, not the world origin.
- `push` converges nearer, `pull` further; `topdown` sits above the subject.
- Every registered scene × every mode it declares produces finite coordinates — the guard on the swap-any-camera-onto-any-scene promise.

Still visual-only: whether a given mode actually *feels* right on a given scene with real music.

---

## Future Improvements

- **Implemented since the table above was first written:** `pickCameraMode()` now ranks by mood,
  dramatic tension, *and* essentia's voice signal against a shared preference table (see "Mode
  selection" above) — kept here as a dated pointer so this section doesn't silently regress into a
  duplicate of Overview.
- **Per-scene mode weighting:** a scene still cannot say "orbit suits me better than it suits the
  others", only whether a mode is allowed at all — the ranking itself is shared across every scene
  that declares a mode.
- **Blends between modes** over N beats rather than a position lerp.
- **Look-at damping** for handheld/spiral at high energy.
- **Cue-authored camera:** priority order cue > director > scene default.

See [HANDOFF.md](HANDOFF.md) §7.
