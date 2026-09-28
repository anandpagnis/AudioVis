/**
 * Replay a `?structurelog` export through the LIVE EVENT LAYER without the song's audio.
 *
 * The recorder (`engine/structureLog.ts`, `noteCell`) stores, per beat, the quantised feature cell the event layer
 * consumed (`StructureAnalyzer.onCell`), so a song that came from Spotify / YouTube system capture (no file to run
 * `runTrack` on) can still be used to tune the detector: the log's `cells` are turned back into the exact input of
 * `eventReplay.replayCells`, and the events it yields are compared with the human marks
 * (`structureLogToTruth`: `sceneMarks` for CUT, `smallMarks` for MICRO).
 *
 * ```ts
 * const cells = logToCellRecords(fs.readFileSync('structurelog-song.json', 'utf8'))
 * const events = replayCells(cells, { ...candidateConfig })          // from './eventReplay'
 * // or in one step: replayLogEvents(text, cfg)
 * ```
 *
 * Fidelity: values are rounded to 4 significant digits (about 0.01 dB on the raw levels), so a replay matches a replay of
 * the un-quantised cells except where a score sits within that rounding of a threshold. A log with no `cells` (an older
 * one, or one recorded while the sink was not wired) returns `[]`.
 */
import type { BeatCell } from '../essentia/structureDsp'
import type { SectionEvent } from '../events/types'
import { CELL_CHROMA_N, CELL_MEL_N, CELL_RAW_N, type StructureLogCell } from '../../engine/structureLog'
import type { EventLayerConfig } from '../events/EventLayer'
import { replayCells, type EventCellRecord } from './eventReplay'
import { parseStructureLog } from './structureLogToTruth'

/** One recorded cell back as the `BeatCell` the analyser folded (the fields the event layer reads; the rest are 0). */
export function logCellToBeatCell(rec: StructureLogCell): BeatCell {
  const v = rec.cell
  let k = 0
  const raw = v.slice(k, (k += CELL_RAW_N))
  const mfcc = v.slice(k, (k += CELL_MEL_N))
  const hpcp = v.slice(k, (k += CELL_CHROMA_N))
  const onsetDensity = v[k++]
  const flatness = v[k++]
  const centroid = v[k++]
  const silent = v[k]
  const fb = rec.fb
  const cell: BeatCell = {
    beat: rec.beat,
    hpcp,
    mfcc,
    logRms: fb ? fb[0] : 0,
    centroid,
    flux: 0,
    flatness,
    air: fb ? fb[5] : 0,
    sub: fb ? fb[1] : 0,
    bass: fb ? fb[2] : 0,
    mid: fb ? fb[3] : 0,
    high: fb ? fb[4] : 0,
    onsetDensity,
    silent,
  }
  if (!fb) cell.raw = raw
  return cell
}

/** The log's `cells` as `replayCells` input (time order). `input` is the JSON text or a parsed log. */
export function logToCellRecords(input: unknown): EventCellRecord[] {
  const log = parseStructureLog(input)
  return (log.cells ?? []).map((c) => ({
    cell: logCellToBeatCell(c),
    beat: c.beat,
    time: c.t,
    bpm: c.bpm,
    locked: c.locked,
    offset: c.offset,
  }))
}

/** Convenience: replay a fresh `EventLayer` (optionally with a candidate config) over the log's cells. */
export function replayLogEvents(input: unknown, cfg: Partial<EventLayerConfig> = {}): SectionEvent[] {
  return replayCells(logToCellRecords(input), cfg)
}
