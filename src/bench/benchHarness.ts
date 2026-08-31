import { ProfileAccumulator, type SceneProfile } from './sceneProfile'
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
  /**
   * What the scene LOOKS like, for role eligibility.
   *
   * See bench/sceneProfile.ts and docs/10_Scene_Roles.md. Accumulated over the
   * same measured window as the timings, so a profile and a cost always
   * describe the same frames.
   */
  profile: SceneProfile
  /**
   * Internal megapixels the cell was drawn at, or null if the harness did not
   * report one (F160).
   *
   * The post chain, the feedback pass and both optical racks are fullscreen
   * passes, so their cost is per-pixel and a millisecond figure means nothing
   * without the resolution it was taken at — which is exactly the omission
   * `frameLoad.ts` spent this project's whole history carrying, and what
   * {@link FILL_REFERENCE_MP} was later invented to paper over. Recorded per
   * cell rather than per run because the cost pass re-solves the render scale
   * for every scene's own pixel budget, so two rows of the same sweep are
   * routinely at different resolutions.
   */
  internalMP: number | null
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
  private readonly profile = new ProfileAccumulator()
  private cpuSamples: number[] = []
  private jsSamples: number[] = []
  private gpuSamples: number[] = []
  private gpuWasSupported = false
  /** Last value handed to {@link setInternalMP}; recorded with the cell. */
  private internalMP: number | null = null

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

  /**
   * One frame's luminance field, for the role profile.
   *
   * Gated on the measure phase for the same reason the timings are: warmup
   * frames include a cold shader compile and, for the particle scenes, a
   * geometry buffer that has not landed yet — a scene that is not drawing what
   * it will draw would profile as something it is not.
   */
  profileFrame(luma: Float32Array, dt: number): void {
    if (this.phase !== 'measure') return
    this.profile.push(luma, dt)
  }

  /**
   * Tell the runner what resolution the current cell is being drawn at (F160).
   *
   * Called by the harness once per cell, after it has pinned the tier and
   * solved the render scale. Optional: a caller that never calls it gets
   * `internalMP: null` and the post-chain diff below refuses to run rather
   * than assuming a resolution.
   */
  setInternalMP(mp: number): void {
    this.internalMP = mp
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
      profile: this.profile.result(),
      // A supported extension that returned nothing usable (every query
      // disjoint) is reported as null, same as no extension — in both cases
      // there is no GPU number, and inventing one from an empty set would be
      // worse than admitting it.
      gpu: this.gpuWasSupported && this.gpuSamples.length > 0 ? stats(this.gpuSamples) : null,
      internalMP: this.internalMP,
    })
    this.profile.reset()
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

/** One matched (scene, tier) pair from the two passes. See {@link postChainDelta}. */
export interface PostChainCell extends BenchCell {
  internalMP: number
  /** GPU mean with the post chain mounted, in ms. */
  withMs: number
  /** GPU mean without it, in ms. */
  withoutMs: number
  /** `withMs - withoutMs`: the chain's cost at this cell's resolution. */
  deltaMs: number
  /** {@link deltaMs} normalised by resolution — the number the model wants. */
  msPerMP: number
}

export interface PostChainDelta {
  cells: PostChainCell[]
  /** Median `msPerMP` across matched cells. Median, not mean: see below. */
  medianMsPerMP: number
  /** What {@link medianMsPerMP} implies at a given reference resolution. */
  atReferenceMs: (referenceMP: number) => number
  /** Cells present in one pass but not usable in the diff, with the reason. */
  skipped: { sceneId: string; tier: number; why: string }[]
}

/**
 * Difference two bench sweeps to measure the POST CHAIN (F160, and the standing
 * request in F43 / F90).
 *
 * ## The constant this exists to replace
 *
 * `frameLoad.ts` reserves `POST_CHAIN_MS = 2` and `FEEDBACK_MS = 1` for costs
 * present in every frame, and both are openly labelled estimates — reasoned
 * from what the shaders do, never measured, because `/bench` deliberately
 * excludes the post chain so that scene costs compare cleanly. F110 later made
 * them scale with resolution through `fillScale`, which fixed their SHAPE
 * without ever establishing their magnitude.
 *
 * `audiovis-session-2026-08-30-09-47-58` is what that eventually costs. At
 * tiers 0 and 1 the reservation alone exceeded the entire tier budget — mean
 * 12.61 ms against 11.0, and 10.86 against 9.5, in 42% of the session's samples
 * — so `remainingMs` floored to zero and no layer could be admitted at the top
 * of the ladder at all (`6 wanted, 2 actually shown`). The budget model
 * contradicts itself up there, and nobody can say which half is wrong without
 * this number.
 */
/*
 * ## The method, and why it is a difference
 *
 * `EffectComposer` renders the scene into its own buffer and then runs the
 * effects over it, so no timer can bracket the chain alone — timing it always
 * includes the scene. The chain's cost is therefore the DIFFERENCE between two
 * sweeps of identical cells:
 *
 *   1. the ordinary cost pass  — `/bench`, no chain, GPU-timed around `gl.render`
 *   2. the post-chain pass     — `/bench?postchain`, chain mounted, GPU-timed
 *                                around the composer's draw
 *
 * Both pin the tier and re-solve the render scale per cell the same way, so a
 * matched pair is at the same resolution by construction — and this refuses to
 * subtract a pair whose `internalMP` disagrees rather than quietly reporting a
 * resolution difference as a post-chain cost.
 *
 * **Not the existing profile pass.** `/bench?profile` also mounts the chain,
 * which makes it look like a free second sample, and it is not one: it holds a
 * fixed DPR across every cell, it does a `getImageData` readback every frame,
 * and it does not GPU-time anything ("GPU timings are meaningless in that pass
 * and are not read"). Differencing against it would charge the post chain for a
 * canvas readback and a resolution change.
 *
 * ## Median, not mean
 *
 * Per-cell `msPerMP` should be constant — a fullscreen pass costs what it costs
 * — so the spread across cells is a measurement-quality signal, not something
 * to average away. A single cell whose scene happened to hit a driver hiccup
 * during its 120 measured frames would drag a mean; the median ignores it, and
 * the per-cell rows are returned so the spread stays visible. If those rows
 * disagree by more than a little, the answer is that the method is wrong, not
 * that the chain is variable.
 *
 * Pure, and tested without a GPU. A benchmark that silently mismeasures is
 * worse than no benchmark — the same reasoning that put {@link BenchRunner} in
 * this file rather than in the React harness.
 */
export function postChainDelta(
  withoutChain: readonly BenchResult[],
  withChain: readonly BenchResult[],
): PostChainDelta {
  const key = (r: BenchCell) => `${r.sceneId}@${r.tier}`
  const base = new Map(withoutChain.map((r) => [key(r), r]))
  const cells: PostChainCell[] = []
  const skipped: { sceneId: string; tier: number; why: string }[] = []

  for (const on of withChain) {
    const off = base.get(key(on))
    const note = (why: string) => skipped.push({ sceneId: on.sceneId, tier: on.tier, why })
    if (!off) {
      note('no matching cell in the no-chain pass')
      continue
    }
    if (!on.gpu || !off.gpu) {
      // No GPU timer means CPU numbers only, and those are vsync-locked: two
      // passes that both hold 60fps are identical on that axis whatever the
      // chain costs. Differencing them would report 0.00 ms with confidence.
      note('no GPU timing in one of the passes')
      continue
    }
    if (on.internalMP === null || off.internalMP === null) {
      note('harness did not report an internal resolution')
      continue
    }
    // 1% — well inside the 0.01 quantisation of `solveRenderScale`, and far
    // outside anything that could be a real per-cell resolution difference.
    if (Math.abs(on.internalMP - off.internalMP) > 0.01 * Math.max(on.internalMP, off.internalMP)) {
      note(`resolution mismatch: ${off.internalMP.toFixed(2)} vs ${on.internalMP.toFixed(2)} MP`)
      continue
    }
    const deltaMs = on.gpu.meanMs - off.gpu.meanMs
    cells.push({
      sceneId: on.sceneId,
      tier: on.tier,
      internalMP: on.internalMP,
      withMs: on.gpu.meanMs,
      withoutMs: off.gpu.meanMs,
      deltaMs,
      msPerMP: on.internalMP > 0 ? deltaMs / on.internalMP : 0,
    })
  }

  const sorted = cells.map((c) => c.msPerMP).sort((a, b) => a - b)
  const median =
    sorted.length === 0
      ? 0
      : sorted.length % 2 === 1
        ? sorted[(sorted.length - 1) / 2]
        : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2

  return {
    cells,
    medianMsPerMP: median,
    atReferenceMs: (referenceMP: number) => median * referenceMP,
    skipped,
  }
}

/** {@link postChainDelta} as markdown, for pasting into docs/ISSUES.md. */
export function formatPostChainDelta(d: PostChainDelta, referenceMP: number): string {
  const head =
    '| scene | tier | MP | GPU no chain | GPU with chain | delta | ms/MP |\n|---|---|---|---|---|---|---|'
  const rows = d.cells.map(
    (c) =>
      `| ${c.sceneId} | ${c.tier} | ${c.internalMP.toFixed(2)} | ${c.withoutMs.toFixed(2)}` +
      ` | ${c.withMs.toFixed(2)} | ${c.deltaMs.toFixed(2)} | ${c.msPerMP.toFixed(3)} |`,
  )
  const v = d.cells.map((c) => c.msPerMP)
  const spread =
    d.cells.length > 1
      ? `spread ${Math.min(...v).toFixed(3)} - ${Math.max(...v).toFixed(3)} ms/MP`
      : 'single cell - no spread to check'
  const out = [
    head,
    ...rows,
    '',
    `median ${d.medianMsPerMP.toFixed(3)} ms/MP over ${d.cells.length} matched cell(s); ${spread}`,
    `=> ${d.atReferenceMs(referenceMP).toFixed(2)} ms at the ${referenceMP} MP reference` +
      ` (frameLoad.FILL_REFERENCE_MP), against POST_CHAIN_MS + FEEDBACK_MS = 3 reserved today`,
  ]
  if (d.skipped.length > 0) {
    out.push('', 'skipped:')
    for (const s of d.skipped) out.push(`  ${s.sceneId}@${s.tier}: ${s.why}`)
  }
  return out.join('\n')
}
