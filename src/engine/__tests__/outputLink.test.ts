import { describe, expect, it } from 'vitest'
import { HANDOFF_GRACE_MS, shouldAdoptStatus } from '../outputLink'

/**
 * The rule that decides whether the control window believes the output window
 * about what is playing.
 *
 * Worth a test of its own because getting it wrong is silent: every
 * screen-share start failed with no error anywhere, and the file path — which
 * awaits nothing between claiming `starting` and handing over — kept working,
 * so the suite stayed green.
 */
describe('shouldAdoptStatus', () => {
  const idle = { status: 'idle', hasSource: false }
  const running = { status: 'running', hasSource: true }

  it('defers to the output window when nothing is being handed over', () => {
    expect(shouldAdoptStatus(idle, false)).toBe(true)
    expect(shouldAdoptStatus(running, false)).toBe(true)
  })

  it('ignores an idle output while a hand-off is in flight', () => {
    // THE BUG. The console sets `starting` and opens the share picker; the
    // output window is still idle and says so every 100 ms. Adopting that wrote
    // `idle` over `starting`, and when the picker resolved the cancellation
    // guard read `idle`, concluded the user had backed out, and stopped the
    // tracks it had just been granted.
    expect(shouldAdoptStatus(idle, true)).toBe(false)
  })

  it('believes the output window the moment it actually has a source', () => {
    // The exemption has to end on evidence, not on a timer alone: once there is
    // a graph over there, its status is the truth whatever this window thinks.
    expect(shouldAdoptStatus(running, true)).toBe(true)
    expect(shouldAdoptStatus({ status: 'error', hasSource: true }, true)).toBe(true)
  })

  it('never adopts an empty status', () => {
    expect(shouldAdoptStatus({ status: '', hasSource: true }, false)).toBe(false)
  })
})

describe('the hand-off grace period', () => {
  it('outlasts the share picker it exists to cover', () => {
    // AudioEngine gives the picker 60 s before it gives up. A grace shorter
    // than that re-opens the bug for anyone who takes their time choosing a
    // window — which is most people, the first time.
    expect(HANDOFF_GRACE_MS).toBeGreaterThan(60_000)
  })
})
