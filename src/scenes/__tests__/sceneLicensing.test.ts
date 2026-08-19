import { describe, expect, it } from 'vitest'
import { commerciallyShippableScenes, nonCommercialSceneIds, SCENES } from '../index'

/**
 * Guards the one class of mistake that cannot be fixed after the fact.
 *
 * A scene that renders correctly gives no hint about whether it may legally be
 * shipped, so nothing about normal development surfaces a licence problem —
 * it only appears when someone packages a build. These assertions make the
 * licence posture a compile-and-test-time fact instead.
 */
describe('scene licensing', () => {
  it('keeps every known NC-encumbered scene marked', () => {
    // CC BY-NC-SA 3.0, both of them. If either flips to `original` or
    // `attribution` the packaging step would silently start including it.
    for (const id of ['synthgrid', 'panic']) {
      const scene = SCENES.find((s) => s.id === id)
      expect(scene, `${id} is registered`).toBeDefined()
      expect(scene!.metadata.license, id).toBe('noncommercial')
    }
  })

  it('excludes every restricted scene from the shippable set', () => {
    const blocked = new Set(nonCommercialSceneIds())
    expect(blocked.size).toBeGreaterThan(0)
    for (const s of commerciallyShippableScenes()) {
      expect(blocked, `${s.id} must not be shippable`).not.toContain(s.id)
    }
  })

  it('treats an unmarked scene as unrestricted, so marking is opt-IN', () => {
    // Deliberate: the default is `original`, because most scenes are. The guard
    // against a mis-marked port is the explicit assertion above plus review,
    // not a default that would spuriously block the whole roster.
    const unmarked = SCENES.filter((s) => s.metadata.license === undefined)
    for (const s of unmarked) {
      expect(nonCommercialSceneIds(), s.id).not.toContain(s.id)
    }
  })

  it('never lets a restricted scene be the SCENES[0] fallback', () => {
    // getScene() falls back to SCENES[0] for any unknown id, so a restricted
    // scene sitting there would be reachable from a stale preset or URL even in
    // a build that had excluded it.
    expect(SCENES[0].metadata.license ?? 'original').not.toBe('noncommercial')
  })
})
