import { MAX_PENDING_QUERIES, interpretQueryResult, trimPending } from './gpuTiming'

/**
 * Thin WebGL wrapper around `EXT_disjoint_timer_query_webgl2` (c11b). See
 * gpuTiming.ts for the tested decision logic this leans on; this file is the
 * untested executor, matching the split every other GL-touching pass in this
 * codebase already uses (FeedbackPass.ts, PostFXChain.tsx).
 *
 * ## Why two frame-boundary calls, not one
 *
 * A `TIME_ELAPSED_EXT` query measures every draw call issued between
 * `begin()` and `end()`, regardless of how many separate `renderer.render()`
 * calls happen in between — the scene's own draw, every post-chain pass, all
 * enqueue GPU commands into the same command stream. `PerfMonitor` calls
 * `begin()` at an extreme negative `useFrame` priority and `end()`/`poll()`
 * at an extreme positive one specifically so both land outside the known
 * range every other director/pass in this engine uses (-100..2 today) —
 * bracketing the ENTIRE frame's GPU submission regardless of how that range
 * changes in the future, rather than guessing at "late enough".
 */
export interface GpuTimer {
  /** Start timing this frame's GPU work. Call before any draw call is issued. */
  begin(): void
  /** Stop timing this frame's GPU work. Call after every draw call for the
   *  frame has been issued. */
  end(): void
  /**
   * Check the oldest still-pending query. Returns its GPU time in
   * milliseconds if ready, or `null` if nothing is ready yet (the common
   * case — see gpuTiming.ts's doc on latency) or the result was invalidated
   * by a disjoint event. Call at most once per frame; cheap either way (a
   * handful of GL parameter reads, no allocation on the common "not ready"
   * path).
   */
  poll(): number | null
  /** Release every GL query object this timer is holding. Call on unmount. */
  dispose(): void
}

/**
 * Feature-detects the extension and returns `null` if it is unavailable —
 * every caller must treat a null timer exactly like the governor already
 * treats a display too small to hold its render budget: a degraded mode
 * with no separate failure path, not an error. Requires a WebGL2 context;
 * the extension does not exist under WebGL1's own (differently-shaped)
 * `EXT_disjoint_timer_query`.
 */
export function createGpuTimer(gl: WebGL2RenderingContext): GpuTimer | null {
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2')
  if (!ext) return null

  const pending: WebGLQuery[] = []
  let openQuery: WebGLQuery | null = null

  return {
    begin() {
      // A query already open — begin() called twice without an intervening
      // end(), or a prior end() that never landed — would violate the
      // extension's "one TIME_ELAPSED_EXT query at a time" rule and throw
      // INVALID_OPERATION. Guarded rather than assumed: a caller-ordering
      // mistake here must not take the frame down with it.
      if (openQuery) return
      const query = gl.createQuery()
      if (!query) return
      openQuery = query
      gl.beginQuery(ext.TIME_ELAPSED_EXT, query)
    },
    end() {
      if (!openQuery) return
      gl.endQuery(ext.TIME_ELAPSED_EXT)
      pending.push(openQuery)
      openQuery = null
      for (const dropped of trimPending(pending, MAX_PENDING_QUERIES)) gl.deleteQuery(dropped)
    },
    poll() {
      if (pending.length === 0) return null
      const oldest = pending[0]
      if (!gl.getQueryParameter(oldest, gl.QUERY_RESULT_AVAILABLE)) return null
      pending.shift()
      // Read before delete: the result and the disjoint flag both belong to
      // the query that just completed, and `deleteQuery` invalidates it.
      const elapsedNs = gl.getQueryParameter(oldest, gl.QUERY_RESULT) as number
      const disjoint = Boolean(gl.getParameter(ext.GPU_DISJOINT_EXT))
      gl.deleteQuery(oldest)
      return interpretQueryResult(elapsedNs, disjoint)
    },
    dispose() {
      if (openQuery) gl.deleteQuery(openQuery)
      for (const query of pending) gl.deleteQuery(query)
      pending.length = 0
      openQuery = null
    },
  }
}
