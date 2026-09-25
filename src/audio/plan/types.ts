/**
 * Public types of the whole-song (non-causal) analyser. Times are seconds from sample 0 of the analysed PCM; bar
 * and beat indices count from the first tracked beat / first downbeat.
 */
import type { SectionEvent } from '../events/types'

export interface PlanSegment {
  startSec: number
  endSec: number
  /** Bar indices into `SongPlan.bars`: `[startBar, endBar)`. The first segment starts at bar 0. */
  startBar: number
  endBar: number
  /** Repetition label from clustering segment signatures: 'A', 'B', 'A' ... ('A1' after 'Z'). */
  label: string
  /** Index of the earlier segment with the same label (undefined for the first occurrence). */
  repeatOf?: number
  /** Mean broadband level over the segment in dBFS. */
  meanLevelDb: number
}

export interface PlanDiagnostics {
  durationSec: number
  /** Analysis sample rate after decimation, and STFT frame rate (frames per second). */
  analysisSampleRate: number
  fps: number
  nFrames: number
  nBars: number
  /** Tempo estimation: chosen BPM before beat tracking refined it, autocorrelation height, confidence 0..1. */
  tempo: { initialBpm: number; acf: number; confidence: number; candidates: Array<{ bpm: number; score: number; acf: number }> }
  /** Mean onset strength on tracked beats over the mean everywhere (1 = beats sit on no more onset than average). */
  beatOnsetRatio: number
  /** Downbeat: confidence 0..1 of the chosen phase, per-phase scores, and how it was decided. */
  downbeat: { confidence: number; scores: number[]; salienceConfidence: number; structureConfidence: number }
  /** Boundary grid prior: dominant boundary position mod 4 bars and mod 8 bars (or -1 when there is none). */
  grid: { phase4: number; phase8: number; share4: number }
  /** Combined bar-boundary novelty (z-score) per boundary index `i` (between bar i-1 and bar i); index 0 is 0. */
  novelty: number[]
  /** Absolute feature distance across each boundary (dB-equivalent), same indexing. */
  distance: number[]
  /** Broadband level per bar (dBFS). */
  barLevelDb: number[]
  /** Candidate peaks rejected by the absolute-distance floor (uniform gain steps, fills, noise). */
  rejectedByFloor: number
  analysisMs: number
  warnings: string[]
}

export interface SongPlan {
  /** Tempo (BPM) from the tracked beats, in the chosen octave (roughly 60-200; see `diagnostics.tempo`). */
  bpm: number
  /** Beat times in seconds (refined). */
  beats: number[]
  /** Which of `beats[0..3]` is a downbeat: `beats[downbeatPhase + 4k]` are the bar lines. */
  downbeatPhase: number
  /** Bar-line times in seconds: `bars[k] === beats[downbeatPhase + 4 * k]`. */
  bars: number[]
  /** Section events on the bar grid, `source: 'plan'`, in time order. */
  events: SectionEvent[]
  /** Section segments covering the song, in time order. */
  segments: PlanSegment[]
  diagnostics: PlanDiagnostics
}

export interface AnalyzeOptions {
  /** Target analysis sample rate (an integer decimation factor is chosen: 44.1 kHz -> 22.05 kHz). Default 22050. */
  targetSampleRate?: number
  /** Centre / width (octaves) of the tempo prior. Defaults 118 BPM / 0.62. */
  priorBpm?: number
  priorOctaves?: number
  /** Minimum spacing between boundaries in bars. Default 4. */
  minSectionBars?: number
  /** Peak threshold: the combined novelty z-score must reach this. Default 2.5. */
  peakThreshold?: number
  /** Absolute floor on the feature shift across a boundary (dB-equivalent), timbre / rhythm / bass channel. Default 1.6. */
  distanceFloor?: number
  /** The same floor for the harmony (chroma) channel. Default 1.5. */
  harmonyFloor?: number
}
