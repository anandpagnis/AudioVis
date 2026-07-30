# Document 3 — AI Performance Director

> **Audience:** automation/AI engineers, creative technologists.  
> **Status:** AutoPilot + PerformanceDirector implemented; unified planner planned.  
> **Spec:** [specs/performance_director_spec.md](specs/performance_director_spec.md)

---

## Overview

The AI Performance Director is the **autonomous show-runner**. It watches musical state and decides what the audience sees: scene, layers, palette, camera (per-scene), and when to transition. Today this is split across **AutoPilot** (mood/drop reactions) and **PerformanceDirector** (phrase/section composition), with **CueTimeline** for authored overrides. The roadmap consolidates these into a single planner with explicit constraints and performance memory.

---

## Goals

- Perform a visual **journey** through a song — not a random scene carousel.
- Transition on **musical phrases** unless an emergency (drop) demands immediate response.
- Respect **manual override** and **authored cues** absolutely.
- Avoid **visual fatigue** through repetition detection (planned).
- Pre-queue transitions so crossfades **land on** musical events.

---

## Responsibilities

Choose (directly or via store actions):

- Primary scene
- Accent and overlay layers
- Palette family
- Transition timing (via SceneManager downbeat commit)
- When to stand down (manual hold, cue governance, silence)

**Not yet centralized:** camera moves (owned per-scene via CameraRig), post FX intensity (audio-reactive in PostFX), generative overlay (mood-gated in GenerativeLayer).

---

## Non-Goals

- LLM reasoning on the hot path (planned for offline preset/scene generation).
- Replacing a human VJ during a authored cue timeline.
- DMX/lighting control (future integration via OSC).

---

## Architecture

```text
MusicState (AudioFeatures + MoodMomentum)
  +
PerformanceMemory (planned — see 12_Performance_Memory.md)
  +
SceneDatabase (SCENES[] + metadata)
  +
PaletteDatabase (PALETTES[] + MOOD_PALETTES table)
  +
CurrentState (Zustand store)
        │
        ▼
┌─────────────────┐     ┌──────────────────────┐
│   AutoPilot     │     │ PerformanceDirector  │
│  mood / drop    │     │ phrase / section     │
│  scene + palette│     │ scene + layers       │
└────────┬────────┘     └──────────┬───────────┘
         │                         │
         └──────────┬──────────────┘
                    ▼
            requestScene / setLayer / setPalette
                    ▼
              SceneManager (downbeat commit)
```

**CueTimeline** sits above both: when `cueState.governed`, directors return immediately.

---

## Data Flow

1. SceneManager ticks audio → fresh `AudioFeatures`.
2. AutoPilot (−90): drop edge → peak/aggressive scene; mood change → mood-fit scene; imminent prediction → prefetch target.
3. CueTimeline (−88): if beat matches cue → apply full look snapshot.
4. PerformanceDirector (−85): on `sectionChange` or 16-beat phrase fallback → rank compatible scenes by mood + dominant band → request primary + optional layer.
5. SceneManager: preload chunk, warm shader, commit on downbeat, crossfade ~2 beats.

---

## Components

| Component | File | Trigger | Action |
|-----------|------|---------|--------|
| AutoPilot | `AutoPilot.tsx` | Drop edge, mood change, imminent prediction | `requestScene`, palette nudge |
| PerformanceDirector | `PerformanceDirector.tsx` | Section change, phrase fallback | Primary + accent/overlay |
| CueTimeline | `CueTimeline.tsx` | Beat index match | Full look apply |
| SceneManager | `SceneManager.tsx` | Pending request | Downbeat commit, fade |

---

## Interfaces

```typescript
// Store actions consumed by directors
requestScene(id: string, opts?: { auto?: boolean }): void
setLayer(role: 'accent' | 'overlay', id: string | null, opts?: { auto?: boolean }): void
setPalette(id: string): void

// Governance
cueState.governed: boolean  // suppresses AutoPilot + PerformanceDirector

// Scene queries
getScenesForMood(mood: MoodState): SceneDef[]
getCompatibleScenes(id: string): SceneDef[]
getAudioResponse(features: AudioFeatures): AudioResponse
```

---

## Data Models

```typescript
interface Decision {
  type: 'scene' | 'layer' | 'palette' | 'cue'
  targetId: string
  reason: 'drop' | 'mood' | 'prediction' | 'section' | 'phrase' | 'cue' | 'manual'
  beatIndex: number
  confidence: number
}

interface PlannerState {
  lastSceneId: string
  lastSwitchBeat: number
  scenesUsedRecently: string[]  // planned
  dramaticTransitionsInWindow: number  // planned
}
```

See [14_Data_Models.md](14_Data_Models.md).

---

## Algorithms

### AutoPilot scene selection

1. Filter `getScenesForMood(target)` excluding current + pending.
2. Take top fit (`moodFit` score); 30% random roll picks 2nd option for variety.
3. `requestScene(id, { auto: true })` — does not update `lastManualAt`.
4. Palette: if current palette not in `MOOD_PALETTES[target]`, pick first matching.

### PerformanceDirector composition

1. Boundary = `sectionChange` OR downbeat where `beatIndex % 16 === 0`.
2. Phrase fallback throttled: min 16 beats since last switch unless real section.
3. Pool = mood-fit scenes ∩ compatible with current primary.
4. Rank by dominant band (sub/bass → bass scenes; high → high scenes; etc.).
5. Primary: pick if no pending; tie-break with `bar % ranked.length`.
6. Layer: if `maxHeavyLayers ≥ 2` or primary not heavy → add accent (calm) or overlay (energetic).

### Drop handling (priority override)

Rising edge of `features.drop` → target mood `peak` or `aggressive` → immediate `requestScene`. SceneManager still commits on downbeat — the **request** is instant, the **visible cut** is beat-locked.

---

## Constraints (AI rules)

These are the target rules for the unified planner. **Bold** = implemented today.

| Rule | Status |
|------|--------|
| **Never interrupt authored cue timeline** | ✅ `cueState.governed` |
| **Manual input suppresses automation for 45 s** | ✅ `lastManualAt` |
| **Scene commits on downbeat when grid trusted** | ✅ SceneManager |
| **Drop triggers immediate scene request** | ✅ AutoPilot |
| Never repeat same scene twice in a row | ⚠️ Partial (random 2nd pick helps) |
| Never perform more than 3 dramatic transitions in 60 s | ❌ Planned |
| Always transition on musical phrases unless emergency | ⚠️ Phrase fallback + section |
| Never interrupt breakdown with heavy visuals | ❌ Planned (energy gate) |
| Avoid visual fatigue | ❌ Planned (Performance Memory) |
| Pre-queue predicted mood within 4 beats | ✅ AutoPilot imminent branch |

---

## State Machines

### Director activation

```text
autoPilot OFF → directors no-op
silence → directors no-op
cueState.governed → directors no-op
lastManualAt within 45s → directors no-op
else → AutoPilot + PerformanceDirector active
```

### Scene request lifecycle

```text
requestScene(id)
  → pendingSceneId set, chunk preload
  → mount warming (dir=0), compile WARM_FRAMES
  → wait downbeat (or timeout)
  → crossfade ~2 beats
  → sceneId = pending, pending cleared
```

---

## Update Frequency

| Director | Eval rate | Action rate |
|----------|-----------|-------------|
| AutoPilot | 60 Hz | Event-driven (mood/drop) |
| PerformanceDirector | 60 Hz | Section + ≤1 per 16 beats fallback |
| CueTimeline | 60 Hz | Per cue beat anchor |

Natural rate limiter: **downbeat commit** prevents strobing.

---

## Performance Constraints

- Directors must not allocate per frame.
- Layer composition respects `quality.knobs.maxHeavyLayers` — skip overlay when primary is heavy and budget tight.
- `preloadScene()` on request — chunk download overlaps warm window.

---

## Failure Modes

| Failure | Behavior |
|---------|----------|
| No mood-fit scenes | No-op |
| Pending scene never loads | Warm gate waits for chunk; timeout commit still applies |
| Auto + manual fight | Manual hold wins 45 s |
| Cue references unregistered scene | Import sanitizer drops cue silently |

---

## Testing

- Enable AutoPilot on track with clear sections → verify scene changes on downbeats
- Trigger drop → verify scene request before next downbeat
- Capture cues → verify directors stand down during playback
- Manual scene change → verify 45 s automation backoff

---

## Future Improvements

- **Unified Planner module** merging AutoPilot + PerformanceDirector with explicit `Decision` log.
- **Performance Memory** — repetition detection, dramatic transition budget, narrative arcs ([12_Performance_Memory.md](12_Performance_Memory.md)).
- **Genre-aware weighting** from off-thread ONNX.
- **LLM offline** — generate cue timelines from track analysis export.
- **Constraint engine** — declarative rules file editable by non-engineers.

See [15_Implementation_Roadmap.md](15_Implementation_Roadmap.md) Phase 4.
