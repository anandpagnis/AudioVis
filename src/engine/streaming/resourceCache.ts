/**
 * General-purpose, reference-counted cache for GPU resources and session-
 * lifetime loader singletons, shared across scenes.
 *
 * Modeled on a `Map<string, Texture>` +
 * `inUse`-set shape — that class is a genuine, working precedent for keyed
 * caching with safe eviction in this codebase — generalized here from one
 * resource type/one consumer to arbitrary types/N consumers, with real
 * reference counting instead of a manually-synced `inUse` set.
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
   * Byte sizes for GPU resources whose LIFECYCLE is owned elsewhere — the
   * render targets cached in `createShaderScene.tsx`'s own `WeakMap`s
   * (F138/F144/F147) are the reason this exists (F16). Those targets
   * deliberately don't go through {@link acquire}/{@link release}: they are
   * session-resident by design ("pay once, keep it"), refcounting a resource
   * nothing ever frees would just be bookkeeping with no decision behind it.
   * But `budgetLedger.ts`'s whole premise — "the VRAM-budget mechanism the
   * uncapped render targets actually need" — needs their real size
   * SOMEWHERE, or {@link totalBytes} silently undercounts the resources most
   * worth tracking. This is a plain size ledger, not a second cache: no
   * refcount, no `dispose`, no eviction — the owner reports, this just adds
   * it to the total.
   */
  private externalEntries = new Map<string, number>()

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

  /**
   * Reports (or updates) the byte size of an externally-owned resource — see
   * {@link externalEntries}. Call again with the same key any time the real
   * size changes (e.g. a grow-only render-target resize); there is no
   * corresponding release call, because there is no corresponding acquire —
   * the key simply keeps whatever was last reported until the session ends
   * or a context loss clears it via {@link invalidateAll}.
   */
  reportExternalByteSize(key: string, bytes: number): void {
    this.externalEntries.set(key, bytes)
  }

  totalBytes(): number {
    let total = 0
    for (const entry of this.entries.values()) total += entry.byteSize
    for (const bytes of this.externalEntries.values()) total += bytes
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
    this.externalEntries.clear()
  }

  snapshot(): { key: string; refCount: number; byteSize: number; pinned: boolean }[] {
    const owned = Array.from(this.entries, ([key, e]) => ({
      key,
      refCount: e.refCount,
      byteSize: e.byteSize,
      pinned: e.pinned,
    }))
    // Externally-owned entries have no refcount/pin concept — reported as a
    // permanent single reference so a snapshot reader doesn't have to know
    // about two different resource shapes to add up a total that means
    // anything.
    const external = Array.from(this.externalEntries, ([key, byteSize]) => ({
      key,
      refCount: 1,
      byteSize,
      pinned: true,
    }))
    return [...owned, ...external]
  }
}

export const resourceCache = new ResourceCache()
