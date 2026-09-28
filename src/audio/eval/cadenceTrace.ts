/**
 * Compact per-frame TRACE of what the scene-change trigger logic reads (phase 0C, baseline replay).
 *
 * The directors (`AutoPilot`, `PerformanceDirector`, `SceneManager`, `armedChange`) decide from a small set of
 * `AudioFeatures` fields. `scripts/calibrate/features.ts` (`runTrack`) already replays real decoded audio through
 * the same DSP chain at a fixed 60 Hz; this module is the columnar record of just the fields those directors read,
 * so the (cheap) trigger model in `legacyCadence.ts` can be re-run in milliseconds without re-decoding or
 * re-running the FFT chain (the same idea as `emotion.ts`'s `toFeatureCache`).
 *
 * Columnar typed arrays (not an array of objects): a 4-minute track is ~14k frames and ~35 columns of 1-4 bytes.
 * Continuous values are QUANTISED (see `Q8`/`Q10`); the model's thresholds (0.25, 0.5, 0.6, 0.65, 0.9...) are far
 * coarser than the ~0.2% quantisation step, and each quantised column says so on its declaration.
 *
 * Pure (no I/O, no Node API): `packTrace`/`unpackTrace` produce a JSON-safe object (RLE where it pays, base64 of the
 * raw little-endian bytes otherwise); the caller does the file I/O. This is offline-evaluation tooling: nothing in
 * the shipped app imports it.
 */
import { CHARACTER_MOODS } from '../characterTypes'
import { MOOD_STATES, SECTION_STATES, type AudioFeatures } from '../types'

export const CADENCE_TRACE_VERSION = 1

/** Scale of the 0..1 quantised columns (stored as 0..255). */
export const Q8 = 255
/** Scale of the "beats" columns stored as tenths of a beat in an Int16. */
export const Q10 = 10
/** `sectionChangeStrength` is stored x100 in a Uint8 (clamped at 2.55; the detector's trigger is 0.45, typical event ~0.6). */
export const STRENGTH_SCALE = 100

type ColType = 'u8' | 'i8' | 'u16' | 'i16' | 'i32'

/**
 * Every column and its element type. Comments give the source field and the encoding.
 */
const SPEC = {
  // --- Front-end / grid ---
  /** f.silence */
  silence: 'u8',
  /** f.beat (one-frame event) */
  beat: 'u8',
  /** f.beatIndex */
  beatIndex: 'i32',
  /** f.beatInBar (0..3) */
  beatInBar: 'u8',
  /** f.bar */
  bar: 'i32',
  /** f.bpm x10 */
  bpm10: 'u16',
  /** f.confidence (beat-grid confidence) x255 */
  confidence: 'u8',
  /** f.downbeatLocked */
  downbeatLocked: 'u8',
  /** f.energy x255 */
  energy: 'u8',
  /** f.loudness x255 */
  loudness: 'u8',
  // --- Phrase detector (the "fast" section flag) ---
  /** f.sectionChange (one-frame event) */
  sectionChange: 'u8',
  /** f.sectionChangeStrength x100, clamped to 255 */
  sectionChangeStrength: 'u8',
  // --- Broadband drop / build heuristics ---
  /** f.drop (latched ~0.6 s) */
  drop: 'u8',
  /** f.buildUp */
  buildUp: 'u8',
  // --- SectionTracker ---
  /** f.structureValid */
  structureValid: 'u8',
  /** f.songSection.boundaryChanged (one-frame event) */
  boundaryChanged: 'u8',
  /** f.songSection.section as an index into `enums.sections` */
  section: 'u8',
  /** f.songSection.previousSection as an index into `enums.sections` */
  previousSection: 'u8',
  /** f.songSection.sectionConfidence x255 */
  sectionConfidence: 'u8',
  /** f.songSection.beatsInSection, clamped to 65535 */
  beatsInSection: 'u16',
  /** f.songSection.changeCount */
  changeCount: 'u16',
  /** f.songSection.isBuild */
  isBuild: 'u8',
  /** f.songSection.isSustain */
  isSustain: 'u8',
  /** f.songSection.isBreakdown */
  isBreakdown: 'u8',
  /** f.songSection.isDrop */
  isDrop: 'u8',
  /** f.songSection.beatsTillDrop x10 (-1 unknown -> -10) */
  beatsTillDrop10: 'i16',
  /** f.songSection.buildProgress x255 */
  buildProgress: 'u8',
  /** f.songSection.repetitionLabel as an index into `enums.labels` (0 = none) */
  repetitionLabel: 'u8',
  // --- Mood ---
  /** f.mood.state as an index into `enums.moods` */
  moodState: 'u8',
  /** f.mood.predictedState as an index into `enums.moods` */
  predictedState: 'u8',
  /** f.mood.changed (one-frame event) */
  moodChanged: 'u8',
  /** f.mood.changeCount */
  moodChangeCount: 'u16',
  /** f.mood.confidence x255 */
  moodConfidence: 'u8',
  /** f.mood.ambiguity x255 */
  moodAmbiguity: 'u8',
  /** f.mood.beatsTillTransition x10 (-1 unknown -> -10) */
  beatsTillTransition10: 'i16',
  // --- Character (only stepped when the harness was asked to; else -1) ---
  /** f.character.primary as an index into `enums.chars`; -1 when the read is not valid / not stepped */
  charPrimary: 'i8',
} as const satisfies Record<string, ColType>

export type ColName = keyof typeof SPEC
export const COLUMN_NAMES = Object.keys(SPEC) as ColName[]

export type NumArray = Uint8Array | Int8Array | Uint16Array | Int16Array | Int32Array

export interface CadenceTrace {
  version: number
  frameRate: number
  /** Number of frames. Frame `i` is at `t = i / frameRate` seconds. */
  n: number
  sampleRate: number
  durationSec: number
  cols: Record<ColName, NumArray>
  enums: { sections: string[]; moods: string[]; chars: string[]; labels: string[] }
  /**
   * Every boundary (beat index) the `StructureAnalyzer` ever reported, with the frame it was FIRST reported at
   * (matching within +-2 beats across batches, since a peak wanders a little between batches). The "analyser
   * boundary" the section tracker consumes; kept with its learn-frame so a consumer can see the detection lag.
   */
  analyserBoundaries: Array<{ beat: number; seenFrame: number }>
  meta: {
    /** `EmotionDimensionEstimator` + `CharacterClassifier` were stepped per frame (character columns are real). */
    characterStepped: boolean
    /** The engine's second, breakdown->dip->snap-back drop path was stepped (`f.drop` matches the live engine). */
    dropStateMachine: boolean
    /** Free-form label (track id). */
    id?: string
  }
}

function makeArray(type: ColType, n: number): NumArray {
  switch (type) {
    case 'u8':
      return new Uint8Array(n)
    case 'i8':
      return new Int8Array(n)
    case 'u16':
      return new Uint16Array(n)
    case 'i16':
      return new Int16Array(n)
    case 'i32':
      return new Int32Array(n)
  }
}

function makeEnums(): CadenceTrace['enums'] {
  return {
    sections: ['', ...SECTION_STATES],
    moods: [...MOOD_STATES],
    chars: [...CHARACTER_MOODS],
    labels: [''],
  }
}

/**
 * A blank trace of `n` frames (all zeros / no events, `structureValid` false, `charPrimary` -1). For hand-built
 * traces in tests and synthetic-stimulus experiments: set the columns you care about.
 */
export function createEmptyTrace(n: number, frameRate = 60): CadenceTrace {
  const cols = {} as Record<ColName, NumArray>
  for (const name of COLUMN_NAMES) cols[name] = makeArray(SPEC[name], n)
  cols.charPrimary.fill(-1)
  return {
    version: CADENCE_TRACE_VERSION,
    frameRate,
    n,
    sampleRate: 0,
    durationSec: n / frameRate,
    cols,
    enums: makeEnums(),
    analyserBoundaries: [],
    meta: { characterStepped: false, dropStateMachine: false },
  }
}

const b = (v: boolean): number => (v ? 1 : 0)
const q8 = (v: number): number => (Number.isFinite(v) ? Math.max(0, Math.min(Q8, Math.round(v * Q8))) : 0)
const q10 = (v: number): number => {
  const x = Number.isFinite(v) ? Math.round(v * Q10) : -Q10
  return Math.max(-32768, Math.min(32767, x))
}

/**
 * Fills a trace one frame at a time. `runTrack` calls `push(i, f)` at the end of each frame (the same point
 * `AudioEngine.update()` finishes: after `sectionTracker.update`) and `noteBoundaries` for every `StructureRaw`.
 */
export class CadenceTraceBuilder {
  private readonly trace: CadenceTrace
  private pushed = 0

  constructor(
    capacity: number,
    frameRate: number,
    sampleRate: number,
    durationSec: number,
    meta: Partial<CadenceTrace['meta']> = {},
  ) {
    this.trace = createEmptyTrace(capacity, frameRate)
    this.trace.sampleRate = sampleRate
    this.trace.durationSec = durationSec
    this.trace.meta = { characterStepped: false, dropStateMachine: false, ...meta }
  }

  push(i: number, f: AudioFeatures): void {
    const c = this.trace.cols
    const ss = f.songSection
    const e = this.trace.enums
    c.silence[i] = b(f.silence)
    c.beat[i] = b(f.beat)
    c.beatIndex[i] = f.beatIndex
    c.beatInBar[i] = Math.max(0, Math.min(255, Math.floor(f.beatInBar)))
    c.bar[i] = f.bar
    c.bpm10[i] = Math.max(0, Math.min(65535, Math.round(f.bpm * 10)))
    c.confidence[i] = q8(f.confidence)
    c.downbeatLocked[i] = b(f.downbeatLocked)
    c.energy[i] = q8(f.energy)
    c.loudness[i] = q8(f.loudness)
    c.sectionChange[i] = b(f.sectionChange)
    c.sectionChangeStrength[i] = Math.max(0, Math.min(255, Math.round(f.sectionChangeStrength * STRENGTH_SCALE)))
    c.drop[i] = b(f.drop)
    c.buildUp[i] = b(f.buildUp)
    c.structureValid[i] = b(f.structureValid)
    c.boundaryChanged[i] = b(ss.boundaryChanged)
    c.section[i] = Math.max(0, e.sections.indexOf(ss.section))
    c.previousSection[i] = Math.max(0, e.sections.indexOf(ss.previousSection))
    c.sectionConfidence[i] = q8(ss.sectionConfidence)
    c.beatsInSection[i] = Math.max(0, Math.min(65535, Math.round(ss.beatsInSection)))
    c.changeCount[i] = Math.max(0, Math.min(65535, ss.changeCount))
    c.isBuild[i] = b(ss.isBuild)
    c.isSustain[i] = b(ss.isSustain)
    c.isBreakdown[i] = b(ss.isBreakdown)
    c.isDrop[i] = b(ss.isDrop)
    c.beatsTillDrop10[i] = q10(ss.beatsTillDrop)
    c.buildProgress[i] = q8(ss.buildProgress)
    let li = ss.repetitionLabel === '' ? 0 : e.labels.indexOf(ss.repetitionLabel)
    if (li < 0) {
      if (e.labels.length < 255) {
        e.labels.push(ss.repetitionLabel)
        li = e.labels.length - 1
      } else li = 0
    }
    c.repetitionLabel[i] = li
    c.moodState[i] = Math.max(0, e.moods.indexOf(f.mood.state))
    c.predictedState[i] = Math.max(0, e.moods.indexOf(f.mood.predictedState))
    c.moodChanged[i] = b(f.mood.changed)
    c.moodChangeCount[i] = Math.max(0, Math.min(65535, f.mood.changeCount))
    c.moodConfidence[i] = q8(f.mood.confidence)
    c.moodAmbiguity[i] = q8(f.mood.ambiguity)
    c.beatsTillTransition10[i] = q10(f.mood.beatsTillTransition)
    const ch = f.character
    c.charPrimary[i] = this.trace.meta.characterStepped && ch.valid && ch.primary !== null ? e.chars.indexOf(ch.primary) : -1
    this.pushed = i + 1
  }

  /** Record the boundaries a `StructureRaw` carried at frame `i` (new ones only, +-2 beats dedupe). */
  noteBoundaries(i: number, boundaries: readonly number[]): void {
    const list = this.trace.analyserBoundaries
    for (const bt of boundaries) {
      if (!Number.isFinite(bt)) continue
      if (list.some((x) => Math.abs(x.beat - bt) <= 2)) continue
      list.push({ beat: bt, seenFrame: i })
    }
  }

  finish(): CadenceTrace {
    const t = this.trace
    if (this.pushed < t.n) {
      for (const name of COLUMN_NAMES) t.cols[name] = t.cols[name].slice(0, this.pushed) as NumArray
      t.n = this.pushed
    }
    t.analyserBoundaries.sort((a, z) => a.beat - z.beat)
    return t
  }
}

// --- JSON cache ------------------------------------------------------------------------------------------------

interface PackedColumn {
  type: ColType
  n: number
  /** Run-length encoded: `[value, count, value, count, ...]`. Present when it beats base64. */
  rle?: number[]
  /** Base64 of the raw little-endian bytes. Present otherwise. */
  b64?: string
}

export interface PackedTrace {
  version: number
  frameRate: number
  n: number
  sampleRate: number
  durationSec: number
  enums: CadenceTrace['enums']
  analyserBoundaries: CadenceTrace['analyserBoundaries']
  meta: CadenceTrace['meta']
  cols: Record<string, PackedColumn>
}

function toBase64(bytes: Uint8Array): string {
  let s = ''
  const CH = 0x8000
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode(...bytes.subarray(i, i + CH))
  return btoa(s)
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

function runsOf(a: NumArray): number {
  let r = a.length ? 1 : 0
  for (let i = 1; i < a.length; i++) if (a[i] !== a[i - 1]) r++
  return r
}

function packColumn(type: ColType, a: NumArray): PackedColumn {
  const runs = runsOf(a)
  // A run costs ~8 JSON chars; base64 costs ~1.33 chars per raw byte.
  if (runs * 8 < a.byteLength * 1.33) {
    const rle: number[] = []
    let i = 0
    while (i < a.length) {
      let j = i + 1
      while (j < a.length && a[j] === a[i]) j++
      rle.push(a[i], j - i)
      i = j
    }
    return { type, n: a.length, rle }
  }
  return { type, n: a.length, b64: toBase64(new Uint8Array(a.buffer, a.byteOffset, a.byteLength)) }
}

function unpackColumn(p: PackedColumn): NumArray {
  const out = makeArray(p.type, p.n)
  if (p.rle) {
    let k = 0
    for (let r = 0; r + 1 < p.rle.length; r += 2) {
      const v = p.rle[r]
      const count = p.rle[r + 1]
      for (let j = 0; j < count; j++) out[k++] = v
    }
    return out
  }
  const bytes = fromBase64(p.b64 ?? '')
  const view = new Uint8Array(out.buffer, out.byteOffset, out.byteLength)
  view.set(bytes.subarray(0, view.length))
  return out
}

export function packTrace(t: CadenceTrace): PackedTrace {
  const cols: Record<string, PackedColumn> = {}
  for (const name of COLUMN_NAMES) cols[name] = packColumn(SPEC[name], t.cols[name])
  return {
    version: t.version,
    frameRate: t.frameRate,
    n: t.n,
    sampleRate: t.sampleRate,
    durationSec: t.durationSec,
    enums: t.enums,
    analyserBoundaries: t.analyserBoundaries,
    meta: t.meta,
    cols,
  }
}

/** Rebuild a trace from its packed form. Throws on a version mismatch (a stale cache must be re-generated). */
export function unpackTrace(p: PackedTrace): CadenceTrace {
  if (p.version !== CADENCE_TRACE_VERSION) {
    throw new Error(`cadence trace version ${p.version} != ${CADENCE_TRACE_VERSION}: regenerate the cache`)
  }
  const cols = {} as Record<ColName, NumArray>
  for (const name of COLUMN_NAMES) {
    const pc = p.cols[name]
    if (!pc) throw new Error(`cadence trace is missing column ${name}: regenerate the cache`)
    cols[name] = unpackColumn(pc)
  }
  return {
    version: p.version,
    frameRate: p.frameRate,
    n: p.n,
    sampleRate: p.sampleRate,
    durationSec: p.durationSec,
    cols,
    enums: p.enums,
    analyserBoundaries: p.analyserBoundaries,
    meta: p.meta,
  }
}
