import { describe, expect, it } from 'vitest'
import {
  commerciallyShippableScenes,
  DISABLED_SCENES,
  KNOWN_NC_SOURCE_IDS,
  nonCommercialSceneIds,
  SCENES,
} from '../index'

/**
 * Guards the one class of mistake that cannot be fixed after the fact.
 *
 * A scene that renders correctly gives no hint about whether it may legally be
 * shipped, so nothing about normal development surfaces a licence problem —
 * it only appears when someone packages a build. These assertions make the
 * licence posture a compile-and-test-time fact instead.
 */
describe('scene licensing', () => {
  it('marks every known NC scene that is currently registered', () => {
    // Driven off KNOWN_NC_SOURCE_IDS rather than a literal list, so the licence
    // fact survives a scene being temporarily disabled — which is precisely
    // when someone would re-enable it later having forgotten.
    for (const id of KNOWN_NC_SOURCE_IDS) {
      const scene = SCENES.find((s) => s.id === id)
      if (!scene) continue
      expect(scene.metadata.license, id).toBe('noncommercial')
    }
  })

  it('marks known NC scenes even while they sit in DISABLED_SCENES', () => {
    // A disabled scene is one edit away from being re-enabled, so its licence
    // marking has to be correct the whole time it is out of the roster.
    for (const id of KNOWN_NC_SOURCE_IDS) {
      const scene = DISABLED_SCENES.find((s) => s.id === id)
      if (!scene) continue
      expect(scene.metadata.license, id).toBe('noncommercial')
    }
  })

  it('accounts for every known NC id in exactly one of the two arrays', () => {
    // Guards the third failure mode: an NC scene quietly deleted from both,
    // leaving KNOWN_NC_SOURCE_IDS stale and the next reader misinformed.
    for (const id of KNOWN_NC_SOURCE_IDS) {
      const found =
        SCENES.some((s) => s.id === id) || DISABLED_SCENES.some((s) => s.id === id)
      expect(found, `${id} is registered or explicitly disabled`).toBe(true)
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
