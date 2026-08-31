/**
 * Pure song-structure DSP — self-similarity segmentation + a riser detector.
 * No essentia / tf imports, so it unit-tests in `environment: 'node'`.
 *
 * The worker turns a rolling PCM window into a beat-synchronous
 * `BeatCell[]` (HPCP + MFCC + scalar bands folded onto the engine beat grid),
 * then calls these functions. `structure.worker.ts` owns the essentia feature
 * extraction; this file owns the algorithm.
 *
 * Approach: cosine self-similarity matrices per feature block, checkerboard
 * (Foote) novelty on each, weighted fusion, adaptive peak-pick → boundaries.
 * Segment mean vectors → greedy repetition letters. Kind labelling is
 * deliberately minimal — `intro`/`outro` (position), `breakdown` (quiet-and-
 * tonal), everything else `section`; `build`/`drop` are the riser's job.
 */
import type { SongSection } from '../types'
import type { StructureBuild, StructureSegment } from './structureProtocol'

export interface BeatCell {
  /** Absolute engine-grid beat index this cell covers. */
  beat: number
  /** 12-bin harmonic pitch-class profile, L2-normalised. Harmonic repetition. */
  hpcp: number[]
  /** MFCC coeffs 1..N (C0 dropped). Timbral change — the dominant EDM cue. */
  mfcc: number[]
  /** Normalised loudness in dB-ish units for slope maths. */
  logRms: number
  centroid: number
  flux: number
  flatness: number
  air: number
  sub: number
  bass: number
}

export const STRUCTURE_DSP = {
  /** Checkerboard kernel half-width in beats (~4 bars). */
  kernelHalfWidth: 16,
  /** Minimum segment length in beats. */
  minSegmentBeats: 8,
  /** Cosine ≥ this ⇒ two segments share a repetition letter. */
  repetitionTau: 0.86,
  /** Peak-pick: local median + this before a novelty peak counts. */
  peakDelta: 0.08,
  /** Novelty-fusion weights. */
  fuse: { emb: 0, timbre: 0.55, harm: 0.2, scalar: 0.25 },
  /** Riser: enter/exit on this 0..1 score. */
  buildEnter: 0.55,
  buildExit: 0.4,
  /** Riser slope window in beats. */
  riserWindow: 24,
} as const

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

/** Cosine similarity of two equal-length vectors (0 when either is a zero vec). */
export function cosine(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na < 1e-12 || nb < 1e-12) return 0
  return dot / Math.sqrt(na * nb)
}

/** Cosine self-similarity matrix over a list of feature vectors. */
export function selfSimilarity(vectors: number[][]): number[][] {
  const n = vectors.length
  const m: number[][] = Array.from({ length: n }, () => new Array(n).fill(0))
  for (let i = 0; i < n; i++) {
    m[i][i] = 1
    for (let j = i + 1; j < n; j++) {
      const c = cosine(vectors[i], vectors[j])
      m[i][j] = c
      m[j][i] = c
    }
  }
  return m
}

/**
 * Checkerboard (Foote) novelty along an SSM diagonal. `K(a,b) = sign(a·b) ·
 * exp(-(a²+b²)/(2σ²))`, σ = halfWidth/2, summed over the ±halfWidth window
 * centred on each frame; edges are clamped. Returns a 0..1 curve (running-max
 * normalised).
 */
export function checkerboardNovelty(
  ssm: number[][],
  halfWidth: number = STRUCTURE_DSP.kernelHalfWidth,
): number[] {
  const n = ssm.length
  const M = Math.min(halfWidth, Math.max(2, Math.floor(n / 2) - 1))
  const sigma = M / 2
  // Precompute the kernel.
  const size = 2 * M + 1
  const kernel: number[][] = Array.from({ length: size }, () => new Array(size).fill(0))
  for (let a = -M; a <= M; a++) {
    for (let b = -M; b <= M; b++) {
      // The centre row/col sit ON the seam and must contribute 0, otherwise the
      // positive and negative quadrants no longer cancel on a uniform matrix.
      const sign = a === 0 || b === 0 ? 0 : a * b > 0 ? 1 : -1
      kernel[a + M][b + M] = sign * Math.exp(-(a * a + b * b) / (2 * sigma * sigma))
    }
  }
  const nov = new Array(n).fill(0)
  for (let i = 0; i < n; i++) {
    let acc = 0
    for (let a = -M; a <= M; a++) {
      const ii = i + a
      if (ii < 0 || ii >= n) continue
      for (let b = -M; b <= M; b++) {
        const jj = i + b
        if (jj < 0 || jj >= n) continue
        acc += kernel[a + M][b + M] * ssm[ii][jj]
      }
    }
    nov[i] = Math.max(0, acc)
  }
  // The kernel's positive/negative quadrants only cancel with a FULL window, so
  // the clamped edges carry a large artefact. Zero the outer M cells — a
  // boundary in the first/last few bars of a streaming window is unreliable
  // anyway (no future context) — then normalise over the trustworthy interior.
  for (let i = 0; i < n; i++) if (i < M || i >= n - M) nov[i] = 0
  let peak = 0
  for (const v of nov) if (v > peak) peak = v
  if (peak > 1e-9) for (let i = 0; i < n; i++) nov[i] /= peak
  return nov
}

/** Weighted sum of novelty curves (each same length), re-normalised 0..1. */
export function fuseNovelty(curves: { curve: number[]; weight: number }[]): number[] {
  const usable = curves.filter((c) => c.weight > 0 && c.curve.length > 0)
  if (usable.length === 0) return []
  const n = usable[0].curve.length
  const wSum = usable.reduce((s, c) => s + c.weight, 0)
  const out = new Array(n).fill(0)
  for (const { curve, weight } of usable) {
    for (let i = 0; i < n && i < curve.length; i++) out[i] += (curve[i] * weight) / wSum
  }
  let peak = 0
  for (const v of out) if (v > peak) peak = v
  if (peak > 1e-9) for (let i = 0; i < n; i++) out[i] /= peak
  return out
}

function median(vals: number[]): number {
  if (vals.length === 0) return 0
  const s = [...vals].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/**
 * Adaptive peak-pick on a fused novelty curve. A local maximum counts as a
 * boundary when it exceeds `median(window) + peakDelta` and is at least
 * `minGap` beats after the previous kept peak. `cellBeats[i]` maps curve index
 * → absolute engine beat.
 */
export function pickBoundaries(
  novelty: number[],
  cellBeats: number[],
  minGap: number = STRUCTURE_DSP.minSegmentBeats,
  delta: number = STRUCTURE_DSP.peakDelta,
): { beat: number; strength: number }[] {
  const n = novelty.length
  const out: { beat: number; strength: number }[] = []
  const w = Math.max(4, Math.round(minGap * 1.5))
  let lastBeat = -Infinity
  for (let i = 1; i < n - 1; i++) {
    if (novelty[i] <= novelty[i - 1] || novelty[i] < novelty[i + 1]) continue
    const lo = Math.max(0, i - w)
    const hi = Math.min(n, i + w + 1)
    const thresh = median(novelty.slice(lo, hi)) + delta
    if (novelty[i] < thresh) continue
    const beat = cellBeats[i]
    if (beat - lastBeat < minGap) {
      // Keep the stronger of the two close peaks.
      if (out.length && novelty[i] > out[out.length - 1].strength) {
        out[out.length - 1] = { beat, strength: novelty[i] }
        lastBeat = beat
      }
      continue
    }
    out.push({ beat, strength: novelty[i] })
    lastBeat = beat
  }
  return out
}

/**
 * Greedy online repetition labelling. For each segment mean-vector, assign the
 * letter of the first existing cluster with `cosine > tau`, else a new letter
 * (A..F, then `'?'`).
 */
export function labelRepetitions(
  segmentVectors: number[][],
  tau: number = STRUCTURE_DSP.repetitionTau,
): string[] {
  const letters = ['A', 'B', 'C', 'D', 'E', 'F']
  const centroids: number[][] = []
  const out: string[] = []
  for (const v of segmentVectors) {
    let assigned = -1
    for (let k = 0; k < centroids.length; k++) {
      if (cosine(v, centroids[k]) > tau) {
        assigned = k
        break
      }
    }
    if (assigned < 0) {
      assigned = centroids.length
      centroids.push(v.slice())
    }
    out.push(assigned < letters.length ? letters[assigned] : '?')
  }
  return out
}

/**
 * Minimal kind labelling — only what is acoustically defensible without a model.
 * `intro` = first segment starting near beat 0 and below-median energy;
 * `outro` = last segment with energy falling and below-median; `breakdown` =
 * quiet (< 45 % of the loudest segment) AND tonal (low flatness); everything
 * else `section`. `build`/`drop` are never emitted here — the riser + `f.drop`
 * own them in `SectionTracker`.
 */
export function classifyKinds(
  segments: { startBeat: number; endBeat: number; meanEnergy: number; meanFlatness: number }[],
  firstBeat: number,
): SongSection[] {
  const n = segments.length
  if (n === 0) return []
  const energies = segments.map((s) => s.meanEnergy)
  const maxE = Math.max(...energies, 1e-6)
  const medE = median(energies)
  const out: SongSection[] = new Array(n).fill('section')
  for (let i = 0; i < n; i++) {
    const s = segments[i]
    if (
      i === 0 &&
      s.startBeat - firstBeat <= STRUCTURE_DSP.minSegmentBeats &&
      s.meanEnergy <= medE
    ) {
      out[i] = 'intro'
      continue
    }
    if (
      i === n - 1 &&
      s.meanEnergy <= medE &&
      (n < 2 || s.meanEnergy < segments[i - 1].meanEnergy)
    ) {
      out[i] = 'outro'
      continue
    }
    if (s.meanEnergy < 0.45 * maxE && s.meanFlatness < 0.35) out[i] = 'breakdown'
  }
  return out
}

function slope(vals: number[]): number {
  // Least-squares slope per index, normalised to "per window".
  const n = vals.length
  if (n < 3) return 0
  const mx = (n - 1) / 2
  let my = 0
  for (const v of vals) my += v
  my /= n
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    num += (i - mx) * (vals[i] - my)
    den += (i - mx) * (i - mx)
  }
  return den < 1e-9 ? 0 : (num / den) * (n - 1)
}

/**
 * Riser / build-up read over the last `riserWindow` beat cells. Weighted sum of
 * five normalised acoustic slopes; `beatsTillDrop` projects the RMS slope to a
 * ~0.95 ceiling and snaps to the nearest upcoming 8/16/32-beat grid target from
 * the build's start. The worker reports these numbers; `SectionTracker` owns
 * the latch/release.
 */
export function riserScore(
  cells: BeatCell[],
  buildStartBeat: number,
  window: number = STRUCTURE_DSP.riserWindow,
): StructureBuild {
  const w = cells.slice(-window)
  if (w.length < 8) {
    return { active: false, score: 0, progress: 0, beatsTillDrop: -1, startBeat: -1 }
  }
  const norm = (s: number, scale: number) => clamp01(s / scale)

  const centroidRise = norm(slope(w.map((c) => c.centroid)), 0.35)
  const rmsRise = norm(slope(w.map((c) => c.logRms)), 0.3)
  const flatRise = slope(w.map((c) => c.flatness))
  const airRise = slope(w.map((c) => c.air))
  const noiseSweep = norm(Math.min(flatRise, airRise) * 2, 0.3)

  const half = w.length >> 1
  const fluxEarly = w.slice(0, half).reduce((a, c) => a + c.flux, 0) / half
  const fluxLate = w.slice(half).reduce((a, c) => a + c.flux, 0) / (w.length - half)
  const hatAccel = norm(fluxLate - fluxEarly, 0.25)

  const lowSlope = slope(w.map((c) => c.sub + c.bass))
  const kickDropout = lowSlope < 0 && slope(w.map((c) => c.logRms)) > 0 ? norm(-lowSlope, 0.4) : 0

  const score = clamp01(
    centroidRise * 0.22 + rmsRise * 0.22 + noiseSweep * 0.2 + hatAccel * 0.18 + kickDropout * 0.18,
  )
  const active = score > STRUCTURE_DSP.buildEnter
  if (!active) {
    return { active: false, score, progress: 0, beatsTillDrop: -1, startBeat: -1 }
  }

  const endBeat = w[w.length - 1].beat
  const start = buildStartBeat >= 0 ? buildStartBeat : endBeat - w.length
  const rmsNow = w[w.length - 1].logRms
  const rmsSlopePerBeat = slope(w.map((c) => c.logRms)) / w.length
  let byProjection = 24
  if (rmsSlopePerBeat > 1e-4) byProjection = Math.max(1, (0.95 - rmsNow) / rmsSlopePerBeat)
  // Nearest upcoming 8/16/32-beat grid target from the build start.
  const elapsed = endBeat - start
  const grid = [8, 16, 32].map((g) => g - (elapsed % g)).filter((d) => d >= 1)
  const byGrid = grid.length ? Math.min(...grid) : 16
  const beatsTillDrop = Math.round(Math.min(48, Math.max(1, Math.min(byProjection, byGrid))))
  const progress = clamp01(Math.max(score, elapsed / (elapsed + beatsTillDrop + 1e-6)))

  return { active: true, score, progress, beatsTillDrop, startBeat: start }
}

/**
 * Full segmentation from a beat-cell window: build the three SSMs, fuse
 * novelty, pick boundaries, cut segments, label repetitions + kinds.
 */
export function segment(cells: BeatCell[]): {
  novelty: number[]
  boundaries: { beat: number; strength: number }[]
  segments: StructureSegment[]
} {
  const n = cells.length
  if (n < STRUCTURE_DSP.minSegmentBeats * 2) {
    return { novelty: [], boundaries: [], segments: [] }
  }
  const cellBeats = cells.map((c) => c.beat)
  const timbreSsm = selfSimilarity(cells.map((c) => c.mfcc))
  const harmSsm = selfSimilarity(cells.map((c) => c.hpcp))
  const scalarSsm = selfSimilarity(
    cells.map((c) => [c.logRms, c.centroid, c.flatness, c.air, c.sub, c.bass, c.flux]),
  )
  const novelty = fuseNovelty([
    { curve: checkerboardNovelty(timbreSsm), weight: STRUCTURE_DSP.fuse.timbre },
    { curve: checkerboardNovelty(harmSsm), weight: STRUCTURE_DSP.fuse.harm },
    { curve: checkerboardNovelty(scalarSsm), weight: STRUCTURE_DSP.fuse.scalar },
  ])
  const boundaries = pickBoundaries(novelty, cellBeats)

  // Cut segments at the boundary beats (plus the window ends).
  const cutBeats = [cellBeats[0], ...boundaries.map((b) => b.beat), cellBeats[n - 1] + 1]
  const raw: {
    startBeat: number
    endBeat: number
    meanEnergy: number
    meanFlatness: number
    vec: number[]
  }[] = []
  for (let k = 0; k < cutBeats.length - 1; k++) {
    const a = cutBeats[k]
    const b = cutBeats[k + 1]
    const inSeg = cells.filter((c) => c.beat >= a && c.beat < b)
    if (inSeg.length === 0) continue
    const meanEnergy = inSeg.reduce((s, c) => s + c.logRms, 0) / inSeg.length
    const meanFlatness = inSeg.reduce((s, c) => s + c.flatness, 0) / inSeg.length
    const dim = inSeg[0].mfcc.length + inSeg[0].hpcp.length
    const vec = new Array(dim).fill(0)
    for (const c of inSeg) {
      const cat = [...c.mfcc, ...c.hpcp]
      for (let d = 0; d < dim; d++) vec[d] += cat[d] / inSeg.length
    }
    raw.push({ startBeat: a, endBeat: b, meanEnergy, meanFlatness, vec })
  }

  const letters = labelRepetitions(raw.map((s) => s.vec))
  const kinds = classifyKinds(raw, cellBeats[0])
  const segments: StructureSegment[] = raw.map((s, i) => ({
    startBeat: s.startBeat,
    endBeat: s.endBeat,
    kind: kinds[i],
    repetitionLabel: letters[i],
    meanEnergy: clamp01(s.meanEnergy),
    meanFlatness: clamp01(s.meanFlatness),
  }))

  return { novelty, boundaries, segments }
}
