import { beforeEach, describe, expect, it } from 'vitest'
import { audioEngine } from '../../audio/AudioEngine'
import { DEFAULT_COUPLING, REF_BPM } from '../../audio/tempoSpeed'
import { createEmptyFeatures } from '../../audio/types'
import { getEffectiveParams } from '../moodParams'
import { performanceState } from '../performanceState'
import { currentTempoRate } from '../tempoRate'
import { useStore } from '../../store'

const OCT_160 = Math.log2(160 / REF_BPM)

/** Reset audio features, the look profile and the relevant store slice to a known, neutral state before each case. */
function reset() {
  Object.assign(audioEngine.features, createEmptyFeatures())
  performanceState.look.valid = false
  performanceState.look.tempoCoupling = DEFAULT_COUPLING
  useStore.setState({
    params: { intensity: 1, speed: 1, reactivity: 1 },
    bandMappings: [],
    moodDrive: false,
  })
}

function setLook(coupling: number) {
  performanceState.look.valid = true
  performanceState.look.tempoCoupling = coupling
}

describe('currentTempoRate', () => {
  beforeEach(reset)

  it('is exactly 1 with the neutral tempo default, whatever the coupling', () => {
    expect(currentTempoRate()).toBe(1)
    setLook(1)
    expect(currentTempoRate()).toBe(1)
  })

  it('uses the default coupling while no valid mood look exists', () => {
    audioEngine.features.tempoOctaves = OCT_160
    expect(currentTempoRate()).toBeCloseTo(2 ** (DEFAULT_COUPLING * OCT_160), 9)
  })

  it("scales with the live look's tempoCoupling: driving-like races, dreamy-like stays floaty, 0 ignores tempo", () => {
    audioEngine.features.tempoOctaves = OCT_160
    setLook(1)
    expect(currentTempoRate()).toBeCloseTo(160 / 120, 9)
    setLook(0.3)
    const dreamy = currentTempoRate()
    expect(dreamy).toBeGreaterThan(1)
    expect(dreamy).toBeLessThan(1.15)
    setLook(0)
    expect(currentTempoRate()).toBe(1)
  })

  it('slows a slow track, harder for a higher coupling', () => {
    audioEngine.features.tempoOctaves = Math.log2(80 / REF_BPM)
    setLook(0.3)
    const soft = currentTempoRate()
    setLook(1)
    const hard = currentTempoRate()
    expect(soft).toBeLessThan(1)
    expect(hard).toBeLessThan(soft)
  })
})

describe('getEffectiveParams — tempo speed', () => {
  beforeEach(reset)

  it('a neutral tempo (the createEmptyFeatures default) leaves speed untouched', () => {
    expect(getEffectiveParams().speed).toBeCloseTo(1, 9)
  })

  it('multiplies the mood-coupled tempo rate into speed', () => {
    audioEngine.features.tempoOctaves = OCT_160
    setLook(1)
    expect(getEffectiveParams().speed).toBeCloseTo(160 / 120, 9)
    setLook(0)
    expect(getEffectiveParams().speed).toBeCloseTo(1, 9)
  })

  it('applies whether moodDrive is on or off — tempo is an independent signal, not a mood one', () => {
    audioEngine.features.tempoOctaves = Math.log2(90 / REF_BPM)
    setLook(1)
    useStore.setState({ moodDrive: false })
    const off = getEffectiveParams().speed
    useStore.setState({ moodDrive: true })
    audioEngine.features.mood.vizLook.speed = 1 // neutral mood multiplier, isolates the tempo term
    const on = getEffectiveParams().speed
    expect(off).toBeCloseTo(90 / 120, 9)
    expect(on).toBeCloseTo(90 / 120, 9)
  })

  it('composes multiplicatively with the mood multiplier and the user speed dial', () => {
    useStore.setState({ params: { intensity: 1, speed: 0.5, reactivity: 1 }, moodDrive: true })
    audioEngine.features.mood.vizLook.speed = 1.2
    audioEngine.features.tempoOctaves = OCT_160
    setLook(1)
    expect(getEffectiveParams().speed).toBeCloseTo(0.5 * 1.2 * (160 / 120), 9)
  })

  it('is clamped like every other effective param, even at the extremes of both mood and tempo', () => {
    useStore.setState({ params: { intensity: 1, speed: 1, reactivity: 1 }, moodDrive: true })
    audioEngine.features.mood.vizLook.speed = 10
    audioEngine.features.tempoOctaves = 1
    setLook(1.2)
    const v = getEffectiveParams().speed
    expect(Number.isFinite(v)).toBe(true)
    expect(v).toBeLessThanOrEqual(2.2)
  })
})
