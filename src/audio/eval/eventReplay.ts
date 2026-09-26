/**
 * Offline replay and scoring of the LIVE EVENT LAYER (`src/audio/events`), for the calibration scripts and the tests.
 *
 * `replayCells` re-runs an `EventLayer` over recorded beat cells (what `runTrack({ events: true })` captured), so a
 * tuning sweep costs milliseconds instead of a full DSP replay. `scoreEventStream` scores an event stream against the
 * known truth of a synthetic song with the same conventions as `synth-structure.calib.ts`: a change is a HIT when the
 * event's CLAIMED boundary time is within +-1 bar of the truth (one-to-one), lag is `detectedAt - truth` for matches
 * inside the causal window [-1, +4] bars, and a detection near a NEGATIVE truth event (a fill, a gain step, a silence
 * gap, a gradual-morph step) counts as a mistake.
 *
 * Only `change` and `breakdown` events are scene-class (what the show director can cut on); `fill` and `gain` are
 * reported separately (they are expected near their negatives and are weight 0 downstream).
 */
import type { BeatCell } from '../essentia/structureDsp'
import { EventLayer, type EventLayerConfig } from '../events/EventLayer'
import type { EventType, SectionEvent } from '../events/types'
import { barsToSec, detectionsNearEvents, matchEvents, percentile } from './structureMetrics'
import type { TruthEvent } from './synthSong'

/** One beat cell as the event layer received it. */
export interface EventCellRecord {
  cell: BeatCell
  beat: number
  time: number
  bpm: number
  locked: boolean
  offset: number
}

/** Deep-copy an event out of the layer's reused ring. */
export function copyEvent(e: SectionEvent): SectionEvent {
  return { ...e, feats: { ...e.feats }, ...(e.sim ? { sim: { ...e.sim } } : {}) }
}

/** Re-run a fresh `EventLayer` over `cells` and return copies of every event it delivered. */
export function replayCells(cells: readonly EventCellRecord[], cfg: Partial<EventLayerConfig> = {}): SectionEvent[] {
  const layer = new EventLayer(cfg)
  const out: SectionEvent[] = []
  for (const r of cells) for (const e of layer.push(r.cell, r.beat, r.time, r.bpm, { locked: r.locked, offset: r.offset })) out.push(copyEvent(e))
  return out
}

export const SCENE_CLASS: readonly EventType[] = ['change', 'breakdown']

export interface StreamScore {
  nTruth: number
  nDet: number
  hits: number
  /** Matched within the causal window [-1, +4] bars of the DETECTED time. */
  hitsCausal: number
  /** Unmatched scene-class detections (a second detection of a matched change is a false alarm). */
  falseAlarms: number
  /** Scene-class events near negative truth events (window [-0.5, +2.5] bars), and the negatives there were. */
  negNear: number
  negTotal: number
  /** Per positive: was it a hit (claimed +-1 bar), and the causal lag if matched. */
  perEvent: Array<{ type: string; timeSec: number; bar: number; hit: boolean; hitCausal: boolean; lagSec: number | null; posErrSec: number | null }>
  lags: number[]
  detTimes: number[]
  claimTimes: number[]
  fills: number
  gains: number
}

/**
 * Score scene-class events of `events` against `truth` (positive truth = `shouldTrigger`). `only` restricts which
 * positives count (e.g. to drop the gradual morph's end).
 */
export function scoreEventStream(
  truth: readonly TruthEvent[],
  events: readonly SectionEvent[],
  bpm: number,
  opts: { minDetSec?: number; excludeNotes?: readonly string[] } = {},
): StreamScore {
  const minDet = opts.minDetSec ?? 1
  const scene = events.filter((e) => SCENE_CLASS.includes(e.type) && e.detectedAtTime >= minDet)
  const claims = scene.map((e) => e.boundaryTime)
  const ats = scene.map((e) => e.detectedAtTime)
  const strict = barsToSec(1, bpm)
  const causal = { before: strict, after: barsToSec(4, bpm) }
  const negWin = { before: barsToSec(0.5, bpm), after: barsToSec(2.5, bpm) }
  const posAll = truth.filter((t) => t.shouldTrigger)
  const pos = posAll.filter((t) => !(opts.excludeNotes ?? []).some((n) => (t.note ?? '').includes(n)))
  const neg = truth.filter((t) => !t.shouldTrigger).map((t) => t.timeSec)
  const P = pos.map((t) => t.timeSec)
  const mS = matchEvents(P, claims, strict)
  const mC = matchEvents(P, ats, causal)
  const faS = claims.length - matchEvents(posAll.map((t) => t.timeSec), claims, strict).pairs.length
  return {
    nTruth: pos.length,
    nDet: scene.length,
    hits: mS.pairs.length,
    hitsCausal: mC.pairs.length,
    falseAlarms: faS,
    negNear: detectionsNearEvents(neg, ats, negWin),
    negTotal: neg.length,
    perEvent: pos.map((t, i) => {
      const ps = mS.pairs.find((p) => p.truthIndex === i)
      const pc = mC.pairs.find((p) => p.truthIndex === i)
      return {
        type: t.type,
        timeSec: t.timeSec,
        bar: t.bar,
        hit: !!ps,
        hitCausal: !!pc,
        lagSec: pc ? pc.lag : null,
        posErrSec: ps ? ps.lag : null,
      }
    }),
    lags: mC.pairs.map((p) => p.lag),
    detTimes: ats,
    claimTimes: claims,
    fills: events.filter((e) => e.type === 'fill').length,
    gains: events.filter((e) => e.type === 'gain').length,
  }
}

/** Median of the pooled lags (NaN when none). */
export function medianLag(scores: readonly StreamScore[]): number {
  const l = scores.flatMap((s) => s.lags)
  return l.length ? percentile(l, 0.5) : NaN
}
