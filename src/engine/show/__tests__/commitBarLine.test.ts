import { describe, expect, it } from 'vitest'
import SCENE_MANAGER_SRC from '../../SceneManager.tsx?raw'
import { isCommitBarLine, type AnchoredBarGrid } from '../commitBarLine'

/**
 * Where SceneManager commits a pending scene. With `?events=v2` it must be the SAME bar line the adapter requests against
 * (the boundary-anchored grid) while that grid is confident; with `?events=legacy`, or a grid that is not confident, it is
 * exactly today's `f.beat && f.beatInBar === 0`.
 */

/** A grid whose bar lines are the beats with `beat % 4 === phase` (confident), or one that is not confident (-1). */
function grid(phase: number | null): AnchoredBarGrid {
  return { beatsToBarLine: (beat) => (phase === null ? -1 : (((phase - Math.round(beat)) % 4) + 4) % 4) }
}

const frame = (beatIndex: number, over: { beat?: boolean; beatInBar?: number } = {}) => ({
  beat: over.beat ?? true,
  beatInBar: over.beatInBar ?? beatIndex % 4,
  beatIndex,
})

describe('isCommitBarLine', () => {
  it('legacy mode (no grid): exactly f.beat && f.beatInBar === 0, for every combination', () => {
    for (const beat of [false, true]) {
      for (let bib = 0; bib < 4; bib++) {
        for (const idx of [0, 1, 2, 3, 40, 41]) {
          const f = { beat, beatInBar: bib, beatIndex: idx }
          expect(isCommitBarLine(f, null)).toBe(beat && bib === 0)
        }
      }
    }
  })

  it('a confident grid replaces the arbitrary phase: the anchored downbeat commits, f.beatInBar === 0 does not', () => {
    const g = grid(2) // bar lines on beats 2, 6, 10, ...
    expect(isCommitBarLine(frame(6, { beatInBar: 2 }), g)).toBe(true)
    expect(isCommitBarLine(frame(8, { beatInBar: 0 }), g)).toBe(false) // the arbitrary-phase downbeat is not a bar line here
    expect(isCommitBarLine(frame(7), g)).toBe(false)
  })

  it('a request made on the last beat of an anchored bar lands on its downbeat (the adapter asks when toLine === 1)', () => {
    const g = grid(2)
    // beat 5 is the last beat of the anchored bar (beatsToBarLine === 1): not a commit line itself, the next beat is
    expect(g.beatsToBarLine(5)).toBe(1)
    expect(isCommitBarLine(frame(5), g)).toBe(false)
    expect(g.beatsToBarLine(6)).toBe(0)
    expect(isCommitBarLine(frame(6), g)).toBe(true)
  })

  it('a grid that is not confident (-1) falls back to f.beatInBar === 0, bit for bit', () => {
    const g = grid(null)
    for (const beat of [false, true]) {
      for (let bib = 0; bib < 4; bib++) {
        const f = { beat, beatInBar: bib, beatIndex: 17 + bib }
        expect(isCommitBarLine(f, g)).toBe(isCommitBarLine(f, null))
      }
    }
  })

  it('only beat frames can be commit lines, whatever the grid says', () => {
    expect(isCommitBarLine(frame(6, { beat: false, beatInBar: 0 }), grid(2))).toBe(false)
    expect(isCommitBarLine(frame(8, { beat: false, beatInBar: 0 }), null)).toBe(false)
  })

  it('reads the grid at the frame\'s beat index (and only on a beat frame)', () => {
    const asked: number[] = []
    const spy: AnchoredBarGrid = { beatsToBarLine: (b) => (asked.push(b), 0) }
    isCommitBarLine(frame(12, { beat: false }), spy)
    expect(asked).toEqual([])
    expect(isCommitBarLine(frame(12), spy)).toBe(true)
    expect(asked).toEqual([12])
  })
})

describe('SceneManager uses it (source pin: the file has no harness for its useFrame)', () => {
  const src = (SCENE_MANAGER_SRC as string).replace(/\r\n/g, '\n')

  it('onDownbeat comes from isCommitBarLine, with the v2 layer as the grid only under EVENTS_V2', () => {
    expect(src).toContain("import { isCommitBarLine } from './show/commitBarLine'")
    expect(src).toContain("import { EVENTS_V2 } from './show/directorFlags'")
    expect(src).toContain('const onDownbeat = isCommitBarLine(f, EVENTS_V2 ? audioEngine.events : null)')
    // the old inline test is gone, and there is exactly one definition of onDownbeat
    expect(src).not.toContain('const onDownbeat = f.beat && f.beatInBar === 0')
    expect(src.match(/const onDownbeat =/g)?.length).toBe(1)
  })

  it('the rest of the commit path is untouched: resolveCommit still takes onDownbeat, the drop and the backstop', () => {
    expect(src).toContain('commit: !gridTrusted || (onDownbeat && warmEnough) || immediate || waited > 2.5')
    expect(src).toContain('const gridTrusted = f.confidence > 0.25 && !f.silence')
  })
})
