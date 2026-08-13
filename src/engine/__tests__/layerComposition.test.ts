import { describe, expect, it } from 'vitest'
import { composeLayers } from '../PerformanceDirector'
import { resolveLayerIds } from '../SceneManager'
import { getScene, type SceneDef } from '../../scenes'

/**
 * Layer-composition invariants.
 *
 * The originals here covered a two-slot, mutually-exclusive model where the
 * only failure mode was "a slot never got cleared" (which showed up as a scene
 * playing on top of everything). With three slots that can be occupied at once,
 * the collision rule becomes all-pairs — two LAYERS can now duplicate each
 * other, which was structurally impossible before.
 */
const scene = (id: string) => getScene(id)

describe('resolveLayerIds — all-pairs collision', () => {
  it('drops a layer that duplicates the committed primary', () => {
    const out = resolveLayerIds(
      { background: null, accent: 'wireframe', overlay: null },
      'wireframe',
      null,
    )
    expect(out.accent).toBeNull()
  })

  it('drops a layer that duplicates a pending primary', () => {
    // The collision can appear *after* the layer mounted, when the primary
    // switches to that same scene — the case a creation-time-only guard misses,
    // leaving the scene mounted twice and compositing over itself.
    const out = resolveLayerIds(
      { background: null, accent: 'wireframe', overlay: null },
      'chrome',
      'wireframe',
    )
    expect(out.accent).toBeNull()
  })

  it('drops a later slot that duplicates an earlier one', () => {
    // New with three slots: nothing stopped two layers naming the same scene.
    const out = resolveLayerIds(
      { background: 'ribbons', accent: 'ribbons', overlay: 'ribbons' },
      'wireframe',
      null,
    )
    expect(out).toEqual({ background: 'ribbons', accent: null, overlay: null })
  })

  it('keeps distinct, non-colliding layers', () => {
    const out = resolveLayerIds(
      { background: 'network', accent: 'ribbons', overlay: null },
      'wireframe',
      'chrome',
    )
    expect(out).toEqual({ background: 'network', accent: 'ribbons', overlay: null })
  })

  it('passes empty slots straight through', () => {
    expect(resolveLayerIds({ background: null, accent: null, overlay: null }, 'wireframe', null))
      .toEqual({ background: null, accent: null, overlay: null })
  })
})

describe('composeLayers', () => {
  const base = {
    mood: 'groove' as const,
    recentIds: [] as string[],
    budget: 8,
  }

  it('leaves a slot unfilled when its pool is empty', () => {
    // The steady state today: no background scenes are registered at all.
    const out = composeLayers({
      ...base,
      primaryCost: 'low',
      pools: { background: [], accent: [scene('ribbons')] },
    })
    expect(out.background).toBeNull()
    expect(out.accent).toBe('ribbons')
  })

  it('fills accent and overlay together — they are no longer exclusive', () => {
    const out = composeLayers({
      ...base,
      primaryCost: 'low',
      pools: { accent: [scene('ribbons')], overlay: [scene('network')] },
    })
    expect(out.accent).toBe('ribbons')
    expect(out.overlay).toBe('network')
  })

  it('runs a heavy primary solo at a tight budget', () => {
    // high primary = 4 units, budget 4 → nothing left over.
    const out = composeLayers({
      ...base,
      budget: 4,
      primaryCost: 'high',
      pools: { accent: [scene('ribbons')], overlay: [scene('network')] },
    })
    expect(out).toEqual({ background: null, accent: null, overlay: null })
  })

  it('honours the priority override when only one slot fits', () => {
    // low primary (1) + budget 2 leaves room for exactly one low layer.
    const pools = { accent: [scene('ribbons')], overlay: [scene('network')] }
    const accentFirst = composeLayers({ ...base, budget: 2, primaryCost: 'low', pools })
    expect(accentFirst.accent).toBe('ribbons')
    expect(accentFirst.overlay).toBeNull()

    const overlayFirst = composeLayers({
      ...base,
      budget: 2,
      primaryCost: 'low',
      pools,
      priority: ['background', 'overlay', 'accent'],
    })
    expect(overlayFirst.overlay).toBe('network')
    expect(overlayFirst.accent).toBeNull()
  })

  it('never returns a scene the pool did not contain', () => {
    const pool: SceneDef[] = [scene('ribbons')]
    const out = composeLayers({ ...base, primaryCost: 'low', pools: { accent: pool } })
    expect([null, 'ribbons']).toContain(out.accent)
  })
})
