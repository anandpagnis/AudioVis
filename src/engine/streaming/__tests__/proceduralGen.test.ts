import { describe, expect, it } from 'vitest'
import {
  generateDissolveField,
  generatePlasmaField,
  mulberry32,
  type DissolveGenParams,
} from '../proceduralGen'

describe('mulberry32', () => {
  it('is deterministic for a given seed and varies across seeds', () => {
    const a = mulberry32(42)
    const b = mulberry32(42)
    const c = mulberry32(43)
    const seqA = Array.from({ length: 8 }, a)
    const seqB = Array.from({ length: 8 }, b)
    const seqC = Array.from({ length: 8 }, c)
    expect(seqA).toEqual(seqB)
    expect(seqA).not.toEqual(seqC)
  })

  it('stays within [0, 1)', () => {
    const random = mulberry32(7)
    for (let i = 0; i < 5000; i++) {
      const v = random()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})

describe('generatePlasmaField', () => {
  const params = { count: 500, spread: 9, seed: 1234 }

  it('is bit-for-bit deterministic given the same seed', () => {
    // This is what makes moving the work to a worker safe: the output does not
    // depend on which thread ran it, only on the seed.
    const a = generatePlasmaField(params)
    const b = generatePlasmaField(params)
    expect(a.positions).toEqual(b.positions)
    expect(a.rand).toEqual(b.rand)
  })

  it('produces a different field for a different seed', () => {
    const a = generatePlasmaField(params)
    const b = generatePlasmaField({ ...params, seed: 999 })
    expect(a.positions).not.toEqual(b.positions)
  })

  it('emits exactly count particles with the right attribute strides', () => {
    const { positions, rand } = generatePlasmaField(params)
    expect(positions.length).toBe(params.count * 3)
    expect(rand.length).toBe(params.count * 4)
  })

  it('keeps every particle inside the declared spread', () => {
    // The Y axis is deliberately flattened to 0.85, so the bound is the
    // spread itself on the widest axis — nothing should escape it.
    const { positions } = generatePlasmaField(params)
    for (let i = 0; i < params.count; i++) {
      const x = positions[i * 3]
      const y = positions[i * 3 + 1]
      const z = positions[i * 3 + 2]
      expect(Math.hypot(x, y, z)).toBeLessThanOrEqual(params.spread * 1.001)
    }
  })

  it('emits no NaNs — a single NaN silently blanks the whole point cloud', () => {
    const { positions, rand } = generatePlasmaField(params)
    expect(positions.every(Number.isFinite)).toBe(true)
    expect(rand.every(Number.isFinite)).toBe(true)
  })

  it('concentrates density toward the core (power-law radius, not uniform)', () => {
    // The core-weighted seeding is the scene's whole look. A uniform-radius
    // regression would still render, just as a flat shell instead of a hot
    // core, so assert the distribution rather than trusting the exponent.
    const { positions } = generatePlasmaField({ count: 4000, spread: 9, seed: 5 })
    let inner = 0
    for (let i = 0; i < 4000; i++) {
      const r = Math.hypot(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2])
      if (r < 9 * 0.5) inner++
    }
    // Uniform-in-radius would put ~50% inside half-radius; the power-law
    // pushes it well above that.
    expect(inner / 4000).toBeGreaterThan(0.55)
  })
})

describe('generateDissolveField', () => {
  /** Two unit triangles forming a quad in the XY plane, normals +Z. */
  function quad(): Pick<DissolveGenParams, 'position' | 'normal'> {
    const position = new Float32Array([
      0, 0, 0, 1, 0, 0, 0, 1, 0,
      1, 0, 0, 1, 1, 0, 0, 1, 0,
    ])
    const normal = new Float32Array([
      0, 0, 1, 0, 0, 1, 0, 0, 1,
      0, 0, 1, 0, 0, 1, 0, 0, 1,
    ])
    return { position, normal }
  }

  const params: DissolveGenParams = { ...quad(), count: 400, cage: 7, seed: 77 }

  it('is bit-for-bit deterministic given the same seed', () => {
    const a = generateDissolveField(params)
    const b = generateDissolveField(params)
    expect(a.formed).toEqual(b.formed)
    expect(a.scattered).toEqual(b.scattered)
    expect(a.rand).toEqual(b.rand)
  })

  it('emits exactly count particles with the right attribute strides', () => {
    const { formed, scattered, rand } = generateDissolveField(params)
    expect(formed.length).toBe(params.count * 3)
    expect(scattered.length).toBe(params.count * 3)
    expect(rand.length).toBe(params.count * 4)
  })

  it('samples formed positions onto the source surface', () => {
    // Every point must land inside the unit quad, on the z=0 plane.
    const { formed } = generateDissolveField(params)
    for (let i = 0; i < params.count; i++) {
      expect(formed[i * 3]).toBeGreaterThanOrEqual(-1e-5)
      expect(formed[i * 3]).toBeLessThanOrEqual(1 + 1e-5)
      expect(formed[i * 3 + 1]).toBeGreaterThanOrEqual(-1e-5)
      expect(formed[i * 3 + 1]).toBeLessThanOrEqual(1 + 1e-5)
      expect(Math.abs(formed[i * 3 + 2])).toBeLessThan(1e-5)
    }
  })

  it('keeps scattered particles inside the cage walls on every axis', () => {
    // The clamp scales back along the ray rather than per-axis, precisely so
    // strays never flatten onto visible planes at the cage faces.
    const limit = (params.cage * 0.5 * 0.93) + 1e-4
    const { scattered } = generateDissolveField(params)
    for (let i = 0; i < params.count; i++) {
      expect(Math.abs(scattered[i * 3])).toBeLessThanOrEqual(limit)
      expect(Math.abs(scattered[i * 3 + 1])).toBeLessThanOrEqual(limit)
      expect(Math.abs(scattered[i * 3 + 2])).toBeLessThanOrEqual(limit)
    }
  })

  it('pushes scattered points off the surface along the normal', () => {
    // Normals are +Z and the source is flat at z=0, so every scattered point
    // should have moved in +Z.
    const { scattered } = generateDissolveField(params)
    let pushed = 0
    for (let i = 0; i < params.count; i++) if (scattered[i * 3 + 2] > 0.3) pushed++
    expect(pushed).toBeGreaterThan(params.count * 0.9)
  })

  it('emits no NaNs', () => {
    const { formed, scattered, rand } = generateDissolveField(params)
    expect(formed.every(Number.isFinite)).toBe(true)
    expect(scattered.every(Number.isFinite)).toBe(true)
    expect(rand.every(Number.isFinite)).toBe(true)
  })

  it('weights sampling by triangle area, not triangle count', () => {
    // One tiny triangle and one large one. Uniform-per-triangle picking would
    // put ~50% of points on the tiny one; area-weighting must put nearly all
    // of them on the large one. This is the bug the CDF exists to prevent.
    const position = new Float32Array([
      // tiny triangle near the origin
      0, 0, 0, 0.01, 0, 0, 0, 0.01, 0,
      // large triangle far along +X
      2, 0, 0, 12, 0, 0, 2, 10, 0,
    ])
    const normal = new Float32Array(18)
    for (let i = 0; i < 6; i++) normal[i * 3 + 2] = 1
    const { formed } = generateDissolveField({ position, normal, count: 1000, cage: 100, seed: 3 })
    let onLarge = 0
    for (let i = 0; i < 1000; i++) if (formed[i * 3] >= 2) onLarge++
    expect(onLarge / 1000).toBeGreaterThan(0.99)
  })
})
