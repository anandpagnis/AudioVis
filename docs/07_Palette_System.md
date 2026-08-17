# Document 7 — Palette System

> **Audience:** designers, scene authors, automation engineers.  
> **Status:** 6 built-in palettes + mood table + key-aware family selection live.  
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

1. User presses `P`, or AutoPilot's `pickPalette()` fires on a committed mood change or a section
   boundary (see Algorithms).
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
| `pickPalette()` | `AutoPilot.tsx` | Pure picker: mood family × key-family preference × anti-repeat — see Algorithms |
| `keyPaletteTracker` | `src/engine/keyPalette.ts` | Accumulates essentia key/scale votes into a harmonic "family" |
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

### AutoPilot palette nudge — `pickPalette()`

Superseded the earlier "if current palette isn't in the mood's list, jump to the first entry"
rule — that could silently decline to move at all, since the six mood lists overlap heavily (`aurora`
alone sits in `ambient`, `mellow`, `groove`, and `building`). `pickPalette(moodPalettes, current,
keyFamily, lastPick, rotation)` (`src/engine/AutoPilot.tsx`, pure and unit-tested):

1. Filters `moodPalettes` to registered ids, then drops whichever is already showing (`current`) —
   the actual fix for "colours never change," since excluding only entries *absent* from the new
   mood's list left `current` itself still pickable.
2. Also drops `lastPick` when an alternative survives, so three moods with overlapping lists can't
   ping-pong between the same two colours.
3. If the harmonic `keyFamily` (see below) survived both filters, prefer it — key is the harmonic
   anchor, skipped only when it was *just* used.
4. Otherwise a deterministic rotation (`rotation` counter, not `Math.random`, so a recorded set
   repeats) walks the remaining pool.

Two independent triggers call it: a committed mood change (once confidence/ambiguity clear their
thresholds, see `docs/02_Music_Intelligence.md`), and a section boundary
(`f.sectionChange`) even when the mood didn't move — colour marks structure more often than mood
changes, so a verse→chorus boundary can recolour even a same-mood passage. Both are floored by
`PALETTE_MIN_SEC` (10 s) so a burst of boundaries can't strobe the palette. Neither counts as manual
input (`lastManualAt` untouched).

### Key-aware family: `keyPaletteTracker`

`src/engine/keyPalette.ts`. Essentia's raw key read is too jittery to drive a palette directly
(measured 43–65% window-to-window agreement on real tracks) — but most of the disagreement is
musically adjacent (a fifth away, the relative major/minor, the parallel), so `keyFamily()` first
collapses the 24 possible keys onto the 6 palette ids by their position on the circle of fifths
(minor keys resolved through their relative major before lookup). `KeyPaletteTracker` then votes over
a rolling history of those collapsed families and refuses to switch before a minimum dwell has
elapsed — the same shape as `MoodEstimator`'s dwell lock. `.family` is what `pickPalette()` reads.

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
- **Brightness limits:** clamp max luminance for post-chain headroom.
- **Scene overrides:** accent color slot per scene while keeping global palette.
- **Accessibility presets:** high-contrast mono variants.

See [11_Generative_AI.md](11_Generative_AI.md) for AI palette prompts.
