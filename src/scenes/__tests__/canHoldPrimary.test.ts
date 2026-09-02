import { describe, expect, it } from 'vitest'
import HUD_SRC from '../../ui/HUD.tsx?raw'
import { SCENES, canHoldPrimary, getEffectScenes } from '../index'

/**
 * The subject slot will not accept a scene that cannot hold it.
 *
 * ## The bug this pins
 *
 * `Shock Ring`, `Section Flare` and `Transient Spark` were selectable from the
 * HUD's scene chips and from the number-key shortcuts, because both listed
 * `SCENES` unfiltered. Picking one blacked the show out, and nothing anywhere
 * logged an error.
 *
 * The mechanism is worth writing down, because none of it is visible from the
 * scenes themselves — all three shaders are correct, and two of the three do not
 * even read `slotProgress` in GLSL:
 *
 * 1. `effect` scenes are PINNED in `SceneManager` as idle entries (`dir === 0`)
 *    so that a firing costs no shader compile. They are mounted the whole show.
 * 2. The commit path looked for a warm entry to promote **by id alone**, so a
 *    requested `shock` matched its own pinned *effect* entry.
 * 3. Promotion sets `dir = 1` and never touches `role`. The entry went live as
 *    the subject while still declaring `role: 'effect'` — and the real primary
 *    was retired to make room for it.
 * 4. `slotProgress` is 0 outside a live firing (`sceneFrame.ts`), and every
 *    effect scene multiplies its output by `effectEnvelope(slotProgress)`, which
 *    is 0 at 0 **by contract** — the slot requires reaching visual zero at both
 *    ends. So the promoted scene correctly rendered nothing.
 *
 * A black frame produced by four individually correct behaviours. The guard is
 * at `store.requestScene`, the choke point every caller passes through, with a
 * second one on the `SceneManager` lookup so the invariant lives next to the
 * code that depends on it.
 */
describe('canHoldPrimary', () => {
  it('refuses every effect scene', () => {
    const effects = getEffectScenes()
    expect(effects.length).toBeGreaterThan(0)
    for (const s of effects) {
      expect(canHoldPrimary(s.id), `${s.id} must not be selectable as the subject`).toBe(false)
    }
  })

  it('refuses an id that names no registered scene', () => {
    // The trap that makes the obvious spelling wrong. `getScene` falls back to
    // `SCENES[0]` for an unknown id, and `SCENES[0]` is primary-capable by
    // invariant — so `getScene(id).metadata.roles.includes('primary')` answers
    // TRUE for every typo. A guard that passes on garbage is not a guard.
    expect(canHoldPrimary('no-such-scene')).toBe(false)
    expect(canHoldPrimary('')).toBe(false)
  })

  it('accepts exactly the scenes that declare the role', () => {
    for (const s of SCENES) {
      expect(canHoldPrimary(s.id), s.id).toBe(s.metadata.roles.includes('primary'))
    }
  })

  it('leaves at least one scene pickable', () => {
    // Guards against a filter that is correct but total: an empty picker is a
    // worse bug than the one being fixed here.
    expect(SCENES.filter((s) => canHoldPrimary(s.id)).length).toBeGreaterThan(0)
  })
})

describe('the HUD picker', () => {
  it('offers PICKABLE_SCENES, not the raw registry', () => {
    // Source-order check, and labelled as one: rendering the HUD needs a DOM and
    // a store, which this suite has no business standing up to assert a filter.
    // Both the chips and the number-key shortcut read the filtered list.
    expect(HUD_SRC).toContain('PICKABLE_SCENES.map(')
    expect(HUD_SRC).toContain('PICKABLE_SCENES[idx].id')
    // `\b` matters: `PICKABLE_SCENES[idx]` ends in `_SCENES[idx]`, and `_` is a
    // word character, so an unanchored /SCENES\[idx\]/ matches the fixed code.
    expect(HUD_SRC).not.toMatch(/\{SCENES\.map\(/)
    expect(HUD_SRC).not.toMatch(/\bSCENES\[idx\]/)
  })

  it("derives that list from the same predicate as the store's guard", () => {
    // If the picker's filter and `canHoldPrimary` ever disagree, the UI offers a
    // chip that `requestScene` silently declines — which looks exactly like the
    // original bug to anyone using it.
    expect(HUD_SRC).toMatch(/PICKABLE_SCENES\s*=\s*SCENES\.filter\(.*roles\.includes\('primary'\)/s)
  })
})
