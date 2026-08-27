import { describe, expect, it } from 'vitest'
import {
  canBeBackground,
  canBeLayer,
  canBePrimary,
  eligibleRoles,
  PROFILE_H,
  PROFILE_W,
  ProfileAccumulator,
  subjectReference,
  type SceneProfile,
} from '../sceneProfile'

/**
 * Tested against SYNTHETIC fields, deliberately.
 *
 * The profiler's whole purpose is to decide something we currently decide by
 * eye, so validating it only against real scenes would be circular — their
 * correct answers are exactly what is in question. A centred blob, an edge
 * band and a full wash have answers that are true by construction, and a
 * statistic that gets those wrong cannot be trusted on a real scene either.
 */
function field(fn: (x: number, y: number) => number): Float32Array {
  const out = new Float32Array(PROFILE_W * PROFILE_H)
  for (let y = 0; y < PROFILE_H; y++) {
    for (let x = 0; x < PROFILE_W; x++) out[y * PROFILE_W + x] = Math.max(0, Math.min(1, fn(x, y)))
  }
  return out
}

const profileOf = (f: Float32Array, frames = 4): SceneProfile => {
  const acc = new ProfileAccumulator()
  for (let i = 0; i < frames; i++) acc.push(f, 1 / 60)
  return acc.result()
}

const CENTRED = field((x, y) => subjectReference(x, y) / 0.75)
const EDGE_BAND = field((x, y) => {
  const dx = (x + 0.5) / PROFILE_W - 0.5
  const dy = (y + 0.5) / PROFILE_H - 0.5
  return Math.sqrt(dx * dx + dy * dy) / 0.5 > 0.75 ? 0.6 : 0
})
const WASH = field(() => 0.5)
const BLACK = field(() => 0)
const SPARSE_RING = field((x, y) => {
  const dx = (x + 0.5) / PROFILE_W - 0.5
  const dy = (y + 0.5) / PROFILE_H - 0.5
  const r = Math.sqrt(dx * dx + dy * dy) / 0.5
  return r > 0.5 && r < 0.62 ? 0.7 : 0
})

describe('the statistics say what they claim', () => {
  it('reads a centred blob as centred', () => {
    const p = profileOf(CENTRED)
    expect(p.centre).toBeGreaterThan(0.5)
    expect(p.edge).toBeLessThan(0.15)
  })

  it('reads an edge band as peripheral', () => {
    const p = profileOf(EDGE_BAND)
    expect(p.edge).toBeGreaterThan(0.7)
    expect(p.centre).toBe(0)
  })

  it('reads a FLAT wash as structureless rather than as full', () => {
    // A perfectly uniform field has no range to normalise, so it reports no
    // structure — which is true, and is why the layer veto also consults
    // absolute brightness. Judged on shape alone this looks like an empty
    // frame; judged on light it covers everything.
    expect(profileOf(WASH).fill).toBe(0)
    expect(profileOf(WASH).meanLuma).toBeCloseTo(0.5, 2)
  })

  it('reads a textured wash as filling the frame', () => {
    const textured = field((x, y) => 0.4 + 0.35 * Math.sin(x * 0.4) * Math.cos(y * 0.4))
    expect(profileOf(textured).fill).toBeGreaterThan(0.5)
    expect(profileOf(CENTRED).fill).toBeLessThan(0.6)
  })

  it('reads black as empty without dividing by zero', () => {
    const p = profileOf(BLACK)
    expect(p.fill).toBe(0)
    expect(p.conflict).toBe(0)
    expect(Number.isFinite(p.centre)).toBe(true)
  })

  it('scores conflict by WHERE the light is, not how much', () => {
    // A dim centred scene and a bright centred scene fight a subject equally.
    // Normalising by the scene's own energy is what makes that true, and it is
    // the property that stops "turn it down" from reading as "it fits now".
    const dim = field((x, y) => (subjectReference(x, y) / 0.75) * 0.2)
    expect(profileOf(dim).conflict).toBeCloseTo(profileOf(CENTRED).conflict, 2)
  })

  it('scores a centred scene as conflicting and a peripheral one as not', () => {
    expect(profileOf(CENTRED).conflict).toBeGreaterThan(0.7)
    expect(profileOf(EDGE_BAND).conflict).toBeLessThan(0.15)
  })

  it('reports motion as a rate, not a per-frame delta', () => {
    // A scene must not read as calmer merely because the machine ran faster.
    const a = new ProfileAccumulator()
    const b = new ProfileAccumulator()
    for (let i = 0; i < 6; i++) {
      const f = field(() => (i % 2 ? 0.4 : 0.2))
      a.push(f, 1 / 60)
      b.push(f, 1 / 30)
    }
    expect(a.result().motion).toBeGreaterThan(b.result().motion * 1.8)
  })

  it('reports a still scene as still', () => {
    expect(profileOf(CENTRED, 8).motion).toBe(0)
  })
})

describe('eligibility', () => {
  it('refuses a centred blob as a layer, for the right reason', () => {
    const v = canBeLayer(profileOf(CENTRED))
    expect(v.ok).toBe(false)
    expect(v.why).toContain('conflict')
  })

  it('accepts a peripheral ring as a layer and as a ground', () => {
    const p = profileOf(SPARSE_RING)
    expect(canBeLayer(p).ok).toBe(true)
    expect(canBeBackground(p).ok).toBe(true)
  })

  it('refuses a flat wash as a layer, on brightness rather than on shape', () => {
    const v = canBeLayer(profileOf(WASH))
    expect(v.ok).toBe(false)
    expect(v.why).toContain('wash')
  })

  it('refuses a textured wash as a layer, on shape', () => {
    const textured = field((x, y) => 0.1 + 0.08 * Math.sin(x * 0.4) * Math.cos(y * 0.4))
    const v = canBeLayer(profileOf(textured))
    expect(v.ok).toBe(false)
    expect(v.why).toContain('fill')
  })

  it('refuses an empty frame as a primary', () => {
    const v = canBePrimary(profileOf(BLACK))
    expect(v.ok).toBe(false)
    expect(v.why).toContain('fill')
  })

  it('accepts a centred blob as a primary', () => {
    expect(canBePrimary(profileOf(CENTRED)).ok).toBe(true)
  })

  it('holds a background to a stricter bar than a plain layer', () => {
    // Everything a background must satisfy, a layer must satisfy too — the
    // ground sits under the whole composition for a full section.
    for (const f of [CENTRED, EDGE_BAND, WASH, SPARSE_RING]) {
      const p = profileOf(f)
      if (canBeBackground(p).ok) expect(canBeLayer(p).ok).toBe(true)
    }
  })

  it('never offers `effect`, because it is a contract and not a property', () => {
    // The role's binding requirement is that the scene drive itself to visual
    // zero by slotProgress 1. A still frame cannot show that.
    expect(Object.keys(eligibleRoles(profileOf(CENTRED)))).not.toContain('effect')
  })

  it('gives a refusal a reason a human can act on', () => {
    for (const f of [CENTRED, WASH, BLACK]) {
      for (const v of Object.values(eligibleRoles(profileOf(f)))) {
        if (!v.ok) expect(v.why.length).toBeGreaterThan(10)
      }
    }
  })
})

/**
 * Normalisation, which is the fix for the incoherence the first roster run
 * exposed: `ribbons` reported `fill 0.000` and `conflict 1.40` in the same
 * breath, because one statistic was thresholded and the other was
 * energy-weighted.
 */
describe('the field is normalised before anything is measured', () => {
  const dim = field((x, y) => (subjectReference(x, y) / 0.75) * 0.08)
  const bright = field((x, y) => subjectReference(x, y) / 0.75)

  it('gives a dim scene and a bright one the same composition', () => {
    // The point of the whole change. Brightness is the engine's job — the
    // exposure servo and the slot gains own level — so two scenes with the same
    // shape must profile the same, because that is how they will be seen.
    const a = profileOf(dim)
    const b = profileOf(bright)
    // Tolerance rather than equality: the p99 is found from a 256-bin
    // histogram, so the scale is quantised and two brightnesses land on
    // slightly different bins. 0.02 is far below the ~0.4 difference the two
    // fields would show unnormalised.
    expect(Math.abs(a.fill - b.fill)).toBeLessThan(0.02)
    expect(Math.abs(a.centre - b.centre)).toBeLessThan(0.02)
    expect(Math.abs(a.conflict - b.conflict)).toBeLessThan(0.02)
  })

  it('stops fill and conflict disagreeing about a dim scene', () => {
    // Before: fill said "nothing here", conflict said "strongly centred".
    const p = profileOf(dim)
    expect(p.fill).toBeGreaterThan(0.05)
    expect(p.conflict).toBeGreaterThan(0.5)
  })

  it('keeps meanLuma raw, so absolute brightness is still visible', () => {
    expect(profileOf(dim).meanLuma).toBeLessThan(profileOf(bright).meanLuma / 4)
  })

  it('refuses to amplify an empty frame into a composition', () => {
    // The failure that would make the profiler worse than no profiler: scaling
    // sensor-floor noise up to the reference and handing an empty scene
    // confident-looking statistics.
    const noise = field((x, y) => (((x * 7 + y * 13) % 5) / 5) * 0.002)
    const p = profileOf(noise)
    expect(p.fill).toBe(0)
    expect(p.conflict).toBe(0)
  })

  it('is not thrown off by one stuck bright pixel', () => {
    // p99 rather than the maximum: a single specular hit or an on-axis particle
    // would otherwise set the scale for the whole frame.
    const withHot = field((x, y) => (x === 3 && y === 3 ? 1 : subjectReference(x, y) / 0.75))
    const a = profileOf(bright)
    const b = profileOf(withHot)
    expect(b.fill).toBeCloseTo(a.fill, 1)
  })
})

describe('the floor is removed before the field is amplified', () => {
  it('is not fooled by a scene whose black has been lifted', () => {
    // The failure that made the first attempt worse than no fix: with the post
    // chain mounted there is no true black -- bloom's halo and the fog veil lift
    // it -- and normalising to p99 alone then amplified that lifted floor past
    // the lit threshold. Every scene in the roster came out above fill 0.83 and
    // the statistic stopped discriminating at all.
    const clean = field((x, y) => subjectReference(x, y) / 0.75)
    const lifted = field((x, y) => 0.05 + (subjectReference(x, y) / 0.75) * 0.9)
    expect(Math.abs(profileOf(clean).fill - profileOf(lifted).fill)).toBeLessThan(0.06)
  })

  it('still calls a genuine full-frame wash full', () => {
    // The floor subtraction must not turn a real wash into an empty frame: a
    // uniform field has no range, which is exactly the empty signal.
    const washy = field((x, y) => 0.4 + 0.35 * Math.sin(x * 0.4) * Math.cos(y * 0.4))
    expect(profileOf(washy).fill).toBeGreaterThan(0.5)
  })
})
