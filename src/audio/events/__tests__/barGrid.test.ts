import { describe, expect, it } from 'vitest'
import { BarGrid } from '../barGrid'

describe('BarGrid: the boundary-anchored bar phase', () => {
  it('starts with no phase, no prior and no cut alignment', () => {
    const g = new BarGrid()
    expect(g.phase()).toBe(-1)
    expect(g.anchored()).toBe(false)
    expect(g.snapReady()).toBe(false)
    expect(g.multiplier(8)).toBe(1)
    expect(g.beatsToBarLine(3)).toBe(-1)
    expect(g.beatInBar(3)).toBe(-1)
    expect(g.snap(7.4)).toBe(7)
  })

  it('converges on the phase of the boundaries (mod 4) with growing confidence', () => {
    const g = new BarGrid()
    let prev = 0
    for (const b of [66, 98, 130, 194]) {
      g.addBoundary(b)
      expect(g.confidence).toBeGreaterThanOrEqual(prev - 1e-9)
      prev = g.confidence
    }
    expect(g.phase()).toBe(2)
    expect(g.anchored()).toBe(true)
    expect(g.snapReady()).toBe(true)
    expect(g.beatInBar(66)).toBe(0)
    expect(g.beatInBar(67)).toBe(1)
    expect(g.beatsToBarLine(67)).toBe(3)
    expect(g.beatsToBarLine(66)).toBe(0)
  })

  it('boosts the score on the anchored bar phase by 1.25 and on the 16-beat phase by a further 1.15, never off-grid', () => {
    const g = new BarGrid()
    for (const b of [64, 96, 160, 192, 256]) g.addBoundary(b) // all = 0 mod 16
    expect(g.phraseAnchored()).toBe(true)
    expect(g.multiplier(320)).toBeCloseTo(1.25 * 1.15, 6) // on the 16-beat phase
    expect(g.multiplier(324)).toBeCloseTo(1.25, 6) // on the bar phase only
    expect(g.multiplier(325)).toBe(1)
    expect(g.multiplier(326)).toBe(1)
  })

  it('does not flip on noise: one contradictory boundary against a settled phase leaves it unchanged', () => {
    const g = new BarGrid()
    for (const b of [64, 96, 128, 192, 224]) g.addBoundary(b)
    expect(g.phase()).toBe(0)
    const before = g.confidence
    g.addBoundary(131) // a stray change 3 beats off the grid
    expect(g.phase()).toBe(0)
    expect(g.confidence).toBeLessThan(before + 1e-9)
    // a jittery estimate (+-1 beat) around the true phase still lands on it
    const j = new BarGrid()
    for (const b of [64.3, 96.9, 127.6, 192.1, 224.8, 256.2]) j.addBoundary(b)
    expect(j.phase()).toBe(0)
  })

  it('is uncertain when the boundaries disagree: no snap, no prior', () => {
    const g = new BarGrid()
    for (const b of [64, 97, 130, 163]) g.addBoundary(b, 1) // 0, 1, 2, 3 mod 4: no phase
    expect(g.snapReady()).toBe(false)
    expect(g.beatsToBarLine(100)).toBe(-1)
  })

  it('snaps a boundary estimate to the nearest bar line within +-2 beats, and leaves a far one alone', () => {
    const g = new BarGrid()
    for (const b of [64, 96, 128]) g.addBoundary(b)
    expect(g.snapReady()).toBe(true)
    expect(g.snap(129.4)).toBe(128)
    expect(g.snap(126.7)).toBe(128)
    expect(g.snap(131.2)).toBe(132)
    expect(g.snap(130)).toBe(128) // a tie goes to the earlier bar line
  })

  it('a DownbeatEstimator hint only breaks a near-tie and only supplies the phase while nothing has voted', () => {
    const g = new BarGrid()
    g.setHint(true, 3)
    expect(g.phase()).toBe(3) // nothing voted: the hint is the phase...
    expect(g.beatsToBarLine(4)).toBe(3) // ...and is enough to cut on
    expect(g.anchored()).toBe(false)
    for (const b of [65, 97, 129]) g.addBoundary(b) // the boundaries say 1: they win over the hint
    expect(g.phase()).toBe(1)
    // near tie between 1 and 3 with the hint at 3: the hint decides
    const t = new BarGrid()
    t.setHint(true, 3)
    t.addBoundary(65)
    t.addBoundary(67)
    expect(t.phase()).toBe(3)
    // an unlocked hint is ignored
    const u = new BarGrid()
    u.setHint(false, 3)
    expect(u.phase()).toBe(-1)
  })

  it('ignores non-finite input and resets cleanly', () => {
    const g = new BarGrid()
    g.addBoundary(Number.NaN)
    g.addBoundary(Number.POSITIVE_INFINITY)
    g.addBoundary(10, 0)
    g.addBoundary(10, Number.NaN)
    expect(g.votes).toBe(0)
    expect(g.multiplier(Number.NaN)).toBe(1)
    expect(g.snap(Number.NaN)).toBeNaN()
    g.addBoundary(6)
    g.addBoundary(10)
    expect(g.phase()).toBe(2)
    g.reset()
    expect(g.phase()).toBe(-1)
    expect(g.confidence).toBe(0)
    expect(g.votes).toBe(0)
  })

  it('old votes decay: a music whose phase changes is followed after enough new boundaries', () => {
    const g = new BarGrid()
    for (const b of [64, 96, 128]) g.addBoundary(b)
    expect(g.phase()).toBe(0)
    for (const b of [194, 226, 258, 290, 322, 354, 386, 418]) g.addBoundary(b) // now 2 mod 4
    expect(g.phase()).toBe(2)
  })
})
