/**
 * Pure decision logic behind GPU timer queries (c11b).
 *
 * `EXT_disjoint_timer_query_webgl2` measures actual GPU execution time for
 * whatever draw calls fall between a `beginQuery`/`endQuery` pair — a
 * genuinely different signal from the wall-clock `delta` the quality
 * governor has used until now (see PerfMonitor.tsx). Wall-clock time is a
 * frame's TOTAL cost: GPU work, JS, driver dispatch overhead, vsync wait,
 * compositor stalls, all folded into one number. GPU time isolates just the
 * first of those, which is what the governor's own complexity knobs
 * (raymarch steps, particle counts, render scale) can actually shrink — a
 * frame that is slow for a CPU/driver reason will not get faster no matter
 * how far those knobs are turned down, and today's governor has no way to
 * tell the two apart.
 *
 * This module owns only the arithmetic and bookkeeping that do not touch
 * WebGL — `gpuTimer.ts` owns the actual extension calls (createQuery,
 * beginQuery, endQuery, getQueryParameter), following this codebase's usual
 * split between a tested pure layer and an untested GL-touching executor
 * (see e.g. bloomParams.ts / PerformanceStateBridge.tsx for the same shape).
 *
 * `perf.gpuMs`/`perf.gpuTimerAvailable` (PerfMonitor.tsx) expose the result
 * as read-only telemetry — DebugPanel and the session log's summary both
 * gain a real GPU-time column where today there is none. Deliberately NOT
 * wired into `quality.ts`'s tier decision in this pass: that controller has
 * been tuned through a long history of oscillation incidents (F111, F116,
 * F157, F162, among others) against wall-clock time specifically, and
 * changing what it reacts to is a real behavioural change to a sensitive,
 * carefully-tuned system that cannot be verified without a live GPU and a
 * playing track — see docs/09_Rendering_Engine.md before attempting it.
 * What this pass adds is the MEASUREMENT the governor is currently missing;
 * teaching it to act on that measurement is deliberately left as follow-up
 * work, not silently skipped.
 */

/**
 * How many in-flight queries to keep before the oldest unread one is
 * dropped.
 *
 * A query's result typically lands 1-3 frames after `end()` — GPU work is
 * asynchronous by construction, so there is no such thing as "this frame's"
 * result becoming available same-frame. Deeper than a handful of frames of
 * backlog means readback has fallen behind (a very heavy frame, a driver
 * that resolves queries lazily), and holding on to more stale queries only
 * delays how current the next number is without buying accuracy.
 */
export const MAX_PENDING_QUERIES = 4

/** Nanoseconds -> milliseconds — the unit every other perf number here is already in. */
export function nsToMs(ns: number): number {
  return ns / 1e6
}

/**
 * What a completed query's raw readback means, in milliseconds — or `null`
 * if the result cannot be trusted.
 *
 * A disjoint event (`GPU_DISJOINT_EXT`) means the GPU clock was interrupted
 * mid-measurement — a display modeset, a thermal-throttle transition, a
 * driver reset — and invalidates whatever query straddled it, per the
 * extension's own spec. Discarded rather than trusted: a wildly wrong
 * number (the spec allows an implementation to report anything once
 * disjoint) would mislead a reader worse than a missing sample would.
 * `elapsedNs` is also guarded against non-finite/negative input for the
 * same total-function discipline every other measurement path in this
 * codebase follows — a stale or zeroed query object should read as "no
 * result" rather than propagate a nonsense number.
 */
export function interpretQueryResult(elapsedNs: number, disjoint: boolean): number | null {
  if (disjoint) return null
  if (!Number.isFinite(elapsedNs) || elapsedNs < 0) return null
  return nsToMs(elapsedNs)
}

/**
 * Trim `queue` to at most `max` entries, dropping from the front (the
 * oldest) and returning what was dropped so the caller can release any
 * resource each entry holds (a `WebGLQuery` object, here).
 *
 * Generic and GL-independent on purpose: the "keep a bounded FIFO, surface
 * what falls off the front" shape has nothing to do with WebGL, and testing
 * it against plain objects is what lets `gpuTimer.ts`'s actual extension
 * calls stay thin enough not to need their own test.
 */
export function trimPending<T>(queue: T[], max: number): T[] {
  const dropped: T[] = []
  while (queue.length > max) dropped.push(queue.shift() as T)
  return dropped
}
