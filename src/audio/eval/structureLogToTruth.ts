/**
 * Turns a `?structurelog` export (`engine/structureLog.ts`, schema `audiovis.structurelog`) into ground truth
 * for the evaluation harness: the human marks as boundary times / beat indices, next to the detector events the
 * same run recorded, so a detector can be scored against the taps. Pure: no I/O, no DOM.
 *
 * ## The human reaction-lag caveat (read this before scoring anything)
 *
 * A tapped mark is NOT the moment of the change. The listener hears the change, recognises it, and moves a
 * finger: typically 0.2 to 1.5 s AFTER the true boundary (longer for a gradual change, shorter for a drop they
 * anticipated). Scoring a detector against raw taps therefore reads as "the detector fired early". So
 * {@link structureLogToTruth} subtracts `lagCompensationSec` (default {@link DEFAULT_LAG_COMPENSATION_SEC} = 0.5 s,
 * the middle of the plausible range) from every tap, never below the start of the recording, and only then snaps
 * to the beat grid. Pass `0` for the raw taps. The compensated time is still an estimate: harnesses should score
 * with a tolerance window (the plan uses +-1 bar and 0.5 s / 3 s hit rates), not exact equality, and should report
 * results at more than one lag (for example 0.2, 0.5 and 1.0 s) when the conclusion depends on it.
 *
 * ## Two kinds of mark (schema v2)
 *
 * A mark is `scene` (M / Space: a BIG change worth a new scene: the show director's CUT) or `small` (N: colours or
 * post-FX / layers / effects should react, but no new scene: its MICRO). {@link StructureTruth.boundaries} keeps
 * BOTH kinds, in time order (each {@link TruthBoundary} carries its `kind`); {@link StructureTruth.sceneMarks} and
 * {@link StructureTruth.smallMarks} are the same boundaries split by kind. The lag compensation (floored at the
 * first recorded frame) and the beat snapping are applied identically to both. A version 1 log has no `kind` on
 * its marks: every mark is read as `scene`, so `smallMarks` is empty.
 *
 * ## Time bases
 *
 * Every time in the log is the AUDIO clock (`features.time`, the AudioContext clock), the same clock the detector
 * events carry, so marks and events compare directly. `tRel` is `t - firstT` (seconds since the first recorded
 * frame). It is NOT guaranteed to equal the file's media time: the first frame is recorded some tens of
 * milliseconds after playback starts and a seek in the file is not visible on the audio clock.
 */

import {
  CELL_LEN,
  STRUCTURE_LOG_CELL_LAYOUT,
  STRUCTURE_LOG_SCHEMA,
  STRUCTURE_LOG_VERSION,
  type StructureLogCell,
  type StructureLogCommit,
  type StructureLogEvent,
  type StructureLogEventKind,
  type StructureLogJson,
  type StructureLogMark,
  type StructureLogMarkKind,
  type StructureLogSample,
  type StructureLogSource,
} from '../../engine/structureLog'

/** Subtracted from every tap by default (seconds). */
export const DEFAULT_LAG_COMPENSATION_SEC = 0.5
/** The plausible human tap lag behind the true change (seconds): the range to sweep in a sensitivity check. */
export const HUMAN_TAP_LAG_RANGE_SEC = [0.2, 1.5] as const

export const HUMAN_LAG_CAVEAT =
  'Taps trail the true change by about 0.2-1.5 s (human reaction). Marks are lag-compensated by ' +
  '`lagCompensationSec` before snapping; score with a tolerance window, and check sensitivity to the lag.'

export interface TruthBoundary {
  /** The mark's creation id in the log. */
  id: number
  /** `scene` (M / Space, a new scene) or `small` (N, colours / effects). Version 1 logs: always `scene`. */
  kind: StructureLogMarkKind
  /** The raw tap time (audio clock, seconds). */
  tapT: number
  /** Lag-compensated time: `tapT - lagCompensationSec`, floored at the start of the recording. */
  t: number
  /** `t - firstT`: seconds since the first recorded frame. */
  tRel: number
  /** The beat index `t` snapped to (the log's own beat grid, or the tap's bpm when the log has none). */
  beat: number
  /** Audio-clock time of that beat. */
  beatTime: number
  /** `beatTime - t` (seconds, signed): how far the snap moved the boundary. */
  snapDeltaSec: number
  /** False when no beat grid nor bpm was available: `beat` is then the beat in force at the tap, unsnapped. */
  snapped: boolean
  note?: string
}

export interface StructureTruth {
  /** Schema version of the log this was read from. */
  version: number
  source: StructureLogSource
  trackHint: string | null
  startedAtIso: string
  /** Audio-clock time of the first recorded frame (null: the log has no frames). */
  firstT: number | null
  durationSec: number
  /** Median bpm over the run (null: none recorded). */
  bpm: number | null
  lagCompensationSec: number
  hasMarks: boolean
  /** The human marks of BOTH kinds, in time order. */
  boundaries: TruthBoundary[]
  /** The `scene` marks (M / Space) of `boundaries`, in time order. Every mark of a version 1 log. */
  sceneMarks: TruthBoundary[]
  /** The `small` marks (N) of `boundaries`, in time order. Empty for a version 1 log. */
  smallMarks: TruthBoundary[]
  /** Every detector event the run recorded, in time order (all kinds). */
  detectorEvents: StructureLogEvent[]
  /** The same events grouped by kind (kinds with no events are absent). */
  detectorsByKind: Partial<Record<StructureLogEventKind, StructureLogEvent[]>>
  commits: StructureLogCommit[]
  samples: StructureLogSample[]
  /** `[beatIndex, t]` grid the marks were snapped to. */
  beats: Array<[number, number]>
  /** Cap overflow: true when any ring dropped its oldest entries (the start of the run is then incomplete). */
  truncated: boolean
  caveats: string[]
}

export interface TruthOptions {
  /** Seconds subtracted from each tap. Default {@link DEFAULT_LAG_COMPENSATION_SEC}; negative or non-finite: 0.5 / 0. */
  lagCompensationSec?: number
  /** Snap to the beat grid (default true). */
  snap?: boolean
}

// ----------------------------------------------------------------------------------------------- parsing

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function arr<T>(v: unknown, keep: (x: unknown) => x is T): T[] {
  return Array.isArray(v) ? v.filter(keep) : []
}

/** Entry shape only; `kind` is normalised afterwards (a v1 mark has none). */
const isMark = (x: unknown): x is Omit<StructureLogMark, 'kind'> & { kind?: unknown } =>
  isObj(x) && finite(x.t) && finite(x.beat)
const isEvent = (x: unknown): x is StructureLogEvent =>
  isObj(x) && finite(x.t) && typeof x.kind === 'string' && (x.data === undefined || isObj(x.data))
const isCommit = (x: unknown): x is StructureLogCommit => isObj(x) && finite(x.t) && typeof x.to === 'string'
const isCell = (x: unknown): x is StructureLogCell =>
  isObj(x) &&
  finite(x.beat) &&
  finite(x.t) &&
  Array.isArray(x.cell) &&
  x.cell.length >= CELL_LEN &&
  x.cell.every(finite) &&
  (x.fb === undefined || (Array.isArray(x.fb) && x.fb.length >= 6 && x.fb.every(finite)))
const isSample = (x: unknown): x is StructureLogSample => isObj(x) && finite(x.t)
const isBeat = (x: unknown): x is [number, number] =>
  Array.isArray(x) && x.length >= 2 && finite(x[0]) && finite(x[1])

/**
 * Read a log from its JSON text or an already-parsed value. Throws on anything that is not a structure log or is
 * from a NEWER schema than this code knows; tolerates missing lists (treated as empty) and drops entries with a
 * non-finite time.
 */
export function parseStructureLog(input: unknown): StructureLogJson {
  const v: unknown = typeof input === 'string' ? JSON.parse(input) : input
  if (!isObj(v)) throw new Error('structurelog: expected an object')
  if (v.schema !== undefined && v.schema !== STRUCTURE_LOG_SCHEMA) {
    throw new Error(`structurelog: unknown schema ${String(v.schema)}`)
  }
  const version = finite(v.version) ? v.version : 0
  if (version < 1) throw new Error('structurelog: missing version')
  if (version > STRUCTURE_LOG_VERSION) {
    throw new Error(`structurelog: version ${version} is newer than supported (${STRUCTURE_LOG_VERSION})`)
  }
  const sourceRaw = v.source
  const source: StructureLogSource =
    sourceRaw === 'system' || sourceRaw === 'mic' || sourceRaw === 'file' ? sourceRaw : 'unknown'
  const bpm = isObj(v.bpmSummary) ? v.bpmSummary : {}
  const num = (x: unknown): number | null => (finite(x) ? x : null)
  const counters = isObj(v.counters) ? v.counters : {}
  const out = {
    schema: STRUCTURE_LOG_SCHEMA,
    version,
    startedAtIso: typeof v.startedAtIso === 'string' ? v.startedAtIso : '',
    exportedAtIso: typeof v.exportedAtIso === 'string' ? v.exportedAtIso : '',
    source,
    startedBy: typeof v.startedBy === 'string' ? v.startedBy : '',
    startSceneId: typeof v.startSceneId === 'string' ? v.startSceneId : '',
    firstT: num(v.firstT),
    lastT: num(v.lastT),
    durationSec: finite(v.durationSec) ? v.durationSec : 0,
    bpmSummary: {
      start: num(bpm.start),
      last: num(bpm.last),
      min: num(bpm.min),
      max: num(bpm.max),
      mean: num(bpm.mean),
      median: num(bpm.median),
      readings: finite(bpm.readings) ? bpm.readings : 0,
    },
    marks: arr(v.marks, isMark)
      .map((m): StructureLogMark => ({ ...m, kind: m.kind === 'small' ? 'small' : 'scene' }))
      .sort((a, b) => a.t - b.t),
    events: arr(v.events, isEvent)
      .map((e) => (e.data === undefined ? { ...e, data: {} } : e))
      .sort((a, b) => a.t - b.t),
    commits: arr(v.commits, isCommit),
    samples: arr(v.samples, isSample),
    beats: arr(v.beats, isBeat).sort((a, b) => a[1] - b[1]),
    cells: arr(v.cells, isCell)
      .map((c): StructureLogCell => ({ ...c, locked: c.locked === true, bpm: finite(c.bpm) ? c.bpm : 0, offset: finite(c.offset) ? c.offset : 0 }))
      .sort((a, b) => a.t - b.t),
    cellLayout: STRUCTURE_LOG_CELL_LAYOUT,
    counters: counters as unknown as StructureLogJson['counters'],
  } satisfies Omit<StructureLogJson, 'userAgent' | 'trackHint'>
  const json: StructureLogJson = out
  if (typeof v.userAgent === 'string') json.userAgent = v.userAgent
  if (typeof v.trackHint === 'string' && v.trackHint !== '') json.trackHint = v.trackHint
  return json
}

// ------------------------------------------------------------------------------------------------ snapping

export interface SnappedBeat {
  beat: number
  time: number
  /** `time - t`, seconds, signed. */
  deltaSec: number
}

/**
 * The beat of `beats` (sorted `[beatIndex, t]` pairs) nearest in time to `t`, or null for an empty grid. Ties go
 * to the earlier beat.
 */
export function nearestBeat(beats: ReadonlyArray<readonly [number, number]>, t: number): SnappedBeat | null {
  const n = beats.length
  if (n === 0 || !Number.isFinite(t)) return null
  let lo = 0
  let hi = n - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (beats[mid][1] < t) lo = mid + 1
    else hi = mid
  }
  // `lo` is the first beat at or after t; the beat before it may be closer.
  let best = lo
  if (lo > 0 && Math.abs(beats[lo - 1][1] - t) <= Math.abs(beats[lo][1] - t)) best = lo - 1
  const [beat, time] = beats[best]
  return { beat, time, deltaSec: time - t }
}

/**
 * Snap a tap to the beat grid. `tCompensated` is the (already lag-compensated) time; `mark` supplies the fallback
 * when the log recorded no beat grid: the beat/progress/bpm at the tap define a local grid, extrapolated back to
 * `tCompensated`. Returns null when neither exists.
 */
export function snapMarkToBeat(
  mark: Pick<StructureLogMark, 't' | 'beat' | 'beatProgress' | 'bpm'>,
  tCompensated: number,
  beats: ReadonlyArray<readonly [number, number]>,
): SnappedBeat | null {
  const fromGrid = nearestBeat(beats, tCompensated)
  if (fromGrid) return fromGrid
  const bpm = mark.bpm
  if (!finite(bpm) || bpm <= 0 || !finite(mark.beat)) return null
  const period = 60 / bpm
  const progress = finite(mark.beatProgress) ? mark.beatProgress : 0
  // Position of the compensated time, in beats, on the grid anchored at the tap.
  const pos = mark.beat + progress + (tCompensated - mark.t) / period
  const beat = Math.round(pos)
  const time = mark.t + (beat - (mark.beat + progress)) * period
  return { beat, time, deltaSec: time - tCompensated }
}

// ----------------------------------------------------------------------------------------------- truth

function groupByKind(events: readonly StructureLogEvent[]): StructureTruth['detectorsByKind'] {
  const out: StructureTruth['detectorsByKind'] = {}
  for (const e of events) (out[e.kind] ??= []).push(e)
  return out
}

/**
 * Human marks (lag-compensated, snapped to beats) plus the detector events of the same run. `input` is the JSON
 * text or an already-parsed value. See the file header for the lag caveat.
 */
export function structureLogToTruth(input: unknown, opts: TruthOptions = {}): StructureTruth {
  const log = parseStructureLog(input)
  const lagRaw = opts.lagCompensationSec
  const lag = lagRaw === undefined || !finite(lagRaw) ? DEFAULT_LAG_COMPENSATION_SEC : Math.max(0, lagRaw)
  const snap = opts.snap !== false
  const floor = Math.max(0, log.firstT ?? 0)
  const boundaries: TruthBoundary[] = log.marks.map((m) => {
    const t = Math.max(floor, m.t - lag)
    const snapped = snap ? snapMarkToBeat(m, t, log.beats) : null
    const b: TruthBoundary = {
      id: m.id,
      kind: m.kind,
      tapT: m.t,
      t,
      tRel: t - (log.firstT ?? 0),
      beat: snapped ? snapped.beat : m.beat,
      beatTime: snapped ? snapped.time : t,
      snapDeltaSec: snapped ? snapped.deltaSec : 0,
      snapped: snapped !== null,
    }
    if (m.note !== undefined) b.note = m.note
    return b
  })
  const caveats: string[] = [HUMAN_LAG_CAVEAT]
  if (log.marks.length === 0) caveats.push('No marks in this log: there is no ground truth to score against.')
  if (log.beats.length === 0 && log.marks.length > 0) {
    caveats.push('No beat grid recorded: marks were snapped with the tap-time bpm, or not at all.')
  }
  const c = log.counters as unknown as Record<string, unknown>
  const truncated = [c.droppedEvents, c.droppedCommits, c.droppedSamples, c.droppedBeats, c.droppedMarks].some(
    (x) => finite(x) && x > 0,
  )
  if (truncated) caveats.push('The log overflowed a cap: the earliest records were dropped, the start is incomplete.')
  if (log.source === 'unknown') caveats.push('The audio source type was not recorded.')
  return {
    version: log.version,
    source: log.source,
    trackHint: log.trackHint ?? null,
    startedAtIso: log.startedAtIso,
    firstT: log.firstT,
    durationSec: log.durationSec,
    bpm: log.bpmSummary.median,
    lagCompensationSec: lag,
    hasMarks: log.marks.length > 0,
    boundaries,
    sceneMarks: boundaries.filter((b) => b.kind === 'scene'),
    smallMarks: boundaries.filter((b) => b.kind === 'small'),
    detectorEvents: log.events,
    detectorsByKind: groupByKind(log.events),
    commits: log.commits,
    samples: log.samples,
    beats: log.beats,
    truncated,
    caveats,
  }
}

/** Ground-truth boundary times in seconds on the audio clock: snapped to beats by default, else lag-compensated taps. */
export function truthBoundaryTimes(truth: StructureTruth, snapped = true): number[] {
  return truth.boundaries.map((b) => (snapped && b.snapped ? b.beatTime : b.t))
}

/** Ground-truth boundary beat indices (snapped). */
export function truthBoundaryBeats(truth: StructureTruth): number[] {
  return truth.boundaries.map((b) => b.beat)
}

/**
 * Times (audio clock) of the detector events of one kind. For the level flags (`buildUp`, `isBuild`, `isDrop`,
 * `isBreakdown`, `dropExpected`, `silence`, `downbeatLock`) pass `onlyRising` to keep the rising edges only.
 */
export function detectorEventTimes(truth: StructureTruth, kind: StructureLogEventKind, onlyRising = false): number[] {
  const list = truth.detectorsByKind[kind] ?? []
  const out: number[] = []
  for (const e of list) {
    if (onlyRising) {
      const d = e.data
      if (d.on === false || d.locked === false) continue
    }
    out.push(e.t)
  }
  return out
}
