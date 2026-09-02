import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { audioEngine, type ResponseTuning, type SourceKind } from './audio/AudioEngine'
import { beginHandoff, endHandoff, handSource, isOutput } from './engine/outputLink'
import type { TransitionStyle } from './engine/transitions'
import { disableMidiSync, enableMidiSync } from './audio/MidiClock'
import { sanitizePreset, type Preset } from './engine/presets'
import { startRecording, stopRecording } from './engine/recorder'
import { canHoldPrimary, canHoldRole, getSceneContract, preloadScene, resolveSceneMode } from './scenes'
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
 * Manual override values for the post-fx fields normally decided by
 * `PerformanceStateBridge`. See the `debugPostFx` field on `AppState` for why
 * this exists and why it is temporary.
 */
export interface DebugPostFx {
  enabled: boolean
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

  uiHidden: boolean
  debugOpen: boolean
  /** Lightweight fps / frame-time / tier readout. Separate from `debugOpen`
   *  because that panel is a per-frame canvas heavy enough to distort the
   *  very measurement you open it to read. */
  fpsMeter: boolean
  analyticsOpen: boolean
  params: VisualParams
  quality: Quality

  /**
   * TEMPORARY: manual override for the post-fx fields `PerformanceStateBridge`
   * otherwise decides every frame (bloom, vignette, glitch, fog, trails). Exists
   * to let a human drag a value and see it, ahead of any director having an
   * opinion about when to move it — see the debug panel's "Post FX" section.
   *
   * Deliberately excluded from `partialize` below: this is scratch state for
   * eyeballing a look, not a setting anyone should reload into. When `enabled`
   * is false every field here is inert and the director's own values reach the
   * screen unchanged.
   */
  debugPostFx: DebugPostFx

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

  userPresets: Preset[]
  favoriteIds: string[]

  micDevices: MicDevice[]
  micDeviceId: string | null

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
  /** Returns false when the request was refused (already current, or the
   *  automatic dwell floor has not elapsed) — callers that act on the
   *  incoming scene must check, not assume. */
  requestScene: (id: string, opts?: { auto?: boolean; immediate?: boolean }) => boolean
  setLayer: (role: LayerRole, id: string | null, opts?: { auto?: boolean }) => void
  setLayerFx: (role: LayerRole, patch: Partial<LayerFx>) => void
  setResponseTuning: (patch: Partial<ResponseTuning>) => void
  addBandMapping: () => void
  updateBandMapping: (id: string, patch: Partial<Omit<BandMapping, 'id'>>) => void
  removeBandMapping: (id: string) => void
  toggleAutoPilot: () => void
  toggleMoodDrive: () => void
  commitScene: () => void
  setPalette: (id: string, opts?: { auto?: boolean }) => void
  toggleUi: () => void
  toggleDebug: () => void
  toggleFpsMeter: () => void
  toggleAnalytics: () => void
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
  setDebugPostFx: (patch: Partial<DebugPostFx>) => void

  applyPreset: (p: Preset) => void
  saveCurrentPreset: (name: string) => void
  deletePreset: (id: string) => void
  toggleFavorite: (id: string) => void
  importPresets: (json: string) => number

  refreshDevices: () => Promise<void>
  setMicDevice: (id: string) => void
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
      recentSceneIds: [],
      lastCommitBeat: -Infinity,
      layerSceneIds: emptyLayerScenes(),
      layerCommitBeats: { background: -Infinity, accent: -Infinity, overlay: -Infinity },
      paletteId: 'aurora',

      uiHidden: false,
      debugOpen: false,
      fpsMeter: false,
      analyticsOpen: false,
      params: { intensity: 1, speed: 1, reactivity: 1 },
      quality: 'auto',
      debugPostFx: {
        enabled: false,
        bloom: 1,
        bloomThreshold: 0.18,
        glitch: 0,
        vignette: 0.85,
        fog: 0,
        trails: 0,
        mirrorSegments: 0,
        mirrorTiles: 0,
        mirrorTwist: 0,
        mirrorSlice: 0,
        mirrorSpin: 0,
        lensAmount: 0,
        lensStyle: 0,
        transitionStyle: 'dissolve',
      },

      autoPilot: true,
      moodDrive: true,
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

      userPresets: [],
      favoriteIds: [],

      micDevices: [],
      micDeviceId: null,

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
        if (!isOutput()) {
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
          handoffToken++
          beginHandoff()
          if (!handSource({ kind: 'file', file })) {
            endHandoff()
            set({ status: 'error', error: OUTPUT_REQUIRED, sourceType: null })
            return
          }
          // See the note in startAudio: the output window confirms.
          set({ status: 'starting', sourceType: 'file' })
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
        } else if (startRecording()) {
          set({ isRecording: true })
        }
      },

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
        if (opts?.auto && !opts.immediate && !canAutoSwitch(get().lastCommitBeat)) return false
        preloadScene(id) // start fetching the lazy chunk before the downbeat commit
        set({ pendingSceneId: id, pendingImmediate: opts?.immediate === true })
        return true
      },

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
      commitScene: () => {
        const pending = get().pendingSceneId
        if (pending) {
          const recent = [pending, ...get().recentSceneIds.filter((id) => id !== pending)].slice(
            0,
            4,
          )
          set({
            sceneId: pending,
            pendingSceneId: null,
            pendingImmediate: false,
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
      toggleAnalytics: () => set((s) => ({ analyticsOpen: !s.analyticsOpen })),
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
        set({ sceneModes: { ...s.sceneModes, [sceneId]: next } })
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
      partialize: (s) => ({
        sceneId: s.sceneId,
        layerSceneIds: s.layerSceneIds,
        paletteId: s.paletteId,
        params: s.params,
        quality: s.quality,
        autoPilot: s.autoPilot,
        moodDrive: s.moodDrive,
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
      }),
      onRehydrateStorage: () => (state) => {
        // The engine reads tuning directly (no store subscription in the audio
        // layer) — push the persisted values into it once on load.
        if (state?.responseTuning) Object.assign(audioEngine.tuning, state.responseTuning)
      },
    },
  ),
)
