/**
 * How far AHEAD of the analysis clock the published beat grid runs, in seconds.
 *
 * `BpmEstimator` phase-locks its grid to onset TIMESTAMPS, and an onset is only detected after its audio has
 * passed through the 2048-sample FFT window (46 ms at 44.1 kHz) and the flux threshold, so every onset is stamped
 * late by the detector's latency. The grid therefore sits on the DETECTION time of each kick, not on the kick:
 * measured on synthetic drums with known kick times (`scripts/calibrate/beat-latency.calib.ts`, 60 fps, 7 tempi
 * 80-170 BPM, hard and soft kicks), the onset the grid is fed is a median 23 ms late (16-33 ms) and the published
 * `f.beat` a median 42 ms late (33-50 ms): the detector lag plus up to one 60 Hz frame of quantisation, before
 * the frame is even drawn.
 *
 * The grid is PREDICTIVE (a free-running phase + k * period), so unlike a band envelope it can be published early:
 * `advanceGrid` reads the grid at `now + lead`, which moves every beat crossing, `beatProgress` and the pulse that
 * hangs off it earlier by `lead`. 40 ms cancels the measured median lag (the residual is then within one frame).
 * It deliberately does NOT try to also cancel display and speaker latency, which depend on the user's machine and
 * output device and cannot be measured from inside the page: that is what `?beatoffset=<ms>` is for.
 *
 *  - `?beatoffset=<ms>`  ADDS to the built-in lead. Positive = visuals earlier (raise it when they feel late, e.g.
 *    with a laggy Bluetooth output the analyser hears BEFORE the sound comes out), negative = later. Clamped to
 *    [-150, +200] ms; the total lead is clamped to [-100, +200] ms. Absent or not a finite number: 0.
 *
 * Every reader takes an injectable search string and falls back safely with no `location`, like
 * `structureFlags.ts` / `engine/look/lookFlags.ts`.
 */

/** Built-in lead (s): the measured median lag of the published beat behind the true kick. */
export const BEAT_LEAD_SEC = 0.04
export const BEAT_OFFSET_MIN_MS = -150
export const BEAT_OFFSET_MAX_MS = 200
export const BEAT_LEAD_MIN_SEC = -0.1
export const BEAT_LEAD_MAX_SEC = 0.2

function readSearch(search?: string): string {
  if (search !== undefined) return search
  try {
    return typeof location === 'undefined' ? '' : location.search
  } catch {
    return ''
  }
}

/** `?beatoffset=<ms>`: the user's nudge, clamped; 0 when absent, empty or not a finite number. */
export function beatOffsetMs(search?: string): number {
  let raw: string | null
  try {
    raw = new URLSearchParams(readSearch(search)).get('beatoffset')
  } catch {
    return 0
  }
  if (raw === null || raw.trim() === '') return 0
  const v = Number(raw)
  if (!Number.isFinite(v)) return 0
  return Math.min(BEAT_OFFSET_MAX_MS, Math.max(BEAT_OFFSET_MIN_MS, v))
}

/** The total lead (s) `advanceGrid` applies: the built-in lead plus the user's nudge, clamped to a safe range. */
export function beatLeadSec(search?: string): number {
  const lead = BEAT_LEAD_SEC + beatOffsetMs(search) / 1000
  return Math.min(BEAT_LEAD_MAX_SEC, Math.max(BEAT_LEAD_MIN_SEC, lead))
}
