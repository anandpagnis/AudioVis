import { beforeEach, describe, expect, it } from 'vitest'
import { sceneStreamer } from '../sceneStreamer'

/**
 * These pin the sequences SceneManager actually drives. Every one of them is a
 * path a scene switch takes at runtime, and a break here shows up as a scene
 * that silently never appears or never gets cleaned up — not as a crash.
 */
describe('sceneStreamer', () => {
  beforeEach(() => sceneStreamer.reset())

  it('walks a normal preload to READY through every intermediate state', () => {
    sceneStreamer.preload('plasma', 0)
    expect(sceneStreamer.status('plasma')).toBe('LOADING')
    sceneStreamer.noteLoaded('plasma')
    expect(sceneStreamer.status('plasma')).toBe('PREWARMING')
    sceneStreamer.noteReady('plasma')
    expect(sceneStreamer.status('plasma')).toBe('READY')
    expect(sceneStreamer.isReady('plasma')).toBe(true)
  })

  it('preload is idempotent — a repeat call does not restart a warming candidate', () => {
    // SceneManager calls this every frame while a switch is pending, so a
    // restart here would mean the scene never finishes warming.
    sceneStreamer.preload('plasma', 0)
    sceneStreamer.noteLoaded('plasma')
    sceneStreamer.preload('plasma', 5)
    expect(sceneStreamer.status('plasma')).toBe('PREWARMING')
  })

  it('promote from cold still reaches ACTIVE without an illegal jump', () => {
    // The commit can beat the warm-up when the beat grid is untrusted.
    sceneStreamer.promote('chrome', 1)
    expect(sceneStreamer.status('chrome')).toBe('ACTIVE')
  })

  it('promote from READY is the warm path', () => {
    sceneStreamer.preload('chrome', 0)
    sceneStreamer.noteLoaded('chrome')
    sceneStreamer.noteReady('chrome')
    expect(sceneStreamer.isReady('chrome')).toBe(true)
    sceneStreamer.promote('chrome', 1)
    expect(sceneStreamer.status('chrome')).toBe('ACTIVE')
  })

  it('retire moves the outgoing scene to UNLOADING and release then forgets it', () => {
    sceneStreamer.promote('a', 0)
    sceneStreamer.retire('a', 1)
    expect(sceneStreamer.status('a')).toBe('UNLOADING')
    sceneStreamer.release('a')
    expect(sceneStreamer.status('a')).toBeUndefined()
  })

  it('a scene re-requested while still fading out climbs back to ACTIVE', () => {
    // A -> B -> A inside one crossfade. Without the UNLOADING -> UNLOADED step
    // the record stays stuck in UNLOADING while its entry visibly fades in.
    sceneStreamer.promote('a', 0)
    sceneStreamer.retire('a', 1) // A is fading out
    sceneStreamer.preload('a', 2)
    expect(sceneStreamer.status('a')).toBe('LOADING')
    sceneStreamer.promote('a', 3)
    expect(sceneStreamer.status('a')).toBe('ACTIVE')
  })

  it('release does NOT drop a scene that was re-promoted while fading out', () => {
    // The old entry's prune fires after the new one is already live. Deleting
    // the record there would leave the on-screen scene untracked.
    sceneStreamer.promote('a', 0)
    sceneStreamer.retire('a', 1)
    sceneStreamer.promote('a', 2) // re-requested, now ACTIVE again
    sceneStreamer.release('a') // old entry finishes fading — must be a no-op
    expect(sceneStreamer.status('a')).toBe('ACTIVE')
  })

  it('retainPending evicts the older warming candidate and keeps the requested one', () => {
    sceneStreamer.preload('old', 0)
    sceneStreamer.preload('new', 1)
    const evicted = sceneStreamer.retainPending('new')
    expect(evicted).toEqual(['old'])
    expect(sceneStreamer.status('old')).toBeUndefined()
    expect(sceneStreamer.status('new')).toBe('LOADING')
  })

  it('retainPending never evicts the scene currently being requested', () => {
    sceneStreamer.preload('wanted', 5)
    expect(sceneStreamer.retainPending('wanted')).toEqual([])
    expect(sceneStreamer.status('wanted')).toBe('LOADING')
  })

  it('retainPending never evicts the ACTIVE scene', () => {
    sceneStreamer.promote('onscreen', 0)
    sceneStreamer.preload('incoming', 1)
    expect(sceneStreamer.retainPending('incoming')).toEqual([])
    expect(sceneStreamer.status('onscreen')).toBe('ACTIVE')
  })

  it('clearPending drops warming candidates but leaves ACTIVE and UNLOADING alone', () => {
    sceneStreamer.promote('active', 0)
    sceneStreamer.promote('leaving', 0)
    sceneStreamer.retire('leaving', 1)
    sceneStreamer.preload('warming', 1)
    const dropped = sceneStreamer.clearPending()
    expect(dropped).toEqual(['warming'])
    expect(sceneStreamer.status('active')).toBe('ACTIVE')
    expect(sceneStreamer.status('leaving')).toBe('UNLOADING')
  })

  it('a full A -> B switch leaves exactly one ACTIVE candidate', () => {
    sceneStreamer.promote('a', 0)
    sceneStreamer.preload('b', 1)
    sceneStreamer.noteLoaded('b')
    sceneStreamer.noteReady('b')
    sceneStreamer.retire('a', 2)
    sceneStreamer.promote('b', 2)
    sceneStreamer.release('a')
    const active = [...sceneStreamer.candidates().values()].filter(
      (c) => c.lifecycle.status === 'ACTIVE',
    )
    expect(active.map((c) => c.id)).toEqual(['b'])
  })

  it('never reports a candidate as ACTIVE without it having been LOADING first', () => {
    // The load-bearing invariant of the whole lifecycle: no UNLOADED -> ACTIVE.
    sceneStreamer.promote('x', 0)
    const candidate = sceneStreamer.candidates().get('x')!
    expect(candidate.lifecycle.status).toBe('ACTIVE')
    // A fresh candidate that was never promoted must not read as ACTIVE.
    sceneStreamer.preload('y', 0)
    expect(sceneStreamer.status('y')).not.toBe('ACTIVE')
  })
})
