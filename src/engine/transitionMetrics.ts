/** One completed primary-scene transition, for the live Analytics panel. */
export interface TransitionRecord {
  fromScene: string | null
  toScene: string
  onDownbeat: boolean
  hardCut: boolean
  /** How long the request sat pending before it committed. */
  waitedSec: number
  /** Crossfade duration computed at commit time (~2 beats, clamped). */
  targetDurationSec: number
  /** Wall time from commit until the incoming entry's fade reached 1. */
  actualDurationSec: number
  frameMsDuringFade: { mean: number; p95: number; max: number }
}

const HISTORY_CAP = 50

export const transitionMetrics = {
  /** Most recent transitions, oldest first, capped at {@link HISTORY_CAP}. */
  history: [] as TransitionRecord[],
}

type PendingRecord = Omit<TransitionRecord, 'actualDurationSec' | 'frameMsDuringFade'>

interface InFlight {
  key: number
  record: PendingRecord
  startedAt: number
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
  inFlight = { key, record: rest, startedAt: nowSec, frames: [] }
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
  })
  if (transitionMetrics.history.length > HISTORY_CAP) transitionMetrics.history.shift()
  inFlight = null
}
