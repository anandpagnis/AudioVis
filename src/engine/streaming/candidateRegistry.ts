import { SceneLifecycle } from './lifecycle'

/**
 * Plain-data bookkeeping for a scene that's somewhere in the streaming
 * pipeline — requested, loading, warming, resident, or active. One entry per
 * scene id; `sceneStreamer.ts` composes this with the resource cache and
 * budget ledger, but this file itself has no THREE/React imports, so it's
 * directly unit-testable.
 */
export interface StreamCandidate {
  id: string
  lifecycle: SceneLifecycle
  requestedAtSec: number
  lastActiveAtSec: number
  priority: number
  /** ResourceCache keys this candidate owns, so eviction can release them all. */
  resourceKeys: string[]
}

export class CandidateRegistry {
  private map = new Map<string, StreamCandidate>()

  get(id: string): StreamCandidate | undefined {
    return this.map.get(id)
  }

  /** Idempotent: returns the existing candidate if one is already tracked,
   *  otherwise creates a fresh UNLOADED one. Never resets an in-flight
   *  candidate's progress just because it was requested again. */
  ensure(id: string, priority: number, nowSec: number): StreamCandidate {
    const existing = this.map.get(id)
    if (existing) return existing
    const candidate: StreamCandidate = {
      id,
      lifecycle: new SceneLifecycle(),
      requestedAtSec: nowSec,
      lastActiveAtSec: nowSec,
      priority,
      resourceKeys: [],
    }
    this.map.set(id, candidate)
    return candidate
  }

  remove(id: string): void {
    this.map.delete(id)
  }

  all(): ReadonlyMap<string, StreamCandidate> {
    return this.map
  }
}
