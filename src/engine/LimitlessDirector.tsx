import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { audioEngine } from '../audio/AudioEngine'
import type { AudioFeatures } from '../audio/types'
import { cueState } from './CueTimeline'
import { performanceState } from './performanceState'
import { pickReturnScene } from './DjCamDirector'
import { useStore } from '../store'

/**
 * The WRITER side of `performanceState.limitless`: a rare directed cutaway to
 * the `limitless` photo-warp scene, held for a phrase or two and eased back to
 * a real scene afterwards — the same "special moment, not a fixture" treatment
 * `DjCamDirector` gives its own cutaway.
 *
 * ## Why `limitless` moved here
 *
 * Before this, `limitless` was an ordinary roster scene: `moods:
 * ['ambient', 'mellow', 'groove', 'building', 'peak', 'aggressive']` and a
 * `moodFit`, so AutoPilot / PerformanceDirector could pick it like any other
 * primary any time its mood scored well. That is the opposite of how a
 * user-supplied photo wants to be treated on stage — the photo is a personal,
 * occasional beat, not a background the show cycles through every few
 * minutes. Reclassifying it as a cutaway (`moods: []`, `HIDDEN_PICKER_IDS`,
 * only ever entered through this director) makes it read the way DJ Cam does:
 * rare, directed, and gone again.
 *
 * ## Same shape as `DjCamDirector`, one fewer moving part
 *
 * `advanceLimitless(opts)` is a pure exported function taking plain arguments
 * and returning the next cutaway state (`LimitlessCutaway` or `null`), mirrored
 * by a thin `LimitlessDirector()` `useFrame` wrapper that reads the singletons,
 * applies the result and owns the release choreography — literally the same
 * split `advanceDjCam` / `DjCamDirector` use.
 *
 * The one real difference: DJ Cam's whole design pivots on `djCamSource.ready`
 * — a live camera stream that can be absent, warming up, or dropped mid-show,
 * and every guard is fail-closed against that. `limitless` has no such
 * dependency. `LimitlessScene` always has something to paint: the user's own
 * photo, or (see `limitlessPhoto.ts` / `Console.tsx`'s `PhotoDrop`) its own
 * generated placeholder when no photo has been set. So there is no `ready`
 * parameter here at all, and no fail-closed exit path — the cutaway can always
 * begin, and the only way it ends early is the same mutual-exclusion guard
 * that also gates its entry.
 *
 * ## Two entry paths, one decision core
 *
 * AUTO fires on the same shape of "genuine big moment" DJ Cam looks for — a
 * confident, high-tension drop a real build led into — rate-limited by a wall
 * -clock cooldown, one cutaway per source, and a warm-up before it can fire at
 * all. It holds for at least a phrase ({@link LIMITLESS_AUTO_HOLD_FLOOR_BEATS})
 * and releases on the next structure boundary, floored and ceilinged (beats
 * AND wall clock) for the identical reasons `DjCamDirector`'s own doc gives.
 *
 * MANUAL is the Console "Cut to Limitless" punch: bypasses every auto guard,
 * enters if idle and exits if live, ends only on another punch, a re-punch
 * mid-fade, or a dead-man ceiling.
 *
 * ## Enter hard, leave soft — but softer than DJ Cam
 *
 * ENTER is a hard cut (`requestScene('limitless', { immediate: true })`), the
 * same "a drop is a hard cut anyway" reasoning DJ Cam uses.
 *
 * LEAVE does NOT need DJ Cam's scene-owned fade-to-black. That mechanism exists
 * there because a live human face crossfading into an abstract scene reads as
 * a bad double-exposure ghost — an aesthetic problem `DjCamScene`'s own header
 * documents, not a technical one. `limitless`'s photo-warp shader has no such
 * issue: it is an ordinary `NoBlending`, self-painting primary scene, exactly
 * like most of the roster (`kifs` / `malachite` / `snowflake` / …), and those
 * already dissolve into and out of each other correctly via the engine's
 * normal crossfade. So the release here is simply an ordinary non-immediate
 * `requestScene`, same as any other scene-to-scene transition — `active` is
 * still held true through the wait for the commit (so suppression doesn't
 * lapse mid-fade and AutoPilot doesn't snatch the pick back), but nothing needs
 * a `releasing` flag or a custom shader ramp to make the crossfade look right.
 *
 * ## Mutual exclusion with DJ Cam
 *
 * The two cutaways are exclusive: neither may BEGIN while the other is
 * `active`. `advanceLimitless` takes `djCamActive` and refuses entry outright
 * when it is true, the mirror image of `advanceDjCam`'s own
 * `otherCutawayActive` parameter. Neither wrapper needs to do anything about
 * an ALREADY-active cutaway of its own kind when the other starts, because
 * that can never happen — the guard is entry-only and symmetric.
 *
 * ## Suppression
 *
 * Identical footprint to DJ Cam's: while `performanceState.limitless.active`,
 * `AutoPilot` and `PerformanceDirector` early-return, `EffectDirector` /
 * `FilterDirector` OR it into their `suppressed` expression, `ExposureSampler`
 * freezes the auto-exposure servo, and `PerformanceStateBridge` holds the
 * layer-tenancy desires null (folded into the same `cutawayUp` check DJ Cam's
 * flag already drives there).
 *
 * ## Mount priority: -86.5
 *
 * After `DjCamDirector` (-87), so this frame's freshly-written
 * `performanceState.djCam.active` is what the mutual-exclusion guard reads —
 * not last frame's. Before `EffectDirector` (-86) / `PerformanceDirector`
 * (-85) / `FilterDirector` (-84), so `limitless.active` is set before their
 * suppression guards read it on the entering frame, matching DJ Cam's own
 * ordering rationale.
 */

/* ---- Tuning ---------------------------------------------------------------
 *
 * Modeled on DJCAM_*'s locked values (see DjCamDirector.tsx), deliberately
 * offset rather than copied outright — an identical cooldown period would let
 * the two cutaways fall into lockstep, always contending for the exact same
 * drop. Exported so `limitlessDirector.test.ts` pins them the same way
 * `djCamDirector.test.ts` pins DJCAM_*.
 */

/** Wall-clock floor between AUTO cutaways. `performance.now()`, not
 *  `features.time`, so it survives a track change. */
export const LIMITLESS_GLOBAL_COOLDOWN_SEC = 180
/** No AUTO cutaway in the first stretch of a source. */
export const LIMITLESS_MIN_SET_TIME_SEC = 45
/** An AUTO cutaway holds at least this many beats before a structure boundary
 *  may release it — one phrase, same floor DJ Cam uses and for the same
 *  reason: by here the `limitless` subject has cleared `MIN_SUBJECT_DWELL_
 *  BEATS` (32), so the non-immediate return request is accepted. */
export const LIMITLESS_AUTO_HOLD_FLOOR_BEATS = 32
/** An AUTO cutaway is force-released after this many beats even with no
 *  boundary. */
export const LIMITLESS_AUTO_HOLD_CEILING_BEATS = 64
/** Wall-clock backstop for the same, in case the beat grid stalls. */
export const LIMITLESS_AUTO_HOLD_CEILING_SEC = 45
/** Dead-man ceiling for a MANUAL cutaway — its only automatic release. */
export const LIMITLESS_MANUAL_MAX_SEC = 240
/** AUTO gate: `songSection.sectionConfidence` must clear this. */
export const LIMITLESS_MIN_CONFIDENCE = 0.6
/** AUTO gate: `performanceState.visualTension` must clear this. */
export const LIMITLESS_MIN_TENSION = 0.9
/** AUTO gate: the build leading in must have reached at least this
 *  `songSection.buildProgress`. */
export const LIMITLESS_MIN_BUILD_PROGRESS = 0.6
/** After a MANUAL cutaway ends (any way), the AUTO trigger stays down this
 *  long so the two don't stack. */
export const LIMITLESS_POST_MANUAL_AUTO_SUPPRESS_SEC = 60

/** Hard stop for the release choreography: if the return scene has still not
 *  committed this long after it was requested, force an immediate cut. Same
 *  value and reasoning as `DjCamDirector`'s own `RELEASE_HARD_STOP_MS`. */
const RELEASE_HARD_STOP_MS = 4000

/** Same grace window as `DjCamEdges`'s own `DJCAM_BUILD_GRACE_SEC` — bridges a
 *  stray beat of `section`/silence mislabeling between a riser and the drop. */
const LIMITLESS_BUILD_GRACE_SEC = 6

/* ---- The pure decision core --------------------------------------------- */

/** One live cutaway. What `advanceLimitless` returns and what
 *  `performanceState.limitless` mirrors. */
export interface LimitlessCutaway {
  /** `features.time` at entry. */
  since: number
  /** `performance.now()` at entry. */
  sinceMs: number
  /** Manual punch vs autonomous trigger — selects the hold rule. */
  manual: boolean
}

/**
 * Decide the next cutaway state from plain arguments — pure and exported for
 * tests, the same shape as `advanceDjCam`: the mutual-exclusion check, the
 * manual short-circuit, then hold/release, then the auto entry evaluation. A
 * hold returns the IDENTICAL `active` object (callers and tests compare by
 * reference); an enter returns a fresh one; anything else returns `null`.
 */
export function advanceLimitless(opts: {
  active: LimitlessCutaway | null
  /** `features.time`, engine seconds. */
  now: number
  /** `performance.now()`, wall-clock ms. */
  nowMs: number
  /** `features.bpm`; `<= 0` or non-finite is treated as 120. */
  bpm: number
  /** `store.limitlessCutawayEnabled` — governs the AUTO trigger only. */
  enabled: boolean
  /** `store.status === 'running'`. */
  running: boolean
  silence: boolean
  /** `cueState.governed`. */
  governed: boolean
  /** `store.pendingLimitless === 'toggle'` this frame, already consumed by
   *  the caller. */
  manualToggle: boolean
  /** Rising edge of `songSection.isDrop` this frame (from `LimitlessEdges`). */
  dropEdge: boolean
  /** `songSection.sectionConfidence`. */
  sectionConfidence: number
  /** `performanceState.visualTension`. */
  tension: number
  /** Peak `songSection.buildProgress` seen in the recent pre-drop window
   *  (from `LimitlessEdges`). */
  recentBuildProgress: number
  /** `sectionChange || (structureValid && songSection.boundaryChanged)`. */
  boundary: boolean
  /** This source has already had its one AUTO cutaway. */
  firedThisSource: boolean
  /** `performance.now()` of the last AUTO entry, `-Infinity` if never. */
  lastAutoCutawayAtMs: number
  /** `performance.now()` the last MANUAL cutaway ended, `-Infinity` if never. */
  lastManualEndedAtMs: number
  /** `performanceState.djCam.active` — mutually exclusive with this cutaway;
   *  see `advanceDjCam`'s symmetric `otherCutawayActive` parameter. */
  djCamActive: boolean
}): LimitlessCutaway | null {
  const {
    active,
    now,
    nowMs,
    bpm,
    enabled,
    running,
    silence,
    governed,
    manualToggle,
    dropEdge,
    sectionConfidence,
    tension,
    recentBuildProgress,
    boundary,
    firedThisSource,
    lastAutoCutawayAtMs,
    lastManualEndedAtMs,
    djCamActive,
  } = opts

  // Hold or release a live cutaway.
  if (active) {
    // Stranded by a source restart that rewound the clock (`since` in the
    // future) — the same failure DjCamDirector's own retire pass guards.
    if (now < active.since || nowMs < active.sinceMs) return null
    // A punch ends ANY live cutaway at once — no floor, no boundary wait.
    if (manualToggle) return null

    if (!active.manual) {
      // The opt-in going false ends an AUTO cutaway, same as `djCamEnabled`.
      if (!enabled) return null
      const bpmEff = bpm > 0 && Number.isFinite(bpm) ? bpm : 120
      const beatsHeld = ((now - active.since) * bpmEff) / 60
      const wallHeldSec = (nowMs - active.sinceMs) / 1000
      if (boundary && beatsHeld >= LIMITLESS_AUTO_HOLD_FLOOR_BEATS) return null
      if (beatsHeld >= LIMITLESS_AUTO_HOLD_CEILING_BEATS) return null
      if (wallHeldSec >= LIMITLESS_AUTO_HOLD_CEILING_SEC) return null
      return active
    }

    // Manual: only the dead-man ceiling releases it automatically. A boundary
    // never does.
    if ((nowMs - active.sinceMs) / 1000 >= LIMITLESS_MANUAL_MAX_SEC) return null
    return active
  }

  // Mutual exclusion with DJ Cam — only one directed takeover may begin at a
  // time. See `advanceDjCam`'s symmetric `otherCutawayActive` guard.
  if (djCamActive) return null

  // Nothing live: the manual punch wins ahead of every auto guard.
  if (manualToggle) {
    return { since: now, sinceMs: nowMs, manual: true }
  }

  // The AUTO gate.
  if (!enabled || !running || silence || governed) return null
  if ((nowMs - lastManualEndedAtMs) / 1000 < LIMITLESS_POST_MANUAL_AUTO_SUPPRESS_SEC) return null
  if (firedThisSource) return null
  if ((nowMs - lastAutoCutawayAtMs) / 1000 < LIMITLESS_GLOBAL_COOLDOWN_SEC) return null
  if (now < LIMITLESS_MIN_SET_TIME_SEC) return null
  if (!dropEdge) return null
  if (sectionConfidence < LIMITLESS_MIN_CONFIDENCE) return null
  if (tension < LIMITLESS_MIN_TENSION) return null
  if (recentBuildProgress < LIMITLESS_MIN_BUILD_PROGRESS) return null

  return { since: now, sinceMs: nowMs, manual: false }
}

/**
 * Rising-edge + build-progress tracking for the AUTO path — a straight copy of
 * `DjCamEdges`'s own logic (see that class's doc for the full reasoning on the
 * grace window), kept as its own class rather than a shared import so this
 * director owns an independent instance with no coupling to DJ Cam's.
 */
export class LimitlessEdges {
  private prevDrop = false
  private peakBuild = 0
  private lastBuildAt = -Infinity

  update(f: AudioFeatures): { dropEdge: boolean; recentBuildProgress: number } {
    const building = f.structureValid && f.songSection.isBuild
    if (building) {
      this.peakBuild = Math.max(this.peakBuild, f.songSection.buildProgress)
      this.lastBuildAt = f.time
    }

    const isDrop = f.structureValid && f.songSection.isDrop
    const dropEdge = isDrop && !this.prevDrop
    this.prevDrop = isDrop

    if (!building && !isDrop && f.time - this.lastBuildAt > LIMITLESS_BUILD_GRACE_SEC) {
      this.peakBuild = 0
    }

    return { dropEdge, recentBuildProgress: this.peakBuild }
  }

  /** New source: the engine clock rewound, so any pending edge / build is stale. */
  reset(): void {
    this.prevDrop = false
    this.peakBuild = 0
    this.lastBuildAt = -Infinity
  }
}

/* ---- Shared side effects ---------------------------------------------- */

function enterCutaway(next: LimitlessCutaway): void {
  const s = useStore.getState()
  const p = performanceState
  // Hard-cut in, exactly as DjCamDirector's own `enterCutaway` does.
  s.requestScene('limitless', { auto: true, immediate: true })
  p.limitless.active = true
  p.limitless.since = next.since
  p.limitless.manual = next.manual
}

/* ---- The thin frame wrapper ----------------------------------------- */

export function LimitlessDirector() {
  const edges = useRef(new LimitlessEdges())
  const active = useRef<LimitlessCutaway | null>(null)
  /** Non-null while the return scene has been requested but not yet committed.
   *  No shader fade to wait on here (see the module header) — this purely
   *  holds `performanceState.limitless.active` true so suppression doesn't
   *  lapse mid-crossfade. */
  const releasing = useRef<{ startMs: number; back: string; manual: boolean } | null>(null)
  const lastSeenTime = useRef(0)
  /** `limitlessRequestNonce` of the last punch this director acted on — same
   *  stale-rebroadcast guard `DjCamDirector`'s own `lastPunchNonce` documents. */
  const lastPunchNonce = useRef(-1)
  const firedThisSource = useRef(false)
  const lastAutoCutawayAtMs = useRef(-Infinity)
  const lastManualEndedAtMs = useRef(-Infinity)

  useFrame(() => {
    const f = audioEngine.features
    const s = useStore.getState()
    const p = performanceState
    const nowMs = performance.now()

    // A new source rewinds the engine clock to ~0 — same rewind test
    // DjCamDirector.tsx uses.
    if (f.time < lastSeenTime.current) {
      firedThisSource.current = false
      edges.current.reset()
      if (releasing.current || active.current) {
        if (active.current?.manual) lastManualEndedAtMs.current = nowMs
        p.limitless.active = false
        p.limitless.since = 0
        p.limitless.manual = false
        releasing.current = null
        active.current = null
      }
    }
    lastSeenTime.current = f.time

    // Observed every frame, before any gate.
    const { dropEdge, recentBuildProgress } = edges.current.update(f)

    // Read the punch. Clearing is unconditional whenever the field is
    // non-null — an unconsumed request re-fires forever otherwise, the same
    // discipline `pendingFilterId` / `pendingDjCam` follow.
    const freshPunch =
      s.pendingLimitless === 'toggle' && s.limitlessRequestNonce !== lastPunchNonce.current
    if (s.pendingLimitless !== null) {
      lastPunchNonce.current = s.limitlessRequestNonce
      s.clearLimitlessRequest()
    }

    // --- Release choreography in progress: hold the flag, wait for the
    //     return scene to commit (or a hard stop), then clear. ---
    if (releasing.current) {
      const rel = releasing.current
      // Operator re-punched mid-fade — abort the return and hold as a fresh
      // manual cutaway, mirroring DjCamDirector's own recovery branch.
      if (freshPunch && s.sceneId === 'limitless') {
        useStore.setState({ pendingSceneId: null, pendingImmediate: false })
        releasing.current = null
        active.current = { since: f.time, sinceMs: nowMs, manual: true }
        p.limitless.active = true
        p.limitless.since = f.time
        p.limitless.manual = true
        return
      }
      p.limitless.active = true
      const elapsedMs = nowMs - rel.startMs
      const gone = s.sceneId !== 'limitless' && !p.transition.active
      if (gone || elapsedMs >= RELEASE_HARD_STOP_MS) {
        if (s.sceneId === 'limitless') s.requestScene(rel.back, { auto: true, immediate: true })
        p.limitless.active = false
        p.limitless.since = 0
        p.limitless.manual = false
        releasing.current = null
        active.current = null
      }
      return
    }

    const next = advanceLimitless({
      active: active.current,
      now: f.time,
      nowMs,
      bpm: f.bpm,
      enabled: s.limitlessCutawayEnabled,
      running: s.status === 'running',
      silence: f.silence,
      governed: cueState.governed,
      manualToggle: freshPunch,
      dropEdge,
      sectionConfidence: f.songSection.sectionConfidence,
      tension: p.visualTension,
      recentBuildProgress,
      boundary: f.sectionChange || (f.structureValid && f.songSection.boundaryChanged),
      firedThisSource: firedThisSource.current,
      lastAutoCutawayAtMs: lastAutoCutawayAtMs.current,
      lastManualEndedAtMs: lastManualEndedAtMs.current,
      djCamActive: p.djCam.active,
    })

    const prev = active.current

    if (next && !prev) {
      // ENTER — stamp the auto bookkeeping only for an autonomous entry.
      if (!next.manual) {
        firedThisSource.current = true
        lastAutoCutawayAtMs.current = next.sinceMs
      }
      enterCutaway(next)
      active.current = next
    } else if (!next && prev) {
      // EXIT: an ordinary non-immediate dissolve — see the module header for
      // why `limitless` needs none of DJ Cam's scene-owned fade choreography.
      if (prev.manual) lastManualEndedAtMs.current = nowMs
      const back = pickReturnScene(f.mood.state, s.sceneId, s.recentSceneIds)
      p.transitionStyle = 'dissolve'
      if (!s.requestScene(back, { auto: true })) {
        s.requestScene(back, { auto: true, immediate: true })
      }
      releasing.current = { startMs: nowMs, back, manual: prev.manual }
      active.current = null
    } else {
      // Hold (next === prev) or idle (both null).
      active.current = next
    }
  }, -86.5) // after DjCamDirector (-87), before EffectDirector (-86); see header

  return null
}
