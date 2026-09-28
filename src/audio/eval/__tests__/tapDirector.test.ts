import { describe, expect, it } from 'vitest'
import { StructureLog, stringifyStructureLog } from '../../../engine/structureLog'
import type { BeatCell } from '../../essentia/structureDsp'
import { MUX } from '../../events/eventMux'
import { VERSE, makeCell, mulberry } from '../../events/__tests__/cellFactory'
import { simulateDirectorOnSong } from '../tapDirector'
import { loadTapSong } from '../tapEval'

const SPB = 0.5

/** A tapped-song log made of `cells`, plus legacy `drop` edges at the given audio times. */
function songOf(cells: readonly BeatCell[], dropEdgesAt: number[] = []) {
  const log = new StructureLog({ isoNow: () => '2026-01-01T00:00:00.000Z' })
  for (const c of cells) log.noteCell(c, { beatIndex: c.beat, beatInBar: c.beat % 4, time: c.beat * SPB, bpm: 120, downbeatLocked: false })
  const json = log.toJSON()
  const events = dropEdgesAt.map((t) => ({ kind: 'drop', t, beat: Math.round(t / SPB), beatInBar: 0, wallMs: 0, data: {} }))
  const text = stringifyStructureLog({ ...json, firstT: 0, marks: [], events } as typeof json)
  return loadTapSong('demo', text)
}

function dropoutCells(): BeatCell[] {
  const rnd = mulberry(11)
  const cells: BeatCell[] = []
  for (let b = 1; b <= 220; b++) {
    const c = makeCell(VERSE, b, rnd)
    if (b >= 100 && b < 108 && c.raw) {
      c.raw = c.raw.slice()
      c.raw[0] = -90
      c.raw[1] = -90
    }
    cells.push(c)
  }
  return cells
}

describe('the director replayed on a tapped song', () => {
  it('v2: the live gap drop reaches the director as a `drop` and cuts the scene (an old scene, a clear drop)', () => {
    // (the change candidates are switched off with an unreachable floor so the drop is the only event: a real dropout also
    // produces a `breakdown` / `change` on the way down, which cuts first and leaves the drop to the refractory)
    const r = simulateDirectorOnSong(songOf(dropoutCells()), { events: 'v2', layer: { scorer: { absFloor: 1e9 } } })
    const d = r.decisions.filter((x) => x.type === 'drop')
    expect(d).toHaveLength(1)
    expect(`${d[0].kind}:${d[0].reason}`).toBe('CUT:event')
    expect(d[0].source).toBe('live')
    expect(r.cuts.length).toBe(1)
    expect(r.cuts[0]).toBeGreaterThanOrEqual(d[0].t)
    expect(r.cuts[0] - d[0].t).toBeLessThanOrEqual(6 * SPB + 1e-9) // lands on a bar line within maxWaitCells
  })

  it('a lone legacy drop edge is demoted under v2 (MUX.legacyDrops = release) and passes in legacy mode', () => {
    const cells: BeatCell[] = []
    const rnd = mulberry(3)
    for (let b = 1; b <= 160; b++) cells.push(makeCell(VERSE, b, rnd))
    const song = songOf(cells, [40.2])
    const v2 = simulateDirectorOnSong(song, { events: 'v2' })
    expect(v2.events.filter((e) => e.type === 'drop')).toEqual([])
    const legacy = simulateDirectorOnSong(song, { events: 'legacy' })
    expect(legacy.events.filter((e) => e.type === 'drop')).toHaveLength(1)
    const old = MUX.legacyDrops
    try {
      MUX.legacyDrops = 'all'
      expect(simulateDirectorOnSong(song, { events: 'v2' }).events.filter((e) => e.type === 'drop')).toHaveLength(1)
    } finally {
      MUX.legacyDrops = old
    }
  })

  it('is deterministic and never cuts without an event (no timer)', () => {
    const cells: BeatCell[] = []
    const rnd = mulberry(4)
    for (let b = 1; b <= 400; b++) cells.push(makeCell(VERSE, b, rnd))
    const song = songOf(cells)
    const a = simulateDirectorOnSong(song, { events: 'v2' })
    const b = simulateDirectorOnSong(song, { events: 'v2' })
    expect(a.cuts).toEqual([])
    expect(a).toEqual(b)
  })
})
