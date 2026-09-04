import type { TransitionStyle } from './transitions'

/** One completed primary-scene transition, for the live Analytics panel. */
export interface TransitionRecord {
  fromScene: string | null
  toScene: string
  /**
   * Which transition style actually ran.
   *
   * Recorded because the styles are not interchangeable in cost: `dissolve` and
   * `dipToBlack` are pure mix curves, while `smear`, `melt` and `collapse` each
   * switch on a post-chain rack for the duration. Without this field the panel
   * reports a frame-time spike during a transition with no way to attribute it,
   * and "which of the six is expensive" cannot be answered from the history at
   * all. A `cut` here also distinguishes a style the director CHOSE from one the
   * budget guard imposed — see `hardCut`.
   */
  style: TransitionStyle
  onDownbeat: boolean
  hardCut: boolean
  /** How long the request sat pending before it committed. */
  waitedSec: number
  /** Crossfade duration computed at commit time (~2 beats, clamped). */
  targetDurationSec: number
  /** Wall time from commit until the incoming entry's fade reached 1. */
  actualDurationSec: number
  frameMsDuringFade: { mean: number; p95: number; max: number }
  /**
   * Wall-clock ms (`Date.now()`) at which this transition COMMITTED.
   *
   * Exists so a reader can tell a transition that just happened from one that
   * happened twenty minutes ago. The panel renders the last four records
   * forever and every director suppresses during silence, so without an age a
   * stopped show shows four rows of scene changes and reads as a running one
   * (F190). Commit time rather than completion time because that is when the
   * scene actually changed; the fade adds at most ~2 beats to it, which is
   * below the resolution this is displayed at.
   *
   * Wall clock, not the render clock `nowSec` that times the fade: the console
   * structured-clones this history into a second window (`outputLink.ts:811`),
   * and `Date.now()` is the only one of the two that means the same thing on
   * both sides of that copy.
   */
  atMs: number
}

const HISTORY_CAP = 50

export const transitionMetrics = {
  /** Most recent transitions, oldest first, capped at {@link HISTORY_CAP}. */
  history: [] as TransitionRecord[],
}

type PendingRecord = Omit<TransitionRecord, 'actualDurationSec' | 'frameMsDuringFade' | 'atMs'>

interface InFlight {
  key: number
  record: PendingRecord
  startedAt: number
  /** Wall clock at commit — see {@link TransitionRecord.atMs}. */
  atMs: number
  frames: number[]
}

let inFlight: InFlight | null = null

/**
 * Called once from SceneManager when a primary-scene transition commits.
 * `key` is the incoming entry's key — the same value passed to
 * {@link sampleTransitionFrame} each frame while that entry fades in.
 */
export function beginTransition(record: PendingRecord & { key: number }, nowSec: number): void {
  const { key, ...rest } = record
  // Stamped here rather than taken from the caller so the one call site
  // (SceneManager) needs no change and cannot forget it.
  inFlight = { key, record: rest, startedAt: nowSec, atMs: Date.now(), frames: [] }
}

/**
 * Called once per frame for the fading-in primary entry. No-ops unless `key`
 * matches the transition currently being watched (including after it has
 * already finalized). Finalizes into {@link transitionMetrics}.history once
 * `fadeValue` reaches 1.
 */
export function sampleTransitionFrame(
  key: number,
  frameMs: number,
  fadeValue: number,
  nowSec: number,
): void {
  if (!inFlight || inFlight.key !== key) return
  inFlight.frames.push(frameMs)
  if (fadeValue < 1) return

  const frames = inFlight.frames.length > 0 ? inFlight.frames : [0]
  const sorted = [...frames].sort((a, b) => a - b)
  const mean = frames.reduce((a, b) => a + b, 0) / frames.length
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)]
  const max = sorted[sorted.length - 1]

  transitionMetrics.history.push({
    ...inFlight.record,
    actualDurationSec: nowSec - inFlight.startedAt,
    frameMsDuringFade: { mean, p95, max },
    atMs: inFlight.atMs,
  })
  if (transitionMetrics.history.length > HISTORY_CAP) transitionMetrics.history.shift()
  inFlight = null
}
