import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { audioEngine } from '../audio/AudioEngine'
import { useStore, type PerformanceCue } from '../store'

/**
 * True while an authored cue governs the composition. AutoPilot and the
 * PerformanceDirector check this and stand down, so authored moments always
 * win; automation resumes ~32 beats after the last cue fires (fallback per
 * the handoff spec).
 */
export const cueState = { governed: false }

/**
 * Phase 5: authored performance playback. Cues are anchored to beat positions
 * counted from source start; when the beat counter crosses a cue, its full
 * look (scene, layers, palette, params, layer FX) is applied through the
 * normal pipeline — so scene changes still commit on downbeats and crossfade.
 */
export function CueTimeline() {
  const appliedId = useRef<string | null>(null)

  useFrame(() => {
    const s = useStore.getState()
    const f = audioEngine.features

    if (!s.cueFollow || s.cues.length === 0 || s.status !== 'running') {
      cueState.governed = false
      appliedId.current = null
      return
    }

    const beat = f.beatIndex + f.beatProgress
    let current: PerformanceCue | null = null
    let next: PerformanceCue | null = null
    for (const c of s.cues) {
      if (c.beat <= beat) current = c
      else {
        next = c
        break
      }
    }

    // Governed while inside the authored region; after the final cue the
    // director takes back over once 32 beats pass without another cue.
    cueState.governed = current !== null && (next !== null || beat - current.beat <= 32)

    if (current && appliedId.current !== current.id) {
      appliedId.current = current.id
      s.applyCue(current)
    }
    if (!current) appliedId.current = null
  }, -88) // after AutoPilot (-90), before PerformanceDirector (-85)

  return null
}
