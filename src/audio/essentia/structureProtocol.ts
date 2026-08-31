/**
 * Message contract between `StructureBridge` (main thread) and
 * `structure.worker.ts`, plus the shared `StructureRaw` payload that
 * `SectionTracker` consumes without importing the worker.
 *
 * Deliberately separate from `protocol.ts` / `voiceProtocol.ts` — this analyzer
 * is a single output family (a segmentation + a build read), so it follows the
 * `voiceProtocol.ts` single-family shape, not the multi-job essentia one.
 */
import type { SongSection } from '../types'

export interface StructureRequest {
  id: number
  /** Mono PCM at the capture rate, transferred; the worker resamples. */
  pcm: Float32Array
  sampleRate: number
  /** Current tempo — the worker folds features into beat cells with this. */
  bpm: number
  /** Integer `beatIndex` at the NEWEST sample of `pcm`, so the worker can
   * report boundaries as absolute engine-grid beat indices. */
  endBeatIndex: number
  /** 0..1 fractional position within `endBeatIndex` at the newest sample. */
  endBeatProgress: number
}

/** One analyzed segment between two boundaries. */
export interface StructureSegment {
  /** Absolute engine-grid beat indices. */
  startBeat: number
  endBeat: number
  /** The analyzer's coarse guess. `'section'` = boundary real, function unknown. */
  kind: SongSection
  /** A/B/C… — same letter = feature-profile match with an earlier segment. */
  repetitionLabel: string
  /** Mean normalized energy over the segment, 0..1 — feeds breakdown/drop logic. */
  meanEnergy: number
  /** Mean spectral flatness, 0..1 — a breakdown is tonal-and-quiet. */
  meanFlatness: number
}

/** The riser / build-up read (the worker reports numbers; `SectionTracker`
 * owns the latch/release). */
export interface StructureBuild {
  active: boolean
  /** 0..1 riser confidence (weighted acoustic slopes). */
  score: number
  /** 0..1, monotone-up while active. */
  progress: number
  /** Estimated beats from the analysis-window end to the drop; -1 when inactive. */
  beatsTillDrop: number
  /** Absolute beat index the build started on; -1 when inactive. */
  startBeat: number
}

/** The async payload `SectionTracker.update(f, raw)` consumes. `raw` is
 * usually null (a new one only arrives every ~15 s). */
export interface StructureRaw {
  /** `beatIndex` the analysis window ended on (analyzer clock). */
  atBeat: number
  /** Fused per-beat-cell novelty over the analyzed window, 0..1. */
  novelty: number[]
  /** Detected boundaries as absolute engine-grid beat indices. */
  boundaries: number[]
  segments: StructureSegment[]
  build: StructureBuild
  /** Worker wall-clock in ms — drives the bridge cadence backoff. */
  costMs: number
}

export interface StructureResult extends StructureRaw {
  id: number
  type: 'structure'
}

export interface StructureError {
  id: number
  type: 'error'
  message: string
  /** essentia WASM / worker construction failed — permanent for the session. */
  missing: boolean
}

export type StructureResponse = StructureResult | StructureError

/** Neutral value for "no read yet" — `SectionTracker` treats this as null. */
export function emptyStructureRaw(): StructureRaw {
  return {
    atBeat: -1,
    novelty: [],
    boundaries: [],
    segments: [],
    build: { active: false, score: 0, progress: 0, beatsTillDrop: -1, startBeat: -1 },
    costMs: 0,
  }
}
