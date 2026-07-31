import { describe, expect, it } from 'vitest'
import { BpmEstimator } from '../BpmEstimator'

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

  it('setExternalTempo overrides the grid and expires ~2s after the last call', () => {
    const est = new BpmEstimator()
    est.setExternalTempo(128, 10, 10)
    expect(est.bpm).toBeCloseTo(128, 5)
    expect(est.confidence).toBe(1)
    expect(est.isExternal(11)).toBe(true)
    expect(est.isExternal(12.1)).toBe(false)
  })
})
