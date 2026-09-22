import { describe, expect, it } from 'vitest'
import {
  bootstrapCI,
  etaSquared,
  normalizedEntropy,
  pearson,
  ranks,
  ridgeCrossValidate,
  ridgeFit,
  ridgePredict,
  spearman,
} from './stats'

describe('stats', () => {
  it('ranks: ties share the average rank', () => {
    expect(ranks([10, 20, 20, 30])).toEqual([1, 2.5, 2.5, 4])
    expect(ranks([3, 1, 2])).toEqual([3, 1, 2])
  })

  it('pearson / spearman: perfect, inverse and monotone-nonlinear cases', () => {
    const x = [1, 2, 3, 4, 5, 6]
    expect(pearson(x, x.map((v) => 2 * v + 1))).toBeCloseTo(1, 10)
    expect(pearson(x, x.map((v) => -v))).toBeCloseTo(-1, 10)
    // Monotone but very nonlinear: Spearman is exactly 1, Pearson is not.
    const y = x.map((v) => v ** 5)
    expect(spearman(x, y)).toBeCloseTo(1, 10)
    expect(pearson(x, y)).toBeLessThan(0.99)
    expect(Number.isNaN(pearson([1, 1, 1, 1], [1, 2, 3, 4]))).toBe(true)
  })

  it('bootstrapCI brackets a known strong correlation and is deterministic', () => {
    const x = Array.from({ length: 80 }, (_, i) => i)
    const y = x.map((v, i) => v + ((i * 7919) % 13) - 6)
    const [lo, hi] = bootstrapCI(x, y)
    const rho = spearman(x, y)
    expect(lo).toBeLessThanOrEqual(rho)
    expect(hi).toBeGreaterThanOrEqual(rho)
    expect(bootstrapCI(x, y)).toEqual([lo, hi])
  })

  it('normalizedEntropy: 0 for one bucket, 1 for uniform', () => {
    expect(normalizedEntropy([100, 0, 0, 0])).toBe(0)
    expect(normalizedEntropy([25, 25, 25, 25])).toBeCloseTo(1, 10)
    expect(normalizedEntropy([70, 10, 10, 10])).toBeGreaterThan(0.5)
    expect(normalizedEntropy([70, 10, 10, 10])).toBeLessThan(0.9)
  })

  it('etaSquared: 1 when the grouping explains everything, ~0 when it explains nothing', () => {
    expect(etaSquared(['a', 'a', 'b', 'b'], [1, 1, 5, 5])).toBeCloseTo(1, 10)
    expect(etaSquared(['a', 'b', 'a', 'b'], [1, 1, 5, 5])).toBeCloseTo(0, 10)
  })

  it('ridge recovers a linear relationship and cross-validates out of sample', () => {
    const X: number[][] = []
    const y: number[] = []
    for (let i = 0; i < 120; i++) {
      const a = Math.sin(i * 1.7)
      const b = Math.cos(i * 0.9)
      const c = Math.sin(i * 0.31 + 1)
      X.push([a, b, c])
      y.push(2 * a - 1 * b + 0 * c + 0.5)
    }
    const m = ridgeFit(X, y, 0.01)
    expect(ridgePredict(m, [0.3, -0.2, 0.9])).toBeCloseTo(2 * 0.3 + 0.2 + 0.5, 1)
    expect(spearman(ridgeCrossValidate(X, y, 5, 0.5), y)).toBeGreaterThan(0.98)
  })
})
