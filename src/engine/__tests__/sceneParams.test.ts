import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PARAM_VALUE,
  SCENE_PARAM_KEYS,
  drastic,
  resolveSceneParams,
  visibleSceneParams,
  type SceneModeSpec,
} from '../sceneParams'
import { SCENES, validateSceneDef, type SceneDef } from '../../scenes'

describe('drastic', () => {
  it('is 0.25x / 1x / 4x at the ends and centre', () => {
    // The whole point of the curve: the centre is the AUTHORED value, and the
    // ends are geometrically far from it rather than a 10% trim.
    expect(drastic(0)).toBeCloseTo(0.25, 10)
    expect(drastic(0.5)).toBeCloseTo(1, 10)
    expect(drastic(1)).toBeCloseTo(4, 10)
  })

  it('is monotonic across the slider', () => {
    let prev = -Infinity
    for (let p = 0; p <= 1.0001; p += 0.05) {
      const v = drastic(p)
      expect(v).toBeGreaterThan(prev)
      prev = v
    }
  })
})

describe('resolveSceneParams', () => {
  it('fills every key so a scene never has to null-check', () => {
    const p = resolveSceneParams(undefined, undefined)
    for (const key of SCENE_PARAM_KEYS) expect(p[key]).toBe(DEFAULT_PARAM_VALUE)
    expect(p.mode).toBe('')
    expect(p.modeIndex).toBe(0)
  })

  it('prefers an override over a declared default', () => {
    const p = resolveSceneParams({ speed: 0.5, fill: 0.2 }, { speed: 0.9 })
    expect(p.speed).toBe(0.9)
    expect(p.fill).toBe(0.2)
  })

  it('treats an override of 0 as a real value, not as absent', () => {
    // The `??` chain has to distinguish "not set" from "set to the bottom of the
    // slider". A `||` here would silently snap every zeroed knob back to its
    // default, which is the exact value a performer reaches for.
    const p = resolveSceneParams({ speed: 0.7 }, { speed: 0 })
    expect(p.speed).toBe(0)
  })

  it('clamps values that came back from storage out of range', () => {
    // These arrive from localStorage, an imported preset and a share URL, none
    // of which are ours to believe.
    const p = resolveSceneParams({ speed: 0.5 }, { speed: 4, fill: -2 })
    expect(p.speed).toBe(1)
    expect(p.fill).toBe(0)
  })

  it('replaces a non-finite stored value rather than propagating NaN', () => {
    // A NaN reaching a uniform turns the whole scene black with no error.
    const p = resolveSceneParams({ speed: 0.5 }, { speed: NaN, fill: Infinity })
    expect(p.speed).toBe(DEFAULT_PARAM_VALUE)
    expect(p.fill).toBe(DEFAULT_PARAM_VALUE)
  })

  const spec: SceneModeSpec = { modes: ['bloom', 'melt', 'shatter'] }

  it('defaults to the first declared mode', () => {
    const p = resolveSceneParams({}, undefined, spec)
    expect(p.mode).toBe('bloom')
    expect(p.modeIndex).toBe(0)
  })

  it('honours the scene-declared default mode over the first entry', () => {
    const p = resolveSceneParams({ mode: 'melt' }, undefined, spec)
    expect(p.mode).toBe('melt')
    expect(p.modeIndex).toBe(1)
  })

  it('resolves an override mode to its index', () => {
    const p = resolveSceneParams({ mode: 'bloom' }, { mode: 'shatter' }, spec)
    expect(p.mode).toBe('shatter')
    expect(p.modeIndex).toBe(2)
  })

  it('falls back to the first mode when a stored mode no longer exists', () => {
    // A persisted preset can name a mode a later build removed. Keeping the
    // stale NAME would leave uMode at 0 while the panel showed the old label —
    // and a shader branching on uMode would render its else case, usually
    // nothing at all.
    const p = resolveSceneParams({}, { mode: 'deleted-mode' }, spec)
    expect(p.mode).toBe('bloom')
    expect(p.modeIndex).toBe(0)
  })

  it('reports no mode for a scene that declares none', () => {
    const p = resolveSceneParams({ speed: 0.5 }, { mode: 'nonsense' })
    expect(p.mode).toBe('')
    expect(p.modeIndex).toBe(0)
  })
})

describe('visibleSceneParams', () => {
  it('shows only declared keys, in canonical order', () => {
    // Declared out of order on purpose: the panel layout must be stable across
    // scenes rather than following whatever order the object literal used.
    const out = visibleSceneParams({ contrast: 0.5, speed: 0.5, fill: 0.5 }, '')
    expect(out.map((o) => o.key)).toEqual(['speed', 'fill', 'contrast'])
  })

  it('returns nothing for a scene with no parameters', () => {
    expect(visibleSceneParams(undefined, '')).toEqual([])
  })

  it('applies wildcard relabelling', () => {
    const out = visibleSceneParams(
      { speed: 0.5, complexity: 0.5 },
      'any',
      { modes: ['any'], paramLabels: { '*': { complexity: 'warp' } } },
    )
    expect(out).toEqual([
      { key: 'speed', label: 'speed' },
      { key: 'complexity', label: 'warp' },
    ])
  })

  it('lets a mode-specific label win over the wildcard', () => {
    const out = visibleSceneParams({ complexity: 0.5 }, 'melt', {
      modes: ['bloom', 'melt'],
      paramLabels: { '*': { complexity: 'warp' }, melt: { complexity: 'viscosity' } },
    })
    expect(out).toEqual([{ key: 'complexity', label: 'viscosity' }])
  })

  it('hides a parameter a mode does not use', () => {
    const out = visibleSceneParams({ speed: 0.5, tilt: 0.5 }, 'flat', {
      modes: ['flat', 'tilted'],
      paramLabels: { flat: { tilt: null } },
    })
    expect(out.map((o) => o.key)).toEqual(['speed'])
  })
})

describe('validateSceneDef mode wiring', () => {
  const base = (): SceneDef => ({
    id: 'test',
    name: 'Test',
    component: () => null,
    metadata: {
      roles: ['primary'],
      moods: ['groove'],
      bands: ['energy'],
      intensity: 'medium',
      compatibleWith: [],
      performanceCost: 'low',
    },
  })

  it('accepts a scene with no modes at all', () => {
    expect(validateSceneDef(base())).toEqual([])
  })

  it('accepts consistent mode wiring', () => {
    const def = base()
    def.metadata.modes = ['a', 'b']
    def.metadata.params = { speed: 0.5, mode: 'b' }
    def.metadata.paramLabels = { b: { speed: 'rate' }, '*': { speed: null } }
    expect(validateSceneDef(def)).toEqual([])
  })

  it('rejects a default mode that is not declared', () => {
    // This fails SILENTLY at runtime — the mode resolves to index 0, so the
    // scene renders a different look than the one it names.
    const def = base()
    def.metadata.modes = ['a', 'b']
    def.metadata.params = { mode: 'c' }
    expect(validateSceneDef(def).join()).toContain('not in its `modes` list')
  })

  it('rejects a default mode when no modes are declared', () => {
    const def = base()
    def.metadata.params = { mode: 'a' }
    expect(validateSceneDef(def).join()).toContain('declares no `modes`')
  })

  it('rejects duplicate mode names', () => {
    const def = base()
    def.metadata.modes = ['a', 'a']
    expect(validateSceneDef(def).join()).toContain('duplicate mode names')
  })

  it('rejects an empty modes array', () => {
    const def = base()
    def.metadata.modes = []
    expect(validateSceneDef(def).join()).toContain('empty `modes` array')
  })

  it('rejects labels for a mode that does not exist', () => {
    const def = base()
    def.metadata.modes = ['a']
    def.metadata.paramLabels = { nope: { speed: 'x' } }
    expect(validateSceneDef(def).join()).toContain('labels mode "nope"')
  })
})

describe('the registered roster', () => {
  it('passes its own validator', () => {
    // validateSceneDef only runs automatically inside registerScene, so the
    // statically-declared SCENES array is otherwise unchecked.
    for (const scene of SCENES) {
      expect(validateSceneDef(scene), scene.id).toEqual([])
    }
  })

  it('declares only canonical parameter keys', () => {
    const allowed = new Set<string>([...SCENE_PARAM_KEYS, 'mode'])
    for (const scene of SCENES) {
      for (const key of Object.keys(scene.metadata.params ?? {})) {
        expect(allowed.has(key), `${scene.id} declares "${key}"`).toBe(true)
      }
    }
  })

  it('declares every parameter inside the slider range', () => {
    for (const scene of SCENES) {
      for (const [key, value] of Object.entries(scene.metadata.params ?? {})) {
        if (key === 'mode') continue
        expect(value, `${scene.id}.${key}`).toBeGreaterThanOrEqual(0)
        expect(value, `${scene.id}.${key}`).toBeLessThanOrEqual(1)
      }
    }
  })
})
