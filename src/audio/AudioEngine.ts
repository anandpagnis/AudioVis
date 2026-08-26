import { BpmEstimator } from './BpmEstimator'
import { essentiaBridge } from './essentia/EssentiaBridge'
import { voiceBridge } from './essentia/VoiceBridge'
import { MoodEstimator } from './MoodEstimator'
import { PercussionDetector } from './PercussionDetector'
import { PhraseDetector } from './PhraseDetector'
import {
  BandNormalizer,
  PEAK_GUARD,
  ProgramLevel,
  REF_RATE,
  type SilenceConfig,
} from './bandNormalizer'
import { computeSpectralBands } from './spectralFeatures'
import { createEmptyFeatures, type AudioFeatures } from './types'

export type SourceKind = 'system' | 'mic' | 'file'

/**
 * Silence gate, as a share of the program's own recent level.
 *
 * Derived from the eight MTG-Jamendo reference tracks rather than guessed —
 * see the derivation in bandNormalizer.test.ts. The gap between the two is
 * hysteresis: `f.silence` hard-stops every automatic director, so a passage
 * hovering at the boundary must not chatter it.
 */
const SILENCE_CONFIG: SilenceConfig = { enterRatio: 0.004, exitRatio: 0.01 }

/** Sum of the `energyTarget` band weights below — keeps energy in 0..1. */
const ENERGY_WEIGHT_SUM = 0.5 + 0.3 + 0.2 + 0.3

const FFT_SIZE = 2048
const SPECTRUM_BINS = 512 // we keep the lower half — up to ~11 kHz at 44.1k

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
  /**
   * Second analyser fed through a band-pass, so scenes can trace the waveform
   * of the LEAD/SYNTH range rather than the full mix. The full-mix waveform is
   * dominated by kick and bass — tracing it draws the drums, not the melody.
   */
  private midAnalyser: AnalyserNode | null = null
  private midFilter: BiquadFilterNode | null = null
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
    rms: new BandNormalizer(),
    bass: new BandNormalizer(),
    mid: new BandNormalizer(),
    sub: new BandNormalizer(),
    presence: new BandNormalizer(),
    high: new BandNormalizer(),
    vocal: new BandNormalizer(),
    air: new BandNormalizer(),
    flux: new BandNormalizer(),
  }

  private energyLog: { t: number; e: number }[] = []
  private silenceSince = 0
  private programLevel = new ProgramLevel()
  /** Peak reference for `midWaveform` — see normalizeWave. */
  private waveRef = 0
  private dropUntil = -1

  readonly bpmEstimator = new BpmEstimator()
  readonly phraseDetector = new PhraseDetector()
  readonly moodEstimator = new MoodEstimator()
  readonly percussionDetector = new PercussionDetector()

  onEnded: (() => void) | null = null

  get running(): boolean {
    return this.analyser !== null
  }

  /**
   * The AudioContext's own state, or `'none'` when there is no graph.
   *
   * `running` only says a graph was built. A context can be built and
   * `suspended`, which reads as perfect silence with no error anywhere — and in
   * the two-window split that is the likely failure, because the output window
   * is opened programmatically and may never have received a user gesture. The
   * console needs to be able to tell "no source" from "source, but the browser
   * has not let it start yet", because those need different things from the
   * operator.
   */
  get contextState(): string {
    return this.ctx ? this.ctx.state : 'none'
  }

  /**
   * Resume a suspended context. Safe to call on every gesture.
   *
   * `connectStream` installs its own listener when it finds a suspended
   * context, but that only exists once a graph has been built. This covers the
   * window before that, and is called from the output window's own click
   * handler.
   */
  resumeContext(): void {
    if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {})
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

  /**
   * Acquire a capture WITHOUT connecting it.
   *
   * Public because the two-window split needs the acquisition and the analysis
   * to happen in different windows: `getDisplayMedia`/`getUserMedia` need
   * transient user activation and a freshly opened window has none, so the
   * control window prompts inside the user's click and hands the live stream to
   * the output window. See engine/outputLink.ts.
   *
   * The caller owns the stream until it is connected — if it is never handed
   * over, its tracks must be stopped or the capture stays live with nothing
   * able to release it.
   */
  acquireSource(kind: SourceKind, deviceId?: string): Promise<MediaStream> {
    return this.acquireStream(kind, deviceId)
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
    this.attachMidTap(ctx, source)
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
  async startWithStream(stream: MediaStream, isSystem = false) {
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
    this.connectStream(ctx, stream, isSystem)
  }

  /**
   * Build the band-passed analyser tap used for `features.midWaveform`.
   *
   * Centred at 1.1 kHz with a wide Q, which covers most lead-synth, vocal and
   * guitar fundamentals while rejecting kick/sub below and cymbal hiss above.
   * It is a filter, not source separation: a snare crack still shows up. But
   * the resulting wave is dominated by sustained tonal material, which is what
   * makes a ribbon traced along it read as "the synth line".
   */
  private attachMidTap(ctx: AudioContext, source: AudioNode) {
    const filter = ctx.createBiquadFilter()
    filter.type = 'bandpass'
    filter.frequency.value = 1100
    filter.Q.value = 0.7
    const analyser = ctx.createAnalyser()
    analyser.fftSize = FFT_SIZE
    analyser.smoothingTimeConstant = 0
    source.connect(filter)
    filter.connect(analyser)
    this.midFilter = filter
    this.midAnalyser = analyser
    // Both graph-building paths route through here, so this is also where the
    // Essentia PCM tap attaches. Fire-and-forget: it resolves after the
    // worklet module loads, never throws, and a failure just leaves the
    // built-in estimators in charge.
    void essentiaBridge.attach(ctx, source)
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
    this.attachMidTap(ctx, source)
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
    this.midAnalyser = null
    this.midFilter = null
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
    this.percussionDetector.reset()
    // Drops the PCM ring and any pending job so a second track can't inherit
    // the first one's tempo read. The worker (and its loaded WASM) persists.
    essentiaBridge.detach()
    for (const band of Object.values(this.bands)) band.reset()
    this.programLevel.reset()
    this.waveRef = 0
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
    // Band-passed time domain — the lead/synth wave scenes can trace.
    if (this.midAnalyser) {
      this.midAnalyser.getFloatTimeDomainData(f.midWaveform)
      this.normalizeWave(f.midWaveform, delta)
    }

    // --- Spectrum (dB → linear magnitude, normalized) ---
    const nyquist = ctx.sampleRate / 2
    const binHz = nyquist / this.freqDb.length
    for (let i = 0; i < SPECTRUM_BINS; i++) {
      const mag = Math.pow(10, this.freqDb[i] / 20)
      f.spectrum[i] = mag
    }

    // --- RMS + crest factor (peak/RMS — pushed/brickwalled vs. dynamic) ---
    let sq = 0
    let peakAbs = 0
    for (let i = 0; i < f.waveform.length; i++) {
      const s = f.waveform[i]
      sq += s * s
      const a = Math.abs(s)
      if (a > peakAbs) peakAbs = a
    }
    const rmsRaw = Math.sqrt(sq / f.waveform.length)
    const crestRaw = Math.min(20, peakAbs / (rmsRaw + 1e-6))

    // --- Bands + centroid + flux + texture cues (flatness/rolloff/air) ---
    const spectral = computeSpectralBands(this.freqDb, this.prevMag, binHz)

    // --- Silence, judged relative to the program's own level ---------------
    // Computed BEFORE normalization because the normalizer needs it: it holds
    // its loudness reference while silent rather than decaying onto the noise
    // floor. See bandNormalizer.ts.
    if (this.programLevel.update(rmsRaw, delta, SILENCE_CONFIG)) this.silenceSince = now
    f.silence = now - this.silenceSince > 0.6

    // --- Adaptive normalization + attack/release smoothing ---
    const norm = (b: BandNormalizer, raw: number) =>
      b.update(raw, delta, f.silence, this.tuning.attack, this.tuning.release)
    f.rms = norm(this.bands.rms, rmsRaw)
    f.bass = norm(this.bands.bass, spectral.bass)
    f.mid = norm(this.bands.mid, spectral.mid)
    f.sub = norm(this.bands.sub, spectral.sub)
    f.presence = norm(this.bands.presence, spectral.presence)
    f.high = norm(this.bands.high, spectral.high)
    f.vocal = norm(this.bands.vocal, spectral.vocal)
    f.air = norm(this.bands.air, spectral.air)
    f.flux = norm(this.bands.flux, spectral.bassFlux)
    f.transient += (Math.min(1, f.flux * 1.5) - f.transient) * Math.min(1, delta * 20)
    f.centroid += (Math.min(1, spectral.centroidRaw * 3) - f.centroid) * Math.min(1, delta * 8)
    f.spectralFlatness += (spectral.spectralFlatness - f.spectralFlatness) * Math.min(1, delta * 8)
    f.spectralRolloff += (spectral.spectralRolloff - f.spectralRolloff) * Math.min(1, delta * 8)
    // Slower smoothing: crest factor is a "character" cue, not a fast envelope.
    f.crestFactor += (crestRaw - f.crestFactor) * Math.min(1, delta * 4)
    // Weights are divided by their own sum rather than clipped with min(1).
    // Before the normalizer fix the bands were crushed so the sum rarely
    // reached 1 and the clip was inert; with the bands using their real range
    // it clipped constantly (measured p99 = 0.9999), and a saturated `energy`
    // silently breaks drop detection — `recent > before * 1.55` cannot be met
    // once both sides are pinned at the ceiling. Same relative weighting, full
    // 0..1 range, no clipping.
    const energyTarget =
      (f.bass * 0.5 + f.mid * 0.3 + f.high * 0.2 + f.rms * 0.3) / ENERGY_WEIGHT_SUM
    f.energy += (energyTarget - f.energy) * Math.min(1, delta * (energyTarget > f.energy ? 14 : 4))

    // --- Independent drum hits (kick / snare / hi-hat) ---
    // Separate from the broadband onset detector below: that one owns beat
    // TIMING, this one owns which part of the kit fired, so visual layers can
    // respond to the three independently.
    this.percussionDetector.update(f.percussion, spectral, now, delta, f.silence)

    // --- Onset detection (adaptive threshold over ~1 s of flux) ---
    this.fluxHistory.push(spectral.bassFlux)
    if (this.fluxHistory.length > 60) this.fluxHistory.shift()
    if (this.fluxHistory.length > 20 && !f.silence) {
      let mean = 0
      for (const v of this.fluxHistory) mean += v
      mean /= this.fluxHistory.length
      let variance = 0
      for (const v of this.fluxHistory) variance += (v - mean) * (v - mean)
      const std = Math.sqrt(variance / this.fluxHistory.length)
      const threshold = mean + 1.6 * std + 1e-6
      if (spectral.bassFlux > threshold && now - this.lastOnsetTime > 0.18) {
        this.lastOnsetTime = now
        const strength = Math.min(1, (spectral.bassFlux - mean) / (std * 4 + 1e-6))
        this.bpmEstimator.addOnset(now, strength)
      }
    }

    // --- Tempo / beat grid ---
    // Drain any completed worker read first (async, arrives whenever it's
    // ready) so this frame's grid already reflects it, then schedule the next
    // job. Both are cheap; the analysis itself happens off-thread.
    essentiaBridge.update(f, this.bpmEstimator)
    // Independent worker, independent cadence — see VoiceBridge's header.
    voiceBridge.update(f)
    this.bpmEstimator.update(now)
    this.advanceGrid(now, f)

    // --- Drop / build-up heuristics ---
    this.energyLog.push({ t: now, e: f.energy })
    while (this.energyLog.length > 0 && now - this.energyLog[0].t > 6) this.energyLog.shift()
    this.detectStructure(now, f)

    // --- Phrase / section tracking ---
    this.phraseDetector.update(now, f)
    // Key is stable within a section, so a boundary — not a timer — is the
    // natural moment to re-read it. Requested here, run on the worker's next
    // free slot (rhythm has priority).
    if (f.sectionChange) essentiaBridge.requestKey()

    // --- Mood: state, momentum, prediction (reads everything above) ---
    this.moodEstimator.update(f)
  }

  /**
   * Scale a time-domain buffer in place against its own slow peak reference.
   *
   * `midWaveform` is raw PCM off an AnalyserNode, so its amplitude is the
   * signal's actual level — the one feature that survived the normalizer fix
   * still fully volume-dependent. FlowRibbonScene traces it as an
   * oscilloscope line, so at low volume the trace flattened to nothing and at
   * high volume it clipped the ribbon.
   *
   * Deliberately shares BandNormalizer's reference shape rather than dividing
   * by this frame's own peak: per-frame normalization would hold the trace at
   * constant height and destroy the dynamics that make it read as playing.
   */
  private normalizeWave(buf: Float32Array, delta: number): void {
    let peak = 0
    for (let i = 0; i < buf.length; i++) {
      const a = Math.abs(buf[i])
      if (a > peak) peak = a
    }
    this.waveRef = Math.max(peak, this.waveRef * (1 - delta * REF_RATE))
    const ref = Math.max(this.waveRef, PEAK_GUARD)
    if (ref <= PEAK_GUARD) return
    const g = 1 / ref
    for (let i = 0; i < buf.length; i++) buf[i] = Math.max(-1, Math.min(1, buf[i] * g))
  }

  private advanceGrid(now: number, f: AudioFeatures) {
    const est = this.bpmEstimator
    f.bpm = est.bpm
    f.confidence = est.confidence
    f.beatGridAccuracy = est.hitScore
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
      //
      // Re-derived after the normalizer fix rather than re-tuned by taste: each
      // constant is set so the compound firing rate over the eight MTG-Jamendo
      // reference tracks matches what the ORIGINAL constants produced at unity
      // gain (0.412% of eligible frames). They end up close to the originals
      // (1.55/0.55/0.60) because the fix restores `bass` and `energy` to almost
      // exactly the distribution they always had - what changed drastically was
      // the bands from `mid` up, which the old absolute floor had crushed.
      //
      // The point is not the values, it is that the rate no longer depends on
      // playback volume. Measured drop rate at 0.25x / 1x / 4x input gain:
      //   before  0.000% / 0.412% / 0.348%   (no drops at all when quiet)
      //   after   0.412% / 0.412% / 0.412%
      if (recent > before * 1.573 && recent > 0.447 && f.bass > 0.507 && now > this.dropUntil + 4) {
        this.dropUntil = now + 0.6
      }
      // Build-up: sustained rise over the window.
      const span = now - oldest
      const first = this.energyLog[0]
      const slope = span > 3 ? (recent - first.e) / span : 0
      // Re-derived the same way. `slope` is the term that moved most (0.09 ->
      // 0.197) because it is an absolute rate of change in `energy`, so it
      // scales with the band range the fix restored: left at 0.09 it fired 43x
      // too often. Build rate at 0.25x / 1x / 4x gain:
      //   before  0.000% / 0.016% / 0.446%   (28x more builds when loud)
      //   after   0.018% / 0.018% / 0.018%
      f.buildUp = slope > 0.197 && recent > 0.295 && recent > before
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
