import type { BeatCell } from '../../essentia/structureDsp'
import { RAW_CHANNELS } from '../rawTap'

/**
 * Synthetic BEAT CELLS for the event-layer tests: a section is a spec (level, band tilts, a mel shape, a chroma
 * profile, rhythm density), a cell is that spec plus a small deterministic jitter, so a stream of cells behaves like the
 * analyser's output for a song of known structure, with no audio and no DSP.
 */

export interface SectionSpec {
  /** RMS in dB (raw tap scale). */
  levelDb: number
  /** Band levels relative to the RMS, dB (the tilts the scorer sees). */
  lowTilt: number
  midTilt: number
  highTilt: number
  /** Shape of the 13 mel band sums (before the gain): `mfcc_i = log1p(gain * mel_i)`. */
  mel: readonly number[]
  /** 12-bin chroma profile (any scale; the cell carries it L2-normalised). */
  chroma: readonly number[]
  onset: number
  flatness: number
  centroid: number
}

const rampMel = (slope: number): number[] => Array.from({ length: 13 }, (_, i) => 0.02 * Math.exp(slope * (i / 12) * 4))

export const CHROMA_C = [1, 0.1, 0.3, 0.1, 0.6, 0.4, 0.1, 0.8, 0.1, 0.3, 0.1, 0.2]
export const CHROMA_D = [0.1, 0.3, 1, 0.1, 0.3, 0.1, 0.6, 0.4, 0.1, 0.8, 0.1, 0.3]

/** A dark, sparse verse. */
export const VERSE: SectionSpec = {
  levelDb: -22,
  lowTilt: -3,
  midTilt: -9,
  highTilt: -26,
  mel: rampMel(-0.6),
  chroma: CHROMA_C,
  onset: 0.25,
  flatness: 0.2,
  centroid: 0.3,
}
/** A bright chorus at the SAME level with a different timbre and harmony. */
export const CHORUS: SectionSpec = {
  ...VERSE,
  lowTilt: -5,
  midTilt: -6,
  highTilt: -18,
  mel: rampMel(0.3),
  chroma: CHROMA_D,
  onset: 0.5,
  flatness: 0.35,
  centroid: 0.5,
}

export function mulberry(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface CellOptions {
  /** Added to every raw dB channel (a volume knob). */
  gainDb?: number
  /** Extra onset density / high-band tilt for this beat only (a fill). */
  onsetBoost?: number
  highBoostDb?: number
  /** Jitter magnitude (default 1: ~0.15 dB, ~1% on shapes). */
  jitter?: number
  silent?: number
}

/** One beat cell of `spec` (beat index `beat`), with deterministic jitter from `rnd`. */
export function makeCell(spec: SectionSpec, beat: number, rnd: () => number, o: CellOptions = {}): BeatCell {
  const j = o.jitter ?? 1
  const n = () => (rnd() - 0.5) * j
  const rms = spec.levelDb + (o.gainDb ?? 0) + 0.3 * n()
  const low = rms + spec.lowTilt + 0.3 * n()
  const mid = rms + spec.midTilt + 0.3 * n()
  const high = rms + spec.highTilt + (o.highBoostDb ?? 0) + 0.3 * n()
  const raw = new Array<number>(RAW_CHANNELS)
  raw[0] = low
  raw[1] = low
  raw[2] = mid
  raw[3] = mid
  raw[4] = high
  raw[5] = high
  raw[6] = rms
  const gain = 10 ** ((spec.levelDb + (o.gainDb ?? 0)) / 20) * 8
  const mfcc = spec.mel.map((m) => Math.log1p(gain * m * (1 + 0.02 * n())))
  const chroma = spec.chroma.map((c) => Math.max(0, c * (1 + 0.04 * n())))
  const norm = Math.sqrt(chroma.reduce((s, x) => s + x * x, 0)) || 1
  return {
    beat,
    hpcp: chroma.map((c) => c / norm),
    mfcc,
    logRms: 0.5,
    centroid: spec.centroid + 0.01 * n(),
    flux: 0.3,
    flatness: spec.flatness + 0.01 * n(),
    air: 0.2,
    sub: 0.3,
    bass: 0.3,
    mid: 0.3,
    high: 0.2,
    onsetDensity: Math.min(1, Math.max(0, spec.onset + (o.onsetBoost ?? 0) + 0.02 * n())),
    raw,
    silent: o.silent ?? 0,
  }
}

/**
 * The analyser's chroma is a 2 s-tau EMA (`FAST_CHROMA_TAU_SEC`), so it TRAILS a harmonic change by a few beats: apply
 * the same one-pole smoothing (per beat) to a stream of raw cells, in place, and return it.
 */
export function smoothChroma(cells: BeatCell[], alpha = 0.22): BeatCell[] {
  let prev: number[] | null = null
  for (const c of cells) {
    const src = c.hpcp
    const y: number[] = prev === null ? src.slice() : src.map((x, i) => (1 - alpha) * (prev as number[])[i] + alpha * x)
    const norm = Math.sqrt(y.reduce((s, v) => s + v * v, 0)) || 1
    prev = y.map((v) => v / norm)
    c.hpcp = prev.slice()
  }
  return cells
}

/** Sections as `[spec, beats]` pairs; returns the cells (beat index from `startBeat`) and each section's start beat. */
export function buildStream(
  sections: ReadonlyArray<readonly [SectionSpec, number]>,
  seed = 1,
  startBeat = 1,
): { cells: BeatCell[]; starts: number[] } {
  const rnd = mulberry(seed)
  const cells: BeatCell[] = []
  const starts: number[] = []
  let beat = startBeat
  for (const [spec, len] of sections) {
    starts.push(beat - 1) // the boundary is the crossing BEFORE the first new cell
    for (let i = 0; i < len; i++) cells.push(makeCell(spec, beat++, rnd))
  }
  return { cells: smoothChroma(cells), starts }
}
