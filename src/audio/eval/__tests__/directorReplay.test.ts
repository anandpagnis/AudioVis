import { describe, expect, it } from 'vitest'
import { cadenceOfTrack } from '../cadenceMetrics'
import { createEmptyTrace, type CadenceTrace } from '../cadenceTrace'
import { simulateDirector, structuralAlignment } from '../directorReplay'

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
  it('a quiet track changes scene once, at the forced ceiling (60 s at 120 BPM), on the first downbeat after it', () => {
    const t = makeTrace(90)
    const r = simulateDirector(t)
    expect(r.commits).toHaveLength(1)
    const c = r.commits[0]
    expect(c.trigger).toBe('forced:forced-bar')
    expect(c.immediate).toBe(false)
    expect(c.kind).toBe('level')
    // requested on the last beat of a bar (beat 123, 61.5 s), committed on the next downbeat (beat 124 = 62 s)
    expect(c.requestBeat).toBe(123)
    expect(c.beat).toBe(124)
    expect(c.beat % 4).toBe(0)
    expect(c.timeSec).toBeCloseTo(62, 1)
    expect(r.stats.forced).toBe(1)
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

  it('a change event is scored against the age threshold: an S = 0.8 event is a MICRO at 5 bars, and mood pressure tips it to a CUT', () => {
    const base = makeTrace(30)
    sectionChangeAt(base, 10, 0.86) // novelty 0.86 -> strength 0.85 -> S 0.81, at 5 bars (T = 0.825)
    const alone = simulateDirector(base)
    expect(alone.commits).toHaveLength(0)
    expect(alone.decisions.find((d) => d.eventType === 'change')?.kind).toBe('MICRO')

    const pressed = makeTrace(30)
    sectionChangeAt(pressed, 10, 0.86)
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
    sectionChangeAt(t, 12, 0.5) // a weak change: HOLD
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
