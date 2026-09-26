import { describe, expect, it } from 'vitest'
import { runTrack } from '../../../../scripts/calibrate/features'
import { scoreEventStream } from '../../eval/eventReplay'
import { PC, chord, synthSong, type SectionSpec, type SongSpec } from '../../eval/synthSong'
import type { SectionEvent } from '../types'

/**
 * END TO END at the audio level, through the offline mirror of `AudioEngine.update()` (`runTrack` with
 * `events: true`): the real front end (band normaliser, chroma, mel, beat tracker, the raw-dB tap, the analyser's beat
 * cells) feeds the live `EventLayer`, on synthetic songs whose changes are known to the sample. Fast variants (22.05 kHz,
 * ~60 s songs); the full catalogue with its acceptance numbers is `scripts/calibrate/events-report.calib.ts`.
 */
const SR = 22050
const FFT_SIZE = 2048
const TIMEOUT = 120_000

const AM_F_C_G = [chord(PC.A, 'min'), chord(PC.F), chord(PC.C), chord(PC.G)]
const D_A_BM_G = [chord(PC.D), chord(PC.A), chord(PC.B, 'min'), chord(PC.G)]

const groove = (over: Partial<SectionSpec> = {}): SectionSpec => ({
  label: 'groove',
  bars: 30,
  chords: AM_F_C_G,
  kick: 'four',
  snare: 'backbeat',
  hats: 'eighth',
  bass: 'root',
  padCutoff: [1600, 1600],
  ...over,
})

function detect(spec: SongSpec) {
  const s = synthSong({ ...spec, sampleRate: SR, seed: 1 })
  const run = runTrack(s.pcm, s.sampleRate, { events: true })
  // runTrack stamps the frame clock (window START): move onto the audio clock like the calibration does
  const off = FFT_SIZE / SR
  const events: SectionEvent[] = (run.events ?? []).map((e) => ({ ...e, boundaryTime: e.boundaryTime + off, detectedAtTime: e.detectedAtTime + off }))
  return { s, run, events }
}

const sceneOf = (evs: readonly SectionEvent[]) => evs.filter((e) => e.type === 'change' || e.type === 'breakdown')

describe('EventLayer over synthetic audio (runTrack)', () => {
  it(
    'a verse -> chorus change at EQUAL loudness (different timbre and chords) is found within a bar, causally, and only once',
    () => {
      const verse: SectionSpec = { ...groove({ label: 'verse', bars: 16 }), kick: 'oneAndThree', hats: 'eighth', padCutoff: [800, 800], chords: [chord(PC.A, 'min7'), chord(PC.F, 'maj7')], chordBars: 2, rmsDb: -20, levels: { kick: 0.6, hats: 0.5 } }
      const chorus: SectionSpec = { ...groove({ label: 'chorus', bars: 14 }), hats: 'sixteenth', bass: 'eighth', lead: 'arp', padCutoff: [4200, 4200], chords: D_A_BM_G, rmsDb: -20, event: { type: 'change' } }
      const { s, run, events } = detect({ name: 'e2e-verse-chorus', bpm: 128, sections: [verse, chorus] })
      expect(run.cells?.length).toBeGreaterThan(40)
      const scene = sceneOf(events)
      const sc = scoreEventStream(s.truth, events, s.bpm)
      expect(sc.nTruth).toBe(1)
      expect(sc.hits).toBe(1)
      expect(scene.length).toBe(1)
      expect(scene[0].source).toBe('live')
      const lag = scene[0].detectedAtTime - s.truth.find((t) => t.shouldTrigger)!.timeSec
      expect(lag).toBeGreaterThan(0.5)
      // ~6 beats (2.8 s at 128 BPM) when the fast channels carry it; the chroma channel trails (its 2 s EMA and a longer
      // window), so a harmony-heavy change is confirmed ~10-12 beats in
      expect(lag).toBeLessThan(7.5)
      expect(scene[0].strength).toBeGreaterThan(0.4)
    },
    TIMEOUT,
  )

  it(
    'snare fills every 4 bars are never a scene-class event',
    () => {
      const { events } = detect({ name: 'e2e-fills', bpm: 124, sections: [groove({ bars: 30, lead: 'arp', fillEvery: 4 })] })
      expect(sceneOf(events)).toEqual([])
    },
    TIMEOUT,
  )

  it(
    'a +6 dB volume step in the middle of a steady groove is typed `gain` (or nothing), never a scene-class event',
    () => {
      const { events } = detect({ name: 'e2e-gain', bpm: 120, sections: [groove({ bars: 32, lead: 'arp', level: [-6, -6] })], gainSteps: [{ bar: 16, db: 6 }] })
      expect(sceneOf(events)).toEqual([])
    },
    TIMEOUT,
  )

  it(
    'a short silence gap in a steady groove is never an event',
    () => {
      const { events } = detect({ name: 'e2e-gap', bpm: 120, sections: [groove({ bars: 32, lead: 'arp' })], silences: [{ bar: 16, beat: 2, beats: 2 }] })
      expect(events.filter((e) => e.type !== 'fill')).toEqual([])
    },
    TIMEOUT,
  )
})
