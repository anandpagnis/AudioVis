import { describe, expect, it } from 'vitest'
import {
  BeatSalienceGatherer,
  DEFAULT_DOWNBEAT_CONFIG,
  DownbeatEstimator,
  barPosition,
  isPhraseEdge,
  type BeatSalienceFrame,
} from '../downbeat'

/** Small deterministic PRNG (mulberry32) so noise tests are reproducible. */
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface FeedOpts {
  /** First beatIndex fed. */
  start?: number
  /** Beats to feed. */
  beats: number
  /** Salience by bar position (0 = the true downbeat). */
  pattern: number[]
  /** beatIndex mod 4 of the true downbeats. */
  phase: number
  /** Multiplicative noise, +-noise/2 around 1 (0 = none). */
  noise?: number
  rand?: () => number
  usable?: boolean
}

/** Feed a periodic pattern; returns the next beatIndex to feed. */
function feed(est: DownbeatEstimator, o: FeedOpts): number {
  const start = o.start ?? 0
  const rand = o.rand ?? rng(1)
  for (let i = 0; i < o.beats; i++) {
    const bi = start + i
    const pos = (((bi - o.phase) % 4) + 4) % 4
    const n = o.noise ? 1 + (rand() - 0.5) * o.noise : 1
    est.update(bi, o.pattern[pos] * n, o.usable ?? true)
  }
  return start + o.beats
}

const ONE_HEAVY = [1.0, 0.3, 0.5, 0.3]
const BARS = (n: number) => n * 4

describe('barPosition', () => {
  it('offset 0 is exactly the legacy % 4 / 4 / 16 derivation', () => {
    for (let b = 0; b < 200; b++) {
      const p = barPosition(b, 0)
      expect(p.beatInBar).toBe(b % 4)
      expect(p.bar).toBe(Math.floor(b / 4))
      expect(p.measure).toBe(Math.floor(b / 16))
    }
  })

  it('a non-zero offset moves the bar line; beatInBar/bar stay mutually consistent', () => {
    for (const o of [1, 2, 3]) {
      for (let b = 8; b < 100; b++) {
        const p = barPosition(b, o)
        expect(p.beatInBar).toBe((b - o) % 4)
        expect(p.bar * 4 + p.beatInBar).toBe(b - o)
        expect(p.measure).toBe(Math.floor((b - o) / 16))
      }
      // beat 1 falls where beatIndex === offset (mod 4)
      expect(barPosition(8 + o, o).beatInBar).toBe(0)
    }
  })

  it('stays in range and never negative, even for a beatIndex smaller than the offset or garbage', () => {
    for (const o of [0, 1, 2, 3]) {
      for (let b = 0; b < 4; b++) {
        const p = barPosition(b, o)
        expect(p.beatInBar).toBeGreaterThanOrEqual(0)
        expect(p.beatInBar).toBeLessThan(4)
        expect(p.bar).toBeGreaterThanOrEqual(0)
        expect(p.measure).toBeGreaterThanOrEqual(0)
      }
    }
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(() => barPosition(bad, 0)).not.toThrow()
      expect(() => barPosition(4, bad)).not.toThrow()
      expect(barPosition(bad, bad)).toEqual({ beatInBar: 0, bar: 0, measure: 0 })
    }
  })
})

describe('isPhraseEdge', () => {
  it('matches the legacy beatInBar===0 && beatIndex%16===0 test at offset 0', () => {
    for (let b = 0; b < 300; b++) {
      const p = barPosition(b, 0)
      const legacy = p.beatInBar === 0 && b > 0 && b % 16 === 0
      expect(isPhraseEdge(true, p.beatInBar, p.bar)).toBe(legacy)
    }
  })

  it('still fires once per 16 beats with a non-zero offset (where the legacy expression is dead)', () => {
    for (const o of [1, 2, 3]) {
      let edges = 0
      let legacyEdges = 0
      for (let b = 0; b < 160; b++) {
        const p = barPosition(b, o)
        if (isPhraseEdge(true, p.beatInBar, p.bar)) edges++
        if (p.beatInBar === 0 && b > 0 && b % 16 === 0) legacyEdges++
      }
      expect(legacyEdges).toBe(0)
      expect(edges).toBeGreaterThanOrEqual(8)
      expect(edges).toBeLessThanOrEqual(10)
    }
  })

  it('needs a beat crossing', () => {
    expect(isPhraseEdge(false, 0, 8)).toBe(false)
  })
})

describe('DownbeatEstimator: finds a clear downbeat', () => {
  it('a 1-heavy pattern is found at every one of the four starting phases', () => {
    for (const phase of [0, 1, 2, 3]) {
      for (const start of [0, 1, 6, 37]) {
        const est = new DownbeatEstimator()
        feed(est, { start, beats: BARS(40), pattern: ONE_HEAVY, phase })
        expect(est.locked).toBe(true)
        expect(est.offset).toBe(phase)
        expect(est.confidence).toBeGreaterThan(0.6)
        // ...and the derived beatInBar is 0 exactly on the true downbeats.
        for (let b = 200; b < 216; b++) {
          const inBar = barPosition(b, est.offset).beatInBar
          expect(inBar === 0).toBe(b % 4 === phase)
        }
      }
    }
  })

  it('kick on 1 and 3 with 1 clearly stronger still finds 1', () => {
    for (const phase of [0, 1, 2, 3]) {
      const est = new DownbeatEstimator()
      feed(est, { beats: BARS(40), pattern: [1.0, 0.05, 0.55, 0.05], phase })
      expect(est.locked).toBe(true)
      expect(est.offset).toBe(phase)
    }
  })

  it('a consistent ~1.3x accent of 1 over 3 (what a saturating kick detector leaves of a 1.8x kick) is adopted; ~1.15x is not', () => {
    for (const phase of [0, 1, 2, 3]) {
      const est = new DownbeatEstimator()
      feed(est, { beats: BARS(60), pattern: [0.78, 0.03, 0.6, 0.03], phase, noise: 0.1, rand: rng(20 + phase) })
      expect(est.locked).toBe(true)
      expect(est.offset).toBe(phase)
      const weak = new DownbeatEstimator()
      feed(weak, { beats: BARS(60), pattern: [0.69, 0.03, 0.6, 0.03], phase, noise: 0.1, rand: rng(30 + phase) })
      expect(weak.locked).toBe(false)
      expect(weak.offset).toBe(0)
    }
  })

  it('needs real evidence: nothing is adopted in the first several bars', () => {
    const est = new DownbeatEstimator()
    feed(est, { beats: BARS(DEFAULT_DOWNBEAT_CONFIG.minVisits - 1), pattern: ONE_HEAVY, phase: 2 })
    expect(est.locked).toBe(false)
    expect(est.offset).toBe(0)
    expect(est.confidence).toBe(0)
  })

  it('scale-free: the same pattern at 1000x the level (or 0.1x, still above the absolute floor) gives the same answer', () => {
    for (const scale of [0.1, 1, 1e3]) {
      const est = new DownbeatEstimator()
      feed(est, { beats: BARS(40), pattern: ONE_HEAVY.map((v) => v * scale), phase: 3 })
      expect(est.offset).toBe(3)
      expect(est.locked).toBe(true)
    }
  })

  it('noisy salience (+-30 %) around a 1-heavy pattern is still found, across seeds', () => {
    let found = 0
    const trials = 20
    for (let seed = 1; seed <= trials; seed++) {
      const est = new DownbeatEstimator()
      const phase = seed % 4
      feed(est, { beats: BARS(60), pattern: [1.0, 0.4, 0.6, 0.4], phase, noise: 0.6, rand: rng(seed) })
      if (est.locked && est.offset === phase) found++
      // never locks onto the WRONG phase
      if (est.locked) expect(est.offset).toBe(phase)
    }
    expect(found).toBeGreaterThanOrEqual(trials * 0.9)
  })
})

describe('DownbeatEstimator: defaults to legacy (offset 0, unlocked) when it cannot be sure', () => {
  it('equal four-on-the-floor: low confidence, offset 0, over a long run', () => {
    for (const noise of [0, 0.1, 0.2]) {
      const est = new DownbeatEstimator()
      feed(est, { beats: BARS(300), pattern: [0.8, 0.8, 0.8, 0.8], phase: 2, noise, rand: rng(7) })
      expect(est.locked).toBe(false)
      expect(est.offset).toBe(0)
      expect(est.confidence).toBeLessThan(DEFAULT_DOWNBEAT_CONFIG.enterConf)
    }
  })

  it('kick on 1 and 3 with EQUAL weight: two phases tie, so no adoption', () => {
    for (const phase of [0, 1, 2, 3]) {
      const est = new DownbeatEstimator()
      feed(est, { beats: BARS(300), pattern: [1, 0.05, 1, 0.05], phase, noise: 0.1, rand: rng(3) })
      expect(est.locked).toBe(false)
      expect(est.offset).toBe(0)
    }
  })

  it('a mild accent (1.2x) is not enough', () => {
    const est = new DownbeatEstimator()
    feed(est, { beats: BARS(300), pattern: [1.2, 1, 1, 1], phase: 1, noise: 0.05, rand: rng(11) })
    expect(est.locked).toBe(false)
    expect(est.offset).toBe(0)
  })

  it('no kick / ambient: exactly-zero salience learns nothing', () => {
    const est = new DownbeatEstimator()
    feed(est, { beats: BARS(300), pattern: [0, 0, 0, 0], phase: 0 })
    expect(est.locked).toBe(false)
    expect(est.offset).toBe(0)
    expect(est.confidence).toBe(0)
    expect(est.candidate).toBe(-1)
  })

  it('no kick / ambient: weak random low-end movement is never mistaken for a downbeat', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const r = rng(seed)
      const est = new DownbeatEstimator()
      for (let b = 0; b < BARS(200); b++) est.update(b, r() * 0.08)
      expect(est.locked).toBe(false)
      expect(est.offset).toBe(0)
    }
  })

  it('pure noise never locks (many seeds, long runs)', () => {
    let locks = 0
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed * 7919)
      const est = new DownbeatEstimator()
      for (let b = 0; b < BARS(150); b++) est.update(b, r())
      if (est.locked) locks++
    }
    expect(locks).toBe(0)
  })

  it('heavy-tailed noise (occasional huge hits on random beats) never locks either', () => {
    let locks = 0
    for (let seed = 1; seed <= 100; seed++) {
      const r = rng(seed * 104729)
      const est = new DownbeatEstimator()
      for (let b = 0; b < BARS(150); b++) est.update(b, r() < 0.25 ? 0.5 + r() : 0.05 * r())
      if (est.locked) locks++
    }
    expect(locks).toBe(0)
  })

  it('a jittery grid on equal four-on-the-floor (hits displaced to a neighbouring beat, dropouts) stays legacy', () => {
    let locks = 0
    for (let seed = 1; seed <= 60; seed++) {
      const r = rng(seed * 31)
      const est = new DownbeatEstimator()
      const hits = new Float64Array(BARS(200) + 2)
      for (let b = 0; b < BARS(200); b++) {
        if (r() < 0.1) continue // dropout
        const target = r() < 0.2 ? b + (r() < 0.5 ? -1 : 1) : b // jitter across the beat boundary
        hits[Math.max(0, target)] += 0.8
      }
      for (let b = 0; b < BARS(200); b++) est.update(b, hits[b])
      if (est.locked) locks++
    }
    expect(locks).toBe(0)
  })

  it('a rotating 3-beat pattern (3/4 material folded into mod-4 bins) does not lock', () => {
    const est = new DownbeatEstimator()
    for (let b = 0; b < BARS(300); b++) est.update(b, b % 3 === 0 ? 1 : 0.3)
    expect(est.locked).toBe(false)
    expect(est.offset).toBe(0)
  })

  it('offset is 0 whenever unlocked, whatever the candidate is', () => {
    const est = new DownbeatEstimator()
    feed(est, { beats: BARS(9), pattern: [1, 0.3, 0.3, 0.3], phase: 3 })
    if (!est.locked) expect(est.offset).toBe(0)
    expect(est.candidate === -1 || est.candidate === 3).toBe(true)
  })
})

describe('DownbeatEstimator: hysteresis', () => {
  function lockedAt(phase: number): { est: DownbeatEstimator; next: number } {
    const est = new DownbeatEstimator()
    const next = feed(est, { beats: BARS(40), pattern: ONE_HEAVY, phase })
    expect(est.locked).toBe(true)
    expect(est.offset).toBe(phase)
    return { est, next }
  }

  it('a brief disagreement (2-3 bars) does not move an adopted offset', () => {
    for (const bars of [1, 2, 3, 4]) {
      const { est, next } = lockedAt(0)
      const n2 = feed(est, { start: next, beats: BARS(bars), pattern: ONE_HEAVY, phase: 2 })
      expect(est.offset).toBe(0)
      // ...and the original pattern resumes cleanly.
      feed(est, { start: n2, beats: BARS(30), pattern: ONE_HEAVY, phase: 0 })
      expect(est.offset).toBe(0)
      expect(est.locked).toBe(true)
    }
  })

  it('a sustained, clear disagreement re-anchors - but only after >= 4 bars of the challenger leading', () => {
    const { est, next } = lockedAt(0)
    let bi = next
    let changedAt = -1
    let firstChallengerBeat = -1
    const history = new Set<number>([est.offset])
    for (let i = 0; i < BARS(80); i++, bi++) {
      const pos = (((bi - 2) % 4) + 4) % 4
      est.update(bi, ONE_HEAVY[pos])
      history.add(est.offset)
      if (firstChallengerBeat < 0 && est.candidate === 2) firstChallengerBeat = bi
      if (changedAt < 0 && est.offset !== 0) changedAt = bi
    }
    expect(est.offset).toBe(2)
    expect(est.locked).toBe(true)
    // Exactly one move, straight to the new phase (no passing through the other two).
    expect([...history].sort()).toEqual([0, 2])
    // It had to lead for the full persistence window first.
    expect(firstChallengerBeat).toBeGreaterThan(0)
    expect(changedAt - firstChallengerBeat).toBeGreaterThanOrEqual(DEFAULT_DOWNBEAT_CONFIG.reanchorBeats - 1)
    expect(DEFAULT_DOWNBEAT_CONFIG.reanchorBeats).toBeGreaterThanOrEqual(16) // >= 4 bars
  })

  it('does not flap: an alternating disagreement (1 bar on, 3 bars off, repeated) never moves the offset', () => {
    const { est, next } = lockedAt(1)
    let bi = next
    const seen = new Set<number>()
    for (let round = 0; round < 12; round++) {
      bi = feed(est, { start: bi, beats: BARS(1), pattern: ONE_HEAVY, phase: 3 })
      bi = feed(est, { start: bi, beats: BARS(3), pattern: ONE_HEAVY, phase: 1 })
      seen.add(est.offset)
    }
    expect([...seen]).toEqual([1])
  })

  it('losing the kick (a breakdown) does NOT release an adopted offset', () => {
    const { est, next } = lockedAt(3)
    feed(est, { start: next, beats: BARS(60), pattern: [0, 0, 0, 0], phase: 0 })
    expect(est.locked).toBe(true)
    expect(est.offset).toBe(3)
  })

  it('never re-anchors while the grid is unusable, and a long grid loss drops the lock instead', () => {
    const { est, next } = lockedAt(1)
    // Short unusable stretch with a conflicting pattern: nothing changes.
    let bi = feed(est, { start: next, beats: 8, pattern: ONE_HEAVY, phase: 3, usable: false })
    expect(est.offset).toBe(1)
    expect(est.locked).toBe(true)
    // A long one: the lock is dropped (grid lost -> phase unrelated), NOT moved to the conflicting phase.
    bi = feed(est, { start: bi, beats: 200, pattern: ONE_HEAVY, phase: 3, usable: false })
    expect(est.locked).toBe(false)
    expect(est.offset).toBe(0)
    expect(bi).toBeGreaterThan(0)
  })

  it('unusable beats break the persistence run: a challenger interrupted every few beats never wins', () => {
    const { est, next } = lockedAt(0)
    let bi = next
    for (let round = 0; round < 40; round++) {
      bi = feed(est, { start: bi, beats: 10, pattern: ONE_HEAVY, phase: 2 })
      bi = feed(est, { start: bi, beats: 1, pattern: ONE_HEAVY, phase: 2, usable: false })
    }
    expect(est.offset).toBe(0)
  })

  it('does not adopt during silence-marked beats either', () => {
    const est = new DownbeatEstimator()
    feed(est, { beats: BARS(100), pattern: ONE_HEAVY, phase: 2, usable: false })
    expect(est.locked).toBe(false)
    expect(est.offset).toBe(0)
  })
})

describe('DownbeatEstimator: reset and beatIndex handling', () => {
  it('reset() returns to the legacy state; a new track does not inherit the old offset', () => {
    const est = new DownbeatEstimator()
    feed(est, { beats: BARS(40), pattern: ONE_HEAVY, phase: 3 })
    expect(est.offset).toBe(3)
    est.reset()
    expect(est.locked).toBe(false)
    expect(est.offset).toBe(0)
    expect(est.confidence).toBe(0)
    expect(est.candidate).toBe(-1)
    expect(est.phaseScores).toEqual([0, 0, 0, 0])
    // Right after the reset the old phase must not leak back in (a few bars of the new track).
    feed(est, { beats: BARS(4), pattern: ONE_HEAVY, phase: 1 })
    expect(est.offset).toBe(0)
    // A different phase on the next "track" is learned from scratch.
    feed(est, { start: 16, beats: BARS(40), pattern: ONE_HEAVY, phase: 1 })
    expect(est.offset).toBe(1)
  })

  it('a beatIndex that goes backwards resets (a new grid fed without an explicit reset)', () => {
    const est = new DownbeatEstimator()
    feed(est, { start: 500, beats: BARS(40), pattern: ONE_HEAVY, phase: 2 })
    expect(est.offset).toBe(2)
    est.update(3, 1)
    expect(est.locked).toBe(false)
    expect(est.offset).toBe(0)
  })

  it('duplicate beatIndex is ignored', () => {
    const a = new DownbeatEstimator()
    const b = new DownbeatEstimator()
    for (let i = 0; i < BARS(40); i++) {
      const s = ONE_HEAVY[(((i - 1) % 4) + 4) % 4]
      a.update(i, s)
      b.update(i, s)
      b.update(i, s * 50) // a repeat with a wild value must change nothing
    }
    expect(b.offset).toBe(a.offset)
    expect(b.phaseScores).toEqual(a.phaseScores)
  })

  it('beatIndex jumps of 1-4 (a frame hitch) do not corrupt the phase mapping', () => {
    for (const phase of [0, 1, 2, 3]) {
      const est = new DownbeatEstimator()
      const r = rng(99 + phase)
      let bi = 0
      for (let n = 0; n < 500; n++) {
        const step = r() < 0.15 ? 2 + Math.floor(r() * 3) : 1 // 2..4 now and then, as advanceGrid caps at 4
        bi += step
        est.update(bi, ONE_HEAVY[(((bi - phase) % 4) + 4) % 4])
      }
      expect(est.locked).toBe(true)
      expect(est.offset).toBe(phase)
    }
  })

  it('a jump larger than maxGap forgets the bins but keeps an adopted offset', () => {
    const est = new DownbeatEstimator()
    const next = feed(est, { beats: BARS(40), pattern: ONE_HEAVY, phase: 2 })
    est.update(next + DEFAULT_DOWNBEAT_CONFIG.maxGap + 5, 1)
    expect(est.offset).toBe(2)
    expect(est.locked).toBe(true)
    expect(est.confidence).toBe(0) // no evidence until the bins refill
    expect(est.phaseScores.every((v) => v <= 1)).toBe(true)
  })

  it('discontinuity(): keeps an adopted offset, forgets the evidence, and the normal rules can then move it', () => {
    const est = new DownbeatEstimator()
    const next = feed(est, { beats: BARS(40), pattern: ONE_HEAVY, phase: 1 })
    est.discontinuity()
    expect(est.locked).toBe(true)
    expect(est.offset).toBe(1)
    expect(est.confidence).toBe(0)
    // The grid really did slip: the true phase is now 3.
    feed(est, { start: next, beats: BARS(60), pattern: ONE_HEAVY, phase: 3 })
    expect(est.offset).toBe(3)
  })

  it('discontinuity() while unlocked keeps offset 0', () => {
    const est = new DownbeatEstimator()
    const next = feed(est, { beats: BARS(4), pattern: ONE_HEAVY, phase: 2 })
    est.discontinuity()
    expect(est.offset).toBe(0)
    expect(est.locked).toBe(false)
    expect(next).toBeGreaterThan(0)
  })
})

describe('DownbeatEstimator: garbage in never throws or poisons the state', () => {
  it('non-finite / negative / huge inputs are tolerated', () => {
    const est = new DownbeatEstimator()
    const bad = [NaN, Infinity, -Infinity, -5, 1e300, 0, -0]
    for (const b of bad) {
      for (const s of bad) {
        expect(() => est.update(b, s)).not.toThrow()
        expect(() => est.update(b, s, false)).not.toThrow()
      }
    }
    expect(() => est.discontinuity()).not.toThrow()
    expect(() => est.reset()).not.toThrow()
    expect(est.offset).toBe(0)
    expect(Number.isFinite(est.confidence)).toBe(true)
    expect(est.phaseScores.every(Number.isFinite)).toBe(true)
  })

  it('a valid stream after garbage still locks correctly', () => {
    const est = new DownbeatEstimator()
    for (let i = 0; i < 50; i++) est.update(NaN, NaN)
    for (let i = 0; i < 50; i++) est.update(i, NaN)
    est.reset()
    feed(est, { beats: BARS(40), pattern: ONE_HEAVY, phase: 1 })
    expect(est.offset).toBe(1)
    expect(est.locked).toBe(true)
  })

  it('NaN salience in the middle of a good stream only costs those beats', () => {
    const est = new DownbeatEstimator()
    const r = rng(5)
    for (let b = 0; b < BARS(80); b++) {
      const s = r() < 0.05 ? NaN : ONE_HEAVY[(((b - 2) % 4) + 4) % 4]
      est.update(b, s)
    }
    expect(est.offset).toBe(2)
    expect(est.locked).toBe(true)
  })

  it('outputs stay in range on any input', () => {
    const r = rng(1234)
    const est = new DownbeatEstimator()
    for (let b = 0; b < 2000; b++) {
      est.update(b + (r() < 0.02 ? 20 : 0), r() < 0.1 ? 1e6 : r(), r() > 0.05)
      expect(est.offset).toBeGreaterThanOrEqual(0)
      expect(est.offset).toBeLessThanOrEqual(3)
      expect(est.confidence).toBeGreaterThanOrEqual(0)
      expect(est.confidence).toBeLessThanOrEqual(1)
      if (!est.locked) expect(est.offset).toBe(0)
    }
  })
})

/* ------------------------------------------------------------------------------------------------ */

describe('BeatSalienceGatherer', () => {
  const FPS = 60
  const DT = 1 / FPS

  /**
   * Drive the gatherer over grid positions [from, to) at 60 fps with a 0.5 s beat. `kicks` maps a grid
   * position (in beats) to a strength; each is fired on the single frame that first reaches it.
   */
  function run(
    g: BeatSalienceGatherer,
    from: number,
    to: number,
    kicks: Array<[number, number]> = [],
    opts: { low?: (pos: number) => number; usable?: (pos: number) => boolean } = {},
  ) {
    const out: Array<{ beatIndex: number; salience: number; usable: boolean }> = []
    const beatsPerFrame = DT / 0.5
    const pending = kicks.map(([pos, k]) => ({ pos, k, done: false }))
    for (let pos = from; pos < to; pos += beatsPerFrame) {
      let trig = false
      let str = 0
      for (const p of pending) {
        if (!p.done && pos >= p.pos) {
          p.done = true
          trig = true
          str = Math.max(str, p.k)
        }
      }
      const frame: BeatSalienceFrame = {
        pos,
        kickTrigger: trig,
        kickStrength: str,
        low: opts.low ? opts.low(pos) : 0,
        dt: DT,
        usable: opts.usable ? opts.usable(pos) : true,
      }
      const r = g.frame(frame)
      if (r) out.push(r)
    }
    return out
  }

  it('attributes a kick to the NEAREST beat, whether it lands just before or just after the crossing', () => {
    const g = new BeatSalienceGatherer()
    // Beat 10 kick lands 0.08 beats EARLY (pos 9.92), beat 11 kick lands 0.10 beats LATE (11.10).
    const out = run(g, 8.0, 14, [
      [9.92, 0.8],
      [11.1, 0.6],
    ])
    const by = new Map(out.map((o) => [o.beatIndex, o.salience]))
    expect(by.get(10)).toBeCloseTo(0.6 * 0.8, 6)
    expect(by.get(11)).toBeCloseTo(0.6 * 0.6, 6)
    expect(by.get(9) ?? 0).toBe(0)
    expect(by.get(12) ?? 0).toBe(0)
  })

  it('reports each beat exactly once, in order, half a beat after its crossing', () => {
    const g = new BeatSalienceGatherer()
    const out = run(g, 0.0, 20)
    const idx = out.map((o) => o.beatIndex)
    // The first window is partial (starts mid-window at pos 0.0 => window of beat 0 is [-0.5, 0.5) and
    // begins at 0.0, which is 0.5 late) so beat 0 is dropped; the rest arrive once each.
    expect(idx[0]).toBe(1)
    for (let i = 1; i < idx.length; i++) expect(idx[i]).toBe(idx[i - 1] + 1)
    expect(idx[idx.length - 1]).toBe(19)
  })

  it('takes the strongest kick in the window, not the sum', () => {
    const g = new BeatSalienceGatherer()
    const out = run(g, 4.0, 8, [
      [5.95, 0.3],
      [6.0, 0.7],
      [6.2, 0.4],
    ])
    expect(out.find((o) => o.beatIndex === 6)?.salience).toBeCloseTo(0.6 * 0.7, 6)
  })

  it('the low term measures a bass ONSET (rise above the recent trough), not a sustained level', () => {
    // Sustained high level: rise ~0 at every beat.
    const flat = run(new BeatSalienceGatherer(), 0, 12, [], { low: () => 0.8 })
    for (const o of flat) expect(o.salience).toBeLessThan(0.05)
    // A pulse up at beat 6 only.
    const pulse = run(new BeatSalienceGatherer(), 0, 12, [], {
      low: (pos) => (Math.abs(pos - 6) < 0.15 ? 0.9 : 0.2),
    })
    const by = new Map(pulse.map((o) => [o.beatIndex, o.salience]))
    expect(by.get(6)!).toBeGreaterThan(0.2)
    expect(by.get(4)!).toBeLessThan(0.05)
    expect(by.get(8)!).toBeLessThan(0.05)
  })

  it('flags a window that saw an unusable frame', () => {
    const out = run(new BeatSalienceGatherer(), 0, 12, [], { usable: (pos) => !(pos > 5.9 && pos < 6.1) })
    const by = new Map(out.map((o) => [o.beatIndex, o.usable]))
    expect(by.get(6)).toBe(false)
    expect(by.get(5)).toBe(true)
    expect(by.get(7)).toBe(true)
  })

  it('drops a window a hitch skipped through, rather than reporting partial data', () => {
    const g = new BeatSalienceGatherer()
    const a = run(g, 0, 5.2)
    expect(a.length).toBeGreaterThan(0)
    // 1.7-beat stall: the next frame lands at 6.9 (window of beat 5 was left at ~5.2, mid-window).
    const b = g.frame({ pos: 6.9, kickTrigger: false, kickStrength: 0, low: 0, dt: DT, usable: true })
    expect(b).toBeNull()
  })

  it('a small backwards step of the grid across a window edge neither double-reports nor chatters', () => {
    const g = new BeatSalienceGatherer()
    const out: number[] = []
    const push = (pos: number) => {
      const r = g.frame({ pos, kickTrigger: false, kickStrength: 0, low: 0, dt: DT, usable: true })
      if (r) out.push(r.beatIndex)
    }
    for (let pos = 0; pos < 6.4; pos += 0.02) push(pos)
    push(6.55) // crosses into beat 7's window
    push(6.46) // PLL nudged the grid back across the boundary
    push(6.5)
    for (let pos = 6.52; pos < 9; pos += 0.02) push(pos)
    const dup = out.filter((v, i) => out.indexOf(v) !== i)
    expect(dup).toEqual([])
  })

  it('non-finite frames are ignored without throwing', () => {
    const g = new BeatSalienceGatherer()
    const bad = [NaN, Infinity, -Infinity]
    for (const v of bad) {
      expect(() =>
        g.frame({ pos: v, kickTrigger: true, kickStrength: v, low: v, dt: v, usable: true }),
      ).not.toThrow()
      expect(() =>
        g.frame({ pos: 3, kickTrigger: true, kickStrength: v, low: v, dt: v, usable: true }),
      ).not.toThrow()
    }
    expect(() => g.reset()).not.toThrow()
  })
})

describe('BeatSalienceGatherer -> DownbeatEstimator end to end', () => {
  it('a kick stream with a stronger kick every fourth beat (arriving slightly late) locks the right phase', () => {
    const FPS = 60
    const DT = 1 / FPS
    const gatherer = new BeatSalienceGatherer()
    const est = new DownbeatEstimator()
    const r = rng(2024)
    const downbeatPhase = 2
    const beatsPerFrame = DT / 0.5
    let firedFor = -1
    for (let pos = 0; pos < 4 * 60; pos += beatsPerFrame) {
      const n = Math.floor(pos + 0.5)
      const kickAt = n + 0.06 // detector latency: the kick registers a little after the crossing
      let trig = false
      let str = 0
      if (n !== firedFor && pos >= kickAt) {
        firedFor = n
        trig = true
        const accent = (((n - downbeatPhase) % 4) + 4) % 4 === 0 ? 1 : 0.5
        str = accent * (0.85 + 0.3 * r())
      }
      const done = gatherer.frame({ pos, kickTrigger: trig, kickStrength: Math.min(1, str), low: 0.3, dt: DT, usable: true })
      if (done) est.update(done.beatIndex, done.salience, done.usable)
    }
    expect(est.locked).toBe(true)
    expect(est.offset).toBe(downbeatPhase)
  })
})
