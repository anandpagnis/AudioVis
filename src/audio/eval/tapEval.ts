/**
 * TAP-LOG EVALUATION: score the detectors against the human taps of `?structurelog` exports (schema v2), for any number
 * of songs. Pure (no I/O, no DOM); `scripts/calibrate/tap-eval.calib.ts` reads the files and prints the tables.
 *
 * ## Why windows and no fixed human lag
 * A tap trails the audible change by the listener's reaction time, and a causal detector trails it by its own latency, so
 * "the detector fired within X of the tap" only means something once both are known. Nothing here hard-codes a lag:
 *
 *  - {@link estimateOnsets} finds, per mark, the AUDIO change onset in the recorded raw-dB cells (level, low band, high
 *    band: robust step detection, each channel whitened by its own song-wide step distribution) and reports
 *    `tap - onset`. The distribution over marks (per song and pooled) IS the measured human lag (plus the cell
 *    resolution, one beat ~ 0.4-0.7 s).
 *  - {@link scoreStream} scores an event stream in an explicit window `[tap - before, tap + after]`: the caller passes
 *    several (see {@link DEFAULT_WINDOWS}) and reads how the numbers move.
 *  - {@link chanceScore} re-scores the same stream circularly shifted by many offsets: what a stream of the same size and
 *    rhythm scores by luck (a stream that fires every 3 s hits every window).
 *
 * All times are SONG-RELATIVE seconds (`t - firstT` of the log's audio clock).
 *
 * ## Small-n warning
 * The first two tapped songs give 24 marks. Every number is an estimate with a wide interval ({@link wilson}); nothing
 * tuned on them may be presented as validated.
 */
import type { BeatCell } from '../essentia/structureDsp'
import type { SectionEvent } from '../events/types'
import { EventLayer, type EventLayerConfig } from '../events/EventLayer'
import { CHANNEL_NAMES } from '../events/barFeatures'
import type { StructureLogJson } from '../../engine/structureLog'
import { copyEvent, type EventCellRecord } from './eventReplay'
import { logToCellRecords } from './logCells'
import { parseStructureLog } from './structureLogToTruth'
import { percentile } from './structureMetrics'

// ----------------------------------------------------------------------------------------------------- song model

export type MarkKind = 'scene' | 'small'

export interface TapMark {
  /** Song-relative time of the FIRST tap of the (merged) mark. */
  t: number
  kind: MarkKind
  /** How many raw taps were merged into it. */
  taps: number
}

/** One detector or director output on the song clock. */
export interface TimedEvent {
  /** When the system knew (detection time), song-relative. */
  t: number
  /** Where the event CLAIMS the change began, when it says (v2 events). */
  claimed?: number
  strength?: number
  type?: string
  /** Director decision `KIND:reason` of a recorded `sectionEvent`. */
  decision?: string
}

export interface TapSong {
  name: string
  durationSec: number
  firstT: number
  /** Merged marks, time order. */
  marks: TapMark[]
  rawMarkCount: number
  cells: EventCellRecord[]
  series: CellSeries
  /** Legacy detector edges recorded live (`sectionChange`, `drop`, `boundary`). */
  legacy: Record<'sectionChange' | 'drop' | 'boundary', TimedEvent[]>
  /** The `sectionEvent` records (what the director was fed and decided), last delivery per id. */
  recorded: TimedEvent[]
  /** Scene commits. */
  commits: Array<TimedEvent & { to: string; trigger: string }>
  log: StructureLogJson
}

/** Taps of the same kind closer than `mergeSec` are one mark (a double tap on one change). */
export function mergeMarks(marks: ReadonlyArray<{ t: number; kind: MarkKind }>, mergeSec = 2): TapMark[] {
  const out: TapMark[] = []
  for (const m of [...marks].sort((a, b) => a.t - b.t)) {
    const last = out[out.length - 1]
    if (last && last.kind === m.kind && m.t - last.t < mergeSec) last.taps++
    else out.push({ t: m.t, kind: m.kind, taps: 1 })
  }
  return out
}

export function loadTapSong(name: string, input: unknown, mergeSec = 2): TapSong {
  const log = parseStructureLog(input)
  const firstT = log.firstT ?? 0
  const rel = (t: number): number => t - firstT
  const cells = logToCellRecords(log)
  const legacyOf = (kind: string): TimedEvent[] =>
    log.events
      .filter((e) => e.kind === kind && e.data.on !== false)
      .map((e) => ({ t: rel(e.t), strength: typeof e.data.strength === 'number' ? e.data.strength : undefined }))
  const byId = new Map<number, TimedEvent>()
  const noId: TimedEvent[] = []
  for (const e of log.events) {
    if (e.kind !== 'sectionEvent') continue
    const d = e.data
    const te: TimedEvent = {
      t: rel(e.t),
      type: String(d.type ?? ''),
      strength: typeof d.strength === 'number' ? d.strength : undefined,
      claimed: typeof d.boundaryT === 'number' ? rel(d.boundaryT) : undefined,
      decision: typeof d.decision === 'string' ? d.decision : undefined,
    }
    ;(te as TimedEvent & { source?: string }).source = String(d.source ?? '')
    if (typeof d.id === 'number') byId.set(d.id, te)
    else noId.push(te)
  }
  const last = cells.length ? rel(cells[cells.length - 1].time) : 0
  return {
    name,
    durationSec: Math.max(log.durationSec, last),
    firstT,
    marks: mergeMarks(
      log.marks.map((m) => ({ t: rel(m.t), kind: m.kind })),
      mergeSec,
    ),
    rawMarkCount: log.marks.length,
    cells,
    series: cellSeries(cells, firstT),
    legacy: { sectionChange: legacyOf('sectionChange'), drop: legacyOf('drop'), boundary: legacyOf('boundary') },
    recorded: [...byId.values(), ...noId].sort((a, b) => a.t - b.t),
    commits: log.commits.map((c) => ({ t: rel(c.t), to: c.to, trigger: c.trigger })),
    log,
  }
}

// ---------------------------------------------------------------------------------------------- raw-dB series

export interface CellSeries {
  /** Song-relative cell times. */
  t: number[]
  /** Raw dB: rms, low band (mean of sub and bass), high band (mean of high and air). */
  level: number[]
  low: number[]
  high: number[]
}

const DB_FLOOR = -120

export function cellSeries(cells: readonly EventCellRecord[], firstT: number): CellSeries {
  const s: CellSeries = { t: [], level: [], low: [], high: [] }
  for (const r of cells) {
    const raw = r.cell.raw
    let lv: number, lo: number, hi: number
    if (raw && raw.length >= 7) {
      lv = raw[6]
      lo = 0.5 * (raw[0] + raw[1])
      hi = 0.5 * (raw[4] + raw[5])
    } else {
      // A cell without the raw tap has only the normalised bands: a pseudo-dB scale (shape only).
      lv = 20 * r.cell.logRms
      lo = 10 * 0.5 * (r.cell.sub + r.cell.bass)
      hi = 10 * 0.5 * (r.cell.high + r.cell.air)
    }
    s.t.push(r.time - firstT)
    s.level.push(Math.max(DB_FLOOR, lv))
    s.low.push(Math.max(DB_FLOOR, lo))
    s.high.push(Math.max(DB_FLOOR, hi))
  }
  return s
}

// ---------------------------------------------------------------------------------------------- audio onsets

export const ONSET_CHANNELS = ['level', 'low', 'high'] as const
export type OnsetChannel = (typeof ONSET_CHANNELS)[number]

export interface OnsetOptions {
  /** Cells on each side of the step (mean of `k` cells after minus mean of `k` before). Default 3. */
  stepCells: number
  /** Search window relative to the tap: the change is looked for in `[tap - back, tap + fwd]`. Default 4 / 0.5 s. */
  back: number
  fwd: number
  /** Minimum robust z of the step to count as a change at all. Default 4. */
  minZ: number
  /** Of the local step maxima in the window, take the LATEST that reaches this share of the strongest (the tap answers the most recent change). Default 0.5. */
  latestShare: number
  /** Floor of the per-channel scale (dB): a clean song has MAD ~ 0. Default 1. */
  scaleFloorDb: number
  /** z is capped here before the share test: a digital-silence gap (a 40 dB step) must not hide the change next to it. Default 10. */
  zCap: number
}

export const DEFAULT_ONSET: Readonly<OnsetOptions> = Object.freeze({
  stepCells: 3,
  back: 4,
  fwd: 0.5,
  minZ: 4,
  latestShare: 0.5,
  scaleFloorDb: 1,
  zCap: 10,
})

export interface OnsetEstimate {
  tap: number
  kind: MarkKind
  /** Song-relative time of the audio change (the boundary between the last old and the first new cell), null when none reached `minZ`. */
  onset: number | null
  channel: OnsetChannel | null
  /** Signed step of that channel (dB, new - old) and its robust z. */
  stepDb: number
  z: number
  /** `tap - onset` (positive: the tap came after the audio change). NaN when no onset. */
  lag: number
  /** The onset sits at the edge of the search window: the lag is truncated, do not trust it. */
  atEdge: boolean
}

function median(v: number[]): number {
  return v.length ? percentile(v, 0.5) : 0
}

/** Steps of one channel: `step[i]` = mean(x[i..i+k-1]) - mean(x[i-k..i-1]) (NaN where a side is short). */
export function stepSeries(x: readonly number[], k: number): number[] {
  const n = x.length
  const out = new Array<number>(n).fill(Number.NaN)
  for (let i = k; i + k <= n; i++) {
    let a = 0
    let b = 0
    for (let j = 0; j < k; j++) {
      a += x[i + j]
      b += x[i - 1 - j]
    }
    out[i] = (a - b) / k
  }
  return out
}

function stepZ(series: CellSeries, o: OnsetOptions) {
  const n = series.t.length
  const chans: Array<{ name: OnsetChannel; step: number[]; med: number; scale: number }> = ONSET_CHANNELS.map((name) => {
    const step = stepSeries(series[name], o.stepCells)
    const mags = step.filter((v) => Number.isFinite(v)).map(Math.abs)
    const med = median(mags)
    const mad = median(mags.map((v) => Math.abs(v - med)))
    return { name, step, med, scale: Math.max(1.4826 * mad, o.scaleFloorDb) }
  })
  // z of every step index and the best channel there
  const zBest = new Array<number>(n).fill(0)
  const zRaw = new Array<number>(n).fill(0)
  const chBest = new Array<number>(n).fill(0)
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < chans.length; c++) {
      const v = chans[c].step[i]
      if (!Number.isFinite(v)) continue
      const z = (Math.abs(v) - chans[c].med) / chans[c].scale
      if (z > zRaw[i]) {
        zRaw[i] = z
        zBest[i] = Math.min(z, o.zCap)
        chBest[i] = c
      }
    }
  }
  return { chans, zBest, zRaw, chBest }
}

export function estimateOnsets(series: CellSeries, marks: readonly TapMark[], opt: Partial<OnsetOptions> = {}): OnsetEstimate[] {
  const o = { ...DEFAULT_ONSET, ...opt }
  const n = series.t.length
  const { chans, zBest, zRaw, chBest } = stepZ(series, o)
  return marks.map((m): OnsetEstimate => {
    const lo = m.t - o.back
    const hi = m.t + o.fwd
    let zMax = 0
    for (let i = 1; i < n; i++) if (series.t[i - 1] >= lo && series.t[i - 1] <= hi && zBest[i] > zMax) zMax = zBest[i]
    let pick = -1
    if (zMax >= o.minZ) {
      for (let i = 1; i < n - 1; i++) {
        const tt = series.t[i - 1]
        if (tt < lo || tt > hi) continue
        if (zBest[i] < o.latestShare * zMax || zBest[i] < o.minZ) continue
        // local maxima of the UNCAPPED z (the cap would make a big step a plateau); later ones override earlier ones
        if (zRaw[i] >= zRaw[i - 1] && zRaw[i] > zRaw[i + 1]) pick = i
      }
    }
    if (pick < 0) return { tap: m.t, kind: m.kind, onset: null, channel: null, stepDb: 0, z: zMax, lag: Number.NaN, atEdge: false }
    const c = chans[chBest[pick]]
    const onset = series.t[pick - 1]
    return {
      tap: m.t,
      kind: m.kind,
      onset,
      channel: c.name,
      stepDb: c.step[pick],
      z: zBest[pick],
      lag: m.t - onset,
      atEdge: onset <= lo + 1e-6 || onset >= hi - 1e-6,
    }
  })
}

export interface LagSummary {
  n: number
  nMarks: number
  median: number
  p25: number
  p75: number
  min: number
  max: number
}

/** Distribution of `tap - onset` over the marks that had a trustworthy onset (found, not at the window edge). */
export function summarizeLags(est: readonly OnsetEstimate[]): LagSummary {
  const l = est.filter((e) => e.onset !== null && !e.atEdge).map((e) => e.lag)
  return {
    n: l.length,
    nMarks: est.length,
    median: percentile(l, 0.5),
    p25: percentile(l, 0.25),
    p75: percentile(l, 0.75),
    min: l.length ? Math.min(...l) : Number.NaN,
    max: l.length ? Math.max(...l) : Number.NaN,
  }
}

// ----------------------------------------------------------------------------------------------- scoring

/** An event counts for a mark when it falls in `[tap - before, tap + after]`. */
export interface Window {
  before: number
  after: number
}

/** Audio-aligned (a fast detector: it fires at the change, the tap trails it), a causal detector, a slow one. */
export const DEFAULT_WINDOWS: readonly Window[] = [
  { before: 1.5, after: 1 },
  { before: 1.5, after: 4 },
  { before: 1.5, after: 6 },
]

export interface StreamScore {
  nMarks: number
  hits: number
  nEvents: number
  /** Events inside the window of at least one mark (of the marks scored). */
  tpEvents: number
  falseAlarms: number
  minutes: number
  /** Signed `event - tap` of the event nearest the tap, for each hit mark. */
  lags: number[]
  /** Share of the song covered by the windows: the recall of an event stream that fires everywhere. */
  coverage: number
}

/** Merge the windows of `marks` into covered seconds (clipped to the song). */
function coveredSec(markT: readonly number[], win: Window, durationSec: number): number {
  const iv = markT.map((t) => [Math.max(0, t - win.before), Math.min(durationSec, t + win.after)] as const).sort((a, b) => a[0] - b[0])
  let tot = 0
  let end = -Infinity
  let start = 0
  for (const [a, b] of iv) {
    if (a > end) {
      if (end > -Infinity) tot += end - start
      start = a
      end = b
    } else if (b > end) end = b
  }
  if (end > -Infinity) tot += end - start
  return tot
}

export function scoreStream(markT: readonly number[], evT: readonly number[], win: Window, durationSec: number): StreamScore {
  const ev = [...evT].sort((a, b) => a - b)
  let hits = 0
  const lags: number[] = []
  for (const t of markT) {
    let best = Number.NaN
    for (const e of ev) {
      if (e < t - win.before - 1e-9) continue
      if (e > t + win.after + 1e-9) break
      if (Number.isNaN(best) || Math.abs(e - t) < Math.abs(best - t)) best = e
    }
    if (!Number.isNaN(best)) {
      hits++
      lags.push(best - t)
    }
  }
  let tp = 0
  for (const e of ev) if (markT.some((t) => e >= t - win.before - 1e-9 && e <= t + win.after + 1e-9)) tp++
  return {
    nMarks: markT.length,
    hits,
    nEvents: ev.length,
    tpEvents: tp,
    falseAlarms: ev.length - tp,
    minutes: durationSec / 60,
    lags,
    coverage: durationSec > 0 ? coveredSec(markT, win, durationSec) / durationSec : 0,
  }
}

/** Sum counts over songs (lags concatenated; coverage is weighted by minutes). */
export function poolScores(scores: readonly StreamScore[]): StreamScore {
  const out: StreamScore = { nMarks: 0, hits: 0, nEvents: 0, tpEvents: 0, falseAlarms: 0, minutes: 0, lags: [], coverage: 0 }
  let cov = 0
  for (const s of scores) {
    out.nMarks += s.nMarks
    out.hits += s.hits
    out.nEvents += s.nEvents
    out.tpEvents += s.tpEvents
    out.falseAlarms += s.falseAlarms
    out.minutes += s.minutes
    out.lags.push(...s.lags)
    cov += s.coverage * s.minutes
  }
  out.coverage = out.minutes > 0 ? cov / out.minutes : 0
  return out
}

export const recallOf = (s: StreamScore): number => (s.nMarks > 0 ? s.hits / s.nMarks : Number.NaN)
export const precisionOf = (s: StreamScore): number => (s.nEvents > 0 ? s.tpEvents / s.nEvents : Number.NaN)
export const faPerMin = (s: StreamScore): number => (s.minutes > 0 ? s.falseAlarms / s.minutes : Number.NaN)
export const medianLagOf = (s: StreamScore): number => (s.lags.length ? percentile(s.lags, 0.5) : Number.NaN)

/** Wilson 95% interval of `k` successes in `n` trials. */
export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (n <= 0) return [0, 1]
  const p = k / n
  const d = 1 + (z * z) / n
  const c = p + (z * z) / (2 * n)
  const h = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return [Math.max(0, (c - h) / d), Math.min(1, (c + h) / d)]
}

/** Events circularly shifted inside the song. */
function shifted(evT: readonly number[], duration: number, off: number): number[] {
  return evT.map((t) => (t + off) % duration)
}

/**
 * The score of the same stream (same count, same rhythm) shifted by `nShifts` offsets spread over the song, leaving out
 * shifts within `minShiftSec` of zero: the recall and precision it earns by luck. Averages of the counts.
 */
export function chanceScore(
  markT: readonly number[],
  evT: readonly number[],
  win: Window,
  durationSec: number,
  nShifts = 40,
  minShiftSec = 10,
): { recall: number; precision: number } {
  if (!(durationSec > 2 * minShiftSec) || evT.length === 0 || markT.length === 0) return { recall: Number.NaN, precision: Number.NaN }
  let r = 0
  let p = 0
  let n = 0
  for (let k = 0; k < nShifts; k++) {
    const off = minShiftSec + ((durationSec - 2 * minShiftSec) * (k + 0.5)) / nShifts
    const s = scoreStream(markT, shifted(evT, durationSec, off), win, durationSec)
    r += recallOf(s)
    p += precisionOf(s)
    n++
  }
  return { recall: r / n, precision: p / n }
}

// ------------------------------------------------------------------------------------------- v2 replay + probe

export interface ProbeRow {
  /** Song-relative time of the cell the score was computed on. */
  t: number
  z: number[]
  s: number
  thr: number
}

/** Replay a fresh `EventLayer` over the song's cells, returning the events (song-relative times) and every scored beat. */
export function replayWithProbe(
  song: TapSong,
  cfg: Partial<EventLayerConfig> = {},
): { events: SectionEvent[]; probe: ProbeRow[]; layer: EventLayer } {
  const layer = new EventLayer(cfg)
  const probe: ProbeRow[] = []
  let cur = 0
  layer.scorer.probe = (_step, _d, z, s, thr) => probe.push({ t: cur, z: Array.from(z), s, thr })
  const events: SectionEvent[] = []
  for (const r of song.cells) {
    cur = r.time - song.firstT
    for (const e of layer.push(r.cell, r.beat, r.time, r.bpm, { locked: r.locked, offset: r.offset })) {
      const c = copyEvent(e)
      c.boundaryTime -= song.firstT
      c.detectedAtTime -= song.firstT
      events.push(c)
    }
  }
  return { events, probe, layer }
}

export interface MarkResponse {
  tap: number
  kind: MarkKind
  /** The strongest score in the window and the threshold it faced (ratio >= 1: a candidate). */
  sMax: number
  ratio: number
  /** Per channel: the strongest z in the window. */
  z: number[]
  /** Channels with z >= 2 in the window, and the dominant one. */
  active: string[]
  dominant: string
}

export function markResponses(probe: readonly ProbeRow[], marks: readonly TapMark[], win: Window): MarkResponse[] {
  return marks.map((m): MarkResponse => {
    const z = new Array<number>(CHANNEL_NAMES.length).fill(0)
    let sMax = 0
    let ratio = 0
    for (const p of probe) {
      if (p.t < m.t - win.before || p.t > m.t + win.after) continue
      if (p.s > sMax) sMax = p.s
      if (p.thr > 0 && p.s / p.thr > ratio) ratio = p.s / p.thr
      for (let k = 0; k < z.length; k++) if (p.z[k] > z[k]) z[k] = p.z[k]
    }
    let dom = 0
    for (let k = 1; k < z.length; k++) if (z[k] > z[dom]) dom = k
    return {
      tap: m.t,
      kind: m.kind,
      sMax,
      ratio,
      z,
      active: CHANNEL_NAMES.filter((_, k) => z[k] >= 2),
      dominant: CHANNEL_NAMES[dom],
    }
  })
}

// -------------------------------------------------------------------------------------------- stream catalogue

export type StreamMap = Record<string, TimedEvent[]>

const fromEvents = (evs: readonly SectionEvent[], keep: (e: SectionEvent) => boolean): TimedEvent[] =>
  evs.filter(keep).map((e) => ({ t: e.detectedAtTime, claimed: e.boundaryTime, strength: e.strength, type: e.type }))

/**
 * Every detector / director stream of a song by name: the legacy edges as recorded live, the recorded v2 `sectionEvent`s by
 * type, the v2 layer REPLAYED from the cells with `cfg`, and the director's recorded CUT / MICRO decisions and commits.
 */
export function songStreams(song: TapSong, replayed: readonly SectionEvent[]): StreamMap {
  const rec = song.recorded as Array<TimedEvent & { source?: string }>
  const live = rec.filter((e) => e.source === 'live')
  const byType = (list: TimedEvent[], t: string): TimedEvent[] => list.filter((e) => e.type === t)
  const out: StreamMap = {
    'legacy sectionChange': song.legacy.sectionChange,
    'legacy drop': song.legacy.drop,
    'legacy boundary': song.legacy.boundary,
    'v2 recorded change': byType(live, 'change'),
    'v2 recorded breakdown': byType(live, 'breakdown'),
    'v2 recorded fill': byType(live, 'fill'),
    'v2 recorded scene-class': live.filter((e) => e.type === 'change' || e.type === 'breakdown'),
    'v2 replay change': fromEvents(replayed, (e) => e.type === 'change'),
    'v2 replay breakdown': fromEvents(replayed, (e) => e.type === 'breakdown'),
    'v2 replay fill': fromEvents(replayed, (e) => e.type === 'fill'),
    'v2 replay drop': fromEvents(replayed, (e) => e.type === 'drop'),
    'v2 replay scene-class': fromEvents(replayed, (e) => e.type === 'change' || e.type === 'breakdown'),
    'v2 replay change+breakdown+fill': fromEvents(replayed, (e) => e.type === 'change' || e.type === 'breakdown' || e.type === 'fill'),
    'v2 replay any': fromEvents(replayed, (e) => e.type !== 'gain'),
    'director CUT (recorded)': rec.filter((e) => (e.decision ?? '').startsWith('CUT')),
    'director MICRO (recorded)': rec.filter((e) => (e.decision ?? '').startsWith('MICRO')),
    'scene commits': song.commits.map((c) => ({ t: c.t })),
  }
  return out
}

export const times = (list: readonly TimedEvent[]): number[] => list.map((e) => e.t)

/** Marks of one kind as times (`kind` undefined: all). */
export function markTimes(song: TapSong, kind?: MarkKind): number[] {
  return song.marks.filter((m) => kind === undefined || m.kind === kind).map((m) => m.t)
}

// -------------------------------------------------------------------------------------- periodicity of the marks

/** Gaps (s) between consecutive scene marks. */
export function sceneGaps(song: TapSong): number[] {
  const t = markTimes(song, 'scene')
  const g: number[] = []
  for (let i = 1; i < t.length; i++) g.push(t[i] - t[i - 1])
  return g
}

export type { BeatCell }

/**
 * Event-triggered profile: the mean capped step z of the raw-dB channels at each time offset from the marks (bins of
 * `binSec`, from `-back` to `+fwd`). Where the audio change energy sits relative to the taps, robust to marks whose single onset
 * is ambiguous: the offset of its peak is the population's tap lag, its mass before zero is the audio leading the tap.
 */
export function triggeredProfile(
  series: CellSeries,
  marks: readonly TapMark[],
  opt: Partial<OnsetOptions> & { binSec?: number; back?: number; fwd?: number } = {},
): Array<{ offset: number; z: number; n: number }> {
  const o = { ...DEFAULT_ONSET, ...opt }
  const bin = opt.binSec ?? 0.5
  const back = opt.back ?? 6
  const fwd = opt.fwd ?? 3
  const { zBest } = stepZ(series, o)
  const nb = Math.round((back + fwd) / bin)
  const sum = new Array<number>(nb).fill(0)
  const cnt = new Array<number>(nb).fill(0)
  for (const m of marks) {
    for (let i = 1; i < series.t.length; i++) {
      const off = series.t[i - 1] - m.t
      if (off < -back || off >= fwd) continue
      const b = Math.floor((off + back) / bin)
      sum[b] += zBest[i]
      cnt[b]++
    }
  }
  return sum.map((v, b) => ({ offset: -back + (b + 0.5) * bin, z: cnt[b] ? v / cnt[b] : 0, n: cnt[b] }))
}

// ------------------------------------------------------------------------------------- phrase prior evaluation

export interface RescueRow {
  /** Song-relative boundary estimate of the near-miss (the peak's time minus the new window) and its score / threshold. */
  boundary: number
  ratio: number
  mult: number
  /** The prior would have lifted it over the acceptance threshold (`ratio * mult >= 1`). */
  rescued: boolean
  /** The mark kind within `tol` of the boundary (M preferred), or null. */
  near: MarkKind | null
}

/**
 * CAUSAL check of a phrase-periodicity prior (`events/phrasePrior.ts`) against the taps, without touching the layer: every local
 * maximum of the scorer's `s` that fell short of its threshold by up to `1 / rmin` (a near-miss) is asked what the prior, as
 * learned from the boundaries the layer had CONFIRMED by then (scene-class events and drops, at their boundary times), would
 * have done to it. Returns each near-miss with the mark it sits at, so the share of rescued near-misses that are real can be
 * compared with the share of the ones it leaves out and with the layer's own accepted events.
 */
export function phraseRescue(
  song: TapSong,
  replay: { events: SectionEvent[]; probe: ProbeRow[] },
  prior: { add(t: number): void; multiplier(t: number): number; reset(): void },
  opt: { rmin?: number; tol?: number; peakHalf?: number; newBeats?: number } = {},
): RescueRow[] {
  const rmin = opt.rmin ?? 0.6
  const tol = opt.tol ?? 3
  const h = opt.peakHalf ?? 2
  const nb = opt.newBeats ?? 4
  prior.reset()
  const confirmed = replay.events
    .filter((e) => e.type === 'change' || e.type === 'breakdown' || e.type === 'drop')
    .sort((a, b) => a.detectedAtTime - b.detectedAtTime)
  const rows: RescueRow[] = []
  let ei = 0
  const p = replay.probe
  for (let i = nb; i + h < p.length; i++) {
    // confirmation happens `h` rows after the peak
    const now = p[i + h].t
    while (ei < confirmed.length && confirmed[ei].detectedAtTime <= now) prior.add(confirmed[ei++].boundaryTime)
    const r = p[i].thr > 0 ? p[i].s / p[i].thr : 0
    if (r < rmin || r >= 1) continue
    let isMax = true
    for (let j = 1; j <= h && isMax; j++) if (p[i - j].s >= p[i].s || p[i + j].s > p[i].s) isMax = false
    if (!isMax) continue
    const boundary = p[i - nb].t
    const mult = prior.multiplier(boundary)
    let near: MarkKind | null = null
    for (const m of song.marks) {
      if (boundary >= m.t - tol && boundary <= m.t + 1) {
        if (near === null || m.kind === 'scene') near = m.kind
      }
    }
    rows.push({ boundary, ratio: r, mult, rescued: r * mult >= 1, near })
  }
  return rows
}
