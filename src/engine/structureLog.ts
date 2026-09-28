/**
 * Structure / event recorder (`?structurelog`): the ONLY human ground truth for tuning the section-change engine.
 *
 * The user plays a song, taps a key at every REAL section change ({@link StructureLog.mark}, `M` / Space = a BIG
 * change worth a new scene, kind `scene`) and at every SMALL change where colours or post-FX / layers / effects
 * should react but no new scene is wanted ({@link StructureLog.markSmall}, `N`, kind `small`; these match the show
 * director's two outputs CUT and MICRO). This records those taps next to everything the detectors thought and every scene change, all stamped on the AUDIO clock
 * (`features.time`, the AudioContext clock while a source runs), so a later harness can score the detectors
 * against the taps. The plan is `so-the-mood-analysis-lively-hickey.md`, Phase 0A.
 *
 * PURE: no React, no three, no globals except the injectable clocks (`now` = wall clock in ms, defaulting to
 * `performance.now()`; `isoNow` = ISO date string). The overlay (`ui/StructureLog.tsx`) owns the DOM and the
 * hotkeys and calls {@link StructureLog.observe} once per rendered frame.
 *
 * ## What is recorded (EDGES only, never per-frame data)
 *
 *  - `marks`    the human taps (`mark` / `markSmall`), sorted by audio time. Each carries its `kind` (`scene` | `small`),
 *               the beat position and bpm at the tap. Example (schema v2):
 *               `{"id":3,"kind":"small","t":45.05,"beat":70,"beatInBar":2,"beatProgress":0.1,"bpm":120,"wallMs":1234.5}`
 *               Version 1 logs have no `kind`: readers treat such a mark as `scene`. Undo removes the most recently
 *               ADDED mark of either kind.
 *  - `events`   one record per detector edge: `sectionChange` (+ strength), `songSection` value changes,
 *               `boundary` (`boundaryChanged`), `drop`, `buildUp` / `isBuild` / `isDrop` / `isBreakdown` /
 *               `dropExpected` / `silence` (level flags: BOTH edges, `on`), `mood`, `character` (primary change),
 *               `downbeatLock`, `downbeatShift` (the bar phase jumped), `tempo` (at start and every 10 s),
 *               `sceneRequest` / `sceneWithdrawn`.
 *  - `commits`  every `sceneId` change with the beat index, the pending request it answered and the director's
 *               reason. The show director calls `noteCommit(trigger, detail)`; until then it is `unknown`.
 *  - `samples`  a coarse 1 Hz sample (energy, loudness, LUFS, bpm, confidence) so the plots can be rebuilt.
 *  - `beats`    `[beatIndex, t]` per beat, so marks can be snapped to the real beat grid.
 *  - `cells`    (ADDITIVE, schema v2) the per-beat feature cell the live event layer consumes, QUANTISED to 4
 *               significant digits, so a retuned detector can be replayed on a tapped song WITHOUT its audio
 *               (Spotify / YouTube system capture has no file): see {@link StructureLogCell} and
 *               `audio/eval/logCells.ts` (turns them back into `eventReplay.replayCells` input). About 300 bytes a
 *               beat: 35 KB per minute at 120 bpm. Fed by {@link StructureLog.noteCell}.
 *
 * Memory is bounded: every list is a ring with a cap and a `dropped` counter (oldest goes first). A held flag
 * records ONE edge, and a frame with no edge allocates nothing.
 *
 * ## Resets
 *
 * A new track starts a new log: a source that stops and starts again (the store goes through `starting`), a
 * source-type change, or the clock/beat counter going BACKWARDS (`resetAnalysis`) calls `begin(...)`. A finished
 * segment that has marks in it is never thrown away: it is archived (last 5 are kept) so a forgotten export can
 * still be downloaded.
 */

/** 2: marks carry `kind` (`scene` | `small`) and the counters split by kind. Version 1 logs are still readable. */
export const STRUCTURE_LOG_VERSION = 2
export const STRUCTURE_LOG_SCHEMA = 'audiovis.structurelog'

export type StructureLogSource = 'system' | 'mic' | 'file' | 'unknown'

export const STRUCTURE_LOG_EVENT_KINDS = [
  'sectionChange',
  'songSection',
  'boundary',
  'drop',
  'buildUp',
  'isBuild',
  'isDrop',
  'isBreakdown',
  'dropExpected',
  'silence',
  'mood',
  'character',
  'downbeatLock',
  'downbeatShift',
  'tempo',
  'sceneRequest',
  'sceneWithdrawn',
  // ADDITIVE (phase 2): one record per `SectionEvent` the show director was fed (v2 live change events, or the legacy
  // mapping's), with the director's score S / threshold T / decision when known: see `noteSectionEvent`.
  'sectionEvent',
] as const
export type StructureLogEventKind = (typeof STRUCTURE_LOG_EVENT_KINDS)[number]

/** The bounds. Exposed so tests (and the schema doc) do not restate them. */
export const STRUCTURE_LOG_CAPS = {
  events: 20_000,
  commits: 2_000,
  samples: 7_200, // 2 h at 1 Hz
  beats: 30_000,
  cells: 30_000,
  marks: 5_000,
  archive: 5,
} as const

/** Seconds between tempo summaries and between coarse samples. */
export const TEMPO_SUMMARY_SEC = 10
export const SAMPLE_INTERVAL_SEC = 1
/** A frame whose time is more than this BEFORE the previous one means the clock was reset (new track). */
export const CLOCK_BACKWARDS_EPS_SEC = 0.25
/** A `noteCommit` reason is attached to the next commit only if it is younger than this (audio seconds). */
export const COMMIT_REASON_TTL_SEC = 20
/** A `noteCommit` that arrives within this of an `unknown` commit patches that commit instead. */
export const COMMIT_PATCH_WINDOW_SEC = 0.5

// --------------------------------------------------------------------------------------------- input shapes

/**
 * The slice of `AudioFeatures` the recorder reads. Structural, so `audioEngine.features` is passed as it is and
 * tests build plain objects; nothing here imports the audio engine.
 */
export interface StructureLogFrame {
  time: number
  beatIndex: number
  beatInBar: number
  beatProgress: number
  bpm: number
  confidence: number
  tempoOctaves: number
  energy: number
  loudness: number
  lufsShortTerm: number
  silence: boolean
  drop: boolean
  buildUp: boolean
  sectionChange: boolean
  sectionChangeStrength: number
  downbeatLocked: boolean
  downbeatConfidence: number
  structureValid: boolean
  songSection: {
    section: string
    previousSection: string
    sectionConfidence: number
    beatsInSection: number
    boundaryChanged: boolean
    changeCount: number
    isBuild: boolean
    isDrop: boolean
    isBreakdown: boolean
    dropExpected: boolean
    buildProgress: number
    beatsTillDrop: number
    repetitionLabel: string
  }
  mood: { changed: boolean; state: string; predictedState: string; confidence: number }
  character: { primary: string | null; confidence: number; valence: number; arousal: number }
}

/** The slice of the zustand store the recorder reads (`useStore.getState()` is passed as it is). */
export interface StructureLogStoreSnapshot {
  sceneId: string
  pendingSceneId?: string | null
  /** `'running'` = a source is live. Anything else pauses recording. Undefined counts as running. */
  status?: string
  sourceType?: string | null
}

// -------------------------------------------------------------------------------------------- output shapes

export type StructureLogMarkKind = 'scene' | 'small'

export interface StructureLogMark {
  /** Creation order (stable across the time-sorted list and across undo). */
  id: number
  /** `scene` = a BIG change (M / Space); `small` = colours / effects should react, no new scene (N). */
  kind: StructureLogMarkKind
  /** Audio-clock seconds of the tap (`features.time`). */
  t: number
  /** `beatIndex` in force at the tap. */
  beat: number
  beatInBar: number
  /** 0..1 position inside that beat at the tap. */
  beatProgress: number
  bpm: number
  wallMs: number
  note?: string
}

/** Flat layout of {@link StructureLogCell.cell} (version 1): raw dB [sub, bass, mid, presence, high, air, rms] (7), the 13
 * log-mel values (`BeatCell.mfcc`), the 12 chroma bins (`BeatCell.hpcp`), then onsetDensity, flatness, centroid, silent. */
export const CELL_RAW_N = 7
export const CELL_MEL_N = 13
export const CELL_CHROMA_N = 12
export const CELL_LEN = CELL_RAW_N + CELL_MEL_N + CELL_CHROMA_N + 4
export const STRUCTURE_LOG_CELL_LAYOUT = 'raw7,mel13,chroma12,onset,flatness,centroid,silent'

/** The slice of a `BeatCell` (`audio/essentia/structureDsp.ts`) the recorder reads. Structural: no audio import. */
export interface StructureLogCellInput {
  hpcp: ArrayLike<number>
  mfcc: ArrayLike<number>
  logRms: number
  centroid: number
  flatness: number
  air: number
  sub: number
  bass: number
  mid: number
  high: number
  onsetDensity: number
  raw?: ArrayLike<number>
  silent?: number
}

/** The slice of `AudioFeatures` `noteCell` reads (the frame that closed the beat). */
export interface StructureLogCellFrame {
  beatIndex: number
  beatInBar: number
  time: number
  bpm: number
  downbeatLocked: boolean
}

/** One beat cell as the event layer received it, quantised (see {@link StructureLog.noteCell}). */
export interface StructureLogCell {
  beat: number
  t: number
  bpm: number
  /** Downbeat estimator lock at that beat (the event layer's grid hint). */
  locked: boolean
  /** `(beat - beatInBar) mod 4`: bar lines are the beats with `(beat - offset) % 4 === 0`. */
  offset: number
  /** Flat feature list, layout {@link STRUCTURE_LOG_CELL_LAYOUT} ({@link CELL_LEN} numbers). */
  cell: number[]
  /** Present only when the cell had no raw dB tap: `[logRms, sub, bass, mid, high, air]` (and `cell[0..6]` are 0). */
  fb?: number[]
}

export interface StructureLogEvent {
  kind: StructureLogEventKind
  t: number
  beat: number
  beatInBar: number
  wallMs: number
  data: Record<string, number | string | boolean | null>
}

export interface StructureLogCommit {
  t: number
  beat: number
  beatInBar: number
  wallMs: number
  from: string
  to: string
  /** The request that was pending on the previous frame ('' = none). */
  pending: string
  /** When that request appeared, if it was for this scene (else null: an unrequested commit). */
  requestedT: number | null
  requestedBeat: number | null
  /** Seconds from the request to the commit. */
  requestLagSec: number | null
  /** Why the show director changed scene (`noteCommit`); `unknown` until it reports. */
  trigger: string
  detail: string | null
  /** Seconds since the previous commit (null for the first). */
  sinceLastCommitSec: number | null
}

export interface StructureLogSample {
  t: number
  beat: number
  energy: number
  loudness: number
  /** Raw short-term LUFS: ABSOLUTE, so a louder chorus shows up here even though the normalised bands hide it. */
  lufs: number
  bpm: number
  confidence: number
}

export interface StructureLogBpmSummary {
  start: number | null
  last: number | null
  min: number | null
  max: number | null
  mean: number | null
  median: number | null
  /** Number of tempo readings (start + one per 10 s). */
  readings: number
}

export interface StructureLogCounters {
  frames: number
  /** All marks currently held (both kinds). */
  marks: number
  sceneMarks: number
  smallMarks: number
  undoneMarks: number
  commits: number
  events: Record<StructureLogEventKind, number>
  droppedEvents: number
  droppedCommits: number
  droppedSamples: number
  droppedBeats: number
  droppedCells: number
  /** Cells held for this track (after cap drops). */
  cells: number
  droppedMarks: number
  nonFinite: number
  resets: number
  archived: number
}

export interface StructureLogJson {
  schema: typeof STRUCTURE_LOG_SCHEMA
  version: number
  startedAtIso: string
  exportedAtIso: string
  userAgent?: string
  source: StructureLogSource
  trackHint?: string
  /** What began this log: `source-start`, `source-change`, `clock-backwards`, `finish`, `manual`, `init`. */
  startedBy: string
  startSceneId: string
  /** Audio-clock time of the first / last recorded frame (null when no frame was recorded). */
  firstT: number | null
  lastT: number | null
  durationSec: number
  bpmSummary: StructureLogBpmSummary
  marks: StructureLogMark[]
  events: StructureLogEvent[]
  commits: StructureLogCommit[]
  samples: StructureLogSample[]
  /** `[beatIndex, t]` pairs. */
  beats: Array<[number, number]>
  /** ADDITIVE (v2): per-beat feature cells for offline replay of the event layer. Absent in older logs. */
  cells?: StructureLogCell[]
  /** {@link STRUCTURE_LOG_CELL_LAYOUT} when `cells` is present. */
  cellLayout?: string
  counters: StructureLogCounters
}

export interface StructureLogExport {
  json: StructureLogJson
  /** The JSON text (one record per line, valid JSON). */
  text: string
  fileName: string
}

export interface StructureLogSummary {
  enabled: boolean
  running: boolean
  source: StructureLogSource
  trackHint: string
  /** All marks (both kinds). */
  marks: number
  sceneMarks: number
  smallMarks: number
  lastMark: { t: number; beat: number; kind: StructureLogMarkKind } | null
  eventCounts: Record<StructureLogEventKind, number>
  section: string
  sectionConfidence: number
  beatsInSection: number
  structureValid: boolean
  bpm: number
  confidence: number
  downbeatLocked: boolean
  t: number
  beat: number
  sceneId: string
  pendingSceneId: string
  recentCommits: StructureLogCommit[]
  archived: number
  unsaved: number
  dropped: number
}

// --------------------------------------------------------------------------------------------------- helpers

function fin(x: unknown, fallback: number): number {
  return typeof x === 'number' && Number.isFinite(x) ? x : fallback
}

/** Rounded for the file (never NaN / Infinity, which JSON would turn into null). */
function r3(x: number): number {
  return Number.isFinite(x) ? Math.round(x * 1000) / 1000 : 0
}

/** 4 significant digits (never NaN / Infinity): the file-size / fidelity trade of the recorded cells. */
function q4(x: unknown): number {
  return typeof x === 'number' && Number.isFinite(x) ? Number(x.toPrecision(4)) : 0
}

function toSource(v: string | null | undefined): StructureLogSource {
  return v === 'system' || v === 'mic' || v === 'file' ? v : 'unknown'
}

/** A bounded FIFO: past `cap` the oldest entry is overwritten and `dropped` counts it. */
class Ring<T> {
  private buf: T[] = []
  private head = 0
  size = 0
  dropped = 0
  constructor(readonly cap: number) {}

  push(v: T): void {
    if (this.size < this.cap) {
      this.buf[(this.head + this.size) % this.cap] = v
      this.size++
    } else {
      this.buf[this.head] = v
      this.head = (this.head + 1) % this.cap
      this.dropped++
    }
  }

  last(): T | undefined {
    return this.size === 0 ? undefined : this.buf[(this.head + this.size - 1) % this.cap]
  }

  toArray(): T[] {
    return this.tail(this.size)
  }

  /** The newest `n` entries, oldest first. */
  tail(n: number): T[] {
    const count = Math.max(0, Math.min(n, this.size))
    const out: T[] = new Array<T>(count)
    const skip = this.size - count
    for (let i = 0; i < count; i++) out[i] = this.buf[(this.head + skip + i) % this.cap]
    return out
  }

  clear(): void {
    this.buf = []
    this.head = 0
    this.size = 0
    this.dropped = 0
  }
}

function emptyEventCounts(): Record<StructureLogEventKind, number> {
  const out = {} as Record<StructureLogEventKind, number>
  for (const k of STRUCTURE_LOG_EVENT_KINDS) out[k] = 0
  return out
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2
}

function slug(text: string | undefined): string {
  if (!text) return ''
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '')
}

/** `structurelog-<trackHint slug>.json`, or `structurelog-YYYYMMDD-HHMMSS.json` from the start time when unnamed. */
export function structureLogFileName(trackHint: string | undefined, startedAtIso: string): string {
  const name = slug(trackHint)
  if (name) return `structurelog-${name}.json`
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(startedAtIso)
  const stamp = m ? `${m[1]}${m[2]}${m[3]}-${m[4]}${m[5]}${m[6]}` : 'unknown-time'
  return `structurelog-${stamp}.json`
}

/** Valid JSON, one record per line inside each list (readable and diffable, unlike one 200 kB line). */
export function stringifyStructureLog(json: StructureLogJson): string {
  const list = (a: readonly unknown[]): string =>
    a.length === 0 ? '[]' : `[\n${a.map((x) => `    ${JSON.stringify(x)}`).join(',\n')}\n  ]`
  const { marks, events, commits, samples, beats, cells, counters, ...head } = json
  const headText = JSON.stringify(head, null, 2).slice(0, -2) // drop the closing "\n}"
  return (
    `${headText},\n` +
    `  "marks": ${list(marks)},\n` +
    `  "events": ${list(events)},\n` +
    `  "commits": ${list(commits)},\n` +
    `  "samples": ${list(samples)},\n` +
    `  "beats": ${list(beats)},\n` +
    (cells === undefined ? '' : `  "cells": ${list(cells)},\n`) +
    `  "counters": ${JSON.stringify(counters)}\n}\n`
  )
}

/** The on-screen key hint (the overlay's first line of instructions). */
export const STRUCTURE_LOG_HINT =
  'M / Space = BIG change (new scene)  |  N = SMALL change (colour / effects)  |  U undo  |  E, E save'

const MMSS = (sec: number): string => {
  const s = Math.max(0, sec)
  const m = Math.floor(s / 60)
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`
}

const EVENT_SHORT: ReadonlyArray<readonly [StructureLogEventKind, string]> = [
  ['sectionChange', 'chg'],
  ['boundary', 'bnd'],
  ['songSection', 'sec'],
  ['drop', 'drop'],
  ['buildUp', 'bu'],
  ['isBuild', 'bld'],
  ['isBreakdown', 'brk'],
  ['mood', 'mood'],
  ['character', 'chr'],
  ['downbeatLock', 'lock'],
  ['downbeatShift', 'shift'],
  ['sectionEvent', 'ev'],
]

/** The overlay text (pure, so it is tested and the component only writes `textContent`). */
export function formatStructureLogHud(sum: StructureLogSummary): string[] {
  const lines: string[] = []
  const name = sum.trackHint ? sum.trackHint : '(unnamed: type a name below)'
  lines.push(`STRUCTURE LOG  ${sum.source}  ${name}`)
  if (!sum.enabled) return lines
  if (sum.running) lines.push(`t ${MMSS(sum.t)}  beat ${sum.beat}`)
  else if (sum.marks > 0) lines.push('SOURCE STOPPED. Press E, E to save this track.')
  else lines.push('waiting for a running audio source...')
  lines.push(STRUCTURE_LOG_HINT)
  const last = sum.lastMark ? `${MMSS(sum.lastMark.t)} (beat ${sum.lastMark.beat}, ${sum.lastMark.kind})` : '-'
  lines.push(`MARKS scene ${sum.sceneMarks}  small ${sum.smallMarks}   last ${last}`)
  const ev = EVENT_SHORT.map(([k, s]) => `${s} ${sum.eventCounts[k]}`).join('  ')
  lines.push(ev)
  const valid = sum.structureValid ? 'valid' : 'not valid'
  lines.push(
    `section ${sum.section || '-'} c${sum.sectionConfidence.toFixed(2)} ${sum.beatsInSection}b ${valid}` +
      `   bpm ${sum.bpm.toFixed(1)} c${sum.confidence.toFixed(2)}${sum.downbeatLocked ? ' lock' : ''}`,
  )
  lines.push(`scene ${sum.sceneId || '-'}${sum.pendingSceneId ? `  pending ${sum.pendingSceneId}` : ''}`)
  if (sum.recentCommits.length === 0) lines.push('commits: none yet')
  for (const c of sum.recentCommits) lines.push(`  b${c.beat}  ${c.from || '-'} > ${c.to}  [${c.trigger}]`)
  const extra: string[] = []
  if (sum.unsaved > 0) extra.push(`UNSAVED tracks: ${sum.unsaved}`)
  if (sum.archived > 0) extra.push(`archived ${sum.archived}`)
  if (sum.dropped > 0) extra.push(`dropped ${sum.dropped}`)
  if (extra.length > 0) lines.push(extra.join('   '))
  return lines
}

// ------------------------------------------------------------------------------------------------- the log

type CapKey = 'events' | 'commits' | 'samples' | 'beats' | 'cells' | 'marks' | 'archive'

export interface StructureLogOptions {
  /** Wall clock in ms. Default `performance.now()`. */
  now?: () => number
  /** ISO timestamp source. Default `new Date().toISOString()`. */
  isoNow?: () => string
  userAgent?: string
  /** Default true. The module singleton starts disabled and is switched on by the overlay. */
  enabled?: boolean
  caps?: Partial<Record<CapKey, number>>
}

// Indices into the previous-flag table (`Uint8Array`, so the per-frame path allocates nothing).
const F_SECTION_CHANGE = 0
const F_DROP = 1
const F_BOUNDARY = 2
const F_MOOD_CHANGED = 3
const F_BUILD_UP = 4
const F_IS_BUILD = 5
const F_IS_DROP = 6
const F_IS_BREAKDOWN = 7
const F_DROP_EXPECTED = 8
const F_SILENCE = 9
const F_LOCKED = 10
const FLAG_COUNT = 11

const DEFAULT_NOW = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now())
const DEFAULT_ISO = (): string => new Date().toISOString()

interface ArchivedTrack {
  json: StructureLogJson
  exported: boolean
}

export class StructureLog {
  enabled: boolean
  private readonly clock: () => number
  private readonly isoNow: () => string
  private readonly userAgent: string | undefined
  private readonly caps: Record<CapKey, number>

  // ---- the current track's records
  private marks: StructureLogMark[] = []
  private markSeq = 0
  private undone = 0
  private droppedMarks = 0
  private readonly events: Ring<StructureLogEvent>
  private readonly commits: Ring<StructureLogCommit>
  private readonly samples: Ring<StructureLogSample>
  private readonly beats: Ring<[number, number]>
  private readonly cells: Ring<StructureLogCell>
  private eventCounts = emptyEventCounts()
  private commitCount = 0
  private tempoReadings: number[] = []
  private tempoSum = 0
  private tempoMin = Infinity
  private tempoMax = -Infinity
  private tempoStart: number | null = null
  private tempoLast: number | null = null

  // ---- header
  private startedAtIso: string
  private startedBy = 'init'
  private source: StructureLogSource = 'unknown'
  private trackHint = ''
  private startSceneId = ''
  private firstT: number | null = null
  private resets = 0
  private archivedTotal = 0
  private nonFinite = 0
  private frames = 0
  private currentExported = false
  private archive: ArchivedTrack[] = []

  // ---- per-frame state (all primitives: the hot path allocates nothing)
  private wasRunning = false
  private primed = false
  private curT = 0
  private curBeat = 0
  private curBib = 0
  private curProgress = 0
  private curBpm = 120
  private lastT = 0
  private prevBeat = 0
  private prevBib = 0
  private readonly flags = new Uint8Array(FLAG_COUNT)
  private prevSection = ''
  private prevMoodState = ''
  private prevCharacter = ''
  private nextTempoT = 0
  private lastSampleT = -Infinity
  private prevSceneId = ''
  private prevPending = ''
  private pendingSinceT = 0
  private pendingSinceBeat = 0
  private lastCommitT: number | null = null
  private reasonTrigger = ''
  private reasonDetail: string | null = null
  private reasonT = -Infinity

  // ---- what the overlay shows
  private liveSection = ''
  private liveSectionConf = 0
  private liveBeatsInSection = 0
  private liveValid = false
  private liveConf = 0
  private liveLocked = false

  constructor(opts: StructureLogOptions = {}) {
    this.enabled = opts.enabled ?? true
    this.clock = opts.now ?? DEFAULT_NOW
    this.isoNow = opts.isoNow ?? DEFAULT_ISO
    this.userAgent = opts.userAgent ?? (typeof navigator !== 'undefined' ? navigator.userAgent : undefined)
    this.caps = { ...STRUCTURE_LOG_CAPS, ...(opts.caps ?? {}) }
    this.events = new Ring(this.caps.events)
    this.commits = new Ring(this.caps.commits)
    this.samples = new Ring(this.caps.samples)
    this.beats = new Ring(this.caps.beats)
    this.cells = new Ring(this.caps.cells)
    this.startedAtIso = this.isoNow()
  }

  // ------------------------------------------------------------------------------------------- human input

  /**
   * A human tap of kind `scene` (M / Space): "a real section change is happening about now". `t` is the audio-clock time (`features.time`)
   * and `beat` the `beatIndex` in force. Beat-in-bar, beat progress and bpm come from the last observed frame.
   * Marks are kept sorted by `t` (a late out-of-order mark is inserted, not appended). Returns the mark, or null
   * for a non-finite `t` (counted) or a disabled log.
   */
  mark(t: number, beat: number, note?: string): StructureLogMark | null {
    return this.addMark('scene', t, beat, note)
  }

  /**
   * A human tap of kind `small` (N): "colours / post-FX / layers / effects should react now, but this is NOT a new
   * scene". Same stamping and ordering as {@link mark}.
   */
  markSmall(t: number, beat: number, note?: string): StructureLogMark | null {
    return this.addMark('small', t, beat, note)
  }

  private addMark(kind: StructureLogMarkKind, t: number, beat: number, note?: string): StructureLogMark | null {
    if (!this.enabled) return null
    if (typeof t !== 'number' || !Number.isFinite(t)) {
      this.nonFinite++
      return null
    }
    const m: StructureLogMark = {
      id: ++this.markSeq,
      kind,
      t: r3(t),
      beat: Math.trunc(fin(beat, this.curBeat)),
      beatInBar: this.curBib,
      beatProgress: r3(this.curProgress),
      bpm: r3(this.curBpm),
      wallMs: r3(this.clock()),
    }
    if (note !== undefined && note !== '') m.note = note
    let i = this.marks.length
    while (i > 0 && this.marks[i - 1].t > m.t) i--
    this.marks.splice(i, 0, m)
    if (this.marks.length > this.caps.marks) {
      this.marks.shift()
      this.droppedMarks++
    }
    this.currentExported = false
    return m
  }

  /** Remove the most recently CREATED mark of either kind (a mis-tap). Returns it, or null when there is none. */
  undoLastMark(): StructureLogMark | null {
    if (this.marks.length === 0) return null
    let idx = 0
    for (let i = 1; i < this.marks.length; i++) if (this.marks[i].id > this.marks[idx].id) idx = i
    const [removed] = this.marks.splice(idx, 1)
    this.undone++
    this.currentExported = false
    return removed
  }

  private countKind(kind: StructureLogMarkKind): number {
    let n = 0
    for (const m of this.marks) if (m.kind === kind) n++
    return n
  }

  /** Name the current track (shown in the file and its file name). */
  setTrackHint(name: string): void {
    this.trackHint = name.trim().slice(0, 120)
  }

  getTrackHint(): string {
    return this.trackHint
  }

  // --------------------------------------------------------------------------------------- show director

  /**
   * The show director's reason for a scene change: `trigger` (`'drop'`, `'change'`, ...) and free
   * `detail` (scores, thresholds). Call it when the change is requested or right after it commits: a reason
   * younger than 20 audio-seconds is attached to the next commit, and a call within 0.5 s after an `unknown`
   * commit patches that commit. Free when the log is disabled.
   */
  noteCommit(trigger: string, detail?: string): void {
    if (!this.enabled) return
    const trig = trigger === '' ? 'unknown' : trigger
    const last = this.commits.last()
    if (last && last.trigger === 'unknown' && this.lastT - last.t <= COMMIT_PATCH_WINDOW_SEC) {
      last.trigger = trig
      last.detail = detail ?? null
      return
    }
    this.reasonTrigger = trig
    this.reasonDetail = detail ?? null
    this.reasonT = this.lastT
  }

  /**
   * A `SectionEvent` the show director was (or, in shadow mode, would have been) fed: its type, calibrated strength and
   * confidence, where the change musically began (`boundaryBeat`/`boundaryTime`, on the source's bar grid: `phase`),
   * when the source knew (`detectedAt*`, so the lag is in the log) and, when the caller has them, the director's score
   * `S = strength * typeWeight * confidence`, the effective threshold `T` and its decision (`HOLD`/`MICRO`/`CUT`).
   * `source` is `live` (the v2 event layer), `legacy` or `plan`; `shadow` marks a v2 event that was only recorded
   * (`?events=legacy`). Free when the log is disabled.
   */
  noteSectionEvent(
    ev: {
      id: number
      type: string
      strength: number
      confidence: number
      boundaryBeat: number
      boundaryTime: number
      detectedAtBeat: number
      detectedAtTime: number
      source: string
      phase: number
      sim?: { boundaryBeat: number; similarity: number }
    },
    extra: { S?: number; T?: number; decision?: string; shadow?: boolean } = {},
  ): void {
    if (!this.enabled) return
    const data: Record<string, number | string | boolean | null> = {
      id: Math.trunc(fin(ev.id, 0)),
      type: String(ev.type),
      source: String(ev.source),
      strength: r3(fin(ev.strength, 0)),
      confidence: r3(fin(ev.confidence, 0)),
      boundaryBeat: Math.trunc(fin(ev.boundaryBeat, 0)),
      boundaryT: r3(fin(ev.boundaryTime, 0)),
      detectedBeat: Math.trunc(fin(ev.detectedAtBeat, 0)),
      detectedT: r3(fin(ev.detectedAtTime, 0)),
      lagBeats: Math.trunc(fin(ev.detectedAtBeat, 0) - fin(ev.boundaryBeat, 0)),
      phase: Math.trunc(fin(ev.phase, 0)),
    }
    if (ev.sim) {
      data.simBeat = Math.trunc(fin(ev.sim.boundaryBeat, 0))
      data.simSimilarity = r3(fin(ev.sim.similarity, 0))
    }
    if (extra.S !== undefined) data.S = r3(fin(extra.S, 0))
    if (extra.T !== undefined) data.T = r3(fin(extra.T, 0))
    if (extra.decision !== undefined) data.decision = extra.decision
    if (extra.shadow) data.shadow = true
    this.emit('sectionEvent', data)
  }

  // ------------------------------------------------------------------------------------------- beat cells

  /**
   * One freshly folded per-beat feature cell (the `StructureAnalyzer.onCell` hook, once per beat), recorded quantised so
   * the event layer can be replayed offline from the log alone. `f` is the frame that closed the beat. A no-op unless the
   * log is enabled (`?structurelog`); costs one small array per BEAT, nothing per frame. Bounded (`caps.cells`, oldest
   * dropped and counted). A cell whose beat / time is not finite is skipped (counted in `nonFinite`).
   */
  noteCell(c: StructureLogCellInput, f: StructureLogCellFrame): void {
    if (!this.enabled) return
    if (!Number.isFinite(f.beatIndex) || !Number.isFinite(f.time)) {
      this.nonFinite++
      return
    }
    const v = new Array<number>(CELL_LEN)
    const raw = c.raw
    const hasRaw = raw !== undefined && raw.length >= CELL_RAW_N
    let k = 0
    for (let i = 0; i < CELL_RAW_N; i++) v[k++] = hasRaw ? q4(raw[i]) : 0
    for (let i = 0; i < CELL_MEL_N; i++) v[k++] = i < c.mfcc.length ? q4(c.mfcc[i]) : 0
    for (let i = 0; i < CELL_CHROMA_N; i++) v[k++] = i < c.hpcp.length ? q4(c.hpcp[i]) : 0
    v[k++] = q4(c.onsetDensity)
    v[k++] = q4(c.flatness)
    v[k++] = q4(c.centroid)
    v[k] = q4(c.silent)
    const beat = Math.trunc(f.beatIndex)
    const rec: StructureLogCell = {
      beat,
      t: r3(f.time),
      bpm: r3(fin(f.bpm, 0)),
      locked: f.downbeatLocked === true,
      offset: (((beat - Math.trunc(fin(f.beatInBar, 0))) % 4) + 4) % 4,
      cell: v,
    }
    if (!hasRaw) rec.fb = [q4(c.logRms), q4(c.sub), q4(c.bass), q4(c.mid), q4(c.high), q4(c.air)]
    this.cells.push(rec)
  }

  // ------------------------------------------------------------------------------------------- per frame

  /**
   * Call once per rendered frame, after the engine and the directors have run. Records edges only.
   * `f` is `audioEngine.features`, `s` is `useStore.getState()` (see the shapes above).
   */
  observe(f: StructureLogFrame, s: StructureLogStoreSnapshot): void {
    if (!this.enabled) return
    const t = f.time
    if (typeof t !== 'number' || !Number.isFinite(t)) {
      this.nonFinite++
      return
    }
    if (!(s.status === undefined || s.status === 'running')) {
      this.wasRunning = false
      return
    }
    const src = toSource(s.sourceType)
    const beat = Math.trunc(fin(f.beatIndex, this.prevBeat))
    if (!this.wasRunning) {
      this.wasRunning = true
      this.begin('source-start', src)
    } else if (this.primed) {
      if (src !== this.source && src !== 'unknown' && this.source !== 'unknown') this.begin('source-change', src)
      else if (t < this.lastT - CLOCK_BACKWARDS_EPS_SEC || beat < this.prevBeat - 1) this.begin('clock-backwards', src)
      else if (this.source === 'unknown') this.source = src
    }
    this.frames++
    this.curT = t
    this.curBeat = beat
    this.curBpm = fin(f.bpm, this.curBpm)
    this.curProgress = fin(f.beatProgress, 0)
    const bib = Math.trunc(fin(f.beatInBar, this.prevBib))

    const ss = f.songSection
    const sectionName = typeof ss.section === 'string' ? ss.section : ''
    this.liveSection = sectionName
    this.liveSectionConf = fin(ss.sectionConfidence, 0)
    this.liveBeatsInSection = Math.trunc(fin(ss.beatsInSection, 0))
    this.liveValid = f.structureValid === true
    this.liveConf = fin(f.confidence, 0)
    this.liveLocked = f.downbeatLocked === true

    if (!this.primed) {
      this.curBib = bib
      this.prime(f, s, t, beat, bib, sectionName)
      return
    }
    this.curBib = bib

    // ---- beat grid + bar-phase discontinuities
    const dBeat = beat - this.prevBeat
    if (dBeat !== 0) this.beats.push([beat, r3(t)])
    const expectedBib = (((this.prevBib + dBeat) % 4) + 4) % 4
    if (bib !== expectedBib) this.emit('downbeatShift', { from: this.prevBib, to: bib, expected: expectedBib })
    this.prevBeat = beat
    this.prevBib = bib

    // ---- one-frame pulses (rising edge only)
    if (this.rise(F_SECTION_CHANGE, f.sectionChange === true)) {
      this.emit('sectionChange', { strength: r3(fin(f.sectionChangeStrength, 0)) })
    }
    if (this.rise(F_DROP, f.drop === true)) this.emit('drop', {})
    if (this.rise(F_BOUNDARY, ss.boundaryChanged === true)) {
      this.emit('boundary', {
        section: sectionName,
        previousSection: ss.previousSection,
        beatsInSection: this.liveBeatsInSection,
        sectionConfidence: r3(this.liveSectionConf),
        structureValid: this.liveValid,
        changeCount: fin(ss.changeCount, 0),
        repetitionLabel: ss.repetitionLabel,
      })
    }
    if (this.rise(F_MOOD_CHANGED, f.mood.changed === true)) {
      this.emit('mood', {
        from: this.prevMoodState,
        to: f.mood.state,
        predicted: f.mood.predictedState,
        confidence: r3(fin(f.mood.confidence, 0)),
      })
    }
    this.prevMoodState = f.mood.state

    // ---- committed section value and character primary
    if (sectionName !== this.prevSection) {
      this.emit('songSection', {
        from: this.prevSection,
        to: sectionName,
        sectionConfidence: r3(this.liveSectionConf),
        beatsInSection: this.liveBeatsInSection,
        structureValid: this.liveValid,
      })
      this.prevSection = sectionName
    }
    const primary = f.character.primary ?? ''
    if (primary !== this.prevCharacter) {
      this.emit('character', {
        from: this.prevCharacter,
        to: primary,
        confidence: r3(fin(f.character.confidence, 0)),
        valence: r3(fin(f.character.valence, 0)),
        arousal: r3(fin(f.character.arousal, 0)),
      })
      this.prevCharacter = primary
    }

    // ---- level flags (both edges)
    if (this.change(F_BUILD_UP, f.buildUp === true)) this.emit('buildUp', { on: f.buildUp === true })
    if (this.change(F_IS_BUILD, ss.isBuild === true)) {
      this.emit('isBuild', { on: ss.isBuild === true, buildProgress: r3(fin(ss.buildProgress, 0)) })
    }
    if (this.change(F_IS_DROP, ss.isDrop === true)) this.emit('isDrop', { on: ss.isDrop === true })
    if (this.change(F_IS_BREAKDOWN, ss.isBreakdown === true)) this.emit('isBreakdown', { on: ss.isBreakdown === true })
    if (this.change(F_DROP_EXPECTED, ss.dropExpected === true)) {
      this.emit('dropExpected', { on: ss.dropExpected === true, beatsTillDrop: r3(fin(ss.beatsTillDrop, -1)) })
    }
    if (this.change(F_SILENCE, f.silence === true)) this.emit('silence', { on: f.silence === true })
    if (this.change(F_LOCKED, this.liveLocked)) {
      this.emit('downbeatLock', { locked: this.liveLocked, confidence: r3(fin(f.downbeatConfidence, 0)) })
    }

    // ---- tempo summary (10 s) and coarse sample (1 Hz)
    if (t >= this.nextTempoT) {
      this.recordTempo(f, 'summary')
      this.nextTempoT = t + TEMPO_SUMMARY_SEC
    }
    if (t - this.lastSampleT >= SAMPLE_INTERVAL_SEC) this.recordSample(f, t, beat)

    // ---- scene commits and requests
    this.observeScene(s, t, beat)
    this.lastT = t
  }

  private prime(f: StructureLogFrame, s: StructureLogStoreSnapshot, t: number, beat: number, bib: number, section: string): void {
    this.primed = true
    this.firstT = r3(t)
    this.lastT = t
    this.prevBeat = beat
    this.prevBib = bib
    const ss = f.songSection
    this.flags[F_SECTION_CHANGE] = 0
    this.flags[F_DROP] = 0
    this.flags[F_BOUNDARY] = 0
    this.flags[F_MOOD_CHANGED] = 0
    this.flags[F_BUILD_UP] = f.buildUp === true ? 1 : 0
    this.flags[F_IS_BUILD] = ss.isBuild === true ? 1 : 0
    this.flags[F_IS_DROP] = ss.isDrop === true ? 1 : 0
    this.flags[F_IS_BREAKDOWN] = ss.isBreakdown === true ? 1 : 0
    this.flags[F_DROP_EXPECTED] = ss.dropExpected === true ? 1 : 0
    this.flags[F_SILENCE] = f.silence === true ? 1 : 0
    this.flags[F_LOCKED] = f.downbeatLocked === true ? 1 : 0
    this.prevSection = section
    this.prevMoodState = f.mood.state
    this.prevCharacter = f.character.primary ?? ''
    this.prevSceneId = s.sceneId || ''
    this.prevPending = s.pendingSceneId || ''
    this.pendingSinceT = t
    this.pendingSinceBeat = beat
    this.startSceneId = this.prevSceneId
    this.beats.push([beat, r3(t)])
    this.recordTempo(f, 'start')
    this.nextTempoT = t + TEMPO_SUMMARY_SEC
    this.recordSample(f, t, beat)
  }

  private rise(i: number, v: boolean): boolean {
    const was = this.flags[i] === 1
    this.flags[i] = v ? 1 : 0
    return v && !was
  }

  private change(i: number, v: boolean): boolean {
    const was = this.flags[i] === 1
    this.flags[i] = v ? 1 : 0
    return v !== was
  }

  private emit(kind: StructureLogEventKind, data: Record<string, number | string | boolean | null>): void {
    this.eventCounts[kind]++
    this.events.push({
      kind,
      t: r3(this.curT),
      beat: this.curBeat,
      beatInBar: this.curBib,
      wallMs: r3(this.clock()),
      data,
    })
  }

  private recordTempo(f: StructureLogFrame, phase: 'start' | 'summary'): void {
    const bpm = fin(f.bpm, 0)
    this.emit('tempo', {
      bpm: r3(bpm),
      confidence: r3(fin(f.confidence, 0)),
      tempoOctaves: r3(fin(f.tempoOctaves, 0)),
      downbeatLocked: f.downbeatLocked === true,
      phase,
    })
    if (bpm > 0) {
      if (this.tempoReadings.length < 2000) this.tempoReadings.push(bpm)
      if (this.tempoStart === null) this.tempoStart = bpm
      this.tempoLast = bpm
      this.tempoSum += bpm
      if (bpm < this.tempoMin) this.tempoMin = bpm
      if (bpm > this.tempoMax) this.tempoMax = bpm
    }
  }

  private recordSample(f: StructureLogFrame, t: number, beat: number): void {
    this.lastSampleT = t
    this.samples.push({
      t: r3(t),
      beat,
      energy: r3(fin(f.energy, 0)),
      loudness: r3(fin(f.loudness, 0)),
      lufs: r3(fin(f.lufsShortTerm, -70)),
      bpm: r3(fin(f.bpm, 0)),
      confidence: r3(fin(f.confidence, 0)),
    })
  }

  private observeScene(s: StructureLogStoreSnapshot, t: number, beat: number): void {
    const sid = s.sceneId || ''
    if (sid !== this.prevSceneId) {
      const requested = this.prevPending !== '' && this.prevPending === sid
      const hasReason = t - this.reasonT <= COMMIT_REASON_TTL_SEC && this.reasonTrigger !== ''
      this.commitCount++
      this.commits.push({
        t: r3(t),
        beat,
        beatInBar: this.curBib,
        wallMs: r3(this.clock()),
        from: this.prevSceneId,
        to: sid,
        pending: this.prevPending,
        requestedT: requested ? r3(this.pendingSinceT) : null,
        requestedBeat: requested ? this.pendingSinceBeat : null,
        requestLagSec: requested ? r3(t - this.pendingSinceT) : null,
        trigger: hasReason ? this.reasonTrigger : 'unknown',
        detail: hasReason ? this.reasonDetail : null,
        sinceLastCommitSec: this.lastCommitT === null ? null : r3(t - this.lastCommitT),
      })
      this.lastCommitT = t
      this.reasonTrigger = ''
      this.reasonDetail = null
      this.reasonT = -Infinity
      this.prevSceneId = sid
    }
    const pend = s.pendingSceneId || ''
    if (pend !== this.prevPending) {
      if (pend !== '') {
        this.emit('sceneRequest', { sceneId: pend, previous: this.prevPending })
        this.pendingSinceT = t
        this.pendingSinceBeat = beat
      } else if (this.prevPending !== sid) {
        this.emit('sceneWithdrawn', { sceneId: this.prevPending })
      }
      this.prevPending = pend
    }
  }

  // ------------------------------------------------------------------------------------------------ reset

  /**
   * Start a fresh log for a new track. A segment with marks (or one being finished) is archived first. The track
   * name is kept when nothing had been recorded yet (typed BEFORE pressing play), cleared when a real track ran.
   */
  reset(reason = 'manual'): void {
    this.begin(reason, this.source)
  }

  private begin(reason: string, src: StructureLogSource): void {
    const ran = this.frames > 0
    if (ran && (this.marks.length > 0 || reason === 'finish')) this.archiveCurrent()
    if (ran) {
      this.resets++
      this.trackHint = ''
    }
    this.marks = []
    this.markSeq = 0
    this.undone = 0
    this.droppedMarks = 0
    this.events.clear()
    this.commits.clear()
    this.samples.clear()
    this.beats.clear()
    this.cells.clear()
    this.eventCounts = emptyEventCounts()
    this.commitCount = 0
    this.tempoReadings = []
    this.tempoSum = 0
    this.tempoMin = Infinity
    this.tempoMax = -Infinity
    this.tempoStart = null
    this.tempoLast = null
    this.startedAtIso = this.isoNow()
    this.startedBy = reason
    this.source = src
    this.startSceneId = ''
    this.firstT = null
    this.nonFinite = 0
    this.frames = 0
    this.currentExported = false
    this.primed = false
    this.lastSampleT = -Infinity
    this.nextTempoT = 0
    this.lastCommitT = null
    this.reasonTrigger = ''
    this.reasonDetail = null
    this.reasonT = -Infinity
    this.lastT = 0
    this.prevBeat = 0
    this.curBeat = 0
    this.curBib = 0
  }

  private archiveCurrent(): void {
    this.archive.push({ json: this.toJSON(), exported: this.currentExported })
    this.archivedTotal++
    while (this.archive.length > this.caps.archive) this.archive.shift()
  }

  // ------------------------------------------------------------------------------------------------ export

  toJSON(): StructureLogJson {
    const readings = this.tempoReadings
    const end = this.lastT
    const out: StructureLogJson = {
      schema: STRUCTURE_LOG_SCHEMA,
      version: STRUCTURE_LOG_VERSION,
      startedAtIso: this.startedAtIso,
      exportedAtIso: this.isoNow(),
      source: this.source,
      startedBy: this.startedBy,
      startSceneId: this.startSceneId,
      firstT: this.firstT,
      lastT: this.firstT === null ? null : r3(end),
      durationSec: this.firstT === null ? 0 : r3(Math.max(0, end - this.firstT)),
      bpmSummary: {
        start: this.tempoStart === null ? null : r3(this.tempoStart),
        last: this.tempoLast === null ? null : r3(this.tempoLast),
        min: readings.length ? r3(this.tempoMin) : null,
        max: readings.length ? r3(this.tempoMax) : null,
        mean: readings.length ? r3(this.tempoSum / readings.length) : null,
        median: readings.length ? r3(median(readings) ?? 0) : null,
        readings: readings.length,
      },
      marks: this.marks.map((m) => ({ ...m })),
      events: this.events.toArray(),
      commits: this.commits.toArray(),
      samples: this.samples.toArray(),
      beats: this.beats.toArray(),
      cells: this.cells.toArray(),
      cellLayout: STRUCTURE_LOG_CELL_LAYOUT,
      counters: {
        frames: this.frames,
        marks: this.marks.length,
        sceneMarks: this.countKind('scene'),
        smallMarks: this.countKind('small'),
        undoneMarks: this.undone,
        commits: this.commitCount,
        events: { ...this.eventCounts },
        droppedEvents: this.events.dropped,
        droppedCommits: this.commits.dropped,
        droppedSamples: this.samples.dropped,
        droppedBeats: this.beats.dropped,
        droppedCells: this.cells.dropped,
        cells: this.cells.size,
        droppedMarks: this.droppedMarks,
        nonFinite: this.nonFinite,
        resets: this.resets,
        archived: this.archivedTotal,
      },
    }
    if (this.userAgent) out.userAgent = this.userAgent
    if (this.trackHint) out.trackHint = this.trackHint
    return out
  }

  fileName(): string {
    return structureLogFileName(this.trackHint, this.startedAtIso)
  }

  /** The current track as a downloadable file. Marks it as exported (the unsaved-work guard). */
  snapshotForExport(): StructureLogExport {
    const json = this.toJSON()
    this.currentExported = true
    return { json, text: stringifyStructureLog(json), fileName: this.fileName() }
  }

  /** Export the current track, archive it, and start a fresh log. The archive still holds it if the save failed. */
  finish(): StructureLogExport {
    const out = this.snapshotForExport()
    this.begin('finish', this.source)
    return out
  }

  archivedCount(): number {
    return this.archive.length
  }

  /** The newest archived track as a file (for a re-download), or null. Marks it exported. */
  latestArchived(): StructureLogExport | null {
    const a = this.archive[this.archive.length - 1]
    if (!a) return null
    a.exported = true
    return {
      json: a.json,
      text: stringifyStructureLog(a.json),
      fileName: structureLogFileName(a.json.trackHint, a.json.startedAtIso),
    }
  }

  /** Tracks holding marks that have not been exported (the current one and the archive): the close-window guard. */
  unsavedCount(): number {
    let n = this.marks.length > 0 && !this.currentExported ? 1 : 0
    for (const a of this.archive) if (!a.exported && a.json.marks.length > 0) n++
    return n
  }

  // ---------------------------------------------------------------------------------------------- overlay

  /** Numbers for the overlay (allocates: call it at a few Hz, not per frame). */
  summary(recentCommits = 4): StructureLogSummary {
    const last = this.marks.length ? this.marks[this.marks.length - 1] : null
    return {
      enabled: this.enabled,
      running: this.wasRunning && this.primed,
      source: this.source,
      trackHint: this.trackHint,
      marks: this.marks.length,
      sceneMarks: this.countKind('scene'),
      smallMarks: this.countKind('small'),
      lastMark: last ? { t: last.t, beat: last.beat, kind: last.kind } : null,
      eventCounts: { ...this.eventCounts },
      section: this.liveSection,
      sectionConfidence: this.liveSectionConf,
      beatsInSection: this.liveBeatsInSection,
      structureValid: this.liveValid,
      bpm: this.curBpm,
      confidence: this.liveConf,
      downbeatLocked: this.liveLocked,
      t: this.curT,
      beat: this.curBeat,
      sceneId: this.prevSceneId,
      pendingSceneId: this.prevPending,
      recentCommits: this.commits.tail(recentCommits),
      archived: this.archive.length,
      unsaved: this.unsavedCount(),
      dropped: this.events.dropped + this.commits.dropped + this.samples.dropped + this.beats.dropped,
    }
  }

  /** The audio-clock time and beat to stamp a tap with right now (last observed frame). */
  now(): { t: number; beat: number } {
    return { t: this.curT, beat: this.curBeat }
  }

  /** True while a source is running and frames are being recorded (a mark before that has no audio clock). */
  isRunning(): boolean {
    return this.enabled && this.wasRunning && this.primed
  }
}

/**
 * The process-wide recorder. DISABLED until the overlay finds `?structurelog` and switches it on, so the show
 * director can call `structureLog.noteCommit(...)` unconditionally: it is a single boolean check when off.
 */
export const structureLog = new StructureLog({ enabled: false })
