import { describe, expect, it } from 'vitest'
import { RealFft } from '../fft'

function naiveDft(x: number[]): { re: number[]; im: number[] } {
  const n = x.length
  const re: number[] = []
  const im: number[] = []
  for (let k = 0; k <= n / 2; k++) {
    let r = 0
    let i = 0
    for (let t = 0; t < n; t++) {
      const a = (-2 * Math.PI * k * t) / n
      r += x[t] * Math.cos(a)
      i += x[t] * Math.sin(a)
    }
    re.push(r)
    im.push(i)
  }
  return { re, im }
}

function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296 - 0.5
  }
}

describe('RealFft', () => {
  it('rejects sizes that are not a power of two', () => {
    expect(() => new RealFft(48)).toThrow()
    expect(() => new RealFft(2)).toThrow()
  })

  it.each([8, 64, 256])('matches a naive DFT at n=%i', (n) => {
    const r = lcg(n)
    const x = Array.from({ length: n }, () => r())
    const fft = new RealFft(n)
    const re = new Float64Array(n / 2 + 1)
    const im = new Float64Array(n / 2 + 1)
    fft.forward(x, re, im)
    const ref = naiveDft(x)
    for (let k = 0; k <= n / 2; k++) {
      expect(re[k]).toBeCloseTo(ref.re[k], 9)
      expect(im[k]).toBeCloseTo(ref.im[k], 9)
    }
  })

  it('power() is |forward|^2 and can be called repeatedly (no state leaks between calls)', () => {
    const n = 2048
    const r = lcg(7)
    const a = Float64Array.from({ length: n }, () => r())
    const b = Float64Array.from({ length: n }, () => r())
    const fft = new RealFft(n)
    const pa = new Float64Array(n / 2 + 1)
    const pb = new Float64Array(n / 2 + 1)
    fft.power(a, pa)
    fft.power(b, pb)
    const pa2 = new Float64Array(n / 2 + 1)
    fft.power(a, pa2)
    const re = new Float64Array(n / 2 + 1)
    const im = new Float64Array(n / 2 + 1)
    fft.forward(a, re, im)
    for (let k = 0; k <= n / 2; k += 37) {
      expect(pa2[k]).toBeCloseTo(pa[k], 9)
      expect(pa[k]).toBeCloseTo(re[k] * re[k] + im[k] * im[k], 6)
    }
  })

  it('Parseval: the spectrum carries the signal energy', () => {
    const n = 1024
    const r = lcg(3)
    const x = Float64Array.from({ length: n }, () => r())
    const p = new Float64Array(n / 2 + 1)
    new RealFft(n).power(x, p)
    let spec = p[0] + p[n / 2]
    for (let k = 1; k < n / 2; k++) spec += 2 * p[k]
    let time = 0
    for (const v of x) time += v * v
    expect(spec / n).toBeCloseTo(time, 6)
  })

  it('a bin-centred sine peaks in exactly its bin', () => {
    const n = 512
    const bin = 37
    const x = Float64Array.from({ length: n }, (_, t) => Math.sin((2 * Math.PI * bin * t) / n))
    const p = new Float64Array(n / 2 + 1)
    new RealFft(n).power(x, p)
    let arg = 0
    for (let k = 1; k <= n / 2; k++) if (p[k] > p[arg]) arg = k
    expect(arg).toBe(bin)
    expect(p[bin]).toBeCloseTo((n / 2) ** 2, 4)
  })
})
