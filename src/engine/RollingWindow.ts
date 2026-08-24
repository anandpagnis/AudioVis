/**
 * A time-windowed sample buffer: push (t, v) pairs, and anything older than
 * `windowSec` (relative to the most recent push) is pruned automatically.
 * Backs the live analytics panel's sparklines and percentile readouts — the one
 * shared version of the time-windowed-array idiom `MoodEstimator` and
 * `BpmEstimator` each already hand-roll privately.
 *
 * ## Why this is a ring buffer over two Float64Arrays
 *
 * This runs once per metric per frame, forever, on the same thread as the
 * render loop. The obvious implementation — an array of `{t, v}` objects, with
 * `splice` to drop expired entries — costs three things per frame, none of which
 * look like anything when read line by line:
 *
 * 1. **An allocation per push.** `samples.push({ t, v })` mints a fresh object
 *    every time. Five metrics at 60 fps is ~300 short-lived objects a second.
 *    They are all garbage almost immediately, and the collector eventually has
 *    to stop and sweep them. A GC pause in the middle of a render loop is
 *    precisely what a viewer sees as a stutter.
 * 2. **An O(n) memmove per prune.** `splice(0, i)` shifts every surviving
 *    element down to close the gap. On a 30 s window at 60 fps that is up to
 *    1,800 elements moved, every frame.
 * 3. **A full copy-and-sort per `percentile()` call.** The old version built a
 *    new array and sorted it on every single call.
 *
 * None of these is individually slow. Together they are a steady tax paid in
 * exactly the currency this project cares most about — frame-time *variance*,
 * not average throughput.
 *
 * The fix is to stop allocating at all. Two fixed-size `Float64Array`s hold
 * timestamps and values as raw numbers, and a `start` index plus a `size` count
 * describe which slots are live. Pushing writes into the next slot and wraps
 * around at the end (that wrap is what makes it a *ring*); pruning just advances
 * `start`, which moves one integer rather than 1,800 elements. Nothing is
 * allocated after construction, so there is nothing for the collector to sweep.
 *
 * `percentile()` additionally reuses one scratch buffer and memoizes its sort,
 * so calling it several times between pushes sorts once — and sorts a typed
 * array, which needs no comparator function and no boxing.
 */

/**
 * Slots allocated up front, from the window length at an assumed 60 fps.
 *
 * A guess, not a limit: {@link RollingWindow.push} grows the ring when it fills
 * while samples are still inside the window, so a 144 Hz display simply doubles
 * once early on and then stays put. Sizing for the common case just avoids
 * paying for that.
 */
const ASSUMED_HZ = 60

/** Never grow past this many slots — see the growth guard in `push`. */
const MAX_CAPACITY = 1 << 16

export class RollingWindow {
  private times: Float64Array
  private vals: Float64Array
  /** Index of the OLDEST live sample. Advancing this is how pruning works. */
  private start = 0
  /** Live sample count. Live slots are `start … start + size` (mod capacity). */
  private size = 0
  private capacity: number

  /** Reused by `percentile()`; never handed out. Grown alongside the ring. */
  private scratch: Float64Array
  /** Is `scratch` a valid sorted view of the current samples? */
  private sorted = false

  constructor(private windowSec: number) {
    this.capacity = Math.max(64, Math.ceil(windowSec * ASSUMED_HZ))
    this.times = new Float64Array(this.capacity)
    this.vals = new Float64Array(this.capacity)
    this.scratch = new Float64Array(this.capacity)
  }

  push(t: number, v: number): void {
    if (this.size === this.capacity) {
      if (this.capacity < MAX_CAPACITY) {
        this.grow()
      } else {
        // Pathological input — samples arriving faster than the window can
        // retire them, e.g. a caller pushing with a clock that never advances.
        // Drop the oldest rather than growing without bound; a slightly short
        // window is a far better failure than exhausting memory.
        this.start = (this.start + 1) % this.capacity
        this.size--
      }
    }
    const i = (this.start + this.size) % this.capacity
    this.times[i] = t
    this.vals[i] = v
    this.size++
    this.sorted = false
    this.prune(t)
  }

  /**
   * Drop samples older than the window. O(number dropped), not O(size) — the
   * whole point of the ring: this moves one index, where `splice(0, i)` moved
   * every surviving element.
   */
  private prune(now: number): void {
    while (this.size > 0 && now - this.times[this.start] > this.windowSec) {
      this.start = (this.start + 1) % this.capacity
      this.size--
      this.sorted = false
    }
  }

  /** Double the ring, re-laying the samples out from index 0. */
  private grow(): void {
    const capacity = Math.min(MAX_CAPACITY, this.capacity * 2)
    const times = new Float64Array(capacity)
    const vals = new Float64Array(capacity)
    for (let i = 0; i < this.size; i++) {
      const src = (this.start + i) % this.capacity
      times[i] = this.times[src]
      vals[i] = this.vals[src]
    }
    this.times = times
    this.vals = vals
    this.scratch = new Float64Array(capacity)
    this.capacity = capacity
    this.start = 0
    this.sorted = false
  }

  clear(): void {
    this.start = 0
    this.size = 0
    this.sorted = false
  }

  count(): number {
    return this.size
  }

  /**
   * Timestamp of the `i`th-oldest live sample, 0-based. No bounds check — call
   * sites iterate `0 … count()`.
   *
   * This and {@link valueAt} replace the old `values(): readonly {t,v}[]`.
   * Materialising that array would have meant allocating one object per sample
   * on every call, which is the exact cost this class now exists to avoid —
   * and the sparkline caller reads it once per frame while the panel is open.
   */
  timeAt(i: number): number {
    return this.times[(this.start + i) % this.capacity]
  }

  /** Value of the `i`th-oldest live sample, 0-based. See {@link timeAt}. */
  valueAt(i: number): number {
    return this.vals[(this.start + i) % this.capacity]
  }

  mean(): number {
    if (this.size === 0) return 0
    let sum = 0
    for (let i = 0; i < this.size; i++) sum += this.vals[(this.start + i) % this.capacity]
    return sum / this.size
  }

  stdev(): number {
    if (this.size === 0) return 0
    const m = this.mean()
    let sq = 0
    for (let i = 0; i < this.size; i++) {
      const d = this.vals[(this.start + i) % this.capacity] - m
      sq += d * d
    }
    return Math.sqrt(sq / this.size)
  }

  min(): number {
    if (this.size === 0) return 0
    let v = Infinity
    for (let i = 0; i < this.size; i++) {
      const x = this.vals[(this.start + i) % this.capacity]
      if (x < v) v = x
    }
    return v
  }

  max(): number {
    if (this.size === 0) return 0
    let v = -Infinity
    for (let i = 0; i < this.size; i++) {
      const x = this.vals[(this.start + i) % this.capacity]
      if (x > v) v = x
    }
    return v
  }

  /**
   * Nearest-rank percentile, p in 0..1.
   *
   * Sorts into the reusable scratch buffer and memoizes: repeated calls between
   * pushes cost one array read each. `TypedArray.prototype.sort` is numeric by
   * default, so this needs no comparator closure and no boxing — both of which
   * the old `samples.map(...).sort((a, b) => a - b)` paid on every call.
   */
  percentile(p: number): number {
    if (this.size === 0) return 0
    if (!this.sorted) {
      for (let i = 0; i < this.size; i++) {
        this.scratch[i] = this.vals[(this.start + i) % this.capacity]
      }
      // Sort only the live prefix; stale slots past `size` are ignored.
      this.scratch.subarray(0, this.size).sort()
      this.sorted = true
    }
    const idx = Math.min(this.size - 1, Math.max(0, Math.ceil(p * this.size) - 1))
    return this.scratch[idx]
  }
}
