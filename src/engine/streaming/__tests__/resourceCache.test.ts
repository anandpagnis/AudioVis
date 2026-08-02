import { describe, expect, it, vi } from 'vitest'
import { ResourceCache } from '../resourceCache'

function stub() {
  return { dispose: vi.fn() }
}

describe('ResourceCache', () => {
  it('builds once and reuses on subsequent acquires of the same key', () => {
    const cache = new ResourceCache()
    const build = vi.fn(stub)
    const a = cache.acquire('k', build)
    const b = cache.acquire('k', build)
    expect(a).toBe(b)
    expect(build).toHaveBeenCalledTimes(1)
  })

  it('disposes exactly once when refcount reaches zero for a non-pinned entry', () => {
    const cache = new ResourceCache()
    const item = stub()
    cache.acquire('k', () => item)
    cache.acquire('k', () => item) // refcount 2
    cache.release('k')
    expect(item.dispose).not.toHaveBeenCalled()
    cache.release('k')
    expect(item.dispose).toHaveBeenCalledTimes(1)
    cache.release('k') // extra release below zero must not double-dispose
    expect(item.dispose).toHaveBeenCalledTimes(1)
  })

  it('never disposes a pinned entry, no matter how far the refcount drops', () => {
    const cache = new ResourceCache()
    const item = stub()
    cache.acquire('k', () => item, { pinned: true })
    cache.release('k')
    cache.release('k')
    expect(item.dispose).not.toHaveBeenCalled()
    // Still resolvable after "release" — a pinned entry stays alive.
    const again = cache.acquire('k', () => stub(), { pinned: true })
    expect(again).toBe(item)
  })

  it('rebuilds after a non-pinned entry is fully released and re-acquired', () => {
    const cache = new ResourceCache()
    const first = stub()
    const second = stub()
    let calls = 0
    const build = () => (calls++ === 0 ? first : second)
    const a = cache.acquire('k', build)
    cache.release('k')
    expect(first.dispose).toHaveBeenCalledTimes(1)
    const b = cache.acquire('k', build)
    expect(b).toBe(second)
    expect(b).not.toBe(a)
  })

  it('acquireSingleton shares one instance and is always pinned', () => {
    const cache = new ResourceCache()
    const build = vi.fn(() => ({ loaded: true }))
    const a = cache.acquireSingleton('loader', build)
    const b = cache.acquireSingleton('loader', build)
    expect(a).toBe(b)
    expect(build).toHaveBeenCalledTimes(1)
    cache.release('loader')
    cache.release('loader')
    expect(cache.snapshot().find((e) => e.key === 'loader')?.pinned).toBe(true)
  })

  it('tracks reported byte sizes and totalBytes across entries', () => {
    const cache = new ResourceCache()
    cache.acquire('a', stub)
    cache.acquire('b', stub)
    cache.reportByteSize('a', 1000)
    cache.reportByteSize('b', 2000)
    expect(cache.totalBytes()).toBe(3000)
  })

  it('invalidateAll clears every entry WITHOUT calling dispose on any of them', () => {
    const cache = new ResourceCache()
    const pinned = stub()
    const normal = stub()
    cache.acquire('pinned', () => pinned, { pinned: true })
    cache.acquire('normal', () => normal)
    cache.invalidateAll()
    expect(pinned.dispose).not.toHaveBeenCalled()
    expect(normal.dispose).not.toHaveBeenCalled()
    expect(cache.snapshot()).toEqual([])
  })

  it('snapshot reflects live refcount/byteSize/pinned state', () => {
    const cache = new ResourceCache()
    cache.acquire('k', stub)
    cache.acquire('k', stub)
    cache.reportByteSize('k', 500)
    const [entry] = cache.snapshot()
    expect(entry).toEqual({ key: 'k', refCount: 2, byteSize: 500, pinned: false })
  })
})
