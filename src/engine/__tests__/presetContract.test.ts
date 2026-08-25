import { describe, expect, it } from 'vitest'
import { SCENES, getSceneContract } from '../../scenes'
import { liveParamKeys, resolveSceneParams, resolveMode } from '../../scenes/contract'
import { retargetPreset, sanitizePreset, type Preset } from '../presets'

/**
 * Presets under Scene Contract v1.
 *
 * The claim being tested is narrow and specific: dial positions stored in the
 * shared vocabulary survive being pointed at a different scene. Before the
 * contract, "same look, different scene" was not a request the system could
 * represent — a preset's look was a bag of private uniforms — so the dials
 * collapsed to defaults and the user re-dialled by hand.
 */

/** Two steerable scenes with different declared vocabularies, or null. */
function twoSteerable(): [string, string] | null {
  const ids = SCENES.filter((s) => s.metadata.contract).map((s) => s.id)
  if (ids.length < 2) return null
  // Prefer a pair that actually DISAGREES about which keys exist — that is the
  // interesting case for a swap, and a pair with identical vocabularies would
  // pass the lossiness assertions for the wrong reason.
  for (const a of ids) {
    for (const b of ids) {
      if (a === b) continue
      const ka = Object.keys(getSceneContract(a)!.params)
      const kb = Object.keys(getSceneContract(b)!.params)
      if (ka.some((k) => !kb.includes(k)) || kb.some((k) => !ka.includes(k))) return [a, b]
    }
  }
  return [ids[0], ids[1]]
}

/**
 * A distinct value on all seven names, so "every dial the target declares" is
 * reachable whichever pair of scenes the roster hands back. Every value is
 * off-default, so a dial that failed to carry reads as a default rather than
 * coincidentally matching.
 */
const ALL_DIALS = {
  speed: 0.9,
  shape: 0.2,
  complexity: 0.7,
  density: 0.1,
  fill: 0.4,
  tilt: 0.3,
  contrast: 0.8,
} as const

const base = (sceneId: string): Preset => ({
  id: 'p1',
  name: 'Test',
  sceneId,
  paletteId: 'aurora',
  params: { intensity: 1, speed: 1, reactivity: 1 },
})

describe('sanitizePreset — scene contract fields', () => {
  it('keeps the whole vocabulary, not just the origin scene keys', () => {
    // The distinction that makes a swap possible. Sanitizing against the
    // preset's OWN scene here would drop the keys a future target might honour,
    // and no later retarget could recover them.
    const pair = twoSteerable()
    if (!pair) return
    const clean = sanitizePreset({
      ...base(pair[0]),
      sceneParams: { speed: 0.9, shape: 0.2, complexity: 0.7, density: 0.1, fill: 0.4 },
    })
    expect(clean).not.toBeNull()
    expect(Object.keys(clean!.sceneParams ?? {}).sort()).toEqual([
      'complexity',
      'density',
      'fill',
      'shape',
      'speed',
    ])
  })

  it('rejects values and names outside the vocabulary', () => {
    const clean = sanitizePreset({
      ...base(SCENES[0].id),
      sceneParams: { speed: 9, wobble: 0.5, shape: 'x' },
    })
    expect(clean!.sceneParams).toEqual({ speed: 1 })
  })

  it('degrades an unknown mode to the target scene default instead of keeping it', () => {
    const withModes = SCENES.find((s) => (s.metadata.contract?.modes?.length ?? 0) > 1)
    if (!withModes) return
    const clean = sanitizePreset({ ...base(withModes.id), sceneMode: 'not-a-mode' })
    expect(clean!.sceneMode).toBe(withModes.metadata.contract!.modes![0])
  })

  it('carries no mode for a scene that has none', () => {
    const plain = SCENES.find((s) => s.metadata.contract && !s.metadata.contract.modes)
    if (!plain) return
    expect(sanitizePreset({ ...base(plain.id), sceneMode: 'whatever' })!.sceneMode).toBeUndefined()
  })

  it('a preset written before v1 loads with no dials rather than failing', () => {
    // Presets arrive by import and by URL, paths the store's persist migration
    // never sees, so an older shape has to stay loadable.
    const clean = sanitizePreset(base(SCENES[0].id))
    expect(clean).not.toBeNull()
    expect(clean!.sceneParams).toEqual({})
  })
})

describe('retargetPreset', () => {
  it('the target scene honours every dial it declares', () => {
    const pair = twoSteerable()
    if (!pair) return
    const [from, to] = pair
    const contract = getSceneContract(to)!
    const moved = retargetPreset({ ...base(from), sceneParams: ALL_DIALS }, to)

    expect(moved.sceneId).toBe(to)
    const mode = resolveMode(contract, moved.sceneMode)
    const resolved = resolveSceneParams(contract, mode, moved.sceneParams)
    // Every parameter the NEW scene declares and can hear took the preset's
    // value. That is the whole claim.
    for (const k of liveParamKeys(contract, mode)) {
      expect(resolved[k], `${to}.${k}`).toBeCloseTo(ALL_DIALS[k])
    }
  })

  it('keeps the full block, so A -> B -> A is not a trip through B vocabulary', () => {
    // Lossy in what the target USES, never in what the preset CARRIES.
    const pair = twoSteerable()
    if (!pair) return
    const [a, b] = pair
    const there = retargetPreset({ ...base(a), sceneParams: ALL_DIALS }, b)
    const back = retargetPreset(there, a)
    expect(back.sceneParams).toEqual(ALL_DIALS)
  })

  it('drops a mode the target scene does not have', () => {
    // A mode name is scene-private in a way a parameter name is not, so it
    // cannot survive a swap the way the dials do.
    const withModes = SCENES.find((s) => (s.metadata.contract?.modes?.length ?? 0) > 1)
    const plain = SCENES.find((s) => s.metadata.contract && !s.metadata.contract.modes)
    if (!withModes || !plain) return
    const moved = retargetPreset(
      { ...base(withModes.id), sceneMode: withModes.metadata.contract!.modes![1] },
      plain.id,
    )
    expect(moved.sceneMode).toBeUndefined()
  })

  it('retargeting onto a scene with no contract is harmless', () => {
    const plain = SCENES.find((s) => !s.metadata.contract)
    const steerable = SCENES.find((s) => s.metadata.contract)
    if (!plain || !steerable) return
    const moved = retargetPreset({ ...base(steerable.id), sceneParams: { speed: 0.9 } }, plain.id)
    expect(moved.sceneId).toBe(plain.id)
    expect(moved.sceneMode).toBeUndefined()
    // The block is still carried, so pointing it back at a steerable scene works.
    expect(moved.sceneParams).toEqual({ speed: 0.9 })
  })

  it('gets a fresh id and loses builtIn, so it does not shadow the original', () => {
    const steerable = SCENES.find((s) => s.metadata.contract)
    if (!steerable) return
    const moved = retargetPreset({ ...base(steerable.id), builtIn: true }, steerable.id)
    expect(moved.id).not.toBe('p1')
    expect(moved.builtIn).toBe(false)
  })
})
