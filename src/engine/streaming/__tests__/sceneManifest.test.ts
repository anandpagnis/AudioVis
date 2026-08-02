import { describe, expect, it } from 'vitest'
import { resolveManifest } from '../sceneManifest'

describe('resolveManifest', () => {
  it('fills every field from performanceCost when nothing is declared', () => {
    const m = resolveManifest('low')
    expect(m.assets).toEqual([])
    expect(m.priority).toBe(0)
    expect(m.cost.source).toBe('estimated')
    expect(m.cost.vramMB).toBeGreaterThan(0)
    expect(m.estPreloadMs).toBeGreaterThan(0)
  })

  it('scales the default cost with performanceCost — high costs more than low', () => {
    const low = resolveManifest('low')
    const high = resolveManifest('high')
    expect(high.cost.vramMB).toBeGreaterThan(low.cost.vramMB)
    expect(high.cost.buildMs).toBeGreaterThan(low.cost.buildMs)
    expect(high.estPreloadMs).toBeGreaterThan(low.estPreloadMs)
  })

  it('a declared field overrides its default without disturbing the others', () => {
    const m = resolveManifest('medium', { priority: 5 })
    expect(m.priority).toBe(5)
    expect(m.cost).toEqual(resolveManifest('medium').cost)
  })

  it('a fully declared manifest is used verbatim', () => {
    const declared = {
      assets: [{ type: 'gltf' as const, url: '/model.glb', estBytes: 1_000_000 }],
      priority: 9,
      estPreloadMs: 500,
      cost: { vramMB: 100, buildMs: 20, source: 'measured' as const },
    }
    const m = resolveManifest('high', declared)
    expect(m).toEqual(declared)
  })
})
