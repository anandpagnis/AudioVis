import type { AudioFeatures } from '../types'
import type { MoodScores, VoiceResponse, VoiceResult } from './voiceProtocol'

/**
 * Main-thread side of the voice/mood classifier.
 *
 * Shares the shape of EssentiaBridge — slow cadence, transferred PCM windows,
 * results drained on the next frame — but owns its own worker so a ~450 ms
 * classification can never delay the beat grid.
 *
 * Fails silent: no worker, no models on disk, or an unsupported WASM backend
 * all leave `vocalPresence`/`moods` at their defaults and stop the retries.
 */

/** Classification is a section-scale read, not a per-beat one. */
const CADENCE_SEC = 12
/** Give the rhythm worker a clear run at startup before adding model load. */
const FIRST_JOB_DELAY_SEC = 6
const WINDOW_SEC = 12

/**
 * How many recent ~3 s patch probabilities back `vocalPresence`.
 *
 * One 12 s window yields only 4 patches, so a fraction computed from a single
 * request can only ever be 0, .25, .5, .75 or 1 — too coarse to read as a
 * continuous signal. Pooling the last 16 (~48 s, roughly a section) gives
 * 1/16 resolution while still tracking a vocal entering or leaving.
 */
const PATCH_HISTORY = 16
/** Matches VOICE_THRESHOLD in the worker; see its comment for the evidence. */
const VOICE_THRESHOLD = 0.5

export interface VoiceStatus {
  running: boolean
  /** Models absent (never fetched) — distinct from a genuine failure. */
  missing: boolean
  loaded: boolean
  lastMelMs: number
  lastInferMs: number
  runs: number
  error: string | null
}

class VoiceBridge {
  readonly status: VoiceStatus = {
    running: false,
    missing: false,
    loaded: false,
    lastMelMs: 0,
    lastInferMs: 0,
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
  private jobId = 0
  private pending: VoiceResult | null = null
  private window: Float32Array | null = null
  /** Rolling per-patch p(voice); see PATCH_HISTORY. */
  private probs: number[] = []
  private disabled = false

  /** Called by EssentiaBridge's tap — one AudioWorklet feeds both bridges. */
  pushPcm(block: Float32Array, sampleRate: number) {
    if (this.disabled) return
    if (!this.ring || this.sampleRate !== sampleRate) {
      this.sampleRate = sampleRate
      this.ring = new Float32Array(Math.ceil(sampleRate * (WINDOW_SEC + 2)))
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
    this.pending = null
    this.probs = []
    // The worker (with TF.js and ~3.4 MB of weights) survives on purpose —
    // restarting a source shouldn't re-pay that load.
  }

  /** Per-frame drain + schedule. Allocation-free unless dispatching. */
  update(f: AudioFeatures) {
    if (this.disabled) return
    if (this.pending) {
      const r = this.pending
      this.pending = null
      this.probs.push(...r.patchProbs)
      if (this.probs.length > PATCH_HISTORY) {
        this.probs.splice(0, this.probs.length - PATCH_HISTORY)
      }
      const over = this.probs.filter((p) => p > VOICE_THRESHOLD).length
      f.vocalPresence = this.probs.length > 0 ? over / this.probs.length : 0
      f.moods.happy = r.moods.happy
      f.moods.aggressive = r.moods.aggressive
      f.moods.party = r.moods.party
      f.moods.relaxed = r.moods.relaxed
      // Only now can a consumer distinguish "ambient" from "no models".
      f.moodsValid = true
    }

    if (!this.ring || f.silence) return
    if (this.ringFilled < this.sampleRate * WINDOW_SEC) return
    const now = f.time
    if (this.startedAt < 0) this.startedAt = now
    // Don't compete with the rhythm worker's first reads or the model load.
    if (now - this.startedAt < FIRST_JOB_DELAY_SEC) return
    if (this.busy) return
    if (this.lastJobAt >= 0 && now - this.lastJobAt < CADENCE_SEC) return
    if (!this.ensureWorker()) return

    this.lastJobAt = now
    this.busy = true
    const win = this.copyWindow(WINDOW_SEC)
    this.jobId++
    this.worker!.postMessage({ id: this.jobId, pcm: win, sampleRate: this.sampleRate }, [win.buffer])
    this.window = null
  }

  private ensureWorker(): boolean {
    if (this.worker) return true
    if (this.disabled) return false
    try {
      const worker = new Worker(new URL('./voice.worker.ts', import.meta.url), { type: 'module' })
      worker.onmessage = (e: MessageEvent<VoiceResponse>) => {
        this.busy = false
        const r = e.data
        if (r.type === 'error') {
          this.status.error = r.message
          this.status.missing = r.missing
          // Absent weights are a permanent condition until someone fetches
          // them; retrying every cadence would just spam 404s.
          if (r.missing) this.disable()
          return
        }
        this.pending = r
        this.status.loaded = true
        this.status.lastMelMs = r.melMs
        this.status.lastInferMs = r.inferMs
        this.status.runs++
        this.status.error = null
      }
      worker.onerror = (e) => {
        this.status.error = e.message || 'voice worker error'
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

  /**
   * Newest `sec` seconds out of the ring, chronological.
   *
   * Two `set()` calls (memcpy) rather than a per-sample loop: this runs on the
   * MAIN thread inside the audio update, and a 12 s window at 48 kHz is 576k
   * samples — a scalar loop with a modulo per sample is a measurable frame-time
   * tail there, which is exactly what the worker split exists to avoid.
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

export const voiceBridge = new VoiceBridge()
export type { MoodScores }
