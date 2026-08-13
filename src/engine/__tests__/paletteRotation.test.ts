import { describe, expect, it } from 'vitest'
import { pickPalette } from '../AutoPilot'

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
