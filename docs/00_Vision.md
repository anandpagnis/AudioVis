# Document 0 — Vision

> **Audience:** product, creative direction, investors — not implementation detail.  
> **Status:** current as of July 2026.  
> **See also:** [01_System_Architecture.md](01_System_Architecture.md), [specs/](specs/)

---

## Overview

AudioVis is an **AI VJ agent**: a browser-based performance engine that listens to live music and performs a deliberate visual journey through it — not a volume-reactive screensaver.

The long-term product is a **modular visual instrument** that DJs, bands, venues, and streamers can run as an OBS source, fullscreen installation, or live stage rig. It interprets musical structure (tempo, mood, sections, drops) and composes scenes, cameras, palettes, and overlays in real time — with optional human override at every layer.

---

## Goals

- **Musical intelligence first.** Visuals lock to beats, phrases, and sections — not just RMS.
- **Crystal-cut clarity.** Hard edges, readable subjects, brutal contrast, real negative space.
- **Buttery smooth above all.** Frame-time variance matters more than visual ambition. A simpler look at rock-solid 60 fps beats a richer look that hitches.
- **Autonomous performance.** The app can direct an entire set without a human touching controls.
- **Human-in-the-loop.** Manual scene, palette, layer, and cue control always wins — with sensible backoff for automation.
- **Extensible platform.** Scenes, palettes, and future plugins register with metadata and immediately participate in mood selection and composition.

---

## Responsibilities

This document defines **why the product exists** and **what it should feel like**. It does not specify algorithms, APIs, or file layout.

---

## Non-Goals

- Replacing a full DAW or lighting desk.
- Source-separated vocal analysis in v1 (frequency-band estimate only).
- Offline pre-rendered video playback as the primary visual medium.
- A custom WebGL2 renderer (considered and rejected — see [09_Rendering_Engine.md](09_Rendering_Engine.md)).

---

## Architecture

N/A — see [01_System_Architecture.md](01_System_Architecture.md).

---

## Data Flow

N/A.

---

## Components

N/A.

---

## Interfaces

N/A.

---

## Data Models

N/A.

---

## Algorithms

N/A.

---

## State Machines

N/A.

---

## Update Frequency

N/A.

---

## Performance Constraints

**Smoothness is the top constraint.** Every visual decision is subordinate to stable frame timing. See [09_Rendering_Engine.md](09_Rendering_Engine.md) for the Quality Governor.

---

## Failure Modes

N/A at vision level.

---

## Testing

N/A at vision level.

---

## Future Improvements

N/A at vision level — see [15_Implementation_Roadmap.md](15_Implementation_Roadmap.md).

---

## Why does this exist?

Live music deserves visuals that **understand the song**, not visuals that merely **react to loudness**.

Most VJ tools are either:

1. **Manual decks** (Resolume, Modul8) — powerful but require a skilled operator for every transition, and the show dies when the operator looks away.
2. **Shader toys** (Shadertoy, generic visualizers) — pretty but musically blind; they loop the same motion regardless of verse, chorus, or breakdown.
3. **Pre-rendered loops** — safe but repetitive; they cannot adapt to an unexpected DJ set or a live band's tempo drift.

AudioVis exists to close that gap: **autonomous musical performance** with **production-grade visual craft**.

---

## What problem are we solving?

| Pain | Today | AudioVis target |
|------|-------|-----------------|
| Transitions feel random | Volume spikes trigger effects | Beat-locked, phrase-aware scene commits |
| Visual fatigue | Same loop for 6 minutes | Mood-driven variety with repetition guards |
| Operator burden | One person must VJ every set | AutoPilot + PerformanceDirector run the show |
| Quality vs performance | Heavy shaders hitch on the beat | Quality Governor + shader pre-warm |
| No narrative | Scenes are interchangeable | Section detection, drops, build-ups drive chapters |

---

## Why is this better than Resolume?

Resolume is the industry standard for **manual** clip triggering. It excels when a skilled VJ knows the set list.

AudioVis targets a different job:

- **Interprets audio structure automatically** — BPM, beat grid, mood, sections, drops — without MIDI clip markers.
- **Composes multi-layer looks** — primary + accent + overlay — from scene metadata, not clip slots.
- **Runs in a browser** — no Windows-only dependency; OBS browser source in one URL.
- **Built-in musical memory** (roadmap) — fatigue detection, narrative arcs, performance history.

Resolume wins on clip libraries, DMX output, and pro I/O. AudioVis wins on **autonomous musical storytelling** and **zero-install deployment**.

Resolume + AudioVis is complementary: AudioVis as the generative brain, Resolume as the output router.

---

## Why is this better than TouchDesigner?

TouchDesigner is the most powerful real-time visual programming environment — and the steepest learning curve in the industry.

AudioVis is not trying to replace TD's node graph. It offers:

- **Opinionated defaults** — scenes, palettes, transitions, and directors work out of the box.
- **Musical contract built-in** — `AudioFeatures` is the universal input; no wiring FFT to every parameter.
- **Web-first deployment** — share a URL, run in OBS, no license dongle.
- **Pluggable renderer path** (roadmap) — OSC/MIDI/WebSocket bridge to TD/Notch for venue-scale output while keeping the AI director in AudioVis.

TouchDesigner wins on bespoke installations, GPU compute, and hardware I/O. AudioVis wins on **time-to-first-show** and **autonomous direction**.

See [10_TouchDesigner_Integration.md](10_TouchDesigner_Integration.md).

---

## What does the user experience feel like?

### Starting a session

1. Open the app. Pick a source: **system/tab audio**, **microphone/line-in**, or **local audio file**.
2. Fullscreen. The default scene (`Wireframe Hero`, `SCENES[0]`) breathes on idle motion even in silence.
3. Music starts. BPM locks within a few bars. The tactical HUD (`J`) shows mood, beat sync, and diagnostics.

### During a track

- **Quiet intro:** mellow scene, ocean/aurora palette, room to breathe. Negative space dominates.
- **Groove establishes:** wireframe hard-line look; mids drive hue and stroke weight; presence thickens lines.
- **Build:** PerformanceDirector queues an accent layer; energy rises; palette shifts warm (solar/ember).
- **Drop:** AutoPilot fires on the rising edge; scene cuts on the downbeat; plasma or chrome for peak energy; bass drives mass, transients flash.
- **Breakdown:** heavy visuals stand down; dissolve or chrome at lower intensity; automation respects the energy drop.

### Manual override

- `1`–`5` request scenes (committed on next downbeat, ~2-beat crossfade).
- `A` toggles AutoPilot. Touch any control → 45 s automation backoff.
- `C` captures a performance cue — full look anchored to current beat.
- `B` opens presets, layers, blend modes, and cue timeline.

### OBS / venue mode

```
http://localhost:5183/?scene=wireframe&palette=ember&ui=hidden&quality=low&autopilot=1
```

Chromeless, URL-configured, long-cacheable vendor chunks. Projector rig runs the same build as the dev preview.

---

## Visual north star

Derived from user reference images (July 2026). One consistent language:

| Reference | Contribution |
|-----------|--------------|
| Ghost in the Shell schematic | Hard line-art precision; annotation as composition |
| Red/cyan plasma filaments | Fine grain, chromatic fringing, particulate substance |
| Monochrome stage projection | Mirror symmetry, extreme contrast, Ikeda-scale restraint |
| Chrome figure above DJ | One readable hero subject, specular, not abstract soup |
| Wireframe cube + dissolving figure | Geometric frame + organic content |
| *Fallen Angels* poster | Filmic degradation — grain, scanlines, saturated grade |

### Unifying principle

> **Hard-edged precise structure + organic particulate substance + filmic degradation, at brutal contrast.**

Every look needs three things the old app lacked: a **subject**, **negative space**, and **crisp edges somewhere in frame**.

### Non-negotiables (user words)

- "**Crystal cut, perfect clear, artistic**"
- "**Buttery smooth is the most important** — not choppiness"
- Seamless visuals locked to the beat

---

## Current roster philosophy

Eleven registered scenes — not seventeen decent ones. Each holds a subject, negative space, and hard edges:

| Scene | Essence |
|-------|---------|
| Wireframe Hero | True edge geometry, LineMaterial thickness — `SCENES[0]`, the fallback |
| Plasma Filament | 70k curl-noise particles, hot core on black |
| Dissolve Cage | Particles scatter/reform inside wireframe cage |
| Chrome Form | PMREM IBL on MeshPhysicalMaterial hero |
| Flow Ribbons | Vertex-shader strips tracing the synth waveform |
| Network Constellation | Fullscreen-quad jittered node web |
| PCD LIDAR Scan | 60k-point deterministic procedural cloud |
| Inversion Machine | Raymarched sphere-inversion fractal |
| Fold Path | Heightfield flythrough, IFS-fold fractal |
| Torus Fold | Mandelbox-style fractal ∩ torus |
| Julia Wings | 2D Julia-set, moth/butterfly-wing symmetry |

`Schematic` and `Liquid Form` were both cut from the roster (`docs/HANDOFF.md` §2 item 17); unlike
the original 17-scene cull, cut scenes are deleted outright rather than left unregistered on disk —
see item 13 in the same doc.

---

## Document map

| Doc | Topic |
|-----|-------|
| [01](01_System_Architecture.md) | Subsystem map |
| [02](02_Music_Intelligence.md) | Audio analysis |
| [03](03_AI_Performance_Director.md) | Autonomous composition |
| [04](04_Visual_Knowledge_Base.md) | Scene/palette metadata |
| [05](05_Scene_Architecture.md) | Scene contract |
| [06](06_Camera_Director.md) | Camera motion |
| [07](07_Palette_System.md) | Color system |
| [08](08_Transition_Engine.md) | How looks change |
| [09](09_Rendering_Engine.md) | GPU, quality, post, the crystal-cut aesthetic |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Extension guide: registering scenes/palettes/inputs |
| [HANDOFF.md](HANDOFF.md) | Implementation status, verification checklist, prioritized roadmap |
