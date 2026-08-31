import { describe, expect, it } from 'vitest'
import { PALETTE_VA, pickPalette } from '../AutoPilot'

/**
 * The bug this guards: palette used to change only when the current one was
 * absent from the new mood's list, and the lists overlap heavily. `aurora`
 * sits in ambient, mellow, groove AND building, so an entire arc through those
 * four moods produced zero colour changes.
 */
const GROOVE = ['aurora', 'violet', 'solar']
const AMBIENT = ['ocean', 'aurora', 'mono']

describe('pickPalette', () => {
  it('never returns the palette already showing', () => {
    for (const current of GROOVE) {
      for (let r = 0; r < 6; r++) {
        expect(pickPalette(GROOVE, current, '', '', r)).not.toBe(current)
      }
    }
  })

  it('changes colour even when the current palette is valid for the mood', () => {
    // The exact stuck case: aurora is legal in both moods, so the old
    // `!includes(current)` guard declined to move.
    expect(pickPalette(AMBIENT, 'aurora', '', '', 0)).not.toBe('aurora')
    expect(pickPalette(GROOVE, 'aurora', '', '', 0)).not.toBe('aurora')
  })

  it('prefers the key family when it is available and not just used', () => {
    expect(pickPalette(GROOVE, 'aurora', 'violet', '', 0)).toBe('violet')
  })

  it('refuses the key family twice running, so colour keeps moving', () => {
    const pick = pickPalette(GROOVE, 'aurora', 'violet', 'violet', 0)
    expect(pick).not.toBe('violet')
    expect(pick).not.toBe('aurora')
  })

  it('ignores a key family the mood does not sanction', () => {
    // Mood owns the family list; key only chooses inside it. A bright key must
    // not be able to drag a breakdown into ember.
    expect(pickPalette(AMBIENT, 'ocean', 'ember', '', 0)).not.toBe('ember')
  })

  it('cycles deterministically so a recorded set repeats', () => {
    const a = [0, 1, 2, 3].map((r) => pickPalette(GROOVE, 'aurora', '', '', r))
    const b = [0, 1, 2, 3].map((r) => pickPalette(GROOVE, 'aurora', '', '', r))
    expect(a).toEqual(b)
  })

  it('visits every alternative rather than flip-flopping between two', () => {
    const seen = new Set<string>()
    for (let r = 0; r < 8; r++) {
      const p = pickPalette(GROOVE, 'aurora', '', '', r)
      if (p) seen.add(p)
    }
    expect(seen).toEqual(new Set(['violet', 'solar']))
  })

  it('returns null when there is nowhere to go', () => {
    expect(pickPalette([], 'aurora', '', '', 0)).toBeNull()
    expect(pickPalette(['aurora'], 'aurora', '', '', 0)).toBeNull()
  })

  it('drops palette ids that are not registered', () => {
    expect(pickPalette(['nope', 'alsonope'], 'aurora', '', '', 0)).toBeNull()
  })
})

describe('pickPalette — VA-weighted rotation (audit c8)', () => {
  it('is unaffected when currentVA is omitted — every existing call above', () => {
    for (let r = 0; r < 8; r++) {
      expect(pickPalette(GROOVE, 'aurora', '', '', r)).toBe(
        pickPalette(GROOVE, 'aurora', '', '', r, undefined),
      )
    }
  })

  it('solar (building/peak pools) reads more aroused than violet (mellow/groove)', () => {
    // Sanity check on the test premise, not on pickPalette: confirms the
    // derived positions actually differ before trusting the frequency tests
    // below to mean anything.
    expect(PALETTE_VA.solar.arousal).toBeGreaterThan(PALETTE_VA.violet.arousal)
  })

  it('is still deterministic — same inputs always give the same answer', () => {
    const a = [0, 1, 2, 3, 4].map((r) => pickPalette(GROOVE, 'aurora', '', '', r, PALETTE_VA.solar))
    const b = [0, 1, 2, 3, 4].map((r) => pickPalette(GROOVE, 'aurora', '', '', r, PALETTE_VA.solar))
    expect(a).toEqual(b)
  })

  it('picks the VA-closer alternative more often across a long rotation', () => {
    // Reading near solar's own position should surface solar more often than
    // violet across many rotation indices, versus reading near violet's own
    // position doing the reverse.
    const countOf = (target: string, currentVA: (typeof PALETTE_VA)['solar']) => {
      let n = 0
      for (let r = 0; r < 400; r++) {
        if (pickPalette(GROOVE, 'aurora', '', '', r, currentVA) === target) n++
      }
      return n
    }
    const solarNearSolar = countOf('solar', PALETTE_VA.solar)
    const solarNearViolet = countOf('solar', PALETTE_VA.violet)
    expect(solarNearSolar).toBeGreaterThan(solarNearViolet)
  })

  it('never fully excludes the farther alternative from the rotation', () => {
    const seen = new Set<string>()
    for (let r = 0; r < 200; r++) {
      const p = pickPalette(GROOVE, 'aurora', '', '', r, PALETTE_VA.solar)
      if (p) seen.add(p)
    }
    // Both non-current, non-excluded alternatives must still appear.
    expect(seen).toEqual(new Set(['violet', 'solar']))
  })

  it('the key family still wins outright, ahead of any VA weighting', () => {
    // Same case as the plain-rotation test above, now with a VA read that
    // would otherwise favour solar — key family must still take it.
    expect(pickPalette(GROOVE, 'aurora', 'violet', '', 0, PALETTE_VA.solar)).toBe('violet')
  })

  it('a palette with no derived VA (never pooled) is not excluded, just untethered', () => {
    // Defensive: PALETTE_VA is derived from MOOD_PALETTES, so every real
    // palette id has an entry, but the lookup falls back to the origin for
    // a foreign id rather than throwing.
    const pool = ['aurora', 'made-up-id']
    expect(() => pickPalette(pool, 'violet', '', '', 0, PALETTE_VA.solar)).not.toThrow()
  })
})

describe('PALETTE_VA', () => {
  it('places every real palette referenced by MOOD_PALETTES', () => {
    expect(PALETTE_VA.aurora).toBeDefined()
    expect(PALETTE_VA.solar).toBeDefined()
    expect(PALETTE_VA.violet).toBeDefined()
  })

  it('gives aurora a lower arousal than the peak-only palettes, reflecting its calmer pools', () => {
    // aurora sits in ambient/mellow/groove/building (per AutoPilot.tsx's own
    // comment); solar sits in building/peak, a hotter pair.
    expect(PALETTE_VA.aurora.arousal).toBeLessThan(PALETTE_VA.solar.arousal)
  })
})
