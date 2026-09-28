import { describe, expect, it } from 'vitest'
import ENGINE_SRC from '../AudioEngine.ts?raw'
import { audioEngine } from '../AudioEngine'
import { EventLayer } from '../events/EventLayer'
import type { SectionEvent } from '../events/types'
import { RAW_BASS, RAW_DB_FLOOR, RAW_RMS, RAW_SUB, RawTap } from '../events/rawTap'
import { createEmptyFeatures, type AudioFeatures } from '../types'

/**
 * The live wiring of the phase-2 event layer inside `AudioEngine`, through the private members (the idiom of
 * `audioEngineNoIntel.test.ts`: there is no mocked AudioContext graph to drive `update()`):
 *  - the raw-dB tap (`rawTap`) is a fresh, unwritten `RawTap`, reset with the analysis, and is handed to the analyser;
 *  - the analyser's per-beat cell reaches `audioEngine.events` (the `onCell` hook), whose ring is read with `drain()`;
 *  - `?structure=off` is honoured by construction (the events ride the analyser);
 *  - the source pins that keep the tap beside the band normaliser and the analyser call fed with it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const engine = audioEngine as any
const src = (ENGINE_SRC as string).replace(/\r\n/g, '\n')

const SR = 44100

function makeFrame(i: number, beat: boolean, beatIndex: number, bright: boolean): AudioFeatures {
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
  // the section is a spectral SHAPE: dark (energy in the lows) vs bright (energy in the highs)
  f.spectrum = new Float32Array(1024).map((_, k) => (bright ? 0.5 * Math.exp(-Math.abs(k - 600) / 150) : 0.5 * Math.exp(-k / 90)))
  return f
}

describe('AudioEngine: the raw tap and the event layer', () => {
  it('owns a RawTap and an EventLayer, both reset with the analysis (stop / new source)', () => {
    expect(engine.rawTap).toBeInstanceOf(RawTap)
    expect(engine.events).toBeInstanceOf(EventLayer)
    expect(audioEngine.events).toBe(engine.events)
    engine.rawTap.write({ sub: 1, bass: 1, mid: 1, presence: 1, high: 1, air: 1 }, 1, 0.5)
    expect(engine.rawTap.written).toBe(true)
    const resets = engine.events.stats.resets
    audioEngine.stop()
    expect(engine.rawTap.written).toBe(false)
    expect(Array.from(engine.rawTap.db as Float64Array).every((v) => v === RAW_DB_FLOOR)).toBe(true)
    expect(engine.events.stats.resets).toBe(resets + 1)
    expect(audioEngine.events.drain([])).toBe(0)
  })

  it('the analyser cell -> EventLayer -> drain() path: a change in the music is delivered as a live `change` event, once', () => {
    audioEngine.stop()
    const analyzer = engine.structureAnalyzer
    const tap = engine.rawTap as RawTap
    const low = new Float32Array(4096).fill(-70)
    const out: SectionEvent[] = []
    let beat = 0
    for (let i = 0; i < 60 * 60; i++) {
      // 30 frames per beat (120 BPM at 60 Hz); the section changes at beat 90
      const isBeat = i % 30 === 29
      if (isBeat) beat++
      const bright = beat >= 90
      tap.write(
        { sub: 0.01, bass: 0.02, mid: bright ? 0.03 : 0.01, presence: bright ? 0.03 : 0.004, high: bright ? 0.02 : 0.001, air: bright ? 0.01 : 0.0005 },
        0.01,
        bright ? 0.12 : 0.1,
      )
      const f = makeFrame(i, isBeat, beat, bright)
      analyzer.update(f, low, SR, tap)
      audioEngine.events.drain(out)
    }
    const changes = out.filter((e) => e.type === 'change' || e.type === 'breakdown')
    expect(changes.length).toBe(1)
    expect(changes[0].source).toBe('live')
    expect(Math.abs(changes[0].boundaryBeat - 90)).toBeLessThanOrEqual(3)
    expect(changes[0].detectedAtBeat).toBeGreaterThan(changes[0].boundaryBeat)
    expect(audioEngine.events.drain([])).toBe(0) // each event is handed over once
    audioEngine.stop()
  })

  it('the tap is only ever written from the un-normalised locals, beside the band normaliser, and fed to the analyser', () => {
    const i = src.indexOf('f.sparkle = norm(this.bands.sparkle, spectral.sparkle)')
    const j = src.indexOf('this.rawTap.write(spectral, subRaw, rmsRaw)')
    expect(i).toBeGreaterThan(0)
    expect(j).toBeGreaterThan(i) // right after the normalised band block
    expect(j - i).toBeLessThan(400)
    expect(src).toContain('this.structureAnalyzer.update(f, this.lowFreqDb, ctx.sampleRate, this.rawTap)')
    expect(src).toContain('onCell: (cell, f) =>')
    expect(src).toContain('this.events.push(cell, f.beatIndex, f.time, f.bpm')
    // reset with the analysis
    expect(src).toContain('this.events.reset()')
    expect(src).toContain('this.rawTap.reset()')
  })

  it('the tap channels are the documented ones', () => {
    expect([RAW_SUB, RAW_BASS, RAW_RMS]).toEqual([0, 1, 6])
  })
})
