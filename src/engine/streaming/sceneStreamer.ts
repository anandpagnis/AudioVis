import { CandidateRegistry, type StreamCandidate } from './candidateRegistry'
import type { SceneLifecycleStatus } from './lifecycle'

/**
 * Owns WHICH scenes are resident and WHAT lifecycle state each is in.
 * `SceneManager` owns mounting them, running the crossfade, and talking to the
 * GPU — this file never touches React, THREE, or `gl`, which is what keeps it
 * unit-testable without a browser.
 *
 * ## What this replaces
 *
 * The warming pipeline used to live as an ad-hoc `Entry.dir === 0` slot inside
 * `SceneManager`: find the one warming entry, and if a second request arrived
 * while it was still warming, throw it away and start over. That worked, but it
 * hard-coded "at most one non-active scene may exist" into the *rendering*
 * loop, where there was nowhere to express anything else — and it silently
 * discarded pre-warmed work every time two requests overlapped.
 *
 * Here that policy is explicit and lives in one place: {@link MAX_PENDING},
 * enforced by {@link retainPending}. Phase 6 sets it to 1, which reproduces the
 * old behaviour exactly. Raising it is what Phase 7 does, and nothing in
 * `SceneManager` has to change for that — it already reconciles against
 * whatever set of candidates this reports.
 *
 * Priorities are passed in rather than read from the scene registry, so this
 * module has no dependency on `src/scenes` (which pulls in React and every
 * scene's lazy wrapper).
 */

/**
 * How many non-active candidates may be resident at once.
 *
 * 1 reproduces the pre-refactor behaviour exactly: a new request evicts
 * whatever was warming. Phase 7 raises this and gates it on the budget ledger,
 * at which point overlapping requests stop destroying each other's work.
 */
export const MAX_PENDING = 1

class SceneStreamer {
  private registry = new CandidateRegistry()

  /** Begin (or continue) bringing `id` toward READY. Safe to call every frame. */
  preload(id: string, nowSec: number, priority = 0): StreamCandidate {
    const candidate = this.registry.ensure(id, priority, nowSec)
    const lc = candidate.lifecycle
    // Re-requested while still fading out from the previous switch — let it
    // climb the chain again rather than sitting stuck in UNLOADING.
    if (lc.status === 'UNLOADING') lc.transition('UNLOADED')
    // UNLOADED -> LOADING is the only legal first step; the state machine
    // rejects anything else, so a repeat call on an in-flight candidate is a
    // no-op rather than a restart.
    lc.transition('LOADING')
    return candidate
  }

  /** The scene's lazy chunk resolved — it can start compiling shaders. */
  noteLoaded(id: string): void {
    this.registry.get(id)?.lifecycle.transition('PREWARMING')
  }

  /** Shader work finished (warm frames elapsed, or compileAsync confirmed). */
  noteReady(id: string): void {
    this.registry.get(id)?.lifecycle.transition('READY')
  }

  status(id: string): SceneLifecycleStatus | undefined {
    return this.registry.get(id)?.lifecycle.status
  }

  /** Warmed and waiting — promoting this costs no compile stall. */
  isReady(id: string): boolean {
    return this.status(id) === 'READY'
  }

  /**
   * Put a scene on screen.
   *
   * Walks the legal chain rather than jumping straight to ACTIVE, because a
   * commit can legitimately land before warming has finished — an untrusted
   * beat grid commits immediately, and the initial scene is on screen before
   * this pipeline ever sees it. Stepping through keeps `UNLOADED -> ACTIVE`
   * impossible by construction while still allowing an early promotion.
   *
   * Ask {@link isReady} BEFORE calling this if you want to know whether the
   * promotion was warm (no compile stall expected) or cold.
   */
  promote(id: string, nowSec: number, priority = 0): void {
    const candidate = this.registry.ensure(id, priority, nowSec)
    const lc = candidate.lifecycle
    if (lc.status === 'BACKGROUND') {
      // Already resident and warm — straight back on screen, no reload. This
      // is the payoff of keeping a demoted scene around (Phase 7).
      lc.transition('ACTIVE')
    } else {
      // A scene can be re-requested while it is still fading out from the last
      // switch (A -> B -> A inside one crossfade). Run it back to UNLOADED
      // first so it can climb the chain again, rather than leaving the record
      // stuck in UNLOADING while its entry is visibly fading in.
      if (lc.status === 'UNLOADING') lc.transition('UNLOADED')
      lc.transition('LOADING')
      lc.transition('PREWARMING')
      lc.transition('READY')
      lc.transition('ACTIVE')
    }
    candidate.lastActiveAtSec = nowSec
  }

  /** ACTIVE -> UNLOADING. The entry keeps rendering while it fades out. */
  retire(id: string, nowSec: number): void {
    const candidate = this.registry.get(id)
    if (!candidate) return
    candidate.lastActiveAtSec = nowSec
    candidate.lifecycle.transition('UNLOADING')
  }

  /**
   * Forget a retiring candidate whose entry has finished fading out.
   *
   * Only removes it if it is actually still UNLOADING. The same scene id can
   * be re-requested and promoted back to ACTIVE while its previous entry is
   * still fading out, and that old entry's prune must not then delete the live
   * record out from under it.
   */
  release(id: string): void {
    const candidate = this.registry.get(id)
    if (!candidate || candidate.lifecycle.status !== 'UNLOADING') return
    this.registry.remove(id)
  }

  /**
   * Enforce {@link MAX_PENDING} over the non-active candidates, keeping the
   * most recently requested. Returns the ids that lost their slot so the caller
   * can unmount them.
   *
   * `keepId` is the scene the show currently wants; it is never evicted even if
   * it is the oldest, because evicting the thing that was just asked for is how
   * the old code managed to throw away work it was about to need.
   */
  retainPending(keepId: string | null, limit = MAX_PENDING): string[] {
    const pending = [...this.registry.all().values()].filter(
      (c) => c.id !== keepId && isPendingStatus(c.lifecycle.status),
    )
    if (pending.length <= Math.max(0, limit - (keepId ? 1 : 0))) return []

    // Oldest request first — those are the ones that lost the race.
    pending.sort((a, b) => a.requestedAtSec - b.requestedAtSec)
    const keepCount = Math.max(0, limit - (keepId ? 1 : 0))
    const evicted = pending.slice(0, pending.length - keepCount)
    for (const candidate of evicted) this.registry.remove(candidate.id)
    return evicted.map((c) => c.id)
  }

  /** Drop every non-active candidate — nothing is pending any more. */
  clearPending(): string[] {
    const dropped: string[] = []
    for (const candidate of [...this.registry.all().values()]) {
      if (!isPendingStatus(candidate.lifecycle.status)) continue
      this.registry.remove(candidate.id)
      dropped.push(candidate.id)
    }
    return dropped
  }

  candidates(): ReadonlyMap<string, StreamCandidate> {
    return this.registry.all()
  }

  /** Test seam — drops all bookkeeping. */
  reset(): void {
    this.registry = new CandidateRegistry()
  }
}

/** Resident (or becoming resident) but not on screen — i.e. evictable. */
function isPendingStatus(status: SceneLifecycleStatus): boolean {
  return status === 'LOADING' || status === 'PREWARMING' || status === 'READY'
}

export const sceneStreamer = new SceneStreamer()
