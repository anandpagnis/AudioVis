import { describe, expect, it } from 'vitest'
import { ONSET_DENSITY_MAX_RATE_HZ, OnsetDensityTracker } from '../onsetDensity'

/** Step a tracker with a periodic trigger at `hz` for `seconds`, at a fixed frame rate. */
function runSteadyPulse(hz: number, seconds: number, fps = 60): OnsetDensityTracker {
  const tracker = new OnsetDensityTracker()
  const dt = 1 / fps
  const period = 1 / hz
  let clock = 0
  let nextTrigger = 0
  const steps = Math.round(seconds * fps)
  for (let i = 0; i < steps; i++) {
    clock += dt
    let trigger = false
    if (clock >= nextTrigger) {
      trigger = true
      nextTrigger += period
    }
    tracker.update(trigger, dt)
  }
  return tracker
}

describe('OnsetDensityTracker', () => {
  it('converges near the known Hz of a steady pulse train, after settling', () => {
    const hz = 4
    const tracker = runSteadyPulse(hz, 15) // several multiples of the 3s window
    expect(tracker.rate()).toBeGreaterThan(hz * 0.7)
    expect(tracker.rate()).toBeLessThan(hz * 1.3)
  })

  it('normalises into 0..1, saturating (not exceeding 1) for a pulse train far above the ceiling', () => {
    const fastHz = ONSET_DENSITY_MAX_RATE_HZ * 3
    const tracker = runSteadyPulse(fastHz, 10)
    expect(tracker.read()).toBeLessThanOrEqual(1)
    expect(tracker.read()).toBeGreaterThan(0.9)
  })

  it('never negative and starts at 0 with no triggers', () => {
    const tracker = new OnsetDensityTracker()
    const dt = 1 / 60
    for (let i = 0; i < 300; i++) tracker.update(false, dt)
    expect(tracker.read()).toBe(0)
    expect(tracker.rate()).toBeGreaterThanOrEqual(0)
  })

  it('decays gradually (not an instant reset) once triggers stop, and settles back towards 0', () => {
    const tracker = runSteadyPulse(6, 6)
    const afterPulses = tracker.read()
    expect(afterPulses).toBeGreaterThan(0)

    const dt = 1 / 60
    // One frame with no trigger should barely move the read (graceful decay).
    tracker.update(false, dt)
    const oneFrameLater = tracker.read()
    expect(oneFrameLater).toBeGreaterThan(afterPulses * 0.9)
    expect(oneFrameLater).toBeLessThanOrEqual(afterPulses)

    // Several seconds of silence should bring it close to (but need not hit exactly) 0.
    for (let i = 0; i < 60 * 10; i++) tracker.update(false, dt)
    expect(tracker.read()).toBeLessThan(0.05)
    expect(tracker.read()).toBeGreaterThanOrEqual(0)
  })

  it('holds the last value through NaN/negative/zero dt instead of resetting', () => {
    const tracker = runSteadyPulse(5, 6)
    const held = tracker.read()
    expect(held).toBeGreaterThan(0)

    tracker.update(false, NaN)
    expect(tracker.read()).toBe(held)
    tracker.update(true, NaN)
    expect(tracker.read()).toBe(held)

    tracker.update(false, -0.016)
    expect(tracker.read()).toBe(held)

    tracker.update(false, 0)
    expect(tracker.read()).toBe(held)
  })

  it('custom window/ceiling constructor args change the read for the same input', () => {
    const dt = 1 / 60
    const wide = new OnsetDensityTracker(3, 10)
    const narrow = new OnsetDensityTracker(3, 2) // much lower ceiling -> saturates sooner
    for (let i = 0; i < 60 * 6; i++) {
      const trigger = i % 15 === 0 // 4 Hz-ish
      wide.update(trigger, dt)
      narrow.update(trigger, dt)
    }
    expect(narrow.read()).toBeGreaterThan(wide.read())
  })
})
