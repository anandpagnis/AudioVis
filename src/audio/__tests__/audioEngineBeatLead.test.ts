import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { audioEngine } from '../AudioEngine'
import {
  BEAT_LEAD_MAX_SEC,
  BEAT_LEAD_MIN_SEC,
  BEAT_LEAD_SEC,
  BEAT_OFFSET_MAX_MS,
  BEAT_OFFSET_MIN_MS,
  beatLeadSec,
  beatOffsetMs,
} from '../beatLead'

/**
 * `advanceGrid` (private) is driven directly on the real singleton, like `audioEngineDownbeat.test.ts`: there is
 * no mocked Web Audio graph in this suite, and the beat lead only needs the grid (period / phase / confidence on
 * the public `bpmEstimator`) plus the per-frame inputs `advanceGrid` reads (`f.bass`, `f.delta`, `f.silence`).
 */

const DT = 1 / 60
const T0 = 100.013

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EngineAny = any

interface Frame {
  t: number
  beat: boolean
  beatIndex: number
  progress: number
  nextBeatTime: number
  strength: number
}

function run(opts: { lead: number; period: number; phase: number; seconds: number; bass?: (t: number) => number }): Frame[] {
  // Fresh grid state every run: lastGridIndex, beatIndex and the strength memory must not carry over.
  audioEngine.stop()
  const engine = audioEngine as EngineAny
  const f = audioEngine.features
  engine.beatLeadSec = opts.lead
  const est = engine.bpmEstimator
  est.period = opts.period
  est.phase = opts.phase
  est.confidence = 0.9
  f.delta = DT
  f.silence = false
  const out: Frame[] = []
  const frames = Math.floor(opts.seconds / DT)
  for (let k = 0; k < frames; k++) {
    const now = T0 + k * DT
    f.bass = opts.bass ? opts.bass(now) : 0.5
    f.sub = f.bass
    engine.advanceGrid(now, f)
    out.push({
      t: now,
      beat: f.beat,
      beatIndex: f.beatIndex,
      progress: f.beatProgress,
      nextBeatTime: f.nextBeatTime,
      strength: f.beatStrength,
    })
  }
  return out
}

describe('AudioEngine.advanceGrid: published-beat lead', () => {
  beforeEach(() => {
    audioEngine.stop()
  })
  afterEach(() => {
    audioEngine.stop()
    ;(audioEngine as EngineAny).beatLeadSec = beatLeadSec()
  })

  it('the engine starts with the built-in lead (no ?beatoffset in the test environment)', () => {
    expect((audioEngine as EngineAny).beatLeadSec).toBe(BEAT_LEAD_SEC)
  })

  it('lead 0 is exactly the grid as the estimator has it (byte-identical to the pre-lead behaviour)', () => {
    const period = 0.5
    const phase = 0.123
    const frames = run({ lead: 0, period, phase, seconds: 20 })
    let prevIdx = Math.floor((frames[0].t - phase) / period)
    for (const fr of frames.slice(1)) {
      const idx = Math.floor((fr.t - phase) / period)
      // The reference: the original formulas, evaluated independently.
      expect(fr.progress).toBe((fr.t - phase) / period - idx)
      expect(fr.nextBeatTime).toBe(phase + (idx + 1) * period)
      expect(fr.beat).toBe(idx > prevIdx)
      prevIdx = idx
    }
  })

  it('a positive lead moves every crossing earlier by the lead (to within one frame)', () => {
    const period = 0.5
    const phase = 0.123
    const lead = 0.04
    const base = run({ lead: 0, period, phase, seconds: 30 })
    const led = run({ lead, period, phase, seconds: 30 })
    const baseBeats = base.filter((fr) => fr.beat).map((fr) => fr.t)
    const ledBeats = led.filter((fr) => fr.beat).map((fr) => fr.t)
    expect(ledBeats.length).toBe(baseBeats.length)
    // Exact crossing times of the lead grid are k*period + phase - lead; a frame catches each within one DT.
    for (let i = 0; i < ledBeats.length; i++) {
      const ideal = phase + (Math.floor((ledBeats[i] - phase + lead) / period)) * period - lead
      expect(ledBeats[i] - ideal).toBeGreaterThanOrEqual(-1e-9)
      expect(ledBeats[i] - ideal).toBeLessThan(DT + 1e-9)
    }
    // ...and every one of them lands no later than the no-lead crossing it corresponds to.
    for (let i = 0; i < ledBeats.length; i++) expect(ledBeats[i]).toBeLessThanOrEqual(baseBeats[i] + 1e-9)
    const meanShift = baseBeats.reduce((a, b, i) => a + (b - ledBeats[i]), 0) / baseBeats.length
    expect(meanShift).toBeGreaterThan(lead - DT)
    expect(meanShift).toBeLessThan(lead + DT)
  })

  it('never double-fires, skips, or goes out of range: one beat per period, progress in [0, 1), index +1 per beat', () => {
    for (const [bpm, lead] of [[60, 0.04], [90, 0.2], [120, 0.04], [170, 0.1], [200, 0.2], [120, -0.1], [120, 0]] as const) {
      const period = 60 / bpm
      const frames = run({ lead, period, phase: 0.31, seconds: 40 })
      let beats = 0
      let lastBeatT = -Infinity
      let lastIndex = frames[0].beatIndex
      for (const fr of frames) {
        expect(fr.progress, `${bpm}/${lead} progress`).toBeGreaterThanOrEqual(0)
        expect(fr.progress, `${bpm}/${lead} progress`).toBeLessThan(1)
        expect(Number.isFinite(fr.nextBeatTime)).toBe(true)
        if (fr.beat) {
          beats++
          expect(fr.beatIndex).toBe(lastIndex + 1)
          expect(fr.t - lastBeatT).toBeGreaterThanOrEqual(period - DT - 1e-9)
          lastBeatT = fr.t
        }
        lastIndex = fr.beatIndex
      }
      const expected = Math.floor(40 / period)
      expect(Math.abs(beats - expected), `${bpm}/${lead} beats`).toBeLessThanOrEqual(1)
    }
  })

  it('nextBeatTime is expressed on the lead clock: it equals the next crossing the frame loop will see', () => {
    const period = 0.5
    const phase = 0.2
    const lead = 0.04
    const frames = run({ lead, period, phase, seconds: 6 })
    for (let i = 0; i < frames.length - 1; i++) {
      const fr = frames[i]
      // The next beat fires on the first frame at or after nextBeatTime.
      const next = frames.slice(i + 1).find((x) => x.beat)
      if (!next) break
      expect(next.t).toBeGreaterThanOrEqual(fr.nextBeatTime - 1e-9)
      expect(next.t - fr.nextBeatTime).toBeLessThan(period)
    }
  })

  it('beatStrength does not collapse when the grid crosses BEFORE the kick reaches the bands', () => {
    // A kick every beat: bass spikes to 0.9 just after each grid line and decays fast. With a lead the crossing
    // precedes the spike, so f.bass at the crossing is the decayed previous hit; the strength must still reflect
    // the previous peak (a steady kick repeats), not the trough.
    const period = 0.5
    const phase = 0.0
    const bassAt = (t: number) => {
      const since = (((t - phase) % period) + period) % period
      return 0.15 + 0.75 * Math.exp(-since / 0.06)
    }
    const led = run({ lead: 0.04, period, phase: phase - 0.04, seconds: 20, bass: bassAt })
    const plain = run({ lead: 0, period, phase, seconds: 20, bass: bassAt })
    const ledStrengths = led.filter((fr) => fr.beat && fr.t > 8).map((fr) => fr.strength)
    const plainStrengths = plain.filter((fr) => fr.beat && fr.t > 8).map((fr) => fr.strength)
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
    // Comparable to the no-lead reading (which sees the spike at its crossing), not a fraction of it.
    expect(mean(ledStrengths)).toBeGreaterThan(0.8 * mean(plainStrengths))
    for (const s of ledStrengths) expect(s).toBeLessThanOrEqual(1)
  })

  it('resetAnalysis (stop) clears the per-beat strength memory', () => {
    run({ lead: 0.04, period: 0.5, phase: 0, seconds: 5, bass: () => 0.9 })
    const engine = audioEngine as EngineAny
    expect(engine.beatPeakBass).toBeGreaterThan(0)
    audioEngine.stop()
    expect(engine.beatPeakBass).toBe(0)
    expect(engine.lastBeatAt).toBe(-1)
  })
})

describe('beatLead: ?beatoffset reader', () => {
  it('defaults to the built-in lead and a zero nudge', () => {
    expect(beatOffsetMs('')).toBe(0)
    expect(beatLeadSec('')).toBe(BEAT_LEAD_SEC)
  })

  it('adds the nudge (in ms) to the built-in lead, either sign', () => {
    expect(beatOffsetMs('?beatoffset=25')).toBe(25)
    expect(beatLeadSec('?beatoffset=25')).toBeCloseTo(BEAT_LEAD_SEC + 0.025, 12)
    expect(beatLeadSec('?beatoffset=-30')).toBeCloseTo(BEAT_LEAD_SEC - 0.03, 12)
    expect(beatLeadSec('?a=1&beatoffset=10&b=2')).toBeCloseTo(BEAT_LEAD_SEC + 0.01, 12)
  })

  it('a nudge that cancels the built-in lead gives exactly 0 (the pre-lead behaviour)', () => {
    expect(beatLeadSec(`?beatoffset=${-BEAT_LEAD_SEC * 1000}`)).toBeCloseTo(0, 12)
  })

  it('clamps the nudge and the total lead to a safe range', () => {
    expect(beatOffsetMs('?beatoffset=99999')).toBe(BEAT_OFFSET_MAX_MS)
    expect(beatOffsetMs('?beatoffset=-99999')).toBe(BEAT_OFFSET_MIN_MS)
    expect(beatLeadSec('?beatoffset=99999')).toBe(BEAT_LEAD_MAX_SEC)
    expect(beatLeadSec('?beatoffset=-99999')).toBe(BEAT_LEAD_MIN_SEC)
  })

  it('ignores garbage: absent, empty, not a number, infinite', () => {
    for (const s of ['?beatoffset=', '?beatoffset=abc', '?beatoffset=NaN', '?beatoffset=Infinity', '?beatoffset', '?other=5']) {
      expect(beatOffsetMs(s), s).toBe(0)
    }
  })

  it('reads location.search by default and survives a throwing location', () => {
    const g = globalThis as { location?: unknown }
    const prev = g.location
    try {
      g.location = { search: '?beatoffset=15' }
      expect(beatOffsetMs()).toBe(15)
      g.location = {
        get search(): string {
          throw new Error('blocked')
        },
      }
      expect(beatOffsetMs()).toBe(0)
    } finally {
      g.location = prev
    }
  })
})

describe('AudioEngine.advanceGrid: a moving grid never double-counts a beat', () => {
  beforeEach(() => {
    audioEngine.stop()
  })
  afterEach(() => {
    audioEngine.stop()
    ;(audioEngine as EngineAny).beatLeadSec = beatLeadSec()
  })

  /** Run frames, calling `mutate(k, est)` before each so a test can move the grid the way the PLL / acquisition do. */
  function runWith(opts: { lead: number; period: number; seconds: number; mutate: (k: number, est: EngineAny) => void }): {
    beats: number[]
    indices: number[]
  } {
    audioEngine.stop()
    const engine = audioEngine as EngineAny
    const f = audioEngine.features
    engine.beatLeadSec = opts.lead
    const est = engine.bpmEstimator
    est.period = opts.period
    est.phase = 0.1
    est.confidence = 0.9
    f.delta = DT
    f.silence = false
    f.bass = 0.5
    const beats: number[] = []
    const indices: number[] = []
    for (let k = 0; k < Math.floor(opts.seconds / DT); k++) {
      const now = T0 + k * DT
      opts.mutate(k, est)
      engine.advanceGrid(now, f)
      if (f.beat) {
        beats.push(now)
        indices.push(f.beatIndex)
      }
    }
    return { beats, indices }
  }

  it('a forward phase slew across a crossing does not fire the same crossing twice', () => {
    // Slew the grid LATER by 0.3 period on the frame right after every 4th crossing: without the hold, the index
    // drops by one and the crossing fires again ~0.3 period later (a double beat that shifts every bar phase).
    const period = 0.5
    let crossings = 0
    let lastBeatFrame = -10
    const { beats } = runWith({
      lead: 0.04,
      period,
      seconds: 40,
      mutate: (k, est) => {
        if (k === lastBeatFrame + 1) {
          crossings++
          if (crossings % 4 === 0) est.phase += 0.3 * period
        }
        // Track the frame a beat fired on (set by the loop below via the engine's own flag).
        if (audioEngine.features.beat) lastBeatFrame = k
      },
    })
    for (let i = 1; i < beats.length; i++) {
      // Never two beats closer than a fraction of the period: a double count is ~0.3 * period apart or less.
      expect(beats[i] - beats[i - 1], `beat ${i}`).toBeGreaterThan(0.45 * period)
    }
  })

  it('a backward slew fires at most one early beat and never a burst', () => {
    const period = 0.5
    const { beats } = runWith({
      lead: 0.04,
      period,
      seconds: 30,
      mutate: (k, est) => {
        if (k % 200 === 100) est.phase -= 0.35 * period
      },
    })
    for (let i = 1; i < beats.length; i++) expect(beats[i] - beats[i - 1]).toBeGreaterThan(0.2 * period)
    // Still one beat per period overall, plus the beats the grid legitimately gained by moving EARLIER: nine slews of
    // 0.35 period is 3.15 periods of shift, so ~3 extra beats (+2 for frame-edge rounding). A burst would be far more.
    expect(beats.length).toBeLessThanOrEqual(Math.ceil(30 / period + 9 * 0.35) + 2)
  })

  it('a large re-anchor (grid index far behind, as after a reset or an external clock) resyncs and keeps beating', () => {
    const period = 0.5
    const { beats } = runWith({
      lead: 0.04,
      period,
      seconds: 30,
      mutate: (k, est) => {
        // At ~10 s the phase jumps FORWARD by 50 periods (idx falls by ~50): must resync, not stall for 25 s.
        if (k === 600) est.phase += 50 * period
      },
    })
    const after = beats.filter((t) => t > T0 + 10.5)
    expect(after.length).toBeGreaterThan(30) // ~19 s remain at 2 beats/s
    expect(after[0] - (T0 + 10)).toBeLessThan(period + 0.1)
  })
})
