import { describe, expect, it } from 'vitest'
import {
  CONFIDENCE_CEIL,
  CONFIDENCE_FLOOR,
  OCTAVES_MAX,
  RATE_MAX,
  RATE_MIN,
  REF_BPM,
  foldedSpeedDial,
  speedDialBias,
  tempoOctaves,
  tempoRate,
} from '../tempoSpeed'

/** `sceneParams.ts`'s `drastic`, restated so this audio-side test stays free of engine imports. */
const drastic = (p: number) => Math.pow(4, (p - 0.5) * 2)

describe('tempoOctaves', () => {
  it('is 0 at the reference BPM and +-1 at double / half time, at full confidence', () => {
    expect(tempoOctaves(REF_BPM, 1)).toBeCloseTo(0, 12)
    expect(tempoOctaves(REF_BPM * 2, 1)).toBeCloseTo(1, 12)
    expect(tempoOctaves(REF_BPM / 2, 1)).toBeCloseTo(-1, 12)
  })

  it('is exactly antisymmetric in log-space', () => {
    expect(tempoOctaves(REF_BPM * 1.5, 1)).toBeCloseTo(-tempoOctaves(REF_BPM / 1.5, 1), 12)
  })

  it('clamps at +-OCTAVES_MAX so an octave-double misread cannot fling motion around', () => {
    expect(tempoOctaves(480, 1)).toBe(OCTAVES_MAX)
    expect(tempoOctaves(20, 1)).toBe(-OCTAVES_MAX)
  })

  it('is monotonically increasing in bpm at full confidence', () => {
    let prev = -Infinity
    for (const bpm of [40, 60, 80, 100, 120, 140, 160, 200, 300]) {
      const v = tempoOctaves(bpm, 1)
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
  })

  it('is fully neutral at or below the confidence floor, whatever the bpm', () => {
    expect(tempoOctaves(200, 0)).toBe(0)
    expect(tempoOctaves(60, CONFIDENCE_FLOOR)).toBe(0)
  })

  it('ramps linearly with confidence between the floor and the ceiling, and saturates above it', () => {
    const full = tempoOctaves(160, 1)
    expect(tempoOctaves(160, (CONFIDENCE_FLOOR + CONFIDENCE_CEIL) / 2)).toBeCloseTo(full * 0.5, 12)
    expect(tempoOctaves(160, CONFIDENCE_CEIL)).toBeCloseTo(full, 12)
    expect(tempoOctaves(160, 0.9)).toBeCloseTo(full, 12)
  })

  it('reads as neutral (0) for non-finite or non-positive bpm, and for non-finite confidence', () => {
    for (const bpm of [0, -10, NaN, Infinity, -Infinity]) expect(tempoOctaves(bpm, 1)).toBe(0)
    for (const c of [NaN, Infinity, -Infinity]) expect(tempoOctaves(160, c)).toBe(0)
  })
})

describe('tempoRate', () => {
  it('is exactly 1 at zero octaves for every coupling', () => {
    for (const k of [0, 0.2, 0.6, 1, 1.2]) expect(tempoRate(0, k)).toBe(1)
  })

  it('is exactly 1 for every tempo at zero coupling (a mood that ignores tempo)', () => {
    for (const o of [-1, -0.5, 0.4, 1]) expect(tempoRate(o, 0)).toBe(1)
  })

  it('at coupling 1, is proportional to tempo: 160 BPM = 4/3, 80 BPM = 2/3', () => {
    expect(tempoRate(Math.log2(160 / REF_BPM), 1)).toBeCloseTo(160 / 120, 9)
    expect(tempoRate(Math.log2(80 / REF_BPM), 1)).toBeCloseTo(80 / 120, 9)
  })

  it('a higher coupling pulls harder in both directions (fast gets faster, slow gets slower)', () => {
    const fast = Math.log2(160 / REF_BPM)
    const slow = Math.log2(80 / REF_BPM)
    expect(tempoRate(fast, 1)).toBeGreaterThan(tempoRate(fast, 0.3))
    expect(tempoRate(fast, 0.3)).toBeGreaterThan(1)
    expect(tempoRate(slow, 1)).toBeLessThan(tempoRate(slow, 0.3))
    expect(tempoRate(slow, 0.3)).toBeLessThan(1)
  })

  it('a 2x faster and a 2x slower song sit at exact reciprocal rates', () => {
    for (const k of [0.3, 0.7, 1]) expect(tempoRate(0.7, k) * tempoRate(-0.7, k)).toBeCloseTo(1, 12)
  })

  it('never leaves [RATE_MIN, RATE_MAX], even for an absurd coupling', () => {
    expect(tempoRate(1, 50)).toBe(RATE_MAX)
    expect(tempoRate(-1, 50)).toBe(RATE_MIN)
  })

  it('treats a negative coupling as 0 and non-finite inputs as neutral', () => {
    expect(tempoRate(0.8, -1)).toBe(1)
    expect(tempoRate(NaN, 1)).toBe(1)
    expect(tempoRate(0.5, NaN)).toBe(1)
    expect(tempoRate(Infinity, 1)).toBe(1)
  })

  it('a dreamy-like coupling keeps a fast track floaty while a driving-like one races', () => {
    const o = Math.log2(160 / REF_BPM)
    expect(tempoRate(o, 0.3)).toBeLessThan(1.15)
    expect(tempoRate(o, 1)).toBeGreaterThan(1.3)
  })
})

describe('speedDialBias', () => {
  it('makes drastic(dial + bias) exactly drastic(dial) * rate, for any dial position', () => {
    for (const dial of [0, 0.2, 0.5, 0.75, 1]) {
      for (const rate of [RATE_MIN, 0.8, 1, 1.33, RATE_MAX]) {
        expect(drastic(dial + speedDialBias(rate))).toBeCloseTo(drastic(dial) * rate, 9)
      }
    }
  })

  it('is 0 for a neutral rate and for garbage', () => {
    expect(speedDialBias(1)).toBe(0)
    for (const r of [0, -1, NaN, Infinity]) expect(speedDialBias(r)).toBe(0)
  })

  it('stays within +-0.25 of the dial across the whole rate range', () => {
    expect(speedDialBias(RATE_MAX)).toBeCloseTo(0.25, 12)
    expect(speedDialBias(RATE_MIN)).toBeCloseTo(-0.25, 12)
  })
})

describe('foldedSpeedDial', () => {
  it('multiplies drastic(dial) by the global speed exactly, for any dial and global speed', () => {
    for (const dial of [0, 0.3, 0.5, 0.8, 1]) {
      for (const g of [0.3, 0.6, 1, 1.5, 2.2]) {
        expect(drastic(foldedSpeedDial(dial, g, 1.2, false))).toBeCloseTo(drastic(dial) * g, 9)
      }
    }
  })

  it('leaves the dial untouched at a global speed of 1', () => {
    expect(foldedSpeedDial(0.42, 1, 1, false)).toBe(0.42)
  })

  it('a tempo-locked scene gets the global speed WITHOUT the tempo rate (no double tempo)', () => {
    const global = 0.8 * 1.3 // e.g. mood 0.8 x tempo rate 1.3
    const locked = foldedSpeedDial(0.5, global, 1.3, true)
    expect(drastic(locked)).toBeCloseTo(0.8, 9)
    expect(drastic(foldedSpeedDial(0.5, global, 1.3, false))).toBeCloseTo(global, 9)
  })

  it('a tempo-locked scene is unaffected by a garbage rate (falls back to the plain global speed)', () => {
    for (const r of [0, -1, NaN, Infinity]) {
      expect(drastic(foldedSpeedDial(0.5, 1.4, r, true))).toBeCloseTo(1.4, 9)
    }
  })
})
