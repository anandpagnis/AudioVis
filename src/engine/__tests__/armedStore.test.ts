import { beforeEach, describe, expect, it, vi } from 'vitest'

// Only the lazy-chunk fetch is stubbed (it would import a real scene module in node); the real registry still
// answers `canHoldPrimary`, so an effect-only scene is refused for real.
vi.mock('../../scenes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../scenes')>()),
  preloadScene: vi.fn(),
}))

import STORE_SRC from '../../store.ts?raw'
import { canAutoSwitch, MIN_SUBJECT_DWELL_BEATS, useStore } from '../../store'

function reset() {
  useStore.setState({
    sceneId: 'wireframe',
    pendingSceneId: null,
    pendingImmediate: false,
    heldSceneId: null,
    lastCommitBeat: -Infinity,
    recentSceneIds: [],
  })
}

const st = () => useStore.getState()

describe('store: armScene', () => {
  beforeEach(reset)

  it('holds a scene in the pending slot without making it immediate', () => {
    expect(st().armScene('kifs')).toBe(true)
    expect(st().pendingSceneId).toBe('kifs')
    expect(st().heldSceneId).toBe('kifs')
    expect(st().pendingImmediate).toBe(false)
  })

  it('refuses the scene already on screen, and refuses while the pending slot is taken', () => {
    expect(st().armScene('wireframe')).toBe(false)
    expect(st().pendingSceneId).toBeNull()
    expect(st().requestScene('plasma', { auto: true, immediate: false })).toBe(true)
    expect(st().armScene('kifs')).toBe(false)
    expect(st().pendingSceneId).toBe('plasma')
    expect(st().heldSceneId).toBeNull()
  })

  it('refuses a scene that cannot be the subject (an effect-only scene)', () => {
    expect(st().armScene('ribbons')).toBe(false)
    expect(st().pendingSceneId).toBeNull()
    expect(st().heldSceneId).toBeNull()
  })

  it('does not check the dwell floor (a hold is not a switch), unlike an automatic request at the same moment', () => {
    // A scene committed this very beat: the 32-beat dwell has not elapsed.
    useStore.setState({ lastCommitBeat: 0 })
    expect(canAutoSwitch(0, MIN_SUBJECT_DWELL_BEATS - 1)).toBe(false)
    expect(st().requestScene('kifs', { auto: true, immediate: false })).toBe(false) // the floor is intact
    expect(st().pendingSceneId).toBeNull()
    expect(st().armScene('kifs')).toBe(true) // ...and a hold is not bound by it
    expect(st().pendingSceneId).toBe('kifs')
  })

  it('does not count as a manual action (it must not start the 45 s manual hold)', () => {
    useStore.setState({ lastManualAt: -1000 })
    st().armScene('kifs')
    expect(st().lastManualAt).toBe(-1000)
  })
})

describe('store: releaseHold', () => {
  beforeEach(reset)

  it('a drop release makes the pending scene immediate and clears the hold', () => {
    st().armScene('kifs')
    expect(st().releaseHold(true)).toBe(true)
    expect(st().heldSceneId).toBeNull()
    expect(st().pendingSceneId).toBe('kifs')
    expect(st().pendingImmediate).toBe(true)
  })

  it('a predicted release keeps it a normal (downbeat, crossfade) switch', () => {
    st().armScene('kifs')
    expect(st().releaseHold(false)).toBe(true)
    expect(st().pendingSceneId).toBe('kifs')
    expect(st().pendingImmediate).toBe(false)
    expect(st().heldSceneId).toBeNull()
  })

  it('does nothing when nothing is held', () => {
    expect(st().releaseHold(true)).toBe(false)
    expect(st().pendingImmediate).toBe(false)
  })

  it('a stale hold (its scene is no longer the pending one) is cleared and never makes an unrelated request immediate', () => {
    useStore.setState({ heldSceneId: 'kifs', pendingSceneId: 'plasma', pendingImmediate: false })
    expect(st().releaseHold(true)).toBe(false)
    expect(st().heldSceneId).toBeNull()
    expect(st().pendingImmediate).toBe(false)
    expect(st().pendingSceneId).toBe('plasma')
  })
})

describe('store: disarmScene', () => {
  beforeEach(reset)

  it('gives the pending slot back when the held scene is still the pending one', () => {
    st().armScene('kifs')
    st().disarmScene()
    expect(st().pendingSceneId).toBeNull()
    expect(st().heldSceneId).toBeNull()
    expect(st().pendingImmediate).toBe(false)
  })

  it('never cancels someone else\'s pending request: a stale hold is cleared and the request survives', () => {
    useStore.setState({ heldSceneId: 'kifs', pendingSceneId: 'plasma', pendingImmediate: true })
    st().disarmScene()
    expect(st().heldSceneId).toBeNull()
    expect(st().pendingSceneId).toBe('plasma')
    expect(st().pendingImmediate).toBe(true)
  })

  it('is a no-op when nothing is held, so a manual pending request is untouched', () => {
    st().requestScene('plasma')
    st().disarmScene()
    expect(st().pendingSceneId).toBe('plasma')
  })
})

describe('store: any other request or a commit drops the hold', () => {
  beforeEach(reset)

  it('a manual pick replaces the held scene outright and is never held', () => {
    st().armScene('kifs')
    expect(st().requestScene('plasma')).toBe(true)
    expect(st().pendingSceneId).toBe('plasma')
    expect(st().heldSceneId).toBeNull()
  })

  it('an automatic request for the armed scene itself doubles as its confirmation', () => {
    st().armScene('kifs')
    expect(st().requestScene('kifs', { auto: true, immediate: true })).toBe(true)
    expect(st().heldSceneId).toBeNull()
    expect(st().pendingSceneId).toBe('kifs')
    expect(st().pendingImmediate).toBe(true)
  })

  it('commitScene clears the hold and puts the scene on screen', () => {
    st().armScene('kifs')
    st().releaseHold(true)
    st().commitScene()
    expect(st().sceneId).toBe('kifs')
    expect(st().pendingSceneId).toBeNull()
    expect(st().heldSceneId).toBeNull()
  })

  it('the persisted allowlist does not include the hold (it is transient by omission)', () => {
    const start = STORE_SRC.indexOf('partialize:')
    expect(start).toBeGreaterThan(0)
    const block = STORE_SRC.slice(start, STORE_SRC.indexOf('}),', start))
    expect(block).toContain('sceneId: s.sceneId') // sanity: this is the right block
    expect(block).not.toContain('heldSceneId')
    expect(block).not.toContain('pendingSceneId')
  })
})
