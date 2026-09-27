import { describe, expect, it } from 'vitest'
import {
  createMothWingsState,
  FLAP_DEPTH_ENERGY,
  FLAP_DEPTH_FLOOR,
  FLAP_DEPTH_SURGE,
  MORPH_FLOOR,
  MORPH_MIDS,
  MORPH_SPD,
  MORPH_SURGE,
  stepMothWings,
  type MothWingsAudio,
} from '../MothWingsScene'

/**
 * `mothwings` was asked for with one hard requirement beyond the look: its
 * audio response must FLOW, not jitter. These pin that property on the JS side,
 * where it is decided — the shader only draws whatever these values say.
 *
 * The input is deliberately hostile: band levels re-rolled uniformly EVERY
 * frame (far noisier than any real analysis), a 174 BPM kick train whose
 * envelope attacks in a single frame, and hard jumps between silence and full
 * level. Each bound below is stated against what the same signal would do if it
 * reached a uniform raw, so a regression to a raw mapping fails loudly.
 */

const TAU = Math.PI * 2
const DT = 1 / 60
const NEUTRAL = { speed: 0.5, fill: 0.5 }
/** The scene's camera anchor distance, straight on: camera zoom 1, no sway. */
const CAM = { x: 0, y: 1.5, z: Math.sqrt(100 - 1.5 * 1.5) }

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

/** Signed shortest difference on a circle of the given period. */
function wrapDiff(b: number, a: number, period: number): number {
  let d = (b - a) % period
  if (d > period / 2) d -= period
  if (d < -period / 2) d += period
  return d
}

/** 30 s of hostile audio: noisy bands, a hard kick train, silence/full jumps every 2 s. */
function hostileAudio(frames: number): MothWingsAudio[] {
  const rng = mulberry32(7)
  const beat = 60 / 174
  const out: MothWingsAudio[] = []
  for (let i = 0; i < frames; i++) {
    const t = i * DT
    const loud = Math.floor(t / 2) % 2 === 0 ? 1 : 0
    const sinceKick = t % beat
    out.push({
      energy: loud * rng() * 1.1,
      mids: loud * rng(),
      highs: loud * rng(),
      kick: loud * 1.2 * Math.exp(-sinceKick / 0.14),
    })
  }
  return out
}

describe('mothwings: audio response flows', () => {
  const FRAMES = 30 * 60
  const audio = hostileAudio(FRAMES)
  const st = createMothWingsState()
  const morph: number[] = []
  const travel: number[] = []
  const zoom: number[] = []
  const bright: number[] = []
  for (const a of audio) {
    stepMothWings(st, a, NEUTRAL, CAM, DT)
    morph.push(st.morph)
    travel.push(st.travel)
    zoom.push(st.zoom)
    bright.push(st.bright)
  }
  const steps = (xs: number[], period: number) =>
    xs.slice(1).map((x, i) => wrapDiff(x, xs[i], period))
  const maxAbs = (xs: number[]) => xs.reduce((m, x) => Math.max(m, Math.abs(x)), 0)
  const accel = (ds: number[]) => ds.slice(1).map((d, i) => d - ds[i])

  it('the wingbeat never jumps or reverses, and its pace changes smoothly', () => {
    const ds = steps(morph, 1)
    // Always forward, never faster than a full mid band plus a full kick surge
    // allows (surge is itself slewed from `kick`, so it can never exceed
    // this hostile generator's own 1.2 peak).
    expect(Math.min(...ds)).toBeGreaterThan(0)
    expect(maxAbs(ds)).toBeLessThanOrEqual(MORPH_SPD * (MORPH_FLOOR + MORPH_MIDS + MORPH_SURGE * 1.2) * DT + 1e-9)
    // Pace change per frame. Raw mids/kick re-rolled every frame would swing
    // the step by well over a magnitude more than the slews allow through.
    expect(maxAbs(accel(ds))).toBeLessThan(0.002)
  })

  it('the travelling glow surges on a kick without snapping', () => {
    const ds = steps(travel, TAU)
    expect(Math.min(...ds)).toBeGreaterThan(0)
    // A raw 1.2 kick would change the glow's per-frame step by 8 x 1.2 x DT
    // = 0.16 rad in one frame; the surge's 18/s attack spreads that over ~4.
    expect(maxAbs(accel(ds))).toBeLessThan(0.05)
  })

  it('the kick breath swells in: no zoom step a raw envelope would give', () => {
    const rel = zoom.slice(1).map((z, i) => Math.abs(z / zoom[i] - 1))
    // A raw 6% x 1.2 envelope would jump the zoom 7.2% in one frame.
    expect(Math.max(...rel)).toBeLessThan(0.006)
    // ...and it is still a visible breath, not smoothed away to nothing.
    expect(Math.max(...zoom)).toBeGreaterThan(1.015)
  })

  it('line brightness follows energy without flicker', () => {
    const ds = bright.slice(1).map((b, i) => Math.abs(b - bright[i]))
    // Raw energy re-rolled every frame would swing brightness by up to 0.45 x 1.1.
    expect(Math.max(...ds)).toBeLessThan(0.025)
  })

  it('every output stays finite and in range', () => {
    for (let i = 0; i < FRAMES; i++) {
      expect(morph[i]).toBeGreaterThanOrEqual(0)
      expect(morph[i]).toBeLessThan(1)
      expect(travel[i]).toBeGreaterThanOrEqual(0)
      expect(travel[i]).toBeLessThan(TAU)
      expect(Number.isFinite(zoom[i]) && zoom[i] > 0.5 && zoom[i] < 2.5).toBe(true)
    }
  })
})

describe('mothwings: never frozen, never skipped', () => {
  it('keeps breathing through silence', () => {
    const st = createMothWingsState()
    const silence = { energy: 0, mids: 0, highs: 0, kick: 0 }
    let wing = 0
    let glow = 0
    for (let i = 0; i < 10 * 60; i++) {
      const m0 = st.morph
      const t0 = st.travel
      stepMothWings(st, silence, NEUTRAL, CAM, DT)
      wing += wrapDiff(st.morph, m0, 1)
      glow += wrapDiff(st.travel, t0, TAU)
    }
    // Floor pace: MORPH_SPD x MORPH_FLOOR cycles/s and 0.55 x 3 rad/s, over 10 s.
    // Silence also means no kick surge, so MORPH_SURGE contributes nothing here.
    expect(wing).toBeCloseTo(10 * MORPH_SPD * MORPH_FLOOR, 3)
    expect(glow).toBeCloseTo(10 * 3 * 0.55, 3)
  })

  it('a stalled frame pauses the wings rather than skipping them ahead', () => {
    const st = createMothWingsState()
    const full = { energy: 1, mids: 1, highs: 1, kick: 0 }
    for (let i = 0; i < 120; i++) stepMothWings(st, full, NEUTRAL, CAM, DT)
    const before = st.morph
    stepMothWings(st, full, NEUTRAL, CAM, 0.1) // the engine's own frame cap
    // kick: 0 throughout, so the surge term contributes nothing here.
    expect(wrapDiff(st.morph, before, 1)).toBeLessThanOrEqual(
      (MORPH_SPD * (MORPH_FLOOR + MORPH_MIDS)) / 30 + 1e-9,
    )
  })

  it('the speed dial scales both clocks', () => {
    const run = (speed: number) => {
      const st = createMothWingsState()
      const quiet = { energy: 0, mids: 0, highs: 0, kick: 0 }
      stepMothWings(st, quiet, { speed, fill: 0.5 }, CAM, DT)
      return st.morph
    }
    expect(run(1) / run(0.5)).toBeCloseTo(4, 6)
    expect(run(0) / run(0.5)).toBeCloseTo(0.25, 6)
  })
})

describe('mothwings: the wingbeat swing depth follows energy and kick, smoothly', () => {
  it('never fully flat, never past the authored range, and never jumps', () => {
    const st = createMothWingsState()
    const audio = hostileAudio(30 * 60)
    let prev = st.flapDepth
    for (const a of audio) {
      stepMothWings(st, a, NEUTRAL, CAM, DT)
      expect(st.flapDepth).toBeGreaterThanOrEqual(FLAP_DEPTH_FLOOR - 1e-9)
      expect(st.flapDepth).toBeLessThanOrEqual(1)
      // Raw energy/kick re-rolled every frame would swing this by up to
      // FLAP_DEPTH_ENERGY + FLAP_DEPTH_SURGE (0.7) in one frame; both inputs
      // are already-slewed state, so this is nowhere close. `st.surge` keeps
      // the same fast 18/s attack it already uses to snap the travelling
      // glow on a kick (a deliberately quick response, not a bug), so the
      // bound here is looser than the wingbeat PACE's own — a kick jumping
      // straight to full strength can still move the surge component of the
      // depth by ~0.11 in one frame.
      expect(Math.abs(st.flapDepth - prev)).toBeLessThan(0.15)
      prev = st.flapDepth
    }
  })

  it('sits at its floor in silence, and rises with a sustained loud passage', () => {
    const st = createMothWingsState()
    const silence = { energy: 0, mids: 0, highs: 0, kick: 0 }
    for (let i = 0; i < 5 * 60; i++) stepMothWings(st, silence, NEUTRAL, CAM, DT)
    expect(st.flapDepth).toBeCloseTo(FLAP_DEPTH_FLOOR, 6)

    const loud = { energy: 1, mids: 1, highs: 1, kick: 1 }
    for (let i = 0; i < 5 * 60; i++) stepMothWings(st, loud, NEUTRAL, CAM, DT)
    expect(st.flapDepth).toBeCloseTo(
      Math.min(1, FLAP_DEPTH_FLOOR + FLAP_DEPTH_ENERGY + FLAP_DEPTH_SURGE),
      2,
    )
  })
})
