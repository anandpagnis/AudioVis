/**
 * Scene cost benchmark: the measurement state machine.
 *
 * ## Why this exists
 *
 * `performanceCost` in the scene registry — `low` / `medium` / `high` — is
 * assigned by eye. `juliawings`, `torusfold`, `foldpath`, `synthgrid` and
 * `plasma` all carry `high`, and they are certainly not within 4× of each
 * other, so the composition budget in slotBudget.ts cannot tell them apart and
 * has been allocating against a number nobody measured.
 *
 * Every performance decision so far has been made by reading shaders and
 * counting operations. That found real things, but op-counting cannot tell you
 * how a driver schedules transcendentals or where the fill-rate wall actually
 * sits. This produces the table those decisions should have been made from.
 *
 * ## What it measures, and the one thing it must not do
 *
 * Each cell is one (scene, tier) pair, run in isolation. The **GPU** time is
 * the number that matters; CPU frame time is recorded too but is vsync-locked,
 * so every scene that holds the refresh rate looks identical on that axis (see
 * gpuTimer.ts). A run on hardware without `EXT_disjoint_timer_query_webgl2`
 * reports `gpuSupported: false`, and its CPU numbers must be read as "did it
 * keep up", never as "what did it cost".
 *
 * The state machine is pure and lives apart from the React harness so it can be
 * tested without a GPU — a benchmark that silently mismeasures is worse than no
 * benchmark, because it produces confident numbers.
 *
 * ## Phases per cell
 *
 *   warmup  — discarded. Covers shader compile, first-frame texture uploads and
 *             the governor settling. Measuring these would report compile time
 *             as scene cost, which is the single easiest way to get this wrong.
 *   measure — CPU samples counted here; GPU samples collected as they land.
 *   drain   — CPU sampling has finished but GPU queries issued during `measure`
 *             are still in flight (they resolve a few frames late). Without this
 *             the tail of every cell would be dropped, biasing fast scenes worst
 *             because they issue the most queries per second.
 */

export interface BenchCell {
  sceneId: string
  /** Quality tier index, 0 (richest) to 4 (survival). */
  tier: number
}

export interface BenchStats {
  count: number
  meanMs: number
  p95Ms: number
  maxMs: number
}

export interface BenchResult extends BenchCell {
  /**
   * Whole-frame wall clock (`delta`), which is vsync-locked when the scene keeps
   * up. Says "did it keep up", nothing more — it includes the vsync wait and any
   * back-pressure from a GPU still finishing the previous frame.
   */
  cpu: BenchStats
  /**
   * Time inside the scene's own per-frame callback.
   *
   * The column that makes `cpu` interpretable. A high `cpu` with a low `js` is a
   * scene waiting on the GPU; a high `cpu` with a high `js` is a scene doing too
   * much work on the main thread. Reading `cpu` alone as the second produced a
   * confidently wrong diagnosis (F87), which is why this exists.
   */
  js: BenchStats
  /** Null when the timer extension is unavailable or every query was disjoint. */
  gpu: BenchStats | null
}

export type BenchPhase = 'warmup' | 'measure' | 'drain' | 'done'

export interface BenchOptions {
  /** Frames discarded before measuring. Must cover a cold shader compile. */
  warmupFrames?: number
  /** CPU frames measured per cell. */
  measureFrames?: number
  /** Max frames spent waiting for in-flight GPU queries after measuring. */
  drainFrames?: number
}

const DEFAULTS: Required<BenchOptions> = {
  // ~1s at 60fps. A cold compile of the heavier raymarchers has been observed
  // in the hundreds of milliseconds, and `prewarmShaders` cannot confirm
  // completion on drivers without KHR_parallel_shader_compile.
  warmupFrames: 60,
  // ~2s. Enough that p95 picks a real tail sample (the 6th worst of 120) rather
  // than whichever frame happened to be worst out of a handful.
  measureFrames: 120,
  // Queries typically resolve within 2-3 frames; 15 is slack for a busy driver.
  drainFrames: 15,
}

function stats(samples: number[]): BenchStats {
  if (samples.length === 0) return { count: 0, meanMs: 0, p95Ms: 0, maxMs: 0 }
  let sum = 0
  let max = -Infinity
  for (const v of samples) {
    sum += v
    if (v > max) max = v
  }
  const sorted = [...samples].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(0.95 * sorted.length) - 1))
  return {
    count: samples.length,
    meanMs: sum / samples.length,
    p95Ms: sorted[idx],
    maxMs: max,
  }
}

/**
 * Build the full (scene × tier) plan.
 *
 * Ordered scene-major — every tier of one scene before moving to the next — so
 * a run can be stopped early and still yield complete rows for the scenes it
 * reached, rather than tier 0 of everything and nothing comparable.
 */
export function buildPlan(sceneIds: readonly string[], tiers: readonly number[]): BenchCell[] {
  const plan: BenchCell[] = []
  for (const sceneId of sceneIds) {
    for (const tier of tiers) plan.push({ sceneId, tier })
  }
  return plan
}

export class BenchRunner {
  private readonly opts: Required<BenchOptions>
  private index = 0
  private phase: BenchPhase
  private frames = 0
  private cpuSamples: number[] = []
  private jsSamples: number[] = []
  private gpuSamples: number[] = []
  private gpuWasSupported = false

  readonly results: BenchResult[] = []

  constructor(
    private readonly plan: readonly BenchCell[],
    options: BenchOptions = {},
  ) {
    this.opts = { ...DEFAULTS, ...options }
    this.phase = plan.length === 0 ? 'done' : 'warmup'
  }

  /** The cell being measured, or null once finished. */
  get current(): BenchCell | null {
    return this.phase === 'done' ? null : (this.plan[this.index] ?? null)
  }

  get currentPhase(): BenchPhase {
    return this.phase
  }

  get done(): boolean {
    return this.phase === 'done'
  }

  /** 0..1 across the whole plan, counting the cell in progress. */
  get progress(): number {
    if (this.plan.length === 0) return 1
    return Math.min(1, this.index / this.plan.length)
  }

  /**
   * Advance one frame.
   *
   * `cpuMs` is this frame's wall time. `gpuMs` is whatever the timer resolved
   * this frame — possibly several samples, possibly none, and not necessarily
   * corresponding to this frame. `gpuSupported` is passed per call rather than
   * held as state so a run started before the extension was probed still
   * records the truth.
   */
  frame(cpuMs: number, jsMs: number, gpuMs: readonly number[], gpuSupported: boolean): void {
    if (this.phase === 'done') return
    if (gpuSupported) this.gpuWasSupported = true
    this.frames++

    switch (this.phase) {
      case 'warmup':
        // GPU results arriving now belong to warmup frames — a cold compile is
        // exactly what must not be counted, so they are dropped on the floor.
        if (this.frames >= this.opts.warmupFrames) this.enter('measure')
        return

      case 'measure':
        this.cpuSamples.push(cpuMs)
        this.jsSamples.push(jsMs)
        for (const g of gpuMs) this.gpuSamples.push(g)
        if (this.frames >= this.opts.measureFrames) {
          // Nothing to wait for without the extension — skip the drain rather
          // than spending 15 frames per cell collecting nothing.
          if (this.gpuWasSupported) this.enter('drain')
          else this.finishCell()
        }
        return

      case 'drain':
        // CPU sampling is over; only late GPU results are still wanted.
        //
        // Runs the full drain rather than stopping at the first empty frame: a
        // query issued in the last measured frame needs a few frames to resolve,
        // so an empty frame early in the drain means "not ready yet", not "queue
        // empty". At 15 frames this costs ~0.25s per cell against ~3s of work.
        for (const g of gpuMs) this.gpuSamples.push(g)
        if (this.frames >= this.opts.drainFrames) this.finishCell()
        return
    }
  }

  /** Abandon the run, keeping completed cells. */
  stop(): void {
    this.phase = 'done'
  }

  private enter(phase: BenchPhase): void {
    this.phase = phase
    this.frames = 0
  }

  private finishCell(): void {
    const cell = this.plan[this.index]
    this.results.push({
      ...cell,
      cpu: stats(this.cpuSamples),
      js: stats(this.jsSamples),
      // A supported extension that returned nothing usable (every query
      // disjoint) is reported as null, same as no extension — in both cases
      // there is no GPU number, and inventing one from an empty set would be
      // worse than admitting it.
      gpu: this.gpuWasSupported && this.gpuSamples.length > 0 ? stats(this.gpuSamples) : null,
    })
    this.cpuSamples = []
    this.jsSamples = []
    this.gpuSamples = []
    this.index++
    this.enter(this.index >= this.plan.length ? 'done' : 'warmup')
  }
}

/** Results as a markdown table, for pasting into an issue or the handoff doc. */
export function formatResults(results: readonly BenchResult[]): string {
  const head =
    '| scene | tier | GPU mean | GPU p95 | GPU max | JS mean | JS p95 | CPU mean | CPU p95 | frames |\n' +
    '|---|---|---|---|---|---|---|---|---|---|'
  const rows = results.map((r) => {
    const g = r.gpu
    const gpu = g
      ? `${g.meanMs.toFixed(2)} | ${g.p95Ms.toFixed(2)} | ${g.maxMs.toFixed(2)}`
      : 'n/a | n/a | n/a'
    return (
      `| ${r.sceneId} | ${r.tier} | ${gpu} | ${r.js.meanMs.toFixed(2)} | ${r.js.p95Ms.toFixed(2)}` +
      ` | ${r.cpu.meanMs.toFixed(2)} | ${r.cpu.p95Ms.toFixed(2)} | ${r.cpu.count} |`
    )
  })
  return [head, ...rows].join('\n')
}
