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

/**
 * The incoming scene must be shader-warm before a NORMAL (beat-locked) switch
 * commits — not just before a drop switch.
 *
 * This gate used to apply only to `pendingImmediate`, and the omission was the
 * largest single source of transition stalls. `requestScene` fires whenever
 * AutoPilot sees a mood change; if the next downbeat lands a frame or two
 * later, the chunk has not arrived and the program has not linked. The commit
 * promoted a cold entry and the driver compiled it on its first real draw — a
 * multi-hundred-millisecond freeze, landing exactly on the beat.
 *
 * The old suite missed it because its `base` fixture already had
 * `incomingWarm: true`, so no case ever exercised a cold downbeat.
 */
describe('resolveCommit — warm gate on normal switches', () => {
  const cold = { ...base, incomingWarm: false }

  it('does NOT commit on a downbeat while the incoming shader is cold', () => {
    expect(resolveCommit({ ...cold, onDownbeat: true }).commit).toBe(false)
  })

  it('commits on the next downbeat once it is warm', () => {
    expect(resolveCommit({ ...base, onDownbeat: true }).commit).toBe(true)
  })

  it('commits on a downbeat when there is no warm entry to wait for', () => {
    // null means nothing is warming — waiting could never be satisfied, so the
    // gate must not turn into a deadlock.
    expect(
      resolveCommit({ ...base, incomingWarm: null, onDownbeat: true }).commit,
    ).toBe(true)
  })

  it('still lands via the safety timeout if the scene never warms', () => {
    // Skipping a downbeat costs one bar; this is the backstop that stops a
    // scene which never compiles from hanging the show indefinitely.
    expect(resolveCommit({ ...cold, onDownbeat: true, waited: 3 }).commit).toBe(true)
  })

  it('still commits at once on an untrusted grid, warm or not', () => {
    // No usable beat grid means there is no downbeat worth waiting for, and the
    // pre-existing behaviour is to cut immediately.
    expect(resolveCommit({ ...cold, gridTrusted: false }).commit).toBe(true)
  })

  it('leaves the drop path unchanged', () => {
    // A drop still has its own, shorter grace (IMMEDIATE_WARM_GRACE_SEC) and is
    // not subject to the downbeat gate at all.
    const drop = { ...cold, pendingImmediate: true }
    expect(resolveCommit({ ...drop, waited: 0.05 }).commit).toBe(false)
    expect(resolveCommit({ ...drop, waited: 0.4 }).commit).toBe(true)
    expect(resolveCommit({ ...drop, waited: 0.4 }).immediate).toBe(true)
  })
})
