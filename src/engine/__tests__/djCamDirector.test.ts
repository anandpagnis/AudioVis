import { describe, expect, it } from 'vitest'
import STORE_SRC from '../../store.ts?raw'
import {
  advanceDjCam,
  DJCAM_AUTO_HOLD_CEILING_BEATS,
  DJCAM_AUTO_HOLD_CEILING_SEC,
  DJCAM_AUTO_HOLD_FLOOR_BEATS,
  DJCAM_EXIT_FADE_SEC,
  DJCAM_GLOBAL_COOLDOWN_SEC,
  DJCAM_MANUAL_MAX_SEC,
  DJCAM_MIN_BUILD_PROGRESS,
  DJCAM_MIN_CONFIDENCE,
  DJCAM_MIN_SET_TIME_SEC,
  DJCAM_MIN_TENSION,
  DJCAM_POST_MANUAL_AUTO_SUPPRESS_SEC,
  type DjCamCutaway,
} from '../DjCamDirector'
import { useStore } from '../../store'

/**
 * DJ Cam director — the pure decision core.
 *
 * Modeled on `filterDirector.test.ts`: `advanceDjCam(opts)` is a pure function
 * driven entirely by plain arguments — no mocks, no singletons, no `audioEngine`
 * or `djCamSource` — so every rule in the plan's §10 is exercised in isolation.
 * The thin `DjCamDirector()` `useFrame` wrapper that reads the singletons, the
 * store and the exit-fade choreography is left to integration, exactly as the
 * filter suite leaves `FilterDirector()` itself.
 *
 * The discipline that makes the auto-trigger tests trustworthy: the default
 * `advance()` args describe a frame on which EVERY gate is already open except
 * the drop edge itself. Each test opts a single rule IN by failing it, so a
 * regression that drops any one guard is caught by its own named test.
 *
 * `advanceDjCam` returns the cutaway for this frame (`DjCamCutaway` or `null`),
 * mirroring `advanceFilter`'s `ActiveFilter | null`. A HOLD returns the
 * identical `active` object (tests compare with `toBe`); an ENTER returns a
 * fresh one; a release / no-op returns `null`. The wrapper compares the return
 * to the previous ref to derive entered / exited and stamps the auto cooldown /
 * per-source latch only for an auto entry — that bookkeeping is asserted here as
 * a property of the return, since a pure function has no side effects.
 */

const NOW_MS = 1_000_000

const advance = (over: Partial<Parameters<typeof advanceDjCam>[0]>) =>
  advanceDjCam({
    active: null,
    now: 60, // past the 45 s warm-up
    nowMs: NOW_MS,
    bpm: 120,
    enabled: true,
    ready: true,
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
    ...over,
  })

describe('the DJCAM_* tuning constants', () => {
  it('carry the locked defaults (2026-09-05, plus the exit-fade delta)', () => {
    // Locked with the user; pinned so a silent edit to any one of them fails
    // here rather than drifting the feel of the cutaway unnoticed.
    expect(DJCAM_GLOBAL_COOLDOWN_SEC).toBe(240)
    expect(DJCAM_MIN_SET_TIME_SEC).toBe(45)
    // Raised from the plan's 8 to a full phrase: the smooth (non-immediate)
    // return only works once the `djcam` subject has cleared
    // MIN_SUBJECT_DWELL_BEATS (32).
    expect(DJCAM_AUTO_HOLD_FLOOR_BEATS).toBe(32)
    expect(DJCAM_AUTO_HOLD_CEILING_BEATS).toBe(64)
    expect(DJCAM_AUTO_HOLD_CEILING_SEC).toBe(45)
    expect(DJCAM_MANUAL_MAX_SEC).toBe(240)
    expect(DJCAM_MIN_CONFIDENCE).toBe(0.6)
    expect(DJCAM_MIN_TENSION).toBe(0.9)
    expect(DJCAM_MIN_BUILD_PROGRESS).toBe(0.6)
    expect(DJCAM_POST_MANUAL_AUTO_SUPPRESS_SEC).toBe(60)
    expect(DJCAM_EXIT_FADE_SEC).toBe(0.6)
  })

  it('keep the beat floor below the beat ceiling, so the auto hold window is non-empty', () => {
    expect(DJCAM_AUTO_HOLD_FLOOR_BEATS).toBeLessThan(DJCAM_AUTO_HOLD_CEILING_BEATS)
  })
})

describe('advanceDjCam — the auto trigger', () => {
  it('fires on a high-confidence, high-tension drop that a build preceded', () => {
    const out = advance({ dropEdge: true })
    expect(out).toEqual({ since: 60, sinceMs: NOW_MS, manual: false })
  })

  it('does nothing on a frame that saw no drop edge, however high the tension', () => {
    expect(advance({})).toBeNull()
    expect(advance({ dropEdge: false, tension: 1, sectionConfidence: 1 })).toBeNull()
  })

  it('does not fire on a soft section change — the tension bar is never cleared', () => {
    expect(advance({ dropEdge: true, tension: DJCAM_MIN_TENSION - 0.2 })).toBeNull()
  })

  it('does not fire when the section read is not confident enough', () => {
    expect(advance({ dropEdge: true, sectionConfidence: DJCAM_MIN_CONFIDENCE - 0.05 })).toBeNull()
  })

  it('does not fire on a drop that no genuine build preceded', () => {
    expect(
      advance({ dropEdge: true, recentBuildProgress: DJCAM_MIN_BUILD_PROGRESS - 0.05 }),
    ).toBeNull()
    expect(
      advance({ dropEdge: true, recentBuildProgress: DJCAM_MIN_BUILD_PROGRESS }),
    ).not.toBeNull()
  })

  it('does not auto-fire while the DJ Cam opt-in is off', () => {
    expect(advance({ dropEdge: true, enabled: false })).toBeNull()
  })

  it('does not auto-fire inside the first DJCAM_MIN_SET_TIME_SEC of a source', () => {
    expect(advance({ dropEdge: true, now: DJCAM_MIN_SET_TIME_SEC - 1 })).toBeNull()
    expect(advance({ dropEdge: true, now: DJCAM_MIN_SET_TIME_SEC })).not.toBeNull()
  })

  it('respects the global cooldown, measured in wall-clock ms so it survives a track change', () => {
    const base = 5_000_000
    expect(
      advance({
        dropEdge: true,
        nowMs: base + DJCAM_GLOBAL_COOLDOWN_SEC * 1000 - 1000,
        lastAutoCutawayAtMs: base,
      }),
    ).toBeNull()
    expect(
      advance({
        dropEdge: true,
        nowMs: base + DJCAM_GLOBAL_COOLDOWN_SEC * 1000,
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

  it('cannot auto-fire without a live camera stream', () => {
    expect(advance({ dropEdge: true, ready: false })).toBeNull()
  })

  it('suppresses an otherwise-valid auto trigger for DJCAM_POST_MANUAL_AUTO_SUPPRESS_SEC after a manual cutaway ends', () => {
    const ended = 8_000_000
    expect(
      advance({
        dropEdge: true,
        nowMs: ended + DJCAM_POST_MANUAL_AUTO_SUPPRESS_SEC * 1000 - 1000,
        lastManualEndedAtMs: ended,
      }),
    ).toBeNull()
    expect(
      advance({
        dropEdge: true,
        nowMs: ended + DJCAM_POST_MANUAL_AUTO_SUPPRESS_SEC * 1000,
        lastManualEndedAtMs: ended,
      }),
    ).not.toBeNull()
  })
})

describe('advanceDjCam — auto cutaway hold and release', () => {
  // Entered at features.time 100 s / wall clock 2_000_000 ms. At 120 bpm one
  // beat is 0.5 s, so `beatsHeld = (now - 100) * 2`.
  const AUTO: DjCamCutaway = { since: 100, sinceMs: 2_000_000, manual: false }

  it('holds through a boundary that lands inside the beat floor', () => {
    // 20 beats after the trigger (= 10 s); the floor is 32 beats, so a boundary
    // sitting soon after the drop must not bounce the cam straight back.
    expect(advance({ active: AUTO, now: 110, nowMs: 2_010_000, boundary: true })).toBe(AUTO)
  })

  it('releases on the first structure boundary past the beat floor', () => {
    // 36 beats (= 18 s), clear of the 32-beat floor.
    expect(advance({ active: AUTO, now: 118, nowMs: 2_018_000, boundary: true })).toBeNull()
  })

  it('keeps holding when no boundary has come and neither ceiling is reached', () => {
    // 40 beats (= 20 s): past the floor, under the 64-beat / 45 s ceilings.
    expect(advance({ active: AUTO, now: 120, nowMs: 2_020_000, boundary: false })).toBe(AUTO)
  })

  it('releases at the beat ceiling when a boundary never arrives', () => {
    // 66 beats (= 33 s at 120 bpm), past the 64-beat ceiling; wall clock still
    // under DJCAM_AUTO_HOLD_CEILING_SEC, so this isolates the beat ceiling.
    expect(advance({ active: AUTO, now: 133, nowMs: 2_033_000, boundary: false })).toBeNull()
  })

  it('releases at the wall-clock ceiling backstop even below the beat ceiling', () => {
    // 40 beats of engine time (under 64) but 46 s of wall clock — past
    // DJCAM_AUTO_HOLD_CEILING_SEC. A stalled structure clock must not strand
    // the show on the camera.
    expect(advance({ active: AUTO, now: 120, nowMs: 2_046_000, boundary: false })).toBeNull()
  })

  it('treats a zero or garbage bpm as 120 rather than stranding on a divide-by-zero', () => {
    // now 133 => 66 beats at the 120 fallback, past the beat ceiling.
    expect(
      advance({ active: AUTO, now: 133, nowMs: 2_033_000, bpm: 0, boundary: false }),
    ).toBeNull()
  })

  it('releases the moment the camera stream drops, mid-hold', () => {
    expect(advance({ active: AUTO, now: 105, nowMs: 2_005_000, ready: false })).toBeNull()
  })

  it('releases when the DJ Cam opt-in is switched off mid-cutaway', () => {
    expect(advance({ active: AUTO, now: 105, nowMs: 2_005_000, enabled: false })).toBeNull()
  })

  it('drops a cutaway stranded by a source restart that rewound the clock', () => {
    expect(advance({ active: AUTO, now: 0.5, nowMs: 2_000_010 })).toBeNull()
  })

  it('a manual punch-out ends a live auto cutaway at once — no floor, no boundary', () => {
    expect(advance({ active: AUTO, now: 101, nowMs: 2_000_500, manualToggle: true })).toBeNull()
  })
})

describe('advanceDjCam — manual cutaway hold and release', () => {
  const MANUAL: DjCamCutaway = { since: 100, sinceMs: 2_000_000, manual: true }

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

  it('still requires a live camera stream — the Console button is dead without one', () => {
    expect(advance({ manualToggle: true, ready: false })).toBeNull()
  })

  it('exits immediately on a second toggle — no beat floor, no boundary wait', () => {
    expect(advance({ active: MANUAL, now: 100.2, nowMs: 2_000_050, manualToggle: true })).toBeNull()
  })

  it('is not released by a structure boundary, at any hold length', () => {
    expect(advance({ active: MANUAL, now: 130, nowMs: 2_030_000, boundary: true })).toBe(MANUAL)
    // Well past where an auto cutaway would have hit its beat ceiling.
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
        nowMs: sinceMs + DJCAM_MANUAL_MAX_SEC * 1000,
        boundary: false,
      }),
    ).toBeNull()
    expect(
      advance({
        active: MANUAL,
        now: 400,
        nowMs: sinceMs + DJCAM_MANUAL_MAX_SEC * 1000 - 1,
        boundary: false,
      }),
    ).toBe(MANUAL)
  })

  it('is released the moment the camera stream drops', () => {
    expect(advance({ active: MANUAL, now: 130, nowMs: 2_030_000, ready: false })).toBeNull()
  })

  it('drops a stranded manual cutaway when a source restart rewinds the clock', () => {
    expect(advance({ active: MANUAL, now: 1, nowMs: 2_000_010 })).toBeNull()
  })

  it('a manual entry is flagged manual, so the wrapper never stamps it as an auto cutaway', () => {
    expect(advance({ manualToggle: true })).toEqual({ since: 60, sinceMs: NOW_MS, manual: true })
  })
})

/**
 * The store half of the seam — the one-shot punch channel, copied field for
 * field from `pendingFilterId` / `filterRequestNonce`. Deliberately not a
 * component test: the contract the Console button codes against is just these
 * fields, and `DjCamDirector`'s consumption is covered by the pure suite above.
 */
describe('store — the manual DJ-cam punch channel', () => {
  it('starts empty, and round-trips a toggle request', () => {
    useStore.getState().clearDjCamRequest()
    expect(useStore.getState().pendingDjCam).toBeNull()

    useStore.getState().requestDjCam()
    expect(useStore.getState().pendingDjCam).toBe('toggle')

    useStore.getState().clearDjCamRequest()
    expect(useStore.getState().pendingDjCam).toBeNull()
  })

  it('bumps the nonce on every request, so a second identical toggle still publishes', () => {
    const s = () => useStore.getState()
    s().requestDjCam()
    const first = s().djCamRequestNonce
    expect(s().pendingDjCam).toBe('toggle')

    // The output window consumes and clears ITS copy; this window's stays put.
    s().clearDjCamRequest()

    s().requestDjCam()
    expect(s().djCamRequestNonce).toBeGreaterThan(first)
    s().clearDjCamRequest()
  })

  it('is not persisted — a one-shot punch must not survive a reload', () => {
    // Source check, matching how `filterDirector.test.ts` pins the same fact:
    // `partialize` is a literal list and absence from it is the whole assertion.
    const partialize = STORE_SRC.slice(STORE_SRC.indexOf('partialize:'))
    expect(partialize.length).toBeGreaterThan(0)
    expect(partialize).not.toContain('pendingDjCam')
    expect(partialize).not.toContain('djCamRequestNonce')
  })

  it('persists the opt-in and the chosen device, but not the scanned device list', () => {
    const partialize = STORE_SRC.slice(STORE_SRC.indexOf('partialize:'))
    expect(partialize).toContain('djCamEnabled')
    expect(partialize).toContain('djCamDeviceId')
    expect(partialize).not.toContain('djCamDevices')
  })

  it('toggleDjCam flips the opt-in flag', () => {
    const was = useStore.getState().djCamEnabled
    useStore.getState().toggleDjCam()
    expect(useStore.getState().djCamEnabled).toBe(!was)
    useStore.getState().toggleDjCam()
    expect(useStore.getState().djCamEnabled).toBe(was)
  })
})
