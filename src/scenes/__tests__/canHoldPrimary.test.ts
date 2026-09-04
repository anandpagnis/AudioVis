import { describe, expect, it } from 'vitest'
import HUD_SRC from '../../ui/HUD.tsx?raw'
import CONSOLE_SRC from '../../ui/Console.tsx?raw'
import { LAYER_ROLES } from '../../store'
import { SCENES, canHoldPrimary, canHoldRole, getEffectScenes } from '../index'

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

/**
 * `Console.tsx` is a second, independent surface with the exact same shape of
 * bug: a scene grid calling `requestScene` and a per-layer picker listing every
 * scene. Both were unfiltered — the HUD fix (above) covered only the surface
 * that had actually been clicked and reported broken. `store.requestScene`'s
 * guard made the grid harmless (a press silently did nothing) but not correct:
 * a dead tile is still a bug the operator sees. `setLayer` had NO guard at all,
 * so a layer picker could mount `shock` as a permanent background wash — not a
 * black frame (a layer mount uses the ROLE passed in, not the scene's declared
 * role, so `effectEnvelope` never enters it), but a scene never priced or
 * profiled for running continuously.
 *
 * ## What changed under these assertions, and what did not
 *
 * The layer pickers were three `<select>`s in the console's Look column when
 * these tests were written; they are now role-labelled tile groups in the Scene
 * column, beside the subject grid, and the roster's `effect` scenes are shown
 * there too as inert status chips. The markup is different. The guarantee is
 * not, and it is the guarantee these assertions exist for:
 *
 *  - the subject grid offers only primary-capable scenes, and derives that from
 *    the same predicate the store's own guard uses;
 *  - each layer picker offers only scenes eligible for ITS role, by the same
 *    predicate `setLayer` enforces;
 *  - no effect scene is wired to `requestScene` from this surface.
 *
 * Source-order checks, and labelled as such for the reason the HUD block above
 * gives: rendering the console needs a DOM, a store and a live telemetry poll,
 * none of which this suite has any business standing up to assert a filter.
 */
describe('the Console picker', () => {
  it('offers PICKABLE_SCENES for the subject grid, not the raw registry', () => {
    expect(CONSOLE_SRC).toContain('PICKABLE_SCENES.map(')
    expect(CONSOLE_SRC).not.toMatch(/\{SCENES\.map\(/)
  })

  it("derives PICKABLE_SCENES from canHoldRole, so it can't drift from the store's own guard", () => {
    expect(CONSOLE_SRC).toMatch(
      /PICKABLE_SCENES\s*=\s*SCENES\.filter\(.*canHoldRole\(.*'primary'\)/s,
    )
  })

  it('filters each layer picker by eligibility for that role', () => {
    expect(CONSOLE_SRC).toMatch(/SCENES\.filter\(.*canHoldRole\(.*role\)/s)
  })

  it('feeds that filtered list to setLayer for the same role it filtered on', () => {
    // The filter is only worth anything if the tiles it produces drive the slot
    // it was computed for. A group that filtered on `role` and then wrote to a
    // hard-coded one would pass the assertion above and still mount an
    // ineligible scene — `setLayer` would decline it, and the tile would sit
    // there never lighting up, which is F180's silent-dead-control failure with
    // a different cause.
    expect(CONSOLE_SRC).toMatch(/setLayer\(role,/)
  })

  it('shows effect scenes without wiring any of them to requestScene', () => {
    // The console lists the `effect` roster so an operator can see what is
    // firing. Listing them is safe; making them pressable is the original bug.
    // `requestScene` would refuse one anyway, which is exactly the problem — the
    // tile would look live and do nothing forever.
    //
    // Counted rather than pattern-matched: any second call site on this surface
    // is a new way to ask for a subject, and this file cannot tell from a regex
    // whether the id reaching it came from `PICKABLE_SCENES` or from the effect
    // list next to it. One call site, from the grid asserted above, is the
    // invariant worth pinning.
    expect(CONSOLE_SRC).toContain('EFFECT_SCENES = getEffectScenes()')
    expect(
      CONSOLE_SRC.match(/requestScene\(/g)?.length,
      'Console.tsx should have exactly one requestScene call site: the subject grid',
    ).toBe(1)
  })
})

describe('canHoldRole', () => {
  it('agrees with canHoldPrimary for the primary role', () => {
    for (const s of SCENES) {
      expect(canHoldRole(s.id, 'primary'), s.id).toBe(canHoldPrimary(s.id))
    }
  })

  it('refuses an unknown id for every role, not just primary', () => {
    for (const role of [...LAYER_ROLES, 'primary', 'effect'] as const) {
      expect(canHoldRole('no-such-scene', role)).toBe(false)
    }
  })

  it('agrees with the scene\'s own declared roles for every layer role', () => {
    for (const s of SCENES) {
      for (const role of LAYER_ROLES) {
        expect(canHoldRole(s.id, role), `${s.id} / ${role}`).toBe(
          s.metadata.roles.includes(role),
        )
      }
    }
  })

  it('leaves at least one scene eligible for every layer role that appears in the roster', () => {
    // Mirrors HUD's own "a slot with no scenes authored for it gets no
    // control" comment — not a requirement that every role be filled, only
    // that if a scene declares itself for a role, `canHoldRole` can see it.
    for (const role of LAYER_ROLES) {
      const anyDeclared = SCENES.some((s) => s.metadata.roles.includes(role))
      const anyEligible = SCENES.some((s) => canHoldRole(s.id, role))
      expect(anyEligible, role).toBe(anyDeclared)
    }
  })
})
