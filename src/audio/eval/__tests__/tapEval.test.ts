import { describe, expect, it } from 'vitest'
import { CELL_LEN, STRUCTURE_LOG_SCHEMA } from '../../../engine/structureLog'
import {
  chanceScore,
  estimateOnsets,
  faPerMin,
  loadTapSong,
  markTimes,
  mergeMarks,
  poolScores,
  precisionOf,
  recallOf,
  scoreStream,
  sceneGaps,
  songStreams,
  stepSeries,
  summarizeLags,
  triggeredProfile,
  wilson,
  type CellSeries,
} from '../tapEval'

const FIRST_T = 100

/** A log with one cell every `spb` seconds: raw dB from `raw(t)` (sub, bass, mid, presence, high, air, rms). */
function makeLog(opts: {
  seconds: number
  spb?: number
  raw: (t: number) => number[]
  marks?: Array<{ t: number; kind: 'scene' | 'small' }>
  events?: Array<{ kind: string; t: number; data?: Record<string, number | string | boolean | null> }>
}) {
  const spb = opts.spb ?? 0.5
  const cells = []
  let beat = 0
  for (let t = spb; t <= opts.seconds; t += spb) {
    const cell = new Array<number>(CELL_LEN).fill(0)
    const r = opts.raw(t)
    for (let i = 0; i < 7; i++) cell[i] = r[i]
    cells.push({ beat: beat++, t: FIRST_T + t, bpm: 120, locked: false, offset: 0, cell })
  }
  return {
    schema: STRUCTURE_LOG_SCHEMA,
    version: 2,
    firstT: FIRST_T,
    lastT: FIRST_T + opts.seconds,
    durationSec: opts.seconds,
    marks: (opts.marks ?? []).map((m, i) => ({ id: i, kind: m.kind, t: FIRST_T + m.t, beat: 0, beatInBar: 0, beatProgress: 0, bpm: 120, wallMs: 0 })),
    events: (opts.events ?? []).map((e) => ({ kind: e.kind, t: FIRST_T + e.t, beat: 0, beatInBar: 0, wallMs: 0, data: e.data ?? {} })),
    commits: [],
    samples: [],
    beats: [],
    cells,
    counters: {},
  }
}

/** Steady -20 dB with the low band 15 dB louder from `stepAt` on (a bass entering). */
const bassEnters =
  (stepAt: number) =>
  (t: number): number[] => {
    const low = t >= stepAt ? -30 : -60
    return [low, low, -50, -60, -80, -80, -20]
  }

describe('marks', () => {
  it('a double tap of one kind is one mark; two kinds close together stay two', () => {
    const m = mergeMarks([
      { t: 49, kind: 'scene' },
      { t: 49.7, kind: 'scene' },
      { t: 49.9, kind: 'small' },
      { t: 60, kind: 'scene' },
    ])
    expect(m.map((x) => [x.t, x.kind, x.taps])).toEqual([
      [49, 'scene', 2],
      [49.9, 'small', 1],
      [60, 'scene', 1],
    ])
  })
})

describe('the audio onset and the measured human lag', () => {
  it('finds a step in the low band and reports tap - onset, with no lag assumed', () => {
    // the first cell of the new material closes at 50.5 (it spans 50.0-50.5), so the change began at 50.0
    const song = loadTapSong('x', makeLog({ seconds: 120, raw: bassEnters(50.5) }))
    const est = estimateOnsets(song.series, [{ t: 50.6, kind: 'scene', taps: 1 }])
    expect(est[0].onset).not.toBeNull()
    expect(est[0].channel).toBe('low')
    expect(est[0].stepDb).toBeGreaterThan(20)
    expect(est[0].onset).toBeCloseTo(50, 1)
    expect(est[0].lag).toBeCloseTo(0.6, 1)
  })

  it('a mark with no audio change near it has no onset', () => {
    const log = makeLog({ seconds: 120, raw: bassEnters(50) })
    const song = loadTapSong('x', log)
    const est = estimateOnsets(song.series, [{ t: 90, kind: 'small', taps: 1 }])
    expect(est[0].onset).toBeNull()
    expect(Number.isNaN(est[0].lag)).toBe(true)
  })

  it('a digital-silence gap right before the change does not hide it (z is capped)', () => {
    // silence 47-49, weak return 49-51, full bass from 51: the human taps at the full return
    const raw = (t: number): number[] => {
      if (t >= 47 && t < 49) return [-120, -120, -120, -120, -120, -120, -80]
      const low = t >= 51 ? -30 : t >= 49 ? -55 : -60
      return [low, low, -50, -60, -80, -80, -20]
    }
    const song = loadTapSong('x', makeLog({ seconds: 120, raw }))
    const est = estimateOnsets(song.series, [{ t: 51.2, kind: 'scene', taps: 1 }])
    expect(est[0].onset).not.toBeNull()
    expect(Math.abs((est[0].onset as number) - 51)).toBeLessThan(1.1)
  })

  it('stepSeries is the mean after minus the mean before', () => {
    const st = stepSeries([0, 0, 0, 10, 10, 10], 3)
    expect(st[3]).toBeCloseTo(10)
    expect(Number.isNaN(st[1])).toBe(true)
  })

  it('summarizeLags ignores marks without an onset or with one at the window edge', () => {
    const l = summarizeLags([
      { tap: 1, kind: 'scene', onset: 0.5, channel: 'low', stepDb: 10, z: 8, lag: 0.5, atEdge: false },
      { tap: 2, kind: 'scene', onset: 1.5, channel: 'low', stepDb: 10, z: 8, lag: 0.3, atEdge: false },
      { tap: 3, kind: 'scene', onset: -1, channel: 'low', stepDb: 10, z: 8, lag: 4, atEdge: true },
      { tap: 4, kind: 'small', onset: null, channel: null, stepDb: 0, z: 1, lag: Number.NaN, atEdge: false },
    ])
    expect(l.n).toBe(2)
    expect(l.nMarks).toBe(4)
    expect(l.median).toBeCloseTo(0.4)
  })

  it('the event-triggered profile peaks just before the taps when the audio leads them', () => {
    const steps = [20, 50, 80, 110]
    const raw = (t: number): number[] => {
      let n = 0
      for (const s of steps) if (t >= s) n++
      const low = n % 2 === 0 ? -60 : -30
      return [low, low, -50, -60, -80, -80, -20]
    }
    const song = loadTapSong('x', makeLog({ seconds: 130, raw }))
    const marks = steps.map((s) => ({ t: s + 0.5, kind: 'scene' as const, taps: 1 }))
    const prof = triggeredProfile(song.series, marks)
    const peak = prof.reduce((a, b) => (b.z > a.z ? b : a))
    expect(peak.offset).toBeLessThan(0)
    expect(peak.offset).toBeGreaterThan(-2)
  })
})

describe('scoring a stream against marks in a window', () => {
  const marks = [20, 60, 100]
  const win = { before: 1.5, after: 4 }

  it('counts hits, true and false events, the lag and the coverage', () => {
    const s = scoreStream(marks, [19, 22, 30, 61, 130], win, 140)
    expect(s.hits).toBe(2) // 20 and 60
    expect(s.tpEvents).toBe(3) // 19, 22, 61
    expect(s.nEvents).toBe(5)
    expect(s.falseAlarms).toBe(2)
    expect(recallOf(s)).toBeCloseTo(2 / 3)
    expect(precisionOf(s)).toBeCloseTo(3 / 5)
    expect(faPerMin(s)).toBeCloseTo(2 / (140 / 60))
    // the event nearest each tap decides the lag: 19 (-1) for tap 20, 61 (+1) for tap 60
    expect(s.lags.sort((a, b) => a - b)).toEqual([-1, 1])
    expect(s.coverage).toBeCloseTo((3 * 5.5) / 140)
  })

  it('a window is inclusive at both ends and asymmetric', () => {
    const s = scoreStream([10], [8.5, 14], { before: 1.5, after: 4 }, 30)
    expect(s.hits).toBe(1)
    expect(s.tpEvents).toBe(2)
    expect(scoreStream([10], [8.4], { before: 1.5, after: 4 }, 30).hits).toBe(0)
  })

  it('pools counts across songs', () => {
    const a = scoreStream([10], [10], win, 60)
    const b = scoreStream([10, 40], [40, 50], win, 120)
    const p = poolScores([a, b])
    expect(p.nMarks).toBe(3)
    expect(p.hits).toBe(2)
    expect(p.nEvents).toBe(3)
    expect(p.minutes).toBeCloseTo(3)
  })

  it('a stream that fires everywhere scores high by chance: the shifted control shows it', () => {
    const dense = Array.from({ length: 140 }, (_, i) => i + 0.5)
    const c = chanceScore(marks, dense, win, 140)
    expect(c.recall).toBeGreaterThan(0.95)
    const sparse = chanceScore(marks, [20.2], win, 140)
    expect(sparse.recall).toBeLessThan(0.2)
  })

  it('wilson interval brackets the proportion and is wide for tiny n', () => {
    const [lo, hi] = wilson(3, 16)
    expect(lo).toBeLessThan(3 / 16)
    expect(hi).toBeGreaterThan(3 / 16)
    expect(hi - lo).toBeGreaterThan(0.3)
    expect(wilson(0, 0)).toEqual([0, 1])
  })
})

describe('loading a log', () => {
  it('turns everything song-relative and builds the named streams', () => {
    const log = makeLog({
      seconds: 60,
      raw: bassEnters(30),
      marks: [
        { t: 30.4, kind: 'scene' },
        { t: 31, kind: 'scene' },
        { t: 45, kind: 'small' },
      ],
      events: [
        { kind: 'sectionChange', t: 31, data: { strength: 0.6 } },
        { kind: 'drop', t: 30.1 },
        { kind: 'sectionEvent', t: 33, data: { id: 1, type: 'change', source: 'live', strength: 0.5, boundaryT: FIRST_T + 30, decision: 'CUT:event' } },
        { kind: 'sectionEvent', t: 33.2, data: { id: 1, type: 'change', source: 'live', strength: 0.6, boundaryT: FIRST_T + 30, decision: 'CUT:event' } },
      ],
    })
    const song = loadTapSong('demo', log)
    expect(song.firstT).toBe(FIRST_T)
    expect(song.marks.map((m) => [m.kind, Math.round(m.t * 10) / 10, m.taps])).toEqual([
      ['scene', 30.4, 2],
      ['small', 45, 1],
    ])
    expect(song.rawMarkCount).toBe(3)
    expect(song.legacy.sectionChange[0].t).toBeCloseTo(31)
    expect(song.recorded).toHaveLength(1) // last delivery per id
    expect(song.recorded[0].strength).toBe(0.6)
    const streams = songStreams(song, [])
    expect(streams['director CUT (recorded)']).toHaveLength(1)
    expect(streams['legacy drop']).toHaveLength(1)
    expect(markTimes(song, 'small')).toEqual([45])
    expect(sceneGaps(song)).toEqual([])
  })

  it('a log with a cell but no raw tap still loads (pseudo-dB fallback)', () => {
    const series: CellSeries = { t: [0.5], level: [-20], low: [-30], high: [-70] }
    expect(estimateOnsets(series, [{ t: 1, kind: 'scene', taps: 1 }])[0].onset).toBeNull()
  })
})
