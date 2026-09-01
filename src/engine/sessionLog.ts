import { audioEngine } from '../audio/AudioEngine'
import { MOOD_CHANGE_MAX_AMBIGUITY, MOOD_CHANGE_MIN_CONFIDENCE } from './autoPilotGates'
import { frameLoad } from './frameLoad'
import { isLensActive, isMirrorActive } from './opticalRack'
import { PALETTES } from './palettes'
import { performanceState } from './performanceState'
import { perf } from './PerfMonitor'
import { quality } from './quality'
import { renderScale } from './renderScale'
import {
  beatCoverageScore,
  beatHitScore,
  cutOffsetDistribution,
  histogramBuckets,
  normalisedEntropy,
  rackDutyCycle,
  repeatGapsSec,
  timeToRepeat,
  type CutBeatSample,
} from './showQualityMetrics'
import { useStore } from '../store'

/**
 * Session recorder — everything the engine knows about itself, over a whole
 * track, in one file.
 *
 * ## Why this exists
 *
 * Every performance question so far has been answered through a human relaying
 * two numbers from a panel: "p95 is 66 to 80", "I can't see the demotions". That
 * is not a fault of the human, it is a fault of the instrument. A p95 with no
 * timeline cannot say whether the frame was slow for ten seconds or the whole
 * track; it cannot say which SCENE was on screen when it was slow; and it cannot
 * say whether the ladder responded at all, which is exactly the thing three
 * separate bugs have now turned on (F110, F111, F114).
 *
 * `/bench` does not answer these either, and cannot: it sweeps one scene at a
 * time, with no audio (F112), no transitions, no layering and no director. The
 * questions that remain are all about the engine RUNNING — a real track, real
 * section changes, real crossfades, real load.
 *
 * So this records the running show and nothing else. It is a flight recorder,
 * not a benchmark: it does not perturb what it measures, it just writes down
 * what happened.
 *
 * ## What comes out
 *
 * Three artefacts, deliberately, because they answer different questions:
 *
 *  - **A summary**, a few kilobytes of text, copied to the clipboard. Frame-time
 *    percentiles, time at each tier, the ladder's actual decisions, transition
 *    completion rates, and — the one that matters most — frame time attributed
 *    to the scene that was on screen. Small enough to paste into a conversation.
 *  - **The full JSON**, every 4 Hz sample and every derived event. For anything
 *    the summary flattened.
 *  - **A contact sheet**, one PNG of periodic thumbnails. Because "it looks
 *    great but lags" is two claims and only one of them is in the numbers.
 *
 * ## Two sampling rates, on purpose
 *
 * Frame times are recorded **every frame** into a preallocated ring: a hitch is
 * a single-frame event and averaging it away is how a stuttering show reads as a
 * steady 60. Everything else is sampled at **4 Hz**, which is finer than
 * anything the governor can act on (`SETTLE_SEC` is 2 s) and keeps the file to a
 * size a person can actually send.
 *
 * ## Events are DERIVED, not instrumented
 *
 * Nothing else in the engine had to be touched to build this. Every event below
 * is found by diffing the sampled state against the previous frame — a tier
 * change, a scene change, a transition starting or ending, a layer arriving.
 * Instrumenting a dozen call sites would have been more precise about intent and
 * far worse in every other way: call sites drift, and a recorder that has to be
 * updated whenever a director changes is a recorder that silently stops
 * recording things. Diffing state cannot miss anything that is visible in state.
 */

/** Frames of raw frame time to keep. 120k at 60 Hz is ~33 minutes. */
const FRAME_CAPACITY = 120_000
/** State sample interval. 4 Hz — finer than the governor's 2 s SETTLE_SEC. */
const SAMPLE_INTERVAL_SEC = 0.25
/** Hard cap on derived events, so a pathological session cannot exhaust memory. */
const EVENT_CAPACITY = 20_000

/* ------------------------------------------------------------- thumbnails */

const TILE_W = 192
const TILE_H = 108
const SHEET_COLS = 8
const SHEET_ROWS = 8
/** 64 tiles. Coverage stays uniform at any length — see {@link compactSheet}. */
const TILE_CAPACITY = SHEET_COLS * SHEET_ROWS

/* ------------------------------------------------------------------ shapes */

/** One 4 Hz observation of everything the engine will tell us. */
export interface SessionSample {
  /** Seconds since recording started. */
  t: number
  fps: number
  ms: number
  p95: number
  tier: number
  appliedTier: number
  renderScale: number
  internalMP: number
  dpr: number
  drawCalls: number
  triangles: number
  programs: number
  /** Frame budget: what is committed, against what the tier allows. */
  budgetMs: number
  primaryMs: number
  incomingMs: number
  layersMs: number
  effectsMs: number
  fixedMs: number
  /** Audio. `silence` is the engine's own judgement, not a threshold applied here. */
  rms: number
  energy: number
  bass: number
  mid: number
  high: number
  bpm: number
  silence: boolean
  /**
   * The mood read itself, not just its output.
   *
   * Added after the first real session (F118): the recording showed the show
   * holding one scene for 38 s and could not say why, because a scene switch is
   * gated on the mood read inside AutoPilot and it was not being written down.
   * A recorder that captures a decision's RESULT but not its INPUTS can only
   * ever confirm that something did not happen.
   *
   * `confidence` is `AudioFeatures.confidence` — BEAT-GRID trust
   * (`BpmEstimator.confidence`, tempo/phase lock). `moodConfidence` is
   * `AudioFeatures.mood.confidence` — the MoodEstimator's certainty in the
   * committed state, which is what AutoPilot's `MOOD_CHANGE_MIN_CONFIDENCE`
   * gate reads. Different signals: F118's "confidence peaked at 0.392" was
   * measured off `confidence` (this field), before `moodConfidence` existed.
   */
  confidence: number
  moodConfidence: number
  ambiguity: number
  moodChanges: number
  /** Show state. */
  scene: string
  activeScene: string
  /** In flight but not yet committed — the gap between a request and a commit. */
  pendingScene: string | null
  mood: string
  tension: number
  background: string | null
  accent: string | null
  overlay: string | null
  effectCount: number
  /** Post FX, so a slow stretch can be blamed on a rack rather than a scene. */
  bloom: number
  trails: number
  glitch: number
  vignette: number
  fog: number
  mirrorSegments: number
  mirrorSpin: number
  lensAmount: number
  lensStyle: number
  transitionActive: boolean
  transitionStyle: string
  transitionProgress: number
  /** Palette in force. Colour variety is not visible in any other field. */
  palette: string
  /**
   * The store's quality setting and the ceiling it imposes.
   *
   * F116 was invisible in the first recording for want of exactly this: the
   * ladder showed `tier changes: 0` and nothing said whether that was because
   * the frame was fine (it was not) or because the governor had been switched
   * off (it had).
   */
  qualityMode: string
  autoPilot: boolean
  /**
   * Real GPU execution time (c11b), milliseconds — 0 when
   * `gpuTimerAvailable` is false (the extension is unsupported here) or no
   * result has landed yet. See `perf.gpuMs`'s own doc for why this always
   * lags `ms` slightly rather than being a same-sample GPU/other split.
   */
  gpuMs: number
  gpuTimerAvailable: boolean
  /** Bar count (`AudioFeatures.bar`) — the beat-grid position this sample fell at, for show-quality metrics (c13). */
  bar: number
  /** `isMirrorActive`/`isLensActive` on the state this sample already captured — reuses the racks' own "is there
   *  anything to do" predicate rather than re-deriving engagement from a subset of the dials (mirror's `segments`
   *  alone reads as off for three of its four ON modes). */
  mirrorActive: boolean
  lensActive: boolean
}

export type SessionEventKind =
  | 'tier'
  | 'scale'
  | 'scene'
  | 'transition-start'
  | 'transition-end'
  | 'layer'
  /**
   * A layer that actually became VISIBLE, as opposed to one the director merely
   * asked for (F150). See performanceState.mountedLayers for why the two are
   * different and why the difference was worth recording.
   */
  | 'layer-visible'
  | 'mood'
  /**
   * The complexity knobs the scenes actually read, at the frame they actually
   * changed (F161).
   *
   * Distinct from `tier`, which is the frame the GOVERNOR DECIDED. Since F157
   * made the render-scale hold directional the two can be seconds apart on a
   * climb — the knobs swap on the decision, the resolution waits — and nothing
   * recorded the second half of that. The session this was added for has a
   * 234 ms frame 0.67 s after a `promote 2 -> 1`, with no instrument able to
   * say whether anything was applied in between.
   */
  | 'knobs'
  | 'palette'
  | 'audio'
  | 'effect'
  | 'note'

export interface SessionEvent {
  t: number
  kind: SessionEventKind
  /** Human-readable, and the only field the summary prints. */
  detail: string
  /** Frame time and p95 at the moment it happened — the "why" for a tier change. */
  ms: number
  p95: number
  scene: string
  /** Beat-grid position at the moment this event was pushed (c13's show-quality metrics) —
   *  recorded on every event, same as `ms`/`p95`/`scene`, cheap context that is only load-bearing
   *  for 'scene' commits (cuts) but costs nothing to carry on the rest. */
  bar: number
  beatInBar: number
  beatProgress: number
}

/* ------------------------------------------------------------------ state */

/**
 * Read a wrapping ring buffer back into chronological order, oldest first.
 *
 * Exported and pure because the off-by-one here is the kind that produces a
 * plausible-looking report with the samples silently rotated — a hitch would
 * appear at the wrong time and be blamed on whatever scene happened to be at
 * that offset. `count` is the true number of writes, which may exceed capacity.
 */
export function readRing(buf: Float32Array, write: number, count: number): number[] {
  const cap = buf.length
  const n = Math.min(count, cap)
  const out: number[] = new Array(n)
  // Once wrapped, the oldest surviving sample is the one about to be
  // overwritten — i.e. the write head. Before that, index 0 is the oldest.
  const start = count > cap ? write : 0
  for (let i = 0; i < n; i++) out[i] = buf[(start + i) % cap]
  return out
}

/** Frame-time statistics. Sorts a copy; never mutates the caller's array. */
export function frameStats(values: readonly number[]): {
  mean: number
  p50: number
  p95: number
  p99: number
  max: number
  over: (ms: number) => number
} {
  if (values.length === 0) {
    return { mean: 0, p50: 0, p95: 0, p99: 0, max: 0, over: () => 0 }
  }
  const s = [...values].sort((a, b) => a - b)
  const pc = (q: number) => s[Math.min(s.length - 1, Math.floor(s.length * q))]
  return {
    mean: values.reduce((a, b) => a + b, 0) / values.length,
    p50: pc(0.5),
    p95: pc(0.95),
    p99: pc(0.99),
    max: s[s.length - 1],
    over: (ms: number) => (values.filter((v) => v > ms).length / values.length) * 100,
  }
}

function stageCanvas(): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null
  return document.querySelector<HTMLCanvasElement>('.stage canvas')
}

/** GPU string, read once. Behind a try: the debug extension is not universal. */
function gpuName(): string {
  try {
    const c = stageCanvas()
    const gl = c?.getContext('webgl2') ?? c?.getContext('webgl')
    if (!gl) return 'unknown'
    const ext = (gl as WebGLRenderingContext).getExtension('WEBGL_debug_renderer_info')
    if (!ext) return 'unknown (extension blocked)'
    return String(
      (gl as WebGLRenderingContext).getParameter(
        (ext as { UNMASKED_RENDERER_WEBGL: number }).UNMASKED_RENDERER_WEBGL,
      ),
    )
  } catch {
    return 'unknown'
  }
}

class SessionLog {
  private active = false
  private startedAt = 0
  private elapsed = 0

  /** Raw per-frame times, preallocated. Wraps; `frameCount` is the true total. */
  private frames = new Float32Array(FRAME_CAPACITY)
  private frameWrite = 0
  /**
   * Frames that span an interval where the tab was hidden (F152).
   *
   * Parallel to {@link frames}: 1 marks a frame whose `delta` is mostly time
   * the page was not rendering at all, because `requestAnimationFrame` is
   * throttled or stopped entirely while `document.hidden`.
   *
   * ## Why the report needs this and the live governor does not
   *
   * `PerfMonitor` deliberately puts no ceiling on a frame time, and is right to:
   * a genuine 150-300 ms frame is exactly what it exists to catch, and a
   * backgrounding transient ages out of its rolling windows within a second or
   * two on its own.
   *
   * The session report is a different consumer with a different lifetime. It
   * keeps every frame forever, so one alt-tab lands at the top of "worst single
   * frames" and drags `max` and `p99` with it — and those are precisely the
   * numbers this project has been citing session-over-session to track a real
   * stall (F144/F145). `audiovis-session-2026-08-29-16-15-09` reports
   * `max 24295.4 ms` for a frame with no scene, tier or scale event anywhere
   * near it, immediately followed by `audio resumed`: the window was simply not
   * in front for 24 seconds.
   *
   * Marked rather than dropped, and then handled differently by each consumer:
   * the JSON keeps every frame so the timeline stays whole, the distribution
   * stats skip the marked ones because a throttled frame is not a measurement
   * of anything the renderer did, and the worst-frames list still prints them
   * with a label so nothing disappears silently. Deleting the frame outright
   * would be the mistake `PerfMonitor`'s no-ceiling comment warns about.
   */
  private hiddenFrames = new Uint8Array(FRAME_CAPACITY)
  /** Set by the visibilitychange listener; consumed by the next tick. */
  private sawHidden = false
  private onVisibility: (() => void) | null = null

  private frameCount = 0

  private samples: SessionSample[] = []
  private events: SessionEvent[] = []
  private nextSampleAt = 0

  /** Previous frame's state, for the diff that produces events. */
  private prev = {
    tier: -1,
    scale: -1,
    scene: '',
    mood: '',
    silence: null as boolean | null,
    transition: false,
    background: null as string | null,
    accent: null as string | null,
    overlay: null as string | null,
    mountedBackground: null as string | null,
    mountedAccent: null as string | null,
    mountedOverlay: null as string | null,
    effects: 0,
    pending: '',
    palette: '',
    knobs: '',
  }
  private transitionStartedAt = 0
  private transitionStyle = ''
  private transitionPeak = 0

  private env = { gpu: '', ua: '', display: '', baseDpr: 0, startedISO: '' }

  /** Contact sheet, allocated on start and drawn into from the render loop. */
  private sheet: HTMLCanvasElement | null = null
  private sheetCtx: CanvasRenderingContext2D | null = null
  private tiles = 0
  private tileInterval = 2
  private nextTileAt = 0

  isRecording(): boolean {
    return this.active
  }

  /** Seconds recorded so far — the console shows this on the button. */
  elapsedSec(): number {
    return this.active ? this.elapsed : 0
  }

  sampleCount(): number {
    return this.samples.length
  }

  start(): void {
    if (this.active) return
    this.active = true
    this.startedAt = performance.now() / 1000
    this.elapsed = 0
    this.frameWrite = 0
    this.frameCount = 0
    this.hiddenFrames.fill(0)
    this.sawHidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
    if (typeof document !== 'undefined' && !this.onVisibility) {
      // Latched rather than sampled in tick(): by the time rAF resumes the page
      // is already visible again, so asking document.hidden from inside the
      // frame would always answer "no" and never catch the frame that spans the
      // gap. The listener fires on the way OUT, and the next tick consumes it.
      this.onVisibility = () => {
        if (document.visibilityState === 'hidden') this.sawHidden = true
      }
      document.addEventListener('visibilitychange', this.onVisibility)
    }
    this.samples = []
    this.events = []
    this.nextSampleAt = 0
    this.tiles = 0
    this.tileInterval = 2
    this.nextTileAt = 0
    this.prev = {
      tier: -1,
      scale: -1,
      scene: '',
      mood: '',
      silence: null,
      transition: false,
      background: null,
      accent: null,
      overlay: null,
      mountedBackground: null,
      mountedAccent: null,
      mountedOverlay: null,
      effects: 0,
      pending: '',
      palette: '',
      knobs: '',
    }

    const c = stageCanvas()
    this.env = {
      gpu: gpuName(),
      ua: navigator.userAgent,
      display: c ? `${c.clientWidth}x${c.clientHeight} css, buffer ${c.width}x${c.height}` : 'no canvas',
      baseDpr: renderScale.baseDpr,
      startedISO: new Date().toISOString(),
    }

    this.sheet = typeof document === 'undefined' ? null : document.createElement('canvas')
    if (this.sheet) {
      this.sheet.width = TILE_W * SHEET_COLS
      this.sheet.height = TILE_H * SHEET_ROWS
      this.sheetCtx = this.sheet.getContext('2d')
      if (this.sheetCtx) {
        this.sheetCtx.fillStyle = '#000'
        this.sheetCtx.fillRect(0, 0, this.sheet.width, this.sheet.height)
      }
    }
    this.note('recording started')
  }

  /** Add a free-text marker. Useful for "the drop is here". */
  note(detail: string): void {
    if (!this.active) return
    this.push('note', detail)
  }

  private push(kind: SessionEventKind, detail: string): void {
    if (this.events.length >= EVENT_CAPACITY) return
    const f = audioEngine.features
    this.events.push({
      t: round(this.elapsed, 2),
      kind,
      detail,
      ms: round(perf.ms, 2),
      p95: round(perf.p95, 2),
      scene: performanceState.activeScene,
      bar: f.bar,
      beatInBar: f.beatInBar,
      beatProgress: round(f.beatProgress, 3),
    })
  }

  /**
   * Called once per frame from inside the render loop, AFTER the composer has
   * drawn — see `SessionRecorderTap` in Stage.tsx. Allocation-free except for
   * the 4 Hz sample and any event it raises.
   */
  tick(delta: number): void {
    if (!this.active) return
    this.elapsed += delta

    // Every frame: the raw time. A hitch is a single frame and an average
    // cannot represent one.
    this.frames[this.frameWrite] = delta * 1000
    this.hiddenFrames[this.frameWrite] = this.sawHidden ? 1 : 0
    this.sawHidden = false
    this.frameWrite = (this.frameWrite + 1) % FRAME_CAPACITY
    this.frameCount++

    this.detectEvents()

    if (this.elapsed >= this.nextSampleAt) {
      this.nextSampleAt = this.elapsed + SAMPLE_INTERVAL_SEC
      this.takeSample()
    }
    if (this.elapsed >= this.nextTileAt) {
      this.nextTileAt = this.elapsed + this.tileInterval
      this.grabTile()
    }
  }

  /* ------------------------------------------------------------- events */

  private detectEvents(): void {
    const p = performanceState
    const tx = p.transition

    if (quality.tier !== this.prev.tier) {
      if (this.prev.tier >= 0) {
        const dir = quality.tier > this.prev.tier ? 'DEMOTE' : 'promote'
        this.push('tier', `${dir} ${this.prev.tier} -> ${quality.tier}`)
      }
      this.prev.tier = quality.tier
    }
    const scale = round(renderScale.applied, 2)
    if (scale !== this.prev.scale) {
      if (this.prev.scale >= 0) {
        this.push(
          'scale',
          `${this.prev.scale.toFixed(2)} -> ${scale.toFixed(2)} (${renderScale
            .internalMP(renderScale.applied)
            .toFixed(2)} MP)`,
        )
      }
      this.prev.scale = scale
    }
    if (p.activeScene !== this.prev.scene) {
      if (this.prev.scene) this.push('scene', `${this.prev.scene} -> ${p.activeScene}`)
      this.prev.scene = p.activeScene
    }
    // A REQUEST, which is the event AutoPilot actually produces — the commit
    // above can trail it by seconds while SceneManager warms the shader and
    // waits for a downbeat. Logging only the commit made a slow decision and a
    // slow handoff look identical (F118).
    const store = useStore.getState()
    const pending = store.pendingSceneId ?? ''
    if (pending !== this.prev.pending) {
      if (pending) this.push('scene', `requested ${pending}`)
      // A WITHDRAWAL (F163). `pendingSceneId` clearing means one of two very
      // different things, and the log used to record neither: the request
      // committed, or it went away. Compared against the store's own `sceneId`
      // rather than `activeScene` because `commitScene` sets them together, so
      // this is exact rather than a race with SceneManager's crossfade — on a
      // commit the ids match and nothing is pushed.
      //
      // The session that produced F163 had a `requested chrome` at 22.58 s that
      // was gone by 22.87 s having never mounted, and there was no line in any
      // stream saying so; it took a diff of two 4 Hz samples to notice at all.
      else if (this.prev.pending && this.prev.pending !== store.sceneId)
        this.push('scene', `withdrew ${this.prev.pending}`)
      this.prev.pending = pending
    }
    // F161: what the scenes are actually reading, at the frame it changed.
    // Suppressed during a crossfade, where TRANSITION_DISCOUNT_TIERS eases the
    // same knobs dozens of times for a reason the transition events already
    // record — the question this exists to answer is what moved when NOTHING
    // structural was happening.
    if (!tx.active) {
      const k = quality.knobs
      const knobKey = `${k.raymarchSteps}/${k.noiseOctaves}/${k.fluidJacobi}/${k.particleFraction.toFixed(2)}/${k.pixelBudgetScale.toFixed(2)}`
      if (knobKey !== this.prev.knobs) {
        if (this.prev.knobs)
          this.push(
            'knobs',
            `steps ${k.raymarchSteps} oct ${k.noiseOctaves} jacobi ${k.fluidJacobi} ` +
              `particles ${k.particleFraction.toFixed(2)} budget x${k.pixelBudgetScale.toFixed(2)}`,
          )
        this.prev.knobs = knobKey
      }
    }
    const palette = performanceState.palette
    if (palette !== this.prev.palette) {
      if (this.prev.palette) this.push('palette', `${this.prev.palette} -> ${palette}`)
      this.prev.palette = palette
    }
    if (p.mood !== this.prev.mood) {
      if (this.prev.mood) this.push('mood', `${this.prev.mood} -> ${p.mood}`)
      this.prev.mood = p.mood
    }
    const silence = audioEngine.features.silence
    if (silence !== this.prev.silence) {
      if (this.prev.silence !== null) this.push('audio', silence ? 'went silent' : 'audio resumed')
      this.prev.silence = silence
    }

    // Transitions get start/end pairs plus the worst frame seen inside them,
    // which is the only way to say whether a crossfade is affordable.
    if (tx.active && !this.prev.transition) {
      this.transitionStartedAt = this.elapsed
      this.transitionStyle = tx.style
      this.transitionPeak = 0
      this.push('transition-start', `${tx.style} (${tx.durationSec.toFixed(2)}s)`)
    } else if (!tx.active && this.prev.transition) {
      const dur = this.elapsed - this.transitionStartedAt
      // `progress` is where it got to on the last active frame. Anything short
      // of ~1 means it was cut off rather than completed.
      const done = tx.progress >= 0.98
      this.push(
        'transition-end',
        `${this.transitionStyle} ${done ? 'completed' : `ABORTED at ${(tx.progress * 100) | 0}%`}` +
          ` in ${dur.toFixed(2)}s, worst frame ${this.transitionPeak.toFixed(1)}ms`,
      )
    }
    if (tx.active) this.transitionPeak = Math.max(this.transitionPeak, perf.ms)
    this.prev.transition = tx.active

    const l = p.layers
    for (const role of ['background', 'accent', 'overlay'] as const) {
      const now = l[role]
      if (now !== this.prev[role]) {
        this.push('layer', now ? `${role}: + ${now}` : `${role}: - ${this.prev[role]}`)
        this.prev[role] = now
      }
    }
    // The same three roles again, but from what is being DRAWN. A desire that
    // is withdrawn before its warm mount completes produces a 'layer' pair with
    // no 'layer-visible' pair between them, which is the whole point.
    const m = p.mountedLayers
    for (const role of ['background', 'accent', 'overlay'] as const) {
      const key = ('mounted' + role[0].toUpperCase() + role.slice(1)) as
        | 'mountedBackground'
        | 'mountedAccent'
        | 'mountedOverlay'
      const now = m[role]
      if (now !== this.prev[key]) {
        this.push('layer-visible', now ? `${role}: + ${now}` : `${role}: - ${this.prev[key]}`)
        this.prev[key] = now
      }
    }
    if (l.effects.length !== this.prev.effects) {
      if (l.effects.length > this.prev.effects) {
        this.push('effect', `fired (${l.effects.join(', ') || 'none'})`)
      }
      this.prev.effects = l.effects.length
    }
  }

  /* ------------------------------------------------------------ sampling */

  private takeSample(): void {
    const p = performanceState
    const f = audioEngine.features
    const store = useStore.getState()
    this.samples.push({
      t: round(this.elapsed, 2),
      fps: round(perf.fps, 1),
      ms: round(perf.ms, 2),
      p95: round(perf.p95, 2),
      tier: quality.tier,
      appliedTier: perf.appliedTier,
      renderScale: round(renderScale.applied, 3),
      internalMP: round(renderScale.internalMP(renderScale.applied), 2),
      dpr: round(perf.dpr, 3),
      drawCalls: perf.drawCalls,
      triangles: perf.triangles,
      programs: perf.programs,
      budgetMs: round(quality.knobs.frameBudgetMs, 2),
      primaryMs: round(frameLoad.primary, 2),
      incomingMs: round(frameLoad.incoming, 2),
      layersMs: round(frameLoad.layers, 2),
      effectsMs: round(frameLoad.effects, 2),
      fixedMs: round(frameLoad.fixed, 2),
      rms: round(f.rms, 3),
      energy: round(f.energy, 3),
      bass: round(f.bass, 3),
      mid: round(f.mid, 3),
      high: round(f.high, 3),
      bpm: round(f.bpm, 1),
      silence: f.silence,
      confidence: round(f.confidence, 3),
      moodConfidence: round(f.mood.confidence ?? 0, 3),
      ambiguity: round(f.mood.ambiguity ?? 0, 3),
      moodChanges: f.mood.changeCount ?? 0,
      scene: p.scene,
      activeScene: p.activeScene,
      pendingScene: store.pendingSceneId ?? null,
      mood: p.mood,
      tension: round(p.visualTension, 3),
      background: p.layers.background,
      accent: p.layers.accent,
      overlay: p.layers.overlay,
      effectCount: p.layers.effects.length,
      bloom: round(p.bloom, 3),
      trails: round(p.trails, 3),
      glitch: round(p.glitch, 3),
      vignette: round(p.vignette, 3),
      fog: round(p.fog, 3),
      mirrorSegments: p.mirror.segments,
      mirrorSpin: round(p.mirror.spin, 3),
      lensAmount: round(p.lens.amount, 3),
      lensStyle: p.lens.style,
      transitionActive: p.transition.active,
      transitionStyle: p.transition.style,
      transitionProgress: round(p.transition.progress, 3),
      palette: p.palette,
      qualityMode: store.quality,
      autoPilot: store.autoPilot,
      gpuMs: round(perf.gpuMs, 2),
      gpuTimerAvailable: perf.gpuTimerAvailable,
      bar: f.bar,
      mirrorActive: isMirrorActive(p.mirror),
      lensActive: isLensActive(p.lens),
    })
  }

  /* ---------------------------------------------------------- thumbnails */

  /**
   * Copy the live frame into the next contact-sheet tile.
   *
   * Must run inside the render tick that drew it: `preserveDrawingBuffer` is
   * off, so this is the only moment the canvas holds pixels rather than
   * transparency — the same constraint `captureIfRequested` documents.
   */
  private grabTile(): void {
    const c = stageCanvas()
    const ctx = this.sheetCtx
    if (!c || !ctx) return
    if (this.tiles >= TILE_CAPACITY) this.compactSheet()
    const col = this.tiles % SHEET_COLS
    const row = (this.tiles / SHEET_COLS) | 0
    try {
      ctx.drawImage(c, col * TILE_W, row * TILE_H, TILE_W, TILE_H)
    } catch {
      return // Tainted or lost context — a missing thumbnail is not worth throwing over.
    }
    this.tiles++
  }

  /**
   * Halve the sheet in place: keep every other tile, double the interval.
   *
   * This is what keeps coverage UNIFORM across a recording of any length. The
   * obvious alternative — stop taking thumbnails once full — front-loads every
   * long session, so a track that goes wrong in its last minute would have no
   * pictures of the part that matters.
   */
  private compactSheet(): void {
    const ctx = this.sheetCtx
    const sheet = this.sheet
    if (!ctx || !sheet) return
    if (typeof document === 'undefined') return
    const tmp = document.createElement('canvas')
    tmp.width = sheet.width
    tmp.height = sheet.height
    const tctx = tmp.getContext('2d')
    if (!tctx) return
    tctx.drawImage(sheet, 0, 0)
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, sheet.width, sheet.height)
    for (let i = 0; i * 2 < TILE_CAPACITY; i++) {
      const src = i * 2
      ctx.drawImage(
        tmp,
        (src % SHEET_COLS) * TILE_W,
        ((src / SHEET_COLS) | 0) * TILE_H,
        TILE_W,
        TILE_H,
        (i % SHEET_COLS) * TILE_W,
        ((i / SHEET_COLS) | 0) * TILE_H,
        TILE_W,
        TILE_H,
      )
    }
    this.tiles = TILE_CAPACITY >> 1
    this.tileInterval *= 2
  }

  /* -------------------------------------------------------------- output */

  /** Raw frame times in chronological order, oldest first. */
  private frameTimes(): number[] {
    return readRing(this.frames, this.frameWrite, this.frameCount)
  }

  /**
   * Per-frame "the tab was hidden across this frame" flags, aligned index-for-
   * index with {@link frameTimes} (F152).
   */
  private hiddenFlags(): boolean[] {
    const cap = this.hiddenFrames.length
    const n = Math.min(this.frameCount, cap)
    const start = this.frameCount > cap ? this.frameWrite : 0
    const out: boolean[] = new Array(n)
    for (let i = 0; i < n; i++) out[i] = this.hiddenFrames[(start + i) % cap] === 1
    return out
  }

  /** Derived events, for tests and for anything that wants the timeline raw. */
  eventLog(): readonly SessionEvent[] {
    return this.events
  }

  stop(): { summary: string; json: string; sheet: HTMLCanvasElement | null } {
    this.active = false
    if (this.onVisibility && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibility)
      this.onVisibility = null
    }
    this.push('note', 'recording stopped')
    const summary = this.buildSummary()
    const json = JSON.stringify({
      version: 1,
      env: this.env,
      durationSec: round(this.elapsed, 2),
      frameCount: this.frameCount,
      frameTimesMs: this.frameTimes().map((v) => round(v, 2)),
      samples: this.samples,
      events: this.events,
      summary,
    })
    return { summary, json, sheet: this.sheet }
  }

  /**
   * The pasteable report.
   *
   * Ordered by what a diagnosis actually needs first: what the machine is, how
   * bad it was, WHEN it was bad, and what was on screen at the time. The
   * per-scene attribution is the section none of the existing instruments can
   * produce, and is usually the answer.
   */
  private buildSummary(): string {
    const ft = this.frameTimes()
    const hidden = this.hiddenFlags()
    const L: string[] = []
    const dur = this.elapsed

    L.push('=== AudioVis session ===')
    L.push(`started   ${this.env.startedISO}`)
    L.push(`duration  ${dur.toFixed(1)}s, ${this.frameCount} frames`)
    L.push(`gpu       ${this.env.gpu}`)
    L.push(`display   ${this.env.display} @ baseDpr ${this.env.baseDpr}`)
    L.push('')

    // --- frame time -------------------------------------------------------
    L.push('--- frame time (ms) ---')
    // Frames spanning a hidden tab are excluded from the DISTRIBUTION (F152):
    // rAF is throttled or stopped while the page is backgrounded, so the delta
    // measures how long the user was elsewhere, not how long a frame took. One
    // alt-tab otherwise owns max and p99 for the whole session. They are still
    // printed, labelled, in the worst-frames list below.
    const rendered = ft.filter((_, i) => !hidden[i])
    if (rendered.length === 0) {
      L.push('no frames recorded')
    } else {
      const st = frameStats(rendered)
      L.push(`mean ${st.mean.toFixed(1)}  p50 ${st.p50.toFixed(1)}  p95 ${st.p95.toFixed(1)}  p99 ${st.p99.toFixed(1)}  max ${st.max.toFixed(1)}`)
      L.push(`effective fps ${(1000 / st.mean).toFixed(1)}`)
      L.push(`over 16.7ms ${st.over(16.7).toFixed(1)}%   over 33.3ms ${st.over(33.3).toFixed(1)}%   over 50ms ${st.over(50).toFixed(1)}%`)
      const skipped = ft.length - rendered.length
      if (skipped > 0) {
        L.push(`excluded ${skipped} frame${skipped === 1 ? '' : 's'} spanning a hidden tab`)
      }
    }
    L.push('')

    // --- gpu time -----------------------------------------------------------
    // c11b: what the governor is still blind to. `frame time` above is the
    // frame's TOTAL cost — GPU work, JS, driver dispatch, vsync wait, all
    // folded together — and this isolates just the first of those, which is
    // the only part the quality knobs can actually shrink. A show reading
    // high frame time but LOW GPU share is not going to get faster from a
    // lower render scale; see gpuTiming.ts for why that distinction is not
    // yet wired into the governor's own decisions.
    L.push('--- gpu time (EXT_disjoint_timer_query_webgl2) ---')
    if (!this.samples.some((s) => s.gpuTimerAvailable)) {
      L.push('not available on this GPU/browser')
    } else {
      const gpuSamples = this.samples.filter((s) => s.gpuTimerAvailable && s.gpuMs > 0)
      if (gpuSamples.length === 0) {
        L.push('available, but no result landed during this session')
      } else {
        const gpuVals = [...gpuSamples.map((s) => s.gpuMs)].sort((a, b) => a - b)
        const gpuMean = gpuVals.reduce((a, b) => a + b, 0) / gpuVals.length
        const gpuP95 = gpuVals[Math.min(gpuVals.length - 1, Math.floor(gpuVals.length * 0.95))]
        const wallMean = gpuSamples.reduce((a, s) => a + s.ms, 0) / gpuSamples.length
        L.push(`mean ${gpuMean.toFixed(2)}ms  p95 ${gpuP95.toFixed(2)}ms  (n=${gpuVals.length} samples)`)
        L.push(
          `GPU share of frame time: ${((gpuMean / Math.max(0.001, wallMean)) * 100).toFixed(0)}%` +
            ' (the rest is JS, driver dispatch, and vsync wait)',
        )
      }
    }
    L.push('')

    // --- per-scene attribution -------------------------------------------
    // The section no other instrument can produce. `/bench` measures one scene
    // in isolation with no audio; this says which scene was on screen while the
    // real show was actually struggling.
    L.push('--- frame time by scene on screen (4Hz samples) ---')
    const byScene = new Map<string, number[]>()
    for (const s of this.samples) {
      const k = s.activeScene + (s.background || s.accent || s.overlay ? ' +layers' : '')
      const arr = byScene.get(k) ?? []
      arr.push(s.ms)
      byScene.set(k, arr)
    }
    const sceneRows = [...byScene.entries()]
      .map(([k, v]) => {
        const sorted = [...v].sort((a, b) => a - b)
        return {
          k,
          n: v.length,
          sec: v.length * SAMPLE_INTERVAL_SEC,
          mean: v.reduce((a, b) => a + b, 0) / v.length,
          p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
        }
      })
      .sort((a, b) => b.p95 - a.p95)
    for (const r of sceneRows) {
      L.push(`${r.k.padEnd(26)} ${r.sec.toFixed(0).padStart(5)}s  mean ${r.mean.toFixed(1).padStart(6)}  p95 ${r.p95.toFixed(1).padStart(6)}`)
    }
    L.push('')

    // --- the ladder -------------------------------------------------------
    L.push('--- quality ladder ---')
    // FIRST, because F116 made this the difference between "the governor tried
    // and could not keep up" and "the governor was never asked".
    const modes = new Set(this.samples.map((s) => s.qualityMode))
    L.push(`store quality setting: ${[...modes].join(' -> ') || 'unknown'}`)
    const tierSec = new Map<number, number>()
    for (const s of this.samples) tierSec.set(s.tier, (tierSec.get(s.tier) ?? 0) + SAMPLE_INTERVAL_SEC)
    for (const [t, sec] of [...tierSec.entries()].sort((a, b) => a[0] - b[0])) {
      L.push(`tier ${t}: ${sec.toFixed(0)}s (${((sec / Math.max(dur, 0.001)) * 100).toFixed(0)}%)`)
    }
    const tierEvents = this.events.filter((e) => e.kind === 'tier')
    L.push(`tier changes: ${tierEvents.length}`)
    for (const e of tierEvents.slice(0, 40)) {
      L.push(`  ${e.t.toFixed(1).padStart(7)}s  ${e.detail.padEnd(22)} ms ${e.ms.toFixed(1)} p95 ${e.p95.toFixed(1)}  [${e.scene}]`)
    }
    L.push('')

    L.push('--- render scale ---')
    const scaleSec = new Map<number, number>()
    for (const s of this.samples)
      scaleSec.set(s.renderScale, (scaleSec.get(s.renderScale) ?? 0) + SAMPLE_INTERVAL_SEC)
    for (const [v, sec] of [...scaleSec.entries()].sort((a, b) => b[0] - a[0])) {
      const mp = this.samples.find((s) => s.renderScale === v)?.internalMP ?? 0
      L.push(`scale ${v.toFixed(2)} (${mp.toFixed(2)} MP): ${sec.toFixed(0)}s`)
    }
    const scaleEvents = this.events.filter((e) => e.kind === 'scale')
    L.push(`scale changes: ${scaleEvents.length}`)
    for (const e of scaleEvents.slice(0, 25)) L.push(`  ${e.t.toFixed(1).padStart(7)}s  ${e.detail}`)
    L.push('')

    // --- budget -----------------------------------------------------------
    L.push('--- frame budget (ms reserved vs allowed) ---')
    if (this.samples.length) {
      const avg = (f: (s: SessionSample) => number) =>
        this.samples.reduce((a, s) => a + f(s), 0) / this.samples.length
      const committed = (s: SessionSample) =>
        s.primaryMs + s.incomingMs + s.layersMs + s.effectsMs + s.fixedMs
      const overs = this.samples.filter((s) => committed(s) > s.budgetMs).length
      L.push(`budget ${avg((s) => s.budgetMs).toFixed(2)}   committed ${avg(committed).toFixed(2)}`)
      L.push(`  primary ${avg((s) => s.primaryMs).toFixed(2)}  incoming ${avg((s) => s.incomingMs).toFixed(2)}  layers ${avg((s) => s.layersMs).toFixed(2)}  effects ${avg((s) => s.effectsMs).toFixed(2)}  fixed ${avg((s) => s.fixedMs).toFixed(2)}`)
      L.push(`over budget in ${((overs / this.samples.length) * 100).toFixed(0)}% of samples`)
    }
    L.push('')

    // --- transitions ------------------------------------------------------
    L.push('--- transitions ---')
    const ends = this.events.filter((e) => e.kind === 'transition-end')
    const aborted = ends.filter((e) => e.detail.includes('ABORTED'))
    L.push(`started ${this.events.filter((e) => e.kind === 'transition-start').length}, ended ${ends.length}, aborted ${aborted.length}`)
    for (const e of ends.slice(0, 30)) L.push(`  ${e.t.toFixed(1).padStart(7)}s  ${e.detail}`)
    L.push('')

    // --- audio ------------------------------------------------------------
    L.push('--- palette ---')
    const palSec = new Map<string, number>()
    for (const s of this.samples) palSec.set(s.palette, (palSec.get(s.palette) ?? 0) + SAMPLE_INTERVAL_SEC)
    L.push(
      [...palSec.entries()].sort((a, b) => b[1] - a[1]).map(([p, sec]) => `${p} ${sec.toFixed(0)}s`).join('  ') ||
        'none recorded',
    )
    // Counted from the registry rather than written out (F149's session had
    // 13 palettes in use against a literal that still said 6). The number is
    // here to answer whether the show is exercising the pool or circling a
    // corner of it, which a stale denominator gets exactly backwards.
    L.push(
      `palette changes: ${this.events.filter((e) => e.kind === 'palette').length}  (of ${PALETTES.length} available)`,
    )
    L.push('')

    // --- show quality -------------------------------------------------------
    // Cut timing, rack presence, and pool variety — none of it new data. All
    // five numbers below are derived from events and samples this recorder was
    // already taking; see showQualityMetrics.ts for the pure arithmetic.
    L.push('--- show quality ---')
    const rhsOf = (detail: string): string => {
      const i = detail.indexOf(' -> ')
      return i < 0 ? '' : detail.slice(i + 4)
    }
    const sceneCommitEvents = this.events.filter((e) => e.kind === 'scene' && e.detail.includes(' -> '))
    const cuts: CutBeatSample[] = sceneCommitEvents.map((e) => ({
      bar: e.bar,
      beatInBar: e.beatInBar,
      beatProgress: e.beatProgress,
    }))
    const totalBars = new Set(this.samples.map((s) => s.bar)).size
    if (cuts.length > 0) {
      const off = cutOffsetDistribution(cuts)
      L.push(
        `cut offset from nearest downbeat (beats): mean ${off.meanBeats.toFixed(2)} median ${off.medianBeats.toFixed(2)} p90 ${off.p90Beats.toFixed(2)} max ${off.maxBeats.toFixed(2)}`,
      )
      L.push(
        `beat hit score (cuts within an 8th note of any beat): ${(beatHitScore(cuts) * 100).toFixed(0)}%   ` +
          `beat coverage score (of ${totalBars} bars spanned, one landed near the downbeat): ${(beatCoverageScore(cuts, totalBars) * 100).toFixed(0)}%`,
      )
    } else {
      L.push('cut timing: no scene commits recorded')
    }
    if (this.samples.length > 0) {
      const mirrorDuty = rackDutyCycle(this.samples.map((s) => s.mirrorActive), SAMPLE_INTERVAL_SEC)
      const lensDuty = rackDutyCycle(this.samples.map((s) => s.lensActive), SAMPLE_INTERVAL_SEC)
      L.push(
        `mirror duty cycle: ${(mirrorDuty.dutyCycle * 100).toFixed(0)}%  longest on ${mirrorDuty.longestOnSec.toFixed(1)}s  longest off ${mirrorDuty.longestOffSec.toFixed(1)}s`,
      )
      L.push(
        `lens   duty cycle: ${(lensDuty.dutyCycle * 100).toFixed(0)}%  longest on ${lensDuty.longestOnSec.toFixed(1)}s  longest off ${lensDuty.longestOffSec.toFixed(1)}s`,
      )
      const sceneEntropy = normalisedEntropy(this.samples.map((s) => s.activeScene))
      const paletteEntropy = normalisedEntropy(this.samples.map((s) => s.palette))
      L.push(
        `scene entropy: ${sceneEntropy.toFixed(2)} of 1 (evenness among the scenes actually used)   ` +
          `palette entropy: ${paletteEntropy.toFixed(2)} of 1`,
      )
    }
    // Time-to-repeat: how long between one scene/palette's appearances and its
    // next, aggregated across every one that came back at all. The histogram
    // buckets in 10s bins — coarse on purpose, this is "does the show cycle
    // back inside a minute or take five", not a precise distribution.
    const histLine = (label: string, entries: { t: number; label: string }[]): string | null => {
      const s = timeToRepeat(entries)
      if (s.n === 0) return null
      const gaps = repeatGapsSec(entries)
      const buckets = histogramBuckets(gaps, 10, 6)
      const hist = buckets
        .map((c, i) => (i === buckets.length - 1 ? `${i * 10}s+:${c}` : `${i * 10}-${(i + 1) * 10}s:${c}`))
        .join(' ')
      return (
        `${label} time-to-repeat: mean ${s.meanSec.toFixed(1)}s median ${s.medianSec.toFixed(1)}s ` +
        `min ${s.minSec.toFixed(1)}s max ${s.maxSec.toFixed(1)}s (n=${s.n})  [${hist}]`
      )
    }
    const sceneEntries = sceneCommitEvents.map((e) => ({ t: e.t, label: rhsOf(e.detail) }))
    const paletteEvents = this.events.filter((e) => e.kind === 'palette')
    const paletteEntries = paletteEvents.map((e) => ({ t: e.t, label: rhsOf(e.detail) }))
    const sceneLine = histLine('scene', sceneEntries)
    if (sceneLine) L.push(sceneLine)
    const paletteLine = histLine('palette', paletteEntries)
    if (paletteLine) L.push(paletteLine)
    L.push('')

    L.push('--- audio & show ---')
    if (this.samples.length) {
      const silent = this.samples.filter((s) => s.silence).length
      const bpms = this.samples.filter((s) => !s.silence).map((s) => s.bpm)
      L.push(`silent ${((silent / this.samples.length) * 100).toFixed(0)}% of samples`)
      if (bpms.length) L.push(`bpm ${Math.min(...bpms).toFixed(0)}-${Math.max(...bpms).toFixed(0)}`)
      const moodSec = new Map<string, number>()
      for (const s of this.samples) moodSec.set(s.mood, (moodSec.get(s.mood) ?? 0) + SAMPLE_INTERVAL_SEC)
      L.push('mood: ' + [...moodSec.entries()].sort((a, b) => b[1] - a[1]).map(([m, sec]) => `${m} ${sec.toFixed(0)}s`).join('  '))
      const e = this.samples.map((s) => s.energy)
      L.push(`energy mean ${(e.reduce((a, b) => a + b, 0) / e.length).toFixed(3)} max ${Math.max(...e).toFixed(3)}`)
    }
    // Mood-read quality, because a scene switch is gated on it and a show that
    // will not move is usually a read that will not firm up (F118). The gate
    // reads `moodConfidence` and `ambiguity` — NOT `confidence` (beat-grid
    // trust), which is reported on its own line below.
    if (this.samples.length) {
      const moodConf = this.samples.map((s) => s.moodConfidence)
      const amb = this.samples.map((s) => s.ambiguity)
      const beatConf = this.samples.map((s) => s.confidence)
      const avg = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length
      const gated = this.samples.filter(
        (s) =>
          s.moodConfidence < MOOD_CHANGE_MIN_CONFIDENCE ||
          s.ambiguity > MOOD_CHANGE_MAX_AMBIGUITY,
      ).length
      L.push(
        `mood confidence mean ${avg(moodConf).toFixed(2)} min ${Math.min(...moodConf).toFixed(2)}`,
      )
      L.push(`mood ambiguity  mean ${avg(amb).toFixed(2)} max ${Math.max(...amb).toFixed(2)}`)
      L.push(
        `samples FAILING the scene-switch gate ` +
          `(moodConf<${MOOD_CHANGE_MIN_CONFIDENCE} or amb>${MOOD_CHANGE_MAX_AMBIGUITY}): ` +
          `${((gated / this.samples.length) * 100).toFixed(0)}%`,
      )
      L.push(
        `beat-grid confidence mean ${avg(beatConf).toFixed(2)} min ${Math.min(...beatConf).toFixed(2)}`,
      )
      L.push(`autoPilot on: ${this.samples[this.samples.length - 1].autoPilot}`)
    }
    // Three counts, not one. The old single figure summed commits, requests and
    // (once F163 added them) withdrawals, so "scene changes: 15" was really
    // 8 requests and 7 commits and read as fifteen cuts. Requests minus commits
    // is the churn number, and it is the one F163 exists to make visible.
    const sceneEvents = this.events.filter((ev) => ev.kind === 'scene')
    const commits = sceneEvents.filter((ev) => ev.detail.includes(' -> ')).length
    const requests = sceneEvents.filter((ev) => ev.detail.startsWith('requested ')).length
    const withdrawn = sceneEvents.filter((ev) => ev.detail.startsWith('withdrew ')).length
    L.push(`scene commits: ${commits}  requested: ${requests}  withdrawn: ${withdrawn}`)
    // Two counts, because they answer different questions (F150). The first is
    // how often the DIRECTOR changed its mind; the second is how often the
    // viewer saw a layer appear or disappear. A large gap means desires are
    // being raised and withdrawn before anything renders — churn in the
    // composition logic that costs a warm mount but is not a visible flicker.
    const layerWanted = this.events.filter((ev) => ev.kind === 'layer').length
    const layerShown = this.events.filter((ev) => ev.kind === 'layer-visible').length
    L.push(`layer changes: ${layerWanted} wanted, ${layerShown} actually shown`)
    // Desires withdrawn inside a second, per role — the shape that showed up as
    // 12 of 22 mounts in audiovis-session-2026-08-29-16-29-40.
    const shortLived: string[] = []
    const layerEvents = this.events.filter((ev) => ev.kind === 'layer')
    for (let i = 0; i < layerEvents.length; i++) {
      const a = layerEvents[i]
      const plus = a.detail.indexOf(': + ')
      if (plus < 0) continue
      const off = a.detail.slice(0, plus) + ': - ' + a.detail.slice(plus + 4)
      const b = layerEvents.find((e) => e.t >= a.t && e.t < a.t + 1 && e.detail === off)
      if (b) shortLived.push(`${a.detail.slice(plus + 4)} ${((b.t - a.t) * 1000) | 0}ms @ ${a.t.toFixed(1)}s`)
    }
    if (shortLived.length > 0) {
      L.push(`layer desires withdrawn within 1s: ${shortLived.length}  (${shortLived.join(', ')})`)
    }
    L.push(`effects fired: ${this.events.filter((ev) => ev.kind === 'effect').length}`)
    L.push('')

    // --- worst frames -----------------------------------------------------
    // Located in TIME, so they can be matched against the event list above and
    // against the contact sheet.
    // RAW frames first. The 4Hz list below cannot see a hitch — it samples one
    // frame in fifteen — and a recording proved it: p99 21.5 ms and a max of
    // 139.6 ms, while the worst thing the sampled list could find was 21.9 (F124).
    // Three frames over 100 ms in that session were invisible to the report
    // whose entire job is to find them.
    L.push('--- worst single frames (every frame, not sampled) ---')
    const worstFrames = ft
      .map((ms, i) => ({ ms, t: (i / Math.max(1, ft.length)) * dur, hidden: hidden[i] }))
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 10)
    for (const f of worstFrames) {
      // Time is approximate — reconstructed from the frame's index rather than
      // stamped, since the ring stores durations only. Good to a second or so,
      // which is all that is needed to line it up against the event list.
      const near = this.samples.reduce(
        (best, s) => (Math.abs(s.t - f.t) < Math.abs(best.t - f.t) ? s : best),
        this.samples[0],
      )
      L.push(
        `~${f.t.toFixed(1).padStart(7)}s  ${f.ms.toFixed(1).padStart(7)} ms   ` +
          `${near ? `${near.activeScene} t${near.tier} x${near.renderScale.toFixed(2)}` : ''}` +
          (f.hidden ? '  (tab hidden - not a stall)' : ''),
      )
    }
    L.push('')

    L.push('--- worst 4Hz samples (what was on screen) ---')
    for (const s of [...this.samples].sort((a, b) => b.ms - a.ms).slice(0, 12)) {
      const layers = [s.background, s.accent, s.overlay].filter(Boolean).join('+') || '-'
      L.push(
        `${s.t.toFixed(1).padStart(7)}s ms ${s.ms.toFixed(1).padStart(6)} p95 ${s.p95.toFixed(1).padStart(6)} t${s.tier} x${s.renderScale.toFixed(2)} ` +
          `${s.activeScene}/${layers} ${s.transitionActive ? `TX:${s.transitionStyle}` : ''} draws ${s.drawCalls}`,
      )
    }
    return L.join('\n')
  }
}

function round(v: number, places: number): number {
  if (!isFinite(v)) return 0
  const f = 10 ** places
  return Math.round(v * f) / f
}

export const sessionLog = new SessionLog()
