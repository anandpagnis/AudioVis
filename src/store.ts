import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { audioEngine, type ResponseTuning, type SourceKind } from './audio/AudioEngine'
import { disableMidiSync, enableMidiSync } from './audio/MidiClock'
import { sanitizePreset, type Preset } from './engine/presets'
import { startRecording, stopRecording } from './engine/recorder'
import { preloadScene } from './scenes'

export type AudioStatus = 'idle' | 'starting' | 'running' | 'error'
export type Quality = 'auto' | 'low' | 'medium' | 'high'

interface MicDevice {
  id: string
  label: string
}

/** Global visual parameters every scene respects (the parameter system). */
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
 * Default per-slot look.
 *
 * Background sits at 0.40 by default — it is the ground, not a second subject,
 * and this is the gain that makes a scene authored at full strength read as
 * behind rather than alongside the primary.
 */
const defaultLayerFx = (): Record<LayerRole, LayerFx> => ({
  background: { intensity: 0.4, blend: 'add' },
  accent: { intensity: 1, blend: 'add' },
  overlay: { intensity: 1, blend: 'add' },
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
  /** Persistent, user-controllable composition slots. Effects are NOT here. */
  layerSceneIds: Record<LayerRole, string | null>
  paletteId: string

  uiHidden: boolean
  debugOpen: boolean
  analyticsOpen: boolean
  params: VisualParams
  quality: Quality

  /** Mood-driven automation. */
  autoPilot: boolean
  moodDrive: boolean
  generative: boolean
  /** Evangelion tactical HUD overlay (part of the show, independent of uiHidden). */
  tacticalHud: boolean
  /** Last manual scene/palette action (autopilot backs off for a while). */
  lastManualAt: number

  /** Phase 6: response shaping, band routing, per-layer look. */
  responseTuning: ResponseTuning
  bandMappings: BandMapping[]
  layerFx: Record<LayerRole, LayerFx>

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
  cancelStartAudio: () => void
  stopAudio: () => void
  captureCue: () => void
  deleteCue: (id: string) => void
  clearCues: () => void
  toggleCueFollow: () => void
  applyCue: (cue: PerformanceCue) => void
  toggleMidiSync: () => Promise<void>
  toggleRecording: () => void
  requestScene: (id: string, opts?: { auto?: boolean; immediate?: boolean }) => void
  setLayer: (role: LayerRole, id: string | null, opts?: { auto?: boolean }) => void
  setLayerFx: (role: LayerRole, patch: Partial<LayerFx>) => void
  setResponseTuning: (patch: Partial<ResponseTuning>) => void
  addBandMapping: () => void
  updateBandMapping: (id: string, patch: Partial<Omit<BandMapping, 'id'>>) => void
  removeBandMapping: (id: string) => void
  toggleAutoPilot: () => void
  toggleMoodDrive: () => void
  toggleGenerative: () => void
  toggleTacticalHud: () => void
  commitScene: () => void
  setPalette: (id: string, opts?: { auto?: boolean }) => void
  toggleUi: () => void
  toggleDebug: () => void
  toggleAnalytics: () => void
  setParam: (key: keyof VisualParams, value: number) => void
  setQuality: (q: Quality) => void

  applyPreset: (p: Preset) => void
  saveCurrentPreset: (name: string) => void
  deletePreset: (id: string) => void
  toggleFavorite: (id: string) => void
  importPresets: (json: string) => number

  refreshDevices: () => Promise<void>
  setMicDevice: (id: string) => void
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
      layerSceneIds: emptyLayerScenes(),
      paletteId: 'aurora',

      uiHidden: false,
      debugOpen: false,
      analyticsOpen: false,
      params: { intensity: 1, speed: 1, reactivity: 1 },
      quality: 'auto',

      autoPilot: true,
      moodDrive: true,
      generative: true,
      tacticalHud: true,
      lastManualAt: 0,

      responseTuning: { attack: 1, release: 1, subdivision: 1 },
      bandMappings: [],
      layerFx: defaultLayerFx(),

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
      cancelStartAudio: () => {
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
        if (id === get().sceneId) return
        preloadScene(id) // start fetching the lazy chunk before the downbeat commit
        set({ pendingSceneId: id, pendingImmediate: opts?.immediate === true })
      },

      setLayer: (role, id, opts) => {
        if (id === get().sceneId) id = null
        if (id) preloadScene(id)
        const patch = { layerSceneIds: { ...get().layerSceneIds, [role]: id } }
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
      toggleGenerative: () => set((s) => ({ generative: !s.generative })),
      toggleTacticalHud: () => set((s) => ({ tacticalHud: !s.tacticalHud })),

      commitScene: () => {
        const pending = get().pendingSceneId
        if (pending) {
          const recent = [pending, ...get().recentSceneIds.filter((id) => id !== pending)].slice(0, 4)
          set({
            sceneId: pending,
            pendingSceneId: null,
            pendingImmediate: false,
            recentSceneIds: recent,
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
      toggleAnalytics: () => set((s) => ({ analyticsOpen: !s.analyticsOpen })),
      setParam: (key, value) => set((s) => ({ params: { ...s.params, [key]: value } })),
      setQuality: (q) => set({ quality: q }),

      applyPreset: (p) => {
        set({
          paletteId: p.paletteId,
          params: { ...p.params },
          layerSceneIds: { ...emptyLayerScenes(), ...p.layerSceneIds },
          ...(p.layerFx ? { layerFx: { ...defaultLayerFx(), ...p.layerFx } } : {}),
          // Presets carrying a performance timeline restore it; plain "look"
          // presets leave the current cue list alone.
          ...(p.cues && p.cues.length > 0 ? { cues: p.cues.map((c) => ({ ...c })) } : {}),
        })
        get().requestScene(p.sceneId)
      },

      saveCurrentPreset: (name) => {
        const s = get()
        const preset: Preset = {
          id: crypto.randomUUID(),
          name: name.trim().slice(0, 40) || 'Untitled',
          sceneId: s.sceneId,
          layerSceneIds: { ...s.layerSceneIds },
          paletteId: s.paletteId,
          params: { ...s.params },
          layerFx: cloneLayerFx(s.layerFx),
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
      version: 1,
      migrate: (persisted, version) => {
        if (version >= 1) return persisted
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
          layerFx: cloneLayerFx(old.layerFx ?? {}),
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
        generative: s.generative,
        tacticalHud: s.tacticalHud,
        responseTuning: s.responseTuning,
        bandMappings: s.bandMappings,
        layerFx: s.layerFx,
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
