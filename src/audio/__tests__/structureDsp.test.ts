import { describe, expect, it } from 'vitest'
import {
  asymmetricCheckerboardNovelty,
  checkerboardNovelty,
  classifyKinds,
  confirmBoundaries,
  cosine,
  cutSegments,
  detectBoundaries,
  dualKernelNovelty,
  fuseNovelty,
  labelRepetitions,
  minPastFor,
  pickBoundaries,
  riserScore,
  segment,
  selfSimilarity,
  STRUCTURE_DSP,
  type BeatCell,
} from '../essentia/structureDsp'

/** A beat cell with sensible defaults; override what a test cares about. */
function cell(beat: number, o: Partial<BeatCell> = {}): BeatCell {
  return {
    beat,
    hpcp: o.hpcp ?? new Array(12).fill(1 / Math.sqrt(12)),
    mfcc: o.mfcc ?? new Array(8).fill(0),
    logRms: o.logRms ?? 0.4,
    centroid: o.centroid ?? 0.4,
    flux: o.flux ?? 0.2,
    flatness: o.flatness ?? 0.3,
    air: o.air ?? 0.2,
    sub: o.sub ?? 0.4,
    bass: o.bass ?? 0.4,
    mid: o.mid ?? 0.4,
    high: o.high ?? 0.2,
    onsetDensity: o.onsetDensity ?? 0,
  }
}

describe('cosine / selfSimilarity', () => {
  it('cosine is 1 for parallel, 0 for orthogonal, 0 for a zero vector', () => {
    expect(cosine([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 6)
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 6)
    expect(cosine([0, 0], [1, 1])).toBe(0)
  })

  it('selfSimilarity has a unit diagonal and is symmetric', () => {
    const m = selfSimilarity([
      [1, 0],
      [0, 1],
      [1, 1],
    ])
    expect(m[0][0]).toBe(1)
    expect(m[1][1]).toBe(1)
    expect(m[0][1]).toBeCloseTo(m[1][0], 9)
    expect(m[0][2]).toBeCloseTo(m[2][0], 9)
  })
})

describe('checkerboardNovelty', () => {
  it('peaks at the boundary of a two-block self-similar matrix', () => {
    const n = 48
    const vecs: number[][] = []
    for (let i = 0; i < n; i++) vecs.push(i < n / 2 ? [1, 0, 0] : [0, 1, 0])
    const nov = checkerboardNovelty(selfSimilarity(vecs), 8)
    let peakIdx = 0
    let peak = -1
    for (let i = 0; i < n; i++) {
      if (nov[i] > peak) {
        peak = nov[i]
        peakIdx = i
      }
    }
    expect(Math.abs(peakIdx - n / 2)).toBeLessThanOrEqual(2)
    expect(peak).toBeCloseTo(1, 5)
  })

  it('is flat (no strong peak) for a uniform matrix', () => {
    const n = 32
    const vecs = Array.from({ length: n }, () => [1, 1, 1])
    const nov = checkerboardNovelty(selfSimilarity(vecs), 8)
    expect(Math.max(...nov)).toBeLessThan(0.5)
  })
})

describe('selfSimilarity: mean-centring', () => {
  it('centring turns "same direction, different level" clusters into NEGATIVE cross similarity', () => {
    // Two clusters of non-negative vectors: raw cosines are all high (~0.7+), centred ones are +1 / -1.
    const vecs: number[][] = []
    for (let i = 0; i < 20; i++) vecs.push(i < 10 ? [1, 0.5] : [0.5, 1])
    const raw = selfSimilarity(vecs)
    const centred = selfSimilarity(vecs, { center: true })
    expect(raw[0][15]).toBeGreaterThan(0.7)
    expect(centred[0][15]).toBeCloseTo(-1, 6)
    expect(centred[0][5]).toBeCloseTo(1, 6)
    expect(centred[3][3]).toBe(1)
  })

  it('a perfectly stationary window centres to the identity (no phantom structure from float noise)', () => {
    const vecs = Array.from({ length: 12 }, () => [0.4, 0.3, 0.9])
    const m = selfSimilarity(vecs, { center: true })
    for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) expect(m[i][j]).toBe(i === j ? 1 : 0)
  })

  it('gamma sharpens (weak similarities shrink faster than strong ones) and keeps the sign', () => {
    const vecs = [
      [1, 0],
      [0.8, 0.6], // cos 0.8 with the first
      [-0.8, 0.6], // cos -0.8 with the first
    ]
    const g1 = selfSimilarity(vecs)
    const g2 = selfSimilarity(vecs, { gamma: 2 })
    expect(g2[0][1]).toBeCloseTo(g1[0][1] ** 2, 9)
    expect(g2[0][2]).toBeCloseTo(-(Math.abs(g1[0][2]) ** 2), 9)
  })
})

/** Two-block matrix: cells [0, join) are class A, [join, n) class B; centred so cross-block = -1. */
function twoBlockSsm(n: number, join: number): number[][] {
  const vecs: number[][] = []
  for (let i = 0; i < n; i++) vecs.push(i < join ? [1, 0.2, 0] : [0.2, 1, 0])
  return selfSimilarity(vecs, { center: true })
}

describe('asymmetricCheckerboardNovelty', () => {
  it('scores exactly 0 on a uniform (stationary) matrix, whatever the side lengths', () => {
    const n = 64
    const ones = Array.from({ length: n }, () => new Array(n).fill(1))
    for (const past of [8, 24]) for (const future of [4, 6]) {
      const nov = asymmetricCheckerboardNovelty(ones, past, future)
      expect(Math.max(...nov)).toBeCloseTo(0, 9)
    }
    // ...and on the identity (what a perfectly stationary, centred window gives).
    const id = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)))
    expect(Math.max(...asymmetricCheckerboardNovelty(id, 8, 4))).toBeCloseTo(0, 9)
  })

  it('peaks at exactly 1 on the seam of a perfect centred two-block matrix', () => {
    const n = 64
    const nov = asymmetricCheckerboardNovelty(twoBlockSsm(n, 32), 8, 4)
    expect(nov[32]).toBeCloseTo(1, 9)
    expect(nov.indexOf(Math.max(...nov))).toBe(32)
    expect(nov[31]).toBeLessThan(0.9)
    expect(nov[33]).toBeLessThan(0.9)
  })

  it('is on a fixed absolute scale: a non-centred change (across-seam similarity 0) tops out near 0.45', () => {
    const n = 64
    const vecs: number[][] = []
    for (let i = 0; i < n; i++) vecs.push(i < 32 ? [1, 0, 0] : [0, 1, 0])
    const nov = asymmetricCheckerboardNovelty(selfSimilarity(vecs), 8, 4)
    expect(Math.max(...nov)).toBeGreaterThan(0.35)
    expect(Math.max(...nov)).toBeLessThan(0.5)
  })

  it('zeroes only the newest future-1 seams (the lookahead) and the oldest minPastFor(past) seams', () => {
    const n = 64
    const ssm = twoBlockSsm(n, 32)
    const nov = asymmetricCheckerboardNovelty(ssm, 8, 4)
    // Newest: seams n-3..n-1 are zero (a seam needs 4 cells after it), n-4 is scored.
    for (let i = n - 3; i < n; i++) expect(nov[i]).toBe(0)
    // ...and a change exactly 4 cells from the end (seam n-4: 4 cells of "after") is fully seen.
    expect(asymmetricCheckerboardNovelty(twoBlockSsm(n, n - 4), 8, 4)[n - 4]).toBeCloseTo(1, 9)
    // Oldest: nothing scored before minPastFor(8) = 8 cells of past exist.
    for (let i = 0; i < minPastFor(8); i++) expect(nov[i]).toBe(0)
    expect(minPastFor(8)).toBe(8)
    expect(minPastFor(24)).toBe(12)
    // The symmetric kernel of the same short width zeroes its newest 8 (the delay this replaces).
    const legacy = checkerboardNovelty(ssm, 8)
    for (let i = n - 8; i < n; i++) expect(legacy[i]).toBe(0)
  })
})

describe('dualKernelNovelty (asymmetric, absolute scale)', () => {
  const n = 64
  const ssm = twoBlockSsm(n, 32)

  // UPDATED (was: symmetric [8, 32] kernels, running-max normalised): the fused curve now uses the
  // asymmetric past/future kernels at past widths [8, 24] and stays on the ABSOLUTE scale, so it peaks
  // at the seam itself and at 1 only because this fixture is a perfect centred two-block change.
  it('returns a fused curve of the right length, peaking at the seam', () => {
    const nov = dualKernelNovelty(ssm, [8, 24])
    expect(nov).toHaveLength(n)
    const peakIdx = nov.indexOf(Math.max(...nov))
    expect(peakIdx).toBe(32)
    expect(nov[32]).toBeCloseTo(1, 9)
  })

  it('degrades to a single-kernel result when given one width', () => {
    expect(dualKernelNovelty(ssm, [8])).toEqual(asymmetricCheckerboardNovelty(ssm, 8, STRUCTURE_DSP.lookahead))
  })

  it('returns empty for an empty widths list', () => {
    expect(dualKernelNovelty(ssm, [])).toEqual([])
  })

  it('is the 0.6 / 0.4 blend of its components, re-weighted where the long scale is not yet usable', () => {
    const short = asymmetricCheckerboardNovelty(ssm, 8, 4)
    const long = asymmetricCheckerboardNovelty(ssm, 24, 4)
    const fused = dualKernelNovelty(ssm, [8, 24], 4)
    const longStart = minPastFor(24)
    for (let i = 0; i < n; i++) {
      const expected = i >= longStart ? 0.6 * short[i] + 0.4 * long[i] : short[i]
      expect(fused[i]).toBeCloseTo(expected, 9)
    }
  })

  it('an unusable-scale seam near the window start is not deflated by the long scale', () => {
    // A change at seam 10: the long scale (needs 12 past cells) cannot score it, the short one can.
    const early = twoBlockSsm(n, 10)
    const fused = dualKernelNovelty(early, [8, 24], 4)
    expect(fused[10]).toBeGreaterThan(0.8)
  })
})

describe('fuseNovelty', () => {
  it('ignores zero-weight and empty curves, renormalises to a unit peak', () => {
    const out = fuseNovelty([
      { curve: [0, 0.5, 1, 0.5, 0], weight: 1 },
      { curve: [], weight: 1 },
      { curve: [9, 9, 9, 9, 9], weight: 0 },
    ])
    expect(out).toHaveLength(5)
    expect(Math.max(...out)).toBeCloseTo(1, 6)
    expect(out[2]).toBeCloseTo(1, 6)
  })

  it('normalize=false keeps the ABSOLUTE scale (what segment() needs for its novelty floor)', () => {
    const out = fuseNovelty(
      [
        { curve: [0, 0.2, 0.4, 0.2, 0], weight: 1 },
        { curve: [0, 0.1, 0.2, 0.1, 0], weight: 1 },
      ],
      false,
    )
    expect(out[2]).toBeCloseTo(0.3, 9)
  })
})

describe('pickBoundaries', () => {
  const beats = (n: number) => Array.from({ length: n }, (_, i) => i * 2)

  it('returns nothing for a flat curve', () => {
    const nov = new Array(40).fill(0.3)
    expect(pickBoundaries(nov, beats(40))).toEqual([])
  })

  it('picks two well-separated peaks but collapses two close ones', () => {
    const far = new Array(60).fill(0.1)
    far[15] = 0.9
    far[45] = 0.9
    expect(pickBoundaries(far, beats(60), 8).length).toBe(2)

    const near = new Array(60).fill(0.1)
    near[20] = 0.8
    near[22] = 0.9
    const picked = pickBoundaries(near, beats(60), 8)
    expect(picked.length).toBe(1)
    expect(picked[0].beat).toBe(44) // index 22 * 2
  })
})

describe('pickBoundaries: absolute novelty floor', () => {
  const beats = (n: number) => Array.from({ length: n }, (_, i) => i * 2)

  // NEW (was: only the local-median + delta rule): a curve whose peak stands out from its own quiet
  // surroundings but is small in absolute terms — what a stationary passage looks like once it is no
  // longer peak-normalised up to 1 — must not produce a boundary.
  it('a peak that clears the local median but not the floor is not a boundary; a big one still is', () => {
    const small = new Array(60).fill(0.02)
    small[30] = 0.15 // 0.13 above the median: passes the old rule, is below the noveltyFloor
    expect(pickBoundaries(small, beats(60))).toEqual([])
    expect(pickBoundaries(small, beats(60), 8, STRUCTURE_DSP.peakDelta, 0)).toHaveLength(1)
    const big = new Array(60).fill(0.02)
    big[30] = 0.5
    const picked = pickBoundaries(big, beats(60))
    expect(picked).toHaveLength(1)
    expect(picked[0].strength).toBeCloseTo(0.5, 9)
  })
})

describe('labelRepetitions', () => {
  it('labels an ABAB C pattern', () => {
    const A = [1, 0, 0, 0]
    const B = [0, 1, 0, 0]
    const C = [0, 0, 1, 0]
    expect(labelRepetitions([A, B, A.slice(), B.slice(), C])).toEqual(['A', 'B', 'A', 'B', 'C'])
  })
})

describe('classifyKinds', () => {
  it('labels a low-energy first segment intro and a quiet tonal dip breakdown', () => {
    const segs = [
      { startBeat: 0, endBeat: 16, meanEnergy: 0.2, meanFlatness: 0.4 },
      { startBeat: 16, endBeat: 48, meanEnergy: 0.8, meanFlatness: 0.3 },
      { startBeat: 48, endBeat: 64, meanEnergy: 0.25, meanFlatness: 0.2 },
      { startBeat: 64, endBeat: 96, meanEnergy: 0.85, meanFlatness: 0.3 },
      { startBeat: 96, endBeat: 112, meanEnergy: 0.3, meanFlatness: 0.4 },
    ]
    const kinds = classifyKinds(segs, 0)
    expect(kinds[0]).toBe('intro')
    expect(kinds[2]).toBe('breakdown')
    expect(kinds[1]).toBe('section')
    expect(kinds[4]).toBe('outro')
  })
})

describe('classifyKinds: trailing-segment length guard', () => {
  // NEW: with a ~4-beat lookahead the newest boundary can sit a few beats from the live edge; a few
  // quiet beats at the window edge are not the song's end.
  it('a quiet trailing segment shorter than minSegmentBeats is not called outro; a full-length one still is', () => {
    const mk = (lastLen: number) => [
      { startBeat: 0, endBeat: 40, meanEnergy: 0.7, meanFlatness: 0.3 },
      { startBeat: 40, endBeat: 40 + lastLen, meanEnergy: 0.6, meanFlatness: 0.3 },
      { startBeat: 40 + lastLen, endBeat: 40 + lastLen + 5, meanEnergy: 0.5, meanFlatness: 0.3 },
    ]
    expect(classifyKinds(mk(30), 0)[2]).toBe('section') // 5-beat tail
    const long = [
      { startBeat: 0, endBeat: 40, meanEnergy: 0.7, meanFlatness: 0.3 },
      { startBeat: 40, endBeat: 80, meanEnergy: 0.6, meanFlatness: 0.3 },
      { startBeat: 80, endBeat: 96, meanEnergy: 0.5, meanFlatness: 0.3 },
    ]
    expect(classifyKinds(long, 0)[2]).toBe('outro') // 16-beat tail
  })
})

describe('riserScore', () => {
  it('fires on a classic riser and snaps beatsTillDrop to the beat grid', () => {
    const cells: BeatCell[] = []
    for (let i = 0; i < 24; i++) {
      const t = i / 23
      cells.push(
        cell(100 + i, {
          centroid: 0.3 + t * 0.5,
          logRms: 0.3 + t * 0.4,
          flatness: 0.2 + t * 0.4,
          air: 0.1 + t * 0.5,
          flux: 0.1 + t * 0.4,
          sub: 0.6 - t * 0.4,
          bass: 0.6 - t * 0.4,
        }),
      )
    }
    const b = riserScore(cells, 100)
    expect(b.active).toBe(true)
    expect(b.score).toBeGreaterThan(0.55)
    expect(b.beatsTillDrop).toBeGreaterThanOrEqual(1)
    expect(b.beatsTillDrop).toBeLessThanOrEqual(48)
    expect(b.startBeat).toBe(100)
  })

  it('stays inactive for a steady passage', () => {
    const cells = Array.from({ length: 24 }, (_, i) => cell(i))
    const b = riserScore(cells, -1)
    expect(b.active).toBe(false)
    expect(b.beatsTillDrop).toBe(-1)
  })

  it('a rising high band + rising onsetDensity scores higher than an otherwise-identical flat sequence', () => {
    const rising: BeatCell[] = []
    const flat: BeatCell[] = []
    for (let i = 0; i < 24; i++) {
      const t = i / 23
      rising.push(cell(100 + i, { high: 0.2 + t * 0.6, onsetDensity: 0 + t * 0.9 }))
      flat.push(cell(100 + i, { high: 0.2, onsetDensity: 0 }))
    }
    const bRising = riserScore(rising, 100)
    const bFlat = riserScore(flat, 100)
    expect(bRising.score).toBeGreaterThan(bFlat.score)
  })

  it('the optional `enter` threshold gives per-beat callers hysteresis: a score between exit and enter is active only with the lower bar', () => {
    // A mild rise: centroid + logRms + high only, so the score lands between buildExit and buildEnter.
    const cells: BeatCell[] = []
    for (let i = 0; i < 24; i++) {
      const t = i / 23
      cells.push(cell(100 + i, { centroid: 0.3 + t * 0.4, logRms: 0.3 + t * 0.3, high: 0.2 + t * 0.4 }))
    }
    const strict = riserScore(cells, 100)
    expect(strict.score).toBeGreaterThan(STRUCTURE_DSP.buildExit)
    expect(strict.score).toBeLessThanOrEqual(STRUCTURE_DSP.buildEnter)
    expect(strict.active).toBe(false)
    const lenient = riserScore(cells, 100, STRUCTURE_DSP.riserWindow, STRUCTURE_DSP.buildExit)
    expect(lenient.score).toBe(strict.score) // the score itself is untouched
    expect(lenient.active).toBe(true)
    expect(lenient.startBeat).toBe(100)
  })
})

describe('segment (end to end)', () => {
  it('finds a boundary between two timbrally distinct halves', () => {
    const cells: BeatCell[] = []
    for (let i = 0; i < 64; i++) {
      const first = i < 32
      cells.push(
        cell(i, {
          mfcc: first ? [1, 0.2, 0, 0, 0, 0, 0, 0] : [0, 0, 1, 0.3, 0, 0, 0, 0],
          logRms: first ? 0.35 : 0.7,
        }),
      )
    }
    const { boundaries, segments } = segment(cells)
    expect(boundaries.length).toBeGreaterThanOrEqual(1)
    const near = boundaries.some((b) => Math.abs(b.beat - 32) <= 6)
    expect(near).toBe(true)
    expect(segments.length).toBeGreaterThanOrEqual(2)
  })

  it('returns empty for a too-short window', () => {
    const { boundaries } = segment(Array.from({ length: 6 }, (_, i) => cell(i)))
    expect(boundaries).toEqual([])
  })
})

/** Deterministic PRNG (mulberry32) so the noisy fixtures below are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Two "textures" with realistic 13-band / 12-bin shapes; `noise` is the relative per-feature wobble. */
const TEX_A = { mfcc: [0.9, 0.8, 0.7, 0.6, 0.5, 0.45, 0.4, 0.35, 0.3, 0.3, 0.25, 0.2, 0.2], loud: 0.4, cen: 0.4, bass: 0.6 }
const TEX_B = { mfcc: [0.3, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.9, 0.8, 0.7, 0.6, 0.5], loud: 0.75, cen: 0.65, bass: 0.35 }
function texCell(beat: number, tex: typeof TEX_A, noise: number, rand: () => number): BeatCell {
  const w = (v: number) => v * (1 + noise * (rand() * 2 - 1))
  const hp = new Array(12).fill(0).map((_, i) => 0.3 + 0.1 * ((i * 5) % 7))
  return cell(beat, {
    mfcc: tex.mfcc.map(w),
    hpcp: hp.map(w),
    logRms: w(tex.loud),
    centroid: w(tex.cen),
    sub: w(tex.bass),
    bass: w(tex.bass),
    flux: w(0.2),
    flatness: w(0.3),
    air: w(0.2),
  })
}
/** `n` cells; cells before `join` are texture A, from `join` on texture B (join >= n: all A). */
function synthetic(n: number, join: number, noise: number, seed: number, firstBeat = 0): BeatCell[] {
  const rand = rng(seed)
  return Array.from({ length: n }, (_, i) => texCell(firstBeat + i, i < join ? TEX_A : TEX_B, noise, rand))
}

describe('segmentation on synthetic signals (absolute floor + lookahead)', () => {
  // NEW: stationary audio must yield nothing. Before, each window's own peak was normalised up to 1,
  // so even pure wobble produced a "peak" that cleared the median + delta rule.
  it('stationary signals yield no boundaries: perfectly constant, and constant + 3% / 6% wobble', () => {
    expect(detectBoundaries(synthetic(120, 999, 0, 1)).boundaries).toEqual([])
    for (const noise of [0.03, 0.06]) {
      for (let seed = 1; seed <= 6; seed++) {
        const { boundaries, novelty } = detectBoundaries(synthetic(120, 999, noise, seed))
        expect(boundaries, `noise ${noise} seed ${seed}`).toEqual([])
        // ...and the curve itself stays well under the floor: it is genuinely flat, not just gated.
        expect(Math.max(...novelty)).toBeLessThan(STRUCTURE_DSP.noveltyFloor)
      }
    }
    expect(segment(synthetic(120, 999, 0.03, 9)).segments.length).toBe(1)
  })

  it('two clearly different halves give a boundary right at the join, with and without wobble', () => {
    for (const noise of [0, 0.03, 0.06]) {
      for (let seed = 1; seed <= 4; seed++) {
        const { boundaries } = detectBoundaries(synthetic(96, 48, noise, seed))
        const near = boundaries.filter((b) => Math.abs(b.beat - 48) <= 2)
        expect(near.length, `noise ${noise} seed ${seed}`).toBe(1)
        expect(near[0].strength).toBeGreaterThan(STRUCTURE_DSP.strongBoundary) // a clear change is "strong"
        expect(boundaries.length).toBeLessThanOrEqual(2)
      }
    }
    const seg = segment(synthetic(96, 48, 0.03, 3))
    expect(seg.segments.length).toBeGreaterThanOrEqual(2)
    expect(seg.segments.some((s) => Math.abs(s.startBeat - 48) <= 2)).toBe(true)
  })

  // NEW (the point of the asymmetric kernel): a boundary is reported once only ~lookahead (4) beats of
  // "after" exist. The old symmetric 8-cell kernel zeroed its newest 8 cells, so it could not see it.
  it('reports a boundary within ~lookahead beats of the join (old symmetric kernel: >= 8)', () => {
    const F = STRUCTURE_DSP.lookahead
    const join = 40
    const nearJoin = (n: number, noise = 0) => {
      const cells = synthetic(n, join, noise, 5)
      return detectBoundaries(cells).boundaries.filter((b) => Math.abs(b.beat - join) <= 2)
    }
    // Newest cell = join + F: the seam has its full lookahead and a scored lower neighbour -> reported.
    expect(nearJoin(join + F + 1)).toHaveLength(1)
    expect(nearJoin(join + F + 1)[0].beat).toBe(join)
    expect(nearJoin(join + F + 1, 0.03)).toHaveLength(1)
    // One beat earlier the last scored seam is the join itself, which cannot be picked yet.
    expect(nearJoin(join + F)).toHaveLength(0)
    // Any later window keeps reporting it (within the +-2 persistence tolerance).
    for (const extra of [2, 5, 9, 20]) expect(nearJoin(join + F + 1 + extra)).toHaveLength(1)

    // The legacy symmetric M=8 kernel (kept exported for reference) sees nothing at that lag...
    const cells = synthetic(join + F + 1, join, 0, 5)
    const vecs = cells.map((c) => c.mfcc)
    const legacy = checkerboardNovelty(selfSimilarity(vecs, { center: true }), 8)
    const legacyPicks = pickBoundaries(legacy, cells.map((c) => c.beat))
    expect(legacyPicks.filter((b) => Math.abs(b.beat - join) <= 2)).toHaveLength(0)
    // ...and needs its full M cells of "after".
    const later = synthetic(join + 8 + 3, join, 0, 5)
    const laterPicks = pickBoundaries(
      checkerboardNovelty(selfSimilarity(later.map((c) => c.mfcc), { center: true }), 8),
      later.map((c) => c.beat),
    )
    expect(laterPicks.filter((b) => Math.abs(b.beat - join) <= 2).length).toBeGreaterThanOrEqual(1)
  })

  it('works on windows that do not start at beat 0 (absolute engine beats)', () => {
    const { boundaries } = detectBoundaries(synthetic(80, 40, 0.03, 2, 1000))
    expect(boundaries.some((b) => Math.abs(b.beat - 1040) <= 2)).toBe(true)
  })

  it('a barely-there change (few-percent level step) stays under the floor', () => {
    const rand = rng(7)
    const cells = Array.from({ length: 96 }, (_, i) => {
      const c = texCell(i, TEX_A, 0.03, rand)
      return i < 48 ? c : { ...c, logRms: c.logRms * 1.03 }
    })
    expect(detectBoundaries(cells).boundaries).toEqual([])
  })
})

describe('confirmBoundaries (cross-batch persistence)', () => {
  const c = (beat: number, strength: number) => ({ beat, strength })

  it('a weak candidate needs a previous-batch candidate within +-2 beats; a strong one does not', () => {
    const weak = c(100, 0.25)
    expect(confirmBoundaries([weak], [])).toEqual([])
    expect(confirmBoundaries([weak], [100])).toEqual([weak])
    expect(confirmBoundaries([weak], [98])).toEqual([weak])
    expect(confirmBoundaries([weak], [102])).toEqual([weak])
    expect(confirmBoundaries([weak], [97])).toEqual([])
    expect(confirmBoundaries([weak], [103])).toEqual([])
    const strong = c(100, STRUCTURE_DSP.strongBoundary)
    expect(confirmBoundaries([strong], [])).toEqual([strong])
  })

  it('filters per candidate and keeps input order', () => {
    const out = confirmBoundaries([c(40, 0.25), c(60, 0.25), c(80, 0.5)], [41, 200])
    expect(out.map((b) => b.beat)).toEqual([40, 80])
  })

  it('cutSegments cuts only at the beats it is given (so unconfirmed candidates leave no segment)', () => {
    const cells = synthetic(96, 48, 0, 1)
    expect(cutSegments(cells, []).length).toBe(1)
    const two = cutSegments(cells, [48])
    expect(two.map((s) => [s.startBeat, s.endBeat])).toEqual([
      [0, 48],
      [48, 96],
    ])
  })
})
