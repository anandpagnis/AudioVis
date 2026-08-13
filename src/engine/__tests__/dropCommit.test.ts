import { describe, expect, it } from 'vitest'
import { resolveCommit } from '../SceneManager'

const base = {
  gridTrusted: true,
  onDownbeat: false,
  pendingImmediate: false,
  incomingWarm: true as boolean | null,
  waited: 0.1,
}

/**
 * Regression coverage for "drops don't visibly switch".
 *
 * Drop detection averages a 0.35s window, so `f.drop` rises AFTER the downbeat
 * the drop landed on. On a trusted grid the old gate then waited for the *next*
 * downbeat — nearly a full bar — and crossfaded over two more beats, finishing
 * ~3s late. `f.drop` is only true for 0.6s, so the flag had long expired.
 */
describe('resolveCommit', () => {
  it('waits for a downbeat on a trusted grid (unchanged for normal switches)', () => {
    expect(resolveCommit(base).commit).toBe(false)
    expect(resolveCommit({ ...base, onDownbeat: true }).commit).toBe(true)
  })

  it('commits at once when the grid is untrusted', () => {
    // Worth pinning: the reported hypothesis was that a confidence dip DELAYED
    // the drop into the 2.5s timeout. It does the opposite — an untrusted grid
    // already bypasses the downbeat wait. The downbeat gate was the delay.
    expect(resolveCommit({ ...base, gridTrusted: false }).commit).toBe(true)
  })

  it('commits a warm drop switch immediately, off the downbeat', () => {
    const r = resolveCommit({ ...base, pendingImmediate: true, incomingWarm: true })
    expect(r.commit).toBe(true)
    expect(r.immediate).toBe(true)
  })

  it('holds a drop switch briefly while the incoming shader is still cold', () => {
    // A compile stall exactly on the drop is worse than a few frames of delay.
    const cold = { ...base, pendingImmediate: true, incomingWarm: false }
    expect(resolveCommit({ ...cold, waited: 0.05 }).commit).toBe(false)
    // ...but never longer than the grace period.
    expect(resolveCommit({ ...cold, waited: 0.4 }).commit).toBe(true)
    expect(resolveCommit({ ...cold, waited: 0.4 }).immediate).toBe(true)
  })

  it('commits a drop switch with no warm entry at all', () => {
    expect(
      resolveCommit({ ...base, pendingImmediate: true, incomingWarm: null }).immediate,
    ).toBe(true)
  })

  it('never marks a non-drop switch immediate, even on the safety timeout', () => {
    // The 2.5s timeout must still crossfade — only drops cut.
    const r = resolveCommit({ ...base, waited: 3 })
    expect(r.commit).toBe(true)
    expect(r.immediate).toBe(false)
  })
})
