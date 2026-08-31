/**
 * Message contract between AudioEngine's EssentiaBridge (main thread) and the
 * essentia worker. One request type per feature family; every request carries
 * a transferred mono PCM window at the capture sample rate — the worker owns
 * resampling to whatever rate the Essentia algorithm assumes.
 *
 * The worker is single-threaded, so jobs are serialized by the bridge: rhythm
 * has priority (it drives the beat grid), key/danceability fill idle slots.
 */

/**
 * `rhythm` is the fast beat-grid source (degara, ~190 ms, no confidence).
 * `rhythm-hq` is an occasional second opinion (multifeature, ~950 ms, carries a
 * 0..1 confidence) whose main job is octave arbitration — degara does no octave
 * folding, so it can hand back a clean-looking half-tempo read (F121).
 */
export type EssentiaJobType = 'rhythm' | 'rhythm-hq' | 'key' | 'danceability'

interface BaseRequest {
  id: number
  /** Mono PCM, transferred (zero-copy). The buffer is consumed by the worker. */
  pcm: Float32Array
  /** Native capture rate of `pcm`; worker resamples to 44.1 kHz internally. */
  sampleRate: number
}

export interface RhythmRequest extends BaseRequest {
  type: 'rhythm' | 'rhythm-hq'
}
export interface KeyRequest extends BaseRequest {
  type: 'key'
}
export interface DanceabilityRequest extends BaseRequest {
  type: 'danceability'
}

export type EssentiaRequest = RhythmRequest | KeyRequest | DanceabilityRequest

export type RhythmMethod = 'multifeature' | 'degara'

export interface RhythmResult {
  id: number
  type: 'rhythm'
  bpm: number
  /**
   * Essentia's own BPM-reliability score, normalized to 0..1. Only the
   * multifeature method produces one (raw scale 0..5.32, ≥3.5 = excellent);
   * degara reports 0 and the estimator falls back to its own grid-fit measure.
   */
  confidence01: number
  method: RhythmMethod
  /** Wall-clock analysis time in ms — drives cadence backoff. */
  ms: number
}

export interface KeyResult {
  id: number
  type: 'key'
  /** Tonic as Essentia spells it: 'C', 'C#', 'Db', … */
  key: string
  /** 'major' | 'minor' as reported; passed through unmodified. */
  scale: string
  /** Essentia's `strength` for the winning key profile, 0..1. */
  strength: number
  ms: number
}

export interface DanceabilityResult {
  id: number
  type: 'danceability'
  /** RAW Essentia value. Documented range ~0..3, higher = more danceable.
   * Deliberately un-normalized so real distributions stay observable. */
  danceability: number
  ms: number
}

export interface WorkerError {
  id: number
  type: 'error'
  /** Which job failed, so the bridge can back that one off in isolation. */
  job: EssentiaJobType | 'unknown'
  message: string
}

export type EssentiaResponse = RhythmResult | KeyResult | DanceabilityResult | WorkerError
