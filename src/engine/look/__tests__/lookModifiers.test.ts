import { describe, expect, it } from 'vitest'
import { CHARACTER_MOODS } from '../../../audio/characterTypes'
import { MOOD_STATES, type MoodState } from '../../../audio/types'
import MODIFIERS_SRC from '../lookModifiers.ts?raw'
import { findAllocations, hotPath } from './hotPath'
import {
  AFTERGLOW,
  applyAfterglow,
  applyBreakdown,
  applyBuild,
  applyDescriptors,
  applyIntensityGate,
  BUILD,
  BUILD_INTENT,
  BREAKDOWN,
  calmMirrorShare,
  clamp01,
  DESCRIPTOR,
  descriptor01,
  easeFactor,
  HARD_LENS_STYLES,
  INTENSITY_GATE,
  intensityGate,
  smoothstep01,
  SOFT_LENS_STYLES,
  stepAfterglow,
  stepRamp,
  stepStructuralBuild,
} from '../lookModifiers'
import { createNeutralRow, LENS, type LookRow } from '../lookRow'

/** A row with non-trivial values in every field the modifiers touch. Lens order: ribs fan anamorphic melt glitch pixels flyEye pixelSort. */
function richRow(): LookRow {
  const r = createNeutralRow()
  r.lensWeights = [0.1, 0.1, 0.2, 0.1, 0.15, 0.1, 0, 0.25]
  r.mirrorSegments = [0.5, 0.3, 0.2]
  r.cameraWeights = [0.3, 0.2, 0.1, 0.05, 0.15, 0.05, 0.02, 0.05, 0.08]
  r.fxShock = 0.7
  r.fxFlare = 0.6
  r.fxSpark = 0.8
  r.fxStrobe = 0.6
  r.lensEngage = 0.5
  r.mirrorEngage = 0.4
  r.mirrorBusyGain = 1
  r.caBase = 0.002
  r.trailsBase = 0.6
  r.echoGate = 0.5
  r.fogBase = 0.2
  r.steerSpeed = 0.5
  r.steerComplexity = 0.5
  r.steerDensity = 0.5
  r.mirrorSpinMin = 0.2
  r.mirrorSpinMax = 0.6
  return r
}

const sum = (a: readonly number[]) => a.reduce((s, x) => s + x, 0)
const sweep = (n: number) => Array.from({ length: n + 1 }, (_, i) => i / n)

describe('helpers', () => {
  it('clamp01 clamps and turns NaN into 0', () => {
    expect(clamp01(-1)).toBe(0)
    expect(clamp01(0.4)).toBe(0.4)
    expect(clamp01(7)).toBe(1)
    expect(clamp01(NaN)).toBe(0)
  })

  it('descriptor01 clamps and turns NaN into the neutral 0.5', () => {
    expect(descriptor01(NaN)).toBe(0.5)
    expect(descriptor01(-3)).toBe(0)
    expect(descriptor01(3)).toBe(1)
    expect(descriptor01(0.25)).toBe(0.25)
  })

  it('easeFactor is 1 - exp(-dt/tau) and holds on a bad dt', () => {
    expect(easeFactor(3, 3)).toBeCloseTo(1 - Math.exp(-1), 12)
    expect(easeFactor(0, 3)).toBe(0)
    expect(easeFactor(-1, 3)).toBe(0)
    expect(easeFactor(NaN, 3)).toBe(0)
    expect(easeFactor(Infinity, 3)).toBe(0)
    expect(easeFactor(1e9, 3)).toBeCloseTo(1, 12)
    expect(easeFactor(1, 0)).toBe(1)
  })

  it('smoothstep01 is 0, 1 at the ends and 0.5 in the middle', () => {
    expect(smoothstep01(0)).toBe(0)
    expect(smoothstep01(1)).toBe(1)
    expect(smoothstep01(0.5)).toBeCloseTo(0.5, 12)
    expect(smoothstep01(NaN)).toBe(0)
  })

  it('stepRamp is linear over the attack / release seconds and ignores a bad dt', () => {
    let v = 0
    for (let i = 0; i < 60; i++) v = stepRamp(v, true, 1 / 60, 2, 1.5)
    expect(v).toBeCloseTo(0.5, 9) // 1 s of a 2 s attack
    for (let i = 0; i < 30; i++) v = stepRamp(v, false, 1 / 60, 2, 1.5)
    expect(v).toBeCloseTo(0.5 - 0.5 / 1.5, 9) // 0.5 s of a 1.5 s release
    for (let i = 0; i < 120; i++) v = stepRamp(v, false, 1 / 60, 2, 1.5)
    expect(v).toBe(0) // clamped, never negative
    expect(stepRamp(0.3, true, NaN, 2, 1.5)).toBe(0.3)
    expect(stepRamp(0.3, true, -1, 2, 1.5)).toBe(0.3)
    expect(stepRamp(0.3, false, 1e9, 2, 1.5)).toBe(0)
    expect(stepRamp(0.3, true, 1e9, 2, 1.5)).toBe(1)
  })

  it('stepStructuralBuild attacks instantly and releases linearly', () => {
    expect(stepStructuralBuild(0, 0.8, 1 / 60)).toBe(0.8)
    let v = 1
    for (let i = 0; i < 90; i++) v = stepStructuralBuild(v, 0, 1 / 60)
    expect(v).toBeCloseTo(0, 9) // 1.5 s release
    expect(stepStructuralBuild(0.6, 0, NaN)).toBe(0.6)
    expect(stepStructuralBuild(0.6, NaN, 0)).toBe(0.6) // NaN target counts as 0: holds, does not poison
    expect(stepStructuralBuild(NaN, 0.4, 1 / 60)).toBe(0.4)
  })

  it('stepAfterglow arms on the edge and decays linearly over its length', () => {
    expect(stepAfterglow(0, true, 1 / 60)).toBe(1)
    expect(stepAfterglow(0.3, true, NaN)).toBe(1)
    let a = 1
    for (let i = 0; i < 120; i++) a = stepAfterglow(a, false, 1 / 60)
    expect(a).toBeCloseTo(1 - 2 / AFTERGLOW.seconds, 9)
    for (let i = 0; i < 240; i++) a = stepAfterglow(a, false, 1 / 60)
    expect(a).toBe(0)
    expect(stepAfterglow(0.5, false, NaN)).toBe(0.5)
    expect(stepAfterglow(0.5, false, -1)).toBe(0.5)
  })
})

describe('intensityGate', () => {
  it('has the specified value for every legacy look state', () => {
    expect(intensityGate('silence')).toBe(0)
    expect(intensityGate('ambient')).toBe(0.35)
    expect(intensityGate('mellow')).toBe(0.35)
    expect(intensityGate('groove')).toBe(0.7)
    expect(intensityGate('building')).toBe(0.9)
    expect(intensityGate('peak')).toBe(1)
    expect(intensityGate('aggressive')).toBe(1)
  })

  it('covers every MoodState, in 0..1, rising with intensity', () => {
    for (const s of MOOD_STATES) expect(INTENSITY_GATE[s]).toBeGreaterThanOrEqual(0)
    for (const s of MOOD_STATES) expect(INTENSITY_GATE[s]).toBeLessThanOrEqual(1)
    const ordered: MoodState[] = ['silence', 'ambient', 'groove', 'building', 'peak']
    for (let i = 1; i < ordered.length; i++) expect(intensityGate(ordered[i])).toBeGreaterThan(intensityGate(ordered[i - 1]))
  })

  it('an unknown state counts as 1', () => {
    expect(intensityGate('nonsense' as MoodState)).toBe(1)
  })
})

describe('applyIntensityGate', () => {
  it('scales exactly the hard-effect propensities', () => {
    const before = richRow()
    const r = richRow()
    applyIntensityGate(r, 0.5)
    expect(r.lensEngage).toBeCloseTo(before.lensEngage * 0.5, 12)
    expect(r.mirrorEngage).toBeCloseTo(before.mirrorEngage * 0.5, 12)
    expect(r.fxShock).toBeCloseTo(before.fxShock * 0.5, 12)
    expect(r.fxFlare).toBeCloseTo(before.fxFlare * 0.5, 12)
    expect(r.fxSpark).toBeCloseTo(before.fxSpark * 0.5, 12)
    expect(r.fxStrobe).toBeCloseTo(before.fxStrobe * 0.5, 12)
    expect(r.caReact).toBeCloseTo(before.caReact * 0.5, 12)
    const gated = new Set(['lensEngage', 'mirrorEngage', 'fxShock', 'fxFlare', 'fxSpark', 'fxStrobe', 'caReact'])
    for (const key of Object.keys(before) as (keyof LookRow)[]) {
      if (!gated.has(key)) expect(r[key]).toEqual(before[key])
    }
  })

  it('gate 0 zeroes them, gate 1 (or more) is the identity, NaN counts as 0', () => {
    const z = richRow()
    applyIntensityGate(z, 0)
    for (const k of ['lensEngage', 'mirrorEngage', 'fxShock', 'fxFlare', 'fxSpark', 'fxStrobe', 'caReact'] as const) expect(z[k]).toBe(0)
    const a = richRow()
    applyIntensityGate(a, 1)
    expect(a).toEqual(richRow())
    const b = richRow()
    applyIntensityGate(b, 5)
    expect(b).toEqual(richRow())
    const n = richRow()
    applyIntensityGate(n, NaN)
    expect(n.lensEngage).toBe(0)
  })
})

describe('applyBuild', () => {
  it('is the identity at r = 0, negative or NaN', () => {
    const a = richRow()
    applyBuild(a, 0)
    applyBuild(a, -0.5)
    applyBuild(a, NaN)
    expect(a).toEqual(richRow())
  })

  it('adds the plan increments at r = 1', () => {
    const base = richRow()
    const r = richRow()
    applyBuild(r, 1)
    expect(r.bloomBase).toBeCloseTo(base.bloomBase + 0.15, 12)
    expect(r.trailsBase).toBeCloseTo(base.trailsBase + 0.1, 12)
    expect(r.trailsZoom).toBeCloseTo(base.trailsZoom * 2, 12)
    expect(r.echoGate).toBeCloseTo(base.echoGate + BUILD.echoGate, 12)
    expect(r.mirrorEngage).toBeCloseTo(base.mirrorEngage + BUILD.mirrorEngage, 12)
    expect(r.steerSpeed).toBeCloseTo(base.steerSpeed + 0.15, 12)
    expect(r.steerComplexity).toBeCloseTo(base.steerComplexity + 0.15, 12)
    expect(r.gradeSat).toBeCloseTo(base.gradeSat + 0.05, 12)
    expect(r.steerDensity).toBe(base.steerDensity) // not a build dial
  })

  it('weights only the hard lens styles by (1 + r)', () => {
    const base = richRow()
    const r = richRow()
    applyBuild(r, 0.5)
    for (const i of HARD_LENS_STYLES) expect(r.lensWeights[i]).toBeCloseTo(base.lensWeights[i] * 1.5, 12)
    for (const i of [LENS.ribs, LENS.fan, LENS.anamorphic, LENS.melt, LENS.pixels, LENS.flyEye]) {
      expect(r.lensWeights[i]).toBe(base.lensWeights[i])
    }
  })

  it('a mood with no hard lens weight gets none from a build', () => {
    const r = richRow()
    r.lensWeights = [0.5, 0.5, 0, 0, 0, 0, 0, 0]
    applyBuild(r, 1)
    expect(r.lensWeights).toEqual([0.5, 0.5, 0, 0, 0, 0, 0, 0])
  })

  it('is monotone in r for every field it raises', () => {
    let prev = richRow()
    for (const r of sweep(20)) {
      const cur = richRow()
      applyBuild(cur, r)
      expect(cur.bloomBase).toBeGreaterThanOrEqual(prev.bloomBase)
      expect(cur.trailsBase).toBeGreaterThanOrEqual(prev.trailsBase)
      expect(cur.trailsZoom).toBeGreaterThanOrEqual(prev.trailsZoom)
      expect(cur.echoGate).toBeGreaterThanOrEqual(prev.echoGate)
      expect(cur.mirrorEngage).toBeGreaterThanOrEqual(prev.mirrorEngage)
      expect(cur.steerSpeed).toBeGreaterThanOrEqual(prev.steerSpeed)
      expect(cur.steerComplexity).toBeGreaterThanOrEqual(prev.steerComplexity)
      expect(cur.gradeSat).toBeGreaterThanOrEqual(prev.gradeSat)
      expect(cur.lensWeights[LENS.glitch]).toBeGreaterThanOrEqual(prev.lensWeights[LENS.glitch])
      expect(cur.lensWeights[LENS.pixelSort]).toBeGreaterThanOrEqual(prev.lensWeights[LENS.pixelSort])
      if (r > 0.5) expect(cur.mirrorSegments[2]).toBeGreaterThanOrEqual(prev.mirrorSegments[2]) // 8 segments, once past the 6 stage
      expect(cur.cameraWeights[2]).toBeGreaterThanOrEqual(prev.cameraWeights[2]) // push
      prev = cur
    }
  })

  it('steps the mirror segments 4 -> 6 -> 8 as r rises, preserving the total', () => {
    const argmax = (a: number[]) => a.indexOf(Math.max(...a))
    const lo = richRow()
    applyBuild(lo, 0.02)
    expect(argmax(lo.mirrorSegments)).toBe(0) // still the row's own lean toward 4
    const mid = richRow()
    applyBuild(mid, 0.5)
    expect(argmax(mid.mirrorSegments)).toBe(1) // 6
    const hi = richRow()
    applyBuild(hi, 1)
    expect(argmax(hi.mirrorSegments)).toBe(2) // 8
    for (const r of sweep(10)) {
      const c = richRow()
      applyBuild(c, r)
      expect(sum(c.mirrorSegments)).toBeCloseTo(1, 12)
    }
  })

  it('pushes the camera toward push, total preserved', () => {
    const base = richRow()
    const r = richRow()
    applyBuild(r, 1)
    expect(r.cameraWeights[2]).toBeGreaterThan(base.cameraWeights[2])
    expect(sum(r.cameraWeights)).toBeCloseTo(sum(base.cameraWeights), 12)
  })

  it('never raises any effect propensity, and above all not the strobe', () => {
    for (const r of sweep(20)) {
      const base = richRow()
      const cur = richRow()
      applyBuild(cur, r)
      expect(cur.fxStrobe).toBe(base.fxStrobe)
      expect(cur.fxShock).toBe(base.fxShock)
      expect(cur.fxFlare).toBe(base.fxFlare)
      expect(cur.fxSpark).toBe(base.fxSpark)
      expect(cur.lensEngage).toBe(base.lensEngage)
    }
  })

  it('treats r above 1 as 1, and caps values that would leave their range', () => {
    const a = richRow()
    const b = richRow()
    applyBuild(a, 9)
    applyBuild(b, 1)
    expect(a).toEqual(b)
    const hi = richRow()
    hi.bloomBase = 0.95
    hi.steerSpeed = 0.95
    hi.mirrorEngage = 0.85
    hi.trailsBase = 0.95
    hi.echoGate = 0.9
    hi.gradeSat = 1.38
    applyBuild(hi, 1)
    expect(hi.bloomBase).toBeLessThanOrEqual(1)
    expect(hi.steerSpeed).toBeLessThanOrEqual(1)
    expect(hi.mirrorEngage).toBeLessThanOrEqual(0.9)
    expect(hi.trailsBase).toBeLessThanOrEqual(1)
    expect(hi.echoGate).toBeLessThanOrEqual(1)
    expect(hi.gradeSat).toBeLessThanOrEqual(1.4)
  })
})

describe('applyAfterglow', () => {
  it('is the identity at 0', () => {
    const a = richRow()
    applyAfterglow(a, 0)
    applyAfterglow(a, NaN)
    expect(a).toEqual(richRow())
  })

  it('at 1: 8-segment mirror, saturation +.1, contrast +.05', () => {
    const base = richRow()
    const r = richRow()
    applyAfterglow(r, 1)
    expect(r.mirrorSegments[2]).toBeCloseTo(sum(base.mirrorSegments), 12) // all the mass on 8
    expect(r.mirrorSegments[0]).toBeCloseTo(0, 12)
    expect(r.mirrorSegments[1]).toBeCloseTo(0, 12)
    expect(r.gradeSat).toBeCloseTo(base.gradeSat + 0.1, 12)
    expect(r.gradeContrast).toBeCloseTo(base.gradeContrast + 0.05, 12)
    expect(r.mirrorEngage).toBeGreaterThan(base.mirrorEngage)
  })

  it('is proportional to the afterglow and so decays with it', () => {
    const base = richRow()
    let prevSat = Infinity
    let prev8 = Infinity
    for (const a of [1, 0.75, 0.5, 0.25, 0]) {
      const r = richRow()
      applyAfterglow(r, a)
      expect(r.gradeSat).toBeCloseTo(base.gradeSat + 0.1 * a, 12)
      expect(r.gradeContrast).toBeCloseTo(base.gradeContrast + 0.05 * a, 12)
      expect(r.gradeSat).toBeLessThanOrEqual(prevSat)
      expect(r.mirrorSegments[2]).toBeLessThanOrEqual(prev8)
      expect(sum(r.mirrorSegments)).toBeCloseTo(1, 12)
      prevSat = r.gradeSat
      prev8 = r.mirrorSegments[2]
    }
  })

  it('leaves the strobe and the rest of the row alone', () => {
    const base = richRow()
    const r = richRow()
    applyAfterglow(r, 1)
    expect(r.fxStrobe).toBe(base.fxStrobe)
    expect(r.bloomBase).toBe(base.bloomBase)
    expect(r.lensWeights).toEqual(base.lensWeights)
  })
})

describe('applyBreakdown', () => {
  it('is the identity at 0', () => {
    const a = richRow()
    applyBreakdown(a, 0, 0)
    applyBreakdown(a, NaN, 1)
    expect(a).toEqual(richRow())
  })

  it('at b = 1: bloom x.7, trails +.15, echo 0, steer -.2, fog +.15, mirror off for a non-calm mood', () => {
    const base = richRow()
    const r = richRow()
    applyBreakdown(r, 1, 0)
    expect(r.bloomBase).toBeCloseTo(base.bloomBase * 0.7, 12)
    expect(r.trailsBase).toBeCloseTo(base.trailsBase + 0.15, 12)
    expect(r.echoGate).toBe(0)
    expect(r.steerSpeed).toBeCloseTo(base.steerSpeed - 0.2, 12)
    expect(r.steerDensity).toBeCloseTo(base.steerDensity - 0.2, 12)
    expect(r.steerComplexity).toBe(base.steerComplexity)
    expect(r.fogBase).toBeCloseTo(base.fogBase + 0.15, 12)
    expect(r.mirrorEngage).toBe(0)
  })

  it('restricts the lens weights to the soft styles, preserving the total', () => {
    const base = richRow()
    const r = richRow()
    applyBreakdown(r, 1, 0)
    for (let i = 0; i < r.lensWeights.length; i++) {
      if (!SOFT_LENS_STYLES.includes(i)) expect(r.lensWeights[i]).toBeCloseTo(0, 12)
    }
    for (const i of SOFT_LENS_STYLES) expect(r.lensWeights[i]).toBeGreaterThan(base.lensWeights[i])
    expect(sum(r.lensWeights)).toBeCloseTo(sum(base.lensWeights), 12)
    // proportional among the soft styles
    expect(r.lensWeights[LENS.anamorphic] / r.lensWeights[LENS.ribs]).toBeCloseTo(base.lensWeights[LENS.anamorphic] / base.lensWeights[LENS.ribs], 9)
  })

  it('a hard-only lens mood still ends up with usable soft weights', () => {
    const r = richRow()
    r.lensWeights = [0, 0, 0, 0, 0.5, 0, 0, 0.5]
    applyBreakdown(r, 1, 0)
    for (const i of SOFT_LENS_STYLES) expect(r.lensWeights[i]).toBeGreaterThan(0)
    for (const i of HARD_LENS_STYLES) expect(r.lensWeights[i]).toBeCloseTo(0, 12)
    expect(sum(r.lensWeights)).toBeCloseTo(1, 12)
  })

  it('a half breakdown moves half of the non-soft mass', () => {
    const base = richRow()
    const r = richRow()
    applyBreakdown(r, 0.5, 0)
    expect(r.lensWeights[LENS.glitch]).toBeCloseTo(base.lensWeights[LENS.glitch] * 0.5, 12)
    expect(r.lensWeights[LENS.pixels]).toBeCloseTo(base.lensWeights[LENS.pixels] * 0.5, 12)
  })

  it('keeps the mirror for a calm-mirror mood but slows its spin', () => {
    const base = richRow()
    const r = richRow()
    applyBreakdown(r, 1, 1)
    expect(r.mirrorEngage).toBe(base.mirrorEngage)
    expect(r.mirrorSpinMax).toBeCloseTo(BREAKDOWN.slowSpinMax, 12)
    expect(r.mirrorSpinMin).toBeLessThanOrEqual(r.mirrorSpinMax)
    const half = richRow()
    applyBreakdown(half, 1, 0.5)
    expect(half.mirrorEngage).toBeCloseTo(base.mirrorEngage * 0.5, 12)
  })

  it('never slows a spin that is already slower, and never drives steer negative', () => {
    const r = richRow()
    r.mirrorSpinMin = 0.02
    r.mirrorSpinMax = 0.05
    r.steerSpeed = 0.1
    r.steerDensity = 0.05
    applyBreakdown(r, 1, 1)
    expect(r.mirrorSpinMax).toBeCloseTo(0.05, 12) // slow spin cap 0.12 is above it: unchanged
    expect(r.mirrorSpinMin).toBeCloseTo(0.02, 12)
    expect(r.steerSpeed).toBe(0)
    expect(r.steerDensity).toBe(0)
  })

  it('pulls the camera toward hover, total preserved', () => {
    const base = richRow()
    const r = richRow()
    applyBreakdown(r, 1, 0)
    expect(r.cameraWeights.indexOf(Math.max(...r.cameraWeights))).toBe(1)
    expect(sum(r.cameraWeights)).toBeCloseTo(sum(base.cameraWeights), 12)
  })

  it('is monotone in b', () => {
    let prev = richRow()
    for (const b of sweep(20)) {
      const cur = richRow()
      applyBreakdown(cur, b, 0)
      expect(cur.bloomBase).toBeLessThanOrEqual(prev.bloomBase)
      expect(cur.echoGate).toBeLessThanOrEqual(prev.echoGate)
      expect(cur.mirrorEngage).toBeLessThanOrEqual(prev.mirrorEngage)
      expect(cur.steerSpeed).toBeLessThanOrEqual(prev.steerSpeed)
      expect(cur.lensWeights[LENS.glitch]).toBeLessThanOrEqual(prev.lensWeights[LENS.glitch])
      expect(cur.trailsBase).toBeGreaterThanOrEqual(prev.trailsBase)
      expect(cur.fogBase).toBeGreaterThanOrEqual(prev.fogBase)
      expect(cur.lensWeights[LENS.ribs]).toBeGreaterThanOrEqual(prev.lensWeights[LENS.ribs])
      prev = cur
    }
  })

  it('adds no strobe or other flash source', () => {
    const base = richRow()
    const r = richRow()
    applyBreakdown(r, 1, 0)
    expect(r.fxStrobe).toBe(base.fxStrobe)
    expect(r.fxShock).toBe(base.fxShock)
  })
})

describe('calmMirrorShare', () => {
  const onehot = (mood: (typeof CHARACTER_MOODS)[number]) => CHARACTER_MOODS.map((m) => (m === mood ? 1 : 0))

  it('is 1 on dreamy / serene / mysterious and 0 elsewhere', () => {
    for (const m of ['dreamy', 'serene', 'mysterious'] as const) expect(calmMirrorShare(onehot(m))).toBe(1)
    for (const m of CHARACTER_MOODS) {
      if (m === 'dreamy' || m === 'serene' || m === 'mysterious') continue
      expect(calmMirrorShare(onehot(m))).toBe(0)
    }
  })

  it('adds the shares of the calm moods and tolerates junk', () => {
    const w = CHARACTER_MOODS.map(() => 0)
    w[CHARACTER_MOODS.indexOf('dreamy')] = 0.25
    w[CHARACTER_MOODS.indexOf('serene')] = 0.15
    w[CHARACTER_MOODS.indexOf('tense')] = 0.6
    expect(calmMirrorShare(w)).toBeCloseTo(0.4, 12)
    w[CHARACTER_MOODS.indexOf('mysterious')] = NaN
    expect(calmMirrorShare(w)).toBeCloseTo(0.4, 12)
    expect(calmMirrorShare([])).toBe(0)
  })
})

describe('applyDescriptors', () => {
  const FIELDS = ['lensEngage', 'caBase', 'trailsBase', 'mirrorEngage', 'steerComplexity', 'steerDensity', 'fogBase', 'echoGate', 'steerSpeed'] as const
  const levels = [0, 0.25, 0.5, 0.75, 1]

  it('is the identity at the neutral descriptors (and for NaN)', () => {
    const a = richRow()
    applyDescriptors(a, 0.5, 0.5, 0.5)
    expect(a).toEqual(richRow())
    const b = richRow()
    applyDescriptors(b, NaN, NaN, NaN)
    expect(b).toEqual(richRow())
  })

  it('keeps every affected field within +-40% over the whole descriptor cube', () => {
    const base = richRow()
    for (const h of levels)
      for (const b of levels)
        for (const s of levels) {
          const r = richRow()
          applyDescriptors(r, h, b, s)
          for (const f of FIELDS) {
            const ratio = r[f] / base[f]
            expect(ratio).toBeGreaterThanOrEqual(1 - DESCRIPTOR.bound - 1e-12)
            expect(ratio).toBeLessThanOrEqual(1 + DESCRIPTOR.bound + 1e-12)
          }
          // lens style mass moves by at most 40% of the soft share, and the total is preserved
          expect(sum(r.lensWeights)).toBeCloseTo(sum(base.lensWeights), 12)
          const softNow = sum(SOFT_LENS_STYLES.map((i) => r.lensWeights[i]))
          const softBase = sum(SOFT_LENS_STYLES.map((i) => base.lensWeights[i]))
          expect(softNow).toBeGreaterThanOrEqual(softBase * (1 - DESCRIPTOR.harshLensShift) - 1e-12)
        }
  })

  it('harsh: lensEngage x(0.6 + 0.8 harsh); more CA, less trails, more hard lens weight, monotonically', () => {
    let prev: LookRow | null = null
    for (const h of sweep(20)) {
      const r = richRow()
      applyDescriptors(r, h, 0.5, 0.5)
      expect(r.lensEngage / 0.5).toBeCloseTo(0.6 + 0.8 * h, 12)
      const hard = r.lensWeights[LENS.glitch] + r.lensWeights[LENS.pixelSort]
      if (prev !== null) {
        expect(r.lensEngage).toBeGreaterThanOrEqual(prev.lensEngage)
        expect(r.caBase).toBeGreaterThanOrEqual(prev.caBase)
        expect(r.trailsBase).toBeLessThanOrEqual(prev.trailsBase)
        expect(hard).toBeGreaterThanOrEqual(prev.lensWeights[LENS.glitch] + prev.lensWeights[LENS.pixelSort])
      }
      prev = r
    }
  })

  it('harsh = 1 moves 40% of the soft lens weight onto pixel sort and glitch', () => {
    const base = richRow()
    const r = richRow()
    applyDescriptors(r, 1, 0.5, 0.5)
    const softBase = sum(SOFT_LENS_STYLES.map((i) => base.lensWeights[i]))
    const hardBase = sum(HARD_LENS_STYLES.map((i) => base.lensWeights[i]))
    const softNow = sum(SOFT_LENS_STYLES.map((i) => r.lensWeights[i]))
    const hardNow = sum(HARD_LENS_STYLES.map((i) => r.lensWeights[i]))
    expect(softNow).toBeCloseTo(softBase * 0.6, 12)
    expect(hardNow).toBeCloseTo(hardBase + softBase * 0.4, 12)
    expect(r.lensWeights[LENS.pixels]).toBe(base.lensWeights[LENS.pixels]) // neither hard nor soft
  })

  it('harsh = 0 hands 40% of the hard lens weight back to the soft styles', () => {
    const base = richRow()
    const r = richRow()
    applyDescriptors(r, 0, 0.5, 0.5)
    const hardBase = sum(HARD_LENS_STYLES.map((i) => base.lensWeights[i]))
    expect(sum(HARD_LENS_STYLES.map((i) => r.lensWeights[i]))).toBeCloseTo(hardBase * 0.6, 12)
    expect(sum(r.lensWeights)).toBeCloseTo(sum(base.lensWeights), 12)
  })

  it('harsh on a mood with no soft lens weight changes no weights, and with none at all changes none', () => {
    const r = richRow()
    r.lensWeights = [0, 0, 0, 0, 0.5, 0, 0, 0.5]
    applyDescriptors(r, 1, 0.5, 0.5)
    expect(r.lensWeights).toEqual([0, 0, 0, 0, 0.5, 0, 0, 0.5])
    const s = richRow()
    s.lensWeights = [0.5, 0.5, 0, 0, 0, 0, 0, 0]
    applyDescriptors(s, 0, 0.5, 0.5)
    expect(s.lensWeights).toEqual([0.5, 0.5, 0, 0, 0, 0, 0, 0])
  })

  it('busy: more mirror engage (by the row gain), steer complexity and density, monotonically', () => {
    let prev: LookRow | null = null
    for (const b of sweep(20)) {
      const r = richRow()
      applyDescriptors(r, 0.5, b, 0.5)
      if (prev !== null) {
        expect(r.mirrorEngage).toBeGreaterThanOrEqual(prev.mirrorEngage)
        expect(r.steerComplexity).toBeGreaterThanOrEqual(prev.steerComplexity)
        expect(r.steerDensity).toBeGreaterThanOrEqual(prev.steerDensity)
      }
      prev = r
    }
    const lo = richRow()
    applyDescriptors(lo, 0.5, 0, 0.5)
    const hi = richRow()
    applyDescriptors(hi, 0.5, 1, 0.5)
    expect(hi.mirrorEngage / lo.mirrorEngage).toBeCloseTo(1.4 / 0.6, 9)
  })

  it('busy has no effect on the mirror when the row gain is 0, and half the swing at gain 0.5', () => {
    const none = richRow()
    none.mirrorBusyGain = 0
    applyDescriptors(none, 0.5, 1, 0.5)
    expect(none.mirrorEngage).toBe(0.4)
    const half = richRow()
    half.mirrorBusyGain = 0.5
    applyDescriptors(half, 0.5, 1, 0.5)
    expect(half.mirrorEngage / 0.4).toBeCloseTo(1.2, 12)
  })

  it('sparse: more fog and trails, less echo gate and steer speed, monotonically', () => {
    let prev: LookRow | null = null
    for (const s of sweep(20)) {
      const r = richRow()
      applyDescriptors(r, 0.5, 0.5, s)
      if (prev !== null) {
        expect(r.fogBase).toBeGreaterThanOrEqual(prev.fogBase)
        expect(r.trailsBase).toBeGreaterThanOrEqual(prev.trailsBase)
        expect(r.echoGate).toBeLessThanOrEqual(prev.echoGate)
        expect(r.steerSpeed).toBeLessThanOrEqual(prev.steerSpeed)
      }
      prev = r
    }
  })

  it('never turns on a dial the mood does not use (0 stays 0)', () => {
    for (const h of levels)
      for (const b of levels)
        for (const s of levels) {
          const r = richRow()
          r.lensEngage = 0
          r.mirrorEngage = 0
          r.fogBase = 0
          r.echoGate = 0
          r.caBase = 0
          applyDescriptors(r, h, b, s)
          expect(r.lensEngage).toBe(0)
          expect(r.mirrorEngage).toBe(0)
          expect(r.fogBase).toBe(0)
          expect(r.echoGate).toBe(0)
          expect(r.caBase).toBe(0)
        }
  })

  it('touches nothing outside its own dials (bloom, grade, fx propensities, camera, transitions)', () => {
    const base = richRow()
    const r = richRow()
    applyDescriptors(r, 1, 1, 1)
    for (const k of ['bloomBase', 'bloomReact', 'vignette', 'gradeSat', 'gradeTemp', 'gradeContrast', 'fxShock', 'fxFlare', 'fxSpark', 'fxStrobe', 'caReact', 'cameraSpeed'] as const) {
      expect(r[k]).toBe(base[k])
    }
    expect(r.cameraWeights).toEqual(base.cameraWeights)
    expect(r.transitionWeights).toEqual(base.transitionWeights)
    expect(r.mirrorSegments).toEqual(base.mirrorSegments)
  })

  it('caps a probability instead of exceeding it', () => {
    const r = richRow()
    r.lensEngage = 0.8
    r.mirrorEngage = 0.88
    applyDescriptors(r, 1, 1, 0.5)
    expect(r.lensEngage).toBeLessThanOrEqual(0.85)
    expect(r.mirrorEngage).toBeLessThanOrEqual(0.9)
  })
})

describe('constants', () => {
  it('match the plan', () => {
    expect(BUILD.bloom).toBe(0.15)
    expect(BUILD.trails).toBe(0.1)
    expect(BUILD.steer).toBe(0.15)
    expect(BUILD.gradeSat).toBe(0.05)
    expect(BUILD_INTENT.legacyCap).toBe(0.5)
    expect(BUILD_INTENT.legacyAttackSec).toBe(2)
    expect(BUILD_INTENT.legacyReleaseSec).toBe(1.5)
    expect(AFTERGLOW.seconds).toBe(4)
    expect(AFTERGLOW.gradeSat).toBe(0.1)
    expect(AFTERGLOW.gradeContrast).toBe(0.05)
    expect(BREAKDOWN.bloomScale).toBe(0.7)
    expect(BREAKDOWN.trails).toBe(0.15)
    expect(BREAKDOWN.steer).toBe(0.2)
    expect(BREAKDOWN.fog).toBe(0.15)
    expect(DESCRIPTOR.bound).toBe(0.4)
  })
})

describe('per-frame code', () => {
  it('contains no allocating constructs', () => {
    const src = hotPath(MODIFIERS_SRC)
    expect(src.length).toBeGreaterThan(500) // the markers were found
    expect(findAllocations(src)).toEqual([])
  })

  it('the detector itself flags the constructs it is there to catch', () => {
    const bad = [
      'const a = new Foo()',
      'f(...xs)',
      'xs.map((x) => x)',
      'const a = [1, 2]',
      'return [1]',
      'const o = { a: 1 }',
      'return { a: 1 }',
      'const s = `x`',
      'Object.keys(o)',
      'const f = function (x) { return x }',
      'ys.slice(1)',
    ]
    const region = (snippet: string) => hotPath(['// @hot-path:begin', snippet, '// @hot-path:end'].join('\n'))
    for (const snippet of bad) expect(findAllocations(region(snippet)).length, snippet).toBeGreaterThan(0)
    const fine = [
      'w[i] = x[j][k] + w[SOFT[j]]',
      'if (a) { b += 1 } else { b -= 1 }',
      'for (let i = 0; i < n; i++) { s += w[i] }',
      'function f(a: number): number { return a > 0 ? a : 0 }',
      'const r = a >= b ? a <= c : false // new [x] => y',
    ]
    for (const snippet of fine) expect(findAllocations(region(snippet)), snippet).toEqual([])
  })
})
