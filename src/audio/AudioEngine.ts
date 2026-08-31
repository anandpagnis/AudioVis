import { BpmEstimator } from './BpmEstimator'
import { essentiaBridge } from './essentia/EssentiaBridge'
import { structureBridge } from './essentia/StructureBridge'
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
import { computeLowBands, computeSpectralBands, writeLinearSpectrum } from './spectralFeatures'
import { meanSquareToLufs } from './loudness'
import { SectionTracker } from './SectionTracker'
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

/** Age-based length of the onset-flux ring — see {@link AudioEngine.fluxHistory}. */
const FLUX_WINDOW_SEC = 1.0

const FFT_SIZE = 2048

/**
 * Dedicated low-frequency analyser. At ~5.4 Hz/bin (44.1k) it resolves the
 * sub-bass region the 2048 main analyser cannot — there, 20–80 Hz is barely
 * three bins and everything below ~23 Hz is bin 1 alone. Its ~186 ms window is
 * fine for `f.sub` (a slow envelope nothing samples per-beat); `f.bass` stays
 * on the 2048 grid because it carries kick fundamentals that this window smears
 * and that `beatStrength` / scene pulses read at the beat.
 */
const LOW_FFT_SIZE = 8192

/**
 * Inline AudioWorklet: ITU-R BS.1770-4 K-weighting → sliding mean-squares.
 *
 * A dedicated worklet rather than an AnalyserNode because the two K-weighting
 * biquads are IIR and need the unbroken sample stream (an AnalyserNode only
 * exposes gapped 1024-sample snapshots). Mixes to mono, runs the pre-filter
 * (high-shelf) then the RLB high-pass, and keeps mean-squares of the weighted
 * signal over the last 400 ms (momentary) and 3 s (short-term). Posts
 * `{ msMomentary, msShort }` at ~60 Hz — NOT per 128-sample block.
 *
 * The coefficient formulas + biquad + denormal flush + NaN guard are the same
 * as `src/audio/loudness.ts` (a worklet Blob can't import) — keep them in sync;
 * `loudness.test.ts` pins that copy against the BS.1770 spec.
 *
 * Distinct processor name ('audiovis-loudness') so it never collides with
 * EssentiaBridge's 'audiovis-tap'.
 */
const LOUDNESS_PROCESSOR = `
class AudioVisLoudness extends AudioWorkletProcessor {
  constructor() {
    super()
    const fs = sampleRate
    { // stage 1 — pre-filter (high-shelf)
      const f0 = 1681.9744509555319, G = 3.99984385397, Q = 0.7071752369554196
      const K = Math.tan(Math.PI * f0 / fs)
      const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416)
      const a0 = 1 + K / Q + K * K
      this.b0a = (Vh + Vb * K / Q + K * K) / a0
      this.b1a = 2 * (K * K - Vh) / a0
      this.b2a = (Vh - Vb * K / Q + K * K) / a0
      this.a1a = 2 * (K * K - 1) / a0
      this.a2a = (1 - K / Q + K * K) / a0
    }
    { // stage 2 — RLB high-pass
      const f0 = 38.13547087602444, Q = 0.5003270373238773
      const K = Math.tan(Math.PI * f0 / fs)
      const a0 = 1 + K / Q + K * K
      this.a1b = 2 * (K * K - 1) / a0
      this.a2b = (1 - K / Q + K * K) / a0
    }
    this.x1a = this.x2a = this.y1a = this.y2a = 0
    this.x1b = this.x2b = this.y1b = this.y2b = 0

    // Ring of per-block (sumSquares, sampleCount) — evict by sample-count age.
    this.winShort = Math.round(fs * 3)
    this.winMom = Math.round(fs * 0.4)
    this.slots = Math.ceil(this.winShort / 128) + 2
    this.ringSS = new Float64Array(this.slots)
    this.ringN = new Float32Array(this.slots)
    this.rd = 0; this.wr = 0; this.count = 0
    this.sumSS = 0; this.sumN = 0

    this.postEvery = Math.max(1, Math.round((fs / 128) / 60))
    this.postCtr = 0; this.resumCtr = 0
  }

  process(inputs) {
    const ch = inputs[0]
    if (!ch || !ch.length || !ch[0]) return true
    const L = ch[0], R = ch[1], n = L.length
    if (n === 0) return true

    let ss = 0
    for (let i = 0; i < n; i++) {
      let x = R ? (L[i] + R[i]) * 0.5 : L[i]
      if (!(x === x) || x === Infinity || x === -Infinity) {
        this.x1a = this.x2a = this.y1a = this.y2a = 0
        this.x1b = this.x2b = this.y1b = this.y2b = 0
        x = 0
      }
      let ya = this.b0a * x + this.b1a * this.x1a + this.b2a * this.x2a
             - this.a1a * this.y1a - this.a2a * this.y2a
      if (ya < 1e-15 && ya > -1e-15) ya = 0
      this.x2a = this.x1a; this.x1a = x; this.y2a = this.y1a; this.y1a = ya
      let yb = ya - 2 * this.x1b + this.x2b - this.a1b * this.y1b - this.a2b * this.y2b
      if (yb < 1e-15 && yb > -1e-15) yb = 0
      this.x2b = this.x1b; this.x1b = ya; this.y2b = this.y1b; this.y1b = yb
      ss += yb * yb
    }

    this.ringSS[this.wr] = ss
    this.ringN[this.wr] = n
    this.wr = (this.wr + 1) % this.slots
    this.sumSS += ss; this.sumN += n; this.count++
    while (this.count > 1 && this.sumN - this.ringN[this.rd] >= this.winShort) {
      this.sumSS -= this.ringSS[this.rd]
      this.sumN -= this.ringN[this.rd]
      this.rd = (this.rd + 1) % this.slots
      this.count--
    }

    if (++this.postCtr >= this.postEvery) {
      this.postCtr = 0
      if (++this.resumCtr >= 16) { // kill running-sum float drift ~4x/s
        this.resumCtr = 0
        let s = 0, m = 0
        for (let k = 0, idx = this.rd; k < this.count; k++, idx = (idx + 1) % this.slots) {
          s += this.ringSS[idx]; m += this.ringN[idx]
        }
        this.sumSS = s; this.sumN = m
      }
      // momentary: sum the newest blocks back to ~400 ms
      let mSS = 0, mN = 0
      for (let k = 1, idx = (this.wr - 1 + this.slots) % this.slots; k <= this.count && mN < this.winMom; k++, idx = (idx - 1 + this.slots) % this.slots) {
        mSS += this.ringSS[idx]; mN += this.ringN[idx]
      }
      this.port.postMessage({
        msMomentary: mN > 0 ? mSS / mN : 0,
        msShort: this.sumN > 0 ? this.sumSS / this.sumN : 0,
      })
    }
    return true
  }
}
registerProcessor('audiovis-loudness', AudioVisLoudness)
`

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
  /**
   * Third analyser, fftSize {@link LOW_FFT_SIZE}, smoothing 0, fed from the same
   * source as the main analyser and the mid tap. `update()` sources `f.sub`
   * from `computeLowBands()` off this when present; `computeSpectralBands`'s own
   * sub (2048) is the fallback for a future graph path that skips the tap.
   */
  private lowAnalyser: AnalyserNode | null = null
  /**
   * ITU-R BS.1770 K-weighting loudness tap (issue 12). A dedicated
   * AudioWorkletNode — the K-weighting biquads are IIR and need the contiguous
   * stream. Posts `{ msMomentary, msShort }` (K-weighted mean-squares, linear)
   * at ~60 Hz; `update()` turns them into `f.lufsShortTerm` (raw dBFS-ish) and
   * `f.loudness` (BandNormalizer → loudness-invariant 0..1). Null until the
   * module loads; a load failure leaves both at their idle defaults.
   */
  private loudnessNode: AudioWorkletNode | null = null
  private lastLoudMsMom = 0
  private lastLoudMsShort = 0
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
  private lowFreqDb = new Float32Array(LOW_FFT_SIZE / 2)
  /**
   * Broadband-onset flux ring: one entry per non-duplicate frame, evicted by
   * AGE (`now - t > FLUX_WINDOW_SEC`), not by count. A fixed 60-sample count was
   * ~1 s at 60 fps but 2 s at 30 fps and 0.4 s at 144 fps, so the adaptive
   * threshold's mean/σ — and onset sensitivity — drifted with the display.
   */
  private fluxHistory: { t: number; v: number }[] = []
  private lastOnsetTime = -10
  private lastFrameTime = 0
  private lastGridIndex = -1
  private beatHoldUntil = -1
  /**
   * Last frame's time-domain samples at three probe indices. When all three are
   * unchanged the `AnalyserNode` has not advanced (render loop outrunning the
   * audio callback — real above a few hundred fps, and whenever a tab is
   * throttled), so re-running onset/percussion detection would only feed
   * `flux ≈ 0` samples into the adaptive threshold and dilute it. `NaN` until
   * the first frame and after every reset.
   */
  private waveProbe0 = NaN
  private waveProbeMid = NaN
  private waveProbeLast = NaN

  private bands = {
    rms: new BandNormalizer(),
    bass: new BandNormalizer(),
    mid: new BandNormalizer(),
    sub: new BandNormalizer(),
    presence: new BandNormalizer(),
    high: new BandNormalizer(),
    vocal: new BandNormalizer(),
    air: new BandNormalizer(),
    sparkle: new BandNormalizer(),
    loudness: new BandNormalizer(),
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
  readonly sectionTracker = new SectionTracker()

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

    // High-resolution low-frequency tap: same source, no band-pass (only the
    // bottom ~160 Hz is ever read). Its own analyser rather than reusing the
    // mid tap's — different fftSize, and the mid tap is band-passed at 1.1 kHz.
    // Both graph paths call attachMidTap, so this covers system, mic and file.
    const lowAnalyser = ctx.createAnalyser()
    lowAnalyser.fftSize = LOW_FFT_SIZE
    lowAnalyser.smoothingTimeConstant = 0
    source.connect(lowAnalyser)
    this.lowAnalyser = lowAnalyser

    // Both graph-building paths route through here, so this is also where the
    // Essentia PCM tap attaches. Fire-and-forget: it resolves after the
    // worklet module loads, never throws, and a failure just leaves the
    // built-in estimators in charge.
    void essentiaBridge.attach(ctx, source)

    // K-weighting loudness worklet (issue 12). Same fire-and-forget contract —
    // its own worklet module, never throws; a failure just leaves f.loudness /
    // f.lufsShortTerm at their idle defaults.
    void this.attachLoudnessTap(ctx, source)
  }

  /**
   * Wire the ITU-R BS.1770 K-weighting loudness worklet into the graph. Own
   * AudioWorkletNode (not chained off the essentia tap, which is an
   * outputs:0 sink), so loudness works even when the essentia WASM is absent.
   * Never throws.
   */
  private async attachLoudnessTap(ctx: AudioContext, source: AudioNode): Promise<void> {
    try {
      const url = URL.createObjectURL(new Blob([LOUDNESS_PROCESSOR], { type: 'text/javascript' }))
      try {
        await ctx.audioWorklet.addModule(url)
      } finally {
        URL.revokeObjectURL(url)
      }
      // A newer session's context took over while addModule was in flight.
      // `this.ctx` is null during the file path's pre-play() window, so only
      // bail on a genuinely different context.
      if (this.ctx !== null && this.ctx !== ctx) return
      const node = new AudioWorkletNode(ctx, 'audiovis-loudness', {
        numberOfInputs: 1,
        numberOfOutputs: 0,
      })
      node.port.onmessage = (e: MessageEvent<{ msMomentary: number; msShort: number }>) => {
        const mom = e.data?.msMomentary
        const short = e.data?.msShort
        if (typeof mom === 'number' && Number.isFinite(mom) && mom >= 0) this.lastLoudMsMom = mom
        if (typeof short === 'number' && Number.isFinite(short) && short >= 0) {
          this.lastLoudMsShort = short
        }
      }
      source.connect(node)
      this.loudnessNode = node
    } catch {
      this.loudnessNode = null
    }
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
    this.lowAnalyser = null
    if (this.loudnessNode) this.loudnessNode.port.onmessage = null
    this.loudnessNode = null
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
    this.lowFreqDb.fill(0)
    this.lastLoudMsMom = 0
    this.lastLoudMsShort = 0
    this.fluxHistory = []
    this.energyLog = []
    this.lastOnsetTime = -10
    this.lastFrameTime = 0
    this.lastGridIndex = -1
    this.beatHoldUntil = -1
    // Force the next frame to count as "FFT advanced" — a fresh source's first
    // frame must never be mistaken for a duplicate of the previous source's last.
    this.waveProbe0 = NaN
    this.waveProbeMid = NaN
    this.waveProbeLast = NaN
    this.silenceSince = 0
    this.dropUntil = -1
    this.bpmEstimator.reset()
    this.phraseDetector.reset()
    this.moodEstimator.reset()
    this.percussionDetector.reset()
    this.sectionTracker.reset()
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
      this.sectionTracker.update(f, null)
      return
    }

    const now = ctx.currentTime
    const delta = Math.min(0.1, Math.max(0.001, now - this.lastFrameTime))
    this.lastFrameTime = now
    f.time = now
    f.delta = delta

    analyser.getFloatTimeDomainData(f.waveform)
    analyser.getFloatFrequencyData(this.freqDb)
    if (this.lowAnalyser) this.lowAnalyser.getFloatFrequencyData(this.lowFreqDb)
    // Band-passed time domain — the lead/synth wave scenes can trace.
    if (this.midAnalyser) {
      this.midAnalyser.getFloatTimeDomainData(f.midWaveform)
      this.normalizeWave(f.midWaveform, delta)
    }

    // Has the analyser actually advanced since last frame? At very high refresh
    // rates (or a throttled tab) the render loop outruns the audio callback and
    // getFloatFrequencyData re-reads the same FFT — those frames must not feed
    // the onset/percussion detectors (see fftAdvanced usage below).
    const w0 = f.waveform[0]
    const wMid = f.waveform[f.waveform.length >> 1]
    const wLast = f.waveform[f.waveform.length - 1]
    const fftAdvanced =
      w0 !== this.waveProbe0 || wMid !== this.waveProbeMid || wLast !== this.waveProbeLast
    this.waveProbe0 = w0
    this.waveProbeMid = wMid
    this.waveProbeLast = wLast

    // --- Spectrum (dB → linear magnitude, clamped to the 0..1 contract) ---
    // f.spectrum now spans the full FFT_SIZE/2 (0..Nyquist), and the clamp
    // enforces the documented per-bin range on hot masters. See writeLinearSpectrum.
    const nyquist = ctx.sampleRate / 2
    const binHz = nyquist / this.freqDb.length
    writeLinearSpectrum(this.freqDb, f.spectrum)

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

    // --- Bands + centroid + flux + texture cues (flatness/rolloff/air/sparkle) ---
    const spectral = computeSpectralBands(this.freqDb, this.prevMag, binHz)
    // `f.sub` comes from the dedicated 8192 analyser when it exists (≈5.4 Hz/bin
    // vs the 2048 path's ~21.5, which can't resolve sub-bass at all); the
    // 2048-derived `spectral.sub` is the fallback. `f.bass` deliberately stays
    // on the 2048 grid — the 8192 window's ~186 ms smear would blunt the kick
    // energy that `beatStrength` and scene bass-pulses read at the beat.
    const subRaw = this.lowAnalyser
      ? computeLowBands(this.lowFreqDb, nyquist / this.lowFreqDb.length).sub
      : spectral.sub

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
    f.sub = norm(this.bands.sub, subRaw)
    f.presence = norm(this.bands.presence, spectral.presence)
    f.high = norm(this.bands.high, spectral.high)
    f.vocal = norm(this.bands.vocal, spectral.vocal)
    f.air = norm(this.bands.air, spectral.air)
    f.sparkle = norm(this.bands.sparkle, spectral.sparkle)
    // BS.1770 K-weighting loudness (issue 12). `f.loudness` is the momentary
    // (~400 ms) K-weighted RMS through a BandNormalizer, so it is
    // loudness-invariant and on the same 0..1 scale as the bands.
    // `f.lufsShortTerm` is the raw 3 s LUFS value — an ABSOLUTE scale (rises
    // when the operator turns the input up), diagnostic only; nothing that
    // gates on it may assume loudness invariance.
    f.loudness = norm(this.bands.loudness, Math.sqrt(this.lastLoudMsMom))
    f.lufsShortTerm = meanSquareToLufs(this.lastLoudMsShort)
    f.flux = norm(this.bands.flux, spectral.bassFlux)
    f.transient += (Math.min(1, f.flux * 1.5) - f.transient) * Math.min(1, delta * 20)
    // `centroidRaw` now integrates the whole spectrum (not just to 9 kHz), so a
    // bright/air-heavy master reads higher. Gain re-derived against the 8-track
    // corpus to hold `f.centroid`'s distribution where it was (p50 ~0.54,
    // p90 ~0.85) — 3 → 2.1 — so every downstream `bright` term is unperturbed.
    f.centroid += (Math.min(1, spectral.centroidRaw * 2.1) - f.centroid) * Math.min(1, delta * 8)
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

    // --- Independent drum hits + broadband onset ---
    // Both are flux-diff detectors, so they only make sense on a frame where the
    // FFT actually advanced. On a duplicate frame (render loop outrunning the
    // audio callback at high refresh, or a throttled tab) `spectral.bassFlux` is
    // ~0 by construction (it diffs against an identical `prevMag`), and feeding
    // those zeros into the adaptive thresholds just drags their mean/σ down and
    // suppresses real onsets. `computeSpectralBands` still ran above, so
    // `prevMag` holds the last real magnitudes and the next live frame diffs
    // across the gap correctly.
    if (fftAdvanced) {
      // Drum hits: separate from the broadband onset — that one owns beat
      // TIMING, this owns which part of the kit fired.
      this.percussionDetector.update(f.percussion, spectral, now, delta, f.silence)

      // Broadband onset: adaptive threshold over the last FLUX_WINDOW_SEC of
      // flux. The ring is evicted by age, not count, so its statistics cover a
      // fixed wall-clock window at any render fps.
      this.fluxHistory.push({ t: now, v: spectral.bassFlux })
      // The `- 1e-6` makes this hold exactly 60 samples at a steady 60 fps
      // (bit-identical to the old fixed count, so the F121 onset calibration is
      // preserved) despite float drift in the frame clock — while still being a
      // true ~1 s window at any other frame rate.
      while (
        this.fluxHistory.length > 0 &&
        now - this.fluxHistory[0].t >= FLUX_WINDOW_SEC - 1e-6
      ) {
        this.fluxHistory.shift()
      }
      if (this.fluxHistory.length > 20 && !f.silence) {
        let mean = 0
        for (const e of this.fluxHistory) mean += e.v
        mean /= this.fluxHistory.length
        let variance = 0
        for (const e of this.fluxHistory) variance += (e.v - mean) * (e.v - mean)
        const std = Math.sqrt(variance / this.fluxHistory.length)
        const threshold = mean + 1.6 * std + 1e-6
        if (spectral.bassFlux > threshold && now - this.lastOnsetTime > 0.18) {
          this.lastOnsetTime = now
          const strength = Math.min(1, (spectral.bassFlux - mean) / (std * 4 + 1e-6))
          this.bpmEstimator.addOnset(now, strength)
        }
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

    // --- Song structure: latched section read. `structureBridge.update` drains
    // any completed worker segmentation (usually null) and schedules the next
    // job; the tracker fuses it with the synchronous drop/build flags. ---
    this.sectionTracker.update(f, structureBridge.update(f))
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
