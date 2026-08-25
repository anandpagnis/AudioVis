# Document 7 — Palette System

> **Audience:** designers, scene authors, automation engineers.  
> **Status:** 28 built-in palettes; five-slot ramp live alongside the original three-colour contract.  
> **Spec:** [specs/palette_system_spec.md](specs/palette_system_spec.md)

---

## Overview

Palettes define the **color identity** of a performance, with smooth temporal
morphing and mood-driven automatic selection.

There are **two views of the same palette**, and both are live:

- **The three-colour contract** — `primary`, `secondary`, `accent` plus a
  background reference, read as `ctx.col.a/b/c`. This is what the 14 scenes
  written before the ramp existed use, and it is not deprecated.
- **The five-slot ramp** — `bg`, `shadow`, `mid`, `accent`, `glow`, darkest to
  lightest, read as `ctx.col.bg/shadow/mid/accent/glow`.

The ramp exists because three colours plus a background cannot say what a
full-frame scene needs to say. With five semantic slots a scene takes its
*shadow* and its *highlight* **from the palette** instead of inventing them,
which is what makes a scene's colour globally art-directable rather than
hardcoded per shader. A scene whose whole image is a walk up the ramp — see
`InkFieldScene` — is impossible to build without it.

A palette may declare its ramp explicitly (`ramp: [bg, shadow, mid, accent, glow]`),
which is always preferable. When it declares only three colours, `resolveRamp()`
derives the ramp: `mid` and `accent` keep their authored roles, `shadow` is the
background carried 40% toward the primary, and `glow` is **the brightest of the
three** lifted 45% toward white. That last rule is not arbitrary — deriving
`glow` from the secondary inverted the ramp for `mono` (`#ffffff` / `#8fa3ad` /
`#3a4a55`), whose `mid` came out pure white and whose `glow` came out mid grey,
so a scene walking bg→glow got *darker* at the top. `resolveRamp` is memoized
per palette id, because every mounted scene reads it every frame.

A palette declaring a ramp derives its `colors` triple from the three **lit**
slots (`mid`/`accent`/`glow`), never from `bg` — handing a scene a near-black as
its "primary" reads as the scene being broken.

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
| LightRig | `LightRig.tsx` | Palette-colored lights for mesh scenes |

---

## Interfaces

```typescript
type PaletteRamp = [bg: string, shadow: string, mid: string, accent: string, glow: string]
type PaletteGroup = 'classic' | 'bold' | 'earth' | 'rainbow'

interface Palette {
  id: string
  name: string
  colors: [string, string, string]  // primary, secondary, accent
  bg: string
  ramp?: PaletteRamp                // authored five slots; derived when absent
  group?: PaletteGroup              // display-only, for the picker
}

function getPalette(id: string): Palette          // falls back to PALETTES[0]
function registerPalette(palette: Palette): void
function resolveRamp(palette: Palette): PaletteRamp   // memoized per id
function paletteFromImage(img: CanvasImageSource): PaletteRamp | null

const MORPH_SECONDS = 1.8

class PaletteBlender {
  // the three-colour contract
  a: THREE.Color; b: THREE.Color; c: THREE.Color
  // the five-slot ramp
  bg: THREE.Color; shadow: THREE.Color; mid: THREE.Color
  accent: THREE.Color; glow: THREE.Color
  update(palette: Palette, delta: number, speed?: number): void
}
```

Every colour is mutated **in place** and its object identity is stable for the
life of the scene instance, so a scene can bind one straight into a uniform at
material-creation time (`uGlow: { value: col.glow }`) and be recoloured for free
from then on — including part-way through a morph. Never retain a *snapshot*
across frames; `.copy()` it if you need one.

**`PALETTES` is append-only.** A persisted `paletteId`, a shared `#look=` URL, a
preset and a cue can all name a palette by id, so removing or reordering an id
silently degrades someone's saved show.

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

### Temporal morph

Snapshot-and-smoothstep over a fixed `MORPH_SECONDS = 1.8`:

```typescript
if (palette.id !== this.id) this.aim(palette)   // snapshot LIVE colours as `from`
this.progress = Math.min(1, this.progress + delta / MORPH_SECONDS)
const t = this.progress
const e = t * t * (3 - 2 * t)                   // smoothstep
slot.lerpColors(from[i], to[i], e)
```

This replaced an exponential lerp re-aimed at the live target every frame
(`lerp(target, min(1, delta * 2.5))`), which had two defects:

- **It never arrived.** It asymptotes, so the last few percent of a colour change
  took forever and a screenshot mid-set was never the authored colour.
- **Its rate depended on frame time**, so the same change took visibly longer on
  a slow machine.

Interrupting a morph re-snapshots `from` off wherever the colours *actually are*,
so a rapid palette cycle eases continuously instead of jumping back to a start
colour. Once `progress` reaches 1 the loop is skipped entirely, so a settled
palette costs nothing.

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
- **Brightness limits:** clamp max luminance for post-chain headroom.
- **Scene overrides:** accent color slot per scene while keeping global palette.
- **Accessibility presets:** high-contrast mono variants.
