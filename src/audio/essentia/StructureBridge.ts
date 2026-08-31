import type { AudioFeatures } from '../types'
import type { StructureRaw, StructureResponse, StructureResult } from './structureProtocol'

/**
 * Main-thread side of the song-structure analyzer.
 *
 * Same shape as `VoiceBridge`: its own worker, a rolling PCM ring, slow
 * cadence, results drained on the next frame. Fails silent — no worker or a
 * WASM failure leaves `f.songSection` / `f.structureValid` at their defaults
 * and stops the retries; `SectionTracker` then runs on the synchronous
 * drop/build flags alone and directors fall back to `f.sectionChange`.
 */

/** Section analysis is a whole-track read; a long window is the point. */
const WINDOW_SEC = 120
const RING_SEC = WINDOW_SEC + 4
/** Base seconds between jobs; self-throttled up to CADENCE_MAX from `costMs`. */
const CADENCE_SEC = 15
const CADENCE_MAX = 45
/** Let the rhythm + voice workers get their first reads in first. */
const FIRST_JOB_DELAY_SEC = 8
/** Don't segment less than this much history — short windows over-segment. */
const MIN_HISTORY_SEC = 30

export interface StructureStatus {
  running: boolean
  /** essentia WASM / worker unavailable — permanent for the session. */
  missing: boolean
  loaded: boolean
  lastMs: number
  lastBoundaries: number
  runs: number
  error: string | null
}

class StructureBridge {
  readonly status: StructureStatus = {
    running: false,
    missing: false,
    loaded: false,
    lastMs: 0,
    lastBoundaries: 0,
    runs: 0,
    error: null,
  }

  private worker: Worker | null = null
  private ring: Float32Array | null = null
  private ringWrite = 0
  private ringFilled = 0
  private sampleRate = 48000
  private busy = false
  private lastJobAt = -1
  private startedAt = -1
  private cadence = CADENCE_SEC
  private jobId = 0
  private pending: StructureResult | null = null
  private window: Float32Array | null = null
  private disabled = false

  /** Called by EssentiaBridge's AudioWorklet tap — one worklet feeds all bridges. */
  pushPcm(block: Float32Array, sampleRate: number) {
    if (this.disabled) return
    if (!this.ring || this.sampleRate !== sampleRate) {
      this.sampleRate = sampleRate
      this.ring = new Float32Array(Math.ceil(sampleRate * RING_SEC))
      this.ringWrite = 0
      this.ringFilled = 0
    }
    const ring = this.ring
    for (let i = 0; i < block.length; i++) {
      ring[this.ringWrite] = block[i]
      this.ringWrite = (this.ringWrite + 1) % ring.length
    }
    this.ringFilled = Math.min(ring.length, this.ringFilled + block.length)
  }

  reset() {
    this.ring = null
    this.ringFilled = 0
    this.ringWrite = 0
    this.busy = false
    this.lastJobAt = -1
    this.startedAt = -1
    this.cadence = CADENCE_SEC
    this.pending = null
    this.status.lastBoundaries = 0
    // The worker (with its loaded WASM) survives — a new source shouldn't re-pay it.
  }

  /**
   * Per-frame drain + schedule. Returns the freshly-arrived `StructureRaw` on
   * the frame it lands, else `null` (the common case — `SectionTracker` holds).
   * Allocation-free unless dispatching a job.
   */
  update(f: AudioFeatures): StructureRaw | null {
    if (this.disabled) return null

    let out: StructureRaw | null = null
    if (this.pending) {
      const r = this.pending
      this.pending = null
      out = {
        atBeat: r.atBeat,
        novelty: r.novelty,
        boundaries: r.boundaries,
        segments: r.segments,
        build: r.build,
        costMs: r.costMs,
      }
    }

    if (!this.ring || f.silence) return out
    if (this.ringFilled < this.sampleRate * MIN_HISTORY_SEC) return out
    const now = f.time
    if (this.startedAt < 0) this.startedAt = now
    if (now - this.startedAt < FIRST_JOB_DELAY_SEC) return out
    if (this.busy) return out
    if (this.lastJobAt >= 0 && now - this.lastJobAt < this.cadence) return out
    if (!this.ensureWorker()) return out

    this.lastJobAt = now
    this.busy = true
    const win = this.copyWindow(WINDOW_SEC)
    this.jobId++
    this.worker!.postMessage(
      {
        id: this.jobId,
        pcm: win,
        sampleRate: this.sampleRate,
        bpm: f.bpm,
        endBeatIndex: f.beatIndex,
        endBeatProgress: f.beatProgress,
      },
      [win.buffer],
    )
    this.window = null
    return out
  }

  private ensureWorker(): boolean {
    if (this.worker) return true
    if (this.disabled) return false
    try {
      const worker = new Worker(new URL('./structure.worker.ts', import.meta.url), {
        type: 'module',
      })
      worker.onmessage = (e: MessageEvent<StructureResponse>) => {
        this.busy = false
        const r = e.data
        if (r.type === 'error') {
          this.status.error = r.message
          this.status.missing = r.missing
          if (r.missing) this.disable()
          return
        }
        this.pending = r
        this.status.loaded = true
        this.status.lastMs = r.costMs
        this.status.lastBoundaries = r.boundaries.length
        this.status.runs++
        this.status.error = null
        // Self-throttle: never spend more than ~a third of the wall clock analysing.
        this.cadence = Math.min(CADENCE_MAX, Math.max(CADENCE_SEC, (r.costMs / 1000) * 3))
      }
      worker.onerror = (e) => {
        this.status.error = e.message || 'structure worker error'
        this.busy = false
        this.disable()
      }
      this.worker = worker
      this.status.running = true
      return true
    } catch (err) {
      this.status.error = err instanceof Error ? err.message : String(err)
      this.disable()
      return false
    }
  }

  private disable() {
    this.disabled = true
    this.status.running = false
    this.worker?.terminate()
    this.worker = null
  }

  /** Newest `sec` seconds out of the ring, chronological, via two memcpys. */
  private copyWindow(sec: number): Float32Array {
    const ring = this.ring
    const n = Math.min(this.ringFilled, Math.floor(this.sampleRate * sec))
    if (!this.window || this.window.length !== n) this.window = new Float32Array(n)
    const out = this.window
    if (!ring) return out
    const start = (this.ringWrite - n + ring.length) % ring.length
    const firstRun = Math.min(n, ring.length - start)
    out.set(ring.subarray(start, start + firstRun), 0)
    if (firstRun < n) out.set(ring.subarray(0, n - firstRun), firstRun)
    return out
  }
}

export const structureBridge = new StructureBridge()
