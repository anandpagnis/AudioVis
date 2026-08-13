import { describe, expect, it } from 'vitest'
import { resolveLayerSlots } from '../PerformanceDirector'
import { resolveLayerId } from '../SceneManager'

/**
 * Layer-composition invariants.
 *
 * Both rules below were violated in ways that showed up as "a scene is playing
 * on top of everything", and neither was visible to typecheck, lint or the
 * existing suite — the offending code compiled and ran fine, it just never tore
 * a layer down.
 */
describe('PerformanceDirector layer slots', () => {
  it('clears the accent when the director switches to overlay mode', () => {
    // An accent is set during a low-energy section...
    expect(resolveLayerSlots('accent', 'wireframe')).toEqual({
      accent: 'wireframe',
      overlay: null,
    })
    // ...then energy rises and the director switches to overlay mode. The old
    // accent must not survive — that was "wireframe on top of everything".
    expect(resolveLayerSlots('overlay', 'ribbons')).toEqual({
      accent: null,
      overlay: 'ribbons',
    })
  })

  it('clears the overlay when the director switches back to accent mode', () => {
    expect(resolveLayerSlots('accent', 'wireframe')).toEqual({
      accent: 'wireframe',
      overlay: null,
    })
  })

  it('leaves both slots empty when no layer is picked', () => {
    expect(resolveLayerSlots('overlay', null)).toEqual({ accent: null, overlay: null })
    expect(resolveLayerSlots('accent', null)).toEqual({ accent: null, overlay: null })
  })

  it('never occupies both slots at once', () => {
    for (const role of ['accent', 'overlay'] as const) {
      const slots = resolveLayerSlots(role, 'wireframe')
      const occupied = Object.values(slots).filter(Boolean)
      expect(occupied).toHaveLength(1)
    }
  })
})

describe('SceneManager layer/primary collision', () => {
  it('drops a layer that duplicates the committed primary', () => {
    expect(resolveLayerId('wireframe', 'wireframe', null)).toBeNull()
  })

  it('drops a layer that duplicates a pending primary', () => {
    // The collision can appear *after* the layer mounted, when the primary
    // switches to that same scene — the case a creation-time-only guard misses,
    // leaving the scene mounted twice and compositing over itself.
    expect(resolveLayerId('wireframe', 'chrome', 'wireframe')).toBeNull()
  })

  it('keeps a layer that does not collide', () => {
    expect(resolveLayerId('ribbons', 'wireframe', null)).toBe('ribbons')
    expect(resolveLayerId('ribbons', 'wireframe', 'chrome')).toBe('ribbons')
  })

  it('passes an empty slot straight through', () => {
    expect(resolveLayerId(null, 'wireframe', null)).toBeNull()
  })
})
