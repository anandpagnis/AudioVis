import { describe, expect, it } from 'vitest'
import {
  applyDispatch,
  drainResults,
  ingestResponse,
  makeSchedState,
  pickJob,
  resetSchedState,
  DANCE_CADENCE_SEC,
  KEY_FALLBACK_SEC,
  KEY_MIN_GAP_SEC,
  RHYTHM_CADENCE_SEC,
  RHYTHM_HQ_CADENCE_SEC,
  RHYTHM_HQ_FRESH_SEC,
  RHYTHM_HQ_MIN_READS,
  type EssentiaSchedState,
} from '../essentia/scheduling'
import type {
  DanceabilityResult,
  KeyResult,
  RhythmResult,
  WorkerError,
} from '../essentia/protocol'

const state = (over: Partial<EssentiaSchedState> = {}): EssentiaSchedState => ({
  ...makeSchedState(),
  ...over,
})

const degara = (over: Partial<RhythmResult> = {}): RhythmResult => ({
  id: 1,
  type: 'rhythm',
  bpm: 128,
  confidence01: 0,
  method: 'degara',
  ms: 190,
  ...over,
})
const multi = (over: Partial<RhythmResult> = {}): RhythmResult => ({
  id: 1,
  type: 'rhythm',
  bpm: 128,
  confidence01: 0.8,
  method: 'multifeature',
  ms: 950,
  ...over,
})
const keyRes = (over: Partial<KeyResult> = {}): KeyResult => ({
  id: 1,
  type: 'key',
  key: 'C',
  scale: 'major',
  strength: 0.7,
  ms: 300,
  ...over,
})
const danceRes = (over: Partial<DanceabilityResult> = {}): DanceabilityResult => ({
  id: 1,
  type: 'danceability',
  danceability: 1.4,
  ms: 400,
  ...over,
})

// ---------------------------------------------------------------------------

describe('pickJob priority ladder', () => {
  it('returns rhythm as the very first job', () => {
    expect(pickJob(state(), 0)).toBe('rhythm')
    // even when the hq timer would otherwise be due
    expect(pickJob(state({ lastHqAt: -1 }), 999)).toBe('rhythm')
  })

  it('returns rhythm whenever a full cadence has elapsed since the last rhythm-family job', () => {
    const s = state({ lastJobAt: 10, cadence: RHYTHM_CADENCE_SEC, rhythmReads: 5 })
    expect(pickJob(s, 10 + RHYTHM_CADENCE_SEC - 0.01)).not.toBe('rhythm')
    expect(pickJob(s, 10 + RHYTHM_CADENCE_SEC)).toBe('rhythm')
  })

  it('never picks rhythm-hq until RHYTHM_HQ_MIN_READS degara reads have completed (Bug A)', () => {
    // rhythm not due (just dispatched), hq timer wide open, but no reads yet
    const early = state({ lastJobAt: 100, rhythmReads: RHYTHM_HQ_MIN_READS - 1, lastHqAt: -1 })
    expect(pickJob(early, 100.5)).not.toBe('rhythm-hq')
    const ready = state({ lastJobAt: 100, rhythmReads: RHYTHM_HQ_MIN_READS, lastHqAt: -1 })
    expect(pickJob(ready, 100.5)).toBe('rhythm-hq')
  })

  // A baseline where rhythm + hq are BOTH not due, so pickJob reaches the
  // key/dance branches. `now` is 1000; every "last*" timer is fresh.
  const quiet = (over: Partial<EssentiaSchedState> = {}) =>
    state({
      lastJobAt: 999,
      lastHqAt: 999,
      lastKeyAt: 999,
      lastDanceAt: 999,
      rhythmReads: 5,
      ...over,
    })

  it('runs rhythm-hq on its slow cadence once eligible', () => {
    const s = quiet({ lastHqAt: 1000 - RHYTHM_HQ_CADENCE_SEC + 0.01, lastKeyAt: -1 })
    expect(pickJob(s, 1000)).not.toBe('rhythm-hq') // hq not due yet → first-key
    s.lastHqAt = 1000 - RHYTHM_HQ_CADENCE_SEC
    expect(pickJob(s, 1000)).toBe('rhythm-hq')
  })

  it('runs the first key read ASAP, ignoring keyRequested and the key timers', () => {
    const s = quiet({ lastKeyAt: -1, keyRequested: false })
    expect(pickJob(s, 1000)).toBe('key')
  })

  it('escalates key to a KEY_MIN_GAP floor when a section boundary requested it', () => {
    const s = quiet({ lastKeyAt: 1000 - KEY_MIN_GAP_SEC + 0.01, keyRequested: true })
    expect(pickJob(s, 1000)).toBeNull() // gap not elapsed
    s.lastKeyAt = 1000 - KEY_MIN_GAP_SEC
    expect(pickJob(s, 1000)).toBe('key')
  })

  it('falls back to KEY_FALLBACK for material with no section boundaries', () => {
    const s = quiet({ lastKeyAt: 1000 - KEY_FALLBACK_SEC + 1, keyRequested: false })
    expect(pickJob(s, 1000)).toBeNull()
    s.lastKeyAt = 1000 - KEY_FALLBACK_SEC
    expect(pickJob(s, 1000)).toBe('key')
  })

  it('runs danceability last, on its own cadence', () => {
    const s = quiet({ lastDanceAt: 1000 - DANCE_CADENCE_SEC + 0.01 })
    expect(pickJob(s, 1000)).toBeNull()
    s.lastDanceAt = 1000 - DANCE_CADENCE_SEC
    expect(pickJob(s, 1000)).toBe('danceability')
  })

  it('returns null when nothing is due', () => {
    expect(pickJob(quiet(), 1000)).toBeNull()
  })

  it('breaks a full three-way tie toward rhythm', () => {
    const s = state({ lastJobAt: 0, cadence: RHYTHM_CADENCE_SEC, rhythmReads: 5, lastKeyAt: 0, lastDanceAt: 0 })
    expect(pickJob(s, 1000)).toBe('rhythm')
  })
})

describe('the opening of a track never dispatches rhythm-hq early (Bug A regression)', () => {
  it('withholds rhythm-hq until RHYTHM_HQ_MIN_READS degara reads complete, whatever the timeline', () => {
    const s = makeSchedState()
    let now = 0
    const seenBefore: string[] = [] // jobs dispatched while rhythmReads < MIN_READS
    for (let step = 0; step < 400 && s.rhythmReads < RHYTHM_HQ_MIN_READS; step++) {
      now += 0.05
      const job = pickJob(s, now)
      if (!job) continue
      seenBefore.push(job)
      applyDispatch(s, job, now)
      // model the job completing instantly at various costs
      if (job === 'rhythm') ingestResponse(s, degara(), now)
      else if (job === 'rhythm-hq') ingestResponse(s, multi(), now)
      else if (job === 'key') ingestResponse(s, keyRes(), now)
      else ingestResponse(s, danceRes(), now)
    }
    expect(seenBefore).not.toContain('rhythm-hq')
    // and once the reads are in, it becomes reachable
    s.lastJobAt = now // rhythm not due
    s.lastHqAt = -1
    expect(pickJob(s, now + 0.1)).toBe('rhythm-hq')
  })
})

describe('applyDispatch timer writes', () => {
  it('rhythm writes only lastJobAt', () => {
    const s = state()
    applyDispatch(s, 'rhythm', 42)
    expect(s.lastJobAt).toBe(42)
    expect(s.lastHqAt).toBe(-1)
    expect(s.lastKeyAt).toBe(-1)
  })

  it('rhythm-hq writes lastHqAt AND lastJobAt, and clears the octave reference (Bug D)', () => {
    const s = state({ hqBpm: 130, hqConf: 0.9 })
    applyDispatch(s, 'rhythm-hq', 42)
    expect(s.lastHqAt).toBe(42)
    expect(s.lastJobAt).toBe(42)
    expect(s.hqBpm).toBe(0)
    expect(s.hqConf).toBe(0)
  })

  it('key writes lastKeyAt and clears keyRequested', () => {
    const s = state({ keyRequested: true })
    applyDispatch(s, 'key', 42)
    expect(s.lastKeyAt).toBe(42)
    expect(s.keyRequested).toBe(false)
  })

  it('danceability writes only lastDanceAt', () => {
    const s = state()
    applyDispatch(s, 'danceability', 42)
    expect(s.lastDanceAt).toBe(42)
    expect(s.lastJobAt).toBe(-1)
  })
})

describe('ingestResponse routing + throttle', () => {
  it('routes each result type to its pending slot', () => {
    const s = state()
    ingestResponse(s, degara(), 0)
    expect(s.pending?.method).toBe('degara')
    ingestResponse(s, keyRes(), 0)
    expect(s.pendingKey?.key).toBe('C')
    ingestResponse(s, danceRes(), 0)
    expect(s.pendingDance?.danceability).toBe(1.4)
  })

  it('grows cadence from a slow degara read but not from multifeature', () => {
    const s = state()
    ingestResponse(s, degara({ ms: 190 }), 0)
    expect(s.cadence).toBe(RHYTHM_CADENCE_SEC) // 190ms*2 < floor
    ingestResponse(s, degara({ ms: 2000 }), 0)
    expect(s.cadence).toBeCloseTo(4.0, 5) // 2000ms * 2
    ingestResponse(s, multi({ ms: 950 }), 0)
    expect(s.cadence).toBeCloseTo(4.0, 5) // unchanged — the 950ms must not inflate the fast path
  })

  it('counts only completed degara reads toward rhythmReads', () => {
    const s = state()
    ingestResponse(s, degara(), 0)
    ingestResponse(s, degara(), 0)
    ingestResponse(s, multi(), 0)
    expect(s.rhythmReads).toBe(2)
  })

  it('captures hqBpm/hqConf from a good multifeature read', () => {
    const s = state()
    ingestResponse(s, multi({ bpm: 174, confidence01: 0.9 }), 0)
    expect(s.hqBpm).toBe(174)
    expect(s.hqConf).toBe(0.9)
  })

  it('leaves the octave reference cleared (not poisoned) on a bad multifeature read', () => {
    const s = state()
    ingestResponse(s, multi({ bpm: NaN }), 0)
    expect(s.hqBpm).toBe(0)
    ingestResponse(s, multi({ bpm: 0 }), 0)
    expect(s.hqBpm).toBe(0)
  })

  it('returns a status patch, not direct writes', () => {
    const s = state()
    const p = ingestResponse(s, degara({ bpm: 140, ms: 200, confidence01: 0 }), 12.5)
    expect(p.lastBpm).toBe(140)
    expect(p.lastMethod).toBe('degara')
    expect(p.lastAt).toBe(12.5)
    const pk = ingestResponse(s, keyRes({ ms: 321 }), 0)
    expect(pk.incKeyRuns).toBe(true)
    expect(pk.keyMs).toBe(321)
  })

  it('reports an error with the failing job name and writes no pending slot', () => {
    const s = state()
    const err: WorkerError = { id: 1, type: 'error', job: 'key', message: 'boom' }
    const p = ingestResponse(s, err, 0)
    expect(p.error).toBe('key: boom')
    expect(s.pendingKey).toBeNull()
  })
})

describe('drainResults merge', () => {
  const est = (bpm = 128, confidence = 0.7) => ({ bpm, confidence })

  it('clears every slot and returns nothing when all are empty', () => {
    const s = state()
    expect(drainResults(s, est(), 0)).toEqual({})
  })

  it('reconciles a degara read against a fresh hq reference when one exists', () => {
    // hq says 152, degara hands back a clean-looking half-tempo 76 → folded to 152
    const s = state({ hqBpm: 152, hqConf: 0.8, lastHqAt: 0 })
    s.pending = degara({ bpm: 76 })
    const out = drainResults(s, est(76, 0.9), 1)
    expect(out.modelTempo?.bpm).toBe(152)
    expect(s.pending).toBeNull()
  })

  it('reconciles against the internal grid when the hq reference is stale', () => {
    const s = state({ hqBpm: 152, hqConf: 0.8, lastHqAt: 0 })
    s.pending = degara({ bpm: 76 })
    // lastHqAt is RHYTHM_HQ_FRESH_SEC+1 old → not fresh → ref = est.bpm (76), no fold
    const out = drainResults(s, est(76, 0.9), RHYTHM_HQ_FRESH_SEC + 1)
    expect(out.modelTempo?.bpm).toBe(76)
  })

  it('drops a tempo read outside [40, 240]', () => {
    const s = state()
    s.pending = degara({ bpm: 300 })
    expect(drainResults(s, est(), 0).modelTempo).toBeUndefined()
    s.pending = degara({ bpm: NaN })
    expect(drainResults(s, est(), 0).modelTempo).toBeUndefined()
    s.pending = degara({ bpm: 20 })
    expect(drainResults(s, est(), 0).modelTempo).toBeUndefined()
  })

  it('passes a confident multifeature read through unchanged (reconciles against itself)', () => {
    const s = state({ hqBpm: 128, hqConf: 0.9, lastHqAt: 0 })
    s.pending = multi({ bpm: 128, confidence01: 0.9 })
    expect(drainResults(s, est(), 1).modelTempo?.bpm).toBe(128)
  })

  it('maps a key result, normalizing scale and clamping strength', () => {
    const s = state()
    s.pendingKey = keyRes({ key: 'F#', scale: 'minor', strength: 1.4 })
    const out = drainResults(s, est(), 0)
    expect(out.key).toEqual({ key: 'F#', scale: 'minor', keyConfidence: 1 })
    s.pendingKey = keyRes({ scale: 'weird' as never, strength: NaN })
    const out2 = drainResults(s, est(), 0)
    expect(out2.key).toEqual({ key: 'C', scale: '', keyConfidence: 0 })
  })

  it('passes danceability through only when finite', () => {
    const s = state()
    s.pendingDance = danceRes({ danceability: 2.1 })
    expect(drainResults(s, est(), 0).dance).toBe(2.1)
    s.pendingDance = danceRes({ danceability: NaN })
    expect(drainResults(s, est(), 0).dance).toBeUndefined()
  })

  it('drains all three families in one call, each slot independent', () => {
    const s = state({ hqBpm: 128, hqConf: 0.8, lastHqAt: 0 })
    s.pending = multi({ bpm: 128 })
    s.pendingKey = keyRes()
    s.pendingDance = danceRes()
    const out = drainResults(s, est(), 1)
    expect(out.modelTempo).toBeDefined()
    expect(out.key).toBeDefined()
    expect(out.dance).toBeDefined()
    expect(s.pending).toBeNull()
    expect(s.pendingKey).toBeNull()
    expect(s.pendingDance).toBeNull()
  })
})

describe('resetSchedState', () => {
  it('restores every field to the fresh defaults', () => {
    const s = state({
      lastJobAt: 5,
      cadence: 9,
      lastHqAt: 5,
      lastKeyAt: 5,
      lastDanceAt: 5,
      keyRequested: true,
      rhythmReads: 7,
      hqBpm: 130,
      hqConf: 0.9,
    })
    s.pending = degara()
    s.pendingKey = keyRes()
    s.pendingDance = danceRes()
    resetSchedState(s)
    expect(s).toEqual(makeSchedState())
  })
})
