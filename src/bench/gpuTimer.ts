/**
 * GPU wall-time per frame, via `EXT_disjoint_timer_query_webgl2`.
 *
 * ## Why the benchmark cannot use CPU frame time
 *
 * `requestAnimationFrame` is vsync-locked, so the frame time the fps meter
 * reports is *presentation cadence*: if the GPU finishes in 3 ms the frame still
 * takes 16.7 ms. Every scene that manages to hit the refresh rate therefore
 * measures **identically**, and a benchmark built on it would report that
 * `orbs` and `juliawings` cost the same right up until the moment one of them
 * falls off a cliff. That is precisely the comparison the benchmark exists to
 * make, so it needs the one number the browser exposes that reflects actual
 * work rather than scheduling.
 *
 * Three's own timestamp-query support lives in the WebGPU backend only
 * (`WebGLTimestampQueryPool` is under `renderers/webgl-fallback`), and the
 * classic `WebGLRenderer` this project uses has none — hence this.
 *
 * ## The two things that make the API awkward
 *
 * 1. **Results are asynchronous.** A query issued this frame becomes readable a
 *    few frames later, so this keeps a small queue and hands back whatever has
 *    completed. Callers must tolerate GPU samples arriving out of step with CPU
 *    ones — {@link BenchRunner} has an explicit drain phase for exactly this.
 * 2. **Results can be thrown away.** If the driver context-switches mid-measure
 *    it raises `GPU_DISJOINT_EXT`, and every in-flight timing is then garbage.
 *    Those are discarded rather than reported, which is why a run can come back
 *    with fewer GPU samples than frames.
 *
 * Only one `TIME_ELAPSED_EXT` query may be active at a time, so this never
 * nests: `begin` is a no-op while one is open.
 */

interface TimerExt {
  TIME_ELAPSED_EXT: number
  GPU_DISJOINT_EXT: number
}

/** Queries in flight, oldest first. */
interface Pending {
  query: WebGLQuery
}

export class GpuTimer {
  private gl: WebGL2RenderingContext | null = null
  private ext: TimerExt | null = null
  private pending: Pending[] = []
  private active: WebGLQuery | null = null
  /** Queries are cheap but not free to allocate; reuse them. */
  private pool: WebGLQuery[] = []

  /** True when real GPU timings are available. False degrades to CPU-only. */
  get supported(): boolean {
    return this.ext !== null
  }

  /** How many queries are still waiting on the driver. */
  get inFlight(): number {
    return this.pending.length + (this.active ? 1 : 0)
  }

  init(gl: WebGL2RenderingContext): void {
    this.gl = gl
    // Chrome exposes this on desktop; Safari and most mobile do not. Absence is
    // a supported state, not an error — the runner reports CPU-only.
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExt | null
  }

  /** Open a timing region. No-op if unsupported or one is already open. */
  begin(): void {
    if (!this.gl || !this.ext || this.active) return
    const query = this.pool.pop() ?? this.gl.createQuery()
    if (!query) return
    this.active = query
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query)
  }

  /** Close the region opened by {@link begin} and queue it for readback. */
  end(): void {
    if (!this.gl || !this.ext || !this.active) return
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT)
    this.pending.push({ query: this.active })
    this.active = null
  }

  /**
   * Collect every timing that has become readable, in milliseconds.
   *
   * Returns an array because several can land in one frame — the queue drains
   * in bursts when the driver catches up. Empty is normal and common.
   */
  poll(): number[] {
    const gl = this.gl
    const ext = this.ext
    if (!gl || !ext || this.pending.length === 0) return []

    // A disjoint event invalidates EVERY in-flight query, not just one, so this
    // is checked once per poll rather than per query.
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT) as boolean
    const out: number[] = []
    const still: Pending[] = []

    for (const p of this.pending) {
      const available = gl.getQueryParameter(p.query, gl.QUERY_RESULT_AVAILABLE) as boolean
      if (!available) {
        still.push(p)
        continue
      }
      if (!disjoint) {
        const ns = gl.getQueryParameter(p.query, gl.QUERY_RESULT) as number
        out.push(ns / 1e6)
      }
      // Recycled whether or not the result was usable — a disjoint query is
      // still a perfectly good query object.
      this.pool.push(p.query)
    }
    this.pending = still
    return out
  }

  /** Release every GL object. Safe to call when uninitialised. */
  dispose(): void {
    const gl = this.gl
    if (!gl) return
    if (this.active) {
      // Leaving a query open would make the next beginQuery throw INVALID_OPERATION.
      if (this.ext) gl.endQuery(this.ext.TIME_ELAPSED_EXT)
      this.pool.push(this.active)
      this.active = null
    }
    for (const p of this.pending) gl.deleteQuery(p.query)
    for (const q of this.pool) gl.deleteQuery(q)
    this.pending = []
    this.pool = []
  }
}
