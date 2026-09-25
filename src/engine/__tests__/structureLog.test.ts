import { describe, expect, it } from 'vitest'
import {
  COMMIT_REASON_TTL_SEC,
  STRUCTURE_LOG_CAPS,
  STRUCTURE_LOG_SCHEMA,
  STRUCTURE_LOG_VERSION,
  StructureLog,
  formatStructureLogHud,
  stringifyStructureLog,
  structureLog,
  structureLogFileName,
  type StructureLogFrame,
  type StructureLogOptions,
  type StructureLogStoreSnapshot,
} from '../structureLog'

const ISO = '2026-05-06T07:08:09.123Z'

function makeLog(over: StructureLogOptions = {}): { log: StructureLog; wall: { ms: number } } {
  const wall = { ms: 1000 }
  const log = new StructureLog({
    now: () => (wall.ms += 7),
    isoNow: () => ISO,
    userAgent: 'vitest',
    ...over,
  })
  return { log, wall }
}

interface FrameOpts {
  beat?: number
  bib?: number
  progress?: number
  bpm?: number
  confidence?: number
  sectionChange?: boolean
  strength?: number
  drop?: boolean
  buildUp?: boolean
  silence?: boolean
  locked?: boolean
  downbeatConfidence?: number
  valid?: boolean
  energy?: number
  loudness?: number
  lufs?: number
  ss?: Partial<StructureLogFrame['songSection']>
  mood?: Partial<StructureLogFrame['mood']>
  ch?: Partial<StructureLogFrame['character']>
}

/** A frame at audio time `t`. 120 bpm by default, so `beatIndex = floor(2t)` and `beatInBar = beat % 4`. */
function frame(t: number, o: FrameOpts = {}): StructureLogFrame {
  const beat = o.beat ?? Math.floor(t * 2)
  return {
    time: t,
    beatIndex: beat,
    beatInBar: o.bib ?? beat % 4,
    beatProgress: o.progress ?? (t * 2) % 1,
    bpm: o.bpm ?? 120,
    confidence: o.confidence ?? 0.8,
    tempoOctaves: 0,
    energy: o.energy ?? 0.5,
    loudness: o.loudness ?? 0.4,
    lufsShortTerm: o.lufs ?? -14,
    silence: o.silence ?? false,
    drop: o.drop ?? false,
    buildUp: o.buildUp ?? false,
    sectionChange: o.sectionChange ?? false,
    sectionChangeStrength: o.strength ?? 0,
    downbeatLocked: o.locked ?? false,
    downbeatConfidence: o.downbeatConfidence ?? 0.1,
    structureValid: o.valid ?? true,
    songSection: {
      section: 'section',
      previousSection: '',
      sectionConfidence: 0.6,
      beatsInSection: 8,
      boundaryChanged: false,
      changeCount: 0,
      isBuild: false,
      isDrop: false,
      isBreakdown: false,
      dropExpected: false,
      buildProgress: 0,
      beatsTillDrop: -1,
      repetitionLabel: '',
      ...o.ss,
    },
    mood: { changed: false, state: 'groove', predictedState: 'groove', confidence: 0.7, ...o.mood },
    character: { primary: 'groove', confidence: 0.5, valence: 0.6, arousal: 0.7, ...o.ch },
  }
}

function store(sceneId = 'a', over: Partial<StructureLogStoreSnapshot> = {}): StructureLogStoreSnapshot {
  return { sceneId, pendingSceneId: null, status: 'running', sourceType: 'file', ...over }
}

/** Steady frames from `t0` to `t1` (exclusive) at 60 fps. Returns the next free time. */
function run(log: StructureLog, t0: number, t1: number, s = store(), o: FrameOpts = {}): number {
  let t = t0
  for (; t < t1 - 1e-9; t += 1 / 60) log.observe(frame(t, o), s)
  return t
}

function allFinite(v: unknown, path = ''): string[] {
  if (typeof v === 'number') return Number.isFinite(v) ? [] : [path]
  if (Array.isArray(v)) return v.flatMap((x, i) => allFinite(x, `${path}[${i}]`))
  if (typeof v === 'object' && v !== null) {
    return Object.entries(v).flatMap(([k, x]) => allFinite(x, `${path}.${k}`))
  }
  return []
}

describe('edges only', () => {
  it('records nothing per frame on a steady stream: only the start tempo, 10 s tempo summaries, samples, beats', () => {
    const { log } = makeLog()
    run(log, 0, 35)
    const j = log.toJSON()
    expect(j.events.every((e) => e.kind === 'tempo')).toBe(true)
    // start + summaries at ~10, 20, 30 s
    expect(j.events).toHaveLength(4)
    expect(j.events[0].data.phase).toBe('start')
    expect(j.events.slice(1).every((e) => e.data.phase === 'summary')).toBe(true)
    expect(j.samples.length).toBeGreaterThanOrEqual(35)
    expect(j.samples.length).toBeLessThanOrEqual(37)
    expect(j.beats.length).toBeGreaterThanOrEqual(70)
    expect(j.counters.frames).toBeGreaterThan(2000)
  })

  it('records a held one-frame flag ONCE (rising edge), and again only after it fell', () => {
    const { log } = makeLog()
    let t = run(log, 0, 1)
    for (let i = 0; i < 30; i++, t += 1 / 60) log.observe(frame(t, { sectionChange: true, strength: 0.71 }), store())
    t = run(log, t, t + 1)
    for (let i = 0; i < 3; i++, t += 1 / 60) log.observe(frame(t, { sectionChange: true, strength: 0.9 }), store())
    const ev = log.toJSON().events.filter((e) => e.kind === 'sectionChange')
    expect(ev).toHaveLength(2)
    expect(ev[0].data.strength).toBe(0.71)
    expect(ev[1].data.strength).toBe(0.9)
  })

  it('primes level flags from the first frame: a flag already on at the start is not an edge', () => {
    const { log } = makeLog()
    log.observe(frame(0, { silence: true }), store())
    log.observe(frame(0.1, { silence: true }), store())
    expect(log.toJSON().events.filter((e) => e.kind === 'silence')).toHaveLength(0)
    log.observe(frame(0.2, { silence: false }), store())
    const s = log.toJSON().events.filter((e) => e.kind === 'silence')
    expect(s).toHaveLength(1)
    expect(s[0].data.on).toBe(false)
  })

  it('level flags record BOTH edges with `on`', () => {
    const { log } = makeLog()
    let t = run(log, 0, 1)
    t = run(log, t, t + 2, store(), { buildUp: true, ss: { isBuild: true, buildProgress: 0.5 } })
    run(log, t, t + 1)
    const j = log.toJSON()
    const bu = j.events.filter((e) => e.kind === 'buildUp')
    expect(bu.map((e) => e.data.on)).toEqual([true, false])
    const ib = j.events.filter((e) => e.kind === 'isBuild')
    expect(ib.map((e) => e.data.on)).toEqual([true, false])
    expect(ib[0].data.buildProgress).toBe(0.5)
  })

  it('records drop, boundary, songSection, mood, character, downbeat lock and shift edges with their details', () => {
    const { log } = makeLog()
    let t = run(log, 0, 2)
    log.observe(frame(t, { drop: true }), store())
    t += 1 / 60
    log.observe(frame(t, { drop: true }), store())
    t += 1 / 60
    log.observe(
      frame(t, {
        ss: { section: 'drop', previousSection: 'section', boundaryChanged: true, changeCount: 1, beatsInSection: 0 },
        mood: { changed: true, state: 'peak', predictedState: 'peak' },
        ch: { primary: 'epic', confidence: 0.9 },
        locked: true,
        downbeatConfidence: 0.9,
      }),
      store(),
    )
    t += 1 / 60
    log.observe(
      frame(t, { ss: { section: 'drop', boundaryChanged: false }, locked: true, ch: { primary: 'epic' }, mood: { state: 'peak' } }),
      store(),
    )
    const j = log.toJSON()
    const one = (kind: string) => j.events.filter((e) => e.kind === kind)
    expect(one('drop')).toHaveLength(1)
    expect(one('boundary')).toHaveLength(1)
    expect(one('boundary')[0].data).toMatchObject({ section: 'drop', previousSection: 'section', changeCount: 1 })
    expect(one('songSection')).toHaveLength(1)
    expect(one('songSection')[0].data).toMatchObject({ from: 'section', to: 'drop' })
    expect(one('mood')).toHaveLength(1)
    expect(one('mood')[0].data).toMatchObject({ from: 'groove', to: 'peak' })
    expect(one('character')).toHaveLength(1)
    expect(one('character')[0].data).toMatchObject({ from: 'groove', to: 'epic' })
    expect(one('downbeatLock')).toHaveLength(1)
    expect(one('downbeatLock')[0].data).toMatchObject({ locked: true, confidence: 0.9 })
    expect(j.counters.events.drop).toBe(1)
    expect(j.counters.events.boundary).toBe(1)
  })

  it('flags a bar-phase jump (downbeatShift) but not a normal beat crossing', () => {
    const { log } = makeLog()
    const t = run(log, 0, 3)
    expect(log.toJSON().counters.events.downbeatShift).toBe(0)
    // the estimator adopts a new offset: beatInBar jumps 1 -> 3 with no beat crossing
    const beat = Math.floor(t * 2)
    log.observe(frame(t, { beat, bib: (beat + 2) % 4 }), store())
    const shift = log.toJSON().events.filter((e) => e.kind === 'downbeatShift')
    expect(shift).toHaveLength(1)
    expect(shift[0].data.to).toBe((beat + 2) % 4)
  })

  it('stamps every record with audio time, beat index, beat in bar and wall-clock time', () => {
    const { log, wall } = makeLog()
    const t = run(log, 0, 3)
    log.observe(frame(t, { sectionChange: true, strength: 0.6 }), store())
    const e = log.toJSON().events.filter((x) => x.kind === 'sectionChange')[0]
    expect(e.t).toBeCloseTo(t, 3)
    expect(e.beat).toBe(Math.floor(t * 2))
    expect(e.beatInBar).toBe(Math.floor(t * 2) % 4)
    expect(e.wallMs).toBeGreaterThan(1000)
    expect(e.wallMs).toBeLessThanOrEqual(wall.ms)
  })

  it('records tempo at the start and the bpm summary across the run', () => {
    const { log } = makeLog()
    let t = run(log, 0, 10.5, store(), { bpm: 120 })
    t = run(log, t, 20.5, store(), { bpm: 130 })
    run(log, t, 30.5, store(), { bpm: 140 })
    const j = log.toJSON()
    expect(j.bpmSummary).toMatchObject({ start: 120, min: 120, max: 140, readings: 4 })
    expect(j.bpmSummary.last).toBe(140)
    expect(j.bpmSummary.median).toBe(125) // readings 120, 120, 130, 140
    expect(j.bpmSummary.mean).toBe(127.5)
  })
})

describe('scene commits', () => {
  it('records a sceneId change as a commit with the beat index and trigger `unknown` until told otherwise', () => {
    const { log } = makeLog()
    run(log, 0, 3, store('a'))
    run(log, 3, 3.1, store('b'))
    const c = log.toJSON().commits
    expect(c).toHaveLength(1)
    expect(c[0]).toMatchObject({ from: 'a', to: 'b', trigger: 'unknown', detail: null, requestedT: null })
    expect(c[0].beat).toBe(6)
    expect(c[0].sinceLastCommitSec).toBeNull()
  })

  it('links a commit to the request it answered, and does not call an answered request withdrawn', () => {
    const { log } = makeLog()
    run(log, 0, 1, store('a'))
    log.observe(frame(1.0), store('a', { pendingSceneId: 'b' }))
    run(log, 1.02, 3, store('a', { pendingSceneId: 'b' }))
    log.observe(frame(3.0), store('b', { pendingSceneId: null }))
    const j = log.toJSON()
    expect(j.events.filter((e) => e.kind === 'sceneRequest')).toHaveLength(1)
    expect(j.events.filter((e) => e.kind === 'sceneWithdrawn')).toHaveLength(0)
    expect(j.commits[0]).toMatchObject({ pending: 'b', requestedBeat: 2 })
    expect(j.commits[0].requestLagSec).toBeCloseTo(2, 2)
  })

  it('records a withdrawn request', () => {
    const { log } = makeLog()
    run(log, 0, 1, store('a'))
    log.observe(frame(1.0), store('a', { pendingSceneId: 'c' }))
    log.observe(frame(1.5), store('a', { pendingSceneId: null }))
    const j = log.toJSON()
    expect(j.events.filter((e) => e.kind === 'sceneWithdrawn')[0].data.sceneId).toBe('c')
    expect(j.commits).toHaveLength(0)
  })

  it('attaches a noteCommit reason given BEFORE the commit, and expires a stale one', () => {
    const { log } = makeLog()
    run(log, 0, 2, store('a'))
    log.noteCommit('drop', 'S=1.2 T=0.6')
    log.observe(frame(2.0), store('b'))
    expect(log.toJSON().commits[0]).toMatchObject({ trigger: 'drop', detail: 'S=1.2 T=0.6' })

    log.noteCommit('change', 'old')
    log.observe(frame(2.0 + COMMIT_REASON_TTL_SEC + 5), store('c'))
    expect(log.toJSON().commits[1].trigger).toBe('unknown')
    expect(log.toJSON().commits[1].sinceLastCommitSec).toBeCloseTo(COMMIT_REASON_TTL_SEC + 5, 2)
  })

  it('patches an `unknown` commit when the reason arrives right after it', () => {
    const { log } = makeLog()
    run(log, 0, 2, store('a'))
    log.observe(frame(2.0), store('b'))
    log.noteCommit('forced', 'age 32 bars')
    expect(log.toJSON().commits[0]).toMatchObject({ trigger: 'forced', detail: 'age 32 bars' })
    // and it is spent: the next commit is unknown again
    log.observe(frame(4.0), store('c'))
    expect(log.toJSON().commits[1].trigger).toBe('unknown')
  })

  it('a reason is spent by the one commit it was given for', () => {
    const { log } = makeLog()
    run(log, 0, 1, store('a'))
    log.noteCommit('change')
    log.observe(frame(1.0), store('b'))
    log.observe(frame(1.5), store('c'))
    const c = log.toJSON().commits
    expect(c.map((x) => x.trigger)).toEqual(['change', 'unknown'])
  })
})

describe('marks', () => {
  it('records the tap with beat, beat-in-bar, progress, bpm and wall time from the last frame', () => {
    const { log } = makeLog()
    const t = run(log, 0, 5.3, store(), { bpm: 128 })
    const m = log.mark(t, 10, 'verse->chorus')
    expect(m).not.toBeNull()
    expect(m).toMatchObject({ id: 1, beat: 10, beatInBar: 2, bpm: 128, note: 'verse->chorus' })
    expect(m?.beatProgress).toBeGreaterThanOrEqual(0)
    expect(m?.wallMs).toBeGreaterThan(1000)
  })

  it('keeps marks sorted by audio time even when one arrives out of order', () => {
    const { log } = makeLog()
    run(log, 0, 1)
    log.mark(30, 60)
    log.mark(10, 20)
    log.mark(20, 40)
    log.mark(20, 41)
    expect(log.toJSON().marks.map((m) => m.t)).toEqual([10, 20, 20, 30])
    // equal times keep creation order
    expect(log.toJSON().marks.map((m) => m.id)).toEqual([2, 3, 4, 1])
  })

  it('undo removes the most recently CREATED mark, not the latest in time', () => {
    const { log } = makeLog()
    run(log, 0, 1)
    log.mark(30, 60)
    log.mark(10, 20)
    const removed = log.undoLastMark()
    expect(removed?.t).toBe(10)
    expect(log.toJSON().marks.map((m) => m.t)).toEqual([30])
    expect(log.toJSON().counters.undoneMarks).toBe(1)
    log.undoLastMark()
    expect(log.undoLastMark()).toBeNull()
  })

  it('ignores a non-finite time and counts it', () => {
    const { log } = makeLog()
    run(log, 0, 1)
    expect(log.mark(Number.NaN, 4)).toBeNull()
    expect(log.mark(Number.POSITIVE_INFINITY, 4)).toBeNull()
    expect(log.toJSON().marks).toHaveLength(0)
    expect(log.toJSON().counters.nonFinite).toBe(2)
    // a non-finite beat falls back to the last observed beat
    const m = log.mark(5, Number.NaN)
    expect(m?.beat).toBe(Math.floor((59 / 60) * 2))
  })

  it('does nothing when disabled', () => {
    const { log } = makeLog({ enabled: false })
    expect(log.mark(1, 2)).toBeNull()
    log.noteCommit('drop')
    log.observe(frame(1), store())
    expect(log.toJSON().counters.frames).toBe(0)
    expect(log.toJSON().events).toHaveLength(0)
  })
})

describe('bounded memory', () => {
  it('drops the oldest events past the cap and counts them, while the per-kind totals stay exact', () => {
    const { log } = makeLog({ caps: { events: 5 } })
    let t = run(log, 0, 1)
    for (let i = 0; i < 12; i++) {
      log.observe(frame(t, { sectionChange: true, strength: i / 100 }), store())
      t += 1 / 60
      log.observe(frame(t), store())
      t += 1 / 60
    }
    const j = log.toJSON()
    expect(j.events).toHaveLength(5)
    expect(j.counters.events.sectionChange).toBe(12)
    // 1 start-tempo + 12 pulses were emitted, 5 kept
    expect(j.counters.droppedEvents).toBe(8)
    expect(j.events[j.events.length - 1].data.strength).toBe(0.11)
    expect(j.events[0].t).toBeLessThan(j.events[4].t)
  })

  it('caps beats, samples, commits and marks with their own counters', () => {
    const { log } = makeLog({ caps: { beats: 3, samples: 2, commits: 2, marks: 3 } })
    run(log, 0, 5)
    for (const id of ['b', 'c', 'd', 'e']) log.observe(frame(5), store(id))
    for (let i = 0; i < 5; i++) log.mark(i, i)
    const j = log.toJSON()
    expect(j.beats).toHaveLength(3)
    expect(j.beats[2][0]).toBe(10) // the last beat seen is frame(5)
    expect(j.counters.droppedBeats).toBeGreaterThan(0)
    expect(j.samples).toHaveLength(2)
    expect(j.counters.droppedSamples).toBeGreaterThan(0)
    expect(j.commits).toHaveLength(2)
    expect(j.counters.commits).toBe(4)
    expect(j.counters.droppedCommits).toBe(2)
    expect(j.marks).toHaveLength(3)
    expect(j.marks.map((m) => m.t)).toEqual([2, 3, 4])
    expect(j.counters.droppedMarks).toBe(2)
  })

  it('has the documented default caps', () => {
    expect(STRUCTURE_LOG_CAPS.events).toBe(20_000)
  })

  it('a long steady run stays flat: no event growth per frame (hot path records nothing)', () => {
    const { log } = makeLog()
    run(log, 0, 5)
    const before = log.toJSON().events.length
    run(log, 5, 9.9) // stays inside the 10 s tempo window
    expect(log.toJSON().events.length).toBe(before)
  })
})

describe('reset and new tracks', () => {
  it('starts a fresh log when the audio clock goes backwards, archiving a track that has marks', () => {
    const { log } = makeLog()
    const t = run(log, 100, 103)
    log.mark(t, 206)
    log.observe(frame(0.5), store())
    const j = log.toJSON()
    expect(j.marks).toHaveLength(0)
    expect(j.startedBy).toBe('clock-backwards')
    expect(j.counters.resets).toBe(1)
    expect(j.firstT).toBe(0.5)
    expect(log.archivedCount()).toBe(1)
    expect(log.unsavedCount()).toBe(1)
    const prev = log.latestArchived()
    expect(prev?.json.marks).toHaveLength(1)
    expect(log.unsavedCount()).toBe(0)
  })

  it('also resets when only the beat counter goes backwards (a new source on the same audio context)', () => {
    const { log } = makeLog()
    run(log, 100, 102)
    log.mark(101, 202)
    log.observe(frame(102.1, { beat: 0, bib: 0 }), store())
    expect(log.toJSON().startedBy).toBe('clock-backwards')
    expect(log.archivedCount()).toBe(1)
  })

  it('does not reset on ordinary jitter or a single skipped-back beat', () => {
    const { log } = makeLog()
    run(log, 10, 12)
    log.observe(frame(12.0 - 0.05, { beat: Math.floor(12 * 2) - 1 }), store())
    expect(log.toJSON().counters.resets).toBe(0)
  })

  it('pauses while the source is not running and starts a new track when it runs again', () => {
    const { log } = makeLog()
    run(log, 0, 2)
    log.mark(1, 2)
    const frames = log.toJSON().counters.frames
    log.observe(frame(2.5), store('a', { status: 'idle', sourceType: null }))
    log.observe(frame(2.6), store('a', { status: 'starting' }))
    expect(log.toJSON().counters.frames).toBe(frames)
    expect(log.summary().running).toBe(false)
    log.observe(frame(3.0), store('a', { sourceType: 'mic' }))
    const j = log.toJSON()
    expect(j.source).toBe('mic')
    expect(j.marks).toHaveLength(0)
    expect(j.startedBy).toBe('source-start')
    expect(log.archivedCount()).toBe(1)
  })

  it('resets on a source-type change while running', () => {
    const { log } = makeLog()
    run(log, 0, 1, store('a', { sourceType: 'system' }))
    log.mark(0.5, 1)
    log.observe(frame(1.1), store('a', { sourceType: 'file' }))
    expect(log.toJSON().startedBy).toBe('source-change')
    expect(log.toJSON().source).toBe('file')
    expect(log.archivedCount()).toBe(1)
  })

  it('identifies the source from the store: system, mic, file, unknown', () => {
    for (const src of ['system', 'mic', 'file'] as const) {
      const { log } = makeLog()
      run(log, 0, 0.5, store('a', { sourceType: src }))
      expect(log.toJSON().source).toBe(src)
    }
    const { log } = makeLog()
    run(log, 0, 0.5, store('a', { sourceType: undefined }))
    expect(log.toJSON().source).toBe('unknown')
  })

  it('keeps a track name typed before play, and clears it once a real track has run', () => {
    const { log } = makeLog()
    log.setTrackHint('  My Song  ')
    run(log, 0, 1)
    expect(log.toJSON().trackHint).toBe('My Song')
    log.observe(frame(1.5), store('a', { status: 'idle' }))
    run(log, 0, 1, store()) // a new run: clock backwards from 1.5 to 0
    expect(log.toJSON().trackHint).toBeUndefined()
  })

  it('finish() exports, archives and starts a fresh empty log; the archive can be re-exported', () => {
    const { log } = makeLog()
    log.setTrackHint('Song A')
    const t = run(log, 0, 3)
    log.mark(t, 6)
    expect(log.unsavedCount()).toBe(1)
    const out = log.finish()
    expect(out.fileName).toBe('structurelog-song-a.json')
    expect(out.json.marks).toHaveLength(1)
    expect(log.unsavedCount()).toBe(0)
    expect(log.toJSON().marks).toHaveLength(0)
    expect(log.toJSON().startedBy).toBe('finish')
    expect(log.getTrackHint()).toBe('')
    expect(log.archivedCount()).toBe(1)
    expect(log.latestArchived()?.fileName).toBe('structurelog-song-a.json')
    // the next frame starts the next track cleanly
    run(log, 3, 4)
    expect(log.toJSON().counters.frames).toBeGreaterThan(30)
    expect(log.toJSON().firstT).toBeCloseTo(3, 1)
  })

  it('an export clears the unsaved flag, a new mark sets it again', () => {
    const { log } = makeLog()
    run(log, 0, 1)
    log.mark(1, 2)
    expect(log.unsavedCount()).toBe(1)
    log.snapshotForExport()
    expect(log.unsavedCount()).toBe(0)
    log.mark(2, 4)
    expect(log.unsavedCount()).toBe(1)
  })

  it('keeps only the last 5 archived tracks', () => {
    const { log } = makeLog()
    let base = 1000
    for (let i = 0; i < 8; i++) {
      run(log, base, base + 1)
      log.mark(base + 0.5, 1)
      base -= 100 // each next track's clock is earlier: a reset
    }
    expect(log.archivedCount()).toBe(STRUCTURE_LOG_CAPS.archive)
  })
})

describe('schema, JSON and file names', () => {
  it('has a versioned schema with every documented top-level field', () => {
    const { log } = makeLog()
    const t = run(log, 0, 4)
    log.mark(t, 8)
    const j = log.toJSON()
    expect(j.schema).toBe(STRUCTURE_LOG_SCHEMA)
    expect(j.version).toBe(STRUCTURE_LOG_VERSION)
    expect(j.startedAtIso).toBe(ISO)
    expect(j.userAgent).toBe('vitest')
    expect(j.source).toBe('file')
    for (const k of ['bpmSummary', 'marks', 'events', 'commits', 'samples', 'beats', 'counters'] as const) {
      expect(j[k]).toBeDefined()
    }
    expect(j.durationSec).toBeCloseTo(4, 0)
  })

  it('round-trips through JSON.stringify and through the line-per-record text', () => {
    const { log } = makeLog()
    log.setTrackHint('Round Trip')
    let t = run(log, 0, 2)
    log.observe(frame(t, { sectionChange: true, strength: 0.8 }), store('b', { pendingSceneId: 'c' }))
    t += 0.05
    log.mark(t, 4, 'x')
    const j = log.toJSON()
    expect(JSON.parse(JSON.stringify(log))).toEqual(JSON.parse(JSON.stringify(j)))
    const text = stringifyStructureLog(j)
    expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(j)))
    // one record per line inside the lists
    expect(text.split('\n').some((l) => l.startsWith('    {"kind":"sectionChange"'))).toBe(true)
    expect(text.endsWith('}\n')).toBe(true)
  })

  it('stringifies an empty log to valid JSON', () => {
    const { log } = makeLog()
    const text = stringifyStructureLog(log.toJSON())
    const j = JSON.parse(text) as { marks: unknown[]; events: unknown[]; source: string }
    expect(j.marks).toEqual([])
    expect(j.events).toEqual([])
    expect(j.source).toBe('unknown')
  })

  it('never writes NaN or Infinity: hostile numeric fields are sanitised', () => {
    const { log } = makeLog()
    run(log, 0, 1)
    const bad = frame(1.2, { sectionChange: true })
    bad.beatIndex = Number.NaN
    bad.bpm = Number.POSITIVE_INFINITY
    bad.energy = Number.NaN
    bad.sectionChangeStrength = Number.NaN
    bad.lufsShortTerm = Number.NEGATIVE_INFINITY
    bad.songSection.sectionConfidence = Number.NaN
    log.observe(bad, store())
    const skip = frame(Number.NaN)
    log.observe(skip, store())
    log.observe(frame(Number.POSITIVE_INFINITY), store())
    log.mark(1.3, Number.NaN)
    const j = log.toJSON()
    expect(allFinite(j)).toEqual([])
    expect(j.counters.nonFinite).toBe(2)
    expect(j.events.some((e) => e.kind === 'sectionChange')).toBe(true)
  })

  it('names the file after the track, or from the start time when unnamed', () => {
    expect(structureLogFileName('Daft Punk - Around the World (Live!)', ISO)).toBe(
      'structurelog-daft-punk-around-the-world-live.json',
    )
    expect(structureLogFileName('  Été / Ça  ', ISO)).toBe('structurelog-ete-ca.json')
    expect(structureLogFileName('', ISO)).toBe('structurelog-20260506-070809.json')
    expect(structureLogFileName(undefined, ISO)).toBe('structurelog-20260506-070809.json')
    expect(structureLogFileName('!!!', ISO)).toBe('structurelog-20260506-070809.json')
    expect(structureLogFileName(undefined, 'garbage')).toBe('structurelog-unknown-time.json')
    expect(structureLogFileName('x'.repeat(200), ISO).length).toBeLessThanOrEqual('structurelog-.json'.length + 60)
  })

  it('the exported file name uses the typed track name', () => {
    const { log } = makeLog()
    log.setTrackHint('Some Song')
    expect(log.fileName()).toBe('structurelog-some-song.json')
    expect(log.snapshotForExport().fileName).toBe('structurelog-some-song.json')
  })
})

describe('overlay text', () => {
  it('shows marks, detector counts, section state and the last scene commits', () => {
    const { log } = makeLog()
    let t = run(log, 0, 2, store('a'))
    log.observe(frame(t, { sectionChange: true }), store('a'))
    t += 0.1
    log.observe(frame(t), store('b'))
    log.mark(t, 4)
    const lines = formatStructureLogHud(log.summary())
    const text = lines.join('\n')
    expect(text).toMatch(/MARKS 1/)
    expect(text).toMatch(/chg 1/)
    expect(text).toMatch(/section section c0\.60 8b valid/)
    expect(text).toMatch(/scene b/)
    expect(text).toMatch(/a > b {2}\[unknown\]/)
    expect(text).toMatch(/M \/ Space = MARK/)
    expect(text).toMatch(/unnamed/)
  })

  it('says when no source runs, and warns about unsaved marks after the source stopped', () => {
    const { log } = makeLog()
    expect(formatStructureLogHud(log.summary()).join('\n')).toMatch(/waiting for a running audio source/)
    run(log, 0, 1)
    log.mark(0.5, 1)
    log.observe(frame(2), store('a', { status: 'idle' }))
    const text = formatStructureLogHud(log.summary()).join('\n')
    expect(text).toMatch(/SOURCE STOPPED/)
    expect(text).toMatch(/UNSAVED tracks: 1/)
  })
})

describe('the process-wide instance', () => {
  it('starts disabled, so a show director can call noteCommit unconditionally at no cost', () => {
    expect(structureLog.enabled).toBe(false)
    structureLog.noteCommit('drop', 'x')
    structureLog.observe(frame(1), store())
    expect(structureLog.toJSON().counters.frames).toBe(0)
  })
})
