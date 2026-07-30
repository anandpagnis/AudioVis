# Document 7 — Palette System

> **Audience:** designers, scene authors, automation engineers.  
> **Status:** 6 built-in palettes + mood table live.  
> **Spec:** [specs/palette_system_spec.md](specs/palette_system_spec.md)

---

## Overview

Palettes define the **color identity** of a performance. AudioVis uses a three-color system (primary, secondary, accent) plus a background reference, with smooth temporal blending and mood-driven automatic selection.

---

## Goals

- Instant palette switches feel like **weather changes**, not hard snaps.
- AutoPilot nudges palette to match mood without counting as manual input.
- Scenes read blended colors every frame — no per-scene palette logic duplication.
- Extension point for community and AI-generated palettes.

---

## Responsibilities

- Store palette definitions (id, name, hex colors, bg).
- Blend active palette toward target over time (`PaletteBlender`).
- Map moods to palette families (`MOOD_PALETTES` in AutoPilot).
- Persist selected palette in store + presets + share URLs.

---

## Non-Goals

- Per-scene independent palettes (one global palette at a time).
- HDR/wide-gamut color management (sRGB assumed).
- Accessibility WCAG audit automation (manual contrast discipline).

---

## Architecture

```text
PALETTES[] ──► getPalette(store.paletteId)
                    │
                    ▼
              PaletteBlender.update(target, delta)
                    │
        ┌───────────┼───────────┐
        ▼           ▼           ▼
     scenes    LightRig   TacticalHUD
                    │
              GenerativeLayer (prompt words)
```

---

## Data Flow

1. User presses `P` or AutoPilot selects mood family palette.
2. Store updates `paletteId`.
3. Each scene's `PaletteBlender` lerps `.a/.b/.c` THREE.Color toward target.
4. Shaders/materials read blended colors as uniforms.

---

## Components

| Component | File | Role |
|-----------|------|------|
| Palette definitions | `palettes.ts` | Static catalog + `registerPalette()` |
| PaletteBlender | `palettes.ts` | Temporal color ease |
| MOOD_PALETTES | `AutoPilot.tsx` | Mood → palette id list |
| PALETTE_WORDS | `textureGenerator.ts` | AI prompt color vocabulary |
| LightRig | `LightRig.tsx` | Palette-colored lights for mesh scenes |

---

## Interfaces

```typescript
interface Palette {
  id: string
  name: string
  colors: [string, string, string]  // primary, secondary, accent
  bg: string
}

function getPalette(id: string): Palette
function registerPalette(palette: Palette): void

class PaletteBlender {
  a: THREE.Color
  b: THREE.Color
  c: THREE.Color
  update(palette: Palette, delta: number, speed?: number): void
}
```

---

## Data Models

### Built-in palettes

| ID | Primary | Secondary | Accent | BG | Character |
|----|---------|-----------|--------|-----|-----------|
| aurora | #00e5ff | #7c4dff | #00ffa3 | #020208 | Cool electronic |
| ember | #ff6d00 | #ff1744 | #ffd54f | #0a0302 | Hot peak |
| violet | #b388ff | #ff80ab | #8c9eff | #05020a | Dreamy |
| ocean | #00b0ff | #00e5ff | #304ffe | #010409 | Deep calm |
| mono | #ffffff | #8fa3ad | #3a4a55 | #000000 | Ikeda minimal |
| solar | #ffd600 | #ff3d00 | #ff9e80 | #080401 | Building energy |

### Mood → palette mapping (AutoPilot)

| Mood | Palettes |
|------|----------|
| silence | (none) |
| ambient | ocean, aurora, mono |
| mellow | aurora, violet, ocean |
| groove | aurora, violet, solar |
| building | solar, aurora, ember |
| peak | ember, solar, violet |
| aggressive | ember, solar, mono |

---

## Algorithms

### Temporal blend

```typescript
const k = Math.min(1, delta * speed)  // default speed 2.5
this.a.lerp(targetA, k)
```

~1.5 s perceptual sweep at 60 fps.

### AutoPilot palette nudge

If current `paletteId` not in `MOOD_PALETTES[targetMood]`, set to first entry. Does **not** update `lastManualAt`.

---

## State Machines

N/A — palette is stateless definition + store id + blender positions.

---

## Update Frequency

- Blender: 60 Hz per scene instance.
- AutoPilot palette change: event-driven on mood/drop.

---

## Performance Constraints

- Three `THREE.Color` lerps per scene — negligible.
- Avoid creating new Color objects per frame.

---

## Failure Modes

| Issue | Mitigation |
|-------|------------|
| Unknown palette id | `getPalette` falls back to `PALETTES[0]` |
| Flash on register | Blender initializes from first palette at mount |

---

## Testing

- Cycle `P` during playback — smooth color sweep
- AutoPilot mood change — palette shifts to mood family
- Share URL with `palette=ember` — restores correctly

---

## Future Improvements

- **Palette metadata:** temperature, saturation, genre tags, energy range.
- **Mood-adaptive derivation:** shift hue ±15° from base palette without full swap.
- **AI palette generation** (Phase 8 roadmap) — LLM or clustering from reference images.
- **Brightness limits:** clamp max luminance for PostFX headroom.
- **Scene overrides:** accent color slot per scene while keeping global palette.
- **Accessibility presets:** high-contrast mono variants.

See [11_Generative_AI.md](11_Generative_AI.md) for AI palette prompts.
