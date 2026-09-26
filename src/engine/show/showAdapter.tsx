import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { audioEngine } from '../../audio/AudioEngine'
import { lookOf } from '../../audio/characterLook'
import type { AudioFeatures } from '../../audio/types'
import {
  createLegacyEventState,
  stepLegacyEvents,
  type LegacyEventState,
  type LegacyInput,
} from '../../audio/events/legacyEvents'
import type { SectionEvent } from '../../audio/events/types'
import { structureLog } from '../structureLog'
import {
  getCharacterCandidates,
  getEffectScenes,
  getScene,
  pickVariedMode,
  pickVariedScene,
  type EffectTrigger,
  type SceneDef,
} from '../../scenes'
import { sceneBoost } from '../../scenes/sceneTraits'
import { useStore } from '../../store'
import { pickHypeScene } from '../AutoPilot'
import { ARM } from '../armedChange'
import { activeLook, armedRuntime, trendOf, tryCommitArmed } from '../armedDirector'
import {
  MOOD_CHANGE_MAX_AMBIGUITY,
  MOOD_CHANGE_MIN_CONFIDENCE,
  MOOD_PREDICT_MIN_CONFIDENCE,
} from '../autoPilotGates'
import { pickAndRequest } from '../buildSwitch'
import { advanceEffects } from '../EffectDirector'
import { characterPickEnabled, pickByCharacter } from '../characterPick'
import { CharacterShiftTrigger } from '../characterShift'
import { cueState } from '../CueTimeline'
import { committedMs } from '../frameLoad'
import { performanceState } from '../performanceState'
import { selectPrimaryCandidates } from '../PerformanceDirector'
import { quality } from '../quality'
import { renderScale } from '../renderScale'
import { DIRECTOR_ON, EVENTS_V2 } from './directorFlags'
import {
  ackCut,
  createShowState,
  step,
  type ShowAction,
  type ShowInput,
  type ShowState,
} from './showDirector'
import {
  LAYERS_CUT,
  LAYERS_MICRO,
  clearShowRuntime,
  showProbe,
  showRuntime,
} from './showRuntime'

/**
 * The thin `useFrame` adapter between the live app and the pure show director (`showDirector.ts`).
 *
 * Each frame it (1) clears the one-frame mailbox, (2) turns the music into `SectionEvent`s, (3) gathers the director's inputs from
 * `audioEngine.features`, the store and `performanceState`, (4) calls `step`, and (5) performs the action through the
 * machinery that already exists. It owns no policy: every number lives in `showPolicy.ts`.
 *
 *  - CUT  -> the ARMED scene when it still fits (`tryCommitArmed('show', ...)`: a release, so the shader is already
 *            compiled), else a cold pick with the same pickers the old directors used (`pickHypeScene` for a drop,
 *            otherwise `pickByCharacter` over the character candidates with the mood-label `pickVariedScene`
 *            fallback, restricted to non-heavy scenes in a breakdown) requested with `{ auto, immediate: drop,
 *            bypassDwell, reason }`. The director owns pacing, so the store's 32-beat dwell must not refuse it.
 *            SceneManager still commits on the next downbeat (`f.beat && f.beatInBar === 0`, else its 2.5 s
 *            backstop), so a CUT waits at most one bar; a drop is an immediate hard cut.
 *  - MICRO-> palette / mode: a flag in `showRuntime` that `AutoPilot` (which owns the palette and mode refs and their
 *            cadence floors) acts on this same frame; layers: a flag `PerformanceDirector` acts on; effect: the same
 *            pure `advanceEffects` the `EffectDirector` uses, fired as a `sectionChange` punctuation.
 *
 * EVENT SOURCE (`?events=v2|legacy`, `directorFlags.ts`, read once; the default is `legacy` until the acceptance gates are shown):
 *  - `legacy`: today's mapping (`legacyEvents.ts`): `f.sectionChange`, the analyser's kind-change boundaries, drops and
 *            build starts. Bit-for-bit the Phase-1 behaviour: the v2 layer is only drained (and logged).
 *  - `v2`:     the bar-synchronous live change scorer (`audioEngine.events`, `audio/events/EventLayer.ts`) supplies
 *            `change` / `fill` / `gain` / `breakdown`. The legacy mapping is still stepped every frame but only its
 *            `drop` and `buildStart` events are kept (its sectionChange- and boundary-derived `change` and `breakdown`
 *            events are dropped, and its sectionChange / non-drop boundary signals are not fed to it, so they cannot
 *            corroborate a drop either). The forced-cut / CUT alignment uses the boundary-anchored bar grid when it is
 *            confident (`EventLayer.grid.beatsToBarLine`), else `f.beatInBar`. SceneManager still commits on
 *            `f.beatInBar === 0`.
 * The v2 layer is drained EVERY frame in both modes and each event is recorded in the `?structurelog` (in legacy mode
 * flagged `shadow`), so tap logs can score v2 against the taps while the show still runs on the legacy events.
 *
 * It bails out on exactly the conditions AutoPilot / PerformanceDirector bail out on (autopilot off, not running,
 * silence, authored cues, a DJ-cam / Limitless cutaway, the 45 s manual hold), consuming edges while it does so.
 * Runs at priority -92: after the audio engine (-100), before AutoPilot (-90) and PerformanceDirector (-85).
 */

const MANUAL_HOLD_SEC = 45 // the same back-off the other directors use after the DJ touches anything
const FIRED_SECTION: EffectTrigger[] = ['sectionChange']

interface AdapterCtx {
  show: ShowState
  legacy: LegacyEventState
  legacyIn: LegacyInput
  input: ShowInput
  events: SectionEvent[]
  /** Scratch for `audioEngine.events.drain` (emptied every frame). */
  live: SectionEvent[]
  charShift: CharacterShiftTrigger
  effectFiredAt: Map<string, number>
  /** Cached `trendOf(f) === 'rising'`, refreshed on beats (it builds a small object). */
  trendRising: boolean
  modeRotation: number
  lastCommitSeen: number
  sceneStartTime: number
}

function createCtx(): AdapterCtx {
  return {
    show: createShowState(),
    legacy: createLegacyEventState(),
    legacyIn: {
      time: 0,
      beat: 0,
      bpm: 120,
      sectionChange: false,
      sectionChangeStrength: 0,
      drop: false,
      buildUp: false,
      structureValid: false,
      boundaryChanged: false,
      section: '',
      previousSection: '',
      sectionConfidence: 0,
      beatsInSection: 0,
      isSustain: false,
    },
    input: {
      beat: 0,
      time: 0,
      bpm: 120,
      sceneStartBeat: Number.NEGATIVE_INFINITY,
      sceneStartTime: Number.NEGATIVE_INFINITY,
      event: null,
      barLine: false,
      inBreakdown: false,
      inBuild: false,
      moodChanged: false,
      characterShift: false,
      moodPredicted: false,
      trendRising: false,
    },
    events: [],
    live: [],
    charShift: new CharacterShiftTrigger(),
    effectFiredAt: new Map(),
    trendRising: false,
    modeRotation: 0,
    lastCommitSeen: Number.NaN,
    sceneStartTime: Number.NEGATIVE_INFINITY,
  }
}

const notHeavy = (scene: SceneDef): boolean => scene.metadata.performanceCost !== 'high'

/** Does the scene on screen have a second mode to vary? (`pickVariedMode` returns nothing for most of the roster.) */
function hasModes(sceneId: string): boolean {
  const modes = getScene(sceneId).metadata.contract?.modes
  return modes !== undefined && modes.length >= 2
}

/** The cold pick for a CUT: the pickers AutoPilot / PerformanceDirector already use, in the same order. */
function coldPick(
  f: AudioFeatures,
  s: ReturnType<typeof useStore.getState>,
  drop: boolean,
  breakdown: boolean,
  exclude: readonly string[],
): SceneDef | null {
  const sceneLook = activeLook()
  if (drop) return pickHypeScene(f, s, sceneLook, exclude)
  const mood = f.mood.predictedState === 'silence' ? f.mood.state : f.mood.predictedState
  const okScene = (sc: SceneDef) => !exclude.includes(sc.id) && (!breakdown || notHeavy(sc))
  const voiceBoost = (scene: SceneDef) =>
    f.moodsValid && f.vocalPresence > 0.5 && scene.metadata.bands.includes('vocal') ? 1.6 : 1
  const boost = sceneLook ? (scene: SceneDef) => voiceBoost(scene) * sceneBoost(scene, sceneLook, 'auto') : voiceBoost
  return (
    pickByCharacter(getCharacterCandidates().filter(okScene), {
      character: f.character,
      key: f.key,
      now: f.time,
      recentIds: s.recentSceneIds,
      exclude,
      boost,
    }) ??
    (pickVariedScene(selectPrimaryCandidates(mood, s.sceneId).filter(okScene), mood, s.recentSceneIds, voiceBoost, {
      valence: performanceState.valence,
      arousal: performanceState.arousal,
    }) ??
      null)
  )
}

/**
 * Perform a CUT. Returns how it was done, for the overlay: `armed`, `pick`, `busy` (a request is already landing) or
 * `refused` (nothing pickable / the store declined every candidate); the director is told when it did not happen.
 */
function performCut(ctx: AdapterCtx, f: AudioFeatures, a: ShowAction): string {
  const s = useStore.getState()
  const drop = a.immediate
  // Never replace a switch that is already landing: a warming entry's compile work would be thrown away. A drop is the
  // one thing worth interrupting anything for.
  if (!drop && s.pendingSceneId !== null && s.pendingSceneId !== s.heldSceneId) {
    ackCut(ctx.show, false, f.beatIndex, f.time)
    return 'busy'
  }
  const reason = `show:${a.reason} S=${a.S.toFixed(2)} T=${a.T.toFixed(2)} age=${a.age.toFixed(1)}b P=${a.pressure.toFixed(2)}`

  // The armed scene is a pick the show already made, compiled and waiting: release it if it still fits.
  if (armedRuntime.state.armed !== null && tryCommitArmed('show', drop, f, undefined, reason)) {
    showRuntime.palette = true
    showRuntime.layers = LAYERS_CUT
    return 'armed'
  }

  const breakdown = (f.structureValid && f.songSection.isBreakdown) || a.eventType === 'breakdown'
  const sceneLook = activeLook()
  const { scene } = pickAndRequest(
    [s.sceneId],
    (exclude) => coldPick(f, s, drop, breakdown, exclude),
    (scene) => {
      const accepted = s.requestScene(scene.id, { auto: true, immediate: drop, bypassDwell: true, reason })
      if (accepted) {
        // The look is chosen with the scene, before it can mount (a scene rebuilds geometry on a mode change).
        const mode = pickVariedMode(scene.id, s.sceneModes[scene.id], ctx.modeRotation++, sceneLook)
        if (mode) s.setSceneMode(scene.id, mode, { auto: true })
      }
      return accepted
    },
  )
  if (scene === null) {
    ackCut(ctx.show, false, f.beatIndex, f.time)
    return 'refused'
  }
  showRuntime.palette = true
  showRuntime.layers = LAYERS_CUT
  return 'pick'
}

/** Perform a MICRO through the existing helpers (see the header). */
function performMicro(ctx: AdapterCtx, f: AudioFeatures, a: ShowAction): void {
  const s = useStore.getState()
  switch (a.micro) {
    case 'palette':
      showRuntime.palette = true
      break
    case 'mode':
      // Most scenes have no second mode: fall back to recomposing a layer so the MICRO is still visible.
      if (hasModes(s.sceneId)) showRuntime.mode = true
      else showRuntime.layers = LAYERS_MICRO
      break
    case 'layer':
      showRuntime.layers = LAYERS_MICRO
      break
    case 'effect': {
      const p = performanceState
      const candidates = getEffectScenes()
      if (candidates.length === 0) break
      p.layers.effects = advanceEffects({
        active: p.layers.effects,
        fired: FIRED_SECTION,
        candidates,
        now: f.time,
        budget: quality.knobs.frameBudgetMs,
        committedMs: committedMs(),
        tier: quality.tier,
        lastFiredAt: ctx.effectFiredAt,
        mood: lookOf(f.mood),
        recentIds: s.recentSceneIds,
        internalMP: renderScale.internalMP(renderScale.applied),
        currentVA: { valence: performanceState.valence, arousal: performanceState.arousal },
        look: p.look.valid && p.look.families.scene ? p.look : undefined,
      })
      break
    }
    default:
      break
  }
}

/** Copy the numbers the overlay prints (no allocation). */
function publish(ctx: AdapterCtx, a: ShowAction | null): void {
  const st = ctx.show
  showProbe.age = st.age
  showProbe.pressure = st.pressure
  showProbe.etaBars = st.etaBars
  showProbe.hold = st.stats.hold
  showProbe.microCount = st.stats.micro
  showProbe.cut = st.stats.cut
  showProbe.forced = st.stats.forced
  if (a !== null && a.evaluated) {
    showProbe.kind = a.kind
    showProbe.reason = a.reason
    showProbe.micro = a.micro ?? ''
    showProbe.S = a.S
    showProbe.T = a.T
  }
}

export function ShowAdapter() {
  const ctxRef = useRef<AdapterCtx | null>(null)
  if (ctxRef.current === null) ctxRef.current = createCtx()

  useFrame(() => {
    // The one-frame mailbox always starts empty, so a request nobody consumed can never fire late.
    clearShowRuntime()
    showProbe.on = DIRECTOR_ON
    showProbe.src = EVENTS_V2 ? 'v2' : 'legacy'
    const ctx = ctxRef.current as AdapterCtx
    const f = audioEngine.features
    // The live event layer is drained EVERY frame, in both modes and even under `?director=legacy`, so its ring never
    // goes stale. What it delivers only reaches the director in v2 mode; otherwise it is recorded as a SHADOW event in
    // the `?structurelog` so a tap log can score v2 while the show still runs on the legacy events.
    ctx.live.length = 0
    audioEngine.events.drain(ctx.live)
    const feedV2 = EVENTS_V2 && DIRECTOR_ON
    for (let k = 0; k < ctx.live.length; k++) {
      const e = ctx.live[k]
      showProbe.lastEvent = `${e.type} ${e.strength.toFixed(2)}${e.sim ? ' sim' : ''}`
      if (!feedV2) structureLog.noteSectionEvent(e, { shadow: true })
    }
    if (!DIRECTOR_ON) return
    const m = f.mood
    const s = useStore.getState()

    // --- Trackers that must see every frame, even while automation is suppressed (an edge is consumed, not late) ---
    const li = ctx.legacyIn
    li.time = f.time
    li.beat = f.beatIndex
    li.bpm = f.bpm
    li.sectionChange = f.sectionChange
    li.sectionChangeStrength = f.sectionChangeStrength
    li.drop = f.drop
    li.buildUp = f.buildUp
    li.structureValid = f.structureValid
    li.boundaryChanged = f.songSection.boundaryChanged
    li.section = f.songSection.section
    li.previousSection = f.songSection.previousSection
    li.sectionConfidence = f.songSection.sectionConfidence
    li.beatsInSection = f.songSection.beatsInSection
    li.isSustain = f.songSection.isSustain
    li.inBreakdown = f.structureValid && f.songSection.isBreakdown
    if (EVENTS_V2) {
      // v2 replaces the sectionChange- and boundary-derived `change` / `breakdown` events: only the drop / build
      // boundaries stay in the legacy mapping's input, and `f.sectionChange` is not fed at all (so it cannot
      // corroborate a drop either).
      li.sectionChange = false
      li.boundaryChanged = f.songSection.boundaryChanged && (f.songSection.section === 'drop' || f.songSection.section === 'build')
    }
    ctx.events.length = 0
    stepLegacyEvents(ctx.legacy, li, ctx.events)
    if (EVENTS_V2) {
      // Keep the legacy drop / buildStart events, then append the live ones (a drop is seen before the change that
      // follows it, so the director can corroborate it).
      let w = 0
      for (let k = 0; k < ctx.events.length; k++) {
        const e = ctx.events[k]
        if (e.type === 'drop' || e.type === 'buildStart') ctx.events[w++] = e
      }
      ctx.events.length = w
      for (let k = 0; k < ctx.live.length; k++) ctx.events.push(ctx.live[k])
    }

    // Off with the rest of the character path under `?scenepick=legacy`.
    if (characterPickEnabled()) ctx.charShift.observe(f.character)
    else ctx.charShift.reset()
    const characterShift = ctx.charShift.take(f.time, Number.NEGATIVE_INFINITY)
    if (f.beat) ctx.trendRising = trendOf(f) === 'rising'

    // When the store commits a scene, the new one's clock starts (the store keeps the beat, not the audio time).
    if (s.lastCommitBeat !== ctx.lastCommitSeen) {
      ctx.lastCommitSeen = s.lastCommitBeat
      ctx.sceneStartTime = f.time
    }

    // --- The same bail-outs the other directors have ---
    const suppressed =
      !s.autoPilot ||
      s.status !== 'running' ||
      f.silence ||
      cueState.governed ||
      performanceState.djCam.active ||
      performanceState.limitless.active ||
      f.time - s.lastManualAt < MANUAL_HOLD_SEC
    if (suppressed) {
      // The events were consumed (an edge is never late), but say so in the log.
      if (feedV2) for (let k = 0; k < ctx.live.length; k++) structureLog.noteSectionEvent(ctx.live[k], { decision: 'suppressed' })
      publish(ctx, null)
      return
    }

    // --- The director's inputs: everything the old triggers used to switch on, now only pressure ---
    const inp = ctx.input
    inp.beat = f.beatIndex
    inp.time = f.time
    inp.bpm = f.bpm
    inp.sceneStartBeat = s.lastCommitBeat
    inp.sceneStartTime = ctx.sceneStartTime
    // The last beat of a bar: a request made now commits on the very next downbeat (see `ShowInput.barLine`). In v2
    // mode the bar lines are the boundary-anchored grid's while it is confident (the music's, not an arbitrary
    // `beatIndex % 4`); otherwise, and always in legacy mode, it is `f.beatInBar`.
    let barLine = f.beat && f.beatInBar === 3
    if (EVENTS_V2 && f.beat) {
      const toLine = audioEngine.events.beatsToBarLine(f.beatIndex)
      if (toLine >= 0) barLine = toLine === 1
    }
    inp.barLine = barLine
    inp.inBreakdown = f.structureValid && f.songSection.isBreakdown
    inp.inBuild = f.structureValid && f.songSection.isSustain
    inp.moodChanged = m.changed && m.confidence >= MOOD_CHANGE_MIN_CONFIDENCE && m.ambiguity <= MOOD_CHANGE_MAX_AMBIGUITY
    inp.moodPredicted =
      m.predictedState !== m.state &&
      m.beatsTillTransition >= 0 &&
      m.beatsTillTransition < 4 &&
      m.confidence > MOOD_PREDICT_MIN_CONFIDENCE
    inp.characterShift = characterShift
    inp.trendRising = ctx.trendRising

    // Is the armed scene still a good pick? (Cheap: read from the last periodic fit check; `tryCommitArmed` re-verifies.)
    const armed = armedRuntime.state
    ctx.show.armedFitOk =
      armed.armed !== null &&
      s.heldSceneId === armed.armed.sceneId &&
      (armed.lastFitBest <= 0 || (armed.lastFitArmed > 0 && armed.lastFitArmed >= ARM.refitRatio * armed.lastFitBest))

    const n = ctx.events.length
    for (let k = 0; k < Math.max(1, n); k++) {
      inp.event = k < n ? ctx.events[k] : null
      const a = step(ctx.show, inp)
      if (inp.event !== null && inp.event.source === 'live') {
        structureLog.noteSectionEvent(inp.event, { S: a.S, T: a.T, decision: `${a.kind}:${a.reason}` })
      }
      if (a.kind === 'CUT') showProbe.cutHow = performCut(ctx, f, a)
      else if (a.kind === 'MICRO') performMicro(ctx, f, a)
      publish(ctx, a)
    }
    inp.event = null
  }, -92) // after the audio engine tick (-100), before AutoPilot (-90) and PerformanceDirector (-85)

  return null
}
