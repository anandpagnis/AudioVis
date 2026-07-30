import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { audioEngine } from '../audio/AudioEngine'
import type { MoodState } from '../audio/types'
import { cueState } from './CueTimeline'
import { PALETTES } from './palettes'
import { getScenesForMood } from '../scenes'
import { useStore } from '../store'

/** Palette families per mood — switched only when the current one doesn't fit. */
const MOOD_PALETTES: Record<MoodState, string[]> = {
  silence: [],
  ambient: ['ocean', 'aurora', 'mono'],
  mellow: ['aurora', 'violet', 'ocean'],
  groove: ['aurora', 'violet', 'solar'],
  building: ['solar', 'aurora', 'ember'],
  peak: ['ember', 'solar', 'violet'],
  aggressive: ['ember', 'solar', 'mono'],
}

const MANUAL_HOLD_SEC = 45 // back off after the DJ touches anything

/**
 * Mood-driven auto-VJ. Watches the committed mood (and its prediction) and
 * requests scene/palette changes through the normal pipeline. Switching is
 * purely event-driven — a mood change, an imminent predicted transition, or a
 * drop each fire an immediate request. There is deliberately NO time cooldown:
 * SceneManager commits every request on the next downbeat, so the bar is the
 * natural rate limiter and the visuals can react as fast as the song does.
 * Backs off whenever the user drives manually.
 */
export function AutoPilot() {
  const handledChange = useRef(-1)
  const prefetchedFor = useRef<MoodState | null>(null)
  const prevDrop = useRef(false)

  useFrame(() => {
    const f = audioEngine.features
    const m = f.mood
    const s = useStore.getState()
    // Rising-edge drop detection must track even while suppressed, so a drop
    // that lands during the manual hold doesn't fire the instant it lifts.
    const dropEdge = f.drop && !prevDrop.current
    prevDrop.current = f.drop

    if (!s.autoPilot || s.status !== 'running' || f.silence) return
    if (cueState.governed) return // authored cues own the journey
    if (f.time - s.lastManualAt < MANUAL_HOLD_SEC) return

    // Decide what mood to aim visuals at, in priority order:
    //   1) a drop — cut to a high-energy scene the instant it lands;
    //   2) an imminent predicted transition — so the crossfade lands on it;
    //   3) the committed state the moment it changes.
    let target: MoodState | null = null

    if (dropEdge) {
      target = m.state === 'aggressive' || m.predictedState === 'aggressive' ? 'aggressive' : 'peak'
      prefetchedFor.current = null
    } else {
      const imminent =
        m.predictedState !== m.state &&
        m.beatsTillTransition >= 0 &&
        m.beatsTillTransition < 4 &&
        m.confidence > 0.5
      if (imminent && prefetchedFor.current !== m.predictedState) {
        target = m.predictedState
        prefetchedFor.current = m.predictedState
      } else if (m.changed && m.changeCount !== handledChange.current) {
        handledChange.current = m.changeCount
        target = m.state
        prefetchedFor.current = null
      }
    }
    if (!target) return

    // Pick among the top fits, skipping whatever is already showing/pending.
    const options = getScenesForMood(target)
      .map((scene) => scene.id)
      .filter((id) => id !== s.sceneId && id !== s.pendingSceneId)
    if (options.length > 0) {
      const pick =
        options.length > 1 && Math.random() < 0.3 ? options[1] : options[0]
      s.requestScene(pick, { auto: true })
    }

    // Nudge the palette into the mood's family if it's out of place.
    const palettes = MOOD_PALETTES[target]
    if (palettes.length > 0 && !palettes.includes(s.paletteId)) {
      const valid = palettes.filter((id) => PALETTES.some((p) => p.id === id))
      if (valid.length > 0) {
        s.setPalette(valid[Math.floor(Math.random() * Math.min(2, valid.length))], { auto: true })
      }
    }
  }, -90) // right after the audio engine tick (-100), before scenes
  return null
}
