import { Suspense, createContext, useRef, useState, type ReactNode } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { audioEngine } from '../audio/AudioEngine'
import { useStore, type LayerBlend, type LayerRole } from '../store'
import { getScene, isSceneLoaded } from '../scenes'
import { quality } from './quality'
import { perf } from './PerfMonitor'
import { updateAnimationSignals } from './AnimationDirector'
import { sampleAnalytics } from './analyticsMetrics'
import { beginTransition, sampleTransitionFrame } from './transitionMetrics'

/**
 * Per-scene-instance fade weight (0..1, up to 1.5 for boosted layers),
 * mutated by the transition manager each frame and read by scenes inside
 * useFrame — no React re-renders.
 */
export const SceneFade = createContext<{ value: number }>({ value: 1 })

interface Entry {
  key: number
  id: string
  role: 'primary' | LayerRole
  /** 1 = fading in, -1 = fading out, 0 = mounted but warming (see WARM_FRAMES). */
  dir: 1 | -1 | 0
  /** Frames this entry has spent warming; drives the compile-then-hide dance. */
  warmFrames: number
  /** Raw crossfade 0..1. */
  fade: { value: number }
  /** What scenes see: fade × per-layer intensity. */
  out: { value: number }
}

/**
 * How many frames a warming scene stays visible (and rendering, to compile its
 * shader) before being hidden. The count only advances once the scene's lazy
 * chunk has loaded (see the aging loop), so it measures frames actually spent
 * rendering after mount — not wall-clock since the request. A shader compiles on
 * its material's first visible render, so a few frames is plenty; keeping it
 * small also shrinks the window where the warming scene renders full-res
 * alongside the current one (a double-heavy frame-time spike).
 */
const WARM_FRAMES = 4

let entryKey = 0

/** Crossfade duration in seconds — roughly two beats, clamped to a sane range. */
function crossfadeDuration(bpm: number): number {
  return Math.min(2, Math.max(0.7, (60 / bpm) * 2))
}

function applyBlend(mat: THREE.Material, blend: LayerBlend) {
  if (!mat.transparent) mat.transparent = true
  switch (blend) {
    case 'add':
      mat.blending = THREE.AdditiveBlending
      break
    case 'normal':
      mat.blending = THREE.NormalBlending
      break
    case 'multiply':
      mat.blending = THREE.MultiplyBlending
      break
    case 'screen':
      // screen = src·(1−dst) + dst — brightens without additive blow-out.
      mat.blending = THREE.CustomBlending
      mat.blendEquation = THREE.AddEquation
      mat.blendSrc = THREE.OneMinusDstColorFactor
      mat.blendDst = THREE.OneFactor
      break
  }
}

/**
 * Wraps a composition layer and rewrites its materials' blending to the
 * user's per-layer choice. Materials are created inside scene useMemo, so we
 * traverse for a few frames after mount (and after each blend change) to
 * catch everything, then go quiet.
 */
function BlendedLayer({ role, children }: { role: LayerRole; children: ReactNode }) {
  const group = useRef<THREE.Group>(null)
  const applied = useRef<LayerBlend | null>(null)
  const framesLeft = useRef(0)

  useFrame(() => {
    const blend = useStore.getState().layerFx[role].blend
    if (applied.current !== blend) {
      applied.current = blend
      framesLeft.current = 30
    }
    if (framesLeft.current <= 0 || !group.current) return
    framesLeft.current--
    group.current.traverse((obj) => {
      const mat = (obj as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined
      if (!mat) return
      for (const m of Array.isArray(mat) ? mat : [mat]) applyBlend(m, blend)
    })
  })

  return <group ref={group}>{children}</group>
}

/**
 * Controls whether an entry actually renders.
 *
 * A scene's shader compiles the first time its material renders, and that
 * compile can stall for hundreds of milliseconds. Mounting the incoming scene
 * at the downbeat therefore put the stall exactly on the beat — the single
 * worst-timed hitch in the app. Instead we mount it as soon as it's requested,
 * let it render WARM_FRAMES frames (compiling it), then hide it so it costs
 * nothing until the transition promotes it with a shader already warm.
 */
function EntryGroup({ entry, children }: { entry: Entry; children: ReactNode }) {
  const group = useRef<THREE.Group>(null)
  useFrame(() => {
    if (group.current) group.current.visible = entry.dir !== 0 || entry.warmFrames <= WARM_FRAMES
  })
  return <group ref={group}>{children}</group>
}

/**
 * Scene manager + transition manager.
 *
 * Switches commit musically: on the next downbeat when the beat grid is
 * trusted, immediately otherwise, with a safety timeout. Committing mounts
 * the incoming scene alongside the outgoing one and crossfades them over
 * roughly two beats (all scenes render additively, so overlapping fades
 * blend cleanly). Accent/overlay layers fade independently and carry their
 * own intensity/blend settings.
 */
export function SceneManager() {
  const entriesRef = useRef<Entry[]>([
    {
      key: entryKey++,
      id: useStore.getState().sceneId,
      role: 'primary',
      dir: 1,
      warmFrames: 0,
      fade: { value: 0 },
      out: { value: 0 },
    },
  ])
  const [, force] = useState(0)
  const pendingSince = useRef(-1)

  useFrame(({ clock }) => {
    // Audio feature pipeline runs once per frame, before any scene reads it.
    audioEngine.update()
    const f = audioEngine.features
    sampleAnalytics(f)
    // Animation primitives are derived once, centrally, so N scenes reading
    // them cost the same as one (each scene used to recompute its own).
    updateAnimationSignals()

    // Age warming entries so EntryGroup knows when to hide them — but only once
    // the lazy chunk has actually loaded, so the warm window is spent rendering
    // (compiling the shader) after mount rather than ticking away while the chunk
    // is still downloading. Without this gate a slow load closes the window
    // before the shader compiles, putting the stall back on the beat.
    for (const e of entriesRef.current) {
      if (e.dir === 0 && isSceneLoaded(e.id)) e.warmFrames++
    }

    const state = useStore.getState()
    const { pendingSceneId, commitScene } = state
    if (pendingSceneId) {
      if (pendingSince.current < 0) pendingSince.current = clock.elapsedTime

      // Pre-warm: mount the incoming scene the moment it's requested so its
      // shader compiles now, well before the downbeat we actually switch on.
      const warming = entriesRef.current.find((e) => e.dir === 0)
      if (!warming) {
        entriesRef.current.push({
          key: entryKey++,
          id: pendingSceneId,
          role: 'primary',
          dir: 0,
          warmFrames: 0,
          fade: { value: 0 },
          out: { value: 0 },
        })
        force((n) => n + 1)
      } else if (warming.id !== pendingSceneId) {
        // The request changed while warming — drop the stale one and warm the
        // new target instead.
        entriesRef.current = entriesRef.current.filter((e) => e !== warming)
        entriesRef.current.push({
          key: entryKey++,
          id: pendingSceneId,
          role: 'primary',
          dir: 0,
          warmFrames: 0,
          fade: { value: 0 },
          out: { value: 0 },
        })
        force((n) => n + 1)
      }

      const waited = clock.elapsedTime - pendingSince.current
      const onDownbeat = f.beat && f.beatInBar === 0
      const gridTrusted = f.confidence > 0.25 && !f.silence
      if (!gridTrusted || onDownbeat || waited > 2.5) {
        commitScene()
        pendingSince.current = -1
        // Only replace the primary scene. Composition layers have their own
        // lifetime and must survive a primary crossfade unchanged. (Invariant:
        // at most one primary is fading in at a time.)
        const outgoing = entriesRef.current.find((e) => e.role === 'primary' && e.dir === 1)
        if (outgoing) outgoing.dir = -1
        // Promote the pre-warmed entry rather than mounting a cold one, so the
        // crossfade starts with an already-compiled shader (no hitch on the beat).
        const warm = entriesRef.current.find((e) => e.dir === 0 && e.id === pendingSceneId)
        let incoming: Entry
        if (warm) {
          warm.dir = 1
          incoming = warm
        } else {
          incoming = {
            key: entryKey++,
            id: pendingSceneId,
            role: 'primary',
            dir: 1,
            warmFrames: 0,
            fade: { value: 0 },
            out: { value: 0 },
          }
          entriesRef.current.push(incoming)
        }
        // Smoothness guard: overlapping two heavy fullscreen scenes through a
        // crossfade is a major frame-time spike. When the quality governor only
        // permits one heavy layer and both scenes are heavy, hard-cut on the beat
        // instead — snap the outgoing out and the (shader-warm) incoming in. It's
        // cheaper and, per docs/09_Rendering_Engine.md, the more deliberate "Ikeda" look.
        const bothHeavy =
          !!outgoing &&
          getScene(outgoing.id).metadata.performanceCost === 'high' &&
          getScene(incoming.id).metadata.performanceCost === 'high'
        const hardCut = bothHeavy && quality.knobs.maxHeavyLayers < 2
        if (hardCut) {
          if (outgoing) outgoing.fade.value = 0
          incoming.fade.value = 1
        }
        beginTransition(
          {
            key: incoming.key,
            fromScene: outgoing?.id ?? null,
            toScene: pendingSceneId,
            onDownbeat,
            hardCut,
            waitedSec: waited,
            targetDurationSec: crossfadeDuration(f.bpm),
          },
          clock.elapsedTime,
        )
        force((n) => n + 1)
      }
    } else {
      pendingSince.current = -1
      // No pending switch — discard any orphaned warming entry.
      if (entriesRef.current.some((e) => e.dir === 0)) {
        entriesRef.current = entriesRef.current.filter((e) => e.dir !== 0)
        force((n) => n + 1)
      }
    }

    // Persistent accent/overlay layers are composed independently from the
    // primary scene. A layer change gets a short fade, while the primary scene
    // continues to use beat-locked transitions above.
    const desiredLayers: { role: LayerRole; id: string | null }[] = [
      { role: 'accent', id: state.accentSceneId },
      { role: 'overlay', id: state.overlaySceneId },
    ]
    for (const desired of desiredLayers) {
      const current = entriesRef.current.find((e) => e.role === desired.role && e.dir === 1)
      if (current?.id === desired.id) continue
      if (current) current.dir = -1
      if (desired.id && desired.id !== state.sceneId && desired.id !== state.pendingSceneId) {
        entriesRef.current.push({
          key: entryKey++,
          id: desired.id,
          role: desired.role,
          dir: 1,
          warmFrames: 0,
          fade: { value: 0 },
          out: { value: 0 },
        })
        force((n) => n + 1)
      }
    }

    // Crossfade over ~two beats when the tempo is known, then weight each
    // entry by its layer intensity (primary is always full strength).
    const duration = crossfadeDuration(f.bpm)
    let prune = false
    for (const e of entriesRef.current) {
      if (e.dir === 0) continue // warming: stays at zero until promoted
      e.fade.value += (f.delta / duration) * e.dir
      if (e.fade.value >= 1) e.fade.value = 1
      if (e.fade.value <= 0 && e.dir === -1) prune = true
      const gain = e.role === 'primary' ? 1 : state.layerFx[e.role].intensity
      e.out.value = Math.max(0, e.fade.value) * gain
      if (e.role === 'primary' && e.dir === 1) {
        sampleTransitionFrame(e.key, perf.ms, e.fade.value, clock.elapsedTime)
      }
    }
    if (prune) {
      entriesRef.current = entriesRef.current.filter((e) => !(e.dir === -1 && e.fade.value <= 0))
      force((n) => n + 1)
    }
  }, -100)

  return (
    <>
      {entriesRef.current.map((e) => {
        const Scene = getScene(e.id).component
        return (
          <SceneFade.Provider key={e.key} value={e.out}>
            <EntryGroup entry={e}>
              <Suspense fallback={null}>
                {e.role === 'primary' ? (
                  <Scene />
                ) : (
                  <BlendedLayer role={e.role}>
                    <Scene />
                  </BlendedLayer>
                )}
              </Suspense>
            </EntryGroup>
          </SceneFade.Provider>
        )
      })}
    </>
  )
}
