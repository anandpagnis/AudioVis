import { describe, expect, it } from 'vitest'
import { MOOD_STATES } from '../../audio/types'
import {
  BUDGET_BY_COST,
  MAX_PIXEL_BUDGET,
  MIN_PIXEL_BUDGET,
  NATIVE_PIXEL_BUDGET,
  RENDER_SCALE_FLOOR,
  UNTRUSTED_MAX_BUDGET,
  combinePixelBudgets,
  resolvePixelBudget,
  solveRenderScale,
} from '../../engine/renderScale'
import {
  SCENES,
  getResolvedManifest,
  getScene,
  getScenePixelBudget,
  getSceneContract,
  getScenesForMood,
  pickVariedMode,
  registerScene,
  scenePixelBudget,
  validateSceneDef,
} from '../index'

/**
 * Registry integrity. Every failure here is the kind that regresses invisibly:
 * a dangling id or an uncovered mood still compiles, still renders, and only
 * shows up as a scene that silently never gets picked — or a crash deep in a
 * lazy import long after the mistake was made.
 */
describe('scene registry', () => {
  it('every compatibleWith id refers to a registered scene', () => {
    const ids = new Set(SCENES.map((s) => s.id))
    for (const scene of SCENES) {
      for (const id of scene.metadata.compatibleWith) {
        expect(ids, `${scene.id}.compatibleWith references unregistered "${id}"`).toContain(id)
      }
    }
  })

  it('no scene lists itself as compatible with itself', () => {
    for (const scene of SCENES) {
      expect(scene.metadata.compatibleWith, scene.id).not.toContain(scene.id)
    }
  })

  it('scene ids are unique', () => {
    const ids = SCENES.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('every mood a scene claims is a real mood state', () => {
    for (const scene of SCENES) {
      for (const mood of scene.metadata.moods) {
        expect(MOOD_STATES, `${scene.id} claims unknown mood "${mood}"`).toContain(mood)
      }
    }
  })

  it('every non-silence mood has at least one PRIMARY-capable scene', () => {
    // The directors pick a primary per mood. A mood with no primary-capable
    // scene leaves them with an empty pool and the show stuck on whatever was
    // already on screen — which looks like "automation stopped working",
    // nowhere near the roles array that actually caused it.
    for (const mood of MOOD_STATES) {
      if (mood === 'silence') continue
      const primaries = getScenesForMood(mood).filter((s) => s.metadata.roles.includes('primary'))
      expect(primaries.length, `mood "${mood}" has no primary-capable scene`).toBeGreaterThan(0)
    }
  })

  it('moodFit only scores moods the scene actually claims', () => {
    for (const scene of SCENES) {
      for (const mood of Object.keys(scene.metadata.moodFit ?? {})) {
        expect(
          scene.metadata.moods,
          `${scene.id} scores moodFit for "${mood}" but does not list it in moods`,
        ).toContain(mood)
      }
    }
  })

  it('getScene falls back to SCENES[0] for an unknown id', () => {
    // Load-bearing: a stale persisted sceneId, preset, cue or ?scene= param
    // must degrade to a working scene rather than throw.
    expect(getScene('does-not-exist')).toBe(SCENES[0])
    expect(SCENES[0].metadata.roles).toContain('primary')
  })

  it('every scene resolves a streaming manifest', () => {
    for (const scene of SCENES) {
      const manifest = getResolvedManifest(scene.id)
      expect(manifest.cost.vramMB, scene.id).toBeGreaterThan(0)
      expect(manifest.estPreloadMs, scene.id).toBeGreaterThan(0)
    }
  })
  it('resolves a legal pixel budget for every scene, declared or derived', () => {
    // The engine-owned half of quality governance. Nothing has to declare a
    // budget any more — `resolvePixelBudget` derives one from `performanceCost`
    // when a scene is silent — but every scene still has to RESOLVE to a legal
    // one, which is what would fail if the derivation table were ever missing a
    // cost class.
    for (const scene of SCENES) {
      const budget = scenePixelBudget(scene)
      expect(typeof budget, scene.id).toBe('number')
      expect(budget, scene.id).toBeGreaterThanOrEqual(MIN_PIXEL_BUDGET)
      expect(budget, scene.id).toBeLessThanOrEqual(MAX_PIXEL_BUDGET)
    }
  })

  it('derives a budget from performanceCost when a scene is silent', () => {
    // The load-bearing behaviour change from the old "every scene must declare
    // one" contract: silence is now legal, and it resolves to the engine's own
    // opinion rather than to native resolution — a fullscreen shader that says
    // nothing about its cost is assumed fill-bound, not exempt.
    expect(resolvePixelBudget({ performanceCost: 'high' })).toBe(BUDGET_BY_COST.high)
    expect(resolvePixelBudget({ performanceCost: 'medium' })).toBe(BUDGET_BY_COST.medium)
    expect(resolvePixelBudget({ performanceCost: 'low' })).toBe(BUDGET_BY_COST.low)
    // A scene has to say `fillBound: false` OUT LOUD to get out of scaling —
    // omitting the field is not the same as opting out.
    expect(resolvePixelBudget({ performanceCost: 'high', fillBound: false })).toBe(
      NATIVE_PIXEL_BUDGET,
    )
  })

  it("caps an untrusted scene's claimed budget rather than believing it", () => {
    // The provenance gate: a claim the engine cannot verify is bounded rather
    // than honoured, so a stranger's upload cannot declare its way to full
    // resolution on a 5K panel by simply asserting `pixelBudget: 16`.
    const claim = { performanceCost: 'low' as const, pixelBudget: NATIVE_PIXEL_BUDGET }
    expect(resolvePixelBudget(claim, true)).toBe(NATIVE_PIXEL_BUDGET)
    expect(resolvePixelBudget(claim, false)).toBe(UNTRUSTED_MAX_BUDGET)

    // `fillBound: false` from an untrusted scene is the same lie in a different
    // shape, and gets the same treatment.
    const fillClaim = { performanceCost: 'low' as const, fillBound: false }
    expect(resolvePixelBudget(fillClaim, false)).toBe(UNTRUSTED_MAX_BUDGET)
  })

  it('marks a registerScene() addition untrusted unless told otherwise', () => {
    const before = SCENES.length
    const naked = {
      id: '__test-untrusted-registration',
      name: 'Untrusted',
      component: () => null,
      metadata: {
        roles: ['primary'],
        moods: ['groove'],
        bands: ['energy'],
        intensity: 'medium',
        compatibleWith: [],
        performanceCost: 'low',
        pixelBudget: NATIVE_PIXEL_BUDGET,
      },
    } as unknown as Parameters<typeof registerScene>[0]
    registerScene(naked)
    try {
      expect(SCENES.length).toBe(before + 1)
      // Registered, but its optimistic claim does not reach the render loop.
      expect(getScenePixelBudget('__test-untrusted-registration')).toBe(UNTRUSTED_MAX_BUDGET)
    } finally {
      // registerScene has no unregister; splice the fixture back out so this
      // test does not leak a scene into every test file that imports SCENES.
      const idx = SCENES.findIndex((s) => s.id === '__test-untrusted-registration')
      if (idx >= 0) SCENES.splice(idx, 1)
    }
  })

  it('rejects a registration with a malformed pixel budget', () => {
    // Checked, not required — an ABSENT budget is legal and derives one. A
    // PRESENT but out-of-range one is a mistake: it would otherwise be silently
    // discarded and the scene would render at a resolution its author neither
    // chose nor was told about.
    const absurd = {
      id: 'untrusted',
      name: 'Untrusted',
      component: () => null,
      metadata: {
        roles: ['primary'],
        moods: ['groove'],
        bands: ['energy'],
        intensity: 'medium',
        compatibleWith: [],
        performanceCost: 'high',
        pixelBudget: 500,
      },
    } as unknown as Parameters<typeof validateSceneDef>[0]
    expect(validateSceneDef(absurd).join(' ')).toContain('pixelBudget')
  })

  it('holds every scene inside its resolved budget, on any display', () => {
    // The venue guarantee, stated as an invariant rather than as intent: what a
    // scene renders is bounded by what it resolves to, not by what the display
    // happens to be. That is false without a budget — a raymarcher on a 5K
    // panel marches 29.5 MP, 14x a 1080p frame, and no amount of complexity
    // reduction closes a 14x gap.
    const displays = [
      (1920 * 1080) / 1e6, // 1080p, 1x
      (1728 * 2 * 1117 * 2) / 1e6, // Retina 16"
      (5120 * 2880) / 1e6, // 5K
    ]
    for (const scene of SCENES) {
      const budget = scenePixelBudget(scene)
      for (const full of displays) {
        const scale = solveRenderScale(budget, full)
        const internal = full * scale * scale
        // The floor is the one thing allowed to override a budget, and it is
        // deliberate: below 0.4 linear the picture is mush, so a display that
        // cannot hold the budget even there is handed to the tier ladder's
        // complexity knobs instead of scaled further. `+ 0.05` covers the 1/100
        // quantisation in the solve, which can round the scale up half a step.
        const ceiling = Math.max(budget, full * RENDER_SCALE_FLOOR * RENDER_SCALE_FLOOR)
        expect(
          internal,
          `${scene.id} renders ${internal.toFixed(2)} MP against a ${budget} MP budget`,
        ).toBeLessThanOrEqual(ceiling + 0.05)
      }
    }
  })

  it('caps every fill-bound scene near a 1080p frame on the largest display', () => {
    // The half of the guarantee that is about the derivation table rather than
    // arithmetic: every declared cost class must resolve UNDER native, and by
    // enough margin that a heavy scene on a 5K panel still lands near 1080p. If
    // this ever fails, BUDGET_BY_COST has drifted rather than any one scene.
    const fiveK = (5120 * 2880) / 1e6
    for (const scene of SCENES) {
      const budget = scenePixelBudget(scene)
      if (budget >= NATIVE_PIXEL_BUDGET) continue
      const scale = solveRenderScale(budget, fiveK)
      const internal = fiveK * scale * scale
      expect(internal, `${scene.id} renders ${internal.toFixed(2)} MP on a 5K panel`).toBeLessThan(
        4.1,
      )
    }
  })

  it('a composition never costs more pixels than its cheapest member allows', () => {
    // Every layer draws into one framebuffer at one resolution, so admitting a
    // second scene must never RAISE the pixel budget. Checked across the real
    // roster because the pairs the director actually builds come from here.
    for (const primary of SCENES) {
      for (const layer of SCENES) {
        const combined = combinePixelBudgets([
          getScenePixelBudget(primary.id),
          getScenePixelBudget(layer.id),
        ])
        expect(
          combined,
          `${primary.id} + ${layer.id} combined to more than ${primary.id} alone`,
        ).toBeLessThanOrEqual(getScenePixelBudget(primary.id))
      }
    }
  })
})

describe('pickVariedMode', () => {
  it('returns undefined for a scene with no modes, or only one', () => {
    // Most of the roster. The caller must be able to ask unconditionally.
    expect(pickVariedMode('plasma', undefined, 0)).toBeUndefined()
    expect(pickVariedMode('does-not-exist', undefined, 0)).toBeUndefined()
  })

  it('never returns the mode already showing', () => {
    // A "change" that picks the current mode is a change the viewer cannot see,
    // and it would burn the scene's variety budget doing nothing.
    const modes = getSceneContract('wireframe')?.modes ?? []
    expect(modes.length).toBeGreaterThan(1)
    for (const current of modes) {
      for (let r = 0; r < 12; r++) {
        expect(pickVariedMode('wireframe', current, r)).not.toBe(current)
      }
    }
  })

  it('is deterministic, so a recorded set replays identically', () => {
    // Same contract as pickPalette's rotation counter.
    expect(pickVariedMode('wireframe', 'crystal', 5)).toBe(
      pickVariedMode('wireframe', 'crystal', 5),
    )
  })

  it('reaches every other mode as the rotation advances', () => {
    // Otherwise a scene with three looks would still only ever show two.
    const modes = getSceneContract('wireframe')?.modes ?? []
    const seen = new Set<string>()
    for (let r = 0; r < 12; r++) {
      const m = pickVariedMode('wireframe', 'crystal', r)
      if (m) seen.add(m)
    }
    expect(seen.size).toBe(modes.length - 1)
  })
})
