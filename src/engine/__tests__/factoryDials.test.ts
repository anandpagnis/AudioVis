import { describe, expect, it } from 'vitest'
import { drastic, resolveFactoryDials, SCENE_PARAM_KEYS, type ResolvedSceneParams } from '../sceneParams'

function dials(over: Partial<ResolvedSceneParams> = {}): ResolvedSceneParams {
  const out = { mode: '', modeIndex: 0 } as ResolvedSceneParams
  for (const k of SCENE_PARAM_KEYS) out[k] = 0.5
  return Object.assign(out, over)
}

describe('resolveFactoryDials', () => {
  it('takes the seven dials from the live (steered) set, not the base set', () => {
    const into = dials()
    const base = dials({ complexity: 0.5, density: 0.5, fill: 0.5, contrast: 0.5 })
    const live = dials({ complexity: 0.8, density: 0.2, fill: 0.7, contrast: 0.9 })
    resolveFactoryDials(into, base, live, 1, false)
    expect(into.complexity).toBe(0.8)
    expect(into.density).toBe(0.2)
    expect(into.fill).toBe(0.7)
    expect(into.contrast).toBe(0.9)
  })

  it('takes mode and modeIndex from the base set (the steered set carries neither)', () => {
    const into = dials()
    const base = dials({ mode: 'ribbons', modeIndex: 2 })
    const live = { ...dials(), mode: '', modeIndex: 0 } as ResolvedSceneParams
    resolveFactoryDials(into, base, live, 1, false)
    expect(into.mode).toBe('ribbons')
    expect(into.modeIndex).toBe(2)
  })

  it('folds the global speed into speed as an exact multiplier on drastic()', () => {
    const into = dials()
    resolveFactoryDials(into, dials(), dials({ speed: 0.3 }), 1.4, false)
    expect(drastic(into.speed)).toBeCloseTo(drastic(0.3) * 1.4, 9)
  })

  it('leaves speed at the steered dial when the global speed is 1', () => {
    const into = dials()
    resolveFactoryDials(into, dials(), dials({ speed: 0.37 }), 1, false)
    expect(into.speed).toBe(0.37)
  })

  it('a tempo-locked scene gets no fold: its steered dial passes through untouched', () => {
    const into = dials()
    resolveFactoryDials(into, dials(), dials({ speed: 0.5 }), 1.4, true)
    expect(into.speed).toBe(0.5)
  })

  it('is rebuilt from scratch every call: nothing from a previous frame survives', () => {
    const into = dials()
    resolveFactoryDials(into, dials({ mode: 'a', modeIndex: 1 }), dials({ complexity: 0.9, speed: 0.9 }), 2, false)
    resolveFactoryDials(into, dials({ mode: 'b', modeIndex: 0 }), dials({ complexity: 0.1, speed: 0.1 }), 1, false)
    expect(into.complexity).toBe(0.1)
    expect(into.speed).toBe(0.1)
    expect(into.mode).toBe('b')
  })

  it('does not mutate the base or live sets', () => {
    const base = dials({ speed: 0.4 })
    const live = dials({ speed: 0.6 })
    resolveFactoryDials(dials(), base, live, 1.5, false)
    expect(base.speed).toBe(0.4)
    expect(live.speed).toBe(0.6)
  })
})
