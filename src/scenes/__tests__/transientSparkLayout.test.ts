import { describe, expect, it } from 'vitest'
import { layoutSparks, MAX_SPARKS, MIN_JUMP, MIN_SPARKS, pickSparkCount, RECENT_WINDOW } from '../transientSparkLayout'

/** Runs `n` firings the way the scene does: seed advances, recent counts feed back. */
function run(n: number, strength = 0.5, seed0 = 100) {
  const counts: number[] = []
  let recent: number[] = []
  for (let i = 0; i < n; i++) {
    const c = pickSparkCount(seed0 + i * 7.31 + (i % 4) * 0.37, strength, recent)
    counts.push(c)
    recent = [...recent, c].slice(-RECENT_WINDOW)
  }
  return counts
}

describe('pickSparkCount', () => {
  it('stays within 1..15 and uses the whole range over a long run', () => {
    const counts = run(400)
    for (const c of counts) {
      expect(c).toBeGreaterThanOrEqual(MIN_SPARKS)
      expect(c).toBeLessThanOrEqual(MAX_SPARKS)
    }
    const seen = new Set(counts)
    expect(Math.min(...counts)).toBeLessThanOrEqual(2)
    expect(Math.max(...counts)).toBeGreaterThanOrEqual(14)
    expect(seen.size).toBeGreaterThanOrEqual(13)
  })

  it('never repeats one of the last four counts, and consecutive bursts differ by at least MIN_JUMP', () => {
    const counts = run(500)
    for (let i = 1; i < counts.length; i++) {
      expect(Math.abs(counts[i] - counts[i - 1])).toBeGreaterThanOrEqual(MIN_JUMP)
      for (let k = Math.max(0, i - RECENT_WINDOW); k < i; k++) expect(counts[i]).not.toBe(counts[k])
    }
  })

  it('is deterministic for the same seed and history', () => {
    expect(pickSparkCount(42.5, 0.6, [3, 9])).toBe(pickSparkCount(42.5, 0.6, [3, 9]))
  })

  it('a hard transient leans toward bigger bursts than a soft one, without ruling either out', () => {
    const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length
    const soft = run(600, 0.05)
    const hard = run(600, 0.95)
    expect(mean(hard)).toBeGreaterThan(mean(soft) + 0.5)
    expect(Math.max(...soft)).toBeGreaterThanOrEqual(12)
    expect(Math.min(...hard)).toBeLessThanOrEqual(3)
  })
})

describe('layoutSparks', () => {
  it('returns the requested number of lights, clamped to 1..15', () => {
    expect(layoutSparks(1, 5, 16 / 9)).toHaveLength(1)
    expect(layoutSparks(9, 5, 16 / 9)).toHaveLength(9)
    expect(layoutSparks(40, 5, 16 / 9)).toHaveLength(MAX_SPARKS)
    expect(layoutSparks(0, 5, 16 / 9)).toHaveLength(1)
  })

  it('keeps every light on screen (units of the shorter side) with finite numbers', () => {
    for (const aspect of [1, 16 / 9, 21 / 9]) {
      for (let seed = 1; seed < 60; seed++) {
        for (const n of [1, 2, 3, 8, 15]) {
          for (const sp of layoutSparks(n, seed * 1.37, aspect)) {
            expect(Number.isFinite(sp.x + sp.y + sp.k + sp.amp)).toBe(true)
            expect(Math.abs(sp.x)).toBeLessThanOrEqual(0.5 * Math.max(1, aspect))
            expect(Math.abs(sp.y)).toBeLessThanOrEqual(0.5)
            expect(sp.k).toBeGreaterThan(0)
            expect(sp.amp).toBeGreaterThan(0)
            expect(sp.amp).toBeLessThanOrEqual(1)
          }
        }
      }
    }
  })

  it('a lone light is bigger and softer than a light in a crowd', () => {
    const solo = layoutSparks(1, 3.3, 16 / 9)[0]
    const crowd = layoutSparks(15, 3.3, 16 / 9)
    const meanCrowdK = crowd.reduce((s, c) => s + c.k, 0) / crowd.length
    expect(solo.k).toBeLessThan(meanCrowdK / 2)
  })

  it('the same count looks different on different firings (position and spread vary)', () => {
    const a = layoutSparks(6, 11.1, 16 / 9)
    const b = layoutSparks(6, 12.9, 16 / 9)
    const same = a.every((p, i) => Math.abs(p.x - b[i].x) < 1e-6 && Math.abs(p.y - b[i].y) < 1e-6)
    expect(same).toBe(false)
  })

  it('lone lights land in varied places across firings, not always the centre', () => {
    const xs = Array.from({ length: 40 }, (_, i) => layoutSparks(1, 2 + i * 1.91, 16 / 9)[0].x)
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(0.5)
  })
})
