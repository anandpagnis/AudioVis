import { audioEngine, beatPulse } from '../audio/AudioEngine'
import type { AudioFeatures } from '../audio/types'
import { useStore, type BandSource, type VisualParams } from '../store'

const out: VisualParams = { intensity: 1, speed: 1, reactivity: 1 }

function sourceValue(f: AudioFeatures, source: BandSource): number {
  switch (source) {
    case 'sub':
      return f.sub
    case 'bass':
      return f.bass
    case 'mid':
      return f.mid
    case 'presence':
      return f.presence
    case 'high':
      return f.high
    case 'vocal':
      return f.vocal
    case 'energy':
      return f.energy
    case 'transient':
      return f.transient
    case 'beatPulse':
      return Math.min(1, beatPulse(f))
  }
}

/**
 * The user's tune-panel params with the mood's smoothed multipliers and the
 * declarative band mappings layered on top. Scenes call this instead of
 * reading `params` off the store, so the whole app leans with the music
 * through one choke point. Returns a reused object — read it, don't hold it.
 */
export function getEffectiveParams(): VisualParams {
  const { params, moodDrive, bandMappings } = useStore.getState()
  const f = audioEngine.features

  if (moodDrive) {
    const viz = f.mood.viz
    out.intensity = params.intensity * viz.intensity
    out.speed = params.speed * viz.speed
    out.reactivity = params.reactivity * viz.reactivity
  } else {
    out.intensity = params.intensity
    out.speed = params.speed
    out.reactivity = params.reactivity
  }

  // Band routing: each mapping scales its target by 1 + amount × envelope.
  for (const m of bandMappings) {
    if (m.amount !== 0) out[m.target] *= 1 + m.amount * sourceValue(f, m.source)
  }

  out.intensity = clamp(out.intensity)
  out.speed = clamp(out.speed)
  out.reactivity = clamp(out.reactivity)
  return out
}

function clamp(v: number): number {
  return Math.min(2.2, Math.max(0.15, v))
}
