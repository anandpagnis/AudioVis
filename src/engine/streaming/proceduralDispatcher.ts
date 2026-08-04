import type {
  DissolveGenParams,
  DissolveGenResult,
  PlasmaGenParams,
  PlasmaGenResult,
  PointCloudGenParams,
  PointCloudGenResult,
} from './proceduralGen'
import {
  generateDissolveField,
  generatePlasmaField,
  generatePointCloudField,
} from './proceduralGen'
import type { ProceduralRequest, ProceduralResponse } from './proceduralGen.worker'

/**
 * Main-thread scheduler for off-thread procedural generation.
 *
 * A small pool (2 workers) rather than one, so Plasma and Dissolve Cage can
 * build concurrently instead of serializing — the case that actually happens
 * when the director composes a primary and a layer at the same boundary.
 * Requests round-robin across the pool; responses are matched by request id,
 * so a worker can have several in flight.
 *
 * Falls back to synchronous main-thread generation if Workers are unavailable
 * or the pool fails. That path is exactly the pre-refactor behavior — a hitch,
 * but a working scene — which is the right failure mode here: never a blank
 * screen because a worker didn't start.
 */

const POOL_SIZE = 2

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
}

class ProceduralDispatcher {
  private workers: Worker[] = []
  private pending = new Map<number, Pending>()
  private nextId = 1
  private nextWorker = 0
  private failed = false

  private ensurePool(): boolean {
    if (this.failed) return false
    if (this.workers.length > 0) return true
    if (typeof Worker === 'undefined') {
      this.failed = true
      return false
    }
    try {
      for (let i = 0; i < POOL_SIZE; i++) {
        const worker = new Worker(new URL('./proceduralGen.worker.ts', import.meta.url), {
          type: 'module',
        })
        worker.onmessage = (e: MessageEvent<ProceduralResponse>) => this.handle(e.data)
        worker.onerror = () => this.failPool()
        this.workers.push(worker)
      }
      return true
    } catch {
      this.failPool()
      return false
    }
  }

  /**
   * A worker that errors takes the whole pool down to the synchronous path.
   * A partially-broken pool would silently stall whichever requests happened
   * to round-robin onto the dead worker, forever — much worse to debug than
   * a clean fallback.
   */
  private failPool(): void {
    this.failed = true
    for (const worker of this.workers) worker.terminate()
    this.workers = []
    for (const [, entry] of this.pending) entry.reject(new Error('procedural worker pool failed'))
    this.pending.clear()
  }

  private handle(res: ProceduralResponse): void {
    const entry = this.pending.get(res.id)
    if (!entry) return
    this.pending.delete(res.id)
    if (res.kind === 'error') entry.reject(new Error(res.message))
    else entry.resolve(res.result)
  }

  private dispatch<T>(request: Omit<ProceduralRequest, 'id'>): Promise<T> {
    const id = this.nextId++
    const worker = this.workers[this.nextWorker % this.workers.length]
    this.nextWorker++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      worker.postMessage({ ...request, id } as ProceduralRequest)
    })
  }

  async requestPlasma(params: PlasmaGenParams): Promise<PlasmaGenResult> {
    if (!this.ensurePool()) return generatePlasmaField(params)
    try {
      return await this.dispatch<PlasmaGenResult>({ kind: 'plasma', params })
    } catch {
      return generatePlasmaField(params)
    }
  }

  async requestPointCloud(params: PointCloudGenParams): Promise<PointCloudGenResult> {
    if (!this.ensurePool()) return generatePointCloudField(params)
    try {
      return await this.dispatch<PointCloudGenResult>({ kind: 'pointcloud', params })
    } catch {
      return generatePointCloudField(params)
    }
  }

  async requestDissolve(params: DissolveGenParams): Promise<DissolveGenResult> {
    if (!this.ensurePool()) return generateDissolveField(params)
    try {
      // The source position/normal arrays are structured-CLONED into the
      // worker, not transferred. Transferring would be one fewer ~600KB copy,
      // but it detaches the caller's arrays — and the catch below needs them
      // intact to regenerate synchronously if the worker fails. Paying a copy
      // to keep the fallback correct is the right trade: the copy is
      // microseconds, the work being moved off-thread is milliseconds.
      return await this.dispatch<DissolveGenResult>({ kind: 'dissolve', params })
    } catch {
      return generateDissolveField(params)
    }
  }
}

export const proceduralDispatcher = new ProceduralDispatcher()
