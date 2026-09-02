import { describe, expect, it } from 'vitest'
import {
  commerciallyShippableScenes,
  DISABLED_SCENES,
  isNonCommercial,
  KNOWN_NC_SOURCE_IDS,
  nonCommercialSceneIds,
  SCENES,
  type SceneDef,
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

  it('exercises the real predicate against known-restricted scenes', () => {
    // NOT asserted against the live SCENES roster: a commercial-launch pass
    // moved every non-original/non-attribution scene out of it into
    // DISABLED_SCENES, so the live roster can legitimately contain zero
    // restricted scenes — that is the intended end state, not a gap to guard
    // against. DISABLED_SCENES exists specifically to hold restricted-licence
    // scenes, so it is guaranteed non-empty and is what proves the predicate
    // itself still correctly identifies them.
    const restricted = DISABLED_SCENES.filter(isNonCommercial)
    expect(restricted.length).toBeGreaterThan(0)
    for (const s of restricted) {
      expect(s.metadata.license, s.id).not.toBe('original')
      expect(s.metadata.license, s.id).not.toBe('attribution')
    }
  })

  it('excludes every restricted scene from the shippable set', () => {
    const blocked = new Set(nonCommercialSceneIds())
    for (const s of commerciallyShippableScenes()) {
      expect(blocked, `${s.id} must not be shippable`).not.toContain(s.id)
    }
  })

  it('reports the live roster as fully shippable once every restricted scene is quarantined', () => {
    // Currently true and worth pinning: if this regresses, either a restricted
    // scene was moved back into SCENES without clearing its licence, or a
    // newly-added scene shipped with no licence declaration at all — which now
    // FAILS this assertion rather than passing it silently, because absent
    // reads as `unverified`. That inversion is the whole of F01; the test below
    // pins the default itself.
    expect(commerciallyShippableScenes().length).toBe(SCENES.length)
  })

  it('treats an unmarked scene as restricted, so shippability is opt-IN', () => {
    // The inverse of what this test asserted before F01 landed, and the
    // inversion is the point. The old default was `original` on the reasoning
    // that most scenes are — but "most" is a property of the roster as it
    // happened to stand, not of the next scene to be added, and the next scene
    // to be added is now an ISF or Shadertoy import (F179). A default of
    // `original` reads silence as a positive claim of authorship, which is
    // precisely what an unattributed paste offers.
    //
    // Constructed rather than filtered: every live scene declares a licence
    // explicitly now, so a filter over SCENES would find nothing and the test
    // would pass while asserting about the empty set. This exercises the real
    // predicate against the shape a forgetful import actually has.
    const unmarked: SceneDef = {
      id: '__unmarked_import__',
      name: 'Unmarked Import',
      component: SCENES[0].component,
      metadata: { ...SCENES[0].metadata, license: undefined },
    }
    expect(isNonCommercial(unmarked)).toBe(true)

    // And the roster genuinely has none left relying on the default, which is
    // what makes the strict default affordable — see F01's closing note.
    expect(SCENES.filter((s) => s.metadata.license === undefined)).toEqual([])
  })

  it('backs every non-original licence in the live roster with a provenance record', () => {
    // The tripwire for the ISF import pipeline (F179). `attribution` is a legal
    // obligation to credit a named party, and a scene claiming it with nowhere
    // to store the credit is worse than one marked `unverified` — it reads as
    // cleared while carrying an unmet condition. So the moment a scene is
    // anything other than "we wrote it", it must say where it came from.
    //
    // Scoped to SCENES, not DISABLED_SCENES, and deliberately: quarantined
    // scenes cannot ship, and several of them are permanently unclearable
    // because their pastes recorded no author, title or URL at all (see the
    // DISABLED_SCENES doc comment). Asserting over them would only invite
    // someone to fill the field with something invented to make it green,
    // which destroys the one thing the field is for. The live roster is where
    // imports land, so the live roster is where the gate belongs.
    for (const s of SCENES) {
      const l = s.metadata.license ?? 'unverified'
      if (l === 'original') continue
      const p = s.metadata.provenance
      expect(p, `${s.id} declares '${l}' and must record where it came from`).toBeDefined()
      expect(p?.source.length, `${s.id} provenance.source`).toBeGreaterThan(0)
      expect(p?.spdx.length, `${s.id} provenance.spdx`).toBeGreaterThan(0)
    }
  })

  it('keeps every provenance record it does have well-formed, quarantine included', () => {
    // Weaker than the roster gate above on purpose. A quarantined scene is not
    // required to have provenance — nothing truthful exists for six of them —
    // but a record that IS present is what a future re-enablement or a credits
    // screen would be built from, so a half-filled one is a trap.
    for (const s of [...SCENES, ...DISABLED_SCENES]) {
      const p = s.metadata.provenance
      if (!p) continue
      expect(p.source.trim().length, `${s.id} provenance.source`).toBeGreaterThan(0)
      expect(p.spdx.trim().length, `${s.id} provenance.spdx`).toBeGreaterThan(0)
      // NOASSERTION is SPDX's own token for "found the work, found no licence",
      // which is the honest reading of an unmarked Shadertoy paste. It is a
      // legitimate value; the empty string and a bare "unknown" are not.
      expect(p.spdx, `${s.id} provenance.spdx`).not.toBe('unknown')
    }
  })

  it('never lets a restricted scene be the SCENES[0] fallback', () => {
    // getScene() falls back to SCENES[0] for any unknown id, so a restricted
    // scene sitting there would be reachable from a stale preset or URL even in
    // a build that had excluded it. Runs the real predicate rather than
    // re-spelling the default, so it cannot drift away from isNonCommercial().
    expect(isNonCommercial(SCENES[0])).toBe(false)
  })
})
