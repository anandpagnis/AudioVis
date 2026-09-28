import { describe, expect, it } from 'vitest'
import type { BeatCell } from '../../essentia/structureDsp'
import { RAW_CHANNELS, RAW_RMS, RawTap } from '../../events/rawTap'
import { createEmptyFeatures, type AudioFeatures } from '../../types'
import { StructureAnalyzer } from '../StructureAnalyzer'

/**
 * The ADDITIVE cell exposure of the slow analyser (phase 2): `onCell` is called once per freshly folded beat cell with
 * the very object the analyser keeps, the raw-dB tap is averaged into `BeatCell.raw`, the silent share into
 * `BeatCell.silent`, and none of it changes what the analyser does when the new arguments are absent.
 */
const SR = 44100

function frame(i: number, over: Partial<AudioFeatures> = {}): AudioFeatures {
  const f = createEmptyFeatures()
  f.silence = false
  f.spectrum = new Float32Array(1024).map((_, k) => 0.4 * Math.exp(-k / 200))
  f.loudness = 0.5
  f.bass = 0.4
  f.mid = 0.4
  f.sub = 0.4
  f.high = 0.2
  f.time = i / 60
  f.delta = 1 / 60
  Object.assign(f, over)
  return f
}

const low = new Float32Array(4096).fill(-70)

describe('StructureAnalyzer.onCell', () => {
  it('fires once per folded beat, with the cell the analyser keeps, the beat that closed it and the frame', () => {
    const seen: Array<{ cell: BeatCell; beat: number; time: number }> = []
    const a = new StructureAnalyzer({ onCell: (cell, f) => seen.push({ cell, beat: f.beatIndex, time: f.time }) })
    let beats = 0
    for (let i = 0; i < 600; i++) {
      const isBeat = i % 30 === 29
      if (isBeat) beats++
      a.update(frame(i, { beat: isBeat, beatIndex: beats }), low, SR)
    }
    expect(seen.length).toBe(beats)
    expect(seen.map((s) => s.cell.beat)).toEqual(seen.map((s) => s.beat))
    expect(seen[0].cell.mfcc.length).toBe(13)
    expect(seen[0].cell.hpcp.length).toBe(12)
    expect(a.status.historyBeats).toBe(beats)
  })

  it('a throwing listener can never disturb the analyser (the cell is still buffered, update never throws)', () => {
    const a = new StructureAnalyzer({
      onCell: () => {
        throw new Error('boom')
      },
    })
    let beats = 0
    for (let i = 0; i < 300; i++) {
      const isBeat = i % 30 === 29
      if (isBeat) beats++
      expect(() => a.update(frame(i, { beat: isBeat, beatIndex: beats }), low, SR)).not.toThrow()
    }
    expect(a.status.historyBeats).toBe(beats)
  })

  it('a disabled analyser (?structure=off) never calls it', () => {
    let n = 0
    const a = new StructureAnalyzer({ disabled: true, onCell: () => n++ })
    for (let i = 0; i < 200; i++) a.update(frame(i, { beat: i % 30 === 0, beatIndex: i }), low, SR)
    expect(n).toBe(0)
  })

  it('averages the raw-dB tap into BeatCell.raw (mean of the frames of the beat) and counts the silent share', () => {
    const cells: BeatCell[] = []
    const a = new StructureAnalyzer({ onCell: (c) => cells.push(c) })
    const tap = new RawTap()
    let beat = 0
    for (let i = 0; i < 120; i++) {
      const isBeat = i % 30 === 29
      if (isBeat) beat++
      // the second beat: RMS -10 dB for its first half, -20 for the rest; the third: silent for a third of its frames
      const inBeat2 = i >= 30 && i < 60
      const rmsDb = inBeat2 ? (i < 45 ? -10 : -20) : -30
      tap.write({ sub: 1, bass: 1, mid: 1, presence: 1, high: 1, air: 1 }, 1, 10 ** (rmsDb / 20))
      const silent = i >= 60 && i < 70
      a.update(frame(i, { beat: isBeat, beatIndex: beat, silence: silent }), low, SR, tap)
    }
    expect(cells.length).toBe(4)
    expect(cells[1].raw).toBeDefined()
    expect(cells[1].raw!.length).toBe(RAW_CHANNELS)
    expect(cells[1].raw![RAW_RMS]).toBeCloseTo(-15, 5) // mean of 15 frames at -10 and 15 at -20
    expect(cells[1].silent).toBe(0)
    expect(cells[2].silent).toBeCloseTo(10 / 30, 6)
  })

  it('without a tap (the legacy call) the cell has no raw block, and the cell still carries the silent share', () => {
    const cells: BeatCell[] = []
    const a = new StructureAnalyzer({ onCell: (c) => cells.push(c) })
    let beat = 0
    for (let i = 0; i < 90; i++) {
      const isBeat = i % 30 === 29
      if (isBeat) beat++
      a.update(frame(i, { beat: isBeat, beatIndex: beat }), low, SR)
    }
    expect(cells.length).toBe(3)
    expect(cells.every((c) => c.raw === undefined)).toBe(true)
    expect(cells.every((c) => c.silent === 0)).toBe(true)
  })
})
