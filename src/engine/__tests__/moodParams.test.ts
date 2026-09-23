import { beforeEach, describe, expect, it } from 'vitest'
import { audioEngine } from '../../audio/AudioEngine'
import { createEmptyFeatures } from '../../audio/types'
import { getEffectiveParams } from '../moodParams'
import { useStore } from '../../store'

/** Reset audio features and the relevant store slice to a known, neutral state before each case. */
function reset() {
  Object.assign(audioEngine.features, createEmptyFeatures())
  useStore.setState({
    params: { intensity: 1, speed: 1, reactivity: 1 },
    bandMappings: [],
    moodDrive: false,
  })
}

describe('getEffectiveParams — tempo speed', () => {
  beforeEach(reset)

  it('tempoSpeed=1 (neutral, the createEmptyFeatures default) leaves speed untouched', () => {
    expect(getEffectiveParams().speed).toBeCloseTo(1, 9)
  })

  it('multiplies tempoSpeed into speed', () => {
    audioEngine.features.tempoSpeed = 1.25
    expect(getEffectiveParams().speed).toBeCloseTo(1.25, 9)
  })

  it('applies whether moodDrive is on or off — tempo is an independent signal, not a mood one', () => {
    audioEngine.features.tempoSpeed = 0.8
    useStore.setState({ moodDrive: false })
    const off = getEffectiveParams().speed
    useStore.setState({ moodDrive: true })
    audioEngine.features.mood.vizLook.speed = 1 // neutral mood multiplier, isolates the tempo term
    const on = getEffectiveParams().speed
    expect(off).toBeCloseTo(0.8, 9)
    expect(on).toBeCloseTo(0.8, 9)
  })

  it('composes multiplicatively with the mood multiplier and the user speed dial', () => {
    useStore.setState({ params: { intensity: 1, speed: 0.5, reactivity: 1 }, moodDrive: true })
    audioEngine.features.mood.vizLook.speed = 1.2
    audioEngine.features.tempoSpeed = 1.1
    expect(getEffectiveParams().speed).toBeCloseTo(0.5 * 1.2 * 1.1, 9)
  })

  it('is clamped like every other effective param, even at the extremes of both mood and tempo', () => {
    useStore.setState({ params: { intensity: 1, speed: 1, reactivity: 1 }, moodDrive: true })
    audioEngine.features.mood.vizLook.speed = 10
    audioEngine.features.tempoSpeed = 10
    const v = getEffectiveParams().speed
    expect(Number.isFinite(v)).toBe(true)
    // Whatever the clamp's exact ceiling, an absurd input must not pass through unclamped.
    expect(v).toBeLessThan(100)
  })
})
