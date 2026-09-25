import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { SCENES } from '../index'
import {
  createInkFluidState,
  INK_MODES,
  LAYOUTS,
  MIN_SOURCES,
  sourceAt,
  stepInkFluid,
  stirAt,
  type InkAudio,
} from '../InkFluidScene'

/**
 * `inkfluid` was asked for with one requirement above the look: it must always
 * be FLUID. Its source's random button could land on a static blob (a reset
 * left on, a "still" layout, no ink, no force). The GPU solver cannot run here,
 * but every one of those failure modes is decided on the JS side — these pin
 * that no dial position and no audio can produce one, and that the audio
 * reaches the solver as a swell rather than a step.
 */

const DT = 1 / 60
const SILENCE: InkAudio = { energy: 0, mids: 0, highs: 0, kick: 0 }
const DEFAULTS = createInkFluidState()

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('inkfluid: no dial position can stop the tank', () => {
  const rng = mulberry32(11)
  const dials = [
    { speed: 0, shape: 0, density: 0, complexity: 0 },
    { speed: 0, shape: 1, density: 0, complexity: 0 },
    { speed: 1, shape: 1, density: 1, complexity: 1 },
    ...Array.from({ length: 200 }, () => ({
      speed: rng(),
      shape: rng(),
      density: rng(),
      complexity: rng(),
    })),
  ]

  it('keeps the clock, the forcing, the ink and the stirrer above their floors in silence', () => {
    for (const P of dials) {
      const st = createInkFluidState()
      for (let i = 0; i < 120; i++) stepInkFluid(st, SILENCE, P, DT)
      // The solver clock never stops: at worst 0.4x speed x 0.85 (no energy).
      expect(st.dt).toBeGreaterThanOrEqual(DT * 0.4 * 0.85 - 1e-9)
      expect(st.force).toBeGreaterThanOrEqual(DEFAULTS.force)
      expect(st.ink).toBeGreaterThanOrEqual(DEFAULTS.ink)
      expect(st.stirF).toBeGreaterThanOrEqual(DEFAULTS.stirF)
      expect(st.sources).toBeGreaterThanOrEqual(MIN_SOURCES)
      expect(st.sources).toBeLessThanOrEqual(8)
      expect(st.vort).toBeGreaterThan(0)
      expect(LAYOUTS[st.layout]).toBeDefined()
    }
  })

  it('has no "still" layout to land on', () => {
    expect(LAYOUTS as readonly string[]).not.toContain('still')
  })

  it('the forcing phase always advances, and wraps without leaving 0..1', () => {
    const st = createInkFluidState()
    let total = 0
    for (let i = 0; i < 60 * 60; i++) {
      const before = st.ph
      stepInkFluid(st, SILENCE, { speed: 0, shape: 0, density: 0, complexity: 0 }, DT)
      const d = (st.ph - before + 1) % 1
      expect(d).toBeGreaterThan(0)
      expect(st.ph).toBeGreaterThanOrEqual(0)
      expect(st.ph).toBeLessThan(1)
      total += d
    }
    // A minute at the slowest dial is still a sixth of a full forcing period.
    expect(total).toBeGreaterThan(0.15)
  })
})

describe('inkfluid: audio reaches the solver as a swell, never a step', () => {
  it('a one-frame kick attack spreads over several frames', () => {
    const st = createInkFluidState()
    const P = { speed: 0.5, shape: 0, density: 0.2, complexity: 0.5 }
    for (let i = 0; i < 60; i++) stepInkFluid(st, SILENCE, P, DT)
    const forces: number[] = [st.force]
    for (let i = 0; i < 30; i++) {
      stepInkFluid(st, { ...SILENCE, kick: 1.2 * Math.exp(-(i * DT) / 0.14) }, P, DT)
      forces.push(st.force)
    }
    const steps = forces.slice(1).map((f, i) => f - forces[i])
    const peak = Math.max(...forces) - forces[0]
    // A raw kick would take the whole surge (1.5x force) in its first frame.
    expect(steps[0]).toBeLessThan(0.2 * peak)
    expect(Math.max(...steps)).toBeLessThan(0.35 * peak)
    // ...and it is still a real surge, not smoothed away.
    expect(peak).toBeGreaterThan(0.5 * DEFAULTS.force)
  })

  it('noisy bands move the stirrer and the clock by a bounded amount per frame', () => {
    const rng = mulberry32(3)
    const st = createInkFluidState()
    const P = { speed: 0.5, shape: 0, density: 0.2, complexity: 0.5 }
    let prev = { stir: st.stirF, dt: 0, vort: st.vort }
    let maxStir = 0
    let maxDt = 0
    let maxVort = 0
    for (let i = 0; i < 600; i++) {
      stepInkFluid(st, { energy: rng() * 1.1, mids: rng(), highs: rng(), kick: 0 }, P, DT)
      if (i > 0) {
        maxStir = Math.max(maxStir, Math.abs(st.stirF - prev.stir))
        maxDt = Math.max(maxDt, Math.abs(st.dt - prev.dt))
        maxVort = Math.max(maxVort, Math.abs(st.vort - prev.vort))
      }
      prev = { stir: st.stirF, dt: st.dt, vort: st.vort }
    }
    // Raw bands re-rolled every frame would swing these by 0.9, ~0.008 and ~0.9.
    expect(maxStir).toBeLessThan(0.03)
    expect(maxDt).toBeLessThan(0.0005)
    expect(maxVort).toBeLessThan(0.05)
  })
})

describe('inkfluid: the forcing geometry', () => {
  const ASP = 16 / 9
  const pos = new THREE.Vector2()
  const dir = new THREE.Vector2()
  const pos2 = new THREE.Vector2()
  const dir2 = new THREE.Vector2()

  it('every emitter sits inside the tank and points somewhere', () => {
    for (let layout = 0; layout < LAYOUTS.length; layout++) {
      for (let n = MIN_SOURCES; n <= 8; n++) {
        for (let i = 0; i < n; i++) {
          for (let ph = 0; ph < 1; ph += 0.05) {
            sourceAt(layout, i, n, ph, ASP, pos, dir)
            expect(pos.x).toBeGreaterThanOrEqual(0)
            expect(pos.x).toBeLessThanOrEqual(ASP)
            expect(pos.y).toBeGreaterThanOrEqual(0)
            expect(pos.y).toBeLessThanOrEqual(1)
            // Unit jets everywhere but `wander`, whose direction the source
            // deliberately leaves unnormalised, so its jets pulse in strength.
            if (LAYOUTS[layout] === 'wander')
              expect(dir.length()).toBeLessThanOrEqual(Math.SQRT2 + 1e-9)
            else expect(dir.length()).toBeCloseTo(1, 6)
          }
        }
      }
    }
  })

  it('no emitter and no stirrer jumps across a period boundary', () => {
    // The source wrapped its clock here, and its wander layout's non-integer
    // harmonics made every emitter teleport once a period. The clock is now
    // unwrapped, so every layout is continuous across any whole cycle.
    for (let layout = 0; layout < LAYOUTS.length; layout++) {
      for (const cycle of [1, 7, 500]) {
        for (let i = 0; i < 4; i++) {
          sourceAt(layout, i, 4, cycle - 1e-6, ASP, pos, dir)
          sourceAt(layout, i, 4, cycle, ASP, pos2, dir2)
          expect(pos.distanceTo(pos2)).toBeLessThan(1e-3)
          expect(dir.distanceTo(dir2)).toBeLessThan(1e-3)
        }
      }
    }
    // The stirrer's harmonics are integers, so the wrapped phase is safe for it.
    expect(stirAt(1 - 1e-6, ASP, pos).distanceTo(stirAt(0, ASP, pos2))).toBeLessThan(1e-3)
  })
})

describe('inkfluid: registry', () => {
  it("declares exactly the modes the render shader's branches draw, in order", () => {
    const def = SCENES.find((s) => s.id === 'inkfluid')
    expect(def).toBeDefined()
    expect(def?.metadata.contract?.modes).toEqual(INK_MODES)
  })
})
