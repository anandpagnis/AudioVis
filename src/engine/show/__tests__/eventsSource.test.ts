import { describe, expect, it } from 'vitest'
import { maskLegacyInputForV2, mergeLiveWithLegacy } from '../../../audio/events/eventMux'
import { createLegacyEventState, stepLegacyEvents, type LegacyInput } from '../../../audio/events/legacyEvents'
import type { SectionEvent } from '../../../audio/events/types'
import LOOKDEBUG_SRC from '../../look/lookDebug.ts?raw'
import STRUCTURELOG_SRC from '../../structureLog.ts?raw'
import ADAPTER_SRC from '../showAdapter.tsx?raw'
import { EVENTS_V2, eventsSource } from '../directorFlags'
import { formatShowLine } from '../../look/lookDebug'
import { showProbe } from '../showRuntime'

/**
 * `?events=v2|legacy`: which source feeds the show director. The adapter's `useFrame` has no node harness, so (as for
 * `?director=legacy`, `showLegacyGuard.test.ts`) the parts that make `legacy` exactly today's Phase-1 behaviour are
 * pinned at the source level, and every pure piece (the flag, the input mask, the merge) is tested by behaviour.
 */
const adapter = (ADAPTER_SRC as string).replace(/\r\n/g, '\n')

describe('?events flag', () => {
  it('is legacy by default and for anything that is not an explicit v2 value', () => {
    expect(eventsSource('')).toBe('legacy')
    expect(eventsSource('?')).toBe('legacy')
    expect(eventsSource('?events')).toBe('legacy')
    expect(eventsSource('?events=legacy')).toBe('legacy')
    expect(eventsSource('?events=LEGACY')).toBe('legacy')
    expect(eventsSource('?events=v3')).toBe('legacy')
    expect(eventsSource('?events=off')).toBe('legacy')
    expect(eventsSource('?event=v2')).toBe('legacy')
    expect(eventsSource('?events=v2x')).toBe('legacy')
  })

  it('is v2 for ?events=v2 (and its synonyms), among other parameters', () => {
    expect(eventsSource('?events=v2')).toBe('v2')
    expect(eventsSource('?events=V2')).toBe('v2')
    expect(eventsSource('?lookdebug&events=v2&director=legacy')).toBe('v2')
    expect(eventsSource('events=v2')).toBe('v2')
    for (const on of ['on', '1', 'true', 'yes', 'live']) expect(eventsSource(`?events=${on}`)).toBe('v2')
  })

  it('with no location (node, workers) it answers legacy, so nothing changes by default', () => {
    expect(eventsSource()).toBe('legacy')
    expect(EVENTS_V2).toBe(false)
  })
})

function legacyIn(over: Partial<LegacyInput> = {}): LegacyInput {
  return {
    time: 10,
    beat: 20,
    bpm: 120,
    sectionChange: false,
    sectionChangeStrength: 0,
    drop: false,
    buildUp: false,
    structureValid: false,
    boundaryChanged: false,
    section: '',
    previousSection: '',
    sectionConfidence: 0,
    beatsInSection: 0,
    isSustain: false,
    ...over,
  }
}

function live(over: Partial<SectionEvent> = {}): SectionEvent {
  return {
    id: 1,
    type: 'change',
    strength: 0.8,
    confidence: 0.9,
    boundaryBeat: 16,
    boundaryTime: 8,
    detectedAtBeat: 22,
    detectedAtTime: 11,
    source: 'live',
    phase: 0,
    feats: { level: 0, low: 0, timbre: 5, harmony: 0, rhythm: 0 },
    ...over,
  }
}

describe('eventMux: v2 keeps the legacy drop / buildStart events and replaces the rest', () => {
  it('a legacy sectionChange is a `change` event in legacy mode and is gone (masked) in v2 mode', () => {
    const sc = legacyIn({ sectionChange: true, sectionChangeStrength: 1.0 })
    const legacyOut: SectionEvent[] = []
    stepLegacyEvents(createLegacyEventState(), { ...sc }, legacyOut)
    expect(legacyOut.some((e) => e.type === 'change')).toBe(true) // ?events=legacy: today's behaviour

    const li = { ...sc }
    maskLegacyInputForV2(li)
    expect(li.sectionChange).toBe(false)
    const v2Out: SectionEvent[] = []
    stepLegacyEvents(createLegacyEventState(), li, v2Out)
    mergeLiveWithLegacy(v2Out, [])
    expect(v2Out).toEqual([])
  })

  it('analyser boundaries: a plain-section / breakdown boundary is dropped, a drop or build boundary is kept', () => {
    for (const [section, expected] of [
      ['section', false],
      ['breakdown', false],
      ['intro', false],
      ['drop', true],
      ['build', true],
    ] as const) {
      const li = legacyIn({ structureValid: true, boundaryChanged: true, section, previousSection: 'section', sectionConfidence: 0.9, beatsInSection: 1 })
      maskLegacyInputForV2(li)
      expect(li.boundaryChanged).toBe(expected)
      const out: SectionEvent[] = []
      stepLegacyEvents(createLegacyEventState(), li, out)
      mergeLiveWithLegacy(out, [])
      expect(out.length > 0).toBe(expected)
      if (expected) expect(out[0].type).toBe(section === 'drop' ? 'drop' : 'buildStart')
    }
  })

  it('a drop edge and a build start still come through in v2 mode, and the live events are appended after them', () => {
    const li = legacyIn({ drop: true, sectionChange: true, sectionChangeStrength: 1.2 })
    maskLegacyInputForV2(li)
    const state = createLegacyEventState()
    const out: SectionEvent[] = []
    stepLegacyEvents(state, li, out)
    // a later frame: a confirmed build starts
    const li2 = legacyIn({ beat: 60, time: 40, isSustain: true, structureValid: true })
    maskLegacyInputForV2(li2)
    stepLegacyEvents(state, li2, out)
    expect(out.map((e) => e.type)).toEqual(['drop', 'buildStart'])
    const l1 = live({ id: 7, type: 'change' })
    const l2 = live({ id: 8, type: 'fill' })
    const n = mergeLiveWithLegacy(out, [l1, l2])
    expect(n).toBe(out.length)
    expect(out[0].type).toBe('drop')
    expect(out[0].source).toBe('legacy')
    expect(out.slice(-2)).toEqual([l1, l2])
    // the merged drop was NOT corroborated by the (masked) sectionChange
    expect(out[0].corroborated).toBeFalsy()
  })

  it('a legacy change / breakdown in the list is filtered out and the array is rewritten in place', () => {
    const arr: SectionEvent[] = [live({ id: 1, type: 'change', source: 'legacy' }), live({ id: 2, type: 'drop', source: 'legacy' }), live({ id: 3, type: 'breakdown', source: 'legacy' }), live({ id: 4, type: 'buildStart', source: 'legacy' })]
    const same = arr
    mergeLiveWithLegacy(arr, [live({ id: 9 })])
    expect(arr).toBe(same)
    expect(arr.map((e) => e.id)).toEqual([2, 4, 9])
  })
})

describe('showAdapter: ?events=legacy keeps the Phase-1 event source; v2 is an overlay guarded by EVENTS_V2', () => {
  it('reads the flag once at module load and imports the pure mux', () => {
    expect(adapter).toContain("import { DIRECTOR_ON, EVENTS_V2 } from './directorFlags'")
    expect(adapter).toContain("import { maskLegacyInputForV2, mergeLiveWithLegacy } from '../../audio/events/eventMux'")
  })

  it('the legacy mapping input is assigned UNCONDITIONALLY from the features; v2 only masks it afterwards', () => {
    expect(adapter).toContain('li.sectionChange = f.sectionChange')
    expect(adapter).toContain('li.boundaryChanged = f.songSection.boundaryChanged')
    expect(adapter).toContain('if (EVENTS_V2) maskLegacyInputForV2(li)')
    expect(adapter).toContain('if (EVENTS_V2) mergeLiveWithLegacy(ctx.events, ctx.live)')
    // exactly one call site of each: nothing else touches the mapping's input or output
    expect(adapter.match(/maskLegacyInputForV2\(/g)?.length).toBe(1)
    expect(adapter.match(/mergeLiveWithLegacy\(/g)?.length).toBe(1)
    const step = adapter.indexOf('stepLegacyEvents(ctx.legacy, li, ctx.events)')
    expect(step).toBeGreaterThan(adapter.indexOf('if (EVENTS_V2) maskLegacyInputForV2(li)'))
    expect(adapter.indexOf('if (EVENTS_V2) mergeLiveWithLegacy(ctx.events, ctx.live)')).toBeGreaterThan(step)
  })

  it('the bar line is f.beatInBar === 3 unless v2 is on AND the anchored grid is confident', () => {
    expect(adapter).toContain('let barLine = f.beat && f.beatInBar === 3')
    expect(adapter).toContain('if (EVENTS_V2 && f.beat) {')
    expect(adapter).toContain('const toLine = audioEngine.events.beatsToBarLine(f.beatIndex)')
    expect(adapter).toContain('if (toLine >= 0) barLine = toLine === 1')
    expect(adapter).toContain('inp.barLine = barLine')
  })

  it('the event ring is drained EVERY frame before the director bail-out; in legacy mode v2 events are only logged as shadow', () => {
    const drain = adapter.indexOf('audioEngine.events.drain(ctx.live)')
    const bail = adapter.indexOf('if (!DIRECTOR_ON) return')
    expect(drain).toBeGreaterThan(0)
    expect(bail).toBeGreaterThan(drain)
    expect(adapter).toContain('const feedV2 = EVENTS_V2 && DIRECTOR_ON')
    expect(adapter).toContain('if (!feedV2) structureLog.noteSectionEvent(e, { shadow: true })')
    // a live event that reached the director is logged with its decision
    expect(adapter).toContain("inp.event.source === 'live'")
    expect(adapter).toContain('structureLog.noteSectionEvent(inp.event, { S: a.S, T: a.T, decision:')
  })

  it('reports the source on the ?lookdebug show line', () => {
    expect(adapter).toContain("showProbe.src = EVENTS_V2 ? 'v2' : 'legacy'")
    expect(showProbe.src).toBe('legacy')
    const base = {
      on: true,
      kind: 'HOLD',
      reason: 'weak',
      micro: '',
      S: 0.2,
      T: 0.5,
      age: 3,
      pressure: 0,
      etaBars: 20,
      hold: 1,
      microCount: 0,
      cut: 0,
      forced: 0,
      cutHow: '-',
    }
    // absent: the line is exactly the Phase-1 one
    expect(formatShowLine(base)).toMatch(/C0\(f0\)$/)
    expect(formatShowLine({ ...base, src: 'v2' })).toMatch(/C0\(f0\) {2}ev=v2$/)
    expect(formatShowLine({ ...base, src: 'v2', lastEvent: 'change 0.82' })).toMatch(/ev=v2 \[change 0\.82\]$/)
    expect(formatShowLine({ ...base, src: 'legacy', lastEvent: '-' })).toMatch(/ev=legacy$/)
    expect(LOOKDEBUG_SRC).toContain('ev=${show.src}')
  })

  it('the structure log gained one ADDITIVE event kind for the events it is fed', () => {
    expect(STRUCTURELOG_SRC).toContain("'sectionEvent',")
    expect(STRUCTURELOG_SRC).toContain('noteSectionEvent(')
  })
})
