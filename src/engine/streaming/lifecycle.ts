/**
 * Explicit scene lifecycle state machine.
 *
 * Before this, a scene's state existed only implicitly, encoded as an
 * `Entry.dir: 1 | -1 | 0` field in `SceneManager.tsx` — three values doing
 * the work of what is really seven distinct states (unloaded, fetching its
 * JS chunk, warming its shader, warmed-but-never-shown, on screen, demoted-
 * but-kept-resident, tearing down). That collapse is what made "only one
 * scene can warm at a time" the only representable shape: there was nowhere
 * to put a second one.
 *
 * This machine makes every state real and enforces the one hard rule by
 * construction: a scene can never jump straight from UNLOADED to ACTIVE. It
 * has zero framework/GL imports — pure, Vitest-testable without a browser.
 */

export type SceneLifecycleStatus =
  | 'UNLOADED'
  | 'LOADING'
  | 'PREWARMING'
  | 'READY'
  | 'ACTIVE'
  | 'BACKGROUND'
  | 'UNLOADING'

/**
 * Legal transitions. `READY` and `BACKGROUND` are peers, not sequential:
 * `READY` means warmed but never yet shown; `BACKGROUND` means it WAS
 * `ACTIVE`, got demoted, and is being kept resident because the budget
 * ledger allows it. `BACKGROUND → ACTIVE` skips `LOADING`/`PREWARMING`
 * entirely — that's the entire payoff of keeping a demoted scene resident: a
 * ping-pong back to it is instant, its shader is already warm.
 */
const TRANSITIONS: Record<SceneLifecycleStatus, SceneLifecycleStatus[]> = {
  UNLOADED: ['LOADING'],
  LOADING: ['PREWARMING', 'UNLOADING'], // UNLOADING = cancelled mid-fetch
  PREWARMING: ['READY', 'UNLOADING'], // cancelled mid-compile
  READY: ['ACTIVE', 'UNLOADING'], // evicted by the budget ledger before ever shown
  ACTIVE: ['BACKGROUND', 'UNLOADING'],
  BACKGROUND: ['ACTIVE', 'UNLOADING'], // re-promoted, or evicted while dormant
  UNLOADING: ['UNLOADED'],
}

export function canTransition(from: SceneLifecycleStatus, to: SceneLifecycleStatus): boolean {
  return TRANSITIONS[from].includes(to)
}

/** True for any status where the scene is holding GPU resources. */
export function isResident(status: SceneLifecycleStatus): boolean {
  return status === 'PREWARMING' || status === 'READY' || status === 'ACTIVE' || status === 'BACKGROUND'
}

/** True for READY/BACKGROUND specifically — resident but not on screen, and
 *  therefore the only statuses the budget ledger may evict. */
export function isEvictable(status: SceneLifecycleStatus): boolean {
  return status === 'READY' || status === 'BACKGROUND'
}

export class SceneLifecycle {
  private _status: SceneLifecycleStatus = 'UNLOADED'

  get status(): SceneLifecycleStatus {
    return this._status
  }

  /** Attempts the transition. Returns false and leaves state unchanged if illegal. */
  transition(to: SceneLifecycleStatus): boolean {
    if (!canTransition(this._status, to)) return false
    this._status = to
    return true
  }
}
