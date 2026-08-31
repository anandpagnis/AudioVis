import { describe, expect, it } from 'vitest'
import { effectEnvelope } from '../effectEnvelope'

describe('effectEnvelope', () => {
  it('is exactly zero at slotProgress 0', () => {
    expect(effectEnvelope(0)).toBe(0)
  })

  it('is exactly zero at slotProgress 1 — the hard SceneManager guarantee', () => {
    // SceneManager retires an effect the instant slotProgress reaches 1 and
    // does NOT fade it out. If this were nonzero, every effect scene using
    // this envelope would pop instead of settle.
    expect(effectEnvelope(1)).toBe(0)
  })

  it('rises to full strength by the end of the rise window (5%)', () => {
    expect(effectEnvelope(0.05)).toBeCloseTo(1, 6)
  })

  it('holds at full strength through the plateau (5%..18%)', () => {
    expect(effectEnvelope(0.1)).toBeCloseTo(1, 6)
    expect(effectEnvelope(0.18)).toBeCloseTo(1, 6)
  })

  it('decays monotonically from the plateau to the end', () => {
    const samples = [0.18, 0.3, 0.5, 0.7, 0.9, 1]
    const values = samples.map(effectEnvelope)
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeLessThanOrEqual(values[i - 1])
    }
  })

  it('rises monotonically through the rise window', () => {
    const samples = [0, 0.01, 0.02, 0.03, 0.04, 0.05]
    const values = samples.map(effectEnvelope)
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThanOrEqual(values[i - 1])
    }
  })

  it('stays within 0..1 across the whole lifetime', () => {
    for (let p = 0; p <= 1; p += 0.01) {
      const v = effectEnvelope(p)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
  })

  it('clamps out-of-range input rather than propagating it', () => {
    expect(effectEnvelope(-1)).toBe(effectEnvelope(0))
    expect(effectEnvelope(2)).toBe(effectEnvelope(1))
  })

  it('is total against non-finite input', () => {
    expect(Number.isFinite(effectEnvelope(NaN))).toBe(true)
    expect(Number.isFinite(effectEnvelope(Infinity))).toBe(true)
    expect(effectEnvelope(NaN)).toBe(0)
  })
})
