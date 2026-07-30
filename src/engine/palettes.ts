import * as THREE from 'three'

export interface Palette {
  id: string
  name: string
  /** Primary, secondary, accent. */
  colors: [string, string, string]
  bg: string
}

export const PALETTES: Palette[] = [
  { id: 'aurora', name: 'Aurora', colors: ['#00e5ff', '#7c4dff', '#00ffa3'], bg: '#020208' },
  { id: 'ember', name: 'Ember', colors: ['#ff6d00', '#ff1744', '#ffd54f'], bg: '#0a0302' },
  { id: 'violet', name: 'Violet Haze', colors: ['#b388ff', '#ff80ab', '#8c9eff'], bg: '#05020a' },
  { id: 'ocean', name: 'Deep Ocean', colors: ['#00b0ff', '#00e5ff', '#304ffe'], bg: '#010409' },
  { id: 'mono', name: 'Monolith', colors: ['#ffffff', '#8fa3ad', '#3a4a55'], bg: '#000000' },
  { id: 'solar', name: 'Solar Flare', colors: ['#ffd600', '#ff3d00', '#ff9e80'], bg: '#080401' },
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

/**
 * Mutable trio of THREE.Colors that eases toward the active palette, so
 * palette switches sweep smoothly instead of snapping. Call `update` each
 * frame with the target palette.
 */
export class PaletteBlender {
  a = new THREE.Color()
  b = new THREE.Color()
  c = new THREE.Color()
  private ta = new THREE.Color()
  private tb = new THREE.Color()
  private tc = new THREE.Color()

  constructor(palette: Palette) {
    this.a.set(palette.colors[0])
    this.b.set(palette.colors[1])
    this.c.set(palette.colors[2])
  }

  update(palette: Palette, delta: number, speed = 2.5) {
    this.ta.set(palette.colors[0])
    this.tb.set(palette.colors[1])
    this.tc.set(palette.colors[2])
    const k = Math.min(1, delta * speed)
    this.a.lerp(this.ta, k)
    this.b.lerp(this.tb, k)
    this.c.lerp(this.tc, k)
  }
}
