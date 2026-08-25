import * as THREE from 'three'

/**
 * The palette contract: five semantic slots, and every scene draws from them.
 *
 * ## Why five, and why semantic
 *
 * A scene used to get three unnamed colours and a background it could not
 * reach. Anything it needed beyond that — a shadow tone to sit its geometry
 * against, a highlight hotter than its body colour — it had to invent, usually
 * as a hardcoded hex or a `multiplyScalar` on one of the three. That is fine
 * while every scene has the same author.
 *
 * It stops being fine the moment they do not. Two scenes by two authors,
 * consecutive in the same show, each inventing their own shadow, is a colour
 * collision every phrase — and no amount of palette switching fixes it, because
 * the invented colours do not participate in the palette at all. **A palette
 * contract is what makes a mixed-authorship set look like one show.** The five
 * slots are that contract: a scene asks for the role it means, and the palette
 * decides what colour that role is today.
 *
 * The slots, darkest to brightest:
 *
 *  - `bg`      the ground the show sits on; near-black by discipline
 *  - `shadow`  where geometry falls away — the tone a scene sits its darks in
 *  - `mid`     the body colour; what the subject mostly IS
 *  - `accent`  the second voice, usually a different hue family from `mid`
 *  - `glow`    the hot highlight; what a kick lights up
 *
 * ## Mutated in place
 *
 * `PaletteBlender` exposes five `THREE.Color` instances that are updated in
 * place, never replaced. A scene copies from them each frame, so a palette
 * change recolours everything — including mid-morph, and including scenes that
 * cached nothing. Ported from lilim's `PAL` singleton, which works the same way
 * and for the same reason.
 */

/** The five slots, darkest to brightest. Every palette declares all five. */
export interface PaletteSlots {
  bg: string
  shadow: string
  mid: string
  accent: string
  glow: string
}

/**
 * Display grouping. Purely organisational — nothing dispatches on it — but it
 * is what lets a picker of thirty palettes stay legible, and it records the
 * intent behind a set's colour relationships.
 */
export type PaletteFamily =
  /** AudioVis's own set. Referenced by `AutoPilot` and `keyPalette`. */
  | 'signature'
  /** One hue family plus a warm highlight. Safe under any scene. */
  | 'classic'
  /** `mid`, `accent` and `glow` in different hue families, so a kick changes
   *  colour rather than just level. */
  | 'bold'
  /** Quiet materials with one contrast note — accents read as a change of
   *  material rather than a colour pop. */
  | 'earth'
  /** The four lit slots span distant hues, so a scene that sweeps the ramp
   *  pulls a full spectrum out of five slots. */
  | 'rainbow'

export interface Palette {
  id: string
  name: string
  family: PaletteFamily
  slots: PaletteSlots
}

const pal = (
  id: string,
  name: string,
  family: PaletteFamily,
  [bg, shadow, mid, accent, glow]: [string, string, string, string, string],
): Palette => ({ id, name, family, slots: { bg, shadow, mid, accent, glow } })

/**
 * The roster.
 *
 * **Append-only.** `paletteId` is persisted in user state, stored in presets and
 * cue timelines, and named directly by `AutoPilot`'s mood table and
 * `keyPalette`'s key table — so an id that changes meaning silently repoints
 * every saved show. Add at the end; never rename, never repurpose.
 *
 * The `signature` six came first and their three lit slots are unchanged from
 * when they were `colors: [primary, secondary, accent]` — `mid`/`accent`/`glow`
 * hold exactly what `colors[0..2]` held, so no existing scene shifts colour.
 * Their `shadow` values are the genuinely new part and are authored by eye: a
 * dark tone sitting between that palette's `bg` and `mid`, chosen to read as the
 * same material in shade rather than as a separate hue.
 *
 * The remaining twenty-four are ported from lilim's preset list, colours
 * unchanged. Two of its names — `aurora` and `ember` — already existed here with
 * different colours and are load-bearing ids, so lilim's versions keep their
 * palettes under disambiguated ids rather than either set being dropped.
 */
export const PALETTES: Palette[] = [
  // --- signature: AudioVis's own, ids referenced across the engine ---------
  pal('aurora', 'Aurora', 'signature', ['#020208', '#071a2e', '#00e5ff', '#7c4dff', '#00ffa3']),
  pal('ember', 'Ember', 'signature', ['#0a0302', '#2e0f04', '#ff6d00', '#ff1744', '#ffd54f']),
  pal('violet', 'Violet Haze', 'signature', ['#05020a', '#1d1038', '#b388ff', '#ff80ab', '#8c9eff']),
  pal('ocean', 'Deep Ocean', 'signature', ['#010409', '#06182e', '#00b0ff', '#00e5ff', '#304ffe']),
  pal('mono', 'Monolith', 'signature', ['#000000', '#1a1f22', '#ffffff', '#8fa3ad', '#3a4a55']),
  pal('solar', 'Solar Flare', 'signature', ['#080401', '#2b1a03', '#ffd600', '#ff3d00', '#ff9e80']),

  // --- classic: one hue family plus a warm highlight -----------------------
  pal('nocturne', 'Nocturne', 'classic', ['#05030a', '#140a2e', '#7b3ff2', '#2fd6a8', '#ffb46b']),
  pal('emberGlass', 'Ember Glass', 'classic', ['#0a0405', '#2e0a0e', '#c2452f', '#ff9d45', '#ffe8c4']),
  pal('glacial', 'Glacial', 'classic', ['#030608', '#0a1c2e', '#2f6d9e', '#6fd0e0', '#eafcff']),
  pal('orchid', 'Orchid', 'classic', ['#0a0308', '#250a26', '#b03fa0', '#f27ab5', '#ffd9a8']),
  pal('moss', 'Moss', 'classic', ['#040703', '#14260f', '#4f8f3a', '#b5d96b', '#f4ffd6']),
  pal('sodium', 'Sodium', 'classic', ['#060504', '#221a08', '#a87b1c', '#ffc93c', '#fff3d0']),
  pal('pearl', 'Pearl', 'classic', ['#060607', '#1c1c22', '#8a8a9e', '#cfcfe0', '#ffffff']),

  // --- bold: lit slots in different hue families --------------------------
  pal('cobalt', 'Cobalt', 'bold', ['#020410', '#0c2058', '#3f6fe0', '#ff9432', '#fff0d8']),
  pal('reef', 'Reef', 'bold', ['#020707', '#083038', '#1fae9e', '#ff7a5c', '#ffe9c4']),
  pal('vapor', 'Vapor', 'bold', ['#050310', '#231043', '#e04fd0', '#3fd6ff', '#ffe0f4']),
  pal('oxide', 'Oxide', 'bold', ['#050303', '#291109', '#b5532a', '#3fc4a4', '#ffdfae']),
  pal('auroraBold', 'Aurora Bold', 'bold', ['#020308', '#141038', '#8f54ff', '#38e08f', '#e4ffe9']),
  pal('velvet', 'Velvet', 'bold', ['#070312', '#260a44', '#7a3fd6', '#ffcf4a', '#ffefc0']),
  pal('acid', 'Acid', 'bold', ['#030503', '#132808', '#7fe03f', '#e03fb0', '#f4ffd0']),
  pal('neon', 'Neon', 'bold', ['#04030a', '#1c0f2e', '#ff3f6e', '#2fd6ff', '#fff0b0']),
  pal('mirage', 'Mirage', 'bold', ['#060408', '#1c1440', '#e05a8c', '#ffb35c', '#fff2d8']),

  // --- earth: quiet materials with one contrast note ----------------------
  pal('canyon', 'Canyon', 'earth', ['#050302', '#26120a', '#b0602f', '#8fc9a8', '#ffe2b8']),
  pal('adobe', 'Adobe', 'earth', ['#060302', '#2c1410', '#c96f4a', '#7f9eb0', '#ffe8cc']),
  pal('sage', 'Sage', 'earth', ['#040504', '#1c2010', '#7f8f5a', '#d9b070', '#f7f0dc']),
  pal('umber', 'Umber', 'earth', ['#050403', '#201207', '#7a4a22', '#d49a3f', '#f4e4c4']),

  // --- rainbow: lit slots span distant hues -------------------------------
  pal('prism', 'Prism', 'rainbow', ['#030309', '#2c0a54', '#1f8fe0', '#ff5a3c', '#ffe94a']),
  pal('carnival', 'Carnival', 'rainbow', ['#060306', '#30104a', '#24c46a', '#ff4f7e', '#ffd94a']),
  pal('candy', 'Candy', 'rainbow', ['#070409', '#3c1450', '#ff6fc4', '#4fd6ff', '#fff29e']),
  pal('tropic', 'Tropic', 'rainbow', ['#030503', '#0c3020', '#2fd66f', '#ff5a8c', '#ffe27a']),
]

/** Families in display order. Drives the palette picker's grouping. */
export const PALETTE_FAMILIES: PaletteFamily[] = [
  'signature',
  'classic',
  'bold',
  'earth',
  'rainbow',
]

/**
 * Look up a palette by id, falling back to the first one. Like {@link getScene},
 * the fallback matters: a persisted or shared `paletteId` may name a palette that
 * no longer exists, and scenes read this every frame — it must never throw.
 */
export function getPalette(id: string): Palette {
  return PALETTES.find((p) => p.id === id) ?? PALETTES[0]
}

/** Every palette in one family, in roster order. For a grouped picker. */
export function getPalettesByFamily(family: PaletteFamily): Palette[] {
  return PALETTES.filter((p) => p.family === family)
}

/**
 * Extension point: add a palette from outside the core bundle. Intentionally has
 * no in-repo callers — public API documented in README.md / ARCHITECTURE.md.
 *
 * Rejects a duplicate id rather than replacing, so a plugin cannot silently
 * repoint an id that presets and cue timelines already reference.
 */
export function registerPalette(palette: Palette) {
  if (!PALETTES.some((p) => p.id === palette.id)) PALETTES.push(palette)
}

/**
 * The five live slots, eased toward the active palette so a switch sweeps
 * rather than snaps.
 *
 * Every colour is mutated in place and never reassigned, which is what lets a
 * scene hold a reference (or copy from one each frame) and simply be recoloured
 * by a palette change it never hears about.
 */
export class PaletteBlender {
  readonly bg = new THREE.Color()
  readonly shadow = new THREE.Color()
  readonly mid = new THREE.Color()
  readonly accent = new THREE.Color()
  readonly glow = new THREE.Color()

  /**
   * Pre-v2 names, kept so the in-repo scenes keep working unchanged.
   *
   * Getters returning the SAME mutable instance, so `col.a` and `col.mid` are
   * one colour, not two that could drift — and reading one allocates nothing.
   *
   * @deprecated Prefer the semantic names. A scene that says `mid` still reads
   * correctly to someone who has never seen this file; one that says `a` does
   * not, which is exactly the problem the slot contract exists to fix.
   */
  get a(): THREE.Color {
    return this.mid
  }
  /** @deprecated Use {@link accent}. */
  get b(): THREE.Color {
    return this.accent
  }
  /** @deprecated Use {@link glow}. */
  get c(): THREE.Color {
    return this.glow
  }

  private readonly target = new THREE.Color()

  constructor(palette: Palette) {
    this.bg.set(palette.slots.bg)
    this.shadow.set(palette.slots.shadow)
    this.mid.set(palette.slots.mid)
    this.accent.set(palette.slots.accent)
    this.glow.set(palette.slots.glow)
  }

  /**
   * Ease every slot toward `palette`.
   *
   * `1 - exp(-delta * speed)` rather than `min(1, delta * speed)`, for the
   * reason spelled out on `approach()` in performanceState.ts: the clamped form
   * snaps to the target outright once `delta * speed >= 1`, which at the default
   * speed is any frame slower than 2.5fps — so a palette change stopped sweeping
   * and started cutting exactly on the machines least able to hide it.
   */
  update(palette: Palette, delta: number, speed = 2.5) {
    if (!isFinite(delta) || delta <= 0) return
    const k = 1 - Math.exp(-delta * speed)
    const s = palette.slots
    this.bg.lerp(this.target.set(s.bg), k)
    this.shadow.lerp(this.target.set(s.shadow), k)
    this.mid.lerp(this.target.set(s.mid), k)
    this.accent.lerp(this.target.set(s.accent), k)
    this.glow.lerp(this.target.set(s.glow), k)
  }
}
