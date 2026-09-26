import { describe, expect, it } from 'vitest'
import { CH_HARMONY, CH_LEVEL, CH_TIMBRE, extractFeatures } from '../barFeatures'
import type { BeatPrior } from '../barGrid'
import { ChangeScorer, DEFAULT_SCORER, type Candidate } from '../changeScorer'
import { CHORUS, VERSE, makeCell, mulberry, smoothChroma, type CellOptions, type SectionSpec } from './cellFactory'

/** Feed cells to a scorer directly (the EventLayer's job, minus typing): returns copies of every accepted candidate. */
function feed(
  sc: ChangeScorer,
  plan: ReadonlyArray<readonly [SectionSpec, number, CellOptions?]>,
  opts: { seed?: number; prior?: BeatPrior | null; smooth?: boolean } = {},
): Candidate[] {
  const rnd = mulberry(opts.seed ?? 1)
  const cells = []
  let beat = 1
  for (const [spec, n, o] of plan) for (let i = 0; i < n; i++) cells.push(makeCell(spec, beat++, rnd, o ?? {}))
  if (opts.smooth !== false) smoothChroma(cells)
  const out: Candidate[] = []
  for (const c of cells) {
    const ring = sc.ring
    extractFeatures(c, ring.data, ring.writeOffset())
    ring.commit(c.beat, c.beat * 0.5, c.beat)
    const cand = sc.step(0.5, opts.prior ?? null)
    if (cand) out.push({ ...cand, z: cand.z.slice(), d: cand.d.slice() })
  }
  return out
}

describe('ChangeScorer', () => {
  it('finds a timbre + harmony change at equal level, with its boundary within a beat and its lag = the confirmation delay', () => {
    const sc = new ChangeScorer()
    const cands = feed(sc, [
      [VERSE, 64],
      [CHORUS, 48],
    ])
    expect(cands.length).toBe(1)
    const c = cands[0]
    expect(Math.abs(c.boundaryBeat - 64)).toBeLessThanOrEqual(1.5)
    expect(c.detectedBeat - c.peakBeat).toBe(DEFAULT_SCORER.peakHalf)
    expect(c.z[CH_TIMBRE]).toBeGreaterThan(5)
    expect(c.z[CH_LEVEL]).toBeLessThan(2) // nothing moved in level
    expect(c.sEff).toBeGreaterThanOrEqual(c.thr)
    expect(c.persist).toBeGreaterThan(0.7)
  })

  it('a level-only step has a shape score near zero (the gain signature); a real change does not', () => {
    const gain = feed(new ChangeScorer(), [
      [VERSE, 70],
      [VERSE, 60, { gainDb: 6 }],
    ])
    expect(gain.length).toBe(1)
    expect(gain[0].z[CH_LEVEL]).toBeGreaterThan(5)
    expect(gain[0].shape).toBeLessThan(1.8)
    expect(gain[0].levelDelta).toBeGreaterThan(4)
    const real = feed(new ChangeScorer(), [
      [VERSE, 70],
      [CHORUS, 60],
    ])
    expect(real[0].shape).toBeGreaterThan(5)
  })

  it('a transient returns to the baseline (persist ~ 0); a step does not (persist ~ 1)', () => {
    const transient = feed(new ChangeScorer(), [
      [VERSE, 90],
      [VERSE, 2, { onsetBoost: 0.5, highBoostDb: 16 }],
      [VERSE, 60],
    ])
    expect(transient.length).toBe(1)
    expect(transient[0].persist).toBeLessThan(0.5)
    const step = feed(new ChangeScorer(), [
      [VERSE, 90],
      [VERSE, 60, { onsetBoost: 0.5, highBoostDb: 16 }],
    ])
    expect(step[0].persist).toBeGreaterThan(0.8)
  })

  it('the refractory keeps a second peak within refractoryBeats out; setLastPeakStep() moves it', () => {
    const cfg = { refractoryBeats: 16 }
    const a = feed(new ChangeScorer(cfg), [
      [VERSE, 64],
      [CHORUS, 8],
      [VERSE, 60],
    ])
    expect(a.length).toBe(1) // the return 8 beats later is inside a 16-beat refractory
    const b = feed(new ChangeScorer({ refractoryBeats: 4 }), [
      [VERSE, 64],
      [CHORUS, 12],
      [VERSE, 60],
    ])
    expect(b.length).toBe(2)
    const sc = new ChangeScorer()
    sc.suppressNext(1000)
    expect(
      feed(sc, [
        [VERSE, 64],
        [CHORUS, 60],
      ]).length,
    ).toBe(0)
  })

  it('the grid prior lifts a marginal on-phase candidate over the threshold, never a strong one, and its snap moves the boundary', () => {
    const plan: Array<readonly [SectionSpec, number]> = [
      [VERSE, 90],
      [CHORUS, 60],
    ]
    const base = feed(new ChangeScorer(), plan)
    expect(base.length).toBe(1)
    const s = base[0].s
    // put the floor just above the raw score (so the candidate is marginal, not "strong"): it fails without a prior
    // and passes with a x1.3 prior
    const floor = s * 1.15
    const cfg = { absFloor: floor, k: 0.5, warmScore: 0 }
    const plain = feed(new ChangeScorer(cfg), plan)
    expect(plain.length).toBe(0)
    const prior: BeatPrior = { multiplier: () => 1.3, snap: (b) => Math.round(b) + 1 }
    const boosted = feed(new ChangeScorer(cfg), plan, { prior })
    expect(boosted.length).toBe(1)
    expect(boosted[0].onGrid).toBe(true)
    expect(boosted[0].boundarySeq).toBe(Math.round(boosted[0].boundarySeqRaw) + 1) // snapped by the prior
    // a strong candidate is not multiplied
    const strong = feed(new ChangeScorer(), plan, { prior })
    expect(strong[0].onGrid).toBe(false)
    expect(strong[0].sEff).toBe(strong[0].s)
  })

  it('a chroma-only change (the lagging channel) still gets a boundary within about a bar and a compensated lag', () => {
    const harmony: SectionSpec = { ...VERSE, chroma: CHORUS.chroma }
    const c = feed(new ChangeScorer(), [
      [VERSE, 64],
      [harmony, 60],
    ])
    expect(c.length).toBe(1)
    expect(c[0].z[CH_HARMONY]).toBeGreaterThan(5)
    expect(c[0].extraLag).toBeGreaterThan(3) // it knows the chroma trails
    expect(Math.abs(c[0].boundaryBeat - 64)).toBeLessThanOrEqual(4)
  })

  it('the probe hook sees every scored beat with finite numbers, and invalidate() drops a pending peak', () => {
    const sc = new ChangeScorer()
    let n = 0
    let finite = true
    sc.probe = (_st, d, z, s, thr) => {
      n++
      finite = finite && Number.isFinite(s) && Number.isFinite(thr) && Array.from(d).every(Number.isFinite) && Array.from(z).every(Number.isFinite)
    }
    feed(sc, [[VERSE, 80]])
    expect(n).toBeGreaterThan(50)
    expect(finite).toBe(true)
    // a peak is only confirmed peakHalf beats after it: invalidating one step before the confirmation forgets it
    const play = (invalidateAt: number): number[] => {
      const s2 = new ChangeScorer()
      const rnd = mulberry(3)
      const cells = smoothChroma([
        ...Array.from({ length: 70 }, (_, i) => makeCell(VERSE, i + 1, rnd)),
        ...Array.from({ length: 50 }, (_, i) => makeCell(CHORUS, i + 71, rnd)),
      ])
      const hits: number[] = []
      cells.forEach((c, i) => {
        extractFeatures(c, s2.ring.data, s2.ring.writeOffset())
        s2.ring.commit(c.beat, c.beat * 0.5, c.beat)
        if (i === invalidateAt) s2.invalidate()
        if (s2.step(0.5, null)) hits.push(i)
      })
      return hits
    }
    const plain = play(-1)
    expect(plain.length).toBe(1)
    // the fast hump is forgotten (the slower chroma hump, no longer shadowed by it, may still report the change later)
    const after = play(plain[0] - 1)
    expect(after).not.toContain(plain[0])
    expect(after.every((i) => i > plain[0])).toBe(true)
  })
})
