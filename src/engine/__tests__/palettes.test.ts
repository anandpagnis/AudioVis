import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  PALETTES,
  PALETTE_FAMILIES,
  PaletteBlender,
  getPalette,
  getPalettesByFamily,
  type PaletteSlots,
} from '../palettes'

/**
 * The palette contract.
 *
 * These are not style checks. Each one pins a promise the contract makes to a
 * scene author who cannot see this file — which is the whole point of having
 * slots rather than three unnamed colours.
 */

const SLOTS: (keyof PaletteSlots)[] = ['bg', 'shadow', 'mid', 'accent', 'glow']
const HEX = /^#[0-9a-f]{6}$/i

/** Relative luminance, for the ordering and darkness invariants. */
const lum = (hex: string) => {
  const c = new THREE.Color(hex)
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
}

describe('the roster', () => {
  it('gives every palette all five slots as real hex', () => {
    // A missing slot is the failure the contract exists to prevent: the scene
    // asks for `shadow`, gets undefined, and THREE.Color silently renders it
    // white — a blown-out frame rather than a visible error.
    for (const p of PALETTES) {
      for (const slot of SLOTS) {
        expect(p.slots[slot], `${p.id}.${slot}`).toMatch(HEX)
      }
    }
  })

  it('has unique ids', () => {
    // `paletteId` is persisted, stored in presets and cue timelines, and named
    // directly by AutoPilot and keyPalette. A duplicate makes `getPalette`
    // return whichever came first and silently repoints saved shows.
    const ids = PALETTES.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('keeps every background near black', () => {
    // The exposure discipline in docs/09_Rendering_Engine.md depends on the
    // frame being mostly true black; a palette that ships a lifted background
    // breaks it for every scene at once, which no scene can defend against.
    for (const p of PALETTES) {
      expect(lum(p.slots.bg), `${p.id} bg is not near-black`).toBeLessThan(0.02)
    }
  })

  it('keeps shadow between bg and mid', () => {
    // What makes `shadow` usable blind: a scene sits its darks in it expecting
    // something above the ground and below the body colour. A shadow brighter
    // than mid would invert every scene that uses it for depth.
    for (const p of PALETTES) {
      expect(lum(p.slots.shadow), `${p.id} shadow not above bg`).toBeGreaterThanOrEqual(
        lum(p.slots.bg),
      )
      expect(lum(p.slots.shadow), `${p.id} shadow not below mid`).toBeLessThan(lum(p.slots.mid))
    }
  })

  it('files every palette under a declared family, and no family is empty', () => {
    for (const p of PALETTES) {
      expect(PALETTE_FAMILIES, `${p.id} has unlisted family "${p.family}"`).toContain(p.family)
    }
    for (const f of PALETTE_FAMILIES) {
      expect(getPalettesByFamily(f).length, `family "${f}" is empty`).toBeGreaterThan(0)
    }
  })

  it('ships the twenty-four ported presets alongside the signature set', () => {
    expect(getPalettesByFamily('signature')).toHaveLength(6)
    const ported = PALETTES.length - getPalettesByFamily('signature').length
    expect(ported).toBe(24)
  })
})

describe('the signature palettes did not shift colour', () => {
  // The migration's central claim: the three lit slots hold exactly what
  // `colors[0..2]` held before, so no existing scene changes appearance. Every
  // one of these is a value read from the pre-migration file.
  const BEFORE: Record<string, [string, string, string, string]> = {
    // id: [bg, mid, accent, glow]
    aurora: ['#020208', '#00e5ff', '#7c4dff', '#00ffa3'],
    ember: ['#0a0302', '#ff6d00', '#ff1744', '#ffd54f'],
    violet: ['#05020a', '#b388ff', '#ff80ab', '#8c9eff'],
    ocean: ['#010409', '#00b0ff', '#00e5ff', '#304ffe'],
    mono: ['#000000', '#ffffff', '#8fa3ad', '#3a4a55'],
    solar: ['#080401', '#ffd600', '#ff3d00', '#ff9e80'],
  }

  it('holds the old colours in the new slots', () => {
    for (const [id, [bg, mid, accent, glow]] of Object.entries(BEFORE)) {
      const s = getPalette(id).slots
      expect(s.bg, `${id} bg`).toBe(bg)
      expect(s.mid, `${id} mid`).toBe(mid)
      expect(s.accent, `${id} accent`).toBe(accent)
      expect(s.glow, `${id} glow`).toBe(glow)
    }
  })

  it('still resolves every id the engine names directly', () => {
    // AutoPilot's mood table and keyPalette's key table name these as strings.
    // A rename here is a silent fallback to PALETTES[0] on every lookup.
    for (const id of Object.keys(BEFORE)) {
      expect(getPalette(id).id, `${id} no longer resolves`).toBe(id)
    }
  })
})

describe('getPalette', () => {
  it('falls back rather than throwing on an unknown id', () => {
    // Read every frame by every scene, off a persisted value that may name a
    // palette a later build removed.
    expect(getPalette('does-not-exist')).toBe(PALETTES[0])
  })
})

describe('PaletteBlender', () => {
  it('mutates its colours in place, never reassigns them', () => {
    // The load-bearing property. A scene may hold a reference to `col.mid` and
    // expect a palette change to reach it; reassigning would leave every such
    // scene frozen on the colour it captured.
    const blender = new PaletteBlender(getPalette('aurora'))
    const handles = SLOTS.map((s) => blender[s])
    for (let i = 0; i < 30; i++) blender.update(getPalette('solar'), 0.1)
    SLOTS.forEach((s, i) => {
      expect(blender[s], `${s} was replaced`).toBe(handles[i])
    })
  })

  it('converges on the target palette', () => {
    const blender = new PaletteBlender(getPalette('mono'))
    for (let i = 0; i < 200; i++) blender.update(getPalette('ember'), 0.1)
    const target = new THREE.Color(getPalette('ember').slots.mid)
    expect(blender.mid.r).toBeCloseTo(target.r, 2)
    expect(blender.mid.g).toBeCloseTo(target.g, 2)
    expect(blender.mid.b).toBeCloseTo(target.b, 2)
  })

  it('eases rather than snapping', () => {
    // A palette switch should sweep; snapping is what makes an automatic
    // palette change read as a glitch rather than as a decision.
    // Compared on GREEN deliberately: mono's mid is #ffffff and ember's is
    // #ff6d00, so their RED channels are both 1 and a red-channel assertion
    // could not tell an eased blend from a snapped one — it would pass on a
    // blender that did nothing at all.
    const blender = new PaletteBlender(getPalette('mono'))
    const start = blender.mid.g
    blender.update(getPalette('ember'), 1 / 60)
    const target = new THREE.Color(getPalette('ember').slots.mid)
    expect(target.g).not.toBeCloseTo(start, 2) // the fixture is a real change
    expect(blender.mid.g).not.toBeCloseTo(target.g, 2) // ...and one frame is not enough
    expect(blender.mid.g).toBeLessThan(start) // ...but it did move toward it
  })

  it('aliases a/b/c onto the same instances as mid/accent/glow', () => {
    // Thirty-nine in-repo call sites still say `col.a`. They must be reading the
    // same object, not a copy that could drift by a frame.
    const blender = new PaletteBlender(getPalette('aurora'))
    expect(blender.a).toBe(blender.mid)
    expect(blender.b).toBe(blender.accent)
    expect(blender.c).toBe(blender.glow)
  })

  it('exposes bg and shadow, which scenes previously had to invent', () => {
    const blender = new PaletteBlender(getPalette('violet'))
    expect(blender.bg).toBeInstanceOf(THREE.Color)
    expect(blender.shadow).toBeInstanceOf(THREE.Color)
    // And they are distinct instances, not the same colour under two names.
    expect(blender.bg).not.toBe(blender.shadow)
  })

  it('allocates nothing per update', () => {
    // The render loop calls this once per scene per frame. The target colour is
    // a reused scratch instance; this pins that it stays that way.
    const blender = new PaletteBlender(getPalette('aurora'))
    const before = Object.keys(blender).length
    for (let i = 0; i < 50; i++) blender.update(getPalette('neon'), 0.016)
    expect(Object.keys(blender).length).toBe(before)
  })
})
