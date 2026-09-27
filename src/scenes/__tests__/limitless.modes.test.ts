import { describe, expect, it } from 'vitest'
import { getSceneContract } from '../index'
import { FRAG, LIMITLESS_MODES } from '../LimitlessScene'

/**
 * `LIMITLESS_MODES`'s array index IS the shader's `uMode` branch number (see
 * `LimitlessScene.tsx`'s own header, "Mode renumbering"). Getting that
 * correspondence wrong is silent — a user picks "shatter" from the picker and
 * sees "prism" render, with no compile error and no test in the rest of the
 * suite that would catch it, since nothing else here parses the shader
 * source. This file parses `FRAG` directly rather than trusting the mapping
 * by eye, so a future edit to either side that breaks the correspondence
 * fails here instead of shipping silently.
 */

/**
 * Every real `if (uMode == N)` / `else if (uMode == N)` branch test the
 * shader source contains, in source order.
 *
 * Anchored on `\bif \(` rather than a bare `uMode == (\d+)`, deliberately —
 * the file mentions `uMode == N` in several PROSE contexts that are not
 * branch tests at all: the header's own doc comment, the `vhs (uMode == 14)`
 * label on the branch's *comment* (the code there is a bare `else`, not an
 * `if`), and the trailing `liveF = uMode == 0 ? ... : ...` ternary. A bare
 * pattern collects all of those as false branch matches; anchoring on the
 * `if (` that only real dispatch code has does not.
 */
function branchNumbersInSource(frag: string): number[] {
  return [...frag.matchAll(/\bif \(uMode == (\d+)\)/g)].map((m) => Number(m[1]))
}

describe('LIMITLESS_MODES <-> shader branch correspondence', () => {
  it('has one entry per mode, no duplicates', () => {
    expect(LIMITLESS_MODES.length).toBeGreaterThan(0)
    expect(new Set(LIMITLESS_MODES).size).toBe(LIMITLESS_MODES.length)
  })

  it('the shader tests every index except the last, which the final else covers', () => {
    const explicit = branchNumbersInSource(FRAG)
    // 0..length-2 must each appear exactly once as an explicit `uMode == N` —
    // the last index (length-1) is deliberately the bare `else`, matching
    // lilim's own structure (see the shader's own comment on the final mode).
    const expected = LIMITLESS_MODES.map((_, i) => i).slice(0, -1)
    expect(explicit.sort((a, b) => a - b)).toEqual(expected)
  })

  it('the explicit branches appear in source in the SAME order as LIMITLESS_MODES', () => {
    // Catches a transposition (branch 3 and 4 swapped) that a sorted-set
    // comparison alone would miss.
    const explicit = branchNumbersInSource(FRAG)
    expect(explicit).toEqual(LIMITLESS_MODES.map((_, i) => i).slice(0, -1))
  })

  it('every mode name in the array has a same-name comment at its own branch', () => {
    // Belt-and-suspenders against a renumbering that moved the CODE but not
    // the comment above it (which would pass the two structural checks above
    // while still describing the wrong mode to the next reader). Checks that
    // mode i's name appears somewhere between its own branch's start and the
    // next one's (or, for the last mode, the bare `else` that covers it).
    const src = FRAG
    // Real branch starts only, via the same anchored pattern as
    // branchNumbersInSource — an unanchored search re-introduces the exact
    // false-positive-on-comments bug that pattern exists to avoid (a match
    // is `if (uMode == 0)` for the first branch, `else if (uMode == N)` for
    // every one after, thanks to `\bif \(` matching wherever "if (" appears,
    // including right after "else ").
    const starts = [...src.matchAll(/\bif \(uMode == \d+\)/g)].map((m) => m.index)
    expect(starts.length, 'one fewer than LIMITLESS_MODES.length (last is the bare else)').toBe(
      LIMITLESS_MODES.length - 1,
    )
    // The bare `else {` closing the chain — matched on `} else {\n` (not
    // `else if`) so it can't collide with any of the branches above it.
    const finalElseAt = src.indexOf('} else {', starts[starts.length - 1])
    expect(finalElseAt, 'the bare else covering the last mode').toBeGreaterThanOrEqual(0)
    const boundaries = [...starts, finalElseAt, src.length]

    for (let i = 0; i < LIMITLESS_MODES.length; i++) {
      const name = LIMITLESS_MODES[i]
      const body = src.slice(boundaries[i], boundaries[i + 1])
      // A loose but sufficient check: the comment naming this mode sits
      // somewhere in its own branch body, e.g. "// smear:" or "// vhs (uMode".
      expect(body.toLowerCase(), `${name}'s branch body should mention "${name}"`).toContain(
        name.toLowerCase(),
      )
    }
  })

  it("matches the roster's own literal `modes` array in index.ts", () => {
    // `index.ts` cannot import LIMITLESS_MODES directly — every scene there is
    // a dynamic import() for code-splitting, and a static import of a lazy
    // chunk's export would pull the whole scene into the eagerly-loaded
    // roster bundle (see that file's own comment on its `modes:` literal).
    // The duplication that forces is exactly what this assertion exists to
    // keep honest: a future edit to one list with no matching edit to the
    // other fails here instead of shipping a mode picker whose Nth entry
    // renders the (N-1)th mode.
    const registered = getSceneContract('limitless')?.modes
    expect(registered).toEqual([...LIMITLESS_MODES])
  })

  it("declares 'none' first, so a fresh photo drop opens undistorted", () => {
    expect(LIMITLESS_MODES[0]).toBe('none')
  })

  it('includes melt and mosh, now that spec.sim exists (F212)', () => {
    expect(LIMITLESS_MODES as readonly string[]).toContain('melt')
    expect(LIMITLESS_MODES as readonly string[]).toContain('mosh')
  })

  it('still excludes every mode that needs an engine primitive melt/mosh did not build (F212)', () => {
    // coral/scanline/windows could reuse spec.sim's own ping-pong plumbing at
    // much lower cost now that it exists — still not ported, see the
    // header's own note on why. terrain is a separate 3D scene graph, not a
    // sim-shaped gap at all.
    const excluded = ['coral', 'scanline', 'windows', 'terrain']
    for (const mode of excluded) {
      expect(LIMITLESS_MODES as readonly string[]).not.toContain(mode)
    }
  })
})

describe('FRAG uniform completeness', () => {
  /** Every `uniform <type> name[, name...];` this shader body declares. */
  function declaredUniforms(frag: string): string[] {
    const names: string[] = []
    for (const m of frag.matchAll(/uniform\s+\w+\s+([^;]+);/g)) {
      for (const n of m[1].split(',')) names.push(n.trim())
    }
    return names
  }

  /** The prelude's own uniforms (`createShaderScene.tsx`'s
   *  SHADER_SCENE_PRELUDE) — a scene must never redeclare one of these. */
  const PRELUDE_UNIFORMS = [
    'uRes',
    'uAspect',
    'uFade',
    'uTime',
    'uMode',
    'uBg',
    'uShadow',
    'uMid',
    'uAccent',
    'uGlow',
    'uKick',
    'uSnare',
    'uHihat',
    'uBassClock',
    'uMidClock',
    'uHighClock',
    'uBeatSin',
    'uBeatSin2',
    'uBeatSin4',
    'uNoiseLUT',
  ]

  it('declares no uniform the prelude already declares', () => {
    const declared = declaredUniforms(FRAG)
    const collisions = declared.filter((n) => PRELUDE_UNIFORMS.includes(n))
    expect(collisions).toEqual([])
  })

  it('reads uFade exactly once, on the final output — the one prelude uniform every scene must honour', () => {
    const reads = [...FRAG.matchAll(/\buFade\b/g)].length
    expect(reads).toBe(1)
    expect(FRAG).toMatch(/gl_FragColor\s*=.*uFade/)
  })
})
