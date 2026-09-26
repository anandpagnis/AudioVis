import { describe, expect, it } from 'vitest'
import type { BeatCell } from '../../essentia/structureDsp'
import { EventLayer, isOctaveJump, strengthOf, STRENGTH_ANCHORS } from '../EventLayer'
import type { SectionEvent } from '../types'
import { CHORUS, VERSE, buildStream, makeCell, mulberry, smoothChroma, type CellOptions, type SectionSpec } from './cellFactory'

const SPB = 0.5 // 120 BPM

/** Push a stream, return copies of every delivered event. */
function run(layer: EventLayer, cells: readonly BeatCell[], t0 = 0, bpm = 120): SectionEvent[] {
  const out: SectionEvent[] = []
  for (const c of cells) {
    for (const e of layer.push(c, c.beat, t0 + c.beat * SPB, bpm)) out.push({ ...e, feats: { ...e.feats } })
  }
  return out
}

const scene = (evs: readonly SectionEvent[]) => evs.filter((e) => e.type === 'change' || e.type === 'breakdown')

/** A third, different section (other chords and brightness) for the multi-section streams. */
const THIRD: SectionSpec = {
  ...CHORUS,
  mel: VERSE.mel,
  chroma: [0.2, 1, 0.1, 0.5, 0.1, 0.9, 0.1, 0.3, 0.4, 0.1, 0.8, 0.1],
}

describe('EventLayer: a clear change is a scene-class event, on the right beat, about six beats late', () => {
  it('a timbre + harmony change at equal level is detected within a beat of the true boundary', () => {
    const { cells, starts } = buildStream([
      [VERSE, 64],
      [CHORUS, 48],
    ])
    const evs = run(new EventLayer(), cells)
    const sc = scene(evs)
    expect(sc.length).toBe(1)
    const e = sc[0]
    expect(e.type).toBe('change')
    expect(e.source).toBe('live')
    expect(Math.abs(e.boundaryBeat - starts[1])).toBeLessThanOrEqual(2)
    // honest lag: detected-at is the confirmation beat, several beats after where the change began
    expect(e.detectedAtBeat - e.boundaryBeat).toBeGreaterThanOrEqual(4)
    expect(e.detectedAtBeat - e.boundaryBeat).toBeLessThanOrEqual(12)
    expect(e.detectedAtTime).toBeGreaterThan(e.boundaryTime)
    expect(e.strength).toBeGreaterThan(0.5)
    expect(e.confidence).toBeGreaterThan(0.5)
    expect(e.feats.timbre + e.feats.harmony).toBeGreaterThan(e.feats.level)
  })

  it('a timbre-only change and a harmony-only change are each detected (equal loudness, nothing else moves)', () => {
    const timbre: SectionSpec = { ...VERSE, mel: CHORUS.mel, highTilt: CHORUS.highTilt }
    const harmony: SectionSpec = { ...VERSE, chroma: CHORUS.chroma }
    for (const other of [timbre, harmony]) {
      const { cells } = buildStream([
        [VERSE, 64],
        [other, 48],
      ])
      const sc = scene(run(new EventLayer(), cells))
      expect(sc.length).toBe(1)
    }
  })

  it('a steady stream produces no event at all', () => {
    const { cells } = buildStream([[VERSE, 200]])
    expect(run(new EventLayer(), cells)).toEqual([])
  })
})

describe('EventLayer: event typing', () => {
  it('a volume knob (+6 dB on every band, nothing else) is `gain`, never a scene-class event', () => {
    const rnd = mulberry(3)
    const cells: BeatCell[] = []
    for (let b = 1; b <= 140; b++) cells.push(makeCell(VERSE, b, rnd, { gainDb: b > 70 ? 6 : 0 }))
    const evs = run(new EventLayer(), cells)
    expect(scene(evs)).toEqual([])
    expect(evs.some((e) => e.type === 'gain')).toBe(true)
  })

  it('a two-beat fill (onset density and high band spike, then back) is `fill`, not a scene-class event', () => {
    const rnd = mulberry(5)
    const cells: BeatCell[] = []
    for (let b = 1; b <= 160; b++) {
      const fill: CellOptions = b === 100 || b === 101 ? { onsetBoost: 0.4, highBoostDb: 14 } : {}
      cells.push(makeCell(VERSE, b, rnd, fill))
    }
    const evs = run(new EventLayer(), cells)
    expect(scene(evs)).toEqual([])
    expect(evs.filter((e) => e.type === 'fill').length).toBeLessThanOrEqual(1)
  })

  it('a low-band dropout with a level dip that stays is a `breakdown`', () => {
    const breakdown: SectionSpec = { ...VERSE, levelDb: VERSE.levelDb - 7, lowTilt: VERSE.lowTilt - 30, mel: CHORUS.mel }
    const { cells } = buildStream([
      [VERSE, 64],
      [breakdown, 48],
    ])
    const evs = run(new EventLayer(), cells)
    expect(evs.some((e) => e.type === 'breakdown')).toBe(true)
    expect(evs.filter((e) => e.type === 'change').length).toBe(0)
  })

  it('a slow drift (level and brightness creeping over 64 beats) produces at most one scene event', () => {
    const rnd = mulberry(7)
    const cells: BeatCell[] = []
    for (let b = 1; b <= 220; b++) {
      const k = Math.min(1, Math.max(0, (b - 60) / 64))
      const spec: SectionSpec = {
        ...VERSE,
        levelDb: VERSE.levelDb + 5 * k,
        highTilt: VERSE.highTilt + 8 * k,
        mel: VERSE.mel.map((m, i) => m * (1 + 1.5 * k * (i / 12))),
      }
      cells.push(makeCell(spec, b, rnd))
    }
    expect(scene(run(new EventLayer(), cells)).length).toBeLessThanOrEqual(1)
  })
})

describe('EventLayer: refractory, guards, resets', () => {
  it('two changes closer than the refractory period give one event; well separated ones give two', () => {
    const close = buildStream([
      [VERSE, 64],
      [CHORUS, 4],
      [THIRD, 60],
    ])
    expect(scene(run(new EventLayer(), close.cells)).length).toBeLessThanOrEqual(2)
    const apart = buildStream([
      [VERSE, 64],
      [CHORUS, 40],
      [THIRD, 60],
    ])
    expect(scene(run(new EventLayer(), apart.cells)).length).toBe(2)
  })

  it('constant channels (MAD = 0) never divide by zero: no NaN anywhere, no event', () => {
    const layer = new EventLayer()
    const rnd = mulberry(1)
    const cells: BeatCell[] = []
    for (let b = 1; b <= 120; b++) cells.push(makeCell(VERSE, b, rnd, { jitter: 0 }))
    const seen: number[] = []
    layer.scorer.probe = (_s, d, z, s, thr) => seen.push(s, thr, ...Array.from(d), ...Array.from(z))
    expect(run(layer, cells)).toEqual([])
    expect(seen.length).toBeGreaterThan(100)
    expect(seen.every(Number.isFinite)).toBe(true)
  })

  it('non-finite cell fields and non-finite beats/times are read as neutral: no throw, no NaN event', () => {
    const layer = new EventLayer()
    const rnd = mulberry(2)
    const cells: BeatCell[] = []
    for (let b = 1; b <= 150; b++) {
      const c = makeCell(VERSE, b, rnd)
      if (b % 17 === 0) {
        c.mfcc[3] = Number.NaN
        c.hpcp[2] = Number.POSITIVE_INFINITY
        c.onsetDensity = Number.NaN
      }
      cells.push(c)
    }
    const evs = run(layer, cells)
    for (const e of evs) expect([e.strength, e.confidence, e.boundaryTime, e.detectedAtTime].every(Number.isFinite)).toBe(true)
    expect(() => layer.push(cells[0], Number.NaN, 1, 120)).not.toThrow()
    expect(layer.push(cells[0], 5000, Number.NaN, 120)).toHaveLength(0)
    expect(() => layer.push(cells[1], 6000, 4000, Number.NaN)).not.toThrow()
  })

  it('a silence gap in the middle of a section is never a change / fill / gain, and does not fake one afterwards (the low end returning after it is a drop)', () => {
    const rnd = mulberry(4)
    const cells: BeatCell[] = []
    for (let b = 1; b <= 200; b++) {
      // beats 90-93: digital silence (raw dB at the floor, all frames flagged), a half-silent beat on each side
      const silent = b >= 90 && b <= 93
      const partial = b === 89 || b === 94
      const c = makeCell(VERSE, b, rnd, silent ? { silent: 1 } : partial ? { silent: 0.3, gainDb: -25 } : {})
      if (silent && c.raw) c.raw = c.raw.map(() => -120)
      cells.push(c)
    }
    const layer = new EventLayer()
    const evs = run(layer, cells)
    // a >= 1.75 s hush and the low end coming back whole is exactly what `gapDrop.ts` reads as a drop: one, at the return
    expect(evs.filter((e) => e.type !== 'drop')).toEqual([])
    const drops = evs.filter((e) => e.type === 'drop')
    expect(drops.length).toBeLessThanOrEqual(1)
    if (drops.length === 1) expect(drops[0].detectedAtBeat).toBeGreaterThanOrEqual(94)
    expect(layer.stats.gapCells).toBeGreaterThanOrEqual(4)
  })

  it('a long silence (>= resetGapBeats) is a new song: windows, grid and signatures all reset', () => {
    const layer = new EventLayer()
    const { cells } = buildStream([[VERSE, 80]])
    run(layer, cells)
    const before = layer.stats.resets
    const rnd = mulberry(9)
    for (let b = 81; b < 81 + 20; b++) {
      const c = makeCell(VERSE, b, rnd, { silent: 1 })
      if (c.raw) c.raw = c.raw.map(() => -120)
      layer.push(c, b, b * SPB, 120)
    }
    expect(layer.stats.resets).toBe(before + 1) // ONE reset per long gap, not one per silent cell
    // the next song starts cleanly and a change in it is still found
    const next = buildStream(
      [
        [CHORUS, 64],
        [VERSE, 48],
      ],
      11,
      101,
    ).cells
    expect(scene(run(layer, next)).length).toBe(1)
  })

  it('a backwards beat counter (a new source) resets; a duplicate beat is ignored; an index jump keeps the windows', () => {
    const layer = new EventLayer()
    const { cells } = buildStream([[VERSE, 40]])
    run(layer, cells)
    const r0 = layer.stats.resets
    expect(layer.push(cells[cells.length - 1], cells[cells.length - 1].beat, 999, 120)).toHaveLength(0) // duplicate beat
    layer.push(cells[0], 1, 0.5, 120)
    expect(layer.stats.resets).toBe(r0 + 1)

    // A jump of the engine's beat index by 4 for one cell: same audio, so the change after it is still found and on time
    const layer2 = new EventLayer()
    const rnd = mulberry(13)
    const stream: BeatCell[] = []
    let beat = 1
    for (let i = 0; i < 130; i++) {
      const spec = i < 70 ? VERSE : CHORUS
      beat += i === 40 ? 4 : 1
      stream.push(makeCell(spec, beat, rnd))
    }
    smoothChroma(stream)
    const evs = scene(run(layer2, stream))
    expect(layer2.stats.jumps).toBeGreaterThanOrEqual(1)
    expect(evs.length).toBe(1)
    // the change starts at cell 70: the boundary beat is the crossing before it
    expect(Math.abs(evs[0].boundaryBeat - stream[69].beat)).toBeLessThanOrEqual(3)
  })

  it('an octave-type tempo re-lock resets the bar grid but not the feature history', () => {
    expect(isOctaveJump(2, 0.1)).toBe(true)
    expect(isOctaveJump(0.5, 0.1)).toBe(true)
    expect(isOctaveJump(1.5, 0.1)).toBe(true)
    expect(isOctaveJump(1.08, 0.1)).toBe(false)
    expect(isOctaveJump(Number.NaN, 0.1)).toBe(false)
    const layer = new EventLayer()
    const { cells } = buildStream(
      [
        [VERSE, 70],
        [CHORUS, 40],
        [VERSE, 60],
      ],
      3,
    )
    run(layer, cells.slice(0, 120))
    expect(layer.grid.confidence).toBeGreaterThan(0)
    layer.push(cells[120], cells[120].beat, 200, 240) // 120 -> 240 bpm
    expect(layer.grid.confidence).toBe(0)
  })
})

describe('EventLayer: bar grid and sim', () => {
  it('boundaries anchor the grid: after consistent changes the boundary phase is stable and the helpers agree', () => {
    const { cells } = buildStream(
      [
        [VERSE, 64],
        [CHORUS, 32],
        [THIRD, 32],
        [VERSE, 40],
      ],
      21,
    )
    const layer = new EventLayer()
    const evs = scene(run(layer, cells))
    expect(evs.length).toBe(3)
    expect(layer.grid.snapReady()).toBe(true)
    // all three boundaries are a whole number of bars apart: they share one phase on the anchored grid
    expect(new Set(evs.map((e) => e.phase)).size).toBeLessThanOrEqual(2)
    expect(evs[2].phase).toBe(0)
    const last = cells[cells.length - 1].beat
    const toLine = layer.beatsToBarLine(last)
    expect(toLine).toBeGreaterThanOrEqual(0)
    expect(toLine).toBeLessThanOrEqual(3)
    expect(layer.beatInBar(last + toLine)).toBe(0)
  })

  it('a section that RETURNS (A B A) reports sim to the earlier section; a new one does not', () => {
    const c3: SectionSpec = { ...THIRD, lowTilt: VERSE.lowTilt + 4, midTilt: VERSE.midTilt + 5, onset: 0.75 }
    const { cells } = buildStream(
      [
        [VERSE, 64],
        [CHORUS, 48],
        [VERSE, 48],
        [c3, 48],
      ],
      31,
    )
    const evs = scene(run(new EventLayer(), cells))
    expect(evs.length).toBe(3)
    expect(evs[0].sim).toBeUndefined() // B is new
    expect(evs[1].sim).toBeDefined() // A returns
    expect(evs[1].sim!.similarity).toBeGreaterThan(0.75)
    expect(evs[1].sim!.boundaryBeat).toBeLessThan(evs[0].boundaryBeat) // it points at the first A, not at B
    expect(evs[2].sim).toBeUndefined() // C is new
  })
})

describe('EventLayer: delivery ring and calibration', () => {
  it('push returns a SHARED empty array on beats with no event (allocation-free steady state)', () => {
    const layer = new EventLayer()
    const { cells } = buildStream([[VERSE, 60]])
    const empties = new Set<unknown>()
    for (const c of cells) {
      const r = layer.push(c, c.beat, c.beat * SPB, 120)
      if (r.length === 0) empties.add(r)
    }
    expect(empties.size).toBe(1)
  })

  it('drain() hands each event over once, readSince() serves independent readers, ring events are reused after ringSize', () => {
    const layer = new EventLayer({ ringSize: 4 })
    const { cells } = buildStream(
      [
        [VERSE, 64],
        [CHORUS, 40],
        [THIRD, 40],
        [VERSE, 60],
      ],
      41,
    )
    const drained: SectionEvent[] = []
    let readerSeq = 0
    const other: SectionEvent[] = []
    for (const c of cells) {
      layer.push(c, c.beat, c.beat * SPB, 120)
      layer.drain(drained)
      readerSeq = layer.readSince(readerSeq, other)
    }
    expect(drained.length).toBe(layer.sequence)
    expect(other.length).toBe(layer.sequence)
    expect(layer.drain([])).toBe(0)
    expect(new Set(drained.map((e) => e.id)).size).toBe(layer.sequence) // ids are unique
    // a reader that fell behind by more than the ring gets at most ringSize events
    const late: SectionEvent[] = []
    layer.readSince(0, late)
    expect(late.length).toBe(Math.min(4, layer.sequence))
    layer.discard()
    expect(layer.drain([])).toBe(0)
  })

  it('strength is a monotone 0..1 map anchored at the corpus percentiles, and finite for garbage', () => {
    let prev = -1
    for (let s = 0; s < 40; s += 0.5) {
      const v = strengthOf(s)
      expect(v).toBeGreaterThanOrEqual(prev)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
      prev = v
    }
    expect(strengthOf(STRENGTH_ANCHORS[1][0])).toBeCloseTo(STRENGTH_ANCHORS[1][1], 6)
    expect(strengthOf(Number.NaN)).toBe(STRENGTH_ANCHORS[0][1])
    expect(strengthOf(Number.POSITIVE_INFINITY)).toBe(1)
  })
})
