import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMusicIntelProvider, NullProvider, type MusicIntelProvider } from '../intel'
import { EssentiaProvider } from '../intel/EssentiaProvider'
import { essentiaBridge } from '../essentia/EssentiaBridge'
import { structureBridge } from '../essentia/StructureBridge'
import { voiceBridge } from '../essentia/VoiceBridge'
import { createEmptyFeatures } from '../types'

/**
 * The provider seam is what keeps AGPL / non-commercial code out of commercial
 * builds, so the contract worth pinning is: flag off (unset, '0', anything but
 * '1') -> NullProvider and the Essentia provider module is never even
 * requested; flag on -> the Essentia provider; a failed load never throws.
 */
afterEach(() => {
  vi.unstubAllEnvs()
  vi.doUnmock('../intel/EssentiaProvider')
  vi.resetModules()
})

describe('createMusicIntelProvider', () => {
  it('returns a NullProvider when the flag is unset (default)', async () => {
    vi.stubEnv('VITE_ENABLE_ESSENTIA', '')
    const p = await createMusicIntelProvider()
    expect(p).toBeInstanceOf(NullProvider)
    expect(p.id).toBe('null')
    expect(p.enabled).toBe(false)
    expect(p.status).toBeNull()
  })

  it.each(['0', 'true', 'yes', ' 1'])(
    'treats %j as off - only the literal "1" enables it',
    async (v) => {
      vi.stubEnv('VITE_ENABLE_ESSENTIA', v)
      expect((await createMusicIntelProvider()).enabled).toBe(false)
    },
  )

  it('never requests the Essentia provider module when the flag is off', async () => {
    const factory = vi.fn(() => ({ EssentiaProvider: class {} }))
    vi.doMock('../intel/EssentiaProvider', factory)
    vi.resetModules()
    vi.stubEnv('VITE_ENABLE_ESSENTIA', '')
    const { createMusicIntelProvider: create } = await import('../intel')
    await create()
    expect(factory).not.toHaveBeenCalled()
  })

  it('returns the Essentia provider when VITE_ENABLE_ESSENTIA=1 (mocked module)', async () => {
    class FakeEssentiaProvider {
      readonly id = 'essentia'
      readonly enabled = true
    }
    vi.doMock('../intel/EssentiaProvider', () => ({ EssentiaProvider: FakeEssentiaProvider }))
    vi.resetModules()
    vi.stubEnv('VITE_ENABLE_ESSENTIA', '1')
    const { createMusicIntelProvider: create } = await import('../intel')
    const p = await create()
    expect(p).toBeInstanceOf(FakeEssentiaProvider)
    expect(p.id).toBe('essentia')
    expect(p.enabled).toBe(true)
  })

  it('degrades to NullProvider (no throw) if the Essentia chunk fails to load', async () => {
    vi.doMock('../intel/EssentiaProvider', () => {
      throw new Error('chunk load failed')
    })
    vi.resetModules()
    vi.stubEnv('VITE_ENABLE_ESSENTIA', '1')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { createMusicIntelProvider: create, NullProvider: Null } = await import('../intel')
    const p = await create()
    expect(p).toBeInstanceOf(Null)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('NullProvider', () => {
  it('is a complete no-op and leaves every feature at its idle default', async () => {
    const p: MusicIntelProvider = new NullProvider()
    const f = createEmptyFeatures()
    const before = JSON.stringify(f)
    let modelCalls = 0
    const bpm = {
      setModelTempo: () => {
        modelCalls++
      },
    }
    await expect(p.attach({} as AudioContext, {} as AudioNode)).resolves.toBeUndefined()
    for (let i = 0; i < 20; i++) {
      f.time = i
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      p.updateRhythm(f, bpm as any)
      p.updateVoice(f)
      p.requestKey()
      expect(p.updateStructure(f)).toBeNull()
    }
    p.detach()
    expect(modelCalls).toBe(0)
    expect(f.key).toBe('')
    expect(f.scale).toBe('')
    expect(f.keyConfidence).toBe(0)
    expect(f.moodsValid).toBe(false)
    expect(f.structureValid).toBe(false)
    expect(f.vocalPresence).toBe(0)
    // Only `time` was touched by the test itself.
    f.time = 0
    expect(JSON.stringify(f)).toBe(before)
  })
})

describe('EssentiaProvider', () => {
  it('is enabled and exposes the live bridge status objects', () => {
    const p = new EssentiaProvider()
    expect(p.id).toBe('essentia')
    expect(p.enabled).toBe(true)
    expect(p.status?.rhythm).toBe(essentiaBridge.status)
    expect(p.status?.voice).toBe(voiceBridge.status)
    expect(p.status?.structure).toBe(structureBridge.status)
  })

  it('delegates each hook to its bridge with the same arguments', () => {
    const p = new EssentiaProvider()
    const f = createEmptyFeatures()
    const bpm = {} as never
    const update = vi.spyOn(essentiaBridge, 'update').mockImplementation(() => {})
    const voice = vi.spyOn(voiceBridge, 'update').mockImplementation(() => {})
    const key = vi.spyOn(essentiaBridge, 'requestKey').mockImplementation(() => {})
    const detach = vi.spyOn(essentiaBridge, 'detach').mockImplementation(() => {})
    const raw = { atBeat: 1 } as never
    const structure = vi.spyOn(structureBridge, 'update').mockReturnValue(raw)
    const attach = vi.spyOn(essentiaBridge, 'attach').mockResolvedValue(undefined)

    p.updateRhythm(f, bpm)
    p.updateVoice(f)
    p.requestKey()
    p.detach()
    expect(p.updateStructure(f)).toBe(raw)
    const ctx = {} as AudioContext
    const src = {} as AudioNode
    void p.attach(ctx, src)

    expect(update).toHaveBeenCalledWith(f, bpm)
    expect(voice).toHaveBeenCalledWith(f)
    expect(key).toHaveBeenCalledTimes(1)
    expect(detach).toHaveBeenCalledTimes(1)
    expect(structure).toHaveBeenCalledWith(f)
    expect(attach).toHaveBeenCalledWith(ctx, src)
    vi.restoreAllMocks()
  })

  it('bridges without a registered worker factory fail soft (no throw, error recorded)', async () => {
    // Fresh module instances = bridges that no provider has wired up yet.
    vi.resetModules()
    const { voiceBridge: fresh } = await import('../essentia/VoiceBridge')
    const f = createEmptyFeatures()
    f.silence = false
    fresh.pushPcm(new Float32Array(48000 * 13), 48000)
    for (let t = 7; t < 40; t += 0.5) {
      f.time = t
      expect(() => fresh.update(f)).not.toThrow()
    }
    expect(fresh.status.running).toBe(false)
    expect(fresh.status.error).toMatch(/worker factory/)
    expect(f.moodsValid).toBe(false)
  })
})
