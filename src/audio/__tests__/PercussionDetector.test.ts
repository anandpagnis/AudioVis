import { describe, expect, it } from 'vitest'
import {
  PercussionDetector,
  createEmptyPercussion,
  type PercussionBand,
  type PercussionState,
} from '../PercussionDetector'

const DT = 1 / 60

/** Zero flux on every band — the "nothing is playing" frame. */
const QUIET = { kickFlux: 0, snareFlux: 0, hihatFlux: 0 }

function fluxFor(band: PercussionBand, v: number) {
  return { ...QUIET, [`${band}Flux`]: v }
}

/**
 * Drive the detector for `frames`, firing `band` every `everyN` frames with a
 * spike well above the noise floor. Returns the state plus how many triggers
 * were observed on each band (triggers are single-frame, so they have to be
 * counted as they happen).
 */
function run(band: PercussionBand, frames: number, everyN: number, spike = 1) {
  const det = new PercussionDetector()
  const state = createEmptyPercussion()
  const counts: Record<PercussionBand, number> = { kick: 0, snare: 0, hihat: 0 }
  let now = 0
  for (let i = 0; i < frames; i++) {
    // A little noise on every frame so mean/σ are non-degenerate.
    const noise = 0.01 * ((i * 7919) % 13)
    const v = i % everyN === 0 ? spike : noise
    det.update(state, fluxFor(band, v), now, DT, false)
    for (const b of ['kick', 'snare', 'hihat'] as PercussionBand[]) {
      if (state[b].trigger) counts[b]++
    }
    now += DT
  }
  return { state, counts }
}

describe('PercussionDetector', () => {
  it('detects hits on the band that actually spiked', () => {
    const { counts } = run('kick', 300, 30)
    expect(counts.kick).toBeGreaterThan(4)
  })

  it('keeps the three bands independent — a kick pattern must not trigger hats or snare', () => {
    const { counts } = run('kick', 300, 30)
    expect(counts.snare).toBe(0)
    expect(counts.hihat).toBe(0)
  })

  it('detects hats independently of kick', () => {
    const { counts } = run('hihat', 300, 12)
    expect(counts.hihat).toBeGreaterThan(10)
    expect(counts.kick).toBe(0)
  })

  it('never fires during silence, however large the flux', () => {
    const det = new PercussionDetector()
    const state = createEmptyPercussion()
    let fired = false
    let now = 0
    for (let i = 0; i < 200; i++) {
      det.update(state, fluxFor('kick', i % 20 === 0 ? 5 : 0.01), now, DT, true)
      if (state.kick.trigger) fired = true
      now += DT
    }
    expect(fired).toBe(false)
  })

  it('decays the envelope back toward zero after a hit', () => {
    const det = new PercussionDetector()
    const state = createEmptyPercussion()
    let now = 0
    // Build history, then one big hit.
    for (let i = 0; i < 60; i++) {
      det.update(state, fluxFor('kick', 0.02), now, DT, false)
      now += DT
    }
    det.update(state, fluxFor('kick', 3), now, DT, false)
    now += DT
    const peak = state.kick.env
    expect(peak).toBeGreaterThan(0)
    for (let i = 0; i < 60; i++) {
      det.update(state, fluxFor('kick', 0.02), now, DT, false)
      now += DT
    }
    expect(state.kick.env).toBeLessThan(peak * 0.2)
  })

  it('respects the per-band refractory interval (no double-triggering on one hit)', () => {
    const det = new PercussionDetector()
    const state = createEmptyPercussion()
    let now = 0
    for (let i = 0; i < 60; i++) {
      det.update(state, fluxFor('kick', 0.02), now, DT, false)
      now += DT
    }
    // Hold a sustained high flux across many consecutive frames — a single
    // event, not a burst of them.
    let triggers = 0
    for (let i = 0; i < 5; i++) {
      det.update(state, fluxFor('kick', 3), now, DT, false)
      if (state.kick.trigger) triggers++
      now += DT
    }
    // 5 frames at 60fps = 83ms, under the kick's 90ms refractory window.
    expect(triggers).toBe(1)
  })

  it('reset() clears history so a new track does not inherit the old threshold', () => {
    const det = new PercussionDetector()
    const state: PercussionState = createEmptyPercussion()
    let now = 0
    for (let i = 0; i < 100; i++) {
      det.update(state, fluxFor('kick', 2), now, DT, false)
      now += DT
    }
    det.reset()
    // Immediately after reset there is no history, so nothing can fire yet.
    det.update(state, fluxFor('kick', 5), now, DT, false)
    expect(state.kick.trigger).toBe(false)
  })
})
