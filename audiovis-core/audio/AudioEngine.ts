import { BpmEstimator } from './BpmEstimator'
import { MoodEstimator } from './MoodEstimator'
import { PhraseDetector } from './PhraseDetector'
import { createEmptyFeatures, type AudioFeatures } from './types'

export type SourceKind = 'system' | 'mic' | 'file'

const FFT_SIZE = 2048
const SPECTRUM_BINS = 512 // we keep the lower half — up to ~11 kHz at 44.1k

interface BandNorm {
  peak: number
  value: number
}

function makeBand(): BandNorm {
  return { peak: 0.15, value: 0 }
}

/**
 * Capture requests must never hang. Chrome leaves getUserMedia() *pending
 * forever* when the permission is already denied (it does not reject with
 * NotAllowedError), and a share picker can be dismissed in ways that never
 * settle either. Without this the start flow sits on "Waiting for permission"
 * with every button disabled — unrecoverable short of a page reload.
 *
 * Generous by design: the user may legitimately spend a while choosing a tab.
 * This is the backstop, not the primary guard.
 */
const PICKER_TIMEOUT_MS = 60_000
const MIC_TIMEOUT_MS = 30_000

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

/**
 * Is microphone access already blocked? Checked up front so a denied
 * permission fails immediately with actionable guidance, instead of hanging
 * until the timeout above. Returns false when the Permissions API is
 * unavailable — the timeout still protects us.
 */
/**
 * Resume the context without ever stranding the caller. A resume blocked by the
 * autoplay policy can stay pending indefinitely, and `.catch()` cannot rescue a
 * promise that never settles — only a race can. Failing to resume is not fatal
 * (the graph still builds), so this resolves rather than throws.
 */
function resumeSafely(ctx: AudioContext): Promise<void> {
  return Promise.race([
    ctx.resume().catch(() => {}),
    new Promise<void>((resolve) => setTimeout(resolve, 3000)),
  ])
}

async function micPermissionBlocked(): Promise<boolean> {
  try {
    const status = await navigator.permissions.query({ name: 'microphone' as PermissionName })
    return status.state === 'denied'
  } catch {
    return false
  }
}

/**
 * Owns the Web Audio graph and turns raw audio into musical understanding.
 * `features` is a single mutable object updated once per render frame —
 * scenes read it inside useFrame and never touch this class otherwise.
 */
/** User-tunable response shaping. Persisted by the store, written directly here. */
export interface ResponseTuning {
  /** Multiplies band attack (rise) speed, 0.25..3. */
  attack: number
  /** Multiplies band release (fall) speed, 0.25..3. */
  release: number
  /** Beat pulses per grid beat: 0.5 = half-time, 1, 2, 4. */
  subdivision: number
}

class AudioEngine {
  readonly features: AudioFeatures = createEmptyFeatures()

  readonly tuning: ResponseTuning = { attack: 1, release: 1, subdivision: 1 }

  private ctx: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private stream: MediaStream | null = null
  private sourceNode: AudioNode | null = null
  private mediaEl: HTMLAudioElement | null = null
  private objectUrl: string | null = null
  private recDest: MediaStreamAudioDestinationNode | null = null

  /** Analyzed audio as a MediaStream — mixed into canvas recordings. */
  get recordingStream(): MediaStream | null {
    return this.recDest?.stream ?? null
  }

  /**
   * Invalidation token for in-flight start attempts.
   *
   * Neither getDisplayMedia nor getUserMedia accepts an AbortSignal, so a
   * pending permission/picker promise genuinely cannot be cancelled — it will
   * settle whenever the browser feels like it, possibly after the user has
   * already backed out or started a different source. Every start captures the
   * token; on settle it re-checks, and a stale token means "release whatever
   * was granted and commit nothing". Without this, a late arrival either
   * clobbers a newer session's engine state or leaves a live capture running
   * (browser "sharing" indicator on) that nothing holds a reference to.
   */
  private startToken = 0

  private freqDb = new Float32Array(FFT_SIZE / 2)
  private prevMag = new Float32Array(FFT_SIZE / 2)
  private fluxHistory: number[] = []
  private lastOnsetTime = -10
  private lastFrameTime = 0
  private lastGridIndex = -1
  private beatHoldUntil = -1

  private bands = {
    rms: makeBand(),
    bass: makeBand(),
    mid: makeBand(),
    sub: makeBand(),
    presence: makeBand(),
    high: makeBand(),
    vocal: makeBand(),
    flux: makeBand(),
  }

  private energyLog: { t: number; e: number }[] = []
  private silenceSince = 0
  private dropUntil = -1

  readonly bpmEstimator = new BpmEstimator()
  readonly phraseDetector = new PhraseDetector()
  readonly moodEstimator = new MoodEstimator()

  onEnded: (() => void) | null = null

  get running(): boolean {
    return this.analyser !== null
  }

  /**
   * Abandon any in-flight start attempt (see {@link startToken}). Safe to call
   * when nothing is starting. Callers that also want the graph torn down should
   * follow with {@link stop}.
   */
  cancelStart() {
    this.startToken++
  }

  /**
   * Begin capture. Resolves without connecting anything if the attempt was
   * cancelled or superseded while a permission prompt was open — check
   * {@link running} rather than assuming success on resolve.
   */
  async start(kind: SourceKind, deviceId?: string) {
    this.stop()
    const token = ++this.startToken

    // Create + resume the AudioContext NOW, inside the user's click. The
    // screen-share picker can take longer than the ~5 s of transient user
    // activation, and a context created after that may be blocked by the
    // autoplay policy — resume() then stays pending forever and the start
    // flow hangs on "Waiting for permission".
    const ctx = new AudioContext({ latencyHint: 'interactive' })
    await resumeSafely(ctx)
    if (token !== this.startToken) {
      void ctx.close().catch(() => {})
      return
    }

    let stream: MediaStream
    try {
      stream = await this.acquireStream(kind, deviceId)
    } catch (err) {
      void ctx.close().catch(() => {})
      // Cancelled while the prompt was open: the failure is no longer the
      // user's problem, so don't surface it on a card they've already left.
      if (token !== this.startToken) return
      throw err
    }

    if (token !== this.startToken) {
      // Permission landed after the user backed out. Release it explicitly —
      // otherwise the capture stays live with nothing able to stop it.
      stream.getTracks().forEach((t) => t.stop())
      void ctx.close().catch(() => {})
      return
    }

    this.connectStream(ctx, stream, kind === 'system')
  }

  private async acquireStream(kind: SourceKind, deviceId?: string): Promise<MediaStream> {
    let stream: MediaStream
    if (kind === 'system') {
      stream = await withTimeout(
        navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            // Keep the original playing through the user's speakers — we
            // analyze the copy, we don't play it.
            suppressLocalAudioPlayback: false,
          },
          // Chrome: offer "share system audio" and hide our own tab from the
          // picker so the visualizer can never capture itself.
          systemAudio: 'include',
          selfBrowserSurface: 'exclude',
        } as DisplayMediaStreamOptions),
        PICKER_TIMEOUT_MS,
        'The share picker never returned. Try again, and pick a source in the dialog.',
      )
      if (stream.getAudioTracks().length === 0) {
        stream.getTracks().forEach((t) => t.stop())
        const isMac = /Mac/i.test(navigator.userAgent)
        throw new Error(
          isMac
            ? 'No audio captured. On macOS, share a Chrome tab (not a screen/window) and tick "Share tab audio".'
            : 'No audio in the shared source. Re-share and enable "Share tab/system audio" in the picker.',
        )
      }
    } else {
      // Fail fast on an already-blocked mic: Chrome hangs getUserMedia forever
      // in that state rather than rejecting, which strands the start flow.
      if (await micPermissionBlocked()) {
        throw new Error(
          'Microphone access is blocked for this site. Click the lock/settings icon in the address bar, allow Microphone, then try again.',
        )
      }
      stream = await withTimeout(
        navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: deviceId ? { exact: deviceId } : undefined,
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        }),
        MIC_TIMEOUT_MS,
        'The microphone permission prompt never returned. Check the address-bar permission for this site and try again.',
      )
    }
    return stream
  }

  /**
   * Phase 7: play a local audio file as a first-class source — it plays
   * through the speakers AND feeds the full analysis pipeline.
   */
  async startWithFile(file: File) {
    this.stop()
    const token = ++this.startToken
    const ctx = new AudioContext({ latencyHint: 'interactive' })
    await resumeSafely(ctx)
    if (token !== this.startToken) {
      void ctx.close().catch(() => {})
      return
    }

    const url = URL.createObjectURL(file)
    const el = new Audio()
    el.src = url

    const source = ctx.createMediaElementSource(el)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = FFT_SIZE
    analyser.smoothingTimeConstant = 0
    source.connect(analyser)
    source.connect(ctx.destination) // the user hears the track
    const recDest = ctx.createMediaStreamDestination()
    source.connect(recDest)

    try {
      // Timed for the same reason as the capture calls: a play() that never
      // settles would strand the start flow with every button disabled.
      await withTimeout(
        el.play(),
        MIC_TIMEOUT_MS,
        'Playback did not start. Try the file again, or pick a different one.',
      )
    } catch (err) {
      void ctx.close().catch(() => {})
      URL.revokeObjectURL(url)
      if (token !== this.startToken) return
      throw err instanceof Error ? err : new Error('Could not play the audio file.')
    }

    if (token !== this.startToken) {
      // Backed out while decoding/starting playback — don't leave it audible.
      el.pause()
      void ctx.close().catch(() => {})
      URL.revokeObjectURL(url)
      return
    }

    el.addEventListener('ended', () => {
      if (this.mediaEl === el) {
        this.stop()
        this.onEnded?.()
      }
    })

    this.ctx = ctx
    this.analyser = analyser
    this.sourceNode = source
    this.mediaEl = el
    this.objectUrl = url
    this.recDest = recDest
    this.lastFrameTime = ctx.currentTime
    this.lastGridIndex = -1
    this.bpmEstimator.phase = ctx.currentTime
  }

  /**
   * Phase 7 extension point: feed ANY MediaStream into the analysis pipeline —
   * virtual audio cables (BlackHole/VB-Cable show up as regular input devices
   * on the mic path too), OBS audio, WebRTC/network streams, or a synth
   * driven by MIDI. No other part of the app changes.
   */
  async startWithStream(stream: MediaStream) {
    this.stop()
    if (stream.getAudioTracks().length === 0) {
      throw new Error('The provided MediaStream has no audio track.')
    }
    const token = ++this.startToken
    const ctx = new AudioContext({ latencyHint: 'interactive' })
    await resumeSafely(ctx)
    if (token !== this.startToken) {
      void ctx.close().catch(() => {})
      return
    }
    this.connectStream(ctx, stream, false)
  }

  private connectStream(ctx: AudioContext, stream: MediaStream, maybeMonitor: boolean) {
    // Safety net: if the context is still suspended (activation expired or
    // policy quirk), never block startup on it — the analyser just reads
    // silence until the next click/keypress resumes it.
    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => {})
      const kick = () => {
        void ctx.resume().catch(() => {})
        if (ctx.state === 'running' || this.ctx !== ctx) {
          window.removeEventListener('pointerdown', kick)
          window.removeEventListener('keydown', kick)
        }
      }
      window.addEventListener('pointerdown', kick)
      window.addEventListener('keydown', kick)
    }

    const source = ctx.createMediaStreamSource(stream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = FFT_SIZE
    analyser.smoothingTimeConstant = 0 // we do our own smoothing
    source.connect(analyser)
    // Recording tap: never routed to speakers, mixed into canvas captures.
    const recDest = ctx.createMediaStreamDestination()
    source.connect(recDest)
    this.recDest = recDest

    if (maybeMonitor) {
      // Feedback safety: only route audio back out when Chrome actually
      // muted the source locally — i.e. a *tab* share with local playback
      // suppressed. A screen/system-audio share keeps playing on its own,
      // and monitoring it would re-capture our own output in an
      // ever-louder echo loop.
      const settings = stream.getAudioTracks()[0]?.getSettings() as
        | (MediaTrackSettings & { displaySurface?: string; suppressLocalAudioPlayback?: boolean })
        | undefined
      const isTabShare = settings?.displaySurface === 'browser'
      const locallyMuted = settings?.suppressLocalAudioPlayback === true
      if (isTabShare && locallyMuted) {
        const monitor = ctx.createGain()
        monitor.gain.value = 1
        source.connect(monitor)
        monitor.connect(ctx.destination)
      }
    }

    // Only the AUDIO track ending should end the session. getDisplayMedia also
    // hands back a video track we never use (we analyze audio only); binding
    // teardown to *every* track meant that if the incidental video surface ended
    // on its own — Chrome ending the capture, the tab backgrounding, the user
    // clicking Chrome's "Stop sharing" bar — the whole session was torn down and
    // the start-card selector reappeared while the audio was still live.
    stream.getAudioTracks().forEach((track) => {
      track.addEventListener('ended', () => {
        if (this.stream === stream) {
          this.stop()
          this.onEnded?.()
        }
      })
    })

    this.ctx = ctx
    this.analyser = analyser
    this.stream = stream
    this.sourceNode = source
    this.lastFrameTime = ctx.currentTime
    this.lastGridIndex = -1
    this.bpmEstimator.phase = ctx.currentTime
  }

  stop() {
    // Also invalidates any in-flight start, so a permission granted after the
    // user stopped can never resurrect a session.
    this.startToken++
    this.stream?.getTracks().forEach((t) => t.stop())
    this.mediaEl?.pause()
    this.sourceNode?.disconnect()
    this.ctx?.close().catch(() => {})
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl)
    this.ctx = null
    this.analyser = null
    this.stream = null
    this.sourceNode = null
    this.mediaEl = null
    this.objectUrl = null
    this.recDest = null
    this.resetAnalysis()
  }

  private resetAnalysis() {
    Object.assign(this.features, createEmptyFeatures())
    this.prevMag.fill(0)
    this.fluxHistory = []
    this.energyLog = []
    this.lastOnsetTime = -10
    this.lastFrameTime = 0
    this.lastGridIndex = -1
    this.beatHoldUntil = -1
    this.silenceSince = 0
    this.dropUntil = -1
    this.bpmEstimator.reset()
    this.phraseDetector.reset()
    this.moodEstimator.reset()
    for (const band of Object.values(this.bands)) {
      band.peak = 0.15
      band.value = 0
    }
  }

  /** Call once per render frame, before scenes read `features`. */
  update() {
    const f = this.features
    const ctx = this.ctx
    const analyser = this.analyser
    if (!ctx || !analyser) {
      // Keep time flowing so idle motion continues before audio starts.
      const now = performance.now() / 1000
      f.delta = Math.min(0.1, now - (f.time || now))
      f.time = now
      this.advanceGrid(now, f)
      this.moodEstimator.update(f)
      return
    }

    const now = ctx.currentTime
    const delta = Math.min(0.1, Math.max(0.001, now - this.lastFrameTime))
    this.lastFrameTime = now
    f.time = now
    f.delta = delta

    analyser.getFloatTimeDomainData(f.waveform)
    analyser.getFloatFrequencyData(this.freqDb)

    // --- Spectrum (dB → linear magnitude, normalized) ---
    const nyquist = ctx.sampleRate / 2
    const binHz = nyquist / this.freqDb.length
    for (let i = 0; i < SPECTRUM_BINS; i++) {
      const mag = Math.pow(10, this.freqDb[i] / 20)
      f.spectrum[i] = mag
    }

    // --- RMS ---
    let sq = 0
    for (let i = 0; i < f.waveform.length; i++) sq += f.waveform[i] * f.waveform[i]
    const rmsRaw = Math.sqrt(sq / f.waveform.length)

    // --- Bands + centroid + flux ---
    const bassEnd = Math.min(this.freqDb.length, Math.ceil(160 / binHz))
    const midEnd = Math.min(this.freqDb.length, Math.ceil(2000 / binHz))
    const presenceEnd = Math.min(this.freqDb.length, Math.ceil(5000 / binHz))
    const highEnd = Math.min(this.freqDb.length, Math.ceil(9000 / binHz))
    const subEnd = Math.min(this.freqDb.length, Math.ceil(80 / binHz))
    let bass = 0
    let mid = 0
    let sub = 0
    let presence = 0
    let high = 0
    let vocal = 0
    let centW = 0
    let centWF = 0
    let bassFlux = 0
    for (let i = 1; i < highEnd; i++) {
      const mag = Math.pow(10, this.freqDb[i] / 20)
      if (i < bassEnd) bass += mag
      else if (i < midEnd) mid += mag
      else high += mag
      if (i < subEnd) sub += mag
      if (i >= Math.ceil(250 / binHz) && i < presenceEnd) vocal += mag
      if (i >= midEnd && i < presenceEnd) presence += mag
      centW += mag
      centWF += mag * i
      // Half-wave-rectified spectral flux, bass-weighted: only rises count (a
      // note starting, not one decaying), and low bins count 2.5x because the
      // kick is what the beat tracker locks onto. `f.flux` is derived from this,
      // so there is deliberately no full-spectrum accumulator — an unweighted
      // one used to be computed here and thrown away.
      const diff = mag - this.prevMag[i]
      if (diff > 0 && i < midEnd) bassFlux += diff * (i < bassEnd ? 2.5 : 1)
      this.prevMag[i] = mag
    }
    bass /= Math.max(1, bassEnd - 1)
    mid /= Math.max(1, midEnd - bassEnd)
    sub /= Math.max(1, subEnd - 1)
    presence /= Math.max(1, presenceEnd - midEnd)
    high /= Math.max(1, highEnd - midEnd)
    vocal /= Math.max(1, presenceEnd - Math.ceil(250 / binHz))
    const centroidRaw = centW > 1e-6 ? centWF / centW / highEnd : 0

    // --- Adaptive normalization + attack/release smoothing ---
    f.rms = this.norm(this.bands.rms, rmsRaw, delta)
    f.bass = this.norm(this.bands.bass, bass, delta)
    f.mid = this.norm(this.bands.mid, mid, delta)
    f.sub = this.norm(this.bands.sub, sub, delta)
    f.presence = this.norm(this.bands.presence, presence, delta)
    f.high = this.norm(this.bands.high, high, delta)
    f.vocal = this.norm(this.bands.vocal, vocal, delta)
    f.flux = this.norm(this.bands.flux, bassFlux, delta)
    f.transient += (Math.min(1, f.flux * 1.5) - f.transient) * Math.min(1, delta * 20)
    f.centroid += (Math.min(1, centroidRaw * 3) - f.centroid) * Math.min(1, delta * 8)
    const energyTarget = Math.min(1, f.bass * 0.5 + f.mid * 0.3 + f.high * 0.2 + f.rms * 0.3)
    f.energy += (energyTarget - f.energy) * Math.min(1, delta * (energyTarget > f.energy ? 14 : 4))

    // --- Silence ---
    if (rmsRaw > 0.008) this.silenceSince = now
    f.silence = now - this.silenceSince > 0.6

    // --- Onset detection (adaptive threshold over ~1 s of flux) ---
    this.fluxHistory.push(bassFlux)
    if (this.fluxHistory.length > 60) this.fluxHistory.shift()
    if (this.fluxHistory.length > 20 && !f.silence) {
      let mean = 0
      for (const v of this.fluxHistory) mean += v
      mean /= this.fluxHistory.length
      let variance = 0
      for (const v of this.fluxHistory) variance += (v - mean) * (v - mean)
      const std = Math.sqrt(variance / this.fluxHistory.length)
      const threshold = mean + 1.6 * std + 1e-6
      if (bassFlux > threshold && now - this.lastOnsetTime > 0.18) {
        this.lastOnsetTime = now
        const strength = Math.min(1, (bassFlux - mean) / (std * 4 + 1e-6))
        this.bpmEstimator.addOnset(now, strength)
      }
    }

    // --- Tempo / beat grid ---
    this.bpmEstimator.update(now)
    this.advanceGrid(now, f)

    // --- Drop / build-up heuristics ---
    this.energyLog.push({ t: now, e: f.energy })
    while (this.energyLog.length > 0 && now - this.energyLog[0].t > 6) this.energyLog.shift()
    this.detectStructure(now, f)

    // --- Phrase / section tracking ---
    this.phraseDetector.update(now, f)

    // --- Mood: state, momentum, prediction (reads everything above) ---
    this.moodEstimator.update(f)
  }

  private norm(band: BandNorm, raw: number, delta: number): number {
    band.peak = Math.max(raw, band.peak * (1 - delta * 0.04), 0.02)
    const target = Math.min(1, raw / band.peak)
    const rate = target > band.value ? 22 * this.tuning.attack : 5 * this.tuning.release
    band.value += (target - band.value) * Math.min(1, delta * rate)
    return band.value
  }

  private advanceGrid(now: number, f: AudioFeatures) {
    const est = this.bpmEstimator
    f.bpm = est.bpm
    f.confidence = est.confidence
    const idx = Math.floor((now - est.phase) / est.period)
    f.beatProgress = (now - est.phase) / est.period - idx
    f.nextBeatTime = est.phase + (idx + 1) * est.period
    f.beat = false
    if (idx !== this.lastGridIndex) {
      if (this.lastGridIndex !== -1 && idx > this.lastGridIndex) {
        f.beat = true
        // Advance by the number of beats the grid actually crossed since the last
        // frame, so a frame hitch or a backgrounded tab doesn't silently
        // under-count (which drifts beat-anchored cue/phrase timing off the
        // music). Cap the catch-up so a tempo re-lock that jumps the grid index
        // can't inject a burst of phantom beats.
        f.beatIndex += Math.min(idx - this.lastGridIndex, 4)
        f.beatInBar = f.beatIndex % 4
        f.bar = Math.floor(f.beatIndex / 4)
        f.measure = Math.floor(f.beatIndex / 16)
        f.beatStrength = Math.min(1, 0.25 + f.bass * 0.9) * (0.35 + 0.65 * f.confidence)
        this.beatHoldUntil = now + 0.05
      }
      this.lastGridIndex = idx
    }
  }

  private detectStructure(now: number, f: AudioFeatures) {
    let recent = 0
    let recentN = 0
    let before = 0
    let beforeN = 0
    let oldest = now
    for (const s of this.energyLog) {
      if (s.t < oldest) oldest = s.t
      if (now - s.t < 0.35) {
        recent += s.e
        recentN++
      } else if (now - s.t < 2.2) {
        before += s.e
        beforeN++
      }
    }
    if (recentN > 3 && beforeN > 10) {
      recent /= recentN
      before /= beforeN
      // Drop: sudden jump well above the recent baseline with heavy bass.
      if (recent > before * 1.55 && recent > 0.55 && f.bass > 0.6 && now > this.dropUntil + 4) {
        this.dropUntil = now + 0.6
      }
      // Build-up: sustained rise over the window.
      const span = now - oldest
      const first = this.energyLog[0]
      const slope = span > 3 ? (recent - first.e) / span : 0
      f.buildUp = slope > 0.09 && recent > 0.35 && recent > before
    }
    f.drop = now < this.dropUntil
  }
}

export const audioEngine = new AudioEngine()

/**
 * Convenience for scenes: a punchy 1→0 envelope inside each beat, weighted by
 * confidence. Honors the user's subdivision tuning: 0.5 stretches the pulse
 * across two beats (half-time feel), 2/4 add softer ticks between grid beats.
 */
export function beatPulse(f: AudioFeatures, sharpness = 3): number {
  const sub = audioEngine.tuning.subdivision
  let progress = f.beatProgress
  let strength = f.beatStrength
  if (sub >= 2) {
    const scaled = f.beatProgress * sub
    const tick = Math.floor(scaled)
    progress = scaled - tick
    if (tick !== 0) strength *= 0.55 // between-beat ticks stay softer
  } else if (sub < 1) {
    progress = ((f.beatIndex % 2) + f.beatProgress) / 2
  }
  const p = Math.pow(1 - progress, sharpness)
  return p * strength * (0.25 + 0.75 * f.confidence)
}
