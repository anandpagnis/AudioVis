import { describe, expect, it } from 'vitest'
import {
  checkerboardNovelty,
  classifyKinds,
  cosine,
  fuseNovelty,
  labelRepetitions,
  pickBoundaries,
  riserScore,
  segment,
  selfSimilarity,
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
