import type { BpmEstimator } from '../BpmEstimator'
import type { AudioFeatures } from '../types'
import {
  applyDispatch,
  drainResults,
  ingestResponse,
  makeSchedState,
  pickJob,
  resetSchedState,
  MODEL_FRESH_SEC,
} from './scheduling'
import { structureBridge } from './StructureBridge'
import { voiceBridge } from './VoiceBridge'
import type { EssentiaResponse } from './protocol'

/**
 * Main-thread side of the Essentia integration.
 *
 * Owns a preallocated mono PCM ring buffer fed by a tiny AudioWorklet tap,
 * schedules analysis jobs to the essentia worker on a slow cadence, and holds
 * the latest result until AudioEngine.update() drains it on the next frame —
 * the same async fade-in pattern as the AI-texture backend. Nothing here
 * blocks or allocates in the per-frame path; a dead/unsupported worker means
 * the pending slot stays empty and the built-in estimator keeps running.
 */

const RING_SEC = 14
const RHYTHM_WINDOW_SEC = 12
/**
 * Never analyze a partial window. Measured: the same 82 BPM click track reads
 * 82.03 from a 12 s window but 163.84 — a confident double-time error — from
 * an 8 s one. Short windows don't just add noise, they produce wrong answers
 * that look certain, so the first read simply waits for a full window.
 *
 * Global, not rhythm-scoped: every job takes a `copyWindow(RHYTHM_WINDOW_SEC)`
 * window, so key/danceability wait for it too.
 */
const RHYTHM_MIN_SEC = RHYTHM_WINDOW_SEC

// The job cadences + the scheduler itself live in ./scheduling.ts (issue 16).

/**
 * PCM tap block size, in samples (audit item 11 / F167).
 *
 * Was 4096 (~85 ms @ 48 k, ~12 msg/s). Halved to 2048 (~43 ms @ 48 k,
 * ~23 msg/s): the first rhythm/key/structure analysis can start up to ~43 ms
 * sooner, and a source cut is noticed a block earlier. Must stay a multiple of
 * the 128-frame render quantum. No point going lower — 1024 is ~10 ms and the
 * per-message overhead (one postMessage + three synchronous ring copies on the
 * main thread) starts to dominate the win.
 *
 * The audit item also asked for timestamps on each block. Deliberately not
 * added: every consumer (`pushPcm` into a seconds-sized ring, right-aligned to
 * "now") treats the newest sample as the present and nothing does cross-stream
 * sample-accurate alignment, so a per-block frame counter would be dead weight.
 * If a future feature needs it, `currentFrame` is available in the worklet and
 * threads through the same three `pushPcm` calls.
 */
export const TAP_BLOCK = 2048

/** Inline AudioWorklet processor: mono mixdown, `TAP_BLOCK`-sample blocks.
 * Registered from a Blob URL because Vite has no first-class worklet support. */
const TAP_PROCESSOR = `
const TAP_BLOCK = ${TAP_BLOCK}
class AudioVisTap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(TAP_BLOCK); this.n = 0 }
  process(inputs) {
    const ch = inputs[0]
    if (!ch || !ch[0]) return true
    const L = ch[0], R = ch[1]
    for (let i = 0; i < L.length; i++) {
      this.buf[this.n++] = R ? (L[i] + R[i]) * 0.5 : L[i]
      if (this.n === TAP_BLOCK) { this.port.postMessage(this.buf); this.buf = new Float32Array(TAP_BLOCK); this.n = 0 }
    }
    return true
  }
}
registerProcessor('audiovis-tap', AudioVisTap)
`

export interface EssentiaStatus {
  /** Worker constructed and not yet errored. */
  running: boolean
  /** Last rhythm read, for the debug/analytics panels. */
  lastBpm: number
  lastConfidence: number
  lastMethod: string
  lastMs: number
  lastAt: number
  /** Per-job analysis cost in ms, for the analytics panel's perf readout. */
  keyMs: number
  danceMs: number
  /** Number of key/danceability reads completed since attach. */
  keyRuns: number
  danceRuns: number
  error: string | null
}

class EssentiaBridge {
  readonly status: EssentiaStatus = {
    running: false,
    lastBpm: 0,
    lastConfidence: 0,
    lastMethod: '',
    lastMs: 0,
    lastAt: -1,
    keyMs: 0,
    danceMs: 0,
    keyRuns: 0,
    danceRuns: 0,
    error: null,
  }

  private worker: Worker | null = null
  private tap: AudioWorkletNode | null = null
  private ring: Float32Array | null = null
  private ringWrite = 0
  private ringFilled = 0
  private sampleRate = 48000
  private busy = false
  private jobId = 0
  /** id of the job currently in the worker; -1 while nothing is in flight or
   * after a detach. A response whose id doesn't match is stale — from a job
   * dispatched before the last source change — and is dropped so track 2 can't
   * inherit track 1's tempo/key read (issue 16, Bug B). */
  private inFlightId = -1
  private window: Float32Array | null = null
  /** All job-scheduling + result-merge state — pure logic in ./scheduling.ts. */
  private readonly sched = makeSchedState()

  /** Wire the PCM tap into a freshly built audio graph. Never throws — any
   * failure just leaves the built-in estimator in charge. */
  async attach(ctx: AudioContext, source: AudioNode): Promise<void> {
    this.detach()
    this.sampleRate = ctx.sampleRate
    this.ring = new Float32Array(Math.ceil(ctx.sampleRate * RING_SEC))
    this.ringWrite = 0
    this.ringFilled = 0
    try {
      const url = URL.createObjectURL(new Blob([TAP_PROCESSOR], { type: 'text/javascript' }))
      try {
        await ctx.audioWorklet.addModule(url)
      } finally {
        URL.revokeObjectURL(url)
      }
      const tap = new AudioWorkletNode(ctx, 'audiovis-tap', {
        numberOfInputs: 1,
        numberOfOutputs: 0,
      })
      // One worklet feeds both analysis bridges — the tap is the expensive
      // part of the graph, the ring copies are not.
      tap.port.onmessage = (e: MessageEvent<Float32Array>) => {
        this.pushPcm(e.data)
        voiceBridge.pushPcm(e.data, this.sampleRate)
        structureBridge.pushPcm(e.data, this.sampleRate)
      }
      source.connect(tap)
      this.tap = tap
      this.ensureWorker()
    } catch (err) {
      this.status.error = err instanceof Error ? err.message : String(err)
      this.status.running = false
    }
  }

  detach() {
    this.tap?.disconnect()
    if (this.tap) this.tap.port.onmessage = null
    this.tap = null
    this.ring = null
    this.ringFilled = 0
    this.ringWrite = 0
    this.busy = false
    this.inFlightId = -1 // any worker job still running is now stale
    resetSchedState(this.sched)
    this.status.lastAt = -1
    voiceBridge.reset()
    structureBridge.reset()
    // The worker (and its loaded WASM) survives detach on purpose — restarting
    // a source shouldn't re-pay the ~2.5 MB load.
  }

  /** PhraseDetector found a section boundary — key may have changed. */
  requestKey() {
    this.sched.keyRequested = true
  }

  /**
   * Per-frame drain + schedule. Called from AudioEngine.update(); must stay
   * allocation-free except when actually dispatching a job.
   *
   * The worker is single-threaded, so exactly one job is in flight at a time.
   * Rhythm wins any tie — it drives the beat grid, and the other two are slow
   * character reads that tolerate waiting a couple of seconds.
   */
  update(f: AudioFeatures, est: BpmEstimator) {
    const now = f.time
    this.drain(f, est, now)

    if (!this.worker || this.busy || !this.ring) return
    if (this.ringFilled < this.sampleRate * RHYTHM_MIN_SEC) return
    // Silence produces degenerate reads (measured: danceability ≈ 97 on
    // near-silence, against ~0.6–8 for real material), so don't spend the
    // worker on it — every field simply holds its last value.
    if (f.silence) return

    const job = pickJob(this.sched, now)
    if (!job) return
    applyDispatch(this.sched, job, now)

    this.busy = true
    const win = this.copyWindow(RHYTHM_WINDOW_SEC)
    this.jobId++
    this.inFlightId = this.jobId
    this.worker.postMessage({ id: this.jobId, type: job, pcm: win, sampleRate: this.sampleRate }, [
      win.buffer,
    ])
    this.window = null // transferred; next job reallocates
  }

  /** Move completed worker results onto the feature object / estimator. */
  private drain(f: AudioFeatures, est: BpmEstimator, now: number) {
    const out = drainResults(this.sched, est, now)
    if (out.modelTempo) {
      est.setModelTempo(out.modelTempo.bpm, out.modelTempo.conf, now, MODEL_FRESH_SEC)
    }
    if (out.key) {
      f.key = out.key.key
      f.scale = out.key.scale
      f.keyConfidence = out.key.keyConfidence
    }
    if (out.dance !== undefined) f.danceability = out.dance
  }

  private ensureWorker() {
    if (this.worker) {
      this.status.running = true
      return
    }
    try {
      const worker = new Worker(new URL('./essentia.worker.ts', import.meta.url), {
        type: 'module',
      })
      worker.onmessage = (e: MessageEvent<EssentiaResponse>) => {
        this.busy = false // the worker is free regardless
        const r = e.data
        // Drop any result (incl. an error) from a job dispatched before the last
        // source change — its id won't match the current in-flight one (Bug B).
        if (r.id !== this.inFlightId) return
        this.inFlightId = -1
        const patch = ingestResponse(this.sched, r, performance.now() / 1000)
        if (patch.error !== undefined) this.status.error = patch.error
        if (patch.lastBpm !== undefined) this.status.lastBpm = patch.lastBpm
        if (patch.lastConfidence !== undefined) this.status.lastConfidence = patch.lastConfidence
        if (patch.lastMethod !== undefined) this.status.lastMethod = patch.lastMethod
        if (patch.lastMs !== undefined) this.status.lastMs = patch.lastMs
        if (patch.lastAt !== undefined) this.status.lastAt = patch.lastAt
        if (patch.keyMs !== undefined) this.status.keyMs = patch.keyMs
        if (patch.incKeyRuns) this.status.keyRuns++
        if (patch.danceMs !== undefined) this.status.danceMs = patch.danceMs
        if (patch.incDanceRuns) this.status.danceRuns++
      }
      worker.onerror = (e) => {
        this.status.error = e.message || 'worker error'
        this.status.running = false
        this.busy = false
        worker.terminate()
        this.worker = null
      }
      this.worker = worker
      this.status.running = true
      this.status.error = null
    } catch (err) {
      this.status.error = err instanceof Error ? err.message : String(err)
      this.status.running = false
    }
  }

  private pushPcm(block: Float32Array) {
    const ring = this.ring
    if (!ring) return
    for (let i = 0; i < block.length; i++) {
      ring[this.ringWrite] = block[i]
      this.ringWrite = (this.ringWrite + 1) % ring.length
    }
    this.ringFilled = Math.min(ring.length, this.ringFilled + block.length)
  }

  /**
   * Copy the newest `sec` seconds out of the ring in chronological order.
   *
   * Two `set()` calls (memcpy) rather than a per-sample loop: this runs on the
   * MAIN thread every 2.5 s, and a 12 s window at 48 kHz is 576k samples — a
   * scalar loop with a modulo per sample is a measurable frame-time tail.
   */
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

export const essentiaBridge = new EssentiaBridge()
