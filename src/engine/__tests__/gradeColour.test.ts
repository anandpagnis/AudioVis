import { describe, expect, it } from 'vitest'
import type { ShaderMaterial } from 'three'
import { GRADE_FRAG, GradePass, sanitizeGradeContrast, sanitizeGradeSat, sanitizeGradeTemp } from '../GradePass'
import { performanceState } from '../performanceState'
import {
  GRADE_LIMITS,
  GRADE_LUMA,
  GRADE_PIVOT,
  GRADE_SNAP,
  GRADE_TEMP_G,
  GradeResidualTracker,
  computeGradeResidual,
  paletteGradeTraits,
  type GradeLookInput,
} from '../look/gradeResidual'

/**
 * The GradePass side of the mood grade (P2). No GL context in this suite (vitest runs in `node`), same
 * posture as `gradeSharpen.test.ts` / `echoPass.test.ts`: what is checkable off-GPU is the JS that decides
 * what reaches the uniforms (clamps, the NaN guard, the identity / kill-switch behaviour of the executor)
 * and the shader SOURCE (stage order and the constants it shares with `gradeMath`). That the GLSL draws the
 * right pixels is not asserted here; `gradeResidual.test.ts` proves the maths on `gradeMath`, which mirrors
 * it operation for operation, and the constants below are what tie the two together.
 */

const DT = 1 / 60

// ---------------------------------------------------------------------------------------------------------
// sanitisers
// ---------------------------------------------------------------------------------------------------------

describe('sanitizeGrade* - identity and pass-through', () => {
  it('leaves exact identity exactly alone', () => {
    expect(sanitizeGradeSat(1)).toBe(1)
    expect(sanitizeGradeTemp(0)).toBe(0)
    expect(sanitizeGradeContrast(1)).toBe(1)
  })

  it('passes an in-range value through unchanged', () => {
    for (const v of [0.8, 0.9, 1.1, 1.2]) expect(sanitizeGradeSat(v)).toBe(v)
    for (const v of [-0.15, -0.08, 0.05, 0.15]) expect(sanitizeGradeTemp(v)).toBe(v)
    for (const v of [0.87, 0.95, 1.05, 1.15]) expect(sanitizeGradeContrast(v)).toBe(v)
  })
})

describe('sanitizeGrade* - clamps', () => {
  it('clamps saturation to +-25%', () => {
    expect(sanitizeGradeSat(0)).toBe(GRADE_LIMITS.satMin)
    expect(sanitizeGradeSat(-4)).toBe(GRADE_LIMITS.satMin)
    expect(sanitizeGradeSat(9)).toBe(GRADE_LIMITS.satMax)
    expect(GRADE_LIMITS.satMin).toBe(0.75)
    expect(GRADE_LIMITS.satMax).toBe(1.25)
  })

  it('clamps temperature to +-15%', () => {
    expect(sanitizeGradeTemp(9)).toBe(0.15)
    expect(sanitizeGradeTemp(-9)).toBe(-0.15)
    expect(sanitizeGradeTemp(0.1501)).toBe(0.15)
  })

  it('clamps contrast to +-15%', () => {
    expect(sanitizeGradeContrast(0.1)).toBe(0.85)
    expect(sanitizeGradeContrast(-3)).toBe(0.85)
    expect(sanitizeGradeContrast(9)).toBe(1.15)
  })

  it('never returns anything outside the limits, for any input', () => {
    const rnd = (i: number) => Math.sin(i * 12.9898) * 43758.5453
    for (let i = 0; i < 2000; i++) {
      const v = (rnd(i) % 1) * 10 ** ((i % 7) - 2) // spans tiny to huge, both signs
      const s = sanitizeGradeSat(v)
      const t = sanitizeGradeTemp(v)
      const c = sanitizeGradeContrast(v)
      expect(s).toBeGreaterThanOrEqual(GRADE_LIMITS.satMin)
      expect(s).toBeLessThanOrEqual(GRADE_LIMITS.satMax)
      expect(Math.abs(t)).toBeLessThanOrEqual(GRADE_LIMITS.tempMax)
      expect(c).toBeGreaterThanOrEqual(GRADE_LIMITS.contrastMin)
      expect(c).toBeLessThanOrEqual(GRADE_LIMITS.contrastMax)
    }
  })

  it('is monotone: a larger request never yields a smaller grade', () => {
    let ps = -Infinity
    let pt = -Infinity
    let pc = -Infinity
    for (let v = -2; v <= 3; v += 0.005) {
      const s = sanitizeGradeSat(v)
      const t = sanitizeGradeTemp(v - 1)
      const c = sanitizeGradeContrast(v)
      expect(s).toBeGreaterThanOrEqual(ps)
      expect(t).toBeGreaterThanOrEqual(pt)
      expect(c).toBeGreaterThanOrEqual(pc)
      ps = s
      pt = t
      pc = c
    }
  })
})

describe('sanitizeGrade* - NaN guard', () => {
  it('reads a non-finite value as IDENTITY, not as a limit', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(sanitizeGradeSat(bad)).toBe(1)
      expect(sanitizeGradeTemp(bad)).toBe(0)
      expect(sanitizeGradeContrast(bad)).toBe(1)
    }
  })
})

describe('sanitizeGrade* - snap to identity', () => {
  it('snaps values within the snap distance onto exact identity, so the shader branch can switch off', () => {
    expect(sanitizeGradeSat(1 + GRADE_SNAP.sat * 0.9)).toBe(1)
    expect(sanitizeGradeSat(1 - GRADE_SNAP.sat * 0.9)).toBe(1)
    expect(sanitizeGradeTemp(GRADE_SNAP.temp * 0.9)).toBe(0)
    expect(sanitizeGradeTemp(-GRADE_SNAP.temp * 0.9)).toBe(0)
    expect(sanitizeGradeContrast(1 + GRADE_SNAP.contrast * 0.9)).toBe(1)
    expect(sanitizeGradeContrast(1 - GRADE_SNAP.contrast * 0.9)).toBe(1)
  })

  it('does not snap a value that is genuinely off identity', () => {
    expect(sanitizeGradeSat(1 + GRADE_SNAP.sat * 1.5)).not.toBe(1)
    expect(sanitizeGradeTemp(GRADE_SNAP.temp * 1.5)).not.toBe(0)
    expect(sanitizeGradeContrast(1 - GRADE_SNAP.contrast * 1.5)).not.toBe(1)
  })

  it('never yields a negative zero (a uniform of -0 would fail the shader identity test in some drivers)', () => {
    expect(Object.is(sanitizeGradeTemp(-0), 0)).toBe(true)
    expect(Object.is(sanitizeGradeTemp(-GRADE_SNAP.temp / 2), 0)).toBe(true)
  })
})

// ---------------------------------------------------------------------------------------------------------
// GradePass.setGrade
// ---------------------------------------------------------------------------------------------------------

describe('GradePass.setGrade', () => {
  it('starts at identity with the stage off', () => {
    const pass = new GradePass()
    expect(pass.grade).toEqual({ sat: 1, temp: 0, contrast: 1 })
    expect(pass.gradeActive).toBe(false)
  })

  it('puts a sane grade on the uniforms and switches the stage on', () => {
    const pass = new GradePass()
    pass.setGrade(1.2, 0.1, 1.1)
    expect(pass.grade).toEqual({ sat: 1.2, temp: 0.1, contrast: 1.1 })
    expect(pass.gradeActive).toBe(true)
  })

  it('any single non-identity component is enough to switch the stage on', () => {
    const pass = new GradePass()
    pass.setGrade(1.1, 0, 1)
    expect(pass.gradeActive).toBe(true)
    pass.setGrade(1, 0.05, 1)
    expect(pass.gradeActive).toBe(true)
    pass.setGrade(1, 0, 1.1)
    expect(pass.gradeActive).toBe(true)
  })

  it('clamps out-of-range input on the way in', () => {
    const pass = new GradePass()
    pass.setGrade(9, -9, 0)
    expect(pass.grade).toEqual({ sat: GRADE_LIMITS.satMax, temp: -GRADE_LIMITS.tempMax, contrast: GRADE_LIMITS.contrastMin })
  })

  it('never lets a NaN or Infinity reach a uniform', () => {
    const pass = new GradePass()
    for (const bad of [NaN, Infinity, -Infinity]) {
      pass.setGrade(bad, bad, bad)
      const g = pass.grade
      expect(g).toEqual({ sat: 1, temp: 0, contrast: 1 })
      expect(pass.gradeActive).toBe(false)
    }
    pass.setGrade(1.2, 0.1, 1.1)
    pass.setGrade(NaN, NaN, NaN)
    expect(pass.grade).toEqual({ sat: 1, temp: 0, contrast: 1 })
  })

  it('returning to identity switches the stage off completely (strict no-op)', () => {
    const pass = new GradePass()
    pass.setGrade(1.2, 0.1, 1.1)
    pass.setGrade(1, 0, 1)
    expect(pass.gradeActive).toBe(false)
    expect(pass.grade).toEqual({ sat: 1, temp: 0, contrast: 1 })
  })

  it('holds the grade until it is set again (render() does not reset it)', () => {
    const pass = new GradePass()
    pass.setGrade(0.9, -0.05, 1.05)
    expect(pass.grade).toEqual({ sat: 0.9, temp: -0.05, contrast: 1.05 })
    expect(pass.grade).toEqual({ sat: 0.9, temp: -0.05, contrast: 1.05 })
  })
})

// ---------------------------------------------------------------------------------------------------------
// The executor rule, as PostFXChain runs it: tracker.update(look, palette, dt) then pass.setGrade(...)
// ---------------------------------------------------------------------------------------------------------

function feed(pass: GradePass, tracker: GradeResidualTracker, look: GradeLookInput, palette: string, seconds: number): void {
  const n = Math.round(seconds / DT)
  for (let i = 0; i < n; i++) {
    tracker.update(look, palette, DT)
    pass.setGrade(tracker.sat, tracker.temp, tracker.contrast)
  }
}

const row = (over: Partial<GradeLookInput> = {}): GradeLookInput => ({
  valid: true,
  families: { grade: true },
  gradeSat: 1.2,
  gradeTemp: 0.3,
  gradeContrast: 1.15,
  ...over,
})

describe('the executor feeds identity unless the look is valid AND the grade family is on', () => {
  it('feeds identity while look.valid is false, whatever the row asks for', () => {
    const pass = new GradePass()
    const tracker = new GradeResidualTracker()
    feed(pass, tracker, row({ valid: false, gradeSat: 1.25, gradeTemp: 1, gradeContrast: 1.3 }), 'ember', 10)
    expect(pass.grade).toEqual({ sat: 1, temp: 0, contrast: 1 })
    expect(pass.gradeActive).toBe(false)
  })

  it('feeds identity while families.grade is false (?look=-grade, ?scenepick=legacy)', () => {
    const pass = new GradePass()
    const tracker = new GradeResidualTracker()
    feed(pass, tracker, row({ families: { grade: false } }), 'pearl', 10)
    expect(pass.grade).toEqual({ sat: 1, temp: 0, contrast: 1 })
    expect(pass.gradeActive).toBe(false)
  })

  it('feeds identity for the untouched default look (valid is false until the bridge computes one)', () => {
    const pass = new GradePass()
    const tracker = new GradeResidualTracker()
    feed(pass, tracker, performanceState.look, 'aurora', 10)
    expect(performanceState.look.valid).toBe(false)
    expect(pass.gradeActive).toBe(false)
  })

  it('accepts the real LookProfile from performanceState and drives the pass when it is valid', () => {
    const look = performanceState.look
    const saved = { valid: look.valid, sat: look.gradeSat, temp: look.gradeTemp, contrast: look.gradeContrast, grade: look.families.grade }
    try {
      look.valid = true
      look.families.grade = true
      look.gradeSat = 1.2
      look.gradeTemp = 0.3
      look.gradeContrast = 1.15
      const pass = new GradePass()
      const tracker = new GradeResidualTracker()
      feed(pass, tracker, look, 'pearl', 8)
      const want = computeGradeResidual(1.2, 0.3, 1.15, paletteGradeTraits('pearl'))
      expect(pass.gradeActive).toBe(true)
      expect(pass.grade.sat).toBeCloseTo(want.sat, 6)
      expect(pass.grade.temp).toBeCloseTo(want.temp, 6)
      expect(pass.grade.contrast).toBeCloseTo(want.contrast, 6)

      // ...and the per-family kill switch takes it back to a strict no-op.
      look.families.grade = false
      feed(pass, tracker, look, 'pearl', 10)
      expect(pass.gradeActive).toBe(false)
      expect(pass.grade).toEqual({ sat: 1, temp: 0, contrast: 1 })
    } finally {
      look.valid = saved.valid
      look.gradeSat = saved.sat
      look.gradeTemp = saved.temp
      look.gradeContrast = saved.contrast
      look.families.grade = saved.grade
    }
  })

  it('applies a valid look on a neutral palette, inside every clamp, and never on the way there exceeds them', () => {
    const pass = new GradePass()
    const tracker = new GradeResidualTracker()
    const lk = row({ gradeSat: 1.3, gradeTemp: 0.6, gradeContrast: 1.3 })
    for (let i = 0; i < 60 * 6; i++) {
      tracker.update(lk, 'mono', DT)
      pass.setGrade(tracker.sat, tracker.temp, tracker.contrast)
      const g = pass.grade
      expect(g.sat).toBeLessThanOrEqual(GRADE_LIMITS.satMax)
      expect(g.temp).toBeLessThanOrEqual(GRADE_LIMITS.tempMax)
      expect(g.contrast).toBeLessThanOrEqual(GRADE_LIMITS.contrastMax)
      expect(g.sat).toBeGreaterThanOrEqual(1)
    }
    expect(pass.gradeActive).toBe(true)
    expect(pass.grade.sat).toBe(GRADE_LIMITS.satMax)
    expect(pass.grade.temp).toBe(GRADE_LIMITS.tempMax)
    expect(pass.grade.contrast).toBe(GRADE_LIMITS.contrastMax)
  })

  it('a palette switch under a steady look moves the uniforms gradually (no pop at the GPU boundary)', () => {
    const pass = new GradePass()
    const tracker = new GradeResidualTracker()
    const lk = row({ gradeSat: 1.2, gradeTemp: 0.3, gradeContrast: 1.1 })
    feed(pass, tracker, lk, 'ember', 8)
    const before = pass.grade
    tracker.update(lk, 'ocean', DT)
    pass.setGrade(tracker.sat, tracker.temp, tracker.contrast)
    const after = pass.grade
    // ember -> ocean turns "warmth already carried" into "warmth needed" (0 -> +0.129 on temp). One frame later
    // it must have moved by a few percent of that, not all of it.
    expect(Math.abs(after.temp - before.temp)).toBeLessThan(0.005)
    expect(Math.abs(after.sat - before.sat)).toBeLessThan(0.01)
    expect(Math.abs(after.contrast - before.contrast)).toBeLessThan(0.01)
  })
})

// ---------------------------------------------------------------------------------------------------------
// The shader source
// ---------------------------------------------------------------------------------------------------------

describe('GRADE_FRAG structure', () => {
  const at = (s: string) => {
    const i = GRADE_FRAG.indexOf(s)
    expect(i, `expected the shader to contain: ${s}`).toBeGreaterThanOrEqual(0)
    return i
  }

  it('runs sharpen, then gain, then the mood grade, then the fog, then the colour-space conversion', () => {
    const sharpen = at('col = casSharpen(uv, col)')
    const gain = at('col *= uGain')
    const grade = at('col = moodGrade(col)')
    const fog = at('if (uFog > 0.0001)')
    const output = at('#include <colorspace_fragment>')
    expect(sharpen).toBeLessThan(gain)
    expect(gain).toBeLessThan(grade)
    expect(grade).toBeLessThan(fog)
    expect(fog).toBeLessThan(output)
  })

  it('does not resample a resting frame: the build push-in is a no-op at uIris 0 (F272)', () => {
    expect(GRADE_FRAG).toMatch(/vec2 uv = uIris > 0\.0 \? \(vUv - 0\.5\) \* \(1\.0 - uIris \* 0\.04\) \+ 0\.5 : vUv;/)
  })

  it('ramps the sharpen lobe in from zero rather than switching it on (F272)', () => {
    expect(GRADE_FRAG).toMatch(/smoothstep\(0\.0, 0\.1, uSharpen\)/)
  })

  it('skips the whole stage on a uniform branch at identity', () => {
    const guard = at('if (uGradeSat != 1.0 || uGradeTemp != 0.0 || uGradeContrast != 1.0) col = moodGrade(col)')
    expect(guard).toBeGreaterThan(at('col *= uGain'))
  })

  it('declares the three uniforms and the moodGrade function', () => {
    for (const name of ['uGradeSat', 'uGradeTemp', 'uGradeContrast']) at(`uniform float ${name};`)
    at('vec3 moodGrade(vec3 c)')
  })

  it('gives every declared uniform a JS value (a declared-but-unset uniform is a black frame)', () => {
    const pass = new GradePass()
    const material = (pass as unknown as { material: ShaderMaterial }).material
    const declared = [...GRADE_FRAG.matchAll(/uniform\s+\w+\s+(\w+);/g)].map((m) => m[1])
    expect(declared.length).toBe(11)
    for (const name of declared) expect(Object.keys(material.uniforms), name).toContain(name)
  })

  it('carries the SAME constants as gradeMath (interpolated, so they cannot drift)', () => {
    at(String(GRADE_LUMA[0]))
    at(String(GRADE_LUMA[1]))
    at(String(GRADE_LUMA[2]))
    at(String(GRADE_TEMP_G))
    at(`lc / ${GRADE_PIVOT}`)
  })

  it('is well-formed: no leaked template holes and no integer literal where a float is needed', () => {
    expect(GRADE_FRAG).not.toMatch(/undefined|NaN|\$\{|\[object/)
    // Every literal the grade interpolates carries a decimal point or an exponent.
    const gradeFn = GRADE_FRAG.slice(GRADE_FRAG.indexOf('vec3 moodGrade'), GRADE_FRAG.indexOf('varying vec2 vUv'))
    expect(gradeFn).not.toMatch(/[^\w.]\d+(?![\w.])/)
  })

  it('has no additive offset in the grade: temperature and contrast only multiply, saturation only mixes', () => {
    const gradeFn = GRADE_FRAG.slice(GRADE_FRAG.indexOf('vec3 moodGrade'), GRADE_FRAG.indexOf('varying vec2 vUv'))
    // The AgX lesson (see GradePass's header): nothing here may add a signed term to the colour.
    expect(gradeFn).not.toMatch(/c\s*\+=/)
    expect(gradeFn).not.toMatch(/c\s*-=/)
    expect(gradeFn).toMatch(/c \*= vec3\(/)
    expect(gradeFn).toMatch(/mix\(vec3\(l\), c, s\)/)
    expect(gradeFn).toMatch(/return max\(c, vec3\(0\.0\)\)/)
  })
})
