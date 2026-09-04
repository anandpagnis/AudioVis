import { describe, expect, it } from 'vitest'
import STORE_SRC from '../../store.ts?raw'
import { ISF_FILTER_MS } from '../frameLoad'
import {
  advanceFilter,
  FILTER_FLOURISH_DURATION_SEC,
  pickFilter,
  type ActiveFilter,
} from '../FilterDirector'
import {
  DISABLED_FILTERS,
  FILTER_COOLDOWN_SEC,
  filterUnusableReason,
  ISF_FILTERS,
} from '../isfFilterRoster'
import { useStore } from '../../store'
import type { EffectTrigger } from '../../scenes'

const advance = (over: Partial<Parameters<typeof advanceFilter>[0]>) =>
  advanceFilter({
    active: null,
    fired: [],
    now: 10,
    headroomMs: ISF_FILTER_MS, // exactly enough, by default
    lastFiredAt: -Infinity,
    mood: 'groove',
    lastId: null,
    rotation: 0,
    ...over,
  })

describe('FILTER_FLOURISH_DURATION_SEC', () => {
  it('sits in the musical 2-4s range, consistent with effect-scene durations', () => {
    expect(FILTER_FLOURISH_DURATION_SEC).toBeGreaterThanOrEqual(2)
    expect(FILTER_FLOURISH_DURATION_SEC).toBeLessThanOrEqual(4)
  })
})

describe('pickFilter', () => {
  it('only ever returns ids from the mood’s own preference list', () => {
    for (let r = 0; r < 12; r++) {
      const id = pickFilter('peak', null, r)
      expect(
        id === null ||
          ['Broken LCD', 'Bad TV', 'JPEG Block Corruption', 'Color Invert'].includes(id),
      ).toBe(true)
    }
  })

  it('maps silence to null — no filter should fire during near-silence', () => {
    expect(pickFilter('silence', null, 0)).toBeNull()
    expect(pickFilter('silence', 'Bad TV', 7)).toBeNull()
  })

  it('excludes Color Invert (DISABLED_FILTERS) even though peak lists it', () => {
    for (let r = 0; r < 12; r++) {
      expect(pickFilter('peak', null, r)).not.toBe('Color Invert')
    }
  })

  it('rotates deterministically — same inputs, same output', () => {
    expect(pickFilter('groove', 'CMYK Halftone', 3)).toBe(pickFilter('groove', 'CMYK Halftone', 3))
  })

  it('avoids repeating the last-fired id when an alternative exists', () => {
    // building: ['Pixel Shifter', 'Bump Distortion', 'Ripples', 'Broken LCD']
    // — excluding Bump Distortion still leaves three choices.
    for (let r = 0; r < 12; r++) {
      expect(pickFilter('building', 'Bump Distortion', r)).not.toBe('Bump Distortion')
    }
  })

  it('falls back to repeating lastId when the mood has only one selectable filter', () => {
    // ambient: ['CMYK Halftone'] — a single choice, so excluding lastId would
    // leave nothing; the pool falls back to the full preferred list. Kept as
    // the roster's one deliberately single-entry mood specifically so this
    // fallback has real data to exercise — see isfFilterRoster.ts's own note.
    expect(pickFilter('ambient', 'CMYK Halftone', 0)).toBe('CMYK Halftone')
  })

  it('visits every eligible filter across a full rotation, not just one', () => {
    const seen = new Set<string | null>()
    for (let r = 0; r < 12; r++) seen.add(pickFilter('peak', null, r))
    expect(seen.size).toBeGreaterThan(1)
  })
})

describe('advanceFilter — retiring an active flourish', () => {
  it('keeps a flourish alive while inside its duration', () => {
    const active: ActiveFilter = { id: 'Bad TV', startedAt: 9, durationSec: 3.5 }
    const out = advance({ active, now: 10 })
    expect(out).toEqual(active)
  })

  it('retires a flourish once its duration has passed', () => {
    const active: ActiveFilter = { id: 'Bad TV', startedAt: 9, durationSec: 3.5 }
    const out = advance({ active, now: 13, fired: [] })
    expect(out).toBeNull()
  })

  it('drops a flourish stranded by a source restart rewinding the clock', () => {
    const active: ActiveFilter = { id: 'Bad TV', startedAt: 90, durationSec: 3.5 }
    // A new source restarts features.time at 0, leaving startedAt in the future.
    const out = advance({ active, now: 0.5, fired: [] })
    expect(out).toBeNull()
  })
})

describe('advanceFilter — admitting a new flourish', () => {
  const fired: EffectTrigger[] = ['drop']

  it('does not fire when nothing triggered this frame', () => {
    expect(advance({ fired: [] })).toBeNull()
  })

  it('fires when something triggered, cooldown has elapsed, and budget allows', () => {
    const out = advance({ fired, now: 20, lastFiredAt: 0 })
    expect(out).not.toBeNull()
    expect(out!.startedAt).toBe(20)
    expect(out!.durationSec).toBe(FILTER_FLOURISH_DURATION_SEC)
  })

  it('respects the shared cooldown', () => {
    expect(advance({ fired, now: 10, lastFiredAt: 0 })).toBeNull() // 10s < 15s
    expect(advance({ fired, now: FILTER_COOLDOWN_SEC, lastFiredAt: 0 })).not.toBeNull()
  })

  it('refuses when the budget cannot fund the filter’s reservation', () => {
    expect(advance({ fired, now: 20, lastFiredAt: 0, headroomMs: ISF_FILTER_MS - 0.01 })).toBeNull()
  })

  it('admits exactly at the headroom boundary', () => {
    expect(advance({ fired, now: 20, lastFiredAt: 0, headroomMs: ISF_FILTER_MS })).not.toBeNull()
  })

  it('does not fire during silence — the mood list is empty', () => {
    expect(advance({ fired, now: 20, lastFiredAt: 0, mood: 'silence' })).toBeNull()
  })

  it('does not re-admit while a flourish is already active, even if triggers keep firing', () => {
    const active: ActiveFilter = { id: 'Bad TV', startedAt: 19, durationSec: 3.5 }
    const out = advance({ active, fired, now: 20, lastFiredAt: 0 })
    // Still mid-flourish (19 + 3.5 > 20), so the existing one is kept rather
    // than restarted or replaced.
    expect(out).toEqual(active)
  })
})

/**
 * The manual path: `store.pendingFilterId`, set by `requestFilter` and read
 * once by `FilterDirector`.
 *
 * Every case below deliberately leaves `fired` empty — no trigger edge — so
 * that anything which fires here can only have fired because a human asked
 * for it. The gates are then failed ONE AT A TIME (cooldown, budget, an
 * already-live flourish) so a regression that restores any single one of them
 * is caught by its own named test rather than hiding behind the others.
 */
describe('advanceFilter — manual picks', () => {
  const MANUAL = 'Bad TV'

  it('fires with no trigger edge at all — a click is its own trigger', () => {
    const out = advance({ manualId: MANUAL, fired: [], now: 20 })
    expect(out).toEqual({
      id: MANUAL,
      startedAt: 20,
      durationSec: FILTER_FLOURISH_DURATION_SEC,
    })
  })

  it('fires while the autonomous path is suppressed', () => {
    // The component expresses suppression (autoPilot off / not running /
    // f.silence / cueState.governed) by passing `fired: []`; `mood: 'silence'`
    // is the one form of suppression this pure function can see for itself,
    // and it would independently empty the pick pool. Both together, and it
    // still fires: the suppression gate paces the SHOW, it does not overrule
    // a person.
    const out = advance({ manualId: MANUAL, fired: [], mood: 'silence', now: 20 })
    expect(out!.id).toBe(MANUAL)
  })

  it('fires well inside the cooldown window', () => {
    // 1s after the last fire, against a 15s cooldown.
    const out = advance({ manualId: MANUAL, now: 1, lastFiredAt: 0 })
    expect(out!.id).toBe(MANUAL)
    expect(advance({ fired: ['drop'], now: 1, lastFiredAt: 0 })).toBeNull() // autonomous still gated
  })

  it('fires with zero budget headroom', () => {
    // The one bypass a reader should question — pinned here so it is a
    // deliberate, tested decision rather than a forgotten check. See the
    // reasoning block in advanceFilter: bounded, user-initiated, one-shot.
    const out = advance({ manualId: MANUAL, headroomMs: 0, now: 20 })
    expect(out!.id).toBe(MANUAL)
  })

  it('replaces a flourish that is still mid-flight', () => {
    const active: ActiveFilter = { id: 'Ripples', startedAt: 19, durationSec: 3.5 }
    const out = advance({ active, manualId: MANUAL, now: 20 })
    expect(out!.id).toBe(MANUAL)
    expect(out!.startedAt).toBe(20)
  })

  it('restarts with a fresh startedAt when the live filter is picked again', () => {
    // Clicking the chip for the filter already showing must still visibly
    // restart it, not read as a no-op.
    const active: ActiveFilter = { id: MANUAL, startedAt: 19, durationSec: 3.5 }
    const out = advance({ active, manualId: MANUAL, now: 20 })
    expect(out).not.toBe(active)
    expect(out).toEqual({ id: MANUAL, startedAt: 20, durationSec: FILTER_FLOURISH_DURATION_SEC })
  })

  it('refuses an unknown id without starting anything', () => {
    expect(advance({ manualId: 'Not A Filter', now: 20 })).toBeNull()
    expect(advance({ manualId: '', now: 20 })).toBeNull()
  })

  it('refuses an unknown id without cutting a live flourish', () => {
    // A bad request is a no-op, never a cut: the running flourish is left to
    // finish on its own clock.
    const active: ActiveFilter = { id: 'Ripples', startedAt: 19, durationSec: 3.5 }
    expect(advance({ active, manualId: 'Not A Filter', now: 20 })).toEqual(active)
  })

  it('fires a DISABLED_FILTERS id that pickFilter would never select', () => {
    // DISABLED_FILTERS governs autonomous rotation, not what a human may ask
    // for — same posture as the HUD's disabled-but-clickable transition chips.
    const disabled = 'Color Invert'
    expect(DISABLED_FILTERS).toContain(disabled)
    expect(ISF_FILTERS.some((f) => f.id === disabled)).toBe(true)
    for (let r = 0; r < 12; r++) expect(pickFilter('aggressive', null, r)).not.toBe(disabled)

    const out = advance({ manualId: disabled, now: 20 })
    expect(out!.id).toBe(disabled)
  })

  it('every roster id can be fired by hand EXCEPT one that is unusable', () => {
    for (const f of ISF_FILTERS) {
      const out = advance({ manualId: f.id, now: 20 })
      if (filterUnusableReason(f.id)) {
        // The one gate a person does not outrank. Everything else the manual
        // path bypasses is pacing; this is a filter that is broken on this
        // platform, so honouring the request would just run the bug on demand.
        expect(out, f.id).toBeNull()
      } else {
        expect(out!.id).toBe(f.id)
      }
    }
  })

  it('refuses an unusable filter even though it IS in the roster', () => {
    // Distinct from the unknown-id case below: this id is real, is credited,
    // and is in `ISF_FILTERS` — it is refused on the reason, not on lookup.
    const broken = 'Broken LCD'
    expect(ISF_FILTERS.some((f) => f.id === broken)).toBe(true)
    expect(filterUnusableReason(broken)).toBeTruthy()
    expect(advance({ manualId: broken, now: 20 })).toBeNull()
  })

  it('does not cut a live flourish when an unusable filter is requested', () => {
    // Same posture as the unknown-id case: a refused request is a no-op, never
    // a cut. Clicking a dead chip must not kill what is already on screen.
    const active: ActiveFilter = { id: 'Bad TV', startedAt: 19, durationSec: 3.5 }
    expect(advance({ active, manualId: 'Broken LCD', now: 20 })).toEqual(active)
  })

  it('leaves the autonomous path exactly as it was when no id is pending', () => {
    // null and undefined both mean "nobody asked" — the component passes the
    // store field straight through, which is `string | null`.
    expect(advance({ manualId: null, fired: [], now: 20 })).toBeNull()
    expect(advance({ manualId: null, fired: ['drop'], now: 20, lastFiredAt: 0 })!.id).toBe(
      pickFilter('groove', null, 0),
    )
    expect(advance({ manualId: undefined, fired: ['drop'], now: 20, lastFiredAt: 0 })!.id).toBe(
      pickFilter('groove', null, 0),
    )
  })
})

/**
 * The store half of the seam. Deliberately not a component test: the contract
 * the UI codes against is just these three fields, and `FilterDirector`'s own
 * consumption is covered by the pure-function suite above.
 */
describe('store — the manual filter request channel', () => {
  it('starts empty, and round-trips a request', () => {
    useStore.getState().clearFilterRequest()
    expect(useStore.getState().pendingFilterId).toBeNull()

    useStore.getState().requestFilter('Bad TV')
    expect(useStore.getState().pendingFilterId).toBe('Bad TV')

    useStore.getState().clearFilterRequest()
    expect(useStore.getState().pendingFilterId).toBeNull()
  })

  it('lets a newer request replace one that has not been consumed yet', () => {
    // Two clicks inside a single frame: the second wins rather than being
    // dropped or queued behind the first.
    useStore.getState().requestFilter('Bad TV')
    useStore.getState().requestFilter('Ripples')
    expect(useStore.getState().pendingFilterId).toBe('Ripples')
    useStore.getState().clearFilterRequest()
  })

  it('accepts an id the director will refuse — validation lives in one place', () => {
    // The store is a plain hand-off; the roster lookup is the director's job,
    // and duplicating it here would give a bad id two places to be rejected.
    useStore.getState().requestFilter('Not A Filter')
    expect(useStore.getState().pendingFilterId).toBe('Not A Filter')
    useStore.getState().clearFilterRequest()
  })

  it('is not persisted — a one-shot request must not survive a reload', () => {
    // Source check rather than a storage round-trip, matching how
    // credits.test.ts pins HUD wiring: `partialize` is a literal list, and
    // absence from it is the whole assertion.
    const partialize = STORE_SRC.slice(STORE_SRC.indexOf('partialize:'))
    expect(partialize.length).toBeGreaterThan(0)
    expect(partialize).not.toContain('pendingFilterId')
    // The precedent being matched: `pendingSceneId` is transient too.
    expect(partialize).not.toContain('pendingSceneId')
  })
})
