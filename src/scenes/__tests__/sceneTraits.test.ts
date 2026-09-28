import { describe, expect, it } from 'vitest'
import { CHARACTER_MOODS } from '../../audio/characterTypes'
import { createLookProfile, type LookProfile } from '../../engine/look/lookRow'
import { MOOD_ROWS } from '../../engine/look/moodRows'
import { isParamLive } from '../contract'
import { SCENE_CHARACTER } from '../character'
import { DISABLED_SCENES, SCENES, pickVariedMode } from '../index'
import {
  NEUTRAL_TRAITS,
  SCENE_BOOST_MAX,
  SCENE_BOOST_MIN,
  TRAIT_KEYS,
  TRAIT_OVERRIDES,
  getSceneTraits,
  hasSceneTraits,
  modeFit,
  preferredModes,
  sceneBoost,
  sceneLookActive,
  type BoostPhase,
} from '../sceneTraits'

/** A valid, scene-enabled profile on the neutral row, with `over` applied. */
function look(over: Partial<LookProfile> = {}): LookProfile {
  const p = createLookProfile()
  p.valid = true
  p.source = 'character'
  Object.assign(p, over)
  return p
}

/** A valid profile carrying one authored mood row's trait targets. */
function moodLook(mood: (typeof CHARACTER_MOODS)[number], over: Partial<LookProfile> = {}): LookProfile {
  const row = MOOD_ROWS[mood]
  return look({
    traitTempo: row.traitTempo,
    traitAngular: row.traitAngular,
    traitBusy: row.traitBusy,
    traitRadial: row.traitRadial,
    traitStrength: row.traitStrength,
    ...over,
  })
}

const LIVE_IDS = SCENES.map((s) => s.id)
const QUARANTINED_IDS = DISABLED_SCENES.map((s) => s.id)
/** Primaries the pickers can reach (moods non-empty, primary role). */
const PRIMARY_IDS = SCENES.filter((s) => s.metadata.roles.includes('primary') && s.metadata.moods.length > 0).map((s) => s.id)
const PHASES: BoostPhase[] = ['auto', 'build', 'drop']

describe('getSceneTraits: every scene resolves a row', () => {
  it('has an authored row for every LIVE scene (a new scene must be in SCENE_CHARACTER or TRAIT_OVERRIDES)', () => {
    const missing = LIVE_IDS.filter((id) => !hasSceneTraits(id))
    expect(missing, `no trait source for: ${missing.join(', ')}`).toEqual([])
  })

  it('also covers every quarantined scene, so promoting one is free', () => {
    expect(QUARANTINED_IDS.filter((id) => !hasSceneTraits(id))).toEqual([])
  })

  it('keeps all six traits finite and in 0..1, for every live and quarantined scene', () => {
    for (const id of [...LIVE_IDS, ...QUARANTINED_IDS]) {
      const t = getSceneTraits(id)
      for (const k of TRAIT_KEYS) {
        expect(Number.isFinite(t[k]), `${id}.${k}`).toBe(true)
        expect(t[k], `${id}.${k}`).toBeGreaterThanOrEqual(0)
        expect(t[k], `${id}.${k}`).toBeLessThanOrEqual(1)
      }
    }
  })

  it('has no override for an id that is neither live nor quarantined, and every override is in 0..1', () => {
    const known = new Set([...LIVE_IDS, ...QUARANTINED_IDS])
    for (const [id, o] of Object.entries(TRAIT_OVERRIDES)) {
      expect(known.has(id), `stale override: ${id}`).toBe(true)
      for (const [k, v] of Object.entries(o)) {
        expect((TRAIT_KEYS as readonly string[]).includes(k), `${id}.${k} is not a trait`).toBe(true)
        expect(v, `${id}.${k}`).toBeGreaterThanOrEqual(0)
        expect(v, `${id}.${k}`).toBeLessThanOrEqual(1)
      }
    }
  })

  it('resolves an unknown id to the neutral row instead of throwing, and memoises', () => {
    expect(hasSceneTraits('no-such-scene')).toBe(false)
    expect(getSceneTraits('no-such-scene')).toEqual(NEUTRAL_TRAITS)
    expect(getSceneTraits('beats')).toBe(getSceneTraits('beats'))
  })
})

describe('getSceneTraits: derived from SCENE_CHARACTER, corrected by the override table', () => {
  it('orders tempo by arousal: calm scenes are slow, fast scenes are fast', () => {
    for (const id of ['snowflake', 'nebula', 'dustfield', 'hold', 'malachite']) {
      expect(getSceneTraits(id).tempo, id).toBeLessThan(0.25)
    }
    for (const id of ['beats', 'javazone', 'maze', 'plasma', 'strobe']) {
      expect(getSceneTraits(id).tempo, id).toBeGreaterThan(0.75)
    }
  })

  it('derives angular from tension: lattesfold and strobe are the angular ones, organic scenes are not', () => {
    expect(getSceneTraits('lattesfold').angular).toBeGreaterThan(0.75)
    expect(getSceneTraits('strobe').angular).toBeGreaterThan(0.9)
    for (const id of ['butterfly', 'truchet', 'chrome', 'snowflake', 'wingfold']) {
      expect(getSceneTraits(id).angular, id).toBeLessThan(0.3)
    }
  })

  it('authors radial for the inherently symmetric scenes (it cannot be derived from a mood)', () => {
    for (const id of ['kifs', 'snowflake', 'truchet', 'travelling', 'shock']) {
      expect(getSceneTraits(id).radial, id).toBeGreaterThanOrEqual(0.8)
    }
    for (const id of ['matrix', 'strobe', 'ribbons', 'dustfield', 'maze']) {
      expect(getSceneTraits(id).radial, id).toBeLessThanOrEqual(0.3)
    }
  })

  it('authors busy where the derivation is wrong: dense scenes high, one-hero scenes low', () => {
    for (const id of ['matrix', 'web', 'lattesfold', 'javazone', 'kifs']) {
      expect(getSceneTraits(id).busy, id).toBeGreaterThanOrEqual(0.8)
    }
    for (const id of ['chrome', 'snowflake', 'nebula', 'dustfield', 'hold']) {
      expect(getSceneTraits(id).busy, id).toBeLessThanOrEqual(0.25)
    }
  })

  it('makes the fast beat-locked flythroughs the build scenes (4D Beats first)', () => {
    for (const id of ['beats', 'javazone', 'maze', 'web', 'plasma']) {
      expect(getSceneTraits(id).buildFit, id).toBeGreaterThanOrEqual(0.8)
    }
    expect(getSceneTraits('pointcloud').buildFit).toBeGreaterThanOrEqual(0.65)
    // The scenes that should be switched AWAY from on a build (buildFit < 0.5) include every calm one.
    for (const id of ['snowflake', 'nebula', 'dustfield', 'hold', 'chrome', 'malachite', 'travelling', 'wireframe', 'dissolve', 'butterfly']) {
      expect(getSceneTraits(id).buildFit, id).toBeLessThan(0.5)
    }
    const best = PRIMARY_IDS.map((id) => [id, getSceneTraits(id).buildFit] as const).sort((a, b) => b[1] - a[1])
    expect(best[0][0]).toBe('beats')
  })

  it('makes the violent, shock-like scenes the drop scenes', () => {
    for (const id of ['shock', 'strobe', 'plasma']) expect(getSceneTraits(id).dropFit, id).toBeGreaterThanOrEqual(0.9)
    for (const id of ['snowflake', 'nebula', 'chrome', 'hold']) expect(getSceneTraits(id).dropFit, id).toBeLessThan(0.4)
  })

  it('pulls a chameleon (wide spread) toward neutral: limitless and djcam carry no strong look', () => {
    expect(SCENE_CHARACTER.limitless.spread).toBeGreaterThan(0.5)
    for (const id of ['limitless', 'djcam']) {
      const t = getSceneTraits(id)
      for (const k of ['tempo', 'angular', 'busy', 'dropFit'] as const) {
        expect(Math.abs(t[k] - 0.5), `${id}.${k}`).toBeLessThan(0.2)
      }
      // A cutaway is never "improved on" by the build switch.
      expect(t.buildFit).toBeGreaterThanOrEqual(0.5)
    }
  })
})

describe('sceneLookActive: the consumer rule', () => {
  it('is true only for a valid profile with the scene family on', () => {
    expect(sceneLookActive(undefined)).toBe(false)
    expect(sceneLookActive(createLookProfile())).toBe(false) // starts invalid
    expect(sceneLookActive(look())).toBe(true)
    const off = look()
    off.families.scene = false
    expect(sceneLookActive(off)).toBe(false)
  })
})

describe('sceneBoost: bounded, neutral at strength 0', () => {
  it('stays inside [0.4, 3] for every scene x mood row x phase x build intent x strength (and odd inputs)', () => {
    const ids = [...LIVE_IDS, ...QUARANTINED_IDS, 'no-such-scene']
    for (const mood of CHARACTER_MOODS) {
      for (const strength of [0, 0.3, 0.6, 1, 5, -1, Number.NaN]) {
        for (const intent of [0, 0.25, 0.5, 1, 4, Number.NaN]) {
          const p = moodLook(mood, { traitStrength: strength, buildIntent: intent })
          for (const phase of PHASES) {
            for (const id of ids) {
              const b = sceneBoost(id, p, phase)
              expect(Number.isFinite(b), `${id}/${mood}/${phase}`).toBe(true)
              expect(b, `${id}/${mood}/${phase}`).toBeGreaterThanOrEqual(SCENE_BOOST_MIN)
              expect(b, `${id}/${mood}/${phase}`).toBeLessThanOrEqual(SCENE_BOOST_MAX)
            }
          }
        }
      }
    }
    // Exhaustive sweep whose work grows with every scene added: ~2s alone, but
    // it crossed vitest's 5s default under full-suite parallel load.
  }, 20_000)

  it('is exactly 1 for every live scene when traitStrength is 0 (and no build is on)', () => {
    for (const mood of CHARACTER_MOODS) {
      const p = moodLook(mood, { traitStrength: 0, buildIntent: 0 })
      for (const id of LIVE_IDS) expect(sceneBoost(id, p), `${id}/${mood}`).toBe(1)
    }
  })

  it('accepts a scene def as well as an id', () => {
    const p = moodLook('euphoric')
    expect(sceneBoost({ id: 'beats' }, p)).toBe(sceneBoost('beats', p))
  })

  it('widens with strength: a stronger look leans harder on the same scenes', () => {
    const spread = (strength: number) => {
      const p = moodLook('euphoric', { traitStrength: strength })
      const v = PRIMARY_IDS.map((id) => sceneBoost(id, p))
      return Math.max(...v) / Math.min(...v)
    }
    expect(spread(0.8)).toBeGreaterThan(spread(0.3))
    expect(spread(0.3)).toBeGreaterThan(1)
  })
})

describe('sceneBoost: favours scenes whose traits match the profile', () => {
  const rank = (p: LookProfile, phase: BoostPhase = 'auto') =>
    PRIMARY_IDS.map((id) => [id, sceneBoost(id, p, phase)] as const).sort((a, b) => b[1] - a[1]).map(([id]) => id)

  it('serene: slow, soft, sparse scenes beat the fast, dense ones', () => {
    const p = moodLook('serene')
    for (const calm of ['snowflake', 'chrome', 'butterfly']) {
      for (const hot of ['javazone', 'beats', 'maze', 'plasma', 'lattesfold']) {
        expect(sceneBoost(calm, p), `${calm} vs ${hot}`).toBeGreaterThan(sceneBoost(hot, p))
      }
    }
  })

  it('aggressive: fast, angular scenes beat the soft ones', () => {
    const p = moodLook('aggressive')
    for (const hard of ['lattesfold', 'maze', 'plasma']) {
      for (const soft of ['snowflake', 'chrome', 'butterfly', 'travelling']) {
        expect(sceneBoost(hard, p), `${hard} vs ${soft}`).toBeGreaterThan(sceneBoost(soft, p))
      }
    }
  })

  it('a high radial target favours the mandala scenes (dreamy / epic rows)', () => {
    const p = look({ traitRadial: 1, traitTempo: 0.5, traitAngular: 0.5, traitBusy: 0.5, traitStrength: 0.8 })
    expect(sceneBoost('kifs', p)).toBeGreaterThan(sceneBoost('maze', p))
    expect(sceneBoost('snowflake', p)).toBeGreaterThan(sceneBoost('matrix', p))
  })

  it('does not depend on anything but the published trait fields (same inputs, same boost)', () => {
    const p = moodLook('groove')
    expect(sceneBoost('web', p)).toBe(sceneBoost('web', moodLook('groove')))
  })

  it('build: with a build on, a fast build scene (4D Beats) is favoured over a calm one, and the factor follows the intent', () => {
    const off = look({ traitStrength: 0, buildIntent: 0 })
    const half = look({ traitStrength: 0, buildIntent: 0.5 })
    const full = look({ traitStrength: 0, buildIntent: 1 })
    expect(sceneBoost('beats', off)).toBe(1)
    expect(sceneBoost('beats', half)).toBeGreaterThan(1)
    expect(sceneBoost('beats', full)).toBeGreaterThan(sceneBoost('beats', half))
    expect(sceneBoost('beats', full)).toBeGreaterThan(2.5) // buildFit .95 of the way to the ceiling
    expect(sceneBoost('beats', full)).toBeLessThanOrEqual(SCENE_BOOST_MAX)
    expect(sceneBoost('snowflake', full)).toBeLessThan(1)
    expect(sceneBoost('beats', full)).toBeGreaterThan(sceneBoost('wireframe', full))
    // Beats tops the primaries during a full build.
    const order = rank(full)
    expect(order.slice(0, 4)).toContain('beats')
    expect(order.slice(-3)).toContain('snowflake')
  })

  it("phase 'build' treats the build as fully on even before the tracker's ramp has climbed", () => {
    const early = look({ traitStrength: 0, buildIntent: 0.05 })
    const full = look({ traitStrength: 0, buildIntent: 1 })
    for (const id of PRIMARY_IDS) expect(sceneBoost(id, early, 'build'), id).toBeCloseTo(sceneBoost(id, full, 'auto'), 10)
    expect(sceneBoost('beats', early, 'auto')).toBeLessThan(sceneBoost('beats', early, 'build'))
  })

  it("phase 'drop' swaps the build factor for dropFit: shock-like scenes up, build-only scenes down", () => {
    const p = look({ traitStrength: 0, buildIntent: 1 })
    expect(sceneBoost('plasma', p, 'drop')).toBeGreaterThan(sceneBoost('snowflake', p, 'drop'))
    expect(sceneBoost('plasma', p, 'drop')).toBeGreaterThan(sceneBoost('pointcloud', p, 'drop'))
    // A drop is not a build: buildIntent is ignored in the drop phase.
    expect(sceneBoost('beats', p, 'drop')).toBe(sceneBoost('beats', look({ traitStrength: 0, buildIntent: 0 }), 'drop'))
  })
})

describe('mode meaning: preferredModes / pickVariedMode with a look', () => {
  const angular = () =>
    look({ traitAngular: 0.95, traitBusy: 0.3, traitTempo: 0.9, harsh: 0.9, busy: 0.3 })
  const busy = () => look({ traitAngular: 0.3, traitBusy: 0.9, traitTempo: 0.8, harsh: 0.3, busy: 0.9 })
  const calm = () => look({ traitAngular: 0.1, traitBusy: 0.15, traitTempo: 0.1, harsh: 0.2, busy: 0.2 })
  const MODES = ['crystal', 'shard', 'cage']

  it('scores the wireframe modes by meaning: shard is angular, cage is busy, crystal is calm', () => {
    const fits = (p: LookProfile) => Object.fromEntries(MODES.map((m) => [m, modeFit('wireframe', m, p)!]))
    const a = fits(angular())
    expect(a.shard).toBeGreaterThan(a.cage)
    expect(a.shard).toBeGreaterThan(a.crystal)
    const b = fits(busy())
    expect(b.cage).toBeGreaterThan(b.shard)
    expect(b.cage).toBeGreaterThan(b.crystal)
    const c = fits(calm())
    expect(c.crystal).toBeGreaterThan(c.shard)
    expect(c.crystal).toBeGreaterThan(c.cage)
  })

  it('has no meaning for an unknown scene or mode (no preference)', () => {
    expect(modeFit('limitless', 'melt', angular())).toBeUndefined()
    expect(modeFit('wireframe', 'no-such-mode', angular())).toBeUndefined()
    expect(preferredModes('limitless', ['smear', 'melt'], angular())).toEqual(['smear', 'melt'])
    // One choice without a meaning keeps the whole list (a partial ranking would be arbitrary).
    expect(preferredModes('wireframe', ['shard', 'no-such-mode'], angular())).toEqual(['shard', 'no-such-mode'])
  })

  it('an angular / harsh look moves wireframe to shard; a busy look to cage; a calm look to crystal', () => {
    for (let r = 0; r < 12; r++) {
      expect(pickVariedMode('wireframe', 'crystal', r, angular()), `angular r${r}`).toBe('shard')
      expect(pickVariedMode('wireframe', 'cage', r, angular()), `angular r${r}`).toBe('shard')
      expect(pickVariedMode('wireframe', 'crystal', r, busy()), `busy r${r}`).toBe('cage')
      expect(pickVariedMode('wireframe', 'shard', r, busy()), `busy r${r}`).toBe('cage')
      expect(pickVariedMode('wireframe', 'shard', r, calm()), `calm r${r}`).toBe('crystal')
      expect(pickVariedMode('wireframe', 'cage', r, calm()), `calm r${r}`).toBe('crystal')
    }
  })

  it('never returns the mode already showing, whatever the look, and is deterministic', () => {
    for (const p of [angular(), busy(), calm(), look()]) {
      for (const current of [...MODES, undefined]) {
        for (let r = 0; r < 9; r++) {
          const m = pickVariedMode('wireframe', current, r, p)
          expect(m).toBeDefined()
          expect(m).not.toBe(current)
          expect(m).toBe(pickVariedMode('wireframe', current, r, p))
        }
      }
    }
  })

  it('still rotates among modes that tie (a neutral look does not pin one mode)', () => {
    const seen = new Set<string>()
    for (let r = 0; r < 12; r++) seen.add(pickVariedMode('wireframe', 'crystal', r, look())!)
    expect(seen.size).toBe(2) // shard and cage both stay in play
  })

  it("is today's behaviour when the look is undefined, invalid, or has the scene family off", () => {
    const off = angular()
    off.families.scene = false
    const invalid = angular()
    invalid.valid = false
    for (const current of [...MODES, undefined]) {
      for (let r = 0; r < 12; r++) {
        const plain = pickVariedMode('wireframe', current, r)
        expect(pickVariedMode('wireframe', current, r, undefined)).toBe(plain)
        expect(pickVariedMode('wireframe', current, r, off)).toBe(plain)
        expect(pickVariedMode('wireframe', current, r, invalid)).toBe(plain)
      }
    }
  })

  it('leaves limitless (17 modes, no authored meaning) and non-mode scenes on the plain rotation', () => {
    for (let r = 0; r < 20; r++) {
      expect(pickVariedMode('limitless', 'none', r, angular())).toBe(pickVariedMode('limitless', 'none', r))
      expect(pickVariedMode('plasma', undefined, r, angular())).toBeUndefined()
      expect(pickVariedMode('does-not-exist', undefined, r, angular())).toBeUndefined()
    }
  })
})

describe('directorSteers opt-ins', () => {
  it('every opt-in names a dial the scene declares and honours in every mode', () => {
    for (const s of SCENES) {
      const c = s.metadata.contract
      if (!c?.directorSteers) continue
      const modes: (string | undefined)[] = c.modes?.length ? c.modes : [undefined]
      for (const key of c.directorSteers) {
        expect(['shape', 'tilt'], `${s.id}.${key}`).toContain(key)
        expect(key in c.params, `${s.id} opts in to ${key} but does not declare it`).toBe(true)
        for (const m of modes) expect(isParamLive(c, m, key), `${s.id}.${key} in mode ${m}`).toBe(true)
      }
    }
  })

  it("opts 4D Beats' tilt (the 4D angle) in, and keeps Fractal Rose Window's symmetry OUT of the director steer (it made the rose bounce)", () => {
    const get = (id: string) => SCENES.find((s) => s.id === id)?.metadata.contract
    expect(get('beats')?.directorSteers).toEqual(['tilt'])
    expect(get('kifs')?.directorSteers).toBeUndefined()
    expect(get('beats')?.paramLabels?.['*']?.tilt).toBe('4D angle')
    expect(get('kifs')?.paramLabels?.['*']?.shape).toBe('symmetry')
  })
})
