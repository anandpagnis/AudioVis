import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { audioEngine } from '../audio/AudioEngine'
import { getAudioResponse } from './audioResponse'
import { cueState } from './CueTimeline'
import { quality } from './quality'
import { getCompatibleScenes, getScene, getScenesForMood } from '../scenes'
import { useStore } from '../store'

const MANUAL_HOLD_SEC = 45
const PHRASE_HOLD_BEATS = 16 // fallback recompose cadence when no section fires

/**
 * Phrase-level scene composer. A true section change recomposes instantly; when
 * the track offers no section boundary it recomposes at most once per phrase
 * (16 beats). SceneManager handles the exact downbeat commit and crossfade.
 * There is no wall-clock hold — pacing is measured in beats so it tracks the
 * song, not the clock.
 */
export function PerformanceDirector() {
  const lastBoundaryBeat = useRef(-1)
  const lastSwitchBeat = useRef(-Infinity)

  useFrame(() => {
    const f = audioEngine.features
    const s = useStore.getState()
    // Note: we do NOT bail on a pending primary switch here. Layer composition
    // must still run while AutoPilot's scene change commits, otherwise the
    // accent/overlay layers (only set here) almost never appear.
    if (!s.autoPilot || s.status !== 'running' || f.silence) return
    if (cueState.governed) return // authored cues own the journey
    if (f.time - s.lastManualAt < MANUAL_HOLD_SEC) return

    const phraseFallback = f.beat && f.beatInBar === 0 && f.beatIndex > 0 && f.beatIndex % 16 === 0
    const boundary = f.sectionChange || phraseFallback
    if (!boundary || f.beatIndex === lastBoundaryBeat.current) return
    lastBoundaryBeat.current = f.beatIndex

    // Section changes cut immediately; the periodic fallback respects a light
    // one-phrase spacing so calm stretches aren't over-recomposed.
    if (!f.sectionChange && f.beatIndex - lastSwitchBeat.current < PHRASE_HOLD_BEATS) return

    const response = getAudioResponse(f)
    const moodFits = getScenesForMood(
      f.mood.predictedState === 'silence' ? f.mood.state : f.mood.predictedState,
    )
    const compatible = getCompatibleScenes(s.sceneId)
    const pool = moodFits.filter((scene) =>
      compatible.some((candidate) => candidate.id === scene.id),
    )
    const candidates = (pool.length > 0 ? pool : moodFits).filter((scene) => scene.id !== s.sceneId)
    if (candidates.length === 0) return

    // Prefer scenes that express the strongest current musical layer, then
    // let a small tie-break vary the journey between repeated sections.
    const band =
      response.sub > response.bass * 0.9
        ? 'bass'
        : response.high > response.mid
          ? 'high'
          : response.vocal > 0.5
            ? 'vocal'
            : response.energy > 0.6
              ? 'energy'
              : 'mid'
    const ranked = candidates.slice().sort((a, b) => {
      const aBand = a.metadata.bands.includes(band) ? 1 : 0
      const bBand = b.metadata.bands.includes(band) ? 1 : 0
      return bBand - aBand
    })

    // Only pick a new primary when one isn't already mid-commit; otherwise we'd
    // fight AutoPilot's in-flight switch. Either way we (re)compose the layers
    // against whichever primary is landing.
    let primaryId = s.pendingSceneId ?? s.sceneId
    if (!s.pendingSceneId) {
      const pick = ranked[Math.min(ranked.length - 1, f.bar % Math.min(2, ranked.length))]
      s.requestScene(pick.id, { auto: true })
      primaryId = pick.id
    }

    // Composition budget: how many high-cost scenes may render at once, from the
    // quality governor. If the primary is already heavy and the budget is tight,
    // run it solo — this both preserves visual breathing room and keeps heavy
    // scenes from stacking during the crossfade (a major stutter source).
    const primaryHeavy = getScene(primaryId).metadata.performanceCost === 'high'
    const allowLayer = quality.knobs.maxHeavyLayers >= 2 || !primaryHeavy

    const layerRole = response.energy > 0.58 || response.dropPulse > 0 ? 'overlay' : 'accent'
    const layerPick = allowLayer
      ? candidates.find(
          (scene) => scene.id !== primaryId && scene.metadata.roles.includes(layerRole),
        )
      : undefined
    if (layerPick) s.setLayer(layerRole, layerPick.id, { auto: true })
    else s.setLayer(layerRole, null, { auto: true })
    if (layerRole === 'accent' || !allowLayer) s.setLayer('overlay', null, { auto: true })
    lastSwitchBeat.current = f.beatIndex
  }, -85)

  return null
}
