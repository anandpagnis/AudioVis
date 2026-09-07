import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { audioEngine } from '../audio/AudioEngine'
import type { AudioFeatures, MoodState } from '../audio/types'
import { cueState } from './CueTimeline'
import { performanceState } from './performanceState'
import { djCamSource } from './djCamSource'
import { getPrimaryScenesForMood, pickVariedScene, SCENES } from '../scenes'
import { useStore } from '../store'

/**
 * The WRITER side of `performanceState.djCam`: a rare broadcast-style cutaway
 * from the synthetic show to a live camera of the DJ, held through a high
 * point of the set and eased back to a real scene afterwards.
 *
 * Same shape as `FilterDirector` — a pure exported `advanceDjCam(opts)` that
 * takes plain arguments and returns the next cutaway state (`DjCamCutaway` or
 * `null`), plus a thin `DjCamDirector()` `useFrame` wrapper that reads the
 * singletons, applies the result and owns the release choreography.
 *
 * ## Two entry paths, one decision core
 *
 * AUTO fires on a genuine "very special moment" — a confident, high-tension
 * drop that a real build led into — and is heavily rate-limited so it reads as
 * an event and not a fixture: a wall-clock global cooldown, one cutaway per
 * source, and a warm-up before it can fire at all. It holds for at least a
 * phrase ({@link DJCAM_AUTO_HOLD_FLOOR_BEATS}) and then releases on the next
 * song-structure boundary — floored so a boundary right on the drop can't
 * bounce it straight back, and ceilinged (beats AND wall clock) so a missed
 * boundary can't strand the show on the camera.
 *
 * MANUAL is the Console "Cut to DJ Cam" punch. It bypasses every auto guard —
 * the operator asked explicitly — enters if idle and exits if live, waits for
 * no boundary, and ends only on another punch, a stream drop, or a dead-man
 * ceiling. It does NOT stamp the auto cooldown, and it opens a short window
 * after it ends during which the auto trigger stays down so the two can't
 * stack.
 *
 * ## Enter hard, leave soft
 *
 * The plan's `dipToBlack` on both edges is not available — that style is in the
 * engine's `DISABLED_STYLES` and coerces to `dissolve` at the commit site, and
 * a dissolve ghosts the opaque letterboxed feed. So:
 *
 *  - ENTER is a hard cut (`requestScene('djcam', { immediate: true })`) — the
 *    right edit on a drop anyway, and ghost-free because it never overlaps.
 *  - LEAVE is scene-owned: `performanceState.djCam.releasing` goes true,
 *    `DjCamScene` ramps its own output to black over
 *    {@link DJCAM_EXIT_FADE_SEC}, and the return scene is requested
 *    NON-immediate so it commits on a downbeat and dissolves up from that
 *    black — smooth, and ghost-free because the whole feed is black by the time
 *    the dissolve is visible. The auto hold floor is a full phrase precisely so
 *    the current subject has cleared `MIN_SUBJECT_DWELL_BEATS` and that
 *    non-immediate request is accepted; a manual punch-out has no such
 *    guarantee, so it falls back to an immediate cut from the (already black)
 *    feed.
 *
 * ## Fail-closed
 *
 * `djCamSource.ready` is the one hard requirement of BOTH paths. A dropped
 * camera ends any cutaway immediately — no graceful fade, the feed is frozen —
 * and no new one can begin without a live feed. `djCamEnabled` going false ends
 * an AUTO cutaway (that toggle governs the auto trigger) but not a live MANUAL
 * punch, which the operator ends themselves.
 *
 * ## Suppression
 *
 * While `performanceState.djCam.active` (which stays true through the release
 * fade), the other decide-band directors stand down: `AutoPilot` and
 * `PerformanceDirector` early-return beside their `cueState.governed` check, and
 * `EffectDirector` / `FilterDirector` OR it into their `suppressed` expression
 * so an already-live effect/filter finishes its fade rather than snapping —
 * only the START of a new one is blocked. `PerformanceStateBridge` holds the
 * layer-tenancy desires null so nothing composites over the DJ's face, and
 * `ExposureSampler` freezes the auto-exposure servo so a bright room can't pull
 * the whole show down for the length of the cutaway.
 *
 * ## Mount priority: -87
 *
 * After `CueTimeline` (-88), so `cueState.governed` is current, and BEFORE
 * `EffectDirector` (-86) / `PerformanceDirector` (-85) / `FilterDirector` (-84),
 * so `djCam.active` is set before their suppression guards read it on the
 * entering frame — no one-frame leak of a punctuation effect over the feed. It
 * reads `performanceState.visualTension` (published by the bridge at -95) and
 * raw `audioEngine.features` (updated by SceneManager at -100), so it races
 * nothing it needs. `AutoPilot` (-90) still runs unsuppressed on the single
 * entering frame; its scene pick is overwritten by the `djcam` request the same
 * frame and a one-frame palette change is invisible against the hard cut.
 */

/* ---- Tuning ---------------------------------------------------------------
 *
 * Locked with the user (2026-09-05). Exported so `djCamDirector.test.ts` pins
 * the values — a silent edit to any one of them changes the feel of the
 * cutaway and should fail a test, not drift unnoticed.
 */

/** Wall-clock floor between AUTO cutaways. Tracked with `performance.now()`,
 *  NOT `features.time`, so it survives a track change — a fresh source rewinds
 *  the engine clock but the "once every few tracks" cadence must not. */
export const DJCAM_GLOBAL_COOLDOWN_SEC = 240
/** No AUTO cutaway in the first stretch of a source — a set needs to be
 *  underway before the director punches to the stage. Read off the engine
 *  clock, which the wrapper rewinds to ~0 on every new source. */
export const DJCAM_MIN_SET_TIME_SEC = 45
/** An AUTO cutaway holds at least this many beats before a structure boundary
 *  may release it — one phrase. Also the reason the smooth (non-immediate)
 *  return works: by here the `djcam` subject has cleared
 *  `MIN_SUBJECT_DWELL_BEATS` (32), so `requestScene` accepts a beat-locked
 *  return. */
export const DJCAM_AUTO_HOLD_FLOOR_BEATS = 32
/** An AUTO cutaway is force-released after this many beats even with no
 *  boundary — a missed boundary can't leave the show on the camera. */
export const DJCAM_AUTO_HOLD_CEILING_BEATS = 64
/** Wall-clock backstop for the same, in case the beat grid stalls. */
export const DJCAM_AUTO_HOLD_CEILING_SEC = 45
/** Dead-man ceiling for a MANUAL cutaway — its only automatic release. Raise
 *  toward `Infinity` while iterating on the grade shader. */
export const DJCAM_MANUAL_MAX_SEC = 240
/** AUTO gate: `songSection.sectionConfidence` must clear this — a touch above
 *  the bridge's `SECTION_BOUNDARY_MIN_CONFIDENCE` (0.5) so a soft section
 *  change doesn't qualify. */
export const DJCAM_MIN_CONFIDENCE = 0.6
/** AUTO gate: `performanceState.visualTension` must clear this — the drop's
 *  `+0.5` spike lands a real drop near 1.0, a soft change stays well under. */
export const DJCAM_MIN_TENSION = 0.9
/** AUTO gate: the build leading in must have reached at least this
 *  `songSection.buildProgress` — a cutaway with no run-up is not the moment. */
export const DJCAM_MIN_BUILD_PROGRESS = 0.6
/** After a MANUAL cutaway ends (any way), the AUTO trigger stays down this
 *  long so the two don't stack. Wall clock. */
export const DJCAM_POST_MANUAL_AUTO_SUPPRESS_SEC = 60
/** How long `DjCamScene` spends fading itself to black on the way out, before
 *  the return scene's dissolve takes over. Short — a dip, not a wipe. */
export const DJCAM_EXIT_FADE_SEC = 0.6

/** Hard stop for the release choreography: if the return scene has still not
 *  committed this long after the fade began (a stalled downbeat at a slow
 *  tempo, a warm that never finishes), force an immediate cut. Long enough for
 *  a ~1-bar downbeat wait at 90 bpm plus the dissolve. Wall-clock ms. */
const RELEASE_HARD_STOP_MS = 4000

/** How long a build's peak `buildProgress` stays "recent" after the section
 *  stops reading as a build — long enough to bridge a stray beat of `section` /
 *  silence labelling between a riser and the drop, short enough that a build
 *  from an earlier part of the track does not still count. Internal to
 *  `DjCamEdges`, not a user-facing tuning knob. */
const DJCAM_BUILD_GRACE_SEC = 6

/* ---- The pure decision core --------------------------------------------- */

/**
 * One live cutaway. Narrower than the wrapper's own bookkeeping — this is what
 * `advanceDjCam` returns and what `performanceState.djCam` mirrors.
 */
export interface DjCamCutaway {
  /** `features.time` at entry — the beat-floor / boundary-hold clock, and what
   *  `performanceState.djCam.since` carries. */
  since: number
  /** `performance.now()` at entry — the wall-clock ceiling / dead-man clock. */
  sinceMs: number
  /** Manual punch vs autonomous trigger — selects the hold rule. */
  manual: boolean
}

/**
 * Decide the next cutaway state from plain arguments — pure and exported for
 * tests, the same shape as `advanceFilter`: a fail-closed check, the manual
 * short-circuit, then hold/release, then the auto entry evaluation. A hold
 * returns the IDENTICAL `active` object (callers and tests compare by
 * reference); an enter returns a fresh one; anything else returns `null`.
 */
export function advanceDjCam(opts: {
  active: DjCamCutaway | null
  /** `features.time`, engine seconds. */
  now: number
  /** `performance.now()`, wall-clock ms. */
  nowMs: number
  /** `features.bpm`; `<= 0` or non-finite is treated as 120. */
  bpm: number
  /** `store.djCamEnabled` — governs the AUTO trigger only. */
  enabled: boolean
  /** `djCamSource.ready` — the one hard requirement of both paths. */
  ready: boolean
  /** `store.status === 'running'`. */
  running: boolean
  silence: boolean
  /** `cueState.governed`. */
  governed: boolean
  /** `store.pendingDjCam === 'toggle'` this frame, already consumed by the caller. */
  manualToggle: boolean
  /** Rising edge of `songSection.isDrop` this frame (from `DjCamEdges`). */
  dropEdge: boolean
  /** `songSection.sectionConfidence`. */
  sectionConfidence: number
  /** `performanceState.visualTension`. */
  tension: number
  /** Peak `songSection.buildProgress` seen in the recent pre-drop window
   *  (from `DjCamEdges`). */
  recentBuildProgress: number
  /** `sectionChange || (structureValid && songSection.boundaryChanged)`. */
  boundary: boolean
  /** This source has already had its one AUTO cutaway. */
  firedThisSource: boolean
  /** `performance.now()` of the last AUTO entry, `-Infinity` if never. */
  lastAutoCutawayAtMs: number
  /** `performance.now()` the last MANUAL cutaway ended, `-Infinity` if never. */
  lastManualEndedAtMs: number
}): DjCamCutaway | null {
  const {
    active,
    now,
    nowMs,
    bpm,
    enabled,
    ready,
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
  } = opts

  // Hold or release a live cutaway.
  if (active) {
    // Fail-closed first: a stream loss can never be out-voted by a trigger on
    // the same frame.
    if (!ready) return null
    // A punch ends ANY live cutaway at once — no floor, no boundary wait.
    if (manualToggle) return null
    // Stranded by a source restart that rewound the clock (`since` in the
    // future) — the same failure the filter director's retire pass guards.
    if (now < active.since || nowMs < active.sinceMs) return null

    if (!active.manual) {
      // `djCamEnabled` going false ends an AUTO cutaway.
      if (!enabled) return null
      const bpmEff = bpm > 0 && Number.isFinite(bpm) ? bpm : 120
      const beatsHeld = ((now - active.since) * bpmEff) / 60
      const wallHeldSec = (nowMs - active.sinceMs) / 1000
      if (boundary && beatsHeld >= DJCAM_AUTO_HOLD_FLOOR_BEATS) return null
      if (beatsHeld >= DJCAM_AUTO_HOLD_CEILING_BEATS) return null
      if (wallHeldSec >= DJCAM_AUTO_HOLD_CEILING_SEC) return null
      return active
    }

    // Manual: only the dead-man ceiling releases it automatically. A boundary
    // never does.
    if ((nowMs - active.sinceMs) / 1000 >= DJCAM_MANUAL_MAX_SEC) return null
    return active
  }

  // Nothing live: the manual punch wins ahead of every auto guard.
  if (manualToggle) {
    return ready ? { since: now, sinceMs: nowMs, manual: true } : null
  }

  // The AUTO gate.
  if (!enabled || !ready || !running || silence || governed) return null
  if ((nowMs - lastManualEndedAtMs) / 1000 < DJCAM_POST_MANUAL_AUTO_SUPPRESS_SEC) return null
  if (firedThisSource) return null
  if ((nowMs - lastAutoCutawayAtMs) / 1000 < DJCAM_GLOBAL_COOLDOWN_SEC) return null
  if (now < DJCAM_MIN_SET_TIME_SEC) return null
  if (!dropEdge) return null
  if (sectionConfidence < DJCAM_MIN_CONFIDENCE) return null
  if (tension < DJCAM_MIN_TENSION) return null
  if (recentBuildProgress < DJCAM_MIN_BUILD_PROGRESS) return null

  return { since: now, sinceMs: nowMs, manual: false }
}

/**
 * Rising-edge + build-progress tracking for the AUTO path.
 *
 * `update` must be called exactly once per frame, BEFORE the suppression gate:
 * a drop edge or a qualifying build that lands during an authored cue (or a
 * manual hold) has to be observed then, or it fires the instant automation
 * resumes — the discipline `TriggerEdges` keeps in `EffectDirector`.
 */
export class DjCamEdges {
  private prevDrop = false
  /** Highest `buildProgress` seen in the build currently in progress. */
  private peakBuild = 0
  /** `features.time` of the last frame still reading as a build — the grace
   *  clock for {@link DJCAM_BUILD_GRACE_SEC}. */
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

    // Spend the stored build only once it is well clear of BOTH a live build and
    // a drop window. A hard reset on the first neither-frame drops a genuine
    // build across a 1-2 beat gap in the section labels right before the drop —
    // and that gap is exactly where a real riser resolves.
    if (!building && !isDrop && f.time - this.lastBuildAt > DJCAM_BUILD_GRACE_SEC) {
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

function enterCutaway(next: DjCamCutaway): void {
  const s = useStore.getState()
  const p = performanceState
  // Hard-cut in, exactly as a drop scene switch does — no downbeat wait. The
  // request only fails on a registration bug (`djcam` must be
  // `roles: ['primary']`); the flag is set regardless so the suppression, the
  // layer-clear and the exposure freeze engage and the ceiling cleans up.
  s.requestScene('djcam', { auto: true, immediate: true })
  // Mutated in place, not reassigned — the no-allocation posture `p.filter.id`
  // and `p.mirror.*` keep.
  p.djCam.active = true
  p.djCam.since = next.since
  p.djCam.manual = next.manual
  p.djCam.releasing = false
}

/** The scene to dip back to — the same pick `PerformanceDirector` would make
 *  for this mood. `djcam` is never in the pool (`moods: []`). Falls back to the
 *  roster's guaranteed primary (`SCENES[0]`, `wireframe`) rather than `null`:
 *  `silence` has no mood pool, and a cutaway that entered on `groove` can wind
 *  down to silence before it exits — the show must not strand on the (black)
 *  feed. */
function pickReturnScene(mood: MoodState, currentId: string, recentIds: readonly string[]): string {
  const candidates = getPrimaryScenesForMood(mood).filter((sc) => sc.id !== currentId)
  const pick = pickVariedScene(candidates, mood, recentIds)?.id
  if (pick) return pick
  const fallback = SCENES.find((sc) => sc.id !== currentId && sc.metadata.roles.includes('primary'))
  return fallback?.id ?? SCENES[0].id
}

/* ---- The thin frame wrapper ----------------------------------------- */

export function DjCamDirector() {
  const edges = useRef(new DjCamEdges())
  const active = useRef<DjCamCutaway | null>(null)
  /** Non-null while the outgoing cutaway is fading itself to black and the
   *  return scene has been requested but not yet committed. `manual` carries
   *  whether the cutaway being released was a manual one, for the rewind path
   *  that tears it down without going back through the EXIT branch. */
  const releasing = useRef<{ startMs: number; back: string; manual: boolean } | null>(null)
  const lastSeenTime = useRef(0)
  /** `djCamRequestNonce` of the last punch this director acted on. The control
   *  window never clears its own `pendingDjCam` (only the output's copy is
   *  cleared here), and `snapshotLook` re-ships the WHOLE look on any unrelated
   *  change — so a stale `'toggle'` gets rebroadcast repeatedly. It carries the
   *  same nonce as the punch already handled; a genuine new punch bumps it.
   *  (The filter channel skips this because `FILTER_COOLDOWN_SEC` swallows a
   *  re-consume; a spurious cam toggle has no such backstop.) */
  const lastPunchNonce = useRef(-1)
  /** One AUTO cutaway per source — reset on a clock rewind, like AutoPilot's
   *  own per-source refs. The wall-clock cooldown below is deliberately NOT
   *  reset: it is what makes the cadence span tracks. */
  const firedThisSource = useRef(false)
  const lastAutoCutawayAtMs = useRef(-Infinity)
  const lastManualEndedAtMs = useRef(-Infinity)

  useFrame(() => {
    const f = audioEngine.features
    const s = useStore.getState()
    const p = performanceState
    const nowMs = performance.now()

    // A new source rewinds the engine clock to ~0 — the same rewind test
    // AutoPilot.tsx uses for `lastPaletteAt` / `lastAutoTriggerAt`.
    if (f.time < lastSeenTime.current) {
      firedThisSource.current = false
      edges.current.reset()
      if (releasing.current || active.current) {
        // A manual cutaway torn down by the source change still opens the
        // post-manual auto-suppress window — "ends (any way)". A manual RELEASE
        // already stamped it when the fade began, so only the still-`active`
        // case needs it here.
        if (active.current?.manual) lastManualEndedAtMs.current = nowMs
        p.djCam.active = false
        p.djCam.since = 0
        p.djCam.manual = false
        p.djCam.releasing = false
        releasing.current = null
        active.current = null
      }
    }
    lastSeenTime.current = f.time

    // Observed every frame, before any gate.
    const { dropEdge, recentBuildProgress } = edges.current.update(f)

    // Read the punch. The nonce guard rejects a stale `'toggle'` that the
    // control window keeps rebroadcasting (see `lastPunchNonce`). Clearing is
    // still unconditional whenever the field is non-null — an unconsumed request
    // re-fires forever, FilterDirector's reasoning for `pendingFilterId`.
    const freshPunch = s.pendingDjCam === 'toggle' && s.djCamRequestNonce !== lastPunchNonce.current
    if (s.pendingDjCam !== null) {
      lastPunchNonce.current = s.djCamRequestNonce
      s.clearDjCamRequest()
    }

    // --- Release choreography in progress: hold the flags, wait for the
    //     return scene to commit (or the fade + a hard stop), then clear. ---
    if (releasing.current) {
      const rel = releasing.current
      // Operator re-punched mid-fade — abort the return and hold the cam as a
      // fresh manual cutaway. Only catchable while `djcam` is still the
      // committed subject: once the return has committed it is an ordinary idle
      // re-punch and enters clean on the next frame.
      if (freshPunch && djCamSource.ready && s.sceneId === 'djcam') {
        useStore.setState({ pendingSceneId: null, pendingImmediate: false })
        releasing.current = null
        active.current = { since: f.time, sinceMs: nowMs, manual: true }
        p.djCam.active = true
        p.djCam.since = f.time
        p.djCam.manual = true
        p.djCam.releasing = false
        return
      }
      p.djCam.active = true
      p.djCam.releasing = true
      const elapsedMs = nowMs - rel.startMs
      // Fully off screen: the return scene committed AND its crossfade against
      // `djcam` has finished (`transition.active` drops when the outgoing
      // primary is pruned). Holding the flags through the whole dissolve keeps
      // `DjCamScene`'s own `exitEnv` at 0 until it unmounts — releasing them
      // early would let the fading-out feed brighten back up mid-dissolve.
      const gone = s.sceneId !== 'djcam' && !p.transition.active
      const streamGone = !djCamSource.ready
      if (gone || streamGone || elapsedMs >= RELEASE_HARD_STOP_MS) {
        // Still on `djcam` (a stalled downbeat, or the non-immediate request was
        // refused): force it now — dwell-exempt, and a cut from the black feed.
        if (s.sceneId === 'djcam') s.requestScene(rel.back, { auto: true, immediate: true })
        p.djCam.active = false
        p.djCam.since = 0
        p.djCam.manual = false
        p.djCam.releasing = false
        releasing.current = null
        active.current = null
      }
      return
    }

    const next = advanceDjCam({
      active: active.current,
      now: f.time,
      nowMs,
      bpm: f.bpm,
      enabled: s.djCamEnabled,
      ready: djCamSource.ready,
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
      // EXIT decision.
      if (prev.manual) lastManualEndedAtMs.current = nowMs
      const back = pickReturnScene(f.mood.state, s.sceneId, s.recentSceneIds)

      if (!djCamSource.ready) {
        // Fail-closed: the feed is frozen or gone — no graceful fade, just cut.
        p.djCam.active = false
        p.djCam.since = 0
        p.djCam.manual = false
        p.djCam.releasing = false
        s.requestScene(back, { auto: true, immediate: true })
        active.current = null
      } else {
        // Graceful: `DjCamScene` reads `releasing` and fades itself to black
        // over DJCAM_EXIT_FADE_SEC; the return scene is requested NON-immediate
        // so it commits on a downbeat and dissolves up from that black. An auto
        // cutaway has held a full phrase, so the dwell floor is satisfied and
        // the request is accepted; a short manual hold falls back to a cut from
        // the (already black) feed.
        p.djCam.releasing = true // p.djCam.active / .since / .manual stay set through the fade
        p.transitionStyle = 'dissolve'
        if (!s.requestScene(back, { auto: true })) {
          s.requestScene(back, { auto: true, immediate: true })
        }
        releasing.current = { startMs: nowMs, back, manual: prev.manual }
        active.current = null
      }
    } else {
      // Hold (next === prev) or idle (both null).
      active.current = next
    }
  }, -87) // after CueTimeline (-88), before EffectDirector (-86); see header

  return null
}
