import { describe, expect, it } from 'vitest'
import { BpmEstimator, reconcileModelBpm } from '../BpmEstimator'

/**
 * Drives the estimator like AudioEngine does: `update()` on every tick,
 * `addOnset()` only when a click actually lands. Returns the final time, so
 * a test can chain simulations (e.g. lock at one tempo, then change it).
 */
function simulateClicks(
  est: BpmEstimator,
  period: number,
  seconds: number,
  startT = 0,
  tick = 0.05,
): number {
  let t = startT
  let nextClick = startT
  const end = startT + seconds
  while (t < end) {
    if (t >= nextClick) {
      est.addOnset(t, 1)
      nextClick += period
    }
    est.update(t)
    t += tick
  }
  return t
}

describe('BpmEstimator', () => {
  it('locks to a steady 120 BPM click track', () => {
    const est = new BpmEstimator()
    simulateClicks(est, 0.5, 20)
    expect(Math.abs(est.bpm - 120)).toBeLessThan(2)
    expect(est.confidence).toBeGreaterThan(0.8)
  })

  it('reports a high hitScore once locked to a perfectly on-grid click track', () => {
    const est = new BpmEstimator()
    simulateClicks(est, 0.5, 20)
    expect(est.hitScore).toBeGreaterThan(0.9)
  })

  it('reports a low hitScore when the same nominal tempo is jittered off-grid', () => {
    const est = new BpmEstimator()
    const period = 0.5
    let t = 0
    let i = 0
    while (t < 20) {
      const jitter = i % 2 === 0 ? period * 0.4 : -period * 0.4
      est.addOnset(t + jitter, 1)
      est.update(t)
      i++
      t += period
    }
    expect(est.hitScore).toBeLessThan(0.5)
  })

  it('locks to an unusual 82 BPM click track instead of 120 or the 164 octave', () => {
    const est = new BpmEstimator()
    simulateClicks(est, 60 / 82, 25)
    expect(Math.abs(est.bpm - 82)).toBeLessThan(2)
    expect(est.octaveCorrection).toBe(1)
  })

  it('octave-corrects a grid seeded at double-time back onto the onset rate', () => {
    // Force the pathological start: pre-lock at 164, then keep feeding 82.
    const est = new BpmEstimator()
    est.period = 60 / 164
    simulateClicks(est, 60 / 82, 25)
    expect(Math.abs(est.bpm - 82)).toBeLessThan(2)
  })

  it('does not relock on a short burst at a different tempo, but does after it sustains', () => {
    const est = new BpmEstimator()
    let t = simulateClicks(est, 0.5, 20)
    // Short burst: a couple of 90 BPM onsets shouldn't move a well-locked grid.
    t = simulateClicks(est, 60 / 90, 2, t)
    expect(Math.abs(est.bpm - 120)).toBeLessThan(5)
    // Sustained: enough 90 BPM onsets should eventually relock.
    simulateClicks(est, 60 / 90, 15, t)
    expect(Math.abs(est.bpm - 90)).toBeLessThan(5)
  })

  it('free-runs the grid and decays confidence once onsets stop', () => {
    const est = new BpmEstimator()
    let t = simulateClicks(est, 0.5, 20)
    const periodBefore = est.period
    const confBefore = est.confidence
    for (let i = 0; i < 300; i++) {
      t += 0.05
      est.update(t)
    }
    // Onsets drain from the 12s window one at a time as they age out, so a
    // still-running evaluate() can nudge the estimate slightly even with no
    // new input — "stays roughly frozen", not bit-identical.
    expect(Math.abs(est.period - periodBefore)).toBeLessThan(0.01)
    expect(est.confidence).toBeLessThan(confBefore)
  })

  it('adopts a model tempo read and reports it as the source while fresh', () => {
    const est = new BpmEstimator()
    // Lock the histogram to 120 first, then hand it a conflicting 82 read.
    const t = simulateClicks(est, 0.5, 20)
    expect(est.isModelDriven(t)).toBe(false)
    for (let i = 0; i < 6; i++) {
      est.setModelTempo(82, 0.9, t + i, 8)
      est.update(t + i)
    }
    expect(est.isModelDriven(t + 5)).toBe(true)
    expect(Math.abs(est.bpm - 82)).toBeLessThan(2)
  })

  it('falls back to onset tracking when model reads go stale', () => {
    const est = new BpmEstimator()
    const t = simulateClicks(est, 0.5, 20)
    est.setModelTempo(82, 0.9, t, 8)
    expect(est.isModelDriven(t + 7)).toBe(true)
    expect(est.isModelDriven(t + 9)).toBe(false)
    // With the read expired, sustained 120 onsets pull the grid back.
    simulateClicks(est, 0.5, 20, t + 9)
    expect(Math.abs(est.bpm - 120)).toBeLessThan(3)
  })

  it('octave-corrects a model read that lands on the wrong metrical level', () => {
    const est = new BpmEstimator()
    // Onsets are genuinely 82 BPM; the model insists on the 164 octave.
    let t = 0
    const period = 60 / 82
    let nextClick = 0
    while (t < 25) {
      if (t >= nextClick) {
        est.addOnset(t, 1)
        nextClick += period
      }
      est.setModelTempo(164, 0.9, t, 8)
      est.update(t)
      t += 0.05
    }
    expect(Math.abs(est.bpm - 82)).toBeLessThan(3)
    expect(est.octaveCorrection).toBe(2)
  })

  it('setExternalTempo overrides the grid and expires ~2s after the last call', () => {
    const est = new BpmEstimator()
    est.setExternalTempo(128, 10, 10)
    expect(est.bpm).toBeCloseTo(128, 5)
    expect(est.confidence).toBe(1)
    expect(est.isExternal(11)).toBe(true)
    expect(est.isExternal(12.1)).toBe(false)
  })

  it('holds the metrical level through a sparse passage that reads as half-tempo (F121)', () => {
    // The F121 repro: a dense chorus locks 152, then a verse where the kick
    // plays every OTHER beat (~76 onsets/min) — mathematically ambiguous
    // between 76 and 152 — then the chorus returns. The old estimator flipped
    // to 76 for the length of the verse; the continuity lock must hold 152.
    const est = new BpmEstimator()
    const dense = 60 / 152 // ~0.395 s
    const sparse = dense * 2 // one onset every other true beat
    let t = simulateClicks(est, dense, 14) // lock 152, build octaveLock
    expect(Math.abs(est.bpm - 152)).toBeLessThan(6)

    const beforeLock = est.octaveLock
    expect(beforeLock).toBeGreaterThan(0.3)

    // 9 s of sparse onsets — longer than a typical verse, shorter than the
    // lock's ~13 s erosion time.
    let flippedToHalf = false
    let nextClick = t
    const sparseEnd = t + 9
    while (t < sparseEnd) {
      if (t >= nextClick) {
        est.addOnset(t, 1)
        nextClick += sparse
      }
      est.update(t)
      if (est.bpm < 120) flippedToHalf = true
      t += 0.05
    }
    expect(flippedToHalf).toBe(false)
    expect(Math.abs(est.bpm - 152)).toBeLessThan(10)
    expect(est.octaveCorrection).not.toBe(2)

    // Chorus returns — still 152, no phantom re-lock.
    simulateClicks(est, dense, 6, t)
    expect(Math.abs(est.bpm - 152)).toBeLessThan(6)
  })

  // --- The logged F121 transition, reproduced literally (audit item 3) ------
  //
  // A live session log caught `bpm` reading 136.6 and then 102.5 in samples
  // 0.25 s apart, after which 102.5 held for the rest of the session.
  //
  // Worth stating precisely, because it is easy to mis-file as an octave bug:
  // 136.6 / 102.5 = 1.3327, and log2(1.3327) = 0.4143. The octave gates in
  // `evaluate()` test `|log2(ratio)| - 1| < 0.15`, so at 0.4143 they do NOT
  // fire — this is a 4:3 metrical reinterpretation (a dotted/triplet reading),
  // not a half/double-time flip. What holds it is therefore the
  // persist-before-jump gate (`stableCount >= 2`), which is the direct
  // implementation of "require SUSTAINED contra-evidence, not one ambiguous
  // reading". These tests pin that, and pin that it is hysteresis rather than
  // a freeze.

  /**
   * Lock the grid to 136.6 on onsets plus a matching stream of degara-style
   * reads (confidence 0, exactly as degara reports), then inject `contraSec`
   * of 102.5 reads before returning to 136.6. Returns the lowest BPM the grid
   * ever showed.
   *
   * `freshSec` is 0.4 against a 0.05 s tick, so a read expires unless it is
   * re-sent every tick — otherwise one `setModelTempo` call would stay fresh
   * for its 8 s default and "one reading" could not be distinguished from a
   * sustained stream.
   */
  function lowestBpmAfterContraEvidence(contraSec: number): number {
    const est = new BpmEstimator()
    const period = 60 / 136.6
    let t = 0
    let next = 0
    while (t < 16) {
      if (t >= next) {
        est.addOnset(t, 1)
        next += period
      }
      est.setModelTempo(136.6, 0, t, 0.4)
      est.update(t)
      t += 0.05
    }
    expect(Math.abs(est.bpm - 136.6)).toBeLessThan(5)

    const start = t
    let lowest = Infinity
    while (t < start + 12) {
      if (t >= next) {
        est.addOnset(t, 1)
        next += period
      }
      const inWindow = t >= start + 1 && t < start + 1 + contraSec
      est.setModelTempo(inWindow ? 102.5 : 136.6, 0, t, 0.4)
      est.update(t)
      lowest = Math.min(lowest, est.bpm)
      t += 0.05
    }
    return lowest
  }

  it('holds 136.6 through a BRIEF 102.5 reinterpretation — the logged transition (F121)', () => {
    // Up to 1 s of contra-evidence — two evaluations at the 0.5 s evaluate
    // cadence — never moves the grid at all. `stableCount` needs to reach 2,
    // which takes three consecutive agreeing evaluations.
    for (const contraSec of [0.05, 0.3, 0.55, 1.0]) {
      expect(lowestBpmAfterContraEvidence(contraSec)).toBeGreaterThan(120)
    }
  })

  it('is hysteresis, not a freeze: SUSTAINED contra-evidence does re-interpret', () => {
    // The converse guard, and what makes the test above non-vacuous: the same
    // harness DOES move the grid once the evidence is sustained past the gate.
    // Measured boundary sits between 1.0 s and 1.5 s.
    expect(lowestBpmAfterContraEvidence(1.5)).toBeLessThan(110)
    expect(lowestBpmAfterContraEvidence(3.0)).toBeLessThan(110)
  })

  it('recovers to 136.6 once the ambiguous reading passes', () => {
    // The logged failure was not just the dip — 102.5 HELD for the rest of the
    // session. Even where contra-evidence is long enough to move the grid, the
    // return of consistent 136.6 reads must bring it back.
    const est = new BpmEstimator()
    const period = 60 / 136.6
    let t = 0
    let next = 0
    const drive = (until: number, modelBpm: (now: number) => number) => {
      while (t < until) {
        if (t >= next) {
          est.addOnset(t, 1)
          next += period
        }
        est.setModelTempo(modelBpm(t), 0, t, 0.4)
        est.update(t)
        t += 0.05
      }
    }
    drive(16, () => 136.6)
    drive(19, () => 102.5) // 3 s — past the gate
    drive(31, () => 136.6)
    expect(Math.abs(est.bpm - 136.6)).toBeLessThan(5)
  })

  it('the logged ratio really is 4:3, not an octave — so the octave gate cannot be what holds it', () => {
    // Guards the reasoning above against a future reader "simplifying" the
    // persist gate away on the assumption that octaveLock covers this case.
    const ratio = 136.6 / 102.5
    expect(ratio).toBeCloseTo(1.3327, 4)
    const octaves = Math.abs(Math.log2(ratio))
    expect(octaves).toBeCloseTo(0.4143, 4)
    // The gate in evaluate() is `|octaves - 1| < 0.15`.
    expect(Math.abs(octaves - 1)).toBeGreaterThan(0.15)
  })

  it('does NOT lock the octave from a cold start, so a real ½/2× seed still corrects', () => {
    // Regression guard for the continuity lock: it must only resist LEAVING a
    // dense-confirmed level, never block acquiring the right one. Seed at
    // double-time with no prior dense evidence — octaveLock is 0, correction
    // proceeds (this is L66's scenario, restated against octaveLock).
    const est = new BpmEstimator()
    est.period = 60 / 164
    expect(est.octaveLock).toBe(0)
    simulateClicks(est, 60 / 82, 25)
    expect(Math.abs(est.bpm - 82)).toBeLessThan(3)
  })
})

describe('reconcileModelBpm', () => {
  it('folds a degara half-tempo read onto a confident lock', () => {
    expect(reconcileModelBpm(76, 152, 0.9, 0)).toBe(152)
    expect(reconcileModelBpm(152, 76, 0.9, 0)).toBe(76) // double-time model vs a 76 lock
  })

  it('leaves a read alone when the internal grid is not confident', () => {
    expect(reconcileModelBpm(76, 152, 0.3, 0)).toBe(76)
  })

  it('leaves a read alone when the model carries its own strong confidence', () => {
    expect(reconcileModelBpm(76, 152, 0.9, 0.8)).toBe(76)
  })

  it('passes an unrelated tempo through untouched', () => {
    expect(reconcileModelBpm(96, 152, 0.9, 0)).toBe(96)
  })

  it('is a no-op on non-finite / non-positive input', () => {
    expect(reconcileModelBpm(0, 152, 0.9, 0)).toBe(0)
    expect(reconcileModelBpm(120, 0, 0.9, 0)).toBe(120)
    expect(Number.isNaN(reconcileModelBpm(NaN, 152, 0.9, 0))).toBe(true)
  })

  it('integrates: a stream of degara half-tempo reads cannot halve a locked grid', () => {
    const est = new BpmEstimator()
    let t = simulateClicks(est, 60 / 152, 20) // lock 152
    for (let i = 0; i < 30; i++) {
      const folded = reconcileModelBpm(76, est.bpm, est.confidence, 0)
      est.setModelTempo(folded, 0, t, 8)
      est.update(t)
      t += 0.25
    }
    expect(Math.abs(est.bpm - 152)).toBeLessThan(8)
  })
})
