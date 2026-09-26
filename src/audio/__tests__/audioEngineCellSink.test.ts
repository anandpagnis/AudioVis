import { describe, expect, it } from 'vitest'
import ENGINE_SRC from '../AudioEngine.ts?raw'
import OVERLAY_SRC from '../../ui/StructureLog.tsx?raw'
import { audioEngine } from '../AudioEngine'
import { StructureLog } from '../../engine/structureLog'
import { RawTap } from '../events/rawTap'
import { createEmptyFeatures, type AudioFeatures } from '../types'

/**
 * `AudioEngine.setCellSink`: the seam that lets the `?structurelog` recorder see every freshly folded beat cell, so a
 * retuned detector can be replayed on a tapped song WITHOUT its audio (a system-capture song has no file). It is driven
 * through the private analyser (the idiom of `audioEngineEvents.test.ts`: there is no mocked audio graph).
 */
const SR = 44100
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const engine = audioEngine as any

function frame(i: number, beat: boolean, beatIndex: number, bright: boolean): AudioFeatures {
  const f = createEmptyFeatures()
  f.silence = false
  f.time = i / 60
  f.delta = 1 / 60
  f.beat = beat
  f.beatIndex = beatIndex
  f.bpm = 120
  f.loudness = 0.5
  f.bass = 0.4
  f.mid = 0.4
  f.sub = 0.4
  f.high = 0.2
  f.spectrum = new Float32Array(1024).map((_, k) => (bright ? 0.5 * Math.exp(-Math.abs(k - 600) / 150) : 0.5 * Math.exp(-k / 90)))
  return f
}

function drive(beats: number, from = 0): number {
  const analyzer = engine.structureAnalyzer
  const tap = engine.rawTap as RawTap
  const low = new Float32Array(4096).fill(-70)
  let beat = from
  for (let i = 0; i < beats * 30; i++) {
    const isBeat = i % 30 === 29
    if (isBeat) beat++
    const bright = beat >= from + Math.floor(beats / 2)
    tap.write({ sub: 0.01, bass: 0.02, mid: bright ? 0.03 : 0.01, presence: bright ? 0.03 : 0.004, high: bright ? 0.02 : 0.001, air: bright ? 0.01 : 0.0005 }, 0.01, bright ? 0.12 : 0.1)
    analyzer.update(frame(i, isBeat, beat, bright), low, SR, tap)
  }
  return beat
}

describe('AudioEngine.setCellSink', () => {
  it('is null by default: folding beat cells with no sink installed does nothing and does not throw', () => {
    audioEngine.stop()
    expect(engine.cellSink).toBeNull()
    expect(() => drive(40)).not.toThrow()
    audioEngine.stop()
  })

  it('delivers every folded beat cell (with its frame) to the sink, then stops when the sink is removed', () => {
    audioEngine.stop()
    const seen: { beat: number; hasMel: boolean }[] = []
    audioEngine.setCellSink((cell, f) => {
      seen.push({ beat: f.beatIndex, hasMel: Array.isArray(cell.mfcc) && cell.mfcc.length > 0 })
    })
    drive(60)
    const n = seen.length
    expect(n).toBeGreaterThan(30) // about one per beat once the grid is running
    expect(seen.every((s) => s.hasMel)).toBe(true)
    // beat indices strictly increase: one cell per beat, in order
    for (let i = 1; i < seen.length; i++) expect(seen[i].beat).toBeGreaterThan(seen[i - 1].beat)
    audioEngine.setCellSink(null)
    drive(20, 200)
    expect(seen.length).toBe(n)
    audioEngine.stop()
  })

  it('end to end into the recorder: cells are logged only while it is enabled, and the JSON stays small', () => {
    audioEngine.stop()
    const log = new StructureLog({ enabled: true })
    audioEngine.setCellSink((c, f) => log.noteCell(c, f))
    drive(240) // 2 minutes at 120 BPM
    audioEngine.setCellSink(null)
    const json = log.toJSON()
    const cells = json.cells ?? []
    expect(cells.length).toBeGreaterThan(100)
    const perMinuteKb = JSON.stringify(cells).length / 1024 / 2
    // measured at ~25 KB per minute at 120 BPM: keep a ceiling so a format change cannot silently balloon the log
    expect(perMinuteKb).toBeLessThan(80)
    const off = new StructureLog({ enabled: false })
    audioEngine.setCellSink((c, f) => off.noteCell(c, f))
    drive(40, 1000)
    audioEngine.setCellSink(null)
    expect((off.toJSON().cells ?? []).length).toBe(0)
    audioEngine.stop()
  })

  it('the overlay installs the sink on mount and removes it on unmount; the engine calls it after the event layer', () => {
    const overlay = (OVERLAY_SRC as string).replace(/\r\n/g, '\n')
    expect(overlay).toContain('audioEngine.setCellSink((c, f) => structureLog.noteCell(c, f))')
    expect(overlay).toContain('audioEngine.setCellSink(null)')
    const src = (ENGINE_SRC as string).replace(/\r\n/g, '\n')
    expect(src.indexOf('this.events.push(cell, f.beatIndex')).toBeGreaterThan(0)
    expect(src.indexOf('this.cellSink?.(cell, f)')).toBeGreaterThan(src.indexOf('this.events.push(cell, f.beatIndex'))
  })
})
