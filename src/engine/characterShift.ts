import type { CharacterMood, CharacterState } from '../audio/characterTypes'

/**
 * Floor, in seconds, between two automatic scene requests when the trigger is a
 * shift in the music's CHARACTER. The classifier already holds its primary mood
 * through hysteresis and dwell, so a shift is rare; this floor only stops a
 * shift landing right behind a mood-change or stale-timer request from
 * re-rolling the scene twice in quick succession.
 */
export const CHARACTER_SHIFT_MIN_GAP_SEC = 12

/**
 * A scene-switch trigger for "the music's character moved", e.g. a serene
 * passage turning tense, which the 7-state mood often does not register: it only
 * sees intensity, so a change that keeps the loudness the same never flips it
 * and the show sat on the old look until the 25 s stale timer.
 *
 * Two calls per frame, deliberately split. `observe` runs before AutoPilot's
 * early returns (manual hold, DJ-cam cutaway, silence...) so a shift that lands
 * while automation is suppressed is latched rather than lost, the same reason
 * the key tracker and the drop edge are read up there. `take` runs only where a
 * scene request is actually allowed.
 */
export class CharacterShiftTrigger {
  private last: CharacterMood | null = null
  private pending = false

  /** Track the committed primary mood; latch a change between two real reads. */
  observe(cs: CharacterState): void {
    if (!cs.valid || cs.primary === null) {
      // Warm-up, silence or a new source: nothing to compare against.
      this.last = null
      this.pending = false
      return
    }
    if (this.last !== null && cs.primary !== this.last) this.pending = true
    this.last = cs.primary
  }

  /** True once per latched shift, when at least the minimum gap has passed since the last request. */
  take(now: number, lastTriggerAt: number): boolean {
    if (!this.pending || now - lastTriggerAt < CHARACTER_SHIFT_MIN_GAP_SEC) return false
    this.pending = false
    return true
  }

  /** Another trigger already requested a scene for this moment, so the shift has been answered. */
  consume(): void {
    this.pending = false
  }

  reset(): void {
    this.last = null
    this.pending = false
  }
}
