/**
 * Small, dependency-free statistics for the emotion evaluation. Pure functions,
 * unit-tested in `stats.calib.ts`. Nothing here ships in the app.
 */

/** Average ranks (ties share the mean rank), 1-based. */
export function ranks(xs: readonly number[]): number[] {
  const idx = xs.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0])
  const out = new Array<number>(xs.length)
  let i = 0
  while (i < idx.length) {
    let j = i
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++
    const r = (i + j) / 2 + 1
    for (let k = i; k <= j; k++) out[idx[k][1]] = r
    i = j + 1
  }
  return out
}

export function mean(xs: readonly number[]): number {
  let s = 0
  for (const x of xs) s += x
  return xs.length ? s / xs.length : 0
}

export function pearson(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length)
  if (n < 3) return NaN
  const ma = mean(a.slice(0, n))
  const mb = mean(b.slice(0, n))
  let sab = 0
  let saa = 0
  let sbb = 0
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma
    const db = b[i] - mb
    sab += da * db
    saa += da * da
    sbb += db * db
  }
  const d = Math.sqrt(saa * sbb)
  return d > 0 ? sab / d : NaN
}

/** Spearman rank correlation (Pearson on average ranks). */
export function spearman(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length)
  return pearson(ranks(a.slice(0, n)), ranks(b.slice(0, n)))
}

/** Deterministic PRNG (mulberry32) so bootstraps and folds reproduce. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Percentile bootstrap 95% CI for a paired statistic (default Spearman). */
export function bootstrapCI(
  a: readonly number[],
  b: readonly number[],
  stat: (x: readonly number[], y: readonly number[]) => number = spearman,
  resamples = 300,
  seed = 7,
): [number, number] {
  const n = Math.min(a.length, b.length)
  if (n < 10) return [NaN, NaN]
  const r = rng(seed)
  const vals: number[] = []
  for (let k = 0; k < resamples; k++) {
    const xs: number[] = []
    const ys: number[] = []
    for (let i = 0; i < n; i++) {
      const j = Math.floor(r() * n)
      xs.push(a[j])
      ys.push(b[j])
    }
    const v = stat(xs, ys)
    if (Number.isFinite(v)) vals.push(v)
  }
  vals.sort((x, y) => x - y)
  if (!vals.length) return [NaN, NaN]
  return [vals[Math.floor(vals.length * 0.025)], vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.975))]]
}

/** Normalised Shannon entropy of a share distribution: 0 = one bucket, 1 = uniform. */
export function normalizedEntropy(counts: readonly number[]): number {
  const total = counts.reduce((s, c) => s + c, 0)
  const k = counts.filter((c) => c > 0).length
  if (total <= 0 || counts.length < 2) return 0
  let h = 0
  for (const c of counts) if (c > 0) h -= (c / total) * Math.log(c / total)
  return h / Math.log(counts.length)
}

/** Share of the variance of `y` explained by the grouping `g` (eta squared). */
export function etaSquared(groups: readonly string[], y: readonly number[]): number {
  const n = Math.min(groups.length, y.length)
  if (n < 3) return NaN
  const my = mean(y.slice(0, n))
  const by = new Map<string, number[]>()
  for (let i = 0; i < n; i++) (by.get(groups[i]) ?? by.set(groups[i], []).get(groups[i])!).push(y[i])
  let ssb = 0
  for (const v of by.values()) ssb += v.length * (mean(v) - my) ** 2
  let sst = 0
  for (let i = 0; i < n; i++) sst += (y[i] - my) ** 2
  return sst > 0 ? ssb / sst : NaN
}

/** Solve A x = b by Gaussian elimination with partial pivoting (A is n x n, small). */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length
  const M = A.map((row, i) => [...row, b[i]])
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r
    ;[M[c], M[p]] = [M[p], M[c]]
    const d = M[c][c] || 1e-12
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / d
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]
    }
  }
  const x = new Array<number>(n).fill(0)
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n]
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k]
    x[r] = s / (M[r][r] || 1e-12)
  }
  return x
}

export interface RidgeModel {
  weights: number[]
  intercept: number
  mu: number[]
  sd: number[]
}

/** Ridge regression on z-scored features (intercept unpenalised). */
export function ridgeFit(X: readonly (readonly number[])[], y: readonly number[], lambda = 1): RidgeModel {
  const n = X.length
  const p = X[0]?.length ?? 0
  const mu = new Array<number>(p).fill(0)
  const sd = new Array<number>(p).fill(1)
  for (let j = 0; j < p; j++) {
    mu[j] = mean(X.map((r) => r[j]))
    const v = mean(X.map((r) => (r[j] - mu[j]) ** 2))
    sd[j] = Math.sqrt(v) || 1
  }
  const Z = X.map((r) => r.map((v, j) => (v - mu[j]) / sd[j]))
  const my = mean(y)
  const A: number[][] = Array.from({ length: p }, () => new Array<number>(p).fill(0))
  const b = new Array<number>(p).fill(0)
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < p; j++) {
      b[j] += Z[i][j] * (y[i] - my)
      for (let k = 0; k < p; k++) A[j][k] += Z[i][j] * Z[i][k]
    }
  }
  for (let j = 0; j < p; j++) A[j][j] += lambda
  return { weights: solve(A, b), intercept: my, mu, sd }
}

export function ridgePredict(m: RidgeModel, x: readonly number[]): number {
  let s = m.intercept
  for (let j = 0; j < m.weights.length; j++) s += m.weights[j] * ((x[j] - m.mu[j]) / m.sd[j])
  return s
}

/** k-fold cross-validated predictions (out-of-fold), deterministic folds. */
export function ridgeCrossValidate(
  X: readonly (readonly number[])[],
  y: readonly number[],
  k = 5,
  lambda = 5,
  seed = 11,
): number[] {
  const n = X.length
  const order = Array.from({ length: n }, (_, i) => i)
  const r = rng(seed)
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1))
    ;[order[i], order[j]] = [order[j], order[i]]
  }
  const pred = new Array<number>(n).fill(0)
  for (let f = 0; f < k; f++) {
    const test = order.filter((_, idx) => idx % k === f)
    const testSet = new Set(test)
    const train = order.filter((i) => !testSet.has(i))
    const model = ridgeFit(
      train.map((i) => X[i]),
      train.map((i) => y[i]),
      lambda,
    )
    for (const i of test) pred[i] = ridgePredict(model, X[i])
  }
  return pred
}
