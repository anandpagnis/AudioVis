import { audioEngine } from '../audio/AudioEngine'
import { frameLoad } from './frameLoad'
import { performanceState } from './performanceState'
import { perf } from './PerfMonitor'
import { quality } from './quality'
import { renderScale } from './renderScale'

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
  /** Show state. */
  scene: string
  activeScene: string
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
}

export type SessionEventKind =
  | 'tier'
  | 'scale'
  | 'scene'
  | 'transition-start'
  | 'transition-end'
  | 'layer'
  | 'mood'
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
    effects: 0,
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
      effects: 0,
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
    this.events.push({
      t: round(this.elapsed, 2),
      kind,
      detail,
      ms: round(perf.ms, 2),
      p95: round(perf.p95, 2),
      scene: performanceState.activeScene,
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
      scene: p.scene,
      activeScene: p.activeScene,
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

  /** Derived events, for tests and for anything that wants the timeline raw. */
  eventLog(): readonly SessionEvent[] {
    return this.events
  }

  stop(): { summary: string; json: string; sheet: HTMLCanvasElement | null } {
    this.active = false
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
    if (ft.length === 0) {
      L.push('no frames recorded')
    } else {
      const st = frameStats(ft)
      L.push(`mean ${st.mean.toFixed(1)}  p50 ${st.p50.toFixed(1)}  p95 ${st.p95.toFixed(1)}  p99 ${st.p99.toFixed(1)}  max ${st.max.toFixed(1)}`)
      L.push(`effective fps ${(1000 / st.mean).toFixed(1)}`)
      L.push(`over 16.7ms ${st.over(16.7).toFixed(1)}%   over 33.3ms ${st.over(33.3).toFixed(1)}%   over 50ms ${st.over(50).toFixed(1)}%`)
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
    L.push(`scene changes: ${this.events.filter((ev) => ev.kind === 'scene').length}`)
    L.push(`layer changes: ${this.events.filter((ev) => ev.kind === 'layer').length}`)
    L.push(`effects fired: ${this.events.filter((ev) => ev.kind === 'effect').length}`)
    L.push('')

    // --- worst frames -----------------------------------------------------
    // Located in TIME, so they can be matched against the event list above and
    // against the contact sheet.
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
