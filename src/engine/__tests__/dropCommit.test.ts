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

/**
 * An ARMED scene (`engine/armedChange.ts`) is held: warmed like any pending scene, committed by nothing until it
 * is released. Unarmed, `resolveCommit` must be exactly what it was before arming existed.
 */
describe('resolveCommit — held (armed) scene', () => {
  const warm = { ...base, incomingWarm: true as boolean | null }

  it('is not committed by a downbeat, an untrusted grid, the 2.5 s backstop, or a pending-immediate flag', () => {
    expect(resolveCommit({ ...warm, held: true, onDownbeat: true }).commit).toBe(false)
    expect(resolveCommit({ ...warm, held: true, gridTrusted: false }).commit).toBe(false)
    expect(resolveCommit({ ...warm, held: true, waited: 60 }).commit).toBe(false)
    expect(resolveCommit({ ...warm, held: true, pendingImmediate: true }).commit).toBe(false)
    expect(resolveCommit({ ...warm, held: true, onDownbeat: true, waited: 60 }).immediate).toBe(false)
  })

  it('is held whether or not it has finished warming', () => {
    for (const incomingWarm of [true, false, null]) {
      expect(resolveCommit({ ...base, held: true, incomingWarm, onDownbeat: true, waited: 9 }).commit).toBe(false)
    }
  })

  it('released as a drop: a warm scene cuts at once', () => {
    const r = resolveCommit({ ...warm, held: false, pendingImmediate: true, waited: 0 })
    expect(r).toEqual({ commit: true, immediate: true })
  })

  it('released as a drop while still cold: waits only the usual grace, then cuts', () => {
    const cold = { ...base, held: false, pendingImmediate: true, incomingWarm: false }
    expect(resolveCommit({ ...cold, waited: 0.05 }).commit).toBe(false)
    expect(resolveCommit({ ...cold, waited: 0.4 })).toEqual({ commit: true, immediate: true })
  })

  it('released as a predicted drop: a normal crossfade that waits for the next downbeat, never a hard cut', () => {
    const released = { ...warm, held: false, pendingImmediate: false, waited: 0 }
    expect(resolveCommit(released).commit).toBe(false)
    expect(resolveCommit({ ...released, onDownbeat: true })).toEqual({ commit: true, immediate: false })
  })

  it('held omitted or false is byte-for-byte the unarmed behaviour, over every input combination', () => {
    for (const gridTrusted of [true, false])
      for (const onDownbeat of [true, false])
        for (const pendingImmediate of [true, false])
          for (const incomingWarm of [true, false, null])
            for (const waited of [0, 0.1, 0.4, 2.6, 9]) {
              const o = { gridTrusted, onDownbeat, pendingImmediate, incomingWarm, waited }
              expect(resolveCommit({ ...o, held: false })).toEqual(resolveCommit(o))
              expect(resolveCommit({ ...o, held: undefined })).toEqual(resolveCommit(o))
            }
  })
})
