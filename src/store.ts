import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { audioEngine, type ResponseTuning, type SourceKind } from './audio/AudioEngine'
import { beginHandoff, endHandoff, handSource, isDemoWindow, isOutput } from './engine/outputLink'
import type { TransitionStyle } from './engine/transitions'
import { disableMidiSync, enableMidiSync } from './audio/MidiClock'
import { sanitizePreset, type Preset } from './engine/presets'
import { startRecording, stopRecording, type ExportPreset } from './engine/recorder'
import { canHoldPrimary, canHoldRole, getSceneContract, preloadScene, resolveSceneMode } from './scenes'
import { RECENCY_DEPTH } from './scenes/character'
import {
  resolveSceneParams,
  sanitizeSceneParams,
  type SceneParamKey,
  type SceneParams,
} from './scenes/contract'

export type AudioStatus = 'idle' | 'starting' | 'running' | 'error'
export type Quality = 'auto' | 'low' | 'medium' | 'high'

interface MicDevice {
  id: string
  label: string
}

/** Global visual parameters every scene respects (the parameter system). */
/**
 * Manual override VALUES for the post-fx fields normally decided by
 * `PerformanceStateBridge`. See the `debugPostFx` field on `AppState` for why
 * this exists and why it is temporary.
 *
 * This is just the numbers a slider/chip last held — it says nothing about
 * whether any of them is actually in effect. Whether a given field is
 * currently overriding the director is a SEPARATE question, answered by
 * {@link AppState.debugPostFxOverrides}. Splitting "the value" from "is it
 * live" this way is what lets each field be taken over independently instead
 * of one boolean freezing (or releasing) all fourteen at once — see that
 * field's own doc for the history of why a single `enabled` flag was wrong.
 */
export interface DebugPostFx {
  /** 0..2 — bloom strength multiplier. Director default: mood-based, ~0.3-0.95. */
  bloom: number
  /** 0..1 — bloom luminance threshold. Lower = more of the frame blooms. */
  bloomThreshold: number
  /** 0..1 — chromatic aberration amount. */
  glitch: number
  /** 0..1 — vignette darkness. */
  vignette: number
  /** 0..1 — atmospheric fog depth. */
  fog: number
  /** 0..1 — feedback pass: history persistence and trail drift. See
   *  engine/feedbackParams.ts for what this one number expands into. */
  trails: number
  /** 0..1 — discrete multi-tap echo: tap spacing and per-tap decay. Director
   *  default: mood-based, near 0 in silence/ambient, ~0.7-0.9 in peak/
   *  aggressive. See engine/echoParams.ts for what this one number expands
   *  into. */
  echo: number
  /** Mirror rack. `segments`: 0 off · 1 mirror-x · 2 quad · >=3 n-fold. */
  mirrorSegments: number
  /** >=2 gives an n x n mirror-repeat wallpaper. */
  mirrorTiles: number
  /** Radial vortex in radians at the centre; signed. */
  mirrorTwist: number
  /** Alternating shear slabs, 0..1. */
  mirrorSlice: number
  /** Kaleidoscope rotation rate. Inert unless `mirrorSegments` >= 3. */
  mirrorSpin: number
  /** Lens rack strength, 0..1. 0 skips the pass. */
  lensAmount: number
  /** Index into engine/opticalRack.ts's `LENS_STYLES`. */
  lensStyle: number
  /** Transition style for the next scene change. See engine/transitions.ts. */
  transitionStyle: TransitionStyle
}

/** Every field a Post FX row can independently be put under manual control of. */
export type DebugPostFxKey = keyof DebugPostFx

/**
 * `DebugPostFxKey`, enumerated — the one place that has to be kept in sync
 * with {@link DebugPostFx}'s fields. Used to build/inspect the "every field"
 * bulk actions ({@link AppState.setAllDebugPostFxOverrides} and its "are they
 * all on" reverse question in the HUD/Console "manual (all)" chip) without
 * either surface re-deriving its own copy of the field list.
 */
export const DEBUG_POSTFX_KEYS: DebugPostFxKey[] = [
  'bloom',
  'bloomThreshold',
  'glitch',
  'vignette',
  'fog',
  'trails',
  'echo',
  'mirrorSegments',
  'mirrorTiles',
  'mirrorTwist',
  'mirrorSlice',
  'mirrorSpin',
  'lensAmount',
  'lensStyle',
  'transitionStyle',
]

export interface VisualParams {
  /** Overall brightness multiplier. */
  intensity: number
  /** Autonomous-motion speed multiplier (beat-locked motion is unaffected). */
  speed: number
  /** How hard visuals respond to the music. */
  reactivity: number
}

/** Envelopes a band mapping can listen to. */
export type BandSource =
  'sub' | 'bass' | 'mid' | 'presence' | 'high' | 'vocal' | 'energy' | 'transient' | 'beatPulse'

/** Declarative band → visual-parameter routing, applied in getEffectiveParams. */
export interface BandMapping {
  id: string
  source: BandSource
  target: keyof VisualParams
  /** -1..1 — how strongly the envelope scales the target. */
  amount: number
}

export const MAX_BAND_MAPPINGS = 6

/**
 * Beats a subject must hold before automation may replace it.
 *
 * **This is the "it switches too much" dial.** Raise it to settle the show
 * down, lower it to make it restless.
 *
 * Nothing else bounded the rate. Three triggers compound:
 *
 *  - PhraseDetector allows a `sectionChange` every 8 beats, and
 *    PerformanceDirector recomposes on one IMMEDIATELY — its
 *    `PHRASE_HOLD_BEATS` guard is explicitly skipped for section changes.
 *    That alone permits a switch every 4s at 120 BPM.
 *  - Its phrase fallback fires every 16 beats otherwise.
 *  - AutoPilot has no cooldown at all, by design, and fires on every
 *    committed mood change, predicted transition and drop on top of that.
 *
 * And critically, neither director has a "hold" outcome: both build their
 * candidate pool with `scene.id !== sceneId`, so whenever one runs it is
 * *guaranteed* to change the subject. There was no path where the show
 * decided to stay put.
 *
 * Measured in beats rather than seconds so the pacing tracks the song, the
 * same reasoning as PerformanceDirector's own phrase cadence. 32 beats is two
 * phrases — about 16s at 120 BPM.
 */
export const MIN_SUBJECT_DWELL_BEATS = 32

/**
 * Beats a composition LAYER must hold before automation may replace it.
 *
 * Half the subject's floor, deliberately: layers are supposed to turn over
 * faster than the thing they decorate. But "faster" was previously "unbounded"
 * — {@link MIN_SUBJECT_DWELL_BEATS} is enforced inside `requestScene`, and
 * `setLayer` had no equivalent, so while a subject held for 32 beats the layers
 * over it could be replaced on every section boundary the phrase detector
 * emitted: as often as every 8 beats, or 4 s at 120 BPM.
 *
 * That churn is most of why one layer felt omnipresent. With only four
 * layer-capable scenes in the roster, re-rolling the slots twice as often does
 * not produce variety — it produces the same few scenes flickering in and out.
 * The real fix is a wider pool; this is the floor that stops the pool being
 * re-sampled faster than the eye can register a change.
 */
export const MIN_LAYER_DWELL_BEATS = 16

export type LayerBlend = 'add' | 'screen' | 'normal' | 'multiply'

/** Per-composition-layer look controls. */
export interface LayerFx {
  /** 0..1.5 multiplier on the layer's fade weight. */
  intensity: number
  blend: LayerBlend
}

/**
 * Composition slots that hold a persistent, user-controllable scene.
 *
 * `effect` is deliberately absent: effect scenes are transient and
 * event-triggered, so they live in `performanceState.layers.effects` (engine
 * state) rather than here (user state). `primary` is absent because it has its
 * own beat-locked commit path.
 */
export type LayerRole = 'background' | 'accent' | 'overlay'

export const LAYER_ROLES: LayerRole[] = ['background', 'accent', 'overlay']

/**
 * Default per-slot look — a stacking discipline, not three independent numbers.
 *
 * Every slot composites ADDITIVELY over the one below it, so gains do not
 * average, they sum. Accent and overlay both sat at 1.0 and a layered frame was
 * therefore arithmetically guaranteed to blow out — against a render doctrine
 * that asks for ≤15% of the frame lit, mean luma under 20, and 0% blown to
 * white (docs/09_Rendering_Engine.md). Background was the only slot that ever
 * got a considered number.
 *
 * The ladder now descends with distance from the subject: the primary is the
 * only thing at full strength, accent supports it, overlay decorates, and
 * background sits furthest back. Each layer is authored to look right alone at
 * 1.0, so these are the amounts by which each yields to the subject.
 */
const defaultLayerFx = (): Record<LayerRole, LayerFx> => ({
  background: { intensity: 0.4, blend: 'add' },
  accent: { intensity: 0.55, blend: 'add' },
  overlay: { intensity: 0.4, blend: 'add' },
})

const emptyLayerScenes = (): Record<LayerRole, string | null> => ({
  background: null,
  accent: null,
  overlay: null,
})

/** Deep-copy the per-slot look, filling in any slot a stored value predates. */
const cloneLayerFx = (fx: Partial<Record<LayerRole, LayerFx>>): Record<LayerRole, LayerFx> => {
  const base = defaultLayerFx()
  for (const role of LAYER_ROLES) if (fx[role]) base[role] = { ...fx[role] }
  return base
}

/**
 * Bring stored accent/overlay gains onto the v2 stacking ladder.
 *
 * A persisted value always beats a changed default, so lowering the numbers in
 * {@link defaultLayerFx} alone would fix the blown-out layered frame for new
 * installs only — everyone already running the app has 1.0 written to disk.
 *
 * Rewrites ONLY an exact 1.0, which is the old default and therefore a value
 * nobody chose. Any other number came from the slider, and a migration must not
 * overwrite a deliberate choice. Shared by the v0 and v1 branches: v0 state
 * predates both versions, so it needs this pass just as much.
 */
const relaxLayerGains = (
  fx: Partial<Record<LayerRole, LayerFx>> | undefined,
): Record<LayerRole, LayerFx> => {
  const out = cloneLayerFx(fx ?? {})
  const fresh = defaultLayerFx()
  for (const role of ['accent', 'overlay'] as const) {
    if (out[role].intensity === 1) out[role].intensity = fresh[role].intensity
  }
  return out
}

/**
 * Has the current subject held long enough for automation to replace it?
 *
 * Pure and exported for the test. A new source restarts `beatIndex` at 0, which
 * would leave the stamp in the future and freeze the show on one scene for the
 * whole of the next track — so a negative elapsed count reads as "yes".
 */
export function canAutoSwitch(lastCommitBeat: number, beatIndex = audioEngine.features.beatIndex) {
  const elapsed = beatIndex - lastCommitBeat
  return elapsed < 0 || elapsed >= MIN_SUBJECT_DWELL_BEATS
}

/**
 * Has this layer slot held long enough for automation to replace it?
 *
 * Same shape and same negative-elapsed escape hatch as {@link canAutoSwitch} —
 * a new source restarts `beatIndex` at 0, which would otherwise leave the stamp
 * in the future and freeze the slot for the whole of the next track.
 */
export function canAutoSwitchLayer(
  lastLayerBeat: number,
  beatIndex = audioEngine.features.beatIndex,
) {
  const elapsed = beatIndex - lastLayerBeat
  return elapsed < 0 || elapsed >= MIN_LAYER_DWELL_BEATS
}

/** Pre-v1 shape of anything that embedded composition slots. */
interface LegacyLayers {
  accentSceneId?: string | null
  overlaySceneId?: string | null
  layerSceneIds?: Partial<Record<LayerRole, string | null>>
  layerFx?: Partial<Record<LayerRole, LayerFx>>
}
type LegacyCue = LegacyLayers & Record<string, unknown>
type LegacyPreset = LegacyLayers & Record<string, unknown>

/**
 * Lift a stored cue or preset from the two-scalar slot shape to the record.
 *
 * Shared by the persist migration and `sanitizePreset`, because a preset can
 * also arrive by import or URL rather than out of localStorage — those paths
 * never see the migration, so they need the same conversion.
 */
export function migrateLegacyLayers<T extends LegacyLayers>(item: T): T {
  const { accentSceneId, overlaySceneId, ...rest } = item
  return {
    ...rest,
    layerSceneIds: {
      background: item.layerSceneIds?.background ?? null,
      accent: item.layerSceneIds?.accent ?? accentSceneId ?? null,
      overlay: item.layerSceneIds?.overlay ?? overlaySceneId ?? null,
    },
  } as T
}

/**
 * Phase 5: one authored moment in a performance — the complete look, anchored
 * to a beat position counted from when the audio source started.
 */
export interface PerformanceCue {
  id: string
  beat: number
  sceneId: string
  layerSceneIds: Record<LayerRole, string | null>
  paletteId: string
  params: VisualParams
  layerFx: Record<LayerRole, LayerFx>
}

interface AppState {
  status: AudioStatus
  sourceType: SourceKind | null
  error: string | null

  sceneId: string
  pendingSceneId: string | null
  /**
   * The pending switch should land NOW rather than on the next downbeat, and
   * hard-cut rather than crossfade.
   *
   * Set by drop-triggered requests. A drop is the one musical event whose whole
   * point is the instant of arrival: waiting for the next bar and then easing
   * over two beats is precisely the "nothing happened" failure. Transient — it
   * describes one pending transition, not persisted state.
   */
  pendingImmediate: boolean
  /** Why the pending scene was requested (`requestScene`'s `reason`, or the show director on releasing the armed
   *  scene); null for legacy callers. Read by the logs at commit time. Transient, not persisted. */
  pendingReason: string | null
  /**
   * The scene AutoPilot has ARMED for the coming drop (`engine/armedChange.ts`): mounted and compiled through
   * the pending slot like any request, but `SceneManager.resolveCommit` will not commit it while this equals
   * `pendingSceneId`. Cleared by any other `requestScene`, by `commitScene`, `releaseHold` and `disarmScene`.
   * Compared against `pendingSceneId` rather than used as a flag, so a stale value (the pending scene was
   * cleared or replaced behind its back, e.g. by a cutaway or the output-window link) can never hold an
   * unrelated request. Transient, not persisted.
   */
  heldSceneId: string | null
  /** Most-recently-committed primary scene ids, newest first, capped at 4.
   *  Transient (not persisted) — feeds `pickVariedScene`'s recency penalty so
   *  AutoPilot/PerformanceDirector don't show the same handful of scenes on
   *  repeat. Updated in `commitScene`, not `requestScene` — a scene only
   *  counts once it's actually on screen, not merely requested. */
  recentSceneIds: string[]
  /** Beat index the current subject committed on. Feeds the dwell floor. */
  lastCommitBeat: number
  /** Persistent, user-controllable composition slots. Effects are NOT here. */
  layerSceneIds: Record<LayerRole, string | null>
  /** Beat index each layer slot last changed on. Feeds the layer dwell floor.
   *  Transient (not persisted) — a beat index is only meaningful within one
   *  source's timeline, so carrying it across a reload would gate the first
   *  16 beats of the next session against a stamp from the last one. */
  layerCommitBeats: Record<LayerRole, number>
  paletteId: string
  /**
   * A filter the user picked by hand, waiting for `FilterDirector` to fire it.
   *
   * The exact shape of `pendingSceneId` above, and for the exact same reason:
   * the thing it wants to change already has a per-frame WRITER that owns it.
   * `FilterDirector` rewrites `performanceState.filter` every frame and clears
   * it on every frame its own flourish is null, so a UI setting that field
   * directly would be stomped one frame later. A manual pick therefore flows
   * THROUGH the director — requested here, consumed there — exactly as a scene
   * pick flows through `pendingSceneId` for `SceneManager` to commit.
   *
   * Transient, and deliberately absent from `partialize` below, matching
   * `pendingSceneId`: a one-shot request is meaningless a reload later, and
   * persisting it would fire a filter flourish at nobody seconds into the
   * next session.
   */
  pendingFilterId: string | null
  /**
   * Bumped on every {@link requestFilter}, and the reason firing the SAME
   * filter twice from the console works at all.
   *
   * `outputLink` publishes the look only when a `LOOK_FIELDS` value actually
   * changes, and — critically — only the CONTROL window publishes; the output
   * window applies looks and never echoes back (see `startLink`). So when the
   * output's `FilterDirector` consumes a request and calls
   * `clearFilterRequest()`, it clears its OWN copy while the console's stays
   * at the id it last sent. A second click on that same chip would then write
   * a value identical to what the console already held, `changed` would stay
   * false, nothing would be published, and the output would never fire —
   * a dead-looking button with no error anywhere.
   *
   * A monotonic counter makes every request distinguishable from the last
   * even when the id repeats, so the look always publishes. Nothing reads its
   * value; only the fact that it changed matters.
   */
  filterRequestNonce: number

  /**
   * A manual DJ-cam punch the operator pressed by hand, waiting for
   * `DjCamDirector` to act on it. The exact shape of {@link pendingFilterId}
   * above and there for the same reason: `DjCamDirector` owns
   * `performanceState.djCam` and rewrites it every frame, so a UI setting that
   * field directly would be stomped one frame later. The punch flows THROUGH
   * the director — requested here, consumed there. `'toggle'` flips the
   * cutaway: enter it while inactive, exit it while active.
   *
   * Transient, and deliberately absent from `partialize` below, matching
   * `pendingFilterId`: a one-shot punch is meaningless a reload later, and
   * persisting it would cut to a camera at nobody seconds into the next
   * session.
   */
  pendingDjCam: 'toggle' | null
  /**
   * Bumped on every {@link requestDjCam}, and — exactly as
   * {@link filterRequestNonce} is for the filter — the reason punching the DJ
   * cam a second time from the console works at all.
   *
   * `outputLink` publishes the look only when a `LOOK_FIELDS` value actually
   * changes, and only the CONTROL window publishes; the output window applies
   * looks and never echoes back. So when the output's `DjCamDirector` consumes
   * a punch and calls `clearDjCamRequest()`, it clears its OWN copy while the
   * console's stays at `'toggle'`. A second punch would then write a value
   * identical to what the console already held, nothing would publish, and the
   * output would never hear it. A monotonic counter makes every punch
   * distinguishable. Nothing reads its value; only that it changed matters.
   */
  djCamRequestNonce: number

  /**
   * A manual Limitless-cutaway punch the operator pressed by hand, waiting for
   * `LimitlessDirector` to act on it. Same shape as {@link pendingDjCam} and
   * for the identical reason: `LimitlessDirector` owns
   * `performanceState.limitless` and rewrites it every frame, so the punch
   * flows THROUGH the director — requested here, consumed there. `'toggle'`
   * flips the cutaway: enter it while inactive, exit it while active.
   *
   * Transient, and deliberately absent from `partialize` below, matching
   * `pendingDjCam`.
   */
  pendingLimitless: 'toggle' | null
  /**
   * Bumped on every {@link requestLimitless} — the reason punching Limitless a
   * second time from the console works at all. Same mechanism as
   * {@link djCamRequestNonce}: the output window's `LimitlessDirector`
   * consumes a punch and clears its OWN copy, so a second identical punch
   * needs a value that changes to publish at all. Nothing reads its value;
   * only that it changed matters.
   */
  limitlessRequestNonce: number

  uiHidden: boolean
  debugOpen: boolean
  /** Lightweight fps / frame-time / tier readout. Separate from `debugOpen`
   *  because that panel is a per-frame canvas heavy enough to distort the
   *  very measurement you open it to read. */
  fpsMeter: boolean
  /** Live readout of the post-fx chain (bloom/CA/vignette/fog/trails/mirror/
   *  lens/active flourishes) — see `src/ui/PostFxMeter.tsx`. Separate from
   *  the ISF filter's own always-on `FilterIndicator`, which this does not
   *  duplicate. */
  postFxMeter: boolean
  analyticsOpen: boolean
  /** The third-party credits/attribution panel — see `src/ui/Credits.tsx`. */
  creditsOpen: boolean
  params: VisualParams
  quality: Quality

  /**
   * TEMPORARY: manual override VALUES for the post-fx fields
   * `PerformanceStateBridge` otherwise decides every frame (bloom, vignette,
   * glitch, fog, trails, the mirror/lens racks, the next transition style).
   * Exists to let a human drag a value and see it, ahead of any director
   * having an opinion about when to move it — see the debug panel's "Post FX"
   * section.
   *
   * Deliberately excluded from `partialize` below: this is scratch state for
   * eyeballing a look, not a setting anyone should reload into.
   *
   * Holding a value here no longer means it is IN EFFECT — that used to be
   * true (a single `enabled: boolean` gated every field at once), and it was
   * wrong in two directions at the same time: dragging one slider silently
   * froze the other thirteen, and a stale `enabled: true` surviving from an
   * earlier session (see `debugPostFxOverrides` below) froze the whole panel
   * with no visible master switch anywhere in the current UI to notice, let
   * alone flip back off — read by a user as "the readout is not live". Which
   * field is actually live is now {@link AppState.debugPostFxOverrides}'s
   * question alone; this object is just the numbers.
   */
  debugPostFx: DebugPostFx
  /**
   * Which fields of {@link debugPostFx} are CURRENTLY under manual control,
   * i.e. which ones `PerformanceStateBridge` should read from `debugPostFx`
   * instead of computing itself this frame. A plain key→boolean map rather
   * than a `Set` — this is UI state read straight off a keyed list of chips,
   * and a plain object is exactly the shape that list already visits.
   *
   * Setting a value (`setDebugPostFx`) and taking control of it
   * (`setDebugPostFxOverride`) are two different actions on purpose: dragging
   * a slider does both at once (see every call site in HUD.tsx/Console.tsx),
   * but only THIS map decides whether `PerformanceStateBridge` looks at the
   * value at all. That split is what lets one field be overridden without
   * touching the other thirteen, and what lets a field be released back to
   * "auto" without losing the number it was sitting at.
   *
   * Deliberately EXCLUDED from `partialize` below, same as `debugPostFx`
   * itself, and for a sharper reason than "scratch state": `partialize` is an
   * ALLOWLIST (a field persists only if it is named there), so leaving this
   * new field off it is enough to stop it being WRITTEN to storage — but it
   * does nothing to protect against a value already sitting in an older
   * install's `localStorage` from before this field, or before `debugPostFx`
   * itself was excluded. zustand's default `merge` spreads whatever
   * `migrate()` hands back straight over the freshly-constructed state
   * (`{...currentState, ...persistedState}` — see `persist`'s own default in
   * `zustand/middleware`), and every `migrate` branch below does a blanket
   * `{...old, ...}` that carries an unrecognised legacy key through
   * untouched. So a literal `debugPostFx.enabled: true` sitting in a pre-this
   * -change blob (exactly the scenario ISSUES.md's F108 already documents:
   * "anyone who had ever dragged the tiles slider held a non-zero value in
   * localStorage") would still resurrect into a live session's state on
   * rehydrate even with today's exclusion in place — it would just no longer
   * do anything, because nothing reads a `.enabled` flag any more and this
   * map (freshly `{}` every load, never itself persisted) is what actually
   * gates every field. Retiring the boolean is therefore not cosmetic: it is
   * what keeps a resurrected legacy value inert instead of merely rare.
   */
  debugPostFxOverrides: Partial<Record<DebugPostFxKey, boolean>>

  /**
   * The photo the `limitless` scene warps, as a re-encoded data URL, or `null`
   * for its own generated placeholder.
   *
   * A data URL rather than a `File` or a canvas because of the two-window
   * split: the console owns the file picker, the output window owns the WebGL
   * texture, and `outputLink.ts` mirrors the look between them over a
   * `BroadcastChannel`. A live `File` handle or an `ImageBitmap` does not
   * survive a structured clone (see that file's "Two channels, deliberately
   * different" note) — the direct-reference path exists but is reserved for
   * `MediaStream`s and audio files it consumes once, whereas this is durable
   * look state that a late-opening output window has to be able to ask for and
   * receive. A string is the only shape that fits that. `Console.tsx` caps the
   * long edge at 1600px and re-encodes as JPEG before storing, so this is tens
   * of KB, not megabytes.
   *
   * In `LOOK_FIELDS`, so it reaches the window that actually renders.
   *
   * Deliberately excluded from `partialize` below, for the same reason
   * `debugPostFx` is: a multi-hundred-KB data URL has no business in
   * localStorage, where it would compete with the presets and cues for a 5 MB
   * quota and could fail the whole persist write.
   */
  limitlessPhoto: string | null

  /** Mood-driven automation. */
  autoPilot: boolean
  moodDrive: boolean
  /** Last manual scene/palette action (autopilot backs off for a while). */
  lastManualAt: number

  /** Phase 6: response shaping, band routing, per-layer look. */
  responseTuning: ResponseTuning
  bandMappings: BandMapping[]
  layerFx: Record<LayerRole, LayerFx>

  /**
   * Scene Contract v1 dial positions, per scene id — sparse: only parameters
   * moved off their scene default are stored.
   *
   * Per scene rather than global because the defaults ARE art direction. One
   * shared block would mean picking a scene whose `density` means "arches" and
   * inheriting the position left behind by a scene where it meant "fold" — the
   * same number naming two different pictures. Each scene keeping its own
   * positions is what makes returning to a scene return to the look you left.
   *
   * Sparse so a changed scene default still reaches a user who never touched
   * that dial. A stored value always beats a default, so storing all seven
   * would freeze every scene at whatever its defaults were on the first visit.
   */
  sceneParams: Record<string, SceneParams>
  /** Active mode per scene id. Absent means the scene's default mode. */
  sceneModes: Record<string, string>

  /** Phase 5: authored performance cues. */
  cues: PerformanceCue[]
  cueFollow: boolean

  /** Phase 7/8: external sync + export (not persisted). */
  midiSync: boolean
  isRecording: boolean
  /** Export shape for the NEXT recording. Mirrored to the output window like
   *  any other look field (see `LOOK_FIELDS`), since recording always runs
   *  there. Not persisted, same as `isRecording` — a stale preset from a past
   *  session is a worse default than always starting on `'native'`. */
  exportPreset: ExportPreset

  userPresets: Preset[]
  favoriteIds: string[]

  micDevices: MicDevice[]
  micDeviceId: string | null

  /**
   * Opt-in: may `DjCamDirector` cut away to a live camera of the DJ on its own
   * at a rare high point of the set? Persisted, the `autoPilot` / `moodDrive`
   * pattern. Governs the AUTOMATIC trigger only — the Console's manual
   * "Cut to DJ Cam" punch works whenever a camera stream is connected,
   * regardless of this flag.
   */
  djCamEnabled: boolean
  /**
   * Opt-in: may `LimitlessDirector` cut away to the photo-warp scene on its
   * own at a rare high point of the set? Same pattern as {@link djCamEnabled}
   * — governs the AUTOMATIC trigger only, the Console's manual "Cut to
   * Limitless" punch works regardless. Persisted, like `djCamEnabled`.
   */
  limitlessCutawayEnabled: boolean
  /** Cameras offered to the Console's DJ-cam picker. Scratch, like
   *  {@link micDevices}: a device list is only valid for this session's
   *  hardware and permission grant, so it is rebuilt on demand and excluded
   *  from `partialize`. */
  djCamDevices: { id: string; label: string }[]
  /** The camera the operator picked for the DJ-cam cutaway, or null for the
   *  browser default. Persisted, like {@link micDeviceId}. */
  djCamDeviceId: string | null

  startAudio: (kind: SourceKind, deviceId?: string) => Promise<void>
  startAudioFile: (file: File) => Promise<void>
  /**
   * Start from a stream the control window acquired and handed over.
   *
   * Output window only. The prompt has already happened in the other window —
   * this is the second half of that gesture, arriving as a live object rather
   * than over a wire. See engine/outputLink.ts.
   */
  startHandedStream: (stream: MediaStream, isSystem: boolean) => Promise<void>
  cancelStartAudio: () => void
  stopAudio: () => void
  captureCue: () => void
  deleteCue: (id: string) => void
  clearCues: () => void
  toggleCueFollow: () => void
  applyCue: (cue: PerformanceCue) => void
  toggleMidiSync: () => Promise<void>
  toggleRecording: () => void
  setExportPreset: (preset: ExportPreset) => void
  /** Returns false when the request was refused (already current, or the
   *  automatic dwell floor has not elapsed) — callers that act on the
   *  incoming scene must check, not assume. */
  requestScene: (
    id: string,
    opts?: {
      auto?: boolean
      immediate?: boolean
      /** Why (the show director's reason, for the logs); stored as `pendingReason` until the commit. */
      reason?: string
      /** The caller owns pacing (the show director): skip the 32-beat dwell floor. Legacy callers never set it. */
      bypassDwell?: boolean
    },
  ) => boolean
  /**
   * Arm `id` for the coming drop: mount and compile it through the pending slot but HOLD it (`heldSceneId`).
   * Refused (false) when it is the current scene, cannot hold `primary`, or the pending slot is taken. Unlike an
   * automatic `requestScene` it does NOT check the 32-beat dwell: the dwell is enforced when the hold is
   * released for a non-drop reason, and a drop bypasses it (see `armedChange.ts`).
   */
  armScene: (id: string) => boolean
  /**
   * Release the held scene so `SceneManager` may commit it: `immediate` cuts NOW (a confirmed drop), otherwise it
   * lands on the next downbeat as a normal crossfade. Returns false (and clears any stale hold) when nothing is
   * held for the current pending scene.
   */
  releaseHold: (immediate: boolean) => boolean
  /** Give the pending slot back: clears the held scene and, when it is still the pending one, the pending scene. */
  disarmScene: () => void
  /** Ask `FilterDirector` to fire this filter on its next frame. Unlike
   *  `requestScene` there is nothing for a caller to check — the director
   *  validates the id and consumes the request either way — so this returns
   *  void rather than a refusal. See {@link AppState.pendingFilterId}. */
  requestFilter: (id: string) => void
  /** Clear a consumed request. Called by `FilterDirector` on the frame it
   *  reads `pendingFilterId`, valid id or not, so an unknown id cannot wedge
   *  the queue. */
  clearFilterRequest: () => void
  /** Ask `DjCamDirector` to punch the DJ cam on its next frame — enter the
   *  cutaway if it is not up, exit it if it is. Like {@link requestFilter}
   *  there is nothing for a caller to check: the director consumes the punch
   *  whatever state it is in. See {@link AppState.pendingDjCam}. */
  requestDjCam: () => void
  /** Clear a consumed punch. Called by `DjCamDirector` on the frame it reads
   *  `pendingDjCam`, so an unconsumed request cannot re-fire forever —
   *  matching `clearFilterRequest`. */
  clearDjCamRequest: () => void
  /** Ask `LimitlessDirector` to punch the Limitless cutaway on its next frame
   *  — enter it if it is not up, exit it if it is. Same shape as
   *  {@link requestDjCam}. See {@link AppState.pendingLimitless}. */
  requestLimitless: () => void
  /** Clear a consumed punch. Called by `LimitlessDirector` on the frame it
   *  reads `pendingLimitless`, matching {@link clearDjCamRequest}. */
  clearLimitlessRequest: () => void
  setLayer: (role: LayerRole, id: string | null, opts?: { auto?: boolean }) => void
  setLayerFx: (role: LayerRole, patch: Partial<LayerFx>) => void
  setResponseTuning: (patch: Partial<ResponseTuning>) => void
  addBandMapping: () => void
  updateBandMapping: (id: string, patch: Partial<Omit<BandMapping, 'id'>>) => void
  removeBandMapping: (id: string) => void
  toggleAutoPilot: () => void
  toggleMoodDrive: () => void
  /** Flip the DJ-cam auto opt-in ({@link AppState.djCamEnabled}). */
  toggleDjCam: () => void
  /** Flip the Limitless-cutaway auto opt-in
   *  ({@link AppState.limitlessCutawayEnabled}). */
  toggleLimitlessCutaway: () => void
  commitScene: () => void
  setPalette: (id: string, opts?: { auto?: boolean }) => void
  toggleUi: () => void
  toggleDebug: () => void
  toggleFpsMeter: () => void
  togglePostFxMeter: () => void
  toggleAnalytics: () => void
  toggleCredits: () => void
  setParam: (key: keyof VisualParams, value: number) => void
  /**
   * Move one Scene Contract dial. A write to a parameter the scene does not
   * declare — or that is inert in its current mode — is dropped, so a generic
   * caller (panel row, MIDI CC, automation lane, the director) can address any
   * of the seven names on any scene without checking first.
   */
  setSceneParam: (sceneId: string, key: SceneParamKey, value: number) => void
  /** Switch a scene's mode. An unknown mode falls back to the scene default. */
  /** Switch a scene's mode. `auto` marks a director's choice, which — like
   *  an automatic palette change — must not count as the user touching the
   *  controls and so must not trigger AutoPilot's manual backoff. */
  setSceneMode: (sceneId: string, mode: string, opts?: { auto?: boolean }) => void
  /** Return one scene's dials (and mode) to its authored defaults. */
  resetSceneParams: (sceneId: string) => void
  setQuality: (q: Quality) => void
  /** Patch one or more `debugPostFx` VALUES. Does not by itself put anything
   *  under manual control — see {@link setDebugPostFxOverride}, which every
   *  slider/chip's `onChange` also calls, and {@link DebugPostFx}'s own doc
   *  for why the two are split. */
  setDebugPostFx: (patch: Partial<DebugPostFx>) => void
  /** Take (`on: true`) or release (`on: false`) manual control of ONE
   *  `debugPostFx` field. Releasing does not touch the value that field was
   *  last set to — it just hands the field back to `PerformanceStateBridge`,
   *  which starts computing it again from next frame. */
  setDebugPostFxOverride: (key: DebugPostFxKey, on: boolean) => void
  /** Bulk convenience backing the "manual (all)" / "auto (all)" chip:
   *  `true` puts every `debugPostFx` field under manual control at once
   *  (each keeps whatever value its slider last held — this only flips the
   *  override flags, it snapshots nothing), `false` releases all of them
   *  back to auto in one action. */
  setAllDebugPostFxOverrides: (on: boolean) => void
  /** Set (or clear, with `null`) the photo `limitless` warps. Already-encoded
   *  data URL — the resize/encode happens at the picker. */
  setLimitlessPhoto: (dataUrl: string | null) => void

  applyPreset: (p: Preset) => void
  saveCurrentPreset: (name: string) => void
  deletePreset: (id: string) => void
  toggleFavorite: (id: string) => void
  importPresets: (json: string) => number

  refreshDevices: () => Promise<void>
  setMicDevice: (id: string) => void
  /** Enumerate camera devices into {@link AppState.djCamDevices}. Best-effort
   *  and label-poor until a getUserMedia grant exists, exactly like
   *  {@link refreshDevices} for microphones. */
  refreshDjCamDevices: () => Promise<void>
  /** Remember the camera the operator picked for the DJ-cam cutaway. */
  setDjCamDevice: (id: string) => void
}

/**
 * Attempt counter for control-window source acquisition.
 *
 * The guard after `await acquireSource(...)` used to ask whether `status` was
 * still `'starting'`, which is a field the OUTPUT window writes through
 * telemetry — so an idle output window cancelled every screen-share the moment
 * the picker took longer than 100 ms. A local token cannot be written by
 * anything else, which is the whole point of it.
 */
let handoffToken = 0

/** Shown when a source was acquired but there is no output window to run it. */
const OUTPUT_REQUIRED =
  'No output window. Open the output window first — it is where the show runs.'

/**
 * How long the control window waits, after successfully handing a stream to
 * the output window, for telemetry to confirm the output side actually
 * picked it up and started (`adoptOutputStatus` moving `status` off
 * `'starting'`).
 *
 * Before this existed, a hand-off that silently never reached the output
 * side — the popup reused a stale/wedged window, `useHandedSource`'s poll
 * never ran, the output window's own start threw somewhere not surfaced —
 * left the console showing "Starting… cancel" forever: no error, nothing to
 * act on, and "cancel" itself only resets the OUTPUT window's copy of
 * `status` (it runs `cancelStartAudio` there via `sendCommand`), which the
 * console has no way to learn about while `handoffInFlight()` is still
 * suppressing telemetry adoption — so the button did not even unstick the
 * screen that showed it.
 *
 * Sized well under `HANDOFF_GRACE_MS` (70 s, which times the OPERATOR'S OWN
 * picker dialog): a real hand-off that DID land completes in about a
 * second (`startWithStream` -> `connectStream` is synchronous once the
 * context resumes, capped at 3 s by `resumeSafely`, plus one
 * `TELEMETRY_INTERVAL_MS` tick to report it) — so 15 s is generous slack for
 * a slow context resume, not a window to keep the operator waiting on.
 */
const HANDOFF_CONFIRM_TIMEOUT_MS = 15_000

/** One place to turn a start failure into something a human can act on. */
function describeStartError(err: unknown): string {
  if (err instanceof DOMException && err.name === 'NotAllowedError') {
    return 'Permission denied — allow access and try again.'
  }
  return err instanceof Error ? err.message : 'Could not start audio capture.'
}

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      status: 'idle',
      sourceType: null,
      error: null,

      sceneId: 'wireframe',
      pendingSceneId: null,
      pendingImmediate: false,
      pendingReason: null,
      heldSceneId: null,
      recentSceneIds: [],
      lastCommitBeat: -Infinity,
      layerSceneIds: emptyLayerScenes(),
      layerCommitBeats: { background: -Infinity, accent: -Infinity, overlay: -Infinity },
      paletteId: 'aurora',
      pendingFilterId: null,
      filterRequestNonce: 0,
      pendingDjCam: null,
      djCamRequestNonce: 0,
      pendingLimitless: null,
      limitlessRequestNonce: 0,

      uiHidden: false,
      debugOpen: false,
      fpsMeter: false,
      postFxMeter: false,
      analyticsOpen: false,
      creditsOpen: false,
      params: { intensity: 1, speed: 1, reactivity: 1 },
      quality: 'auto',
      debugPostFx: {
        bloom: 1,
        bloomThreshold: 0.18,
        glitch: 0,
        vignette: 0.85,
        fog: 0,
        trails: 0,
        echo: 0,
        mirrorSegments: 0,
        mirrorTiles: 0,
        mirrorTwist: 0,
        mirrorSlice: 0,
        mirrorSpin: 0,
        lensAmount: 0,
        lensStyle: 0,
        transitionStyle: 'dissolve',
      },
      // Fresh on every load, deliberately — see this field's own doc on
      // `AppState` for why it must never be persisted.
      debugPostFxOverrides: {},
      limitlessPhoto: null,

      autoPilot: true,
      moodDrive: true,
      djCamEnabled: false,
      limitlessCutawayEnabled: false,
      lastManualAt: 0,

      responseTuning: { attack: 1, release: 1, subdivision: 1 },
      bandMappings: [],
      layerFx: defaultLayerFx(),

      sceneParams: {},
      sceneModes: {},

      cues: [],
      cueFollow: true,
      midiSync: false,
      isRecording: false,
      exportPreset: 'native',

      userPresets: [],
      favoriteIds: [],

      micDevices: [],
      micDeviceId: null,
      djCamDevices: [],
      djCamDeviceId: null,

      startAudio: async (kind, deviceId) => {
        // Ignore re-entrant starts. The start card disables its buttons while
        // starting, but keyboard/programmatic paths can still double-fire, and
        // two concurrent acquisitions would race to commit engine state.
        if (get().status === 'starting') return
        set({ status: 'starting', error: null })

        // Two-window path: this window prompts (it has the user activation; a
        // freshly opened window does not) and the output window analyses. The
        // stream crosses by direct reference because a MediaStream does not
        // survive a structured clone.
        //
        // The public /demo window is neither of those windows — it is both at
        // once, alone, with no pairing to wait for — so it takes the same
        // self-acquire branch below as a real output window. See
        // isDemoWindow's own doc in outputLink.ts.
        if (!isOutput() && !isDemoWindow()) {
          const token = ++handoffToken
          // Holds telemetry off `status` for the length of the prompt; see
          // shouldAdoptStatus, which exists because of this exact window.
          beginHandoff()
          try {
            const stream = await audioEngine.acquireSource(
              kind,
              deviceId ?? get().micDeviceId ?? undefined,
            )
            if (token !== handoffToken) {
              // Superseded or cancelled. Release the capture: nothing else can,
              // and the OS indicator stays lit until something does.
              stream.getTracks().forEach((t) => t.stop())
              return
            }
            // `startAudio` is only ever called with a capture kind; `file`
            // has its own action. Narrowed here rather than by widening the
            // hand-off type, which would let a File-shaped payload claim to
            // carry a stream.
            const capture = kind === 'file' ? 'mic' : kind
            if (!handSource({ kind: capture, stream })) {
              // Nothing took it, so nothing will ever stop it. Release the
              // capture rather than leaving the OS indicator lit on a device
              // no one is reading.
              stream.getTracks().forEach((t) => t.stop())
              endHandoff()
              set({ status: 'error', error: OUTPUT_REQUIRED, sourceType: null })
              return
            }
            // NOT `running`: this window has no engine, so whether the show
            // actually started is a fact only the output window has. It arrives
            // on telemetry a moment later — see adoptOutputStatus.
            set({ status: 'starting', sourceType: kind })
            if (kind === 'mic') void get().refreshDevices()
            // See HANDOFF_CONFIRM_TIMEOUT_MS's own doc: a hand-off that never
            // reaches (or never starts in) the output window used to leave
            // this card on "Starting…" forever, no error, nothing to act on.
            window.setTimeout(() => {
              if (token !== handoffToken) return
              if (get().status !== 'starting') return
              set({
                status: 'error',
                error:
                  'The output window never confirmed receiving the source. It may be stuck on an old page — close it and click a source button again to open a fresh one.',
                sourceType: null,
              })
            }, HANDOFF_CONFIRM_TIMEOUT_MS)
          } catch (err) {
            endHandoff()
            if (token !== handoffToken) return
            set({ status: 'error', error: describeStartError(err), sourceType: null })
          }
          return
        }

        try {
          await audioEngine.start(kind, deviceId ?? get().micDeviceId ?? undefined)
          // start() resolves without connecting when it was cancelled or
          // superseded mid-prompt, so success cannot be inferred from resolve.
          if (get().status !== 'starting') return // already moved on by whoever cancelled
          if (!audioEngine.running) {
            // Resolved without connecting, yet we're still the live attempt —
            // so nothing else is going to reset the card. Any stop() bumps the
            // engine's start token (the track-'ended' handlers call it
            // directly), and returning silently here left the selector stuck on
            // "Waiting for permission" forever with no error and no way out.
            set({ status: 'idle', sourceType: null })
            return
          }
          audioEngine.onEnded = () => set({ status: 'idle', sourceType: null })
          set({ status: 'running', sourceType: kind })
          if (kind === 'mic') void get().refreshDevices()
        } catch (err) {
          // The picker timeout can fire long after the user backed out; don't
          // resurrect an error onto a card they already dismissed.
          if (get().status !== 'starting') return
          const msg =
            err instanceof DOMException && err.name === 'NotAllowedError'
              ? 'Permission denied — allow access and try again.'
              : err instanceof Error
                ? err.message
                : 'Could not start audio capture.'
          set({ status: 'error', error: msg, sourceType: null })
        }
      },

      startAudioFile: async (file) => {
        if (get().status === 'starting') return
        set({ status: 'starting', error: null })
        // A File clones fine, but it travels the same way as a stream so there
        // is one hand-off path rather than two.
        if (!isOutput()) {
          const token = ++handoffToken
          beginHandoff()
          if (!handSource({ kind: 'file', file })) {
            endHandoff()
            set({ status: 'error', error: OUTPUT_REQUIRED, sourceType: null })
            return
          }
          // See the note in startAudio: the output window confirms.
          set({ status: 'starting', sourceType: 'file' })
          // See HANDOFF_CONFIRM_TIMEOUT_MS's own doc — same gap, same fix.
          window.setTimeout(() => {
            if (token !== handoffToken) return
            if (get().status !== 'starting') return
            set({
              status: 'error',
              error:
                'The output window never confirmed receiving the file. It may be stuck on an old page — close it and click a source button again to open a fresh one.',
              sourceType: null,
            })
          }, HANDOFF_CONFIRM_TIMEOUT_MS)
          return
        }
        try {
          await audioEngine.startWithFile(file)
          if (get().status !== 'starting') return
          if (!audioEngine.running) {
            // Same dead-end as startAudio() — see the note there.
            set({ status: 'idle', sourceType: null })
            return
          }
          audioEngine.onEnded = () => set({ status: 'idle', sourceType: null })
          set({ status: 'running', sourceType: 'file' })
        } catch (err) {
          if (get().status !== 'starting') return
          const msg = err instanceof Error ? err.message : 'Could not play the audio file.'
          set({ status: 'error', error: msg, sourceType: null })
        }
      },

      /**
       * Back out of a start that is waiting on a permission prompt. There is no
       * way to dismiss the browser's own dialog from script, so this releases
       * the app side: the in-flight attempt is invalidated and the card returns
       * to its source list. If the user then answers the dialog, the grant is
       * discarded and its tracks stopped (see AudioEngine.cancelStart).
       */
      startHandedStream: async (stream, isSystem) => {
        set({ status: 'starting', error: null })
        try {
          await audioEngine.startWithStream(stream, isSystem)
          if (!audioEngine.running) {
            set({ status: 'idle', sourceType: null })
            return
          }
          audioEngine.onEnded = () => set({ status: 'idle', sourceType: null })
          set({ status: 'running', sourceType: isSystem ? 'system' : 'mic' })
        } catch (err) {
          set({ status: 'error', error: describeStartError(err), sourceType: null })
        }
      },

      cancelStartAudio: () => {
        // Invalidates any acquisition still waiting on a prompt: the resolved
        // stream is released instead of being handed over to a show the
        // operator has already backed out of.
        handoffToken++
        endHandoff()
        audioEngine.cancelStart()
        audioEngine.stop()
        set({ status: 'idle', error: null, sourceType: null })
      },

      stopAudio: () => {
        audioEngine.stop()
        if (get().isRecording) {
          stopRecording()
          set({ isRecording: false })
        }
        set({ status: 'idle', sourceType: null })
      },

      captureCue: () => {
        const s = get()
        const f = audioEngine.features
        const beat = Math.max(0, Math.round(f.beatIndex + f.beatProgress))
        const cue: PerformanceCue = {
          id: crypto.randomUUID(),
          beat,
          sceneId: s.sceneId,
          layerSceneIds: { ...s.layerSceneIds },
          paletteId: s.paletteId,
          params: { ...s.params },
          layerFx: cloneLayerFx(s.layerFx),
        }
        // Re-capturing near an existing cue replaces it.
        const cues = s.cues
          .filter((c) => Math.abs(c.beat - beat) > 1)
          .concat(cue)
          .sort((a, b) => a.beat - b.beat)
        set({ cues })
      },

      deleteCue: (id) => set((s) => ({ cues: s.cues.filter((c) => c.id !== id) })),
      clearCues: () => set({ cues: [] }),
      toggleCueFollow: () => set((s) => ({ cueFollow: !s.cueFollow })),

      applyCue: (cue) => {
        set({
          paletteId: cue.paletteId,
          params: { ...cue.params },
          layerSceneIds: { ...emptyLayerScenes(), ...cue.layerSceneIds },
          layerFx: cloneLayerFx(cue.layerFx),
        })
        get().requestScene(cue.sceneId, { auto: true })
      },

      toggleMidiSync: async () => {
        if (get().midiSync) {
          disableMidiSync()
          set({ midiSync: false })
        } else {
          const ok = await enableMidiSync()
          set({ midiSync: ok })
        }
      },

      toggleRecording: () => {
        if (get().isRecording) {
          stopRecording()
          set({ isRecording: false })
        } else if (startRecording(get().exportPreset)) {
          set({ isRecording: true })
        }
      },

      setExportPreset: (preset) => set({ exportPreset: preset }),

      requestScene: (id, opts) => {
        if (!opts?.auto) set({ lastManualAt: audioEngine.features.time })
        if (id === get().sceneId) return false
        // A scene that cannot hold `primary` must never become the subject.
        //
        // This is a correctness guard, not tidiness. `effect`-role scenes are
        // PINNED in SceneManager as idle entries (`dir === 0`) so a firing costs
        // no compile — and the commit path looks for a warm entry to promote by
        // id alone. Requesting one as the subject therefore found its pinned
        // EFFECT entry, promoted it with `role` still `'effect'`, and retired the
        // real primary: the scene then read `slotProgress` (0 outside a live
        // firing), multiplied by `effectEnvelope(0)` — which is 0 by contract —
        // and rendered nothing. A black screen, and no error anywhere.
        //
        // Guarded here rather than only at the picker because every caller comes
        // through this function: the HUD chips, the number-key shortcuts, cue
        // playback, AutoPilot and PerformanceDirector. `false` is already this
        // function's "declined" return, so callers need no new handling.
        if (!canHoldPrimary(id)) return false
        // Minimum dwell, enforced HERE rather than in either director because
        // both of them request subjects and the floor has to bind on the pair.
        // Manual picks are exempt (the user asked for it), and so are drops:
        // `immediate` marks the one event whose whole point is landing on the
        // instant, and a drop is worth interrupting a dwell for.
        if (opts?.auto && !opts.immediate && !opts.bypassDwell && !canAutoSwitch(get().lastCommitBeat)) return false
        preloadScene(id) // start fetching the lazy chunk before the downbeat commit
        // Any request other than `armScene` replaces the pending scene outright, so it also drops a hold: a
        // request for the ARMED scene therefore doubles as its confirmation, and a manual pick is never held.
        set({
          pendingSceneId: id,
          pendingImmediate: opts?.immediate === true,
          heldSceneId: null,
          pendingReason: opts?.reason ?? null,
        })
        return true
      },

      armScene: (id) => {
        const s = get()
        if (id === s.sceneId || s.pendingSceneId !== null) return false
        if (!canHoldPrimary(id)) return false
        preloadScene(id) // start fetching the lazy chunk now: the whole point is to be ready long before the drop
        set({ pendingSceneId: id, pendingImmediate: false, heldSceneId: id, pendingReason: null })
        return true
      },

      releaseHold: (immediate) => {
        const s = get()
        if (s.heldSceneId === null) return false
        if (s.heldSceneId !== s.pendingSceneId) {
          set({ heldSceneId: null })
          return false
        }
        set({ heldSceneId: null, pendingImmediate: immediate })
        return true
      },

      disarmScene: () => {
        const s = get()
        if (s.heldSceneId === null) return
        if (s.heldSceneId === s.pendingSceneId) {
          set({ pendingSceneId: null, pendingImmediate: false, heldSceneId: null })
        } else {
          set({ heldSceneId: null })
        }
      },

      // No roster lookup, no dwell floor, no cooldown here — deliberately.
      // This is a plain hand-off to the one component that owns
      // `performanceState.filter` (see `pendingFilterId`), and `FilterDirector`
      // is where every rule about whether and how a filter may fire already
      // lives; validating the id here too would only give a bad one two places
      // to be rejected and two places to keep in sync with `ISF_FILTERS`.
      // The nonce bump is load-bearing across the window boundary, not
      // bookkeeping — see {@link AppState.filterRequestNonce}: without it a
      // repeat click on the same chip publishes no look change and the output
      // window never hears about it.
      requestFilter: (id) =>
        set((s) => ({ pendingFilterId: id, filterRequestNonce: s.filterRequestNonce + 1 })),
      clearFilterRequest: () => set({ pendingFilterId: null }),

      // Same plain hand-off as `requestFilter` above, to the one component that
      // owns `performanceState.djCam` — `DjCamDirector`, where every rule about
      // whether the cutaway may start already lives. The nonce bump is
      // load-bearing across the window boundary, not bookkeeping — see
      // {@link AppState.djCamRequestNonce}.
      requestDjCam: () =>
        set((s) => ({ pendingDjCam: 'toggle', djCamRequestNonce: s.djCamRequestNonce + 1 })),
      clearDjCamRequest: () => set({ pendingDjCam: null }),

      // Same plain hand-off, to the one component that owns
      // `performanceState.limitless` — `LimitlessDirector`, where every rule
      // about whether the cutaway may start already lives.
      requestLimitless: () =>
        set((s) => ({
          pendingLimitless: 'toggle',
          limitlessRequestNonce: s.limitlessRequestNonce + 1,
        })),
      clearLimitlessRequest: () => set({ pendingLimitless: null }),

      setLayer: (role, id, opts) => {
        if (id === get().sceneId) id = null
        // A scene not authored for this role must never be mounted in it.
        // `effect` scenes aren't the black-frame risk here (a layer mount uses
        // the ROLE passed in, not the scene's own declared role, so `slotProgress`
        // stays 0 and `effectEnvelope` never even enters it — see F180's
        // `role === 'effect'` branch) — the risk here is a scene rendering
        // unbudgeted and out of visual grammar: `shock`'s ring is authored to
        // flash and vanish, not sit as a permanent background wash, and it was
        // never priced or profiled for that. Same choke-point pattern as
        // `requestScene`'s `canHoldPrimary` guard.
        if (id !== null && !canHoldRole(id, role)) return
        const s = get()
        if (s.layerSceneIds[role] === id) return // no-op; don't restamp the dwell
        // Minimum dwell for automatic changes, mirroring requestScene's floor
        // for the subject. Manual picks are exempt — the user asked for it.
        // Clearing a slot (id === null) is exempt too: a layer whose scene was
        // just taken by the primary has to be able to yield immediately, and
        // holding an empty slot open costs nothing to look at.
        if (opts?.auto && id !== null && !canAutoSwitchLayer(s.layerCommitBeats[role])) return
        if (id) preloadScene(id)
        const patch = {
          layerSceneIds: { ...s.layerSceneIds, [role]: id },
          layerCommitBeats: {
            ...s.layerCommitBeats,
            [role]: audioEngine.features.beatIndex,
          },
        }
        set(opts?.auto ? patch : { ...patch, lastManualAt: audioEngine.features.time })
      },

      setLayerFx: (role, patch) =>
        set((s) => ({
          layerFx: {
            ...s.layerFx,
            [role]: {
              ...s.layerFx[role],
              ...patch,
              ...(patch.intensity !== undefined
                ? { intensity: Math.min(1.5, Math.max(0, patch.intensity)) }
                : {}),
            },
          },
        })),

      setResponseTuning: (patch) => {
        const clamp = (v: number) => Math.min(3, Math.max(0.25, v))
        const next: ResponseTuning = {
          ...get().responseTuning,
          ...patch,
          ...(patch.attack !== undefined ? { attack: clamp(patch.attack) } : {}),
          ...(patch.release !== undefined ? { release: clamp(patch.release) } : {}),
        }
        Object.assign(audioEngine.tuning, next)
        set({ responseTuning: next })
      },

      addBandMapping: () =>
        set((s) =>
          s.bandMappings.length >= MAX_BAND_MAPPINGS
            ? s
            : {
                bandMappings: [
                  ...s.bandMappings,
                  {
                    id: crypto.randomUUID(),
                    source: 'bass' as const,
                    target: 'intensity' as const,
                    amount: 0.5,
                  },
                ],
              },
        ),

      updateBandMapping: (id, patch) =>
        set((s) => ({
          bandMappings: s.bandMappings.map((m) =>
            m.id === id
              ? {
                  ...m,
                  ...patch,
                  ...(patch.amount !== undefined
                    ? { amount: Math.min(1, Math.max(-1, patch.amount)) }
                    : {}),
                }
              : m,
          ),
        })),

      removeBandMapping: (id) =>
        set((s) => ({ bandMappings: s.bandMappings.filter((m) => m.id !== id) })),

      toggleAutoPilot: () => set((s) => ({ autoPilot: !s.autoPilot })),
      toggleMoodDrive: () => set((s) => ({ moodDrive: !s.moodDrive })),
      toggleDjCam: () => set((s) => ({ djCamEnabled: !s.djCamEnabled })),
      toggleLimitlessCutaway: () =>
        set((s) => ({ limitlessCutawayEnabled: !s.limitlessCutawayEnabled })),
      commitScene: () => {
        const pending = get().pendingSceneId
        if (pending) {
          const recent = [pending, ...get().recentSceneIds.filter((id) => id !== pending)].slice(
            0,
            RECENCY_DEPTH,
          )
          set({
            sceneId: pending,
            pendingSceneId: null,
            pendingImmediate: false,
            pendingReason: null,
            heldSceneId: null,
            recentSceneIds: recent,
            lastCommitBeat: audioEngine.features.beatIndex,
          })
        }
      },

      setPalette: (id, opts) =>
        set(
          opts?.auto
            ? { paletteId: id }
            : { paletteId: id, lastManualAt: audioEngine.features.time },
        ),
      toggleUi: () => set((s) => ({ uiHidden: !s.uiHidden })),
      toggleDebug: () => set((s) => ({ debugOpen: !s.debugOpen })),

      toggleFpsMeter: () => set((s) => ({ fpsMeter: !s.fpsMeter })),
      togglePostFxMeter: () => set((s) => ({ postFxMeter: !s.postFxMeter })),
      toggleAnalytics: () => set((s) => ({ analyticsOpen: !s.analyticsOpen })),
      toggleCredits: () => set((s) => ({ creditsOpen: !s.creditsOpen })),
      setParam: (key, value) => set((s) => ({ params: { ...s.params, [key]: value } })),
      setSceneParam: (sceneId, key, value) => {
        const contract = getSceneContract(sceneId)
        if (!contract) return
        const s = get()
        const mode = resolveSceneMode(sceneId, s.sceneModes[sceneId])
        // Round-tripped through the contract's own sanitizer rather than
        // clamped here: that is the single place that knows which keys this
        // scene honours in this mode, and an inert write must not be stored —
        // it would come back to life the moment the user switched modes.
        const clean = sanitizeSceneParams(contract, mode, { [key]: value })
        if (!(key in clean)) return
        set({
          sceneParams: {
            ...s.sceneParams,
            [sceneId]: { ...s.sceneParams[sceneId], ...clean },
          },
        })
      },

      setSceneMode: (sceneId, mode, opts) => {
        const next = resolveSceneMode(sceneId, mode)
        if (next === undefined) return
        const s = get()
        if (s.sceneModes[sceneId] === next) return
        // A manual switch backs AutoPilot off, exactly as a manual scene or
        // palette change does; a director's own pick must not, or the show
        // would silence its own automation every time it changed a mode.
        if (!opts?.auto) set({ lastManualAt: performance.now() / 1000 })
        // Dropped, not remapped: a mode change can make a parameter inert, and
        // a stored inert value would silently reappear on the way back. The
        // scene's defaults for the new mode are the honest starting point.
        //
        // BOTH fields, not just `sceneModes` (F219): this store's own
        // `SceneParams` (from `scenes/contract.ts`) is a DIFFERENT type from
        // `engine/sceneParams.ts`'s same-named one — a genuine split between
        // two systems built independently (see that module's own header on
        // the same split affecting `resolveSceneParams`). `createShaderScene`
        // -based scenes (every scene with a `uMode` shader branch, Limitless
        // included) get `P.mode`/`P.modeIndex` from `useSceneParams`, which
        // reads `sceneParams[id].mode` — NOT `sceneModes`. Before this fix,
        // this action updated only the field nothing in that path ever reads:
        // confirmed live, `setSceneMode` succeeding and `sceneModes[id]`
        // changing while the actually-rendering scene's own `P.mode` stayed
        // on whatever it booted with, forever — which silently broke every
        // manual or `AutoPilot`-driven mode switch for every scene built this
        // way, not just this session's own melt/mosh addition. The type
        // assertion is real, not a workaround: the object gains a `mode`
        // property `scenes/contract.ts`'s own functions (`sanitizeSceneParams`
        // et al.) never look at — they iterate `SCENE_PARAM_KEYS` explicitly,
        // so an extra key already sitting on the object structurally cannot
        // reach them.
        set({
          sceneModes: { ...s.sceneModes, [sceneId]: next },
          sceneParams: {
            ...s.sceneParams,
            [sceneId]: { ...s.sceneParams[sceneId], mode: next } as SceneParams,
          },
        })
      },

      resetSceneParams: (sceneId) =>
        set((s) => {
          const params = { ...s.sceneParams }
          const modes = { ...s.sceneModes }
          delete params[sceneId]
          delete modes[sceneId]
          return { sceneParams: params, sceneModes: modes }
        }),

      setQuality: (q) => set({ quality: q }),
      setDebugPostFx: (patch) => set((s) => ({ debugPostFx: { ...s.debugPostFx, ...patch } })),
      setDebugPostFxOverride: (key, on) =>
        set((s) => ({ debugPostFxOverrides: { ...s.debugPostFxOverrides, [key]: on } })),
      setAllDebugPostFxOverrides: (on) =>
        set(() => {
          if (!on) return { debugPostFxOverrides: {} }
          const all: Partial<Record<DebugPostFxKey, boolean>> = {}
          for (const key of DEBUG_POSTFX_KEYS) all[key] = true
          return { debugPostFxOverrides: all }
        }),
      setLimitlessPhoto: (dataUrl) => set({ limitlessPhoto: dataUrl }),

      applyPreset: (p) => {
        const contract = getSceneContract(p.sceneId)
        // The mode is resolved BEFORE the params, because which parameters the
        // target scene can hear depends on which mode it will be in — applying
        // them against the outgoing mode would drop exactly the dials the
        // preset switched modes in order to reach.
        const mode = contract ? resolveSceneMode(p.sceneId, p.sceneMode) : undefined
        set((s) => ({
          paletteId: p.paletteId,
          params: { ...p.params },
          layerSceneIds: { ...emptyLayerScenes(), ...p.layerSceneIds },
          ...(p.layerFx ? { layerFx: { ...defaultLayerFx(), ...p.layerFx } } : {}),
          // Presets carrying a performance timeline restore it; plain "look"
          // presets leave the current cue list alone.
          ...(p.cues && p.cues.length > 0 ? { cues: p.cues.map((c) => ({ ...c })) } : {}),
          // Only this scene's entry is rewritten. A preset says what one scene
          // should look like, so it must not silently reset the dials on the
          // other seventeen — a user who tunes `kaleido`, applies a `wireframe`
          // preset, and comes back expects to find `kaleido` as they left it.
          ...(contract
            ? {
                sceneParams: {
                  ...s.sceneParams,
                  [p.sceneId]: sanitizeSceneParams(contract, mode, p.sceneParams),
                },
                sceneModes:
                  mode === undefined
                    ? s.sceneModes
                    : { ...s.sceneModes, [p.sceneId]: mode },
              }
            : {}),
        }))
        get().requestScene(p.sceneId)
      },

      saveCurrentPreset: (name) => {
        const s = get()
        const sceneContract = getSceneContract(s.sceneId)
        const currentMode = resolveSceneMode(s.sceneId, s.sceneModes[s.sceneId])
        const preset: Preset = {
          id: crypto.randomUUID(),
          name: name.trim().slice(0, 40) || 'Untitled',
          sceneId: s.sceneId,
          layerSceneIds: { ...s.layerSceneIds },
          paletteId: s.paletteId,
          params: { ...s.params },
          layerFx: cloneLayerFx(s.layerFx),
          // The RESOLVED dials, not the sparse overrides: a preset has to
          // reproduce a look, and a sparse block reproduces "whatever this
          // scene's defaults happen to be when you load me", which is a
          // different picture the next time a default is retuned.
          ...(sceneContract
            ? {
                sceneParams: resolveSceneParams(
                  sceneContract,
                  currentMode,
                  s.sceneParams[s.sceneId],
                ),
                ...(currentMode !== undefined ? { sceneMode: currentMode } : {}),
              }
            : {}),
          ...(s.cues.length > 0 ? { cues: s.cues.map((c) => ({ ...c })) } : {}),
        }
        set({ userPresets: [...s.userPresets, preset] })
      },

      deletePreset: (id) =>
        set((s) => ({
          userPresets: s.userPresets.filter((p) => p.id !== id),
          favoriteIds: s.favoriteIds.filter((f) => f !== id),
        })),

      toggleFavorite: (id) =>
        set((s) => ({
          favoriteIds: s.favoriteIds.includes(id)
            ? s.favoriteIds.filter((f) => f !== id)
            : [...s.favoriteIds, id],
        })),

      importPresets: (json) => {
        try {
          const raw = JSON.parse(json) as unknown
          const list = Array.isArray(raw) ? raw : [raw]
          const clean = list.map(sanitizePreset).filter((p): p is Preset => p !== null)
          if (clean.length === 0) return 0
          const existing = new Set(get().userPresets.map((p) => p.id))
          const merged = [...get().userPresets, ...clean.filter((p) => !existing.has(p.id))]
          set({ userPresets: merged })
          return clean.length
        } catch {
          return 0
        }
      },

      refreshDevices: async () => {
        try {
          const devices = await navigator.mediaDevices.enumerateDevices()
          const mics = devices
            .filter((d) => d.kind === 'audioinput')
            .map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` }))
          set({ micDevices: mics })
        } catch {
          /* device enumeration is best-effort */
        }
      },

      setMicDevice: (id) => set({ micDeviceId: id }),

      refreshDjCamDevices: async () => {
        try {
          const devices = await navigator.mediaDevices.enumerateDevices()
          const cams = devices
            .filter((d) => d.kind === 'videoinput')
            .map((d, i) => ({ id: d.deviceId, label: d.label || `Camera ${i + 1}` }))
          set({ djCamDevices: cams })
        } catch {
          /* device enumeration is best-effort */
        }
      },

      setDjCamDevice: (id) => set({ djCamDeviceId: id }),
    }),
    {
      name: 'audiovis-settings',
      /**
       * v1 — composition slots moved from two scalars (`accentSceneId`,
       * `overlaySceneId`) to a `layerSceneIds` record that can also hold a
       * background.
       *
       * There was no `version` before this, so persisted state written by any
       * earlier build reports 0. Without the migration those two keys would
       * simply be dropped on rehydrate and every user would silently lose their
       * layer setup — including saved cues and presets, which embed the same
       * shape. `layerFx` needs no branch: `cloneLayerFx` fills the new
       * background slot from defaults whatever the stored value looks like.
       */
      version: 2,
      migrate: (persisted, version) => {
        // v2 — accent/overlay gains dropped from 1.0 to the stacking ladder in
        // `defaultLayerFx`. Anyone who has run this build has 1.0 persisted, and
        // a stored value always beats a changed default, so without this the fix
        // would reach new installs only. Rewritten ONLY where the stored number
        // is exactly the old default: a user who deliberately tuned a slot has
        // made a choice, and a migration must not overwrite a choice.
        if (version >= 2) return persisted
        if (version === 1) {
          const v1 = (persisted ?? {}) as Record<string, unknown> & {
            layerFx?: Partial<Record<LayerRole, LayerFx>>
          }
          return { ...v1, layerFx: relaxLayerGains(v1.layerFx) }
        }
        const old = (persisted ?? {}) as Record<string, unknown> & {
          accentSceneId?: string | null
          overlaySceneId?: string | null
          layerFx?: Partial<Record<LayerRole, LayerFx>>
          cues?: LegacyCue[]
          userPresets?: LegacyPreset[]
        }
        return {
          ...old,
          layerSceneIds: {
            background: null,
            accent: old.accentSceneId ?? null,
            overlay: old.overlaySceneId ?? null,
          },
          // v0 state predates v1 AND v2, so it takes the gain relax too.
          layerFx: relaxLayerGains(old.layerFx),
          cues: (old.cues ?? []).map(migrateLegacyLayers),
          userPresets: (old.userPresets ?? []).map(migrateLegacyLayers),
        }
      },
      // An ALLOWLIST, not a blocklist: every field of `AppState` not named
      // here — `debugPostFx`, `debugPostFxOverrides`, `status`, `pendingSceneId`,
      // `micDevices`, and every other clearly-transient or live-handle-shaped
      // field — is EXCLUDED from `localStorage` by omission, with no edit
      // needed here to add a new one to that exclusion. `debugPostFxOverrides`
      // (added alongside per-field Post FX overrides) relies on exactly this:
      // it needed no entry here to become un-persisted, only the discipline of
      // not adding one. A broader audit of this list was considered and
      // declined — it is already a tight, deliberate allowlist (every one of
      // the ~15 fields below is a genuine user setting; nothing that looks
      // transient has snuck in), so the minimal move for this task is to add
      // nothing, not to restructure what was already correct. See
      // `debugPostFxOverrides`'s own doc for the sharper reason a NEW field
      // being excluded here is not by itself a persistence guarantee — this
      // allowlist governs what gets WRITTEN, not what an older install's
      // stored blob still contains on rehydrate.
      partialize: (s) => ({
        sceneId: s.sceneId,
        layerSceneIds: s.layerSceneIds,
        paletteId: s.paletteId,
        params: s.params,
        quality: s.quality,
        autoPilot: s.autoPilot,
        moodDrive: s.moodDrive,
        djCamEnabled: s.djCamEnabled,
        limitlessCutawayEnabled: s.limitlessCutawayEnabled,
        responseTuning: s.responseTuning,
        bandMappings: s.bandMappings,
        layerFx: s.layerFx,
        sceneParams: s.sceneParams,
        sceneModes: s.sceneModes,
        cues: s.cues,
        cueFollow: s.cueFollow,
        userPresets: s.userPresets,
        favoriteIds: s.favoriteIds,
        micDeviceId: s.micDeviceId,
        djCamDeviceId: s.djCamDeviceId,
      }),
      onRehydrateStorage: () => (state) => {
        // The engine reads tuning directly (no store subscription in the audio
        // layer) — push the persisted values into it once on load.
        if (state?.responseTuning) Object.assign(audioEngine.tuning, state.responseTuning)
      },
    },
  ),
)
