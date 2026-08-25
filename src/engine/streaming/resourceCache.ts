/**
 * General-purpose, reference-counted cache for GPU resources and session-
 * lifetime loader singletons, shared across scenes.
 *
 * Modeled on a `Map<string, Texture>` + `inUse`-set shape that was a genuine,
 * working precedent for keyed caching with safe eviction in this codebase —
 * generalized here from one resource type/one consumer to arbitrary
 * types/N consumers, with real reference counting instead of a
 * manually-synced `inUse` set.
 *
 * Before this, the only shared-resource precedent (`getSharedEnvMap()`) was a
 * bare module-level singleton: not reference-counted, "deliberately never
 * disposed," and with no invalidation path across a WebGL context loss. This
 * cache generalizes that pattern and closes the context-loss gap via
 * {@link ResourceCache.invalidateAll}.
 */

export interface Disposable {
  dispose(): void
}

interface Entry<T> {
  value: T
  refCount: number
  byteSize: number
  /** Pinned entries (session-lifetime singletons, e.g. the shared env map or
   *  a loader instance) are exempt from refcount-triggered disposal — they
   *  only ever go away via {@link ResourceCache.invalidateAll}. */
  pinned: boolean
  dispose: (() => void) | null
}

export class ResourceCache {
  private entries = new Map<string, Entry<unknown>>()

  /**
   * Build-or-reuse a disposable resource, incrementing its reference count.
   * `pinned: true` marks it as a session-lifetime singleton (never disposed
   * by {@link release} reaching zero — only by {@link invalidateAll}).
   */
  acquire<T extends Disposable>(key: string, build: () => T, opts?: { pinned?: boolean }): T {
    const existing = this.entries.get(key)
    if (existing) {
      existing.refCount++
      return existing.value as T
    }
    const value = build()
    this.entries.set(key, {
      value,
      refCount: 1,
      byteSize: 0,
      pinned: opts?.pinned ?? false,
      dispose: () => value.dispose(),
    })
    return value
  }

  /**
   * Build-or-reuse a non-`Disposable` session singleton — for shared loader
   * instances (`GLTFLoader`, `DRACOLoader`, `KTX2Loader`) which have no
   * meaningful per-instance dispose contract. Always pinned.
   */
  acquireSingleton<T>(key: string, build: () => T): T {
    const existing = this.entries.get(key)
    if (existing) {
      existing.refCount++
      return existing.value as T
    }
    const value = build()
    this.entries.set(key, { value, refCount: 1, byteSize: 0, pinned: true, dispose: null })
    return value
  }

  /**
   * Release a reference. Non-pinned entries dispose immediately once the
   * refcount reaches zero — a resident scene that comes and goes quickly does
   * not thrash the cache, since the SAME key's next `acquire` before eviction
   * just re-increments rather than rebuilding (there is no re-entry after
   * disposal in this design; disposal is terminal for that key).
   */
  release(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    entry.refCount = Math.max(0, entry.refCount - 1)
    if (entry.refCount === 0 && !entry.pinned) {
      entry.dispose?.()
      this.entries.delete(key)
    }
  }

  /** Records the real, computed GPU byte size of a resource once built. */
  reportByteSize(key: string, bytes: number): void {
    const entry = this.entries.get(key)
    if (entry) entry.byteSize = bytes
  }

  totalBytes(): number {
    let total = 0
    for (const entry of this.entries.values()) total += entry.byteSize
    return total
  }

  /**
   * Context-loss hook. Clears every entry — pinned or not — WITHOUT calling
   * `.dispose()`: the GL handles are already dead, so there is nothing to
   * free, and calling into a dead WebGL context is at best a no-op and at
   * worst throws. Stage.tsx calls this from its `webglcontextrestored`
   * listener, before bumping `glEpoch` to remount the resource-holding tree.
   */
  invalidateAll(): void {
    this.entries.clear()
  }

  snapshot(): { key: string; refCount: number; byteSize: number; pinned: boolean }[] {
    return Array.from(this.entries, ([key, e]) => ({
      key,
      refCount: e.refCount,
      byteSize: e.byteSize,
      pinned: e.pinned,
    }))
  }
}

export const resourceCache = new ResourceCache()

/** Session-lifetime loader keys — acquired once via `acquireSingleton`, never released. */
export const LOADER_KEYS = {
  gltf: 'loader:gltf',
  draco: 'loader:draco',
  ktx2: 'loader:ktx2',
} as const
