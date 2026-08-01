import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { audioEngine, beatPulse } from '../audio/AudioEngine'
import type { MoodState } from '../audio/types'
import { getScene } from '../scenes'
import { cutCamera, pickCameraMode } from './CameraDirector'
import { getEffectiveParams } from './moodParams'
import { approach, performanceState } from './performanceState'
import { quality } from './quality'
import { useStore } from '../store'

/**
 * Resting bloom per mood — the creative decision the old formula's hardcoded
 * 0.65 was standing in for. Quiet moods sit darker so the music has somewhere
 * to go; hype moods start hot and stay there between hits.
 */
const BLOOM_BASE: Record<MoodState, number> = {
  silence: 0.4,
  ambient: 0.5,
  mellow: 0.55,
  groove: 0.65,
  building: 0.75,
  peak: 0.95,
  aggressive: 0.9,
}

/**
 * Populates {@link performanceState} once per frame.
 *
 * This is the Phase-1 adapter: it derives the performance state from where
 * those decisions currently live (the Zustand store, the mood engine, the
 * quality governor) so downstream executors can be migrated to read
 * `performanceState` one at a time, with zero behaviour change at each step.
 *
 * The end state (Phase 6) inverts this: the creative directors write
 * `performanceState` directly and the store becomes just the human-override
 * surface feeding into it. When that happens this file shrinks to nothing —
 * which is the point. Everything downstream is already reading the right
 * object by then, so the inversion touches no executor.
 *
 * Runs at −95: after SceneManager's audio tick (−100), before the creative
 * directors (−90 … −85) and well before any executor.
 */
export function PerformanceStateBridge() {
  /** Visible scene the current camera mode was chosen for. */
  const lastCameraScene = useRef('')

  useFrame(() => {
    const f = audioEngine.features
    const s = useStore.getState()
    const params = getEffectiveParams()
    const p = performanceState
    const m = f.mood

    // --- What is on screen (currently owned by the store) ---
    p.scene = s.pendingSceneId ?? s.sceneId
    p.activeScene = s.sceneId
    p.accent = s.accentSceneId
    p.overlay = s.overlaySceneId
    p.palette = s.paletteId
    p.mood = m.state

    // --- Behaviour ---
    p.animationIntensity = params.intensity
    p.particleDensity = quality.knobs.particleFraction

    // Dramatic pressure, not loudness: a build with rising energy is tense even
    // while quiet, and a drop is the release. Consumed by the camera pick below,
    // by AnimationDirector's explode/dissolve primitives, and by glitch.
    const buildTension = m.isBuilding ? 0.35 + Math.max(0, m.energyVel) * 0.4 : 0
    const predictionTension =
      m.predictedState === 'peak' && m.beatsTillTransition >= 0
        ? Math.max(0, 1 - m.beatsTillTransition / 16) * 0.5
        : 0
    p.visualTension = Math.min(1, Math.max(buildTension, predictionTension) + (f.drop ? 0.5 : 0))

    // --- Camera ---
    // Which mode to shoot in is a DECISION, re-taken at section boundaries and
    // whenever the visible scene changes (a new scene may not declare the mode
    // that was running). Deliberately NOT re-evaluated every frame: a mode that
    // flickers reads as noise, and CameraDirector eases toward its target, so
    // the target has to hold still long enough to converge on.
    //
    // This runs regardless of AutoPilot. Framing is not one of the choices the
    // user is overriding when they pick a scene by hand, so it should keep
    // being directed either way.
    const active = getScene(p.activeScene)
    if (f.sectionChange || active.id !== lastCameraScene.current) {
      lastCameraScene.current = active.id
      p.cameraMode = pickCameraMode(
        active.metadata.cameraModes,
        m.state,
        p.visualTension,
        f.beatIndex,
      )
      // A section boundary is the one moment a hard angle jump reads as
      // deliberate rather than as a glitch — this is the VJ cut.
      if (f.sectionChange) cutCamera()
    }

    // --- Post / effects ---
    // Phase 4: these are DECISIONS, not a transcription of the audio. The base
    // level is chosen per mood, and the music modulates around it — so a
    // breakdown reads calm even if its transients are sharp, and a peak reads
    // hot even between hits. EffectsDirector just applies the result.
    const pulse = beatPulse(f) * params.reactivity
    const reactive = (f.bass * 0.7 + pulse * 0.7 + (f.drop ? 0.8 : 0)) * params.reactivity
    p.bloom = (BLOOM_BASE[m.state] + reactive) * params.intensity

    // Glitch is punctuation, so it is gated on tension and drops rather than
    // running continuously. Low quality zeroes it — the pass stays in the chain
    // (removing it would rebuild the composer's shader), it just does nothing.
    p.glitch =
      s.quality === 'low'
        ? 0
        : 0.0006 + pulse * 0.0035 + p.visualTension * 0.002 + (f.drop ? 0.004 : 0)

    // Fog deepens as the music thins out — an empty mix gets air around the
    // subject, a dense one stays close and flat.
    const sparse = 1 - Math.min(1, m.level * 1.3)
    p.fog = approach(p.fog, sparse * 0.6 + (m.state === 'ambient' ? 0.25 : 0), 0.6, f.delta)

    // Distortion tracks tension so a build visibly strains before it releases.
    p.distortion = approach(p.distortion, p.visualTension * 0.8, 1.5, f.delta)
  }, -95)

  return null
}
