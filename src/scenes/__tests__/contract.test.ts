import { describe, expect, it } from 'vitest'
import {
  NEUTRAL,
  SCENE_CONTRACT_VERSION,
  SCENE_PARAM_KEYS,
  bipolar,
  defaultSceneParams,
  drastic,
  isParamLive,
  liveParamKeys,
  paramLabel,
  resolveMode,
  resolveSceneParams,
  resolveSteeredParams,
  sanitizeParamBlock,
  sanitizeSceneParams,
  steps,
  summarizeContract,
  validateContract,
  type SceneContract,
} from '../contract'
import {
  SCENES,
  getSceneContract,
  resolveSceneMode,
  sceneContracts,
  validateSceneDef,
} from '../index'

/**
 * Scene Contract v1.
 *
 * The point of the contract is that a caller who has never seen a scene can
 * still address it, so most of these tests are written from that caller's side:
 * they use only the seven canonical names and the contract's own accessors, and
 * never reach into a specific scene's internals. A test that had to know
 * `kaleido` calls `density` "fold" in order to pass would be testing the wrong
 * thing.
 */

/** Two modes, a per-mode relabel, and a parameter that dies in one mode. */
const multi: SceneContract = {
  version: 1,
  modes: ['wide', 'tight'],
  params: { speed: 0.5, shape: 0.25, density: 0.5, contrast: 0.5 },
  paramLabels: {
    '*': { density: 'fold' },
    tight: { shape: null, density: 'crush' },
  },
}

const simple: SceneContract = {
  version: 1,
  params: { speed: 0.5, complexity: 0.8 },
}

describe('unit-range expansion', () => {
  it('every expansion is neutral at 0.5, so an untouched dial changes nothing', () => {
    // The invariant the whole roster is calibrated against: a scene reading a
    // dial it has not been told about must render exactly as it did before the
    // contract existed. That only holds if NEUTRAL is the identity for all three.
    expect(drastic(NEUTRAL)).toBe(1)
    expect(bipolar(NEUTRAL)).toBe(0)
    expect(steps(NEUTRAL, 0, 2)).toBe(1)
  })

  it('drastic spans a quarter to four times', () => {
    expect(drastic(0)).toBeCloseTo(0.25)
    expect(drastic(1)).toBeCloseTo(4)
  })

  it('bipolar is signed and scaled by span', () => {
    expect(bipolar(0, 2)).toBeCloseTo(-2)
    expect(bipolar(1, 2)).toBeCloseTo(2)
  })

  it('steps covers both endpoints and never leaves the range', () => {
    expect(steps(0, 1, 4)).toBe(1)
    expect(steps(1, 1, 4)).toBe(4)
    expect(steps(-5, 1, 4)).toBe(1)
    expect(steps(9, 1, 4)).toBe(4)
  })

  it('a non-finite dial reads as neutral rather than propagating NaN', () => {
    // A NaN reaching a uniform blanks the geometry for the rest of the session,
    // and the source is usually a corrupt stored value or a bad MIDI byte.
    expect(drastic(NaN)).toBe(1)
    expect(bipolar(NaN)).toBe(0)
  })
})

describe('labels and liveness', () => {
  it('an unlabelled parameter shows its canonical name', () => {
    expect(paramLabel(multi, 'wide', 'speed')).toBe('speed')
  })

  it("a scene's own word replaces the canonical name for humans", () => {
    expect(paramLabel(multi, 'wide', 'density')).toBe('fold')
  })

  it('a per-mode label beats the wildcard', () => {
    expect(paramLabel(multi, 'tight', 'density')).toBe('crush')
  })

  it('a null label means inert, and inert means a write is dropped', () => {
    expect(paramLabel(multi, 'tight', 'shape')).toBeNull()
    expect(isParamLive(multi, 'tight', 'shape')).toBe(false)
    // Not merely hidden from the panel — the value must not land, or the dial
    // would come back to life holding a number nobody chose the moment the
    // user switched modes.
    expect(sanitizeSceneParams(multi, 'tight', { shape: 0.9 })).toEqual({})
    expect(sanitizeSceneParams(multi, 'wide', { shape: 0.9 })).toEqual({ shape: 0.9 })
  })

  it('an undeclared parameter is inert in every mode', () => {
    expect(paramLabel(multi, 'wide', 'fill')).toBeNull()
    expect(isParamLive(multi, 'wide', 'fill')).toBe(false)
  })

  it('liveParamKeys is what a panel or a MIDI map enumerates', () => {
    expect(liveParamKeys(multi, 'wide')).toEqual(['speed', 'shape', 'density', 'contrast'])
    expect(liveParamKeys(multi, 'tight')).toEqual(['speed', 'density', 'contrast'])
  })

  it('keys come back in canonical order regardless of declaration order', () => {
    // Panel row order and MIDI CC assignment both key off this, so it cannot
    // depend on how a third-party author happened to type their object.
    const scrambled: SceneContract = {
      version: 1,
      params: { contrast: 0.5, speed: 0.5, fill: 0.5 },
    }
    expect(liveParamKeys(scrambled, undefined)).toEqual(['speed', 'fill', 'contrast'])
  })
})

describe('modes', () => {
  it('the first declared mode is the default', () => {
    expect(resolveMode(multi, undefined)).toBe('wide')
  })

  it('an unknown mode degrades to the default instead of throwing', () => {
    // Modes arrive from persisted state, imported presets and URLs; a stale one
    // has to behave like a stale sceneId does everywhere else.
    expect(resolveMode(multi, 'nonsense')).toBe('wide')
    expect(resolveMode(multi, 42)).toBe('wide')
  })

  it('a single-mode scene has no mode at all', () => {
    expect(resolveMode(simple, 'wide')).toBeUndefined()
  })
})

describe('resolveSceneParams', () => {
  it('fills all seven so a scene can read any key unconditionally', () => {
    const r = resolveSceneParams(simple, undefined, undefined)
    expect(Object.keys(r).sort()).toEqual([...SCENE_PARAM_KEYS].sort())
  })

  it('an undeclared parameter resolves to neutral, not undefined', () => {
    expect(resolveSceneParams(simple, undefined, undefined).tilt).toBe(NEUTRAL)
  })

  it('a declared default survives when nothing overrides it', () => {
    expect(resolveSceneParams(simple, undefined, {}).complexity).toBe(0.8)
  })

  it('an override to an inert parameter cannot push it', () => {
    expect(resolveSceneParams(multi, 'tight', { shape: 1 }).shape).toBe(0.25)
  })

  it('out-of-range and non-finite values are clamped rather than trusted', () => {
    expect(resolveSceneParams(simple, undefined, { speed: 40 }).speed).toBe(1)
    expect(resolveSceneParams(simple, undefined, { speed: -3 }).speed).toBe(0)
    expect(resolveSceneParams(simple, undefined, { speed: NaN }).speed).toBe(0.5)
  })

  it('writes into a supplied object, so the render loop allocates nothing', () => {
    const into = defaultSceneParams(simple)
    const out = resolveSceneParams(simple, undefined, { speed: 0.2 }, into)
    expect(out).toBe(into)
    expect(into.speed).toBe(0.2)
  })
})

describe('resolveSteeredParams — who wins a dial', () => {
  it('the steer moves a dial the user has not touched', () => {
    expect(resolveSteeredParams(simple, undefined, { speed: 0.9 }, undefined).speed).toBe(0.9)
  })

  it('the user beats the director on the same dial', () => {
    // The load-bearing rule. A VJ who moves a dial and watches it ease away has
    // been told the control is a suggestion.
    expect(resolveSteeredParams(simple, undefined, { speed: 0.9 }, { speed: 0.1 }).speed).toBe(0.1)
  })

  it('taking one dial does not take the others', () => {
    const r = resolveSteeredParams(
      simple,
      undefined,
      { speed: 0.9, complexity: 0.9 },
      { speed: 0.1 },
    )
    expect(r.speed).toBe(0.1)
    expect(r.complexity).toBe(0.9)
  })

  it('the steer cannot reach an inert or undeclared parameter either', () => {
    expect(resolveSteeredParams(multi, 'tight', { shape: 1 }, undefined).shape).toBe(0.25)
    expect(resolveSteeredParams(simple, undefined, { fill: 1 }, undefined).fill).toBe(NEUTRAL)
  })

  it('with neither layer present the scene renders at its authored defaults', () => {
    expect(resolveSteeredParams(simple, undefined, undefined, undefined)).toEqual(
      defaultSceneParams(simple),
    )
  })
})

describe('sanitizers', () => {
  it('sanitizeParamBlock is contract-agnostic, so a preset survives a swap', () => {
    // The distinction that makes retargeting possible: a preset stores the whole
    // vocabulary, because sanitizing against its ORIGINAL scene would throw away
    // exactly the keys a future target scene might honour.
    const block = sanitizeParamBlock({ speed: 0.7, fill: 0.3, bogus: 1, tilt: 'x' })
    expect(block).toEqual({ speed: 0.7, fill: 0.3 })
  })

  it('sanitizeParamBlock clamps and rejects junk', () => {
    expect(sanitizeParamBlock({ speed: 5, shape: -1, density: NaN })).toEqual({
      speed: 1,
      shape: 0,
    })
    expect(sanitizeParamBlock(null)).toEqual({})
    expect(sanitizeParamBlock('nope')).toEqual({})
  })

  it('sanitizeSceneParams is sparse out, so absent means "leave at default"', () => {
    // Not the same as 0.5: filling the gaps would overwrite every non-neutral
    // scene default with neutral.
    expect(sanitizeSceneParams(simple, undefined, { speed: 0.2 })).toEqual({ speed: 0.2 })
  })
})

describe('summarizeContract — what an external consumer sees', () => {
  it('describes a scene by canonical key AND human label', () => {
    const s = summarizeContract('demo', 'Demo', multi, 'wide')
    expect(s.id).toBe('demo')
    expect(s.modes).toEqual(['wide', 'tight'])
    expect(s.mode).toBe('wide')
    expect(s.params).toEqual([
      { key: 'speed', label: 'speed', default: 0.5 },
      { key: 'shape', label: 'shape', default: 0.25 },
      { key: 'density', label: 'fold', default: 0.5 },
      { key: 'contrast', label: 'contrast', default: 0.5 },
    ])
  })

  it('describes the mode asked for, not always the default', () => {
    // A dial caption that lies about which mode it belongs to is worse than
    // none, so the summary is mode-scoped.
    const s = summarizeContract('demo', 'Demo', multi, 'tight')
    expect(s.params.map((p) => p.key)).toEqual(['speed', 'density', 'contrast'])
    expect(s.params.find((p) => p.key === 'density')?.label).toBe('crush')
  })

  it('never returns a parameter with no label to show', () => {
    for (const mode of multi.modes ?? []) {
      for (const p of summarizeContract('demo', 'Demo', multi, mode).params) {
        expect(p.label.length).toBeGreaterThan(0)
      }
    }
  })
})

describe('validateContract — a malformed contract is refused, not tolerated', () => {
  const bad = (over: Partial<SceneContract>): string =>
    validateContract('x', { version: 1, params: { speed: 0.5 }, ...over } as SceneContract).join(
      ' ',
    )

  it('accepts well-formed contracts', () => {
    expect(validateContract('x', multi)).toEqual([])
    expect(validateContract('x', simple)).toEqual([])
  })

  it('rejects a version it was not built for', () => {
    expect(bad({ version: 2 as 1 })).toMatch(/version/)
  })

  it('rejects a contract that declares nothing', () => {
    expect(bad({ params: {} })).toMatch(/no parameters/)
  })

  it('rejects a name outside the vocabulary', () => {
    // The whole value is that the seven names are the seven names; an eighth is
    // a name every generic caller would have to special-case.
    expect(bad({ params: { speed: 0.5, wobble: 0.5 } as never })).toMatch(/unknown parameter/)
  })

  it('rejects a default that is not a 0..1 number', () => {
    expect(bad({ params: { speed: 4 } })).toMatch(/0\.\.1/)
    expect(bad({ params: { speed: NaN } })).toMatch(/0\.\.1/)
  })

  it('rejects a label for a parameter the scene never declared', () => {
    // Otherwise the panel shows a row that writes into nothing.
    expect(bad({ paramLabels: { '*': { fill: 'size' } } })).toMatch(/does not declare/)
  })

  it('rejects a label keyed to a mode the scene never declared', () => {
    expect(bad({ paramLabels: { ghost: { speed: 'rate' } } })).toMatch(/labels mode "ghost"/)
  })

  it('rejects duplicate and blank mode names', () => {
    expect(bad({ modes: ['a', 'a'] })).toMatch(/twice/)
    expect(bad({ modes: [''] })).toMatch(/blank mode/)
  })

  it('rejects a parameter that is inert in every mode', () => {
    // Declared-but-unreachable: either the scene reads it (so it should be live
    // somewhere) or it does not (so it should not be declared). The same
    // reasoning performanceState.ts applies to a field with no reader.
    const issues = validateContract('x', {
      version: 1,
      modes: ['a', 'b'],
      params: { speed: 0.5, shape: 0.5 },
      paramLabels: { a: { shape: null }, b: { shape: null } },
    })
    expect(issues.join(' ')).toMatch(/inert in every mode/)
  })

  it('validateSceneDef refuses a scene whose contract is malformed', () => {
    // The gate that matters for a third-party scene: registerScene throws on
    // these, so a bad contract never reaches the panel or the director.
    const def = {
      id: 'bad',
      name: 'Bad',
      component: (() => null) as never,
      metadata: {
        roles: ['primary'],
        moods: ['groove'],
        bands: ['energy'],
        intensity: 'medium',
        performanceCost: 'low',
        compatibleWith: [],
        contract: { version: 1, params: { speed: 9 } },
      },
    } as never
    expect(validateSceneDef(def).join(' ')).toMatch(/0\.\.1/)
  })
})

describe('the shipped roster', () => {
  it('every declared contract is valid', () => {
    for (const scene of SCENES) {
      const c = scene.metadata.contract
      if (!c) continue
      expect(validateContract(scene.id, c), scene.id).toEqual([])
    }
  })

  it('every declared contract is on the current version', () => {
    for (const scene of SCENES) {
      const c = scene.metadata.contract
      if (c) expect(c.version, scene.id).toBe(SCENE_CONTRACT_VERSION)
    }
  })

  it('at least one scene is steerable, or the director has nothing to perform', () => {
    expect(SCENES.filter((s) => s.metadata.contract).length).toBeGreaterThan(0)
  })

  it('every scene with modes declares its default mode first and reachably', () => {
    for (const scene of SCENES) {
      const c = scene.metadata.contract
      if (!c?.modes) continue
      const first = c.modes[0]
      expect(resolveSceneMode(scene.id, undefined), scene.id).toBe(first)
      // A default mode in which nothing is steerable would ship a scene whose
      // panel is empty until the user finds the mode chips.
      expect(liveParamKeys(c, first).length, `${scene.id} in ${first}`).toBeGreaterThan(0)
    }
  })

  it('a scene with no contract is simply not steerable — never a crash', () => {
    const plain = SCENES.find((s) => !s.metadata.contract)
    if (!plain) return // the whole roster has migrated; nothing to check
    expect(getSceneContract(plain.id)).toBeUndefined()
    expect(resolveSceneMode(plain.id, 'whatever')).toBeUndefined()
  })

  it('an unknown scene id degrades to the fallback rather than throwing', () => {
    expect(() => getSceneContract('does-not-exist')).not.toThrow()
    expect(resolveSceneMode('does-not-exist', 'x')).toBe(SCENES[0].metadata.contract?.modes?.[0])
  })
})

describe('sceneContracts — the marketplace/connector view', () => {
  it('lists only steerable scenes, and never non-commercial source', () => {
    // The callers are exactly the ones that must not enumerate material the
    // project is not allowed to ship, so this is built from the shippable
    // roster rather than from SCENES.
    const listed = sceneContracts()
    const ids = listed.map((s) => s.id)
    expect(ids.length).toBeGreaterThan(0)
    for (const scene of SCENES) {
      const shippable =
        scene.metadata.license === undefined ||
        scene.metadata.license === 'original' ||
        scene.metadata.license === 'attribution'
      if (scene.metadata.contract && shippable) expect(ids).toContain(scene.id)
      if (!shippable) expect(ids).not.toContain(scene.id)
    }
  })

  it('every listed parameter is addressable by its canonical key', () => {
    for (const s of sceneContracts()) {
      for (const p of s.params) {
        expect(SCENE_PARAM_KEYS).toContain(p.key)
        expect(p.default).toBeGreaterThanOrEqual(0)
        expect(p.default).toBeLessThanOrEqual(1)
      }
    }
  })

  it('honours a per-scene mode request', () => {
    const withModes = SCENES.find((s) => (s.metadata.contract?.modes?.length ?? 0) > 1)
    if (!withModes) return
    const other = withModes.metadata.contract!.modes![1]
    const listed = sceneContracts({ [withModes.id]: other })
    expect(listed.find((s) => s.id === withModes.id)?.mode).toBe(other)
  })
})
