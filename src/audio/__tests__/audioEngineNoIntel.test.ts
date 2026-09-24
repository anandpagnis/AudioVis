import { describe, expect, it } from 'vitest'
import { audioEngine } from '../AudioEngine'

/**
 * Boot smoke test for the commercial (no-Essentia) default: with
 * `VITE_ENABLE_ESSENTIA` unset the engine runs on a NullProvider, and every
 * AudioEngine path that used to call a bridge must be a safe no-op that leaves
 * the licence-clean fallbacks in place.
 */
describe('AudioEngine keeps features.character linked to its classifier', () => {
  it('after construction and after every reset (stop/start), so live reads reach the directors', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const classifier = (audioEngine as any).characterClassifier
    expect(audioEngine.features.character).toBe(classifier.state)
    audioEngine.stop()
    expect(audioEngine.features.character).toBe(classifier.state)
    classifier.state.valid = true
    expect(audioEngine.features.character.valid).toBe(true)
    classifier.reset()
  })
})

describe('AudioEngine without a music-intel provider', () => {
  it('idles, updates and stops without throwing; fallbacks stay at defaults', async () => {
    // Let the async provider factory settle (it resolves to NullProvider).
    await new Promise((r) => setTimeout(r, 0))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((audioEngine as any).intel.id).toBe('null')
    for (let i = 0; i < 5; i++) expect(() => audioEngine.update()).not.toThrow()
    expect(() => audioEngine.stop()).not.toThrow()
    const f = audioEngine.features
    expect(f.key).toBe('')
    expect(f.scale).toBe('')
    expect(f.keyConfidence).toBe(0)
    expect(f.moodsValid).toBe(false)
    expect(f.structureValid).toBe(false)
    expect(f.vocalPresence).toBe(0)
  })
})

/**
 * `detectStructure` (private) is exercised directly, the same way other tests in this file reach past
 * TS-only privacy for internal state — there is no mocked AudioContext/AnalyserNode graph in this test
 * suite for driving the public `update()` loop, and building one just for this would be a large
 * integration harness for a small wiring check. This targets exactly what F-structure's drop-detector
 * task changed: two independent triggers into the same `f.drop` pulse-latch, both reached through the
 * real AudioEngine singleton (not the isolated DropStateMachine class, which has its own full test suite
 * in `src/audio/structure/__tests__/dropStateMachine.test.ts`).
 */
describe('AudioEngine detectStructure: f.drop has two independent trigger paths', () => {
  it('the ORIGINAL broadband energy/bass-ratio path still sets f.drop (unchanged behaviour)', () => {
    audioEngine.stop()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const engine = audioEngine as any
    const f = audioEngine.features
    let now = 100
    // "Before" window: steady low energy, long enough to fill the >10-sample before-bucket
    // (0.35s-2.2s ago) `detectStructure` reads from `energyLog`.
    for (let i = 0; i < 60; i++) {
      engine.energyLog.push({ t: now, e: 0.2 })
      now += 0.05
      engine.detectStructure(now, f)
    }
    expect(f.drop).toBe(false)
    // Sudden jump with heavy bass, sustained long enough that the <0.35s "recent" bucket fills
    // entirely with spike-level samples — the exact shape the broadband ratio test looks for.
    f.bass = 0.9
    let fired = false
    for (let i = 0; i < 30; i++) {
      engine.energyLog.push({ t: now, e: 0.9 })
      now += 0.05
      engine.detectStructure(now, f)
      if (f.drop) fired = true
    }
    expect(fired).toBe(true)
    audioEngine.stop()
  })

  it('the NEW fast breakdown->snap-back state machine also sets f.drop, through several detectStructure() calls', () => {
    audioEngine.stop()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const engine = audioEngine as any
    const f = audioEngine.features
    let now = 200
    f.delta = 0.05
    // Nothing in `energyLog` here, so the broadband block above is structurally skipped
    // (`recentN > 3 && beforeN > 10` never holds) — only the new path can set `dropUntil` below.
    f.sub = 0.4
    f.bass = 0.4
    for (let i = 0; i < 200; i++) {
      now += f.delta
      engine.detectStructure(now, f)
    }
    expect(f.drop).toBe(false)
    // Breakdown: sub+bass well under the trailing baseline, sustained past the arming floor (~1.5s).
    f.sub = 0.05
    f.bass = 0.05
    for (let i = 0; i < 40; i++) {
      now += f.delta
      engine.detectStructure(now, f)
    }
    expect(f.drop).toBe(false)
    // Snap-back with a concurrent broadband transient (flux).
    f.sub = 0.45
    f.bass = 0.45
    f.flux = 0.9
    now += f.delta
    engine.detectStructure(now, f)
    expect(f.drop).toBe(true)
    audioEngine.stop()
  })
})

/**
 * `f.buildUp` (the fast, always-on build flag `SectionTracker` overlays on the analyzer's riser read).
 * Its old form, `(recent - firstSample) / span > 0.197`, was unreachable in steady state: `update()`
 * trims `energyLog` to 6 s so `span` ~ 6, and `energy` is a 0..1 mean so the slope caps near 1/6 =
 * 0.167 < 0.197 — it could only fire in a track's first few seconds. It is now a least-squares climb
 * (slope > 0.03/s, R^2 > 0.8) with the old floor / still-rising guards. Driven through the real
 * singleton's private `detectStructure`, feeding `energyLog` and trimming it to 6 s exactly as
 * `update()` does (the direct-call idiom of the drop tests above does not trim, which would let the log
 * grow past the 6 s window this flag is defined over).
 */
describe('AudioEngine detectStructure: f.buildUp fires on a sustained energy RAMP, not on steady/drifting energy', () => {
  const DT = 1 / 60

  /** Deterministic beat-level ripple + noise on top of a shape, like a real (smoothed) `f.energy`. */
  function makeEnergy(shape: (t: number) => number, gain = 1) {
    let seed = 12345
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    return (t: number) => {
      const ripple = 0.06 * Math.sin(2 * Math.PI * 2 * t) + 0.04 * (rand() - 0.5)
      return Math.max(0, Math.min(1, gain * (shape(t) + ripple)))
    }
  }

  /** Run `seconds` of frames from `t0`; returns the sim-times at which `f.buildUp` was true. */
  function drive(energyAt: (t: number) => number, seconds: number, t0 = 500): number[] {
    audioEngine.stop()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const engine = audioEngine as any
    const f = audioEngine.features
    f.delta = DT
    f.bass = 0.2 // keep the ratio-based drop path out of it
    f.sub = 0.2
    f.flux = 0
    const fired: number[] = []
    for (let k = 0; k * DT < seconds; k++) {
      const now = t0 + k * DT
      const e = energyAt(k * DT)
      f.energy = e
      engine.energyLog.push({ t: now, e })
      while (engine.energyLog.length > 0 && now - engine.energyLog[0].t > 6) engine.energyLog.shift()
      engine.detectStructure(now, f)
      if (f.buildUp) fired.push(k * DT)
    }
    audioEngine.stop()
    return fired
  }

  /** 12 s of steady 0.3, then a linear climb to 0.8 over 7 s, then held. */
  const ramp = (t: number) => (t < 12 ? 0.3 : t < 19 ? 0.3 + (0.5 * (t - 12)) / 7 : 0.8)

  it('a genuine 0.3 -> 0.8 climb over 7 s fires within a few seconds of starting (steady state, log already full)', () => {
    const fired = drive(makeEnergy(ramp), 30)
    expect(fired.length).toBeGreaterThan(0)
    // Nothing during the 12 s steady lead-in (the log was full for the last 6 of them)...
    expect(fired.filter((t) => t < 12).length).toBe(0)
    // ...and the first fire comes within ~5 s of the ramp beginning.
    expect(fired[0]).toBeGreaterThan(12)
    expect(fired[0] - 12).toBeLessThan(5)
    // It is a window, not a latch: it has let go again by the time the energy has plateaued for a while.
    expect(fired[fired.length - 1]).toBeLessThan(26)
  })

  it('steady energy never fires over a long run, with or without ripple/noise, at any level', () => {
    for (const level of [0.35, 0.5, 0.8]) {
      expect(drive(makeEnergy(() => level), 120).length).toBe(0)
    }
    expect(drive(() => 0.5, 60).length).toBe(0) // perfectly flat too
  })

  it('a slow 0.4 -> 0.5 drift never fires (over 40 s, and over the 8 s it is concentrated in)', () => {
    expect(drive(makeEnergy((t) => 0.4 + (0.1 * t) / 40), 40).length).toBe(0)
    expect(drive(makeEnergy((t) => (t < 20 ? 0.4 : t < 28 ? 0.4 + (0.1 * (t - 20)) / 8 : 0.5)), 50).length).toBe(0)
  })

  it('a single step (verse -> chorus) is not a ramp: no fire, wherever it falls in the window', () => {
    expect(drive(makeEnergy((t) => (t < 20 ? 0.3 : 0.7)), 40).length).toBe(0)
    expect(drive(makeEnergy((t) => (t < 20 ? 0.4 : 0.6)), 40).length).toBe(0)
  })

  it('the SAME ramp shape behaves consistently across a realistic gain range; scaled steady energy stays silent', () => {
    const firstFire = (gain: number) => {
      const fired = drive(makeEnergy(ramp, gain), 30)
      expect(fired.length).toBeGreaterThan(0)
      return fired[0]
    }
    const t = [0.8, 1, 1.25].map(firstFire)
    // Same onset to within a second regardless of gain (the rise/R^2 tests are shape-, not level-driven).
    expect(Math.max(...t) - Math.min(...t)).toBeLessThan(1)
    for (const g of [0.8, 1, 1.25]) expect(drive(makeEnergy(() => 0.5, g), 60).length).toBe(0)
  })

  it('regression: the old 0.197 slope bound was unreachable once the log is full; the steepest possible ramp fires now, mid-run', () => {
    // Old test: slope = (recent - firstSample) / ~6 s <= 1 / 6 = 0.167 < 0.197 -> impossible in steady state.
    expect(1 / 6).toBeLessThan(0.197)
    const fired = drive(makeEnergy((t) => Math.max(0.05, Math.min(0.95, 0.05 + 0.9 * ((t - 15) / 6)))), 30)
    expect(fired.length).toBeGreaterThan(0)
    expect(fired[0]).toBeGreaterThan(15) // not a start-up artefact: fires mid-run, after the log has filled
  })
})
