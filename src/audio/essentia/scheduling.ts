/**
 * The EssentiaBridge job scheduler and result merge, as PURE functions over an
 * injected state struct — no worker, no AudioContext, no AudioFeatures.
 *
 * `EssentiaBridge` keeps all I/O (the Worker, the PCM ring, `busy`, `status`,
 * `copyWindow`, `postMessage`) and calls these with `this.sched`. The single-
 * threaded worker runs exactly one job at a time; `pickJob` is the priority
 * ladder that decides which, `drainResults` folds a completed job's output
 * toward the feature object / BpmEstimator.
 *
 * Split out (issue 16) because the scheduling cadence, the drain merge and the
 * octave-reference selection are the parts most likely to regress silently and
 * were previously untestable — only the "no worker attached" inert path had
 * coverage. See `src/audio/__tests__/essentiaScheduling.test.ts`.
 */
import { reconcileModelBpm } from '../BpmEstimator'
import type {
  DanceabilityResult,
  EssentiaJobType,
  EssentiaResponse,
  KeyResult,
  RhythmResult,
} from './protocol'

/** Floor cadence between fast (degara) rhythm reads, seconds. */
export const RHYTHM_CADENCE_SEC = 2.5
/** How long a worker tempo read stays authoritative in BpmEstimator. */
export const MODEL_FRESH_SEC = 8
/**
 * How often the expensive multifeature second opinion runs. One run blocks the
 * single worker ~950 ms, so it must not crowd the fast degara reads.
 */
export const RHYTHM_HQ_CADENCE_SEC = 20
/** How long a multifeature read stays usable as an octave reference. */
export const RHYTHM_HQ_FRESH_SEC = 26
/**
 * The multifeature ("hq") second opinion does not run until this many fast
 * degara reads have COMPLETED — its job is to arbitrate an already-locked
 * degara octave, so it is useless (and just steals the worker) before the fast
 * grid has had a few rounds. Previously the guard was `lastJobAt >= 0`, which
 * `pickJob`'s own first branch already guarantees is true — dead code that let
 * hq fire as job #2, ~0.2 s into a track (issue 16, Bug A).
 */
export const RHYTHM_HQ_MIN_READS = 2
/** Key is normally section-triggered; this is the no-boundary timer fallback. */
export const KEY_FALLBACK_SEC = 20
/** Floor between section-triggered key reads, so a burst of boundaries can't spam. */
export const KEY_MIN_GAP_SEC = 6
/** Danceability is a slow character read; refresh every few sections' worth. */
export const DANCE_CADENCE_SEC = 8

/** Everything `pickJob` / `applyDispatch` / `ingestResponse` / `drainResults` touch. */
export interface EssentiaSchedState {
  /** Engine-clock time of the last rhythm-FAMILY dispatch (degara or hq). */
  lastJobAt: number
  /** Current floor cadence, grown from degara `ms` (self-throttle). */
  cadence: number
  /** Engine-clock time the last hq job was dispatched. */
  lastHqAt: number
  /** Engine-clock time of the last key dispatch. */
  lastKeyAt: number
  /** Engine-clock time of the last danceability dispatch. */
  lastDanceAt: number
  /** A section boundary landed — escalate the next key read. */
  keyRequested: boolean
  /** Completed degara reads since attach — gates the hq second opinion. */
  rhythmReads: number
  /** Last multifeature BPM, kept as an octave reference for degara reads. 0 while
   * an hq job is in flight (cleared on dispatch) so a stale value can't be
   * labelled "fresh" (issue 16, Bug D). */
  hqBpm: number
  hqConf: number
  /** Completed but not-yet-drained worker results, one slot per family. */
  pending: RhythmResult | null
  pendingKey: KeyResult | null
  pendingDance: DanceabilityResult | null
}

export function makeSchedState(): EssentiaSchedState {
  return {
    lastJobAt: -1,
    cadence: RHYTHM_CADENCE_SEC,
    lastHqAt: -1,
    lastKeyAt: -1,
    lastDanceAt: -1,
    keyRequested: false,
    rhythmReads: 0,
    hqBpm: 0,
    hqConf: 0,
    pending: null,
    pendingKey: null,
    pendingDance: null,
  }
}

/** In-place reset for a new source (mirrors `makeSchedState` defaults). */
export function resetSchedState(s: EssentiaSchedState): void {
  s.lastJobAt = -1
  s.cadence = RHYTHM_CADENCE_SEC
  s.lastHqAt = -1
  s.lastKeyAt = -1
  s.lastDanceAt = -1
  s.keyRequested = false
  s.rhythmReads = 0
  s.hqBpm = 0
  s.hqConf = 0
  s.pending = null
  s.pendingKey = null
  s.pendingDance = null
}

/**
 * Which job is due, rhythm first. Null when nothing is. Pure — reads timers,
 * writes nothing. The class still owns the `!worker / busy / ringFilled /
 * silence` gates and only calls this once they pass.
 */
export function pickJob(s: EssentiaSchedState, now: number): EssentiaJobType | null {
  if (s.lastJobAt < 0 || now - s.lastJobAt >= s.cadence) return 'rhythm'
  // Multifeature second opinion — only once RHYTHM_HQ_MIN_READS fast reads have
  // completed (never as job #1 or #2), then on its own slow cadence.
  if (
    s.rhythmReads >= RHYTHM_HQ_MIN_READS &&
    (s.lastHqAt < 0 || now - s.lastHqAt >= RHYTHM_HQ_CADENCE_SEC)
  ) {
    return 'rhythm-hq'
  }
  const keyDue =
    s.lastKeyAt < 0 ||
    (s.keyRequested && now - s.lastKeyAt >= KEY_MIN_GAP_SEC) ||
    now - s.lastKeyAt >= KEY_FALLBACK_SEC
  if (keyDue) return 'key'
  if (s.lastDanceAt < 0 || now - s.lastDanceAt >= DANCE_CADENCE_SEC) return 'danceability'
  return null
}

/** Timer bookkeeping for a job the class just dispatched. */
export function applyDispatch(s: EssentiaSchedState, job: EssentiaJobType, now: number): void {
  if (job === 'rhythm') {
    s.lastJobAt = now
  } else if (job === 'rhythm-hq') {
    // An hq run also resets the fast-read clock, and clears the stale octave
    // reference it is about to recompute (Bug D).
    s.lastHqAt = now
    s.lastJobAt = now
    s.hqBpm = 0
    s.hqConf = 0
  } else if (job === 'key') {
    s.lastKeyAt = now
    s.keyRequested = false
  } else {
    s.lastDanceAt = now
  }
}

/** `status.*` fields a response changes — the class applies these (it owns `status`). */
export interface IngestPatch {
  lastBpm?: number
  lastConfidence?: number
  lastMethod?: string
  lastMs?: number
  /** Set to the receipt clock the caller passed. */
  lastAt?: number
  keyMs?: number
  incKeyRuns?: boolean
  danceMs?: number
  incDanceRuns?: boolean
  error?: string
}

/**
 * Route a completed worker response into the pending slots + `hqBpm`/`cadence`,
 * and return the `status` changes for the class to apply. `receiptClock` is
 * whatever the caller stamps `status.lastAt` with (`performance.now() / 1000`).
 * The class has already verified the response is not stale (id match) and set
 * `busy = false` before calling this.
 */
export function ingestResponse(
  s: EssentiaSchedState,
  r: EssentiaResponse,
  receiptClock: number,
): IngestPatch {
  if (r.type === 'error') return { error: `${r.job}: ${r.message}` }
  if (r.type === 'key') {
    s.pendingKey = r
    return { keyMs: r.ms, incKeyRuns: true }
  }
  if (r.type === 'danceability') {
    s.pendingDance = r
    return { danceMs: r.ms, incDanceRuns: true }
  }
  // rhythm (degara or multifeature — both carry type 'rhythm', method distinguishes)
  s.pending = r
  const patch: IngestPatch = {
    lastBpm: r.bpm,
    lastConfidence: r.confidence01,
    lastMethod: r.method,
    lastMs: r.ms,
    lastAt: receiptClock,
  }
  if (r.method === 'multifeature') {
    // Keep it as an octave reference for the fast reads that follow; a bad read
    // (NaN / non-positive) leaves the previous reference cleared, not poisoned.
    if (Number.isFinite(r.bpm) && r.bpm > 0) {
      s.hqBpm = r.bpm
      s.hqConf = r.confidence01
    }
  } else {
    s.rhythmReads++
    // Self-throttle: never spend more than ~half the wall clock analyzing.
    s.cadence = Math.max(RHYTHM_CADENCE_SEC, (r.ms / 1000) * 2)
  }
  return patch
}

/** What `drainResults` wants applied to `AudioFeatures` / `BpmEstimator`. */
export interface DrainOut {
  modelTempo?: { bpm: number; conf: number }
  key?: { key: string; scale: 'major' | 'minor' | ''; keyConfidence: number }
  dance?: number
}

/**
 * Fold any completed results toward the feature object / estimator. Pure: reads
 * the pending slots + `hqBpm`/`hqConf`/`lastHqAt`, clears the slots, and returns
 * what the class should write. `est` is the minimal read view of BpmEstimator.
 */
export function drainResults(
  s: EssentiaSchedState,
  est: { bpm: number; confidence: number },
  now: number,
): DrainOut {
  const out: DrainOut = {}

  if (s.pending) {
    const r = s.pending
    s.pending = null
    // Prefer a fresh multifeature octave reference; else the internal onset lock.
    const hqFresh = s.hqBpm > 0 && now - s.lastHqAt < RHYTHM_HQ_FRESH_SEC
    const refBpm = hqFresh ? s.hqBpm : est.bpm
    const refConf = hqFresh ? Math.max(s.hqConf, 0.6) : est.confidence
    const modelConf = r.method === 'multifeature' ? r.confidence01 : 0
    const bpm = reconcileModelBpm(r.bpm, refBpm, refConf, modelConf)
    if (bpm >= 40 && bpm <= 240 && Number.isFinite(bpm)) {
      out.modelTempo = { bpm, conf: r.confidence01 }
    }
  }

  if (s.pendingKey) {
    const r = s.pendingKey
    s.pendingKey = null
    out.key = {
      key: r.key,
      scale: r.scale === 'major' || r.scale === 'minor' ? r.scale : '',
      keyConfidence: Number.isFinite(r.strength) ? Math.max(0, Math.min(1, r.strength)) : 0,
    }
  }

  if (s.pendingDance) {
    const r = s.pendingDance
    s.pendingDance = null
    if (Number.isFinite(r.danceability)) out.dance = r.danceability
  }

  return out
}
