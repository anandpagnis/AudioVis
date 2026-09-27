import { describe, expect, it } from 'vitest'
import BRIDGE_SRC from '../../engine/PerformanceStateBridge.tsx?raw'
import DIRECTOR_SRC from '../../engine/PerformanceDirector.tsx?raw'
import SCENE_MANAGER_SRC from '../../engine/SceneManager.tsx?raw'
import { canHoldRole, getCompatibleScenes, getScene, sceneOwnsFrame, SCENES } from '../index'

/**
 * Layer tenancy for the three flow scenes (owner's call, 2026-09-25):
 * `tribalentity` and `mothwings` are primary scenes that composite alone;
 * `inkfluid` may also be an accent.
 *
 * The bug this pins: both primaries declared `compatibleWith: []` meaning "owns
 * the frame", but the layer director reads an empty list as "no preference" and
 * fell back to every mood-fitting layer — so at the top tiers a background and
 * an accent/overlay were stacked on them anyway, the background showing through
 * their darks under the primary slot's additive blend.
 */

/** Comments out of a source string, so a pin on code is not fooled by prose that names it. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

describe('frame ownership: registry', () => {
  it('tribalentity and mothwings are primary-only and own the frame', () => {
    for (const id of ['tribalentity', 'mothwings']) {
      expect(getScene(id).metadata.roles).toEqual(['primary'])
      expect(sceneOwnsFrame(id)).toBe(true)
      for (const role of ['background', 'accent', 'overlay'] as const)
        expect(canHoldRole(id, role)).toBe(false)
    }
  })

  it('inkfluid can be a primary or an accent, and does not own the frame', () => {
    expect(canHoldRole('inkfluid', 'primary')).toBe(true)
    expect(canHoldRole('inkfluid', 'accent')).toBe(true)
    expect(sceneOwnsFrame('inkfluid')).toBe(false)
  })

  it('inkfluid is reachable as an accent: its partner subjects list it back', () => {
    // The layer director prefers a subject's compatible accents and only falls
    // back to the whole pool when it has none, so an accent with no partners is
    // almost never picked. Compatibility is symmetric.
    for (const id of getScene('inkfluid').metadata.compatibleWith) {
      expect(canHoldRole(id, 'primary')).toBe(true)
      expect(getCompatibleScenes(id).map((s) => s.id)).toContain('inkfluid')
    }
    expect(getScene('inkfluid').metadata.compatibleWith.length).toBeGreaterThan(0)
  })

  it('never pairs inkfluid with a subject that owns the frame', () => {
    for (const s of getCompatibleScenes('inkfluid')) expect(sceneOwnsFrame(s.id)).toBe(false)
  })

  it('only primary-capable scenes claim to own the frame', () => {
    for (const s of SCENES) if (s.metadata.ownsFrame) expect(s.metadata.roles).toContain('primary')
  })

  it('is null-safe for a pending id', () => {
    expect(sceneOwnsFrame(null)).toBe(false)
    expect(sceneOwnsFrame(undefined)).toBe(false)
    expect(sceneOwnsFrame('no-such-scene')).toBe(false)
  })
})

describe('frame ownership: wiring (source pins)', () => {
  it('the bridge holds every layer null while the committed OR incoming subject owns the frame', () => {
    const bridge = code(BRIDGE_SRC)
    expect(bridge).toMatch(
      /layersHeld\s*=\s*cutawayUp\s*\|\|\s*sceneOwnsFrame\(s\.sceneId\)\s*\|\|\s*sceneOwnsFrame\(s\.pendingSceneId\)/,
    )
    for (const role of ['background', 'accent', 'overlay']) {
      expect(bridge).toMatch(
        new RegExp(`p\\.layers\\.${role}\\s*=\\s*layersHeld\\s*\\?\\s*null\\s*:`),
      )
    }
  })

  it('the director composes no layer for a subject that owns the frame', () => {
    const director = code(DIRECTOR_SRC)
    expect(director).toMatch(/owned\s*=\s*sceneOwnsFrame\(primaryId\)/)
    expect(director).toMatch(/forRole\s*=\s*\(role: LayerRole\)\s*=>\s*owned\s*\?\s*\[\]\s*:/)
  })

  it('SceneManager withholds mounting layers, not just the telemetry copy, while a cutaway or a frame-owning subject is up', () => {
    // The bridge and the director above both only gate what they own — a
    // TELEMETRY desire and an AUTO pick. Neither stops a layer that was already
    // set (manually, or by a stale auto pick) from staying mounted, rendering
    // every frame, and bleeding into the composite. `resolveLayerIds` is fed
    // from the raw store desire; this pins that the call site itself refuses to
    // pass that desire through under the same conditions the bridge holds
    // `performanceState.layers` null for.
    const manager = code(SCENE_MANAGER_SRC)
    expect(manager).toMatch(
      /layersHeld\s*=\s*\n?\s*performanceState\.djCam\.active\s*\|\|\s*\n?\s*performanceState\.limitless\.active\s*\|\|\s*\n?\s*sceneOwnsFrame\(state\.sceneId\)\s*\|\|\s*\n?\s*sceneOwnsFrame\(state\.pendingSceneId\)/,
    )
    expect(manager).toMatch(
      /resolveLayerIds\(\s*\n?\s*layersHeld\s*\?\s*EMPTY_LAYER_IDS\s*:\s*state\.layerSceneIds,/,
    )
  })
})
