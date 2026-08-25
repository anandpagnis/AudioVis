import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  MORPH_SECONDS,
  PALETTES,
  PaletteBlender,
  getPalette,
  resolveRamp,
  type Palette,
} from '../palettes'

const lum = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
const col = (hex: string) => new THREE.Color(hex)
/** RGB-space distance. THREE.Color has no distanceTo of its own. */
const dist = (x: THREE.Color, y: THREE.Color) =>
  Math.hypot(x.r - y.r, x.g - y.g, x.b - y.b)

/**
 * Advance a blender by `seconds` at a fixed step, as the render loop would.
 *
 * The frame count is computed rather than accumulated. Summing `t += step` and
 * testing `t < seconds` lets float error decide whether the final frame runs, so
 * the same nominal duration ran 27 or 28 frames depending on the step size —
 * which showed up as a spurious frame-rate-dependence failure below.
 */
function run(blender: PaletteBlender, palette: Palette, seconds: number, step = 1 / 60) {
  const frames = Math.round(seconds / step)
  for (let i = 0; i < frames; i++) blender.update(palette, step)
}

describe('resolveRamp', () => {
  it('returns an authored ramp untouched', () => {
    const p = getPalette('nocturne')
    expect(p.ramp).toBeDefined()
    expect(resolveRamp(p)).toBe(p.ramp)
  })

  it('derives five slots for a three-colour palette', () => {
    const ramp = resolveRamp(getPalette('aurora'))
    expect(ramp).toHaveLength(5)
    for (const hex of ramp) expect(hex).toMatch(/^#[0-9a-f]{6}$/i)
  })

  it('never derives a glow darker than the mid', () => {
    // The slot names promise an ordering, and a scene walking bg->glow relies on
    // it. Deriving glow from the SECONDARY colour broke this for `mono`
    // (#ffffff / #8fa3ad / #3a4a55), whose mid came out pure white and whose
    // glow came out a mid grey — the top of the ramp was darker than its middle.
    for (const p of PALETTES) {
      if (p.ramp) continue
      const [, , mid, , glow] = resolveRamp(p)
      expect(lum(col(glow)), `${p.id}: glow must not be darker than mid`).toBeGreaterThanOrEqual(
        lum(col(mid)) - 1e-6,
      )
    }
  })

  it('derives a shadow between the background and the mid', () => {
    for (const p of PALETTES) {
      if (p.ramp) continue
      const [bg, shadow, mid] = resolveRamp(p)
      const l = lum(col(shadow))
      expect(l, `${p.id}`).toBeGreaterThanOrEqual(lum(col(bg)) - 1e-6)
      expect(l, `${p.id}`).toBeLessThanOrEqual(lum(col(mid)) + 1e-6)
    }
  })

  it('memoizes, so the per-frame read does not re-derive', () => {
    const p = getPalette('violet')
    expect(resolveRamp(p)).toBe(resolveRamp(p))
  })
})

describe('palette catalogue', () => {
  it('has unique ids', () => {
    const ids = PALETTES.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('keeps every authored ramp dark at the bottom and bright at the top', () => {
    for (const p of PALETTES) {
      if (!p.ramp) continue
      const [bg, shadow, mid, , glow] = p.ramp
      expect(lum(col(bg)), `${p.id} bg`).toBeLessThan(0.05)
      expect(lum(col(shadow)), `${p.id} shadow`).toBeGreaterThanOrEqual(lum(col(bg)))
      expect(lum(col(glow)), `${p.id} glow`).toBeGreaterThan(lum(col(mid)))
    }
  })

  it('derives the three-colour contract from an authored ramp', () => {
    // The 14 scenes reading col.a/b/c must get the three LIT slots, never the
    // near-black ground — handing a scene a #05030a as its "primary" reads as
    // the scene being broken.
    const p = getPalette('nocturne')
    expect(p.colors).toEqual([p.ramp![2], p.ramp![3], p.ramp![4]])
    expect(p.bg).toBe(p.ramp![0])
  })

  it('falls back rather than throwing on an unknown id', () => {
    expect(getPalette('does-not-exist')).toBe(PALETTES[0])
  })
})

describe('PaletteBlender', () => {
  it('starts snapped to its palette, not morphing up from black', () => {
    // A scene mounting mid-show must not fade in from the wrong colour.
    const p = getPalette('ember')
    const b = new PaletteBlender(p)
    expect(b.a.getHexString()).toBe(col(p.colors[0]).getHexString())
    expect(b.glow.getHexString()).toBe(col(resolveRamp(p)[4]).getHexString())
  })

  it('arrives exactly on target, rather than asymptoting', () => {
    // The whole reason for replacing the exponential ease: it never actually
    // got there, so a screenshot mid-set was never the authored colour.
    const b = new PaletteBlender(getPalette('aurora'))
    const target = getPalette('ember')
    run(b, target, MORPH_SECONDS + 0.2)
    const ramp = resolveRamp(target)
    expect(b.a.getHexString()).toBe(col(target.colors[0]).getHexString())
    expect(b.mid.getHexString()).toBe(col(ramp[2]).getHexString())
    expect(b.glow.getHexString()).toBe(col(ramp[4]).getHexString())
  })

  it('is still in motion halfway through the morph', () => {
    const from = getPalette('aurora')
    const b = new PaletteBlender(from)
    const to = getPalette('ember')
    run(b, to, MORPH_SECONDS * 0.5)
    expect(b.a.getHexString()).not.toBe(col(from.colors[0]).getHexString())
    expect(b.a.getHexString()).not.toBe(col(to.colors[0]).getHexString())
  })

  it('re-aims from the live colour when interrupted, so it never snaps back', () => {
    const b = new PaletteBlender(getPalette('aurora'))
    run(b, getPalette('ember'), MORPH_SECONDS * 0.4)
    const midMorph = b.a.clone()

    // Change target part-way. The next frame must continue from where the colour
    // actually is — not jump to either endpoint.
    b.update(getPalette('ocean'), 1 / 60)
    expect(dist(b.a, midMorph)).toBeLessThan(0.05)
    expect(b.a.getHexString()).not.toBe(col(getPalette('ocean').colors[0]).getHexString())
  })

  it('converges on the final target through a rapid palette cycle', () => {
    const b = new PaletteBlender(getPalette('aurora'))
    for (const id of ['ember', 'ocean', 'violet', 'solar']) {
      run(b, getPalette(id), 0.2)
    }
    const last = getPalette('solar')
    run(b, last, MORPH_SECONDS + 0.2)
    expect(b.a.getHexString()).toBe(col(last.colors[0]).getHexString())
  })

  it('holds still once arrived, so a settled palette costs nothing to re-aim', () => {
    const p = getPalette('ember')
    const b = new PaletteBlender(getPalette('aurora'))
    run(b, p, MORPH_SECONDS + 0.5)
    const settled = b.a.clone()
    run(b, p, 1)
    expect(b.a.equals(settled)).toBe(true)
  })

  it('takes the same wall-clock time regardless of frame rate', () => {
    // A fixed-duration morph is the other half of the reason the exponential
    // ease was replaced: its rate depended on frame time, so the same change
    // took visibly longer on a slow machine.
    const target = getPalette('ember')
    const fast = new PaletteBlender(getPalette('aurora'))
    const slow = new PaletteBlender(getPalette('aurora'))
    run(fast, target, MORPH_SECONDS * 0.5, 1 / 144)
    run(slow, target, MORPH_SECONDS * 0.5, 1 / 30)
    expect(dist(fast.a, slow.a)).toBeLessThan(0.02)
  })

  it('exposes stable Color instances a scene can bind into a uniform', () => {
    // Scenes bind `pal.glow` straight into a uniform at material-creation time
    // and rely on in-place mutation from then on. A morph that REPLACED the
    // object would silently stop reaching the shader.
    const b = new PaletteBlender(getPalette('aurora'))
    const bound = b.glow
    run(b, getPalette('ember'), MORPH_SECONDS + 0.2)
    expect(b.glow).toBe(bound)
  })
})
