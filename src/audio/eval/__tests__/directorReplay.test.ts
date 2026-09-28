import { describe, expect, it } from 'vitest'
import { cadenceOfTrack } from '../cadenceMetrics'
import { createEmptyTrace, type CadenceTrace } from '../cadenceTrace'
import { prepareLiveStream, simulateDirector, structuralAlignment, type LiveStream } from '../directorReplay'
import type { EventCellRecord } from '../eventReplay'
import { buildStream, CHORUS, VERSE } from '../../events/__tests__/cellFactory'
import type { SectionEvent } from '../../events/types'
import { SHOW } from '../../../engine/show/showPolicy'

/**
 * `simulateDirector` replays the REAL show director over a cached trace. These tests pin what the report rests on, on
 * hand-made traces where every frame is known: the inputs the adapter derives, the commit path (downbeat / immediate),
 * the decision log, and the outcome tallies (what became of the drops).
 */

const FPS = 60

/** A steady 4/4 grid at 120 BPM (a beat every 0.5 s = 30 frames), grid trusted. */
function makeTrace(seconds: number, opts: { structureValid?: boolean } = {}): CadenceTrace {
  const n = Math.round(seconds * FPS)
  const t = createEmptyTrace(n, FPS)
  const c = t.cols
  let beatIndex = 0
  for (let i = 0; i < n; i++) {
    if (i > 0 && i % 30 === 0) {
      beatIndex++
      c.beat[i] = 1
    }
    c.beatIndex[i] = beatIndex
    c.beatInBar[i] = beatIndex % 4
    c.bar[i] = Math.floor(beatIndex / 4)
    c.bpm10[i] = 1200
    c.confidence[i] = 230
    c.structureValid[i] = opts.structureValid ? 1 : 0
  }
  return t
}

const f = (sec: number): number => Math.round(sec * FPS)

/** `f.drop` high for 0.6 s from `sec` (the engine's latch): ONE rising edge. */
function dropAt(t: CadenceTrace, sec: number): void {
  for (let i = f(sec); i < f(sec + 0.6); i++) t.cols.drop[i] = 1
}

function sectionChangeAt(t: CadenceTrace, sec: number, novelty: number): void {
  t.cols.sectionChange[f(sec)] = 1
  t.cols.sectionChangeStrength[f(sec)] = Math.round(novelty * 100)
}

function range(t: CadenceTrace, col: 'isSustain' | 'isBreakdown' | 'silence', from: number, to: number): void {
  for (let i = f(from); i < f(to); i++) t.cols[col][i] = 1
}

describe('simulateDirector: the commit path', () => {
  it('a quiet track (no events) never changes scene: there is no timer, however long it plays', () => {
    const t = makeTrace(300)
    const r = simulateDirector(t)
    expect(r.commits).toHaveLength(0)
    expect(r.requests).toEqual([])
    expect(r.stats).toEqual({ hold: 0, micro: 0, cut: 0 })
    expect(r.edges).toEqual([])
  })

  it('a drop after a real build is a hard cut on the very next frame (the fast lane), and is reported as a release', () => {
    const t = makeTrace(40, { structureValid: true })
    range(t, 'isSustain', 8, 20)
    dropAt(t, 20)
    const r = simulateDirector(t)
    expect(r.commits).toHaveLength(1)
    const c = r.commits[0]
    expect(c.trigger).toBe('drop:drop-fast')
    expect(c.immediate).toBe(true)
    expect(c.timeSec).toBeGreaterThan(20)
    expect(c.timeSec).toBeLessThan(20.1)
    expect(r.releaseDrops).toMatchObject({ events: 1, cut: 1, fast: 1, refractory: 0 })
    expect(r.outcomes.drop).toMatchObject({ events: 1, cut: 1 })
  })

  it('a lone drop in a young scene is a MICRO (no scene change), with the numbers on the record', () => {
    const t = makeTrace(30)
    dropAt(t, 12) // 6 bars in, no build behind it
    const r = simulateDirector(t)
    expect(r.commits).toHaveLength(0)
    expect(r.outcomes.drop).toEqual({ events: 1, cut: 0, micro: 1, hold: 0 })
    const d = r.decisions.find((x) => x.eventType === 'drop')
    expect(d).toBeDefined()
    expect(d?.kind).toBe('MICRO')
    expect(d?.reason).toBe('below-T')
    expect(d?.S).toBeCloseTo(1.25 * 0.35, 2)
    expect(d?.credibility).toBe(1)
  })

  it('a lone drop in an OLD scene cuts, but on the next downbeat and not as a hard cut', () => {
    const t = makeTrace(40)
    dropAt(t, 22.75) // ~11 bars in: S 0.44 >= T(11) = 0.375
    const r = simulateDirector(t)
    expect(r.commits).toHaveLength(1)
    const c = r.commits[0]
    expect(c.trigger).toBe('drop:event')
    expect(c.immediate).toBe(false)
    expect(c.beat % 4).toBe(0)
    expect(c.timeSec).toBeGreaterThan(22.75)
    expect(c.timeSec).toBeLessThan(25)
  })

  it('a train of drops (one every 2 s) never changes the scene, and the later ones are discounted to a HOLD', () => {
    const t = makeTrace(40)
    for (let s = 8; s < 30; s += 2) dropAt(t, s)
    const r = simulateDirector(t)
    expect(r.commits).toHaveLength(0)
    const drops = r.decisions.filter((d) => d.eventType === 'drop')
    expect(drops.length).toBeGreaterThanOrEqual(10)
    expect(drops[0].credibility).toBe(1)
    const late = drops[drops.length - 1]
    expect(late.credibility).toBeLessThanOrEqual(0.5)
    expect(late.kind).toBe('HOLD')
    expect(late.reason).toBe('drop-noisy')
    expect(r.outcomes.drop.cut).toBe(0)
    expect(r.outcomes.drop.hold).toBeGreaterThan(r.outcomes.drop.micro)
  })

  it('a drop right after a breakdown counts as a release', () => {
    const t = makeTrace(40, { structureValid: true })
    range(t, 'isBreakdown', 6, 19)
    dropAt(t, 19.5)
    const r = simulateDirector(t)
    expect(r.releaseDrops.events).toBe(1)
    expect(r.releaseDrops.cut).toBe(1)
    expect(r.commits[0].trigger).toBe('drop:drop-fast')
  })

  it('silence consumes the edges: the director is not stepped, so a drop in silence decides nothing', () => {
    const t = makeTrace(40)
    range(t, 'silence', 10, 20)
    dropAt(t, 12)
    const r = simulateDirector(t)
    expect(r.decisions.filter((d) => d.eventType === 'drop')).toHaveLength(0)
    expect(r.outcomes.drop.events).toBe(0)
  })

  it('a change event is scored against the age threshold: an S = 0.7 event is a MICRO at 5 bars, and mood pressure tips it to a CUT', () => {
    const base = makeTrace(30)
    sectionChangeAt(base, 10, 0.53) // novelty 0.53 -> strength 0.745 -> S 0.71, at 5 bars (T = 0.825)
    const alone = simulateDirector(base)
    expect(alone.commits).toHaveLength(0)
    expect(alone.decisions.find((d) => d.eventType === 'change')?.kind).toBe('MICRO')

    const pressed = makeTrace(30)
    sectionChangeAt(pressed, 10, 0.53)
    pressed.cols.moodChanged[f(9.9)] = 1
    for (let i = 0; i < pressed.n; i++) {
      pressed.cols.moodConfidence[i] = 230
      pressed.cols.moodAmbiguity[i] = 30
    }
    const r = simulateDirector(pressed)
    expect(r.commits).toHaveLength(1)
    expect(r.commits[0].trigger).toBe('change:event')
    // with the pressure source switched off the same trace only tweaks
    expect(simulateDirector(pressed, { pressure: false }).commits).toHaveLength(0)
  })

  it('is deterministic, and its result feeds cadenceOfTrack like a legacy result', () => {
    const t = makeTrace(90)
    dropAt(t, 25)
    sectionChangeAt(t, 40, 1.2)
    const a = simulateDirector(t)
    const b = simulateDirector(t)
    expect(a.commits).toEqual(b.commits)
    expect(a.decisions).toEqual(b.decisions)
    const cad = cadenceOfTrack('x', t, a, { seed: 3, chanceCopies: 4 })
    expect(cad.commits).toBe(a.commits.length)
    expect(Object.keys(cad.triggers).every((k) => k.includes(':'))).toBe(true)
  })
})

describe('simulateDirector: outcome tallies', () => {
  it('counts each distinct event once, by its final type and best outcome', () => {
    const t = makeTrace(60)
    sectionChangeAt(t, 12, 0.2) // a weak change (novelty just above the mapping floor): S 0.09, HOLD
    sectionChangeAt(t, 40, 1.2) // a strong one at a mature age: CUT
    const r = simulateDirector(t)
    expect(r.outcomes.change.events).toBe(2)
    expect(r.outcomes.change.hold).toBe(1)
    expect(r.outcomes.change.cut).toBe(1)
    expect(r.outcomes.drop.events).toBe(0)
    expect(r.stats.cut).toBe(r.commits.length)
  })
})

describe('structuralAlignment', () => {
  it('measures |commit - nearest structural event| against a random-phase control (and ignores f.drop)', () => {
    const t = makeTrace(60)
    sectionChangeAt(t, 10, 1)
    sectionChangeAt(t, 30, 1)
    dropAt(t, 50) // not a structural event
    const a = structuralAlignment(t, [10.5, 50], { chanceCopies: 5, seed: 2 })
    expect(a.events).toBe(2)
    expect(a.commits).toBe(2)
    expect(a.real).toHaveLength(2)
    expect(a.real[0]).toBeCloseTo(0.5, 1)
    expect(a.real[1]).toBeCloseTo(20, 0) // 50 s is 20 s from the nearest structural event
    expect(a.chance).toHaveLength(10)
    // deterministic for a seed
    expect(structuralAlignment(t, [10.5, 50], { chanceCopies: 5, seed: 2 }).chance).toEqual(a.chance)
  })

  it('has no samples when there are no commits or no events', () => {
    const t = makeTrace(30)
    expect(structuralAlignment(t, [5]).real).toEqual([])
    sectionChangeAt(t, 10, 1)
    const none = structuralAlignment(t, [])
    expect(none.real).toEqual([])
    expect(none.chance).toEqual([])
  })
})

// --- The v2 event source (lane W3): the live stream merged as the adapter does, and the anchored commit ---------------

function liveEvent(over: Partial<SectionEvent> = {}): SectionEvent {
  return {
    id: 1,
    type: 'change',
    strength: 1,
    confidence: 1,
    boundaryBeat: 36,
    boundaryTime: 18,
    detectedAtBeat: 40,
    detectedAtTime: 20,
    source: 'live',
    phase: 0,
    feats: { level: 0, low: 0, timbre: 5, harmony: 0, rhythm: 0 },
    ...over,
  }
}

/** A hand-made live stream: `events` delivered at the given frames, `toLine` -1 everywhere except where set. */
function stream(n: number, events: Array<{ frame: number; event: SectionEvent }>, toLine: Record<number, number> = {}): LiveStream {
  const byFrame = new Map<number, SectionEvent[]>()
  for (const e of events) byFrame.set(e.frame, [...(byFrame.get(e.frame) ?? []), e.event])
  const tl = new Int8Array(n).fill(-1)
  for (const [k, v] of Object.entries(toLine)) tl[Number(k)] = v
  return { byFrame, events, toLine: tl, cells: { matched: 0, mismatched: 0, unplaced: 0 }, lastFrame: n - 1 }
}

describe('simulateDirector: the v2 event source (options.live)', () => {
  it('without options.live nothing changes: a section change is a legacy change event, exactly as before', () => {
    const t = makeTrace(60)
    sectionChangeAt(t, 40, 1.2)
    const r = simulateDirector(t)
    expect(r.commits.map((c) => c.trigger)).toEqual(['change:event'])
  })

  it('masks the legacy section change and delivers the live change instead (a live change scores x liveGain)', () => {
    const t = makeTrace(60)
    sectionChangeAt(t, 40, 1.2) // legacy: a change at 40 s; masked in v2 mode
    const none = simulateDirector(t, { live: stream(t.n, []) })
    expect(none.decisions.filter((d) => d.eventType === 'change')).toHaveLength(0)
    // a live change at 20 s (10 bars old, T = 0.45): S = 0.9 * 0.7 * liveGain is well above it
    const ev = liveEvent({ strength: 0.9, confidence: 0.7 })
    const r = simulateDirector(t, { live: stream(t.n, [{ frame: f(20), event: ev }]) })
    const d = r.decisions.find((x) => x.eventType === 'change')
    expect(d?.kind).toBe('CUT')
    expect(d?.S).toBeCloseTo(0.9 * 0.7 * SHOW.liveGain, 2)
    expect(r.commits[0].trigger).toBe('change:event')
    expect(r.commits[0].timeSec).toBeGreaterThan(20)
  })

  it('keeps the legacy drop path: a release-backed drop still hard-cuts under v2 while the sectionChange beside it is masked', () => {
    const t = makeTrace(40, { structureValid: true })
    range(t, 'isSustain', 8, 20)
    dropAt(t, 20)
    sectionChangeAt(t, 20.2, 1.2)
    const r = simulateDirector(t, { live: stream(t.n, []) })
    expect(r.commits).toHaveLength(1)
    expect(r.commits[0].trigger).toBe('drop:drop-fast')
    expect(r.outcomes.change.events).toBe(0)
  })

  it('commits on the ANCHORED downbeat (commitGrid anchored), not on f.beatInBar === 0', () => {
    const t = makeTrace(60)
    // anchored bar lines are beats 2, 6, 10, ... (beat index % 4 === 2): toLine counts down 3, 2, 1, 0 over each bar.
    const toLine: Record<number, number> = {}
    for (let i = 0; i < t.n; i++) if (t.cols.beat[i] === 1) toLine[i] = (((2 - t.cols.beatIndex[i]) % 4) + 4) % 4
    // a change delivered at 20.1 s (mid-beat, so the commit waits for a downbeat)
    const s = stream(t.n, [{ frame: f(20.1), event: liveEvent() }], toLine)
    const anchored = simulateDirector(t, { live: s, commitGrid: 'anchored' })
    const legacyGrid = simulateDirector(t, { live: s, commitGrid: 'legacy' })
    expect(anchored.commits).toHaveLength(1)
    expect(legacyGrid.commits).toHaveLength(1)
    expect(anchored.commits[0].beat % 4).toBe(2) // an anchored downbeat
    expect(legacyGrid.commits[0].beat % 4).toBe(0) // the arbitrary-phase one
    expect(anchored.commits[0].beat).toBeGreaterThan(40)
  })

  it('an unconfident anchored grid (toLine -1) falls back to f.beatInBar === 0: the same commit as the legacy grid', () => {
    const t = makeTrace(60)
    const s = stream(t.n, [{ frame: f(20.1), event: liveEvent() }])
    const a = simulateDirector(t, { live: s, commitGrid: 'anchored' })
    const b = simulateDirector(t, { live: s, commitGrid: 'legacy' })
    expect(a.commits).toEqual(b.commits)
    expect(a.commits[0].beat % 4).toBe(0)
  })

  it('endSec stops the replay: nothing after it is decided', () => {
    const t = makeTrace(90)
    sectionChangeAt(t, 60, 1.2) // a strong change at a mature age: a CUT
    const full = simulateDirector(t)
    const cut = simulateDirector(t, { endSec: 30 })
    expect(full.commits).toHaveLength(1)
    expect(cut.commits).toHaveLength(0)
  })
})

describe('prepareLiveStream', () => {
  const SR = 44100
  const OFF = 2048 / SR

  /** Cells on a 120 BPM grid (a beat every 30 frames), stamped as events-cache does: window start + FFT_SIZE / sampleRate. */
  function records(sections: Parameters<typeof buildStream>[0]): { t: CadenceTrace; cells: EventCellRecord[] } {
    const { cells } = buildStream(sections, 3, 1)
    const t = makeTrace(cells.length * 0.5 + 8)
    const recs: EventCellRecord[] = cells.map((cell) => {
      const frame = cell.beat * 30
      return { cell, beat: cell.beat, time: frame / FPS + OFF, bpm: 120, locked: false, offset: 0 }
    })
    return { t, cells: recs }
  }

  it('places every cell on the trace frame of the same beat, and delivers a verse -> chorus change on a beat frame', () => {
    const { t, cells } = records([[VERSE, 64], [CHORUS, 64]])
    const live = prepareLiveStream(t, cells, SR)
    expect(live.cells).toEqual({ matched: cells.length, mismatched: 0, unplaced: 0 })
    const change = live.events.filter((e) => e.event.type === 'change')
    expect(change.length).toBeGreaterThanOrEqual(1)
    for (const e of live.events) {
      expect(t.cols.beat[e.frame]).toBe(1)
      expect(live.byFrame.get(e.frame)).toContain(e.event)
      expect(e.event.source).toBe('live')
    }
    // the layer confirms about six beats after the change at beat 64 (frame 64 * 30)
    expect(change[0].frame).toBeGreaterThan(64 * 30)
    expect(change[0].frame).toBeLessThan(80 * 30)
    expect(live.toLine).toHaveLength(t.n)
  })

  it('the director fed that stream cuts on the v2 change (trigger change:event) and is deterministic', () => {
    const { t, cells } = records([[VERSE, 64], [CHORUS, 64]])
    const live = prepareLiveStream(t, cells, SR)
    const a = simulateDirector(t, { live, commitGrid: 'anchored' })
    const b = simulateDirector(t, { live, commitGrid: 'anchored' })
    expect(a.commits).toEqual(b.commits)
    const cut = a.commits.find((c) => String(c.trigger) === 'change:event')
    expect(cut).toBeDefined()
    expect(cut?.timeSec).toBeGreaterThan(32) // after the change at beat 64 = 32 s
  })

  it('reports cells it cannot place (beyond the trace) and cells whose beat index disagrees', () => {
    const { t, cells } = records([[VERSE, 30]])
    const shifted = cells.map((r, k) => (k === 5 ? { ...r, beat: r.beat + 1000 } : r))
    const far = [...shifted, { ...cells[0], time: 9999 }]
    const live = prepareLiveStream(t, far, SR)
    expect(live.cells.unplaced).toBe(1)
    expect(live.cells.mismatched).toBe(1)
    expect(live.cells.matched).toBe(cells.length - 1)
  })
})
