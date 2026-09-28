import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { audioEngine } from '../AudioEngine'
import { beatLeadSec } from '../beatLead'
import { barPosition } from '../structure/downbeat'

/**
 * `advanceGrid` (private) drives the real singleton the same way `audioEngineNoIntel.test.ts` drives
 * `detectStructure`: there is no mocked AudioContext / AnalyserNode graph in this suite, and a bar-phase
 * wiring check does not need one. The grid is set directly on the public `bpmEstimator` (period, phase,
 * confidence — `advanceGrid` only reads them) and each simulated frame writes the same per-frame inputs
 * `update()` would have produced before calling it: `f.percussion.kick`, `f.sub` / `f.bass`, `f.silence`.
 *
 * Lives in its own file rather than the NoIntel one so this wiring check stays independent of the
 * structure/section tests that file collects.
 */

const DT = 1 / 60
const PERIOD = 0.5 // 120 BPM
/** Absolute grid index (mod 4) of the true downbeats in these simulations; chosen so the LEGACY
 *  `beatIndex % 4` phase is wrong (first frame's grid index is a multiple of 4, so beatIndex % 4 === idx % 4). */
const TRUE_DOWNBEAT_IDX_MOD = 2
const T0 = 100.03 // first frame: grid index 200

interface SimOpts {
  seconds: number
  /** Kick amplitude by bar position (0 = true downbeat); 0 = no kick that beat. */
  kick: [number, number, number, number]
  gridConfidence?: number
  silence?: boolean
  /** Called after every frame's advanceGrid with the beat's true bar position when f.beat fired. */
  onBeat?: (info: { idx: number; truePos: number; time: number }) => void
  /** Continue from a previous simulation's clock. */
  startFrame?: number
}

function setupGrid(confidence: number) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const engine = audioEngine as any
  const est = engine.bpmEstimator
  est.period = PERIOD
  est.phase = 0
  est.confidence = confidence
  return engine
}

function simulate(o: SimOpts): number {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const engine = audioEngine as any
  const f = audioEngine.features
  const est = engine.bpmEstimator
  est.confidence = o.gridConfidence ?? 0.9
  f.delta = DT
  f.silence = o.silence ?? false
  const frames = Math.floor(o.seconds / DT)
  const start = o.startFrame ?? 0
  const firedFor = new Set<number>()
  for (let k = start; k < start + frames; k++) {
    const now = T0 + k * DT
    const idx = Math.floor(now / PERIOD)
    // The kick registers 30 ms after the grid line (detector latency), exactly once per beat.
    const kickIdx = Math.floor((now - 0.03) / PERIOD)
    const truePosOf = (i: number) => (((i - TRUE_DOWNBEAT_IDX_MOD) % 4) + 4) % 4
    const amp = o.kick[truePosOf(kickIdx)]
    const tk = kickIdx * PERIOD + 0.03
    const fire = amp > 0 && !firedFor.has(kickIdx) && now >= tk
    if (fire) firedFor.add(kickIdx)
    f.percussion.kick.trigger = fire
    f.percussion.kick.strength = fire ? amp : 0
    const low = amp > 0 ? 0.25 + 0.6 * amp * Math.exp(-Math.max(0, now - tk) / 0.12) : 0.25
    f.sub = low
    f.bass = low
    engine.advanceGrid(now, f)
    if (f.beat) o.onBeat?.({ idx, truePos: truePosOf(idx), time: now })
  }
  return start + frames
}

describe('AudioEngine.advanceGrid: bar position from the downbeat estimate', () => {
  beforeEach(() => {
    audioEngine.stop()
    // This suite labels each beat's true bar position from wall-clock grid lines, which assumes the beat fires ON the
    // line. The published-beat lead (beatLead.ts) fires it ~40 ms EARLY, so the labels would be off by one beat. The
    // lead is orthogonal to bar phase (audioEngineBeatLead.test.ts covers it): pin it to 0 here.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(audioEngine as any).beatLeadSec = 0
  })
  afterEach(() => {
    audioEngine.stop()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(audioEngine as any).beatLeadSec = beatLeadSec()
  })

  it('a clear 1-heavy kick pattern is adopted: beatInBar / bar / measure follow the estimated downbeat', () => {
    setupGrid(0.9)
    const f = audioEngine.features
    const beats: Array<{ beatIndex: number; beatInBar: number; bar: number; measure: number; truePos: number; locked: boolean }> = []
    simulate({
      seconds: 90,
      kick: [1, 0.4, 0.7, 0.4],
      onBeat: ({ truePos }) =>
        beats.push({ beatIndex: f.beatIndex, beatInBar: f.beatInBar, bar: f.bar, measure: f.measure, truePos, locked: f.downbeatLocked }),
    })
    expect(beats.length).toBeGreaterThan(150)
    // Locked, confident, and beatInBar lands on the true bar line for the whole final stretch.
    expect(f.downbeatLocked).toBe(true)
    expect(f.downbeatConfidence).toBeGreaterThan(0.6)
    const tail = beats.slice(-40)
    for (const b of tail) expect(b.beatInBar).toBe(b.truePos)
    // ...which is NOT the legacy phase (the whole point): beatIndex % 4 disagrees.
    expect(tail.every((b) => b.beatInBar !== b.beatIndex % 4)).toBe(true)
    // bar / measure are counted from the adopted downbeat, consistently with beatInBar.
    const offset = (((tail[0].beatIndex - tail[0].beatInBar) % 4) + 4) % 4
    expect(offset).toBe(TRUE_DOWNBEAT_IDX_MOD)
    for (const b of tail) {
      expect(b.bar * 4 + b.beatInBar).toBe(b.beatIndex - offset)
      expect(b.measure).toBe(Math.floor((b.beatIndex - offset) / 16))
    }
    // Before the lock every beat was the legacy reading, exactly.
    const pre = beats.filter((b) => !b.locked)
    expect(pre.length).toBeGreaterThan(20)
    for (const b of pre) {
      expect(b.beatInBar).toBe(b.beatIndex % 4)
      expect(b.bar).toBe(Math.floor(b.beatIndex / 4))
      expect(b.measure).toBe(Math.floor(b.beatIndex / 16))
    }
    // The estimator moved the bar line exactly once (one adoption, no flapping).
    let changes = 0
    for (let i = 1; i < beats.length; i++) {
      const o = (b: (typeof beats)[number]) => (((b.beatIndex - b.beatInBar) % 4) + 4) % 4
      if (o(beats[i]) !== o(beats[i - 1])) changes++
    }
    expect(changes).toBe(1)
  })

  it('at low confidence beatInBar is EXACTLY the legacy beatIndex % 4 (equal four-on-the-floor)', () => {
    setupGrid(0.9)
    const f = audioEngine.features
    let n = 0
    simulate({
      seconds: 120,
      kick: [1, 1, 1, 1],
      onBeat: () => {
        n++
        expect(f.beatInBar).toBe(f.beatIndex % 4)
        expect(f.bar).toBe(Math.floor(f.beatIndex / 4))
        expect(f.measure).toBe(Math.floor(f.beatIndex / 16))
      },
    })
    expect(n).toBeGreaterThan(200)
    expect(f.downbeatLocked).toBe(false)
    expect(f.downbeatConfidence).toBeLessThan(0.6)
  })

  it('no kick at all (ambient): legacy, unlocked, zero confidence', () => {
    setupGrid(0.9)
    const f = audioEngine.features
    let n = 0
    simulate({
      seconds: 90,
      kick: [0, 0, 0, 0],
      onBeat: () => {
        n++
        expect(f.beatInBar).toBe(f.beatIndex % 4)
      },
    })
    expect(n).toBeGreaterThan(150)
    expect(f.downbeatLocked).toBe(false)
    expect(f.downbeatConfidence).toBe(0)
  })

  it('an unreliable grid (low tempo confidence) never adopts, even with a clear accent', () => {
    setupGrid(0.1)
    const f = audioEngine.features
    let n = 0
    simulate({
      seconds: 120,
      kick: [1, 0.3, 0.6, 0.3],
      gridConfidence: 0.1,
      onBeat: () => {
        n++
        expect(f.beatInBar).toBe(f.beatIndex % 4)
      },
    })
    expect(n).toBeGreaterThan(200)
    expect(f.downbeatLocked).toBe(false)
  })

  it('silence never adopts either', () => {
    setupGrid(0.9)
    const f = audioEngine.features
    simulate({
      seconds: 120,
      kick: [1, 0.3, 0.6, 0.3],
      silence: true,
      onBeat: () => expect(f.beatInBar).toBe(f.beatIndex % 4),
    })
    expect(f.downbeatLocked).toBe(false)
  })

  it('resetAnalysis (stop) drops the adopted offset: a new track never inherits the old bar phase', () => {
    setupGrid(0.9)
    const f = audioEngine.features
    simulate({ seconds: 90, kick: [1, 0.4, 0.7, 0.4] })
    expect(f.downbeatLocked).toBe(true)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const engine = audioEngine as any
    expect(engine.downbeat.offset).toBe(TRUE_DOWNBEAT_IDX_MOD)
    audioEngine.stop()
    expect(engine.downbeat.locked).toBe(false)
    expect(engine.downbeat.offset).toBe(0)
    expect(audioEngine.features.downbeatLocked).toBe(false)
    expect(audioEngine.features.downbeatConfidence).toBe(0)
    // ...and the first beats of the next source read legacy again.
    setupGrid(0.9)
    const g = audioEngine.features
    let n = 0
    simulate({
      seconds: 10,
      kick: [1, 0.4, 0.7, 0.4],
      onBeat: () => {
        n++
        expect(g.beatInBar).toBe(g.beatIndex % 4)
      },
    })
    expect(n).toBeGreaterThan(10)
  })

  it('a capped grid catch-up (grid jumped further than beatIndex may follow) keeps the offset but forgets the evidence', () => {
    setupGrid(0.9)
    const f = audioEngine.features
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const engine = audioEngine as any
    const next = simulate({ seconds: 90, kick: [1, 0.4, 0.7, 0.4] })
    expect(f.downbeatLocked).toBe(true)
    const before = f.beatIndex
    // A 20-second stall (background tab): the grid index jumps ~40 beats but beatIndex may only follow by 4.
    const now = T0 + (next + Math.floor(20 / DT)) * DT
    f.silence = false
    engine.advanceGrid(now, f)
    expect(f.beat).toBe(true)
    expect(f.beatIndex).toBe(before + 4)
    expect(f.downbeatLocked).toBe(true) // offset kept...
    expect(f.beatInBar).toBe(barPosition(f.beatIndex, engine.downbeat.offset).beatInBar)
    expect(engine.downbeat.confidence).toBe(0) // ...evidence forgotten
  })

  it('features expose the new fields with legacy-neutral defaults', () => {
    audioEngine.stop()
    expect(audioEngine.features.downbeatConfidence).toBe(0)
    expect(audioEngine.features.downbeatLocked).toBe(false)
  })
})
