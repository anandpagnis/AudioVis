import { describe, expect, it } from 'vitest'
import { resolveSteeredParams, SCENE_CONTRACT_VERSION, type SceneContract } from '../contract'

const declares = (extra: Partial<SceneContract> = {}): SceneContract => ({
  version: SCENE_CONTRACT_VERSION,
  params: { speed: 0.5, shape: 0.5, tilt: 0.5, complexity: 0.5 },
  ...extra,
})

describe('resolveSteeredParams and directorSteers', () => {
  it('ignores a steered shape/tilt for a scene that did not opt in (the steer block is shared by every scene)', () => {
    const out = resolveSteeredParams(declares(), undefined, { shape: 0.9, tilt: 0.9, speed: 0.8 }, undefined)
    expect(out.shape).toBe(0.5)
    expect(out.tilt).toBe(0.5)
    expect(out.speed).toBe(0.8)
  })

  it('applies a steered dial only for the ones the scene opted into', () => {
    const out = resolveSteeredParams(declares({ directorSteers: ['tilt'] }), undefined, { shape: 0.9, tilt: 0.9 }, undefined)
    expect(out.tilt).toBe(0.9)
    expect(out.shape).toBe(0.5)
  })

  it('the user still wins over a director steer on an opted-in dial', () => {
    const out = resolveSteeredParams(declares({ directorSteers: ['tilt'] }), undefined, { tilt: 0.9 }, { tilt: 0.2 })
    expect(out.tilt).toBe(0.2)
  })

  it('a user shape/tilt value is never affected by the opt-in list', () => {
    const out = resolveSteeredParams(declares(), undefined, undefined, { shape: 0.3, tilt: 0.7 })
    expect(out.shape).toBe(0.3)
    expect(out.tilt).toBe(0.7)
  })
})

describe('steerExempt', () => {
  it('keeps the authored default for an exempt dial while the others are still steered', () => {
    const c = declares({ params: { speed: 0.5, complexity: 0.8, density: 1, fill: 0.62 }, steerExempt: ['complexity', 'density', 'fill'] })
    const out = resolveSteeredParams(c, undefined, { speed: 0.9, complexity: 0.25, density: 0.2, fill: 0.9 }, undefined)
    expect(out.complexity).toBe(0.8)
    expect(out.density).toBe(1)
    expect(out.fill).toBe(0.62)
    expect(out.speed).toBe(0.9)
  })

  it('the user own dial still wins on an exempt dial', () => {
    const c = declares({ params: { complexity: 0.8 }, steerExempt: ['complexity'] })
    expect(resolveSteeredParams(c, undefined, { complexity: 0.2 }, { complexity: 0.4 }).complexity).toBe(0.4)
  })

  it('the three scenes that were bouncing / thinning are exempt', async () => {
    const { getSceneContract } = await import('../index')
    expect(getSceneContract('kifs')?.steerExempt).toEqual(expect.arrayContaining(['fill', 'complexity']))
    expect(getSceneContract('kifs')?.directorSteers).toBeUndefined()
    expect(getSceneContract('wingfold')?.steerExempt).toContain('fill')
    expect(getSceneContract('maze')?.steerExempt).toEqual(expect.arrayContaining(['complexity', 'density', 'fill']))
  })
})
