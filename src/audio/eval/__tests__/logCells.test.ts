import { describe, expect, it } from 'vitest'
import { StructureLog, stringifyStructureLog } from '../../../engine/structureLog'
import type { BeatCell } from '../../essentia/structureDsp'
import { CHORUS, VERSE, buildStream } from '../../events/__tests__/cellFactory'
import { replayCells, type EventCellRecord } from '../eventReplay'
import { logCellToBeatCell, logToCellRecords, replayLogEvents } from '../logCells'
import { parseStructureLog } from '../structureLogToTruth'

const SPB = 0.5 // 120 bpm

/** The frame the analyser hands `onCell` for beat `beat`. */
const frame = (beat: number) => ({
  beatIndex: beat,
  beatInBar: beat % 4,
  time: beat * SPB,
  bpm: 120,
  downbeatLocked: true,
})

function records(cells: readonly BeatCell[]): EventCellRecord[] {
  return cells.map((c) => ({ cell: c, beat: c.beat, time: c.beat * SPB, bpm: 120, locked: true, offset: 0 }))
}

function record(cells: readonly BeatCell[]): StructureLog {
  const log = new StructureLog({ isoNow: () => '2026-01-01T00:00:00.000Z' })
  for (const c of cells) log.noteCell(c, frame(c.beat))
  return log
}

describe('recording beat cells', () => {
  const { cells } = buildStream([
    [VERSE, 64],
    [CHORUS, 48],
    [VERSE, 48],
  ])

  it('round trip: cells -> JSON text -> parse -> replay gives the same events as replaying the original cells', () => {
    const text = stringifyStructureLog(record(cells).toJSON())
    const want = replayCells(records(cells))
    const got = replayLogEvents(text)
    expect(want.length).toBeGreaterThan(0)
    expect(got.map((e) => e.type)).toEqual(want.map((e) => e.type))
    expect(got.map((e) => e.detectedAtBeat)).toEqual(want.map((e) => e.detectedAtBeat))
    expect(got.map((e) => e.boundaryBeat)).toEqual(want.map((e) => e.boundaryBeat))
    for (let i = 0; i < want.length; i++) {
      expect(got[i].boundaryTime).toBeCloseTo(want[i].boundaryTime, 2)
      expect(got[i].detectedAtTime).toBeCloseTo(want[i].detectedAtTime, 2)
      expect(got[i].strength).toBeCloseTo(want[i].strength, 1)
      expect(got[i].confidence).toBeCloseTo(want[i].confidence, 1)
    }
  })

  it('rebuilds the fields the event layer reads within the 4-significant-digit quantisation', () => {
    const log = record(cells)
    const back = logToCellRecords(log.toJSON())
    expect(back).toHaveLength(cells.length)
    const a = cells[10]
    const b = back[10]
    expect(b).toMatchObject({ beat: a.beat, time: a.beat * SPB, bpm: 120, locked: true })
    expect(b.cell.raw).toHaveLength(7)
    a.raw?.forEach((x, i) => expect(Math.abs((b.cell.raw as number[])[i] - x)).toBeLessThanOrEqual(Math.abs(x) * 6e-4))
    a.mfcc.slice(0, 13).forEach((x, i) => expect(b.cell.mfcc[i]).toBeCloseTo(x, 3))
    a.hpcp.forEach((x, i) => expect(b.cell.hpcp[i]).toBeCloseTo(x, 3))
    expect(b.cell.onsetDensity).toBeCloseTo(a.onsetDensity, 3)
  })

  it('a cell without the raw tap round-trips through the fallback fields', () => {
    const c = { ...cells[3], raw: undefined, logRms: 0.61234, sub: 0.2, bass: 0.3, mid: 0.4, high: 0.5, air: 0.6 } as BeatCell
    const log = new StructureLog()
    log.noteCell(c, frame(c.beat))
    const rec = log.toJSON().cells?.[0]
    expect(rec?.fb).toEqual([0.6123, 0.2, 0.3, 0.4, 0.5, 0.6])
    const back = logCellToBeatCell(rec as NonNullable<typeof rec>)
    expect(back.raw).toBeUndefined()
    expect(back).toMatchObject({ logRms: 0.6123, sub: 0.2, bass: 0.3, mid: 0.4, high: 0.5, air: 0.6 })
  })

  it('is about 300 bytes a beat: a minute of 120 bpm music stays well under 50 KB', () => {
    const text = stringifyStructureLog(record(cells.slice(0, 120)).toJSON())
    const cellsText = text.slice(text.indexOf('"cells"'), text.indexOf('"counters"'))
    expect(cellsText.length).toBeLessThan(50_000)
  })

  it('is a no-op while the log is disabled, and drops the oldest past the cap (counted)', () => {
    const off = new StructureLog({ enabled: false })
    off.noteCell(cells[0], frame(1))
    expect(off.toJSON().cells).toEqual([])
    const small = new StructureLog({ caps: { cells: 10 } })
    for (const c of cells.slice(0, 25)) small.noteCell(c, frame(c.beat))
    const j = small.toJSON()
    expect(j.cells).toHaveLength(10)
    expect(j.cells?.[0].beat).toBe(cells[15].beat)
    expect(j.counters).toMatchObject({ cells: 10, droppedCells: 15 })
  })

  it('skips a non-finite beat or time, and the parser tolerates logs without cells (older versions)', () => {
    const log = new StructureLog()
    log.noteCell(cells[0], { ...frame(1), time: Number.NaN })
    expect(log.toJSON().cells).toEqual([])
    expect(log.toJSON().counters.nonFinite).toBe(1)
    const old = { version: 1, schema: 'audiovis.structurelog' }
    expect(parseStructureLog(old).cells).toEqual([])
    expect(logToCellRecords(old)).toEqual([])
    expect(replayLogEvents(old)).toEqual([])
  })

  it('a new track clears the recorded cells', () => {
    const log = record(cells.slice(0, 5))
    log.reset()
    expect(log.toJSON().cells).toEqual([])
  })
})
