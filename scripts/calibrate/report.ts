/**
 * Pure aggregation over per-frame samples, for the calibration harness. NOT
 * shipped. Unit-tested in `report.test.calib.ts` with synthetic frames.
 */
import {
  MOOD_CHANGE_MAX_AMBIGUITY,
  MOOD_CHANGE_MIN_CONFIDENCE,
} from '../../src/engine/autoPilotGates'
import type { FrameSample } from './features'

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN
  const idx = (sorted.length - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

export function percentileTable(values: number[], ps = [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95]) {
  const sorted = [...values].sort((a, b) => a - b)
  const out: Record<string, number> = {}
  for (const p of ps) out[`p${Math.round(p * 100)}`] = round(percentile(sorted, p), 4)
  out.mean = round(values.reduce((a, b) => a + b, 0) / (values.length || 1), 4)
  out.n = values.length
  return out
}

const round = (v: number, d = 4) => {
  const m = 10 ** d
  return Math.round(v * m) / m
}

/**
 * Octave-flip count: transitions where consecutive non-silent BPM readings
 * cross a ±`tol` band around their own rolling median (the pathology is the
 * reading jumping ~2x, not slow drift). If `referenceBpm` is given, count
 * frames sitting closer to `0.5·ref` or `2·ref` than to `ref` instead.
 */
export function octaveStats(
  frames: FrameSample[],
  referenceBpm?: number,
  tol = 0.35,
): { flips: number; halfTempoSampleShare: number; doubleTempoSampleShare: number } {
  const live = frames.filter((f) => !f.silence && f.bpm > 0)
  if (live.length < 4) return { flips: 0, halfTempoSampleShare: 0, doubleTempoSampleShare: 0 }

  let half = 0
  let dbl = 0
  if (referenceBpm && referenceBpm > 0) {
    for (const f of live) {
      const dRef = Math.abs(f.bpm - referenceBpm)
      const dHalf = Math.abs(f.bpm - referenceBpm / 2)
      const dDouble = Math.abs(f.bpm - referenceBpm * 2)
      if (dHalf < dRef && dHalf <= dDouble) half++
      else if (dDouble < dRef) dbl++
    }
  }

  // Rolling-median crossing count.
  const win = 30
  let flips = 0
  let prevSide = 0
  for (let i = 0; i < live.length; i++) {
    const from = Math.max(0, i - win)
    const slice = live
      .slice(from, i + 1)
      .map((f) => f.bpm)
      .sort((a, b) => a - b)
    const med = percentile(slice, 0.5)
    const side = live[i].bpm > med * (1 + tol) ? 1 : live[i].bpm < med * (1 - tol) ? -1 : 0
    if (side !== 0 && prevSide !== 0 && side !== prevSide) flips++
    if (side !== 0) prevSide = side
  }

  return {
    flips,
    halfTempoSampleShare: round(half / live.length, 4),
    doubleTempoSampleShare: round(dbl / live.length, 4),
  }
}

export function secondsPerMood(frames: FrameSample[], frameRate: number): Record<string, number> {
  const dt = 1 / frameRate
  const raw: Record<string, number> = {}
  for (const f of frames) raw[f.moodState] = (raw[f.moodState] ?? 0) + dt
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(raw)) out[k] = round(v, 1)
  return out
}

export function moodQuality(frames: FrameSample[]) {
  const nonSilent = frames.filter((f) => !f.silence)
  if (nonSilent.length === 0) return null
  const conf = nonSilent.map((f) => f.moodConfidence)
  const amb = nonSilent.map((f) => f.moodAmbiguity)
  const gatePass = nonSilent.filter(
    (f) =>
      f.moodConfidence >= MOOD_CHANGE_MIN_CONFIDENCE &&
      f.moodAmbiguity <= MOOD_CHANGE_MAX_AMBIGUITY,
  ).length
  return {
    confidence: percentileTable(conf, [0.5, 0.9, 0.95]),
    confidenceMax: round(Math.max(...conf)),
    ambiguityMean: round(amb.reduce((a, b) => a + b, 0) / amb.length),
    gatePassShare: round(gatePass / nonSilent.length, 4),
    commitCount: nonSilent.filter((f) => f.moodChanged).length,
  }
}

/** Cross-track distributions the estimator constants are calibrated against. */
export function distributions(allFrames: FrameSample[]) {
  const live = allFrames.filter((f) => !f.silence)
  return {
    n: live.length,
    moodLevel: percentileTable(live.map((f) => f.moodLevel)),
    energy: percentileTable(live.map((f) => f.energy)),
    sub: percentileTable(live.map((f) => f.sub)),
    bass: percentileTable(live.map((f) => f.bass)),
    high: percentileTable(live.map((f) => f.high)),
    centroid: percentileTable(live.map((f) => f.centroid)),
    spectralFlatness: percentileTable(live.map((f) => f.spectralFlatness)),
    spectralRolloff: percentileTable(live.map((f) => f.spectralRolloff)),
    // `sparkle` (16 kHz+) is expected to sit near the floor on this corpus —
    // it is 96 kbps MP3, brick-walled around 15.5 kHz. Recorded anyway so the
    // limitation is visible rather than assumed.
    sparkle: percentileTable(live.map((f) => f.sparkle)),
    crestFactor: percentileTable(live.map((f) => f.crestFactor)),
    energyVelAbs: percentileTable(live.map((f) => Math.abs(f.energyVel))),
  }
}
