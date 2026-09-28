/**
 * GAP -> SNAP-BACK DROP: the classic "breakdown, then the bass comes back" event, read from the raw-dB low band of the
 * per-beat cells (`rawTap.ts`), independently of the engine's `f.drop` heuristics.
 *
 * ## The mechanism (music in general, not one song)
 * A drop is the RETURN of the low end after a stretch without it. So the detector is a small state machine on the
 * low band (mean of the sub and bass dB, absolute, so a volume knob moves the reference with it):
 *
 *   in     the low band is within `returnDb` of its reference;
 *   out    it fell `lowDb` or more below the reference (the reference is the median of the trailing `refCells` cells,
 *          FROZEN while out, so a long breakdown cannot drag its own comparison point down: the same idea as
 *          `structure/dropStateMachine.ts`, which works on the front end's normalised bands at 60 Hz);
 *   fire   the first cell back within `returnDb` of the frozen reference, provided the dropout lasted at least
 *          `minCells` consecutive cells AND `minSec` seconds and at most `maxSec`; that cell is the drop. A PARTIAL return
 *          (the bass back but the sub still out) stays `out`: the drop is when the low end is whole again.
 *
 * Digital silence counts as out (its dB is far below anything), so "a bar of silence, then everything back" fires.
 *
 * ## What it must NOT fire on (the false-drop cluster of a pumping / sidechained passage)
 * Sidechain pumping and bass-line rests dip the low band by 10-20 dB for one or two beats, again and again. Those dips
 * are shorter than a bar (`minCells`, `minSec`), so they never qualify, and after a fire the detector is quiet for
 * `refractorySec`. A breakdown of at least a bar is what a producer means by one.
 *
 * ## Strength and confidence
 * Both grow with the length of the gap, the only evidence there is: a bar-long hush is a small event (the director
 * treats it like a change), a 4-8 bar breakdown is the classic drop. `strength = 0.6 + 0.4 * min(1, gapSec / fullSec)`;
 * `confidence = 0.5 + 0.3 * min(1, (gapSec - minSec) / fullSec) + 0.2 * min(1, extraDepthDb / 15)`.
 *
 * Pure, allocation-free after construction (a fixed ring of the recent low-band values; the median sorts a scratch copy).
 */

export interface GapDropConfig {
  /** Out: the low band this many dB under the reference (10 dB is the classic "half as loud" step; 6 dB, half the amplitude, is back). */
  lowDb: number
  /** Back: within this many dB of the reference. */
  returnDb: number
  /** Minimum dropout: consecutive cells and seconds (both). */
  minCells: number
  minSec: number
  /** A dropout longer than this is a quiet section, not a breakdown before a drop: forget it. */
  maxSec: number
  /** The reference: median of the trailing `refCells` in-cells; nothing fires before `warmCells` cells are known. */
  refCells: number
  warmCells: number
  /** After a fire, no new dropout counts for this long (seconds). */
  refractorySec: number
  /** Gap length (seconds) at which strength and the length part of the confidence saturate. */
  fullSec: number
}

export const DEFAULT_GAP_DROP: Readonly<GapDropConfig> = Object.freeze({
  lowDb: 10,
  returnDb: 6,
  minCells: 4,
  minSec: 1.75,
  maxSec: 30,
  refCells: 48,
  warmCells: 24,
  refractorySec: 6,
  fullSec: 8,
})

export interface GapDropFire {
  /** Time / index of the last out cell (the boundary: the return began right after it) and of the return cell (the detection). */
  boundaryTime: number
  boundaryBeat: number
  detectedTime: number
  detectedBeat: number
  gapSec: number
  gapCells: number
  /** Mean depth of the dropout below the reference (dB, positive). */
  depthDb: number
  strength: number
  confidence: number
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)

export class GapDropDetector {
  readonly cfg: GapDropConfig
  private readonly ring: Float64Array
  private readonly scratch: Float64Array
  private head = 0
  private n = 0
  private out = false
  private outCells = 0
  private outDepthSum = 0
  private outStartTime = 0
  private lastOutTime = 0
  private lastOutBeat = 0
  private ref = 0
  /** A too-long dropout was given up: wait for a cell back in range before a new one can start. */
  private waitIn = false
  private lastFireTime = Number.NEGATIVE_INFINITY
  private fire: GapDropFire = {
    boundaryTime: 0,
    boundaryBeat: 0,
    detectedTime: 0,
    detectedBeat: 0,
    gapSec: 0,
    gapCells: 0,
    depthDb: 0,
    strength: 0,
    confidence: 0,
  }

  constructor(cfg: Partial<GapDropConfig> = {}) {
    this.cfg = { ...DEFAULT_GAP_DROP, ...cfg }
    this.ring = new Float64Array(this.cfg.refCells)
    this.scratch = new Float64Array(this.cfg.refCells)
  }

  reset(): void {
    this.head = 0
    this.n = 0
    this.out = false
    this.outCells = 0
    this.outDepthSum = 0
    this.waitIn = false
    this.lastFireTime = Number.NEGATIVE_INFINITY
  }

  private median(): number {
    const k = this.n
    for (let i = 0; i < k; i++) this.scratch[i] = this.ring[i]
    for (let i = k; i < this.scratch.length; i++) this.scratch[i] = Number.POSITIVE_INFINITY
    this.scratch.sort()
    return k & 1 ? this.scratch[k >> 1] : 0.5 * (this.scratch[(k >> 1) - 1] + this.scratch[k >> 1])
  }

  private remember(low: number): void {
    this.ring[this.head] = low
    this.head = (this.head + 1) % this.ring.length
    if (this.n < this.ring.length) this.n++
  }

  /**
   * Feed one cell: the low band in dB (`0.5 * (sub + bass)`, floored, silence included), its audio time and beat.
   * Returns the drop this cell completes (ONE reused object: copy what you keep) or null.
   */
  push(lowDb: number, time: number, beat: number): GapDropFire | null {
    const c = this.cfg
    if (!Number.isFinite(lowDb) || !Number.isFinite(time)) return null
    if (!this.out) {
      if (this.n < c.warmCells) {
        this.remember(lowDb)
        return null
      }
      const ref = this.median()
      if (lowDb <= ref - c.lowDb && !this.waitIn && time - this.lastFireTime >= c.refractorySec) {
        this.out = true
        this.outCells = 1
        this.outDepthSum = ref - lowDb
        this.outStartTime = time
        this.lastOutTime = time
        this.lastOutBeat = beat
        this.ref = ref
        return null
      }
      if (lowDb > ref - c.lowDb) this.waitIn = false
      // the quiet cells stay out of the reference only while a dropout is being tracked; here they belong to the recent past
      this.remember(lowDb)
      return null
    }
    // out
    if (lowDb <= this.ref - c.returnDb) {
      this.outCells++
      this.outDepthSum += Math.max(0, this.ref - lowDb)
      this.lastOutTime = time
      this.lastOutBeat = beat
      if (time - this.outStartTime > c.maxSec) {
        // a quiet passage, not a breakdown before a drop
        this.out = false
        this.waitIn = true
      }
      return null
    }
    // back within returnDb of the reference
    this.out = false
    const gapSec = time - this.outStartTime
    const cells = this.outCells
    const depth = this.outDepthSum / Math.max(1, cells)
    this.remember(lowDb)
    if (cells < c.minCells || gapSec < c.minSec || gapSec > c.maxSec) return null
    this.lastFireTime = time
    const f = this.fire
    f.boundaryTime = this.lastOutTime
    f.boundaryBeat = this.lastOutBeat
    f.detectedTime = time
    f.detectedBeat = beat
    f.gapSec = gapSec
    f.gapCells = cells
    f.depthDb = depth
    f.strength = 0.6 + 0.4 * clamp01(gapSec / c.fullSec)
    f.confidence = clamp01(0.5 + 0.3 * clamp01((gapSec - c.minSec) / c.fullSec) + 0.2 * clamp01((depth - c.lowDb) / 15))
    return f
  }
}
