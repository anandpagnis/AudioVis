import { describe, expect, it } from 'vitest'
import { IsfImportError, parseISF, splitIsfHeader } from '../parseISF'
import CHECKERBOARD_FS from './fixtures/Checkerboard.fs?raw'

/**
 * Tested against the REAL `Checkerboard.fs`, plus hand-built headers for the
 * refusals.
 *
 * The fixture is vendored verbatim at `./fixtures/Checkerboard.fs` from
 * https://github.com/Vidvox/ISF-Files (`ISF/Checkerboard.fs`, MIT), with that
 * repository's `LICENSE` alongside it at `./fixtures/LICENSE`. Neither file is
 * edited — the point of a fixture from upstream is that it is what upstream
 * actually ships.
 *
 * The split is worth a real file and the refusals are not, and the reason is
 * asymmetric. A synthetic ISF header is one I would write to match the parser I
 * just wrote, so it proves nothing about whether the parser matches the FORMAT
 * — and the format has things a plausible synthetic file does not: tab-indented
 * JSON arrays, `MAX` written before `DEFAULT`, inputs with no `MIN`/`MAX` at
 * all. The refusals, by contrast, are about one key being present, and a
 * fifteen-line file makes that visible where a real 200-line shader buries it.
 *
 * The fixture is vendored rather than fetched. A test that reaches the network
 * fails on a plane, fails in CI behind a proxy, and silently changes meaning
 * the day upstream edits the file.
 */

/** The smallest thing that parses, so a refusal test can add exactly one key. */
function isf(header: Record<string, unknown>, body = 'void main() { gl_FragColor = vec4(1.0); }') {
  return `/*${JSON.stringify(header, null, 2)}*/\n${body}\n`
}

describe('splitIsfHeader', () => {
  it('splits the JSON comment from the GLSL body', () => {
    const { json, glsl } = splitIsfHeader(CHECKERBOARD_FS)
    expect(JSON.parse(json).CREDIT).toBe('by VIDVOX')
    expect(glsl).toContain('void main()')
    // The body must not carry any of the header back with it — a stray `CREDIT`
    // in the GLSL would be a compile error, and a stray `*/` a worse one.
    expect(glsl).not.toContain('CATEGORIES')
    expect(glsl).not.toContain('*/')
  })

  it('preserves line numbers, so a GLSL compile error still points at the file', () => {
    const { glsl } = splitIsfHeader(CHECKERBOARD_FS)
    const sourceLine = CHECKERBOARD_FS.split('\n').findIndex((l) => l.includes('void main()'))
    const bodyLine = glsl.split('\n').findIndex((l) => l.includes('void main()'))
    expect(bodyLine).toBe(sourceLine)
  })

  it('tolerates a leading line comment above the header', () => {
    const { json } = splitIsfHeader(`// vendored from upstream\n${isf({ ISFVSN: '2' })}`)
    expect(JSON.parse(json).ISFVSN).toBe('2')
  })

  it('refuses a file with no header at all', () => {
    expect(() => splitIsfHeader('void main() {}', { origin: 'plain.frag' })).toThrow(
      /no ISF header found/,
    )
  })

  it('refuses an unterminated header comment', () => {
    expect(() => splitIsfHeader('/* { "ISFVSN": "2" }\nvoid main() {}')).toThrow(/never closed/)
  })
})

describe('parseISF on the real Checkerboard.fs', () => {
  const parsed = parseISF(CHECKERBOARD_FS, { origin: 'Checkerboard.fs' })

  it('reads the metadata keys', () => {
    expect(parsed.header.isfvsn).toBe('2')
    expect(parsed.header.credit).toBe('by VIDVOX')
    expect(parsed.header.categories).toEqual(['Pattern', 'Color'])
  })

  it('reads all five inputs, in source order, with their types', () => {
    expect(parsed.header.inputs.map((i) => [i.name, i.type])).toEqual([
      ['width', 'float'],
      ['offset', 'point2D'],
      ['color1', 'color'],
      ['color2', 'color'],
      ['splitPos', 'point2D'],
    ])
  })

  it('keeps an input that declares DEFAULT but no MIN/MAX', () => {
    // The common shape across the corpus, and the one the remap derivation has
    // to synthesise a range for. It must not be dropped or defaulted to 0..1
    // here — that decision belongs to isfContract, with the DEFAULT in hand.
    const width = parsed.header.inputs[0]
    expect(width.default).toBe(0.25)
    expect(width.min).toBeUndefined()
    expect(width.max).toBeUndefined()
  })

  it('reads MIN/MAX regardless of the order they appear in', () => {
    // `splitPos` writes MAX, then DEFAULT, then MIN. JSON is unordered and the
    // parser must be too — this is a real ordering from the real file.
    const splitPos = parsed.header.inputs[4]
    expect(splitPos.min).toEqual([0, 0])
    expect(splitPos.default).toEqual([0.5, 0.5])
    expect(splitPos.max).toEqual([1, 1])
  })

  it('keeps colours four-component', () => {
    expect(parsed.header.inputs[2].default).toEqual([1, 1, 1, 1])
    expect(parsed.header.inputs[3].default).toEqual([0, 0, 0, 1])
  })
})

describe('the refusals', () => {
  it('refuses PASSES, naming multi-pass as the reason', () => {
    const src = isf({ ISFVSN: '2', PASSES: [{ TARGET: 'bufferA' }] })
    expect(() => parseISF(src, { origin: 'Trails.fs' })).toThrow(IsfImportError)
    expect(() => parseISF(src, { origin: 'Trails.fs' })).toThrow(/Trails\.fs: declares PASSES/)
  })

  it('refuses TYPE image, naming it a filter rather than a scene', () => {
    const src = isf({ INPUTS: [{ NAME: 'inputImage', TYPE: 'image' }] })
    expect(() => parseISF(src)).toThrow(/is TYPE "image" — this is a FILTER/)
  })

  it('refuses both audio types, pointing at the prelude instead', () => {
    for (const type of ['audio', 'audioFFT']) {
      const src = isf({ INPUTS: [{ NAME: 'track', TYPE: type }] })
      expect(() => parseISF(src)).toThrow(/SHADER_SCENE_PRELUDE/)
      expect(() => parseISF(src)).toThrow(new RegExp(`TYPE "${type}"`))
    }
  })

  it('refuses IMPORTED, which is an image dependency by another name', () => {
    expect(() => parseISF(isf({ IMPORTED: { tex: { PATH: 'noise.png' } } }))).toThrow(
      /declares IMPORTED/,
    )
  })

  it('refuses an unknown TYPE separately from a known-but-unsupported one', () => {
    // The two need different messages: one says "pick another shader", the
    // other says "this file is malformed".
    expect(() => parseISF(isf({ INPUTS: [{ NAME: 'x', TYPE: 'flaot' }] }))).toThrow(/unknown TYPE/)
  })

  it('refuses a NAME that is not a bare GLSL identifier', () => {
    expect(() => parseISF(isf({ INPUTS: [{ NAME: 'line width', TYPE: 'float' }] }))).toThrow(
      /bare GLSL identifier/,
    )
  })

  it('refuses two inputs of the same NAME', () => {
    const src = isf({
      INPUTS: [
        { NAME: 'width', TYPE: 'float' },
        { NAME: 'width', TYPE: 'float' },
      ],
    })
    expect(() => parseISF(src)).toThrow(/redeclares input "width"/)
  })

  it('refuses a long whose VALUES and LABELS do not line up', () => {
    const src = isf({
      INPUTS: [{ NAME: 'mode', TYPE: 'long', VALUES: [0, 1, 2], LABELS: ['a', 'b'] }],
    })
    expect(() => parseISF(src)).toThrow(/3 VALUES but 2 LABELS/)
  })

  it('reports invalid JSON as invalid JSON rather than as a missing key', () => {
    expect(() => parseISF('/* { "INPUTS": [], } */\nvoid main() {}')).toThrow(/not valid JSON/)
  })

  it('prefixes every message with the origin, so a batch import says which file', () => {
    try {
      parseISF(isf({ PASSES: [] }), { origin: 'Foo.fs' })
      expect.unreachable('should have refused')
    } catch (e) {
      expect(e).toBeInstanceOf(IsfImportError)
      expect((e as IsfImportError).origin).toBe('Foo.fs')
      expect((e as IsfImportError).message.startsWith('Foo.fs: ')).toBe(true)
    }
  })
})

describe('tolerances the corpus actually needs', () => {
  it('accepts a numeric ISFVSN', () => {
    expect(parseISF(isf({ ISFVSN: 2 })).header.isfvsn).toBe('2')
  })

  it('accepts 0/1 where a bool is expected', () => {
    const p = parseISF(isf({ INPUTS: [{ NAME: 'flip', TYPE: 'bool', DEFAULT: 1 }] }))
    expect(p.header.inputs[0].default).toBe(true)
  })

  it('pads a three-component colour with opaque alpha', () => {
    const p = parseISF(isf({ INPUTS: [{ NAME: 'tint', TYPE: 'color', DEFAULT: [1, 0, 0] }] }))
    expect(p.header.inputs[0].default).toEqual([1, 0, 0, 1])
  })

  it('accepts a shader with no INPUTS at all', () => {
    expect(parseISF(isf({ ISFVSN: '2' })).header.inputs).toEqual([])
  })
})
