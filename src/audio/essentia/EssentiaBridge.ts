import type { BpmEstimator } from '../BpmEstimator'
import type { AudioFeatures } from '../types'
import { voiceBridge } from './VoiceBridge'
import type {
  DanceabilityResult,
  EssentiaJobType,
  EssentiaResponse,
  KeyResult,
  RhythmResult,
} from './protocol'

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
 */
const RHYTHM_MIN_SEC = RHYTHM_WINDOW_SEC
const RHYTHM_CADENCE_SEC = 2.5
/** How long a worker read stays authoritative before onset tracking resumes. */
const MODEL_FRESH_SEC = 8

/**
 * Key is stable within a section, so it is normally triggered by
 * PhraseDetector's section boundary rather than a timer. This is the fallback
 * for material that never fires one, and the floor between section-triggered
 * runs so a burst of boundaries can't spam the worker.
 */
const KEY_FALLBACK_SEC = 20
const KEY_MIN_GAP_SEC = 6
/**
 * Danceability is a slow character read (DFA over segment lengths up to 8.8 s),
 * so it only needs refreshing every few sections' worth of time.
 */
const DANCE_CADENCE_SEC = 8

/** Inline AudioWorklet processor: mono mixdown, 4096-sample blocks (~12 msg/s).
 * Registered from a Blob URL because Vite has no first-class worklet support. */
const TAP_PROCESSOR = `
class AudioVisTap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(4096); this.n = 0 }
  process(inputs) {
    const ch = inputs[0]
    if (!ch || !ch[0]) return true
    const L = ch[0], R = ch[1]
    for (let i = 0; i < L.length; i++) {
      this.buf[this.n++] = R ? (L[i] + R[i]) * 0.5 : L[i]
      if (this.n === 4096) { this.port.postMessage(this.buf); this.buf = new Float32Array(4096); this.n = 0 }
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
  private lastJobAt = -1
  private cadence = RHYTHM_CADENCE_SEC
  private jobId = 0
  private pending: RhythmResult | null = null
  private pendingKey: KeyResult | null = null
  private pendingDance: DanceabilityResult | null = null
  private window: Float32Array | null = null
  private lastKeyAt = -1
  private lastDanceAt = -1
  /** Set by AudioEngine when PhraseDetector reports a boundary; the next
   * eligible slot runs a key job. Key is stable within a section, so this is
   * the natural trigger and it costs nothing on material that never fires. */
  private keyRequested = false

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
    this.lastJobAt = -1
    this.cadence = RHYTHM_CADENCE_SEC
    this.pending = null
    this.pendingKey = null
    this.pendingDance = null
    this.lastKeyAt = -1
    this.lastDanceAt = -1
    this.keyRequested = false
    this.status.lastAt = -1
    voiceBridge.reset()
    // The worker (and its loaded WASM) survives detach on purpose — restarting
    // a source shouldn't re-pay the ~2.5 MB load.
  }

  /** PhraseDetector found a section boundary — key may have changed. */
  requestKey() {
    this.keyRequested = true
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

    const job = this.pickJob(now)
    if (!job) return
    if (job === 'rhythm') this.lastJobAt = now
    else if (job === 'key') {
      this.lastKeyAt = now
      this.keyRequested = false
    } else this.lastDanceAt = now

    this.busy = true
    const win = this.copyWindow(RHYTHM_WINDOW_SEC)
    this.jobId++
    this.worker.postMessage(
      { id: this.jobId, type: job, pcm: win, sampleRate: this.sampleRate },
      [win.buffer],
    )
    this.window = null // transferred; next job reallocates
  }

  /** Which job is due, rhythm first. Null when nothing is. */
  private pickJob(now: number): EssentiaJobType | null {
    if (this.lastJobAt < 0 || now - this.lastJobAt >= this.cadence) return 'rhythm'
    const keyDue =
      this.lastKeyAt < 0 ||
      (this.keyRequested && now - this.lastKeyAt >= KEY_MIN_GAP_SEC) ||
      now - this.lastKeyAt >= KEY_FALLBACK_SEC
    if (keyDue) return 'key'
    if (this.lastDanceAt < 0 || now - this.lastDanceAt >= DANCE_CADENCE_SEC) return 'danceability'
    return null
  }

  /** Move completed worker results onto the feature object / estimator. */
  private drain(f: AudioFeatures, est: BpmEstimator, now: number) {
    if (this.pending) {
      const r = this.pending
      this.pending = null
      if (r.bpm >= 40 && r.bpm <= 240 && Number.isFinite(r.bpm)) {
        est.setModelTempo(r.bpm, r.confidence01, now, MODEL_FRESH_SEC)
      }
    }
    if (this.pendingKey) {
      const r = this.pendingKey
      this.pendingKey = null
      f.key = r.key
      f.scale = r.scale === 'major' || r.scale === 'minor' ? r.scale : ''
      f.keyConfidence = Number.isFinite(r.strength) ? Math.max(0, Math.min(1, r.strength)) : 0
    }
    if (this.pendingDance) {
      const r = this.pendingDance
      this.pendingDance = null
      if (Number.isFinite(r.danceability)) f.danceability = r.danceability
    }
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
        this.busy = false
        const r = e.data
        if (r.type === 'error') {
          this.status.error = `${r.job}: ${r.message}`
          return
        }
        if (r.type === 'key') {
          this.pendingKey = r
          this.status.keyMs = r.ms
          this.status.keyRuns++
          return
        }
        if (r.type === 'danceability') {
          this.pendingDance = r
          this.status.danceMs = r.ms
          this.status.danceRuns++
          return
        }
        this.pending = r
        this.status.lastBpm = r.bpm
        this.status.lastConfidence = r.confidence01
        this.status.lastMethod = r.method
        this.status.lastMs = r.ms
        this.status.lastAt = performance.now() / 1000
        // Self-throttle: never spend more than ~half the wall clock analyzing.
        this.cadence = Math.max(RHYTHM_CADENCE_SEC, (r.ms / 1000) * 2)
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
