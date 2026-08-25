import { describe, expect, it } from 'vitest'
import {
  LENS_STYLES,
  RACK_OFF_THRESHOLD,
  isLensActive,
  isMirrorActive,
  lensBeatMode,
  lensStyleName,
  resolveLensStyle,
  type MirrorRackState,
} from '../opticalRack'

/**
 * The pure half of the two optical racks.
 *
 * What these actually protect is the structural rule the racks live under: the
 * effect list never changes shape, and `enabled` is the only branch. Every
 * "is this rack active" test below is really a test that an inert rack costs
 * nothing — because both racks default to inert, so a wrong answer here is a
 * bill every session pays forever.
 */

const inert: MirrorRackState = { segments: 0, tiles: 0, twist: 0, slice: 0, spin: 0 }

describe('isMirrorActive', () => {
  it('is inert when every control is at rest', () => {
    expect(isMirrorActive(inert)).toBe(false)
  })

  it('activates on any one of the four transforms', () => {
    expect(isMirrorActive({ ...inert, segments: 1 })).toBe(true)
    expect(isMirrorActive({ ...inert, tiles: 2 })).toBe(true)
    expect(isMirrorActive({ ...inert, twist: 0.5 })).toBe(true)
    expect(isMirrorActive({ ...inert, slice: 0.5 })).toBe(true)
  })

  it('treats a negative twist as active — it is signed, not a magnitude', () => {
    // A vortex has a direction. Testing `twist > threshold` instead of its
    // absolute value would make every anticlockwise twist silently inert.
    expect(isMirrorActive({ ...inert, twist: -0.5 })).toBe(true)
  })

  it('does NOT activate on spin alone', () => {
    // Spin only rotates a kaleidoscope that is already folding. With no
    // segments there is nothing to turn, so spin alone must not switch the pass
    // on and start charging a fullscreen draw for an identity transform.
    expect(isMirrorActive({ ...inert, spin: 3 })).toBe(false)
  })

  it('ignores a single tile — that is the whole frame, unfolded', () => {
    // The shader's own gate is `uTiles >= 1.5`; a 1x1 wallpaper is the identity,
    // so anything below 2 must read as off on this side too or the pass runs to
    // produce the frame it was given.
    expect(isMirrorActive({ ...inert, tiles: 1 })).toBe(false)
    expect(isMirrorActive({ ...inert, tiles: 2 })).toBe(true)
  })
})

describe('isLensActive', () => {
  it('is inert at zero and just above zero', () => {
    expect(isLensActive({ amount: 0, style: 0 })).toBe(false)
    expect(isLensActive({ amount: RACK_OFF_THRESHOLD, style: 0 })).toBe(false)
  })

  it('activates once the amount is meaningful', () => {
    expect(isLensActive({ amount: 0.2, style: 0 })).toBe(true)
  })

  it('stays inert on a garbage amount rather than rendering with NaN', () => {
    // A NaN would reach `uAmt` and turn the whole frame black; refusing to
    // enable is the safe direction.
    expect(isLensActive({ amount: NaN, style: 0 })).toBe(false)
  })

  it('does not activate on style alone', () => {
    expect(isLensActive({ amount: 0, style: 5 })).toBe(false)
  })
})

describe('resolveLensStyle', () => {
  it('rounds to the material a slider is visually on', () => {
    expect(resolveLensStyle(2.9)).toBe(3)
    expect(resolveLensStyle(2.1)).toBe(2)
  })

  it('clamps instead of wrapping', () => {
    // A preset written against a longer future list must degrade to the last
    // material, not wrap around onto an unrelated one.
    expect(resolveLensStyle(99)).toBe(LENS_STYLES.length - 1)
    expect(resolveLensStyle(-5)).toBe(0)
  })

  it('degrades to the first material on any non-finite value', () => {
    // Both directions, deliberately. A non-finite index is garbage rather than
    // an opinion, so it resolves to a defined safe default instead of being
    // clamped as if the caller had meant "as far as possible" — clamping
    // Infinity to the last material would dress a bug up as a choice.
    expect(resolveLensStyle(NaN)).toBe(0)
    expect(resolveLensStyle(Infinity)).toBe(0)
    expect(resolveLensStyle(-Infinity)).toBe(0)
  })

  it('names every material, and the names are unique', () => {
    const names = LENS_STYLES.map((_, i) => lensStyleName(i))
    expect(names).toHaveLength(LENS_STYLES.length)
    expect(new Set(names).size).toBe(LENS_STYLES.length)
  })
})

describe('lensBeatMode', () => {
  it('routes each material to the re-seat mechanism it was authored for', () => {
    // Three genuinely different mechanisms — pushing the same number at all
    // seven is what makes an effect rack read as one filter with a knob.
    expect(lensBeatMode(0)).toBe('drift') // glass ribs
    expect(lensBeatMode(1)).toBe('drift') // glass fan
    expect(lensBeatMode(2)).toBe('drift') // anamorphic
    expect(lensBeatMode(3)).toBe('plume') // melt
    expect(lensBeatMode(4)).toBe('seed') // glitch
    expect(lensBeatMode(6)).toBe('drift') // fly eye
  })

  it('leaves the LED wall alone on the beat', () => {
    // Sizing the cell grid off the kick moved every cell boundary on every hit
    // and the wall read as jitter. Kicks light the panel instead; the geometry
    // holds still. Regression guard for a bug lilim already hit and documented.
    expect(lensBeatMode(5)).toBe('none')
  })

  it('gives every material a defined mode', () => {
    for (let i = 0; i < LENS_STYLES.length; i++) {
      expect(['drift', 'seed', 'plume', 'none']).toContain(lensBeatMode(i))
    }
  })
})

describe('the style list is an on-disk contract', () => {
  it('has not been reordered', () => {
    // Index IS the shader's `uStyle` value and is what a stored preset holds, so
    // reordering silently repoints every saved look at a different material.
    // Append only — this test is the tripwire.
    expect([...LENS_STYLES]).toEqual([
      'glass ribs',
      'glass fan',
      'anamorphic',
      'melt',
      'glitch',
      'pixels',
      'fly eye',
    ])
  })
})
