import { describe, expect, it } from 'vitest'
import { DEFAULT_GAP_DROP, GapDropDetector, type GapDropFire } from '../gapDrop'

const SPB = 0.5

/** Feed `n` cells of low-band level `db` starting at cell index `from`; returns the fires. */
function feed(d: GapDropDetector, from: number, n: number, db: number | ((i: number) => number)): Array<GapDropFire & { at: number }> {
  const out: Array<GapDropFire & { at: number }> = []
  for (let i = from; i < from + n; i++) {
    const v = typeof db === 'number' ? db : db(i)
    const f = d.push(v, i * SPB, i)
    if (f) out.push({ ...f, at: i })
  }
  return out
}

/** A warmed-up detector with `steady` cells at -40 dB. */
function warm(cfg = {}, steady = 64): GapDropDetector {
  const d = new GapDropDetector(cfg)
  feed(d, 0, steady, -40)
  return d
}

describe('GapDropDetector: a dropout of at least a bar and the low end returning whole is a drop', () => {
  it('fires once, at the first cell back, with the last out cell as the boundary', () => {
    const d = warm()
    expect(feed(d, 64, 8, -70)).toEqual([]) // 4 s without the low end
    const f = feed(d, 72, 1, -40)
    expect(f).toHaveLength(1)
    expect(f[0].detectedBeat).toBe(72)
    expect(f[0].boundaryBeat).toBe(71)
    expect(f[0].boundaryTime).toBeCloseTo(71 * SPB)
    expect(f[0].gapCells).toBe(8)
    expect(f[0].depthDb).toBeCloseTo(30, 0)
    // nothing more while the music goes on
    expect(feed(d, 73, 60, -40)).toEqual([])
  })

  it('a longer gap is a stronger, more confident drop (the only evidence there is)', () => {
    const a = warm()
    feed(a, 64, 5, -55)
    const fa = feed(a, 69, 1, -40)[0]
    const b = warm()
    feed(b, 64, 20, -80)
    const fb = feed(b, 84, 1, -40)[0]
    expect(fa).toBeDefined()
    expect(fb).toBeDefined()
    expect(fb.strength).toBeGreaterThan(fa.strength)
    expect(fb.confidence).toBeGreaterThan(fa.confidence)
    for (const f of [fa, fb]) {
      expect(f.strength).toBeLessThanOrEqual(1)
      expect(f.confidence).toBeLessThanOrEqual(1)
      expect(f.strength).toBeGreaterThanOrEqual(0.6)
      expect(f.confidence).toBeGreaterThanOrEqual(0.5)
    }
  })

  it('digital silence counts as out', () => {
    const d = warm()
    feed(d, 64, 6, -120)
    expect(feed(d, 70, 1, -40)).toHaveLength(1)
  })

  it('a PARTIAL return (bass back, sub still out) is not the drop; the whole return is', () => {
    const d = warm()
    feed(d, 64, 6, -80)
    expect(feed(d, 70, 4, -55)).toEqual([]) // 15 dB under the reference: still out
    const f = feed(d, 74, 1, -40)
    expect(f).toHaveLength(1)
    expect(f[0].gapCells).toBe(10)
  })
})

describe('GapDropDetector: what must not fire', () => {
  it('short dips of a pumping / sidechained passage (1-3 cells, over and over) never fire', () => {
    const d = warm()
    // 2 cells out, 2 cells in, ... for 30 s
    const fires = feed(d, 64, 60, (i) => ((i - 64) % 4 < 2 ? -62 : -40))
    expect(fires).toEqual([])
    // and 3-cell rests every 5 cells (1.5 s, shorter than a bar of 4 cells x 0.5 s = 2 s and than minSec)
    const d2 = warm()
    expect(feed(d2, 64, 100, (i) => ((i - 64) % 5 < 3 ? -60 : -40))).toEqual([])
  })

  it('a dropout shorter than minCells or minSec does not fire', () => {
    const d = warm()
    feed(d, 64, 3, -70)
    expect(feed(d, 67, 1, -40)).toEqual([])
    // long enough in cells but too short in seconds (fast cells)
    const d2 = new GapDropDetector()
    for (let i = 0; i < 64; i++) d2.push(-40, i * 0.1, i)
    for (let i = 64; i < 70; i++) d2.push(-70, i * 0.1, i)
    expect(d2.push(-40, 7.0, 70)).toBeNull()
  })

  it('a low band that is only a little lower (under lowDb) is not a dropout', () => {
    const d = warm()
    feed(d, 64, 20, -40 - DEFAULT_GAP_DROP.lowDb + 2)
    expect(feed(d, 84, 1, -40)).toEqual([])
  })

  it('a gap longer than maxSec is a quiet passage, not a breakdown before a drop, and the next real one still fires', () => {
    const d = warm()
    feed(d, 64, 80, -80) // 40 s
    expect(feed(d, 144, 1, -40)).toEqual([])
    feed(d, 145, 60, -40)
    feed(d, 205, 8, -80)
    expect(feed(d, 213, 1, -40)).toHaveLength(1)
  })

  it('a refractory period follows a fire: a second dropout right after is ignored, a later one fires', () => {
    const d = warm()
    feed(d, 64, 8, -80)
    expect(feed(d, 72, 1, -40)).toHaveLength(1)
    feed(d, 73, 3, -40)
    feed(d, 76, 8, -80) // 2 s after the fire: inside refractorySec (6 s)
    expect(feed(d, 84, 1, -40)).toEqual([])
    feed(d, 85, 30, -40)
    feed(d, 115, 8, -80)
    expect(feed(d, 123, 1, -40)).toHaveLength(1)
  })

  it('nothing fires before warmCells cells of history exist', () => {
    const d = new GapDropDetector()
    feed(d, 0, 10, -40)
    feed(d, 10, 8, -80)
    expect(feed(d, 18, 1, -40)).toEqual([])
  })

  it('the reference is frozen during the dropout and is a median, not a mean (a loud outlier does not move it)', () => {
    const d = warm({}, 40)
    feed(d, 40, 2, -10) // two loud hits
    feed(d, 42, 30, -40)
    feed(d, 72, 8, -75)
    expect(feed(d, 80, 1, -40)).toHaveLength(1)
  })

  it('non-finite input is ignored and does not corrupt the state', () => {
    const d = warm()
    expect(d.push(Number.NaN, 40, 80)).toBeNull()
    expect(d.push(-40, Number.NaN, 81)).toBeNull()
    feed(d, 64, 8, -70)
    expect(feed(d, 72, 1, -40)).toHaveLength(1)
  })

  it('reset() forgets everything: no fire from a dropout begun before it', () => {
    const d = warm()
    feed(d, 64, 8, -70)
    d.reset()
    expect(feed(d, 72, 1, -40)).toEqual([])
  })
})
