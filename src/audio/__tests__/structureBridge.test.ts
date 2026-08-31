import { describe, expect, it } from 'vitest'
import { structureBridge } from '../essentia/StructureBridge'
import { createEmptyFeatures } from '../types'

/**
 * The bridge's schedule/drain policy is pure logic and testable without a
 * worker or WASM: with nothing attached there is no ring, so `update()` must
 * return `null` every frame and never touch the worker. This is the
 * "fails silent" contract — WASM unsupported, worklet blocked, or worker
 * construction refused all land here (mirrors `voiceBridge.test.ts`).
 */
describe('StructureBridge', () => {
  it('returns null and stays idle when nothing is attached', () => {
    const f = createEmptyFeatures()
    f.silence = false
    for (let i = 0; i < 60; i++) {
      f.time = i
      expect(structureBridge.update(f)).toBeNull()
    }
    expect(structureBridge.status.runs).toBe(0)
    expect(structureBridge.status.loaded).toBe(false)
  })

  it('reset() and pushPcm() are safe with no worker', () => {
    expect(() => structureBridge.reset()).not.toThrow()
    expect(() => structureBridge.pushPcm(new Float32Array(256), 48000)).not.toThrow()
  })

  it('reports a not-running status before attach', () => {
    expect(structureBridge.status.running).toBe(false)
    expect(structureBridge.status.missing).toBe(false)
    expect(structureBridge.status.lastBoundaries).toBe(0)
  })

  it('leaves an empty feature set unchanged (no worker)', () => {
    const f = createEmptyFeatures()
    f.silence = false
    f.time = 100
    structureBridge.update(f)
    expect(f.structureValid).toBe(false)
    expect(f.songSection.section).toBe('')
  })
})
