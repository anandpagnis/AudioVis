import * as THREE from 'three'

/**
 * A palette's five semantic slots, darkest → lightest.
 *
 * This is the lilim vocabulary, adopted wholesale because three colours plus a
 * background cannot say what a scene needs to say. With five slots a scene
 * takes its *shadow* and its *highlight* from the palette instead of inventing
 * them — which is the whole reason a scene's colour can be art-directed
 * globally rather than hardcoded per shader.
 *
 * The ordering is load-bearing, not cosmetic:
 *   bg      near-black ground the frame sits on
 *   shadow  dark tint — where a form falls away
 *   mid     the main body colour
 *   accent  the contrast note; kicks and highlights change hue here, not level
 *   glow    brightest slot — specular hits, bloom seeds
 */
export type PaletteRamp = [
  bg: string,
  shadow: string,
  mid: string,
  accent: string,
  glow: string,
]

/** Display-only grouping for the palette picker. */
export type PaletteGroup = 'classic' | 'bold' | 'earth' | 'rainbow'

export interface Palette {
  id: string
  name: string
  /**
   * Primary, secondary, accent — the original three-colour contract.
   *
   * Still authoritative for the 14 scenes that read `ctx.col.a/b/c`. For a
   * palette that declares a `ramp`, this is derived from it (mid/accent/glow)
   * so those scenes keep working without knowing about the five-slot system.
   */
  colors: [string, string, string]
  bg: string
  /**
   * Authored five-slot ramp. When absent it is derived from `colors` + `bg` by
   * {@link resolveRamp}, so a three-colour palette — including a third-party
   * one registered through {@link registerPalette} — still drives five-slot
   * scenes correctly. Declaring it explicitly is strictly better: derivation
   * has to guess a shadow and a glow that an author would have chosen.
   */
  ramp?: PaletteRamp
  group?: PaletteGroup
}

/** Build a `Palette` from an authored five-slot ramp. */
function fromRamp(id: string, name: string, ramp: PaletteRamp, group: PaletteGroup): Palette {
  return {
    id,
    name,
    // The three lit slots are what a three-colour consumer wants; bg/shadow are
    // ground, and handing a scene a near-black as its "primary" reads as broken.
    colors: [ramp[2], ramp[3], ramp[4]],
    bg: ramp[0],
    ramp,
    group,
  }
}

/**
 * The palette catalogue.
 *
 * **Append-only.** A persisted `paletteId`, a shared `#look=` URL, a preset and
 * a cue can all name a palette by id, so an id that disappears silently
 * degrades someone's saved show to the fallback. Add at the end; never reorder
 * or rename an id.
 *
 * The first six are the original three-colour palettes, kept because
 * `MOOD_PALETTES` in AutoPilot, `keyPalette.ts`'s key→family table, and every
 * preset written before the five-slot system reference these ids. They get
 * derived ramps.
 *
 * The rest are lilim's authored five-slot palettes. Two of its 24 (`aurora`,
 * `ember`) are omitted: those ids were already taken by the originals above,
 * which cover the same cool-electronic and hot territory. Nothing else collided.
 */
export const PALETTES: Palette[] = [
  { id: 'aurora', name: 'Aurora', colors: ['#00e5ff', '#7c4dff', '#00ffa3'], bg: '#020208' },
  { id: 'ember', name: 'Ember', colors: ['#ff6d00', '#ff1744', '#ffd54f'], bg: '#0a0302' },
  { id: 'violet', name: 'Violet Haze', colors: ['#b388ff', '#ff80ab', '#8c9eff'], bg: '#05020a' },
  { id: 'ocean', name: 'Deep Ocean', colors: ['#00b0ff', '#00e5ff', '#304ffe'], bg: '#010409' },
  { id: 'mono', name: 'Monolith', colors: ['#ffffff', '#8fa3ad', '#3a4a55'], bg: '#000000' },
  { id: 'solar', name: 'Solar Flare', colors: ['#ffd600', '#ff3d00', '#ff9e80'], bg: '#080401' },

  // ---- lilim, group: classic ----
  fromRamp('nocturne', 'Nocturne', ['#05030a', '#140a2e', '#7b3ff2', '#2fd6a8', '#ffb46b'], 'classic'),
  fromRamp('glacial', 'Glacial', ['#030608', '#0a1c2e', '#2f6d9e', '#6fd0e0', '#eafcff'], 'classic'),
  fromRamp('orchid', 'Orchid', ['#0a0308', '#250a26', '#b03fa0', '#f27ab5', '#ffd9a8'], 'classic'),
  fromRamp('moss', 'Moss', ['#040703', '#14260f', '#4f8f3a', '#b5d96b', '#f4ffd6'], 'classic'),
  fromRamp('sodium', 'Sodium', ['#060504', '#221a08', '#a87b1c', '#ffc93c', '#fff3d0'], 'classic'),
  fromRamp('pearl', 'Pearl', ['#060607', '#1c1c22', '#8a8a9e', '#cfcfe0', '#ffffff'], 'classic'),

  // ---- lilim, group: bold ----
  // mid, accent and glow sit in different hue families, so kicks and highlights
  // change colour rather than only level.
  fromRamp('cobalt', 'Cobalt', ['#020410', '#0c2058', '#3f6fe0', '#ff9432', '#fff0d8'], 'bold'),
  fromRamp('reef', 'Reef', ['#020707', '#083038', '#1fae9e', '#ff7a5c', '#ffe9c4'], 'bold'),
  fromRamp('vapor', 'Vapor', ['#050310', '#231043', '#e04fd0', '#3fd6ff', '#ffe0f4'], 'bold'),
  fromRamp('oxide', 'Oxide', ['#050303', '#291109', '#b5532a', '#3fc4a4', '#ffdfae'], 'bold'),
  fromRamp('velvet', 'Velvet', ['#070312', '#260a44', '#7a3fd6', '#ffcf4a', '#ffefc0'], 'bold'),
  fromRamp('acid', 'Acid', ['#030503', '#132808', '#7fe03f', '#e03fb0', '#f4ffd0'], 'bold'),
  fromRamp('neon', 'Neon', ['#04030a', '#1c0f2e', '#ff3f6e', '#2fd6ff', '#fff0b0'], 'bold'),
  fromRamp('mirage', 'Mirage', ['#060408', '#1c1440', '#e05a8c', '#ffb35c', '#fff2d8'], 'bold'),

  // ---- lilim, group: earth ----
  // Quiet materials with one contrast note, so accents read as a change of
  // material rather than a colour pop.
  fromRamp('canyon', 'Canyon', ['#050302', '#26120a', '#b0602f', '#8fc9a8', '#ffe2b8'], 'earth'),
  fromRamp('adobe', 'Adobe', ['#060302', '#2c1410', '#c96f4a', '#7f9eb0', '#ffe8cc'], 'earth'),
  fromRamp('sage', 'Sage', ['#040504', '#1c2010', '#7f8f5a', '#d9b070', '#f7f0dc'], 'earth'),
  fromRamp('umber', 'Umber', ['#050403', '#201207', '#7a4a22', '#d49a3f', '#f4e4c4'], 'earth'),

  // ---- lilim, group: rainbow ----
  // The four lit slots span distant hue families, so a scene that sweeps the
  // ramp pulls a full spectrum out of five slots.
  fromRamp('prism', 'Prism', ['#030309', '#2c0a54', '#1f8fe0', '#ff5a3c', '#ffe94a'], 'rainbow'),
  fromRamp('carnival', 'Carnival', ['#060306', '#30104a', '#24c46a', '#ff4f7e', '#ffd94a'], 'rainbow'),
  fromRamp('candy', 'Candy', ['#070409', '#3c1450', '#ff6fc4', '#4fd6ff', '#fff29e'], 'rainbow'),
  fromRamp('tropic', 'Tropic', ['#030503', '#0c3020', '#2fd66f', '#ff5a8c', '#ffe27a'], 'rainbow'),
]

/**
 * Look up a palette by id, falling back to the first one. Like {@link getScene},
 * the fallback matters: a persisted or shared `paletteId` may name a palette that
 * no longer exists, and scenes read this every frame — it must never throw.
 */
export function getPalette(id: string): Palette {
  return PALETTES.find((p) => p.id === id) ?? PALETTES[0]
}

/**
 * Extension point: add a palette from outside the core bundle. Intentionally has
 * no in-repo callers — public API documented in README.md / ARCHITECTURE.md.
 */
export function registerPalette(palette: Palette) {
  if (!PALETTES.some((p) => p.id === palette.id)) PALETTES.push(palette)
}

const rampCache = new Map<string, PaletteRamp>()
const scratch = new THREE.Color()
const white = new THREE.Color(1, 1, 1)

/**
 * The palette's five slots, deriving `shadow` and `glow` when it only declares
 * three colours.
 *
 * Memoized per id: this is read every frame by every mounted scene, and the
 * derivation allocates. `PALETTES` is append-only and palette entries are never
 * mutated, so a cache keyed on id can never go stale.
 *
 * The derivation keeps the roles the palette already authored rather than
 * re-sorting all three by luminance, which would discard the author's intent:
 *  - `mid` ← primary and `accent` ← accent.
 *  - `shadow` is the background carried 40% toward the primary, so a form falls
 *    off into a tinted dark rather than into flat black.
 *  - `glow` is the **brightest of the three** lifted 45% toward white.
 *
 * That last one is not arbitrary. Deriving `glow` from the secondary — the
 * roster's nominal "air/edge" colour — inverts the ramp whenever the secondary
 * is not the brightest: `mono` is `#ffffff / #8fa3ad / #3a4a55`, so `mid` came
 * out pure white and `glow` came out a mid grey, and a scene walking bg→glow
 * would have got *darker* at the top of its ramp. Picking by luminance
 * guarantees the one property the slot's name promises.
 */
export function resolveRamp(palette: Palette): PaletteRamp {
  if (palette.ramp) return palette.ramp
  const cached = rampCache.get(palette.id)
  if (cached) return cached
  const shadow = `#${scratch.set(palette.bg).lerp(new THREE.Color(palette.colors[0]), 0.4).getHexString()}`
  let brightest = palette.colors[0]
  let bestLum = -1
  for (const hex of palette.colors) {
    scratch.set(hex)
    // Rec.709 luma — the same weighting the image extractor sorts by, so a
    // derived ramp and an extracted one agree on what "brightest" means.
    const lum = 0.2126 * scratch.r + 0.7152 * scratch.g + 0.0722 * scratch.b
    if (lum > bestLum) {
      bestLum = lum
      brightest = hex
    }
  }
  const glow = `#${scratch.set(brightest).lerp(white, 0.45).getHexString()}`
  const derived: PaletteRamp = [palette.bg, shadow, palette.colors[0], palette.colors[2], glow]
  rampCache.set(palette.id, derived)
  return derived
}

/**
 * Seconds a palette change takes to complete.
 *
 * lilim's figure, kept because it is tuned: fast enough to read as a deliberate
 * change on a section boundary, slow enough that it never snaps.
 */
export const MORPH_SECONDS = 1.8

/**
 * Mutable palette colours that ease toward the active palette, so switches
 * sweep smoothly instead of snapping. Call {@link update} each frame with the
 * target palette.
 *
 * Every colour is mutated **in place**, which is what lets a scene hold a
 * direct reference in a uniform (`uGlow: { value: pal.glow }`) and get recoloured
 * for free — including part-way through a morph. Scenes must therefore never
 * retain a blended colour across frames; `.copy()` it if you need a snapshot.
 *
 * ## Why a snapshot-and-smoothstep morph, not an exponential ease
 *
 * The original blender re-aimed an exponential lerp at the live target every
 * frame (`lerp(target, min(1, dt * 2.5))`). That has two problems this shape
 * fixes: it never actually arrives (it asymptotes, so the last few percent of a
 * colour change takes forever and a screenshot mid-sweep is never the authored
 * colour), and its rate depends on frame time in a way that makes the same
 * change take visibly longer on a slow machine.
 *
 * This snapshots the *live* colours as the morph's origin whenever the target
 * changes, then drives a fixed-duration smoothstep. Interrupting a morph
 * re-snapshots from wherever the colours actually are, so a rapid palette
 * cycle eases continuously instead of jumping back to a start colour.
 */
export class PaletteBlender {
  /** Primary — form/base. The three-colour contract, unchanged. */
  a = new THREE.Color()
  /** Secondary — air/edge. */
  b = new THREE.Color()
  /** Accent — hot. */
  c = new THREE.Color()

  /** Near-black ground. */
  bg = new THREE.Color()
  /** Dark tint — where a form falls away. */
  shadow = new THREE.Color()
  /** Main body colour. */
  mid = new THREE.Color()
  /** Contrast note. */
  accent = new THREE.Color()
  /** Brightest slot. */
  glow = new THREE.Color()

  private id = ''
  private progress = 1

  /**
   * All eight tracked colours in a fixed order, so the morph is one loop.
   *
   * Built once, not returned from a getter. `update()` walks this every frame
   * for every mounted scene, and a getter that returned a fresh array would be
   * a per-frame allocation in the render loop — the one thing this codebase
   * consistently refuses to do.
   *
   * Class fields initialise in declaration order, so this must stay below the
   * eight Colors it references.
   */
  private readonly slots: readonly THREE.Color[] = [
    this.a,
    this.b,
    this.c,
    this.bg,
    this.shadow,
    this.mid,
    this.accent,
    this.glow,
  ]

  /** Live colours at the moment the target changed. */
  private from = this.slots.map(() => new THREE.Color())
  private to = this.slots.map(() => new THREE.Color())

  constructor(palette: Palette) {
    this.aim(palette)
    // Start snapped rather than morphing up from black — a scene mounting
    // mid-show must not fade in from the wrong colour.
    this.progress = 1
    for (let i = 0; i < this.slots.length; i++) this.slots[i].copy(this.to[i])
  }

  /** Point `to` at a palette and snapshot `from` off the live colours. */
  private aim(palette: Palette) {
    const ramp = resolveRamp(palette)
    for (let i = 0; i < this.slots.length; i++) this.from[i].copy(this.slots[i])
    this.to[0].set(palette.colors[0])
    this.to[1].set(palette.colors[1])
    this.to[2].set(palette.colors[2])
    this.to[3].set(ramp[0])
    this.to[4].set(ramp[1])
    this.to[5].set(ramp[2])
    this.to[6].set(ramp[3])
    this.to[7].set(ramp[4])
    this.id = palette.id
    this.progress = 0
  }

  /**
   * Advance the morph. `speed` scales the rate (1 = {@link MORPH_SECONDS}); it
   * exists so a hard-cut path can force an instant change without reaching into
   * private state.
   */
  update(palette: Palette, delta: number, speed = 1) {
    if (palette.id !== this.id) this.aim(palette)
    if (this.progress >= 1) return
    this.progress = Math.min(1, this.progress + (delta * speed) / MORPH_SECONDS)
    // smoothstep — eases in and out, so a change has no visible start or stop.
    const t = this.progress
    const e = t * t * (3 - 2 * t)
    for (let i = 0; i < this.slots.length; i++) {
      this.slots[i].lerpColors(this.from[i], this.to[i], e)
    }
  }
}

/**
 * Extract a five-slot palette from an image.
 *
 * Quantise to a 4-bit-per-channel histogram, take the 40 most populous buckets
 * as candidates, then greedily pick five that are mutually far apart in RGB —
 * picking by popularity alone returns five near-identical shades of whatever
 * dominates the frame. Order by luminance into bg→glow, then shape the ends:
 * the darkest is forced to near-black so it can serve as ground, and the
 * lightest is lifted toward white so it can serve as a highlight. Without that
 * shaping a photo of a bright wall yields five mid-greys and no ramp at all.
 *
 * Returns `null` for an image with no opaque pixels. Requires a DOM canvas, so
 * it is a UI-thread helper — never call it from the render loop.
 */
export function paletteFromImage(img: CanvasImageSource): PaletteRamp | null {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 48
  const g = canvas.getContext('2d', { willReadFrequently: true })
  if (!g) return null
  g.drawImage(img, 0, 0, 48, 48)
  const { data } = g.getImageData(0, 0, 48, 48)

  const buckets = new Map<number, [number, number, number, number]>()
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue
    const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4)
    const bucket = buckets.get(key) ?? [0, 0, 0, 0]
    bucket[0] += data[i]
    bucket[1] += data[i + 1]
    bucket[2] += data[i + 2]
    bucket[3]++
    buckets.set(key, bucket)
  }

  type RGB = [number, number, number]
  const candidates: RGB[] = [...buckets.values()]
    .sort((x, y) => y[3] - x[3])
    .slice(0, 40)
    .map((b) => [b[0] / b[3] / 255, b[1] / b[3] / 255, b[2] / b[3] / 255])
  if (candidates.length === 0) return null

  const dist2 = (x: RGB, y: RGB) =>
    (x[0] - y[0]) ** 2 + (x[1] - y[1]) ** 2 + (x[2] - y[2]) ** 2
  const picked: RGB[] = [candidates[0]]
  while (picked.length < 5 && picked.length < candidates.length) {
    let best = candidates[0]
    let bestD = -1
    for (const cand of candidates) {
      const d = Math.min(...picked.map((p) => dist2(p, cand)))
      if (d > bestD) {
        bestD = d
        best = cand
      }
    }
    picked.push(best)
  }
  // A near-monochrome image can run out of distinct candidates; repeat the last
  // rather than returning a short ramp callers would have to length-check.
  while (picked.length < 5) picked.push(picked[picked.length - 1])

  const lum = (p: RGB) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]
  picked.sort((x, y) => lum(x) - lum(y))
  const hex = (p: RGB, scale = 1, toWhite = 0) => {
    scratch.setRGB(p[0] * scale, p[1] * scale, p[2] * scale)
    if (toWhite) scratch.lerp(white, toWhite)
    return `#${scratch.getHexString()}`
  }
  return [
    hex(picked[0], Math.min(1, 0.07 / Math.max(0.02, lum(picked[0])))),
    hex(picked[1], 0.55),
    hex(picked[2]),
    hex(picked[3]),
    hex(picked[4], 1, 0.25),
  ]
}
