import { describe, expect, it } from 'vitest'
import STORE_SRC from '../../store.ts?raw'
import {
  advanceLimitless,
  LIMITLESS_AUTO_HOLD_CEILING_BEATS,
  LIMITLESS_AUTO_HOLD_CEILING_SEC,
  LIMITLESS_AUTO_HOLD_FLOOR_BEATS,
  LIMITLESS_GLOBAL_COOLDOWN_SEC,
  LIMITLESS_MANUAL_MAX_SEC,
  LIMITLESS_MIN_BUILD_PROGRESS,
  LIMITLESS_MIN_CONFIDENCE,
  LIMITLESS_MIN_SET_TIME_SEC,
  LIMITLESS_MIN_TENSION,
  LIMITLESS_POST_MANUAL_AUTO_SUPPRESS_SEC,
  type LimitlessCutaway,
} from '../LimitlessDirector'
import { advanceDjCam } from '../DjCamDirector'
import { useStore } from '../../store'

/**
 * Limitless-cutaway director — the pure decision core.
 *
 * Modeled directly on `djCamDirector.test.ts`, which this file's `advance`
 * helper mirrors: every gate open by default except the drop edge itself, and
 * each test opts a single rule IN by failing it. See that file's own header
 * for the fuller discipline note; not repeated here.
 *
 * The one structural difference from the DJ-cam suite: `advanceLimitless` has
 * no `ready` parameter (there is no stream that can be absent — see
 * `LimitlessDirector.tsx`'s own header) and instead takes `djCamActive`, the
 * mutual-exclusion input. Its own suite lives here; DJ Cam's symmetric
 * `otherCutawayActive` guard is covered at the bottom of this file instead of
 * duplicating the whole `djCamDirector.test.ts` suite for one new parameter.
 */

const NOW_MS = 1_000_000

const advance = (over: Partial<Parameters<typeof advanceLimitless>[0]>) =>
  advanceLimitless({
    active: null,
    now: 60, // past the 45 s warm-up
    nowMs: NOW_MS,
    bpm: 120,
    enabled: true,
    running: true,
    silence: false,
    governed: false,
    manualToggle: false,
    dropEdge: false, // nothing auto-fires unless a test asks for it
    sectionConfidence: 0.8,
    tension: 1,
    recentBuildProgress: 0.8,
    boundary: false,
    firedThisSource: false,
    lastAutoCutawayAtMs: -Infinity,
    lastManualEndedAtMs: -Infinity,
    djCamActive: false,
    ...over,
  })

describe('the LIMITLESS_* tuning constants', () => {
  it('are locked so a silent edit fails here rather than drifting the feel of the cutaway unnoticed', () => {
    expect(LIMITLESS_GLOBAL_COOLDOWN_SEC).toBe(180)
    expect(LIMITLESS_MIN_SET_TIME_SEC).toBe(45)
    expect(LIMITLESS_AUTO_HOLD_FLOOR_BEATS).toBe(32)
    expect(LIMITLESS_AUTO_HOLD_CEILING_BEATS).toBe(64)
    expect(LIMITLESS_AUTO_HOLD_CEILING_SEC).toBe(45)
    expect(LIMITLESS_MANUAL_MAX_SEC).toBe(240)
    expect(LIMITLESS_MIN_CONFIDENCE).toBe(0.6)
    expect(LIMITLESS_MIN_TENSION).toBe(0.9)
    expect(LIMITLESS_MIN_BUILD_PROGRESS).toBe(0.6)
    expect(LIMITLESS_POST_MANUAL_AUTO_SUPPRESS_SEC).toBe(60)
  })

  it('keep the beat floor below the beat ceiling, so the auto hold window is non-empty', () => {
    expect(LIMITLESS_AUTO_HOLD_FLOOR_BEATS).toBeLessThan(LIMITLESS_AUTO_HOLD_CEILING_BEATS)
  })

  it("deliberately offsets its global cooldown from DJ Cam's, so the two cutaways cannot fall into lockstep", () => {
    expect(LIMITLESS_GLOBAL_COOLDOWN_SEC).not.toBe(240)
  })
})

describe('advanceLimitless — the auto trigger', () => {
  it('fires on a high-confidence, high-tension drop that a build preceded', () => {
    const out = advance({ dropEdge: true })
    expect(out).toEqual({ since: 60, sinceMs: NOW_MS, manual: false })
  })

  it('does nothing on a frame that saw no drop edge, however high the tension', () => {
    expect(advance({})).toBeNull()
    expect(advance({ dropEdge: false, tension: 1, sectionConfidence: 1 })).toBeNull()
  })

  it('does not fire on a soft section change — the tension bar is never cleared', () => {
    expect(advance({ dropEdge: true, tension: LIMITLESS_MIN_TENSION - 0.2 })).toBeNull()
  })

  it('does not fire when the section read is not confident enough', () => {
    expect(advance({ dropEdge: true, sectionConfidence: LIMITLESS_MIN_CONFIDENCE - 0.05 })).toBeNull()
  })

  it('does not fire on a drop that no genuine build preceded', () => {
    expect(
      advance({ dropEdge: true, recentBuildProgress: LIMITLESS_MIN_BUILD_PROGRESS - 0.05 }),
    ).toBeNull()
    expect(
      advance({ dropEdge: true, recentBuildProgress: LIMITLESS_MIN_BUILD_PROGRESS }),
    ).not.toBeNull()
  })

  it('does not auto-fire while the Limitless opt-in is off', () => {
    expect(advance({ dropEdge: true, enabled: false })).toBeNull()
  })

  it('does not auto-fire inside the first LIMITLESS_MIN_SET_TIME_SEC of a source', () => {
    expect(advance({ dropEdge: true, now: LIMITLESS_MIN_SET_TIME_SEC - 1 })).toBeNull()
    expect(advance({ dropEdge: true, now: LIMITLESS_MIN_SET_TIME_SEC })).not.toBeNull()
  })

  it('respects the global cooldown, measured in wall-clock ms so it survives a track change', () => {
    const base = 5_000_000
    expect(
      advance({
        dropEdge: true,
        nowMs: base + LIMITLESS_GLOBAL_COOLDOWN_SEC * 1000 - 1000,
        lastAutoCutawayAtMs: base,
      }),
    ).toBeNull()
    expect(
      advance({
        dropEdge: true,
        nowMs: base + LIMITLESS_GLOBAL_COOLDOWN_SEC * 1000,
        lastAutoCutawayAtMs: base,
      }),
    ).not.toBeNull()
  })

  it('fires at most once per source — the per-source latch blocks the next drop', () => {
    expect(advance({ dropEdge: true, firedThisSource: true })).toBeNull()
  })

  it('stays shut while the transport is not running', () => {
    expect(advance({ dropEdge: true, running: false })).toBeNull()
  })

  it('stays shut during near-silence', () => {
    expect(advance({ dropEdge: true, silence: true })).toBeNull()
  })

  it('yields to an authored cue — no auto-fire while the show is governed', () => {
    expect(advance({ dropEdge: true, governed: true })).toBeNull()
  })

  it('suppresses an otherwise-valid auto trigger for LIMITLESS_POST_MANUAL_AUTO_SUPPRESS_SEC after a manual cutaway ends', () => {
    const ended = 8_000_000
    expect(
      advance({
        dropEdge: true,
        nowMs: ended + LIMITLESS_POST_MANUAL_AUTO_SUPPRESS_SEC * 1000 - 1000,
        lastManualEndedAtMs: ended,
      }),
    ).toBeNull()
    expect(
      advance({
        dropEdge: true,
        nowMs: ended + LIMITLESS_POST_MANUAL_AUTO_SUPPRESS_SEC * 1000,
        lastManualEndedAtMs: ended,
      }),
    ).not.toBeNull()
  })

  it('cannot auto-fire while DJ Cam owns the frame', () => {
    expect(advance({ dropEdge: true, djCamActive: true })).toBeNull()
  })
})

describe('advanceLimitless — auto cutaway hold and release', () => {
  // Entered at features.time 100 s / wall clock 2_000_000 ms. At 120 bpm one
  // beat is 0.5 s, so `beatsHeld = (now - 100) * 2`.
  const AUTO: LimitlessCutaway = { since: 100, sinceMs: 2_000_000, manual: false }

  it('holds through a boundary that lands inside the beat floor', () => {
    expect(advance({ active: AUTO, now: 110, nowMs: 2_010_000, boundary: true })).toBe(AUTO)
  })

  it('releases on the first structure boundary past the beat floor', () => {
    expect(advance({ active: AUTO, now: 118, nowMs: 2_018_000, boundary: true })).toBeNull()
  })

  it('keeps holding when no boundary has come and neither ceiling is reached', () => {
    expect(advance({ active: AUTO, now: 120, nowMs: 2_020_000, boundary: false })).toBe(AUTO)
  })

  it('releases at the beat ceiling when a boundary never arrives', () => {
    expect(advance({ active: AUTO, now: 133, nowMs: 2_033_000, boundary: false })).toBeNull()
  })

  it('releases at the wall-clock ceiling backstop even below the beat ceiling', () => {
    expect(advance({ active: AUTO, now: 120, nowMs: 2_046_000, boundary: false })).toBeNull()
  })

  it('treats a zero or garbage bpm as 120 rather than stranding on a divide-by-zero', () => {
    expect(
      advance({ active: AUTO, now: 133, nowMs: 2_033_000, bpm: 0, boundary: false }),
    ).toBeNull()
  })

  it('releases when the Limitless opt-in is switched off mid-cutaway', () => {
    expect(advance({ active: AUTO, now: 105, nowMs: 2_005_000, enabled: false })).toBeNull()
  })

  it('drops a cutaway stranded by a source restart that rewound the clock', () => {
    expect(advance({ active: AUTO, now: 0.5, nowMs: 2_000_010 })).toBeNull()
  })

  it('a manual punch-out ends a live auto cutaway at once — no floor, no boundary', () => {
    expect(advance({ active: AUTO, now: 101, nowMs: 2_000_500, manualToggle: true })).toBeNull()
  })

  it('an already-active cutaway is not retroactively killed by DJ Cam turning active — the guard is entry-only', () => {
    // The mutual-exclusion guard only refuses BEGINNING a cutaway; it can never
    // actually observe this state (DJ Cam's own symmetric guard means it can't
    // start while Limitless is active), but the hold path must not depend on
    // `djCamActive` at all — asserting that keeps the two decision cores
    // independent by construction rather than by convention.
    expect(advance({ active: AUTO, now: 105, nowMs: 2_005_000, djCamActive: true })).toBe(AUTO)
  })
})

describe('advanceLimitless — manual cutaway hold and release', () => {
  const MANUAL: LimitlessCutaway = { since: 100, sinceMs: 2_000_000, manual: true }

  it('enters on a toggle with the opt-in off and every auto guard failing', () => {
    const out = advance({
      manualToggle: true,
      enabled: false,
      running: false,
      silence: true,
      governed: true,
      firedThisSource: true,
      dropEdge: false,
      tension: 0,
      sectionConfidence: 0,
      recentBuildProgress: 0,
      now: 5, // inside the warm-up
      nowMs: 3_000_000,
      lastAutoCutawayAtMs: 3_000_000 - 1000, // deep inside the cooldown
    })
    expect(out).toEqual({ since: 5, sinceMs: 3_000_000, manual: true })
  })

  it('cannot enter, manually or otherwise, while DJ Cam owns the frame', () => {
    expect(advance({ manualToggle: true, djCamActive: true })).toBeNull()
  })

  it('exits immediately on a second toggle — no beat floor, no boundary wait', () => {
    expect(advance({ active: MANUAL, now: 100.2, nowMs: 2_000_050, manualToggle: true })).toBeNull()
  })

  it('is not released by a structure boundary, at any hold length', () => {
    expect(advance({ active: MANUAL, now: 130, nowMs: 2_030_000, boundary: true })).toBe(MANUAL)
    expect(advance({ active: MANUAL, now: 200, nowMs: 2_100_000, boundary: true })).toBe(MANUAL)
  })

  it('is not released by the opt-in going false — that toggle governs the auto trigger only', () => {
    expect(advance({ active: MANUAL, now: 130, nowMs: 2_030_000, enabled: false })).toBe(MANUAL)
  })

  it('is released by the dead-man ceiling', () => {
    const sinceMs = 2_000_000
    expect(
      advance({
        active: MANUAL,
        now: 400,
        nowMs: sinceMs + LIMITLESS_MANUAL_MAX_SEC * 1000,
        boundary: false,
      }),
    ).toBeNull()
    expect(
      advance({
        active: MANUAL,
        now: 400,
        nowMs: sinceMs + LIMITLESS_MANUAL_MAX_SEC * 1000 - 1,
        boundary: false,
      }),
    ).toBe(MANUAL)
  })

  it('drops a stranded manual cutaway when a source restart rewinds the clock', () => {
    expect(advance({ active: MANUAL, now: 1, nowMs: 2_000_010 })).toBeNull()
  })

  it('a manual entry is flagged manual, so the wrapper never stamps it as an auto cutaway', () => {
    expect(advance({ manualToggle: true })).toEqual({ since: 60, sinceMs: NOW_MS, manual: true })
  })
})

/**
 * DJ Cam's own symmetric half of the mutual-exclusion guard — `advanceDjCam`'s
 * `otherCutawayActive` parameter, added alongside this director. Kept short
 * rather than re-running the whole `djCamDirector.test.ts` suite: that file
 * owns DJ Cam's own behaviour end to end, this just pins the one new input.
 */
describe('advanceDjCam — mutual exclusion with the Limitless cutaway', () => {
  const djAdvance = (over: Partial<Parameters<typeof advanceDjCam>[0]>) =>
    advanceDjCam({
      active: null,
      now: 60,
      nowMs: NOW_MS,
      bpm: 120,
      enabled: true,
      ready: true,
      running: true,
      silence: false,
      governed: false,
      manualToggle: false,
      dropEdge: false,
      sectionConfidence: 0.8,
      tension: 1,
      recentBuildProgress: 0.8,
      boundary: false,
      firedThisSource: false,
      lastAutoCutawayAtMs: -Infinity,
      lastManualEndedAtMs: -Infinity,
      ...over,
    })

  it('defaults to false — every pre-existing call site (and the whole djCamDirector.test.ts suite) is unaffected', () => {
    expect(djAdvance({ dropEdge: true })).not.toBeNull()
    expect(djAdvance({ manualToggle: true })).not.toBeNull()
  })

  it('refuses an auto entry while the Limitless cutaway is active', () => {
    expect(djAdvance({ dropEdge: true, otherCutawayActive: true })).toBeNull()
  })

  it('refuses a manual punch while the Limitless cutaway is active', () => {
    expect(djAdvance({ manualToggle: true, otherCutawayActive: true })).toBeNull()
  })
})

/**
 * The store half of the seam — the one-shot punch channel, copied field for
 * field from `pendingDjCam` / `djCamRequestNonce`'s own test block in
 * `djCamDirector.test.ts`.
 */
describe('store — the manual Limitless punch channel', () => {
  it('starts empty, and round-trips a toggle request', () => {
    useStore.getState().clearLimitlessRequest()
    expect(useStore.getState().pendingLimitless).toBeNull()

    useStore.getState().requestLimitless()
    expect(useStore.getState().pendingLimitless).toBe('toggle')

    useStore.getState().clearLimitlessRequest()
    expect(useStore.getState().pendingLimitless).toBeNull()
  })

  it('bumps the nonce on every request, so a second identical toggle still publishes', () => {
    const s = () => useStore.getState()
    s().requestLimitless()
    const first = s().limitlessRequestNonce
    expect(s().pendingLimitless).toBe('toggle')

    s().clearLimitlessRequest()

    s().requestLimitless()
    expect(s().limitlessRequestNonce).toBeGreaterThan(first)
    s().clearLimitlessRequest()
  })

  it('is not persisted — a one-shot punch must not survive a reload', () => {
    const partialize = STORE_SRC.slice(STORE_SRC.indexOf('partialize:'))
    expect(partialize.length).toBeGreaterThan(0)
    expect(partialize).not.toContain('pendingLimitless')
    expect(partialize).not.toContain('limitlessRequestNonce')
  })

  it('persists the auto opt-in', () => {
    const partialize = STORE_SRC.slice(STORE_SRC.indexOf('partialize:'))
    expect(partialize).toContain('limitlessCutawayEnabled')
  })

  it('toggleLimitlessCutaway flips the opt-in flag', () => {
    const was = useStore.getState().limitlessCutawayEnabled
    useStore.getState().toggleLimitlessCutaway()
    expect(useStore.getState().limitlessCutawayEnabled).toBe(!was)
    useStore.getState().toggleLimitlessCutaway()
    expect(useStore.getState().limitlessCutawayEnabled).toBe(was)
  })
})
