import { describe, expect, it } from 'vitest'
import { canAutoSwitch, MIN_SUBJECT_DWELL_BEATS } from '../../store'

/**
 * The rate limit on automatic scene changes.
 *
 * Nothing bounded this before: PhraseDetector permits a `sectionChange` every
 * 8 beats and PerformanceDirector recomposes on one immediately (its own
 * `PHRASE_HOLD_BEATS` guard is skipped for section changes), while AutoPilot
 * has no cooldown at all. Worse, neither director has a "hold" outcome — both
 * exclude the current scene from their candidate pool, so whenever one runs it
 * is guaranteed to switch. The result was a subject change as often as every
 * few seconds.
 */
describe('canAutoSwitch', () => {
  it('blocks a switch before the dwell has elapsed', () => {
    expect(canAutoSwitch(100, 100)).toBe(false)
    expect(canAutoSwitch(100, 100 + MIN_SUBJECT_DWELL_BEATS - 1)).toBe(false)
  })

  it('allows one once it has', () => {
    expect(canAutoSwitch(100, 100 + MIN_SUBJECT_DWELL_BEATS)).toBe(true)
    expect(canAutoSwitch(100, 500)).toBe(true)
  })

  it('allows the very first switch of a session', () => {
    // lastCommitBeat starts at -Infinity so the show is not frozen on the
    // boot scene until 32 beats have passed.
    expect(canAutoSwitch(-Infinity, 0)).toBe(true)
  })

  it('recovers when a new source rewinds the beat counter', () => {
    // A new track restarts beatIndex at 0, leaving the stamp in the future. If
    // that read as "not yet", the next track would be stuck on one scene for
    // its entire length — the failure mode is silent and total.
    expect(canAutoSwitch(9000, 3)).toBe(true)
  })

  it('is measured in beats, so pacing tracks the song', () => {
    // Two phrases — ~16s at 120 BPM, ~21s at 90.
    expect(MIN_SUBJECT_DWELL_BEATS).toBe(32)
  })
})
