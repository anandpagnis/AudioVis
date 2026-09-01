import { describe, expect, it } from 'vitest'
import { IsfImportError, ISF_FILTER_IMAGE_INPUT, parseISF, type ParsedISF } from '../parseISF'
import {
  FILTER_PRELUDE_SYMBOLS,
  FILTER_RESERVED_SYMBOLS,
  ISF_FADE_WRAPPER,
  ISF_FILTER_IMAGE_UNIFORM,
  ISF_FILTER_MIX_UNIFORM,
  ISF_FILTER_PRELUDE,
  ISF_FILTER_WRAPPER,
  ISF_IMAGE_FUNCTIONS,
  ISF_IMAGE_SAMPLERS_GLSL,
  isfUniformSeed,
  PRELUDE_SYMBOLS,
  SHADER_LIB_SYMBOLS,
  tokenizeGlsl,
  transpileISF,
} from '../transpileISF'
import BAD_TV_FS from '../../../assets/isf/filters/Bad TV.fs?raw'
import BROKEN_LCD_FS from '../../../assets/isf/filters/Broken LCD.fs?raw'
import BUMP_DISTORTION_FS from '../../../assets/isf/filters/Bump Distortion.fs?raw'
import CMYK_HALFTONE_FS from '../../../assets/isf/filters/CMYK Halftone.fs?raw'
import COLOR_INVERT_FS from '../../../assets/isf/filters/Color Invert.fs?raw'
import CHECKERBOARD_FS from './fixtures/Checkerboard.fs?raw'

/**
 * The filter half of the adapter — `kind: 'filter'` through `parseISF` and
 * `transpileISF`, and the `IMG_*` implementations that make it possible at all.
 *
 * ## Why the vendored files carry most of the weight here
 *
 * The generator tests could reasonably prove themselves on hand-built headers,
 * because the interesting cases there are malformed files. The interesting
 * cases HERE are well-formed ones, and a synthetic filter is a filter I would
 * write to match the transpiler I just wrote. Real ones do things I would not
 * have thought to write down:
 *
 *  - `Broken LCD` calls `IMG_PIXEL(inputImage, vec2(modCoord.x, 0.0))` — a
 *    nested paren inside a macro argument, which is exactly what breaks the JS
 *    reference implementation's regex expansion and is the reason this adapter
 *    emits FUNCTIONS instead. It also declares its own `map()`, which is the
 *    case that decided `FILTER_RESERVED_SYMBOLS` must not include the shared
 *    chunk symbols.
 *  - `Bump Distortion` guards a `distance()` redefinition behind `#ifndef
 *    GL_ES` and writes `vec4(0.0)` out of bounds — the one alpha the wet/dry
 *    wrapper had to be checked against.
 *  - `Bad TV` animates off `TIME` and declares nine float inputs.
 *  - `CMYK Halftone` works in `gl_FragCoord` pixel space with `IMG_PIXEL`.
 *  - `Color Invert` is the whole format in three lines.
 *
 * All five are vendored verbatim from `Vidvox/ISF-Files` (MIT) under
 * `src/assets/isf/filters/`, with that repository's LICENSE and a NOTICE
 * alongside. Loaded with `?raw`: a test that reaches the network fails on a
 * plane, fails behind a CI proxy, and silently changes meaning the day upstream
 * edits a file.
 */

/** The five vendored proving filters, by the id an import would give them. */
const VENDORED: ReadonlyArray<readonly [string, string]> = [
  ['Bad TV', BAD_TV_FS],
  ['Broken LCD', BROKEN_LCD_FS],
  ['Bump Distortion', BUMP_DISTORTION_FS],
  ['CMYK Halftone', CMYK_HALFTONE_FS],
  ['Color Invert', COLOR_INVERT_FS],
]

/** Build a one-off ISF filter file with the given inputs and body. */
function filterIsf(inputs: unknown[], body: string): string {
  return `/*${JSON.stringify({ ISFVSN: '2', INPUTS: inputs })}*/\n${body}\n`
}

/** The image input every filter is required to declare. */
const IMAGE_INPUT = { NAME: ISF_FILTER_IMAGE_INPUT, TYPE: 'image' }

/** Parse a filter source, throwing on anything the filter gate refuses. */
function parseFilter(src: string, origin = 'test.fs'): ParsedISF {
  return parseISF(src, { origin, kind: 'filter' })
}

/** Transpile a filter source end to end. */
function transpileFilter(src: string, origin = 'test.fs') {
  return transpileISF(parseFilter(src, origin), { origin, kind: 'filter' })
}

/** The emitted code with generated commentary dropped — see transpileISF.test.ts. */
function code(frag: string): string {
  return tokenizeGlsl(frag)
    .filter((t) => t.kind !== 'comment')
    .map((t) => t.text)
    .join('')
}

describe('parseISF in filter mode', () => {
  it('accepts the inputImage every real filter declares', () => {
    const parsed = parseFilter(COLOR_INVERT_FS, 'Color Invert.fs')
    expect(parsed.header.inputs.map((i) => [i.name, i.type])).toEqual([['inputImage', 'image']])
    expect(parsed.header.credit).toBe('by zoidberg')
  })

  it('leaves generator mode exactly as it was — an image is still a refusal', () => {
    // The whole point of defaulting `kind` to 'generator': every caller written
    // before filters existed keeps its behaviour, including the message that
    // tells a curator they picked the wrong sort of shader.
    expect(() => parseISF(COLOR_INVERT_FS, { origin: 'Color Invert.fs' })).toThrow(
      /is TYPE "image" — this is a FILTER/,
    )
    expect(() => parseISF(COLOR_INVERT_FS, { origin: 'x', kind: 'generator' })).toThrow(
      IsfImportError,
    )
  })

  it('refuses a shader with no image input when one was asked for', () => {
    // Checkerboard is a real generator. Handed to the filter runtime it would
    // compile and ignore its input entirely, painting over the frame — which
    // looks like the post chain has broken rather than like a mis-import.
    expect(() => parseFilter(CHECKERBOARD_FS, 'Checkerboard.fs')).toThrow(
      /declares no image input named "inputImage"/,
    )
  })

  it('refuses an image input under any other name, naming transitions', () => {
    // `startImage`/`endImage` is the transition shape. There is exactly one
    // upstream frame in a post chain, so picking one of the two would render
    // half a transition against black.
    const src = filterIsf(
      [
        { NAME: 'startImage', TYPE: 'image' },
        { NAME: 'endImage', TYPE: 'image' },
      ],
      'void main() { gl_FragColor = vec4(1.0); }',
    )
    expect(() => parseFilter(src, 'Fade.fs')).toThrow(/must be named "inputImage"/)
    expect(() => parseFilter(src, 'Fade.fs')).toThrow(/TRANSITION/)
  })

  it('refuses a second image alongside inputImage', () => {
    const src = filterIsf(
      [IMAGE_INPUT, { NAME: 'maskImage', TYPE: 'image' }],
      'void main() { gl_FragColor = vec4(1.0); }',
    )
    expect(() => parseFilter(src, 'Mask.fs')).toThrow(/must be named "inputImage"/)
  })

  it('still refuses PASSES in filter mode', () => {
    // The multi-pass gap is about render-target ownership, and a filter has no
    // more of that than a scene does.
    const src = `/*${JSON.stringify({ INPUTS: [IMAGE_INPUT], PASSES: [{ TARGET: 'a' }] })}*/\nvoid main() {}`
    expect(() => parseFilter(src, 'Trails.fs')).toThrow(/Trails\.fs: declares PASSES/)
  })

  it('still refuses IMPORTED in filter mode', () => {
    const src = `/*${JSON.stringify({ INPUTS: [IMAGE_INPUT], IMPORTED: { tex: { PATH: 'n.png' } } })}*/\nvoid main() {}`
    expect(() => parseFilter(src)).toThrow(/declares IMPORTED/)
  })

  it('still refuses audio inputs in filter mode', () => {
    const src = filterIsf([IMAGE_INPUT, { NAME: 'track', TYPE: 'audioFFT' }], 'void main() {}')
    expect(() => parseFilter(src)).toThrow(/TYPE "audioFFT"/)
  })

  it('keeps the IsfImportError discipline, so a batch import can skip a file', () => {
    try {
      parseFilter(CHECKERBOARD_FS, 'Checkerboard.fs')
      expect.unreachable('should have refused')
    } catch (e) {
      expect(e).toBeInstanceOf(IsfImportError)
      expect((e as IsfImportError).origin).toBe('Checkerboard.fs')
    }
  })
})

describe('the filter prelude', () => {
  it('carries none of the scene prelude — no uFade, no palette, no audio', () => {
    // The load-bearing assertion of the whole filter path. `uFade` is the
    // OUTGOING scene's crossfade; honouring it in a post pass would dim the
    // entire show on every scene change. The palette has already been baked
    // into the pixels arriving in tDiffuse, and a filter is a look rather than
    // a performer, so the audio uniforms mean nothing to it either.
    const sceneOnly = PRELUDE_SYMBOLS.filter((s) => !FILTER_PRELUDE_SYMBOLS.includes(s))
    expect(sceneOnly).toContain('uFade')
    for (const name of ['uFade', 'uBg', 'uShadow', 'uMid', 'uAccent', 'uGlow']) {
      expect(FILTER_PRELUDE_SYMBOLS).not.toContain(name)
      expect(ISF_FILTER_PRELUDE).not.toMatch(new RegExp(`uniform\\s+\\w+\\s+${name}\\s*;`))
    }
    for (const name of ['uKick', 'uSnare', 'uHihat', 'uBassClock', 'uBeatSin']) {
      expect(FILTER_PRELUDE_SYMBOLS).not.toContain(name)
    }
  })

  it('declares exactly the four uniforms a post pass can honestly supply', () => {
    const uniforms = [...ISF_FILTER_PRELUDE.matchAll(/uniform\s+\w+\s+(\w+)\s*;/g)].map((m) => m[1])
    expect(uniforms.sort()).toEqual(
      [ISF_FILTER_IMAGE_UNIFORM, ISF_FILTER_MIX_UNIFORM, 'uRes', 'uTime'].sort(),
    )
  })

  it('shares uRes/uTime/vUv with the scene prelude, so ISF built-ins map the same way', () => {
    // `TIME` -> uTime and `RENDERSIZE` -> uRes are one substitution table for
    // both paths. If the filter prelude renamed either, the table would have to
    // fork and the two would drift.
    for (const shared of ['uRes', 'uTime', 'vUv']) {
      expect(PRELUDE_SYMBOLS).toContain(shared)
      expect(FILTER_PRELUDE_SYMBOLS).toContain(shared)
    }
  })

  it('FILTER_PRELUDE_SYMBOLS is exactly what the prelude declares', () => {
    // Derived rather than hardcoded (unlike PRELUDE_SYMBOLS, which cannot be —
    // it lives in a .tsx that would drag three into this module). This asserts
    // the derivation actually sees every name, so a uniform added to the
    // prelude cannot slip past the collision check.
    expect([...FILTER_PRELUDE_SYMBOLS].sort()).toEqual(
      [
        ...ISF_IMAGE_FUNCTIONS,
        ISF_FILTER_IMAGE_UNIFORM,
        ISF_FILTER_MIX_UNIFORM,
        'uRes',
        'uTime',
        'vUv',
      ].sort(),
    )
  })

  it('reserves the prelude but NOT the shared shaderLib chunks', () => {
    // The asymmetry with RESERVED_SYMBOLS is deliberate: IsfFilterPass has no
    // `include:` mechanism, so reserving `fbm`/`map`/`noise` would refuse
    // filters that carry their own helper to prevent a conflict that cannot
    // happen. `Broken LCD` declares `map` and `noise` at file scope and is one
    // of the best filters in the corpus.
    expect(SHADER_LIB_SYMBOLS).toContain('map')
    expect(FILTER_RESERVED_SYMBOLS).not.toContain('map')
    for (const name of FILTER_PRELUDE_SYMBOLS) expect(FILTER_RESERVED_SYMBOLS).toContain(name)
  })
})

describe('the IMG_* image functions', () => {
  /** One emitted implementation's body, by function name. */
  function impl(name: string): string {
    const m = ISF_IMAGE_SAMPLERS_GLSL.match(
      new RegExp(`\\b${name}\\s*\\([^)]*\\)\\s*\\{([^}]*)\\}`),
    )
    expect(m, `${name} is not implemented`).not.toBeNull()
    return (m as RegExpMatchArray)[1].trim()
  }

  it('IMG_NORM_PIXEL samples at the normalised coordinate given', () => {
    expect(impl('IMG_NORM_PIXEL')).toBe('return texture2D(image, normCoord);')
  })

  it('IMG_PIXEL divides pixel coordinates by the image size', () => {
    // The spec's own words: these take "either pixel-based coords or normalized
    // coords". A filter passing gl_FragCoord.xy straight to texture2D would
    // sample far outside 0..1 and clamp to one edge pixel — a solid colour, and
    // exactly the kind of plausible-but-wrong picture the adapter exists to
    // prevent.
    expect(impl('IMG_PIXEL')).toBe('return texture2D(image, pixelCoord / IMG_SIZE(image));')
  })

  it('IMG_THIS_PIXEL and IMG_THIS_NORM_PIXEL both resolve to the current fragment', () => {
    // Despite the name, the reference implementation expands BOTH to the
    // normalised form — "this pixel" means the pixel being rendered, not "in
    // pixel units". Getting that backwards would offset every use of
    // IMG_THIS_PIXEL by the full resolution.
    expect(impl('IMG_THIS_PIXEL')).toBe('return texture2D(image, vUv);')
    expect(impl('IMG_THIS_NORM_PIXEL')).toBe('return texture2D(image, vUv);')
  })

  it('carries IMG_NORM_THIS_PIXEL, the spelling the ISF docs actually print', () => {
    // docs.isf.video/ref_functions.html documents `IMG_NORM_THIS_PIXEL`; all
    // 104 uses across the corpus spell it `IMG_THIS_NORM_PIXEL`. The docs and
    // the format disagree, so both are accepted.
    expect(impl('IMG_NORM_THIS_PIXEL')).toBe('return texture2D(image, vUv);')
    expect(ISF_IMAGE_FUNCTIONS).toContain('IMG_NORM_THIS_PIXEL')
  })

  it('IMG_SIZE returns the render-buffer size as a vec2', () => {
    expect(ISF_IMAGE_SAMPLERS_GLSL).toMatch(/vec2\s+IMG_SIZE\s*\(sampler2D\s+image\)/)
    expect(impl('IMG_SIZE')).toBe('return uRes;')
  })

  it('takes the sampler as a parameter, so a nested paren in the argument survives', () => {
    // The JS reference implementation expands these with regexes and its
    // IMG_PIXEL pattern mis-splits `IMG_PIXEL(img, vec2(x, 0.0))`. Real filters
    // write exactly that — `Broken LCD` six times. Declaring real functions
    // hands argument parsing to the GLSL compiler, where it belongs.
    for (const fn of ISF_IMAGE_FUNCTIONS) {
      expect(ISF_IMAGE_SAMPLERS_GLSL).toMatch(new RegExp(`\\b${fn}\\s*\\(\\s*sampler2D\\s`))
    }
    const t = transpileFilter(
      filterIsf(
        [IMAGE_INPUT],
        'void main() { gl_FragColor = IMG_PIXEL(inputImage, vec2(gl_FragCoord.x, 0.0)); }',
      ),
    )
    expect(code(t.frag)).toContain('IMG_PIXEL(tDiffuse, vec2(gl_FragCoord.x, 0.0))')
  })

  it('refuses an IMG_ name it does not implement rather than emitting it', () => {
    const src = filterIsf(
      [IMAGE_INPUT],
      'void main() { gl_FragColor = IMG_THIS_PIXEL_RECT(inputImage); }',
    )
    expect(() => transpileFilter(src, 'Odd.fs')).toThrow(/IMG_THIS_PIXEL_RECT/)
    expect(() => transpileFilter(src, 'Odd.fs')).toThrow(/not one of ISF's image functions/)
  })

  it('still refuses any IMG_ name on the generator path', () => {
    const src = `/*${JSON.stringify({ INPUTS: [] })}*/\nvoid main() { gl_FragColor = IMG_THIS_PIXEL(x); }`
    expect(() => transpileISF(parseISF(src), { origin: 'Gen.fs' })).toThrow(
      /declares no image input/,
    )
  })
})

describe('transpileISF in filter mode', () => {
  it('maps inputImage onto the composer’s tDiffuse and emits no uniform for it', () => {
    const t = transpileFilter(COLOR_INVERT_FS, 'Color Invert.fs')
    expect(t.kind).toBe('filter')
    expect(t.uniformNames.inputImage).toBe(ISF_FILTER_IMAGE_UNIFORM)
    // The prelude declares it; a second declaration is a GLSL redeclaration
    // error, which on this path is a post pass that draws nothing.
    expect(t.uniforms.map((u) => u.name)).not.toContain(ISF_FILTER_IMAGE_UNIFORM)
    expect(code(t.frag)).not.toMatch(/uniform\s+sampler2D/)
    expect(code(t.frag)).toContain('IMG_THIS_PIXEL(tDiffuse)')
    expect(code(t.frag)).not.toContain('inputImage')
  })

  it('emits the wet/dry wrapper, not the fade wrapper', () => {
    const t = transpileFilter(COLOR_INVERT_FS)
    expect(t.frag).toContain(ISF_FILTER_WRAPPER)
    expect(t.frag).not.toContain(ISF_FADE_WRAPPER)
    expect(t.frag).not.toContain('uFade')
  })

  it('the wrapper mixes the whole vec4 from the untouched input', () => {
    // Byte-for-byte, because the shape is the contract: at mix 0 the pass must
    // be an exact pass-through of the input PIXEL, alpha included. `Bump
    // Distortion` writes vec4(0.0) out of bounds, so an .rgb-only mix would
    // leave an alpha of 0 behind on a frame that was meant to be untouched.
    expect(ISF_FILTER_WRAPPER).toBe(
      'void main() { isf_main(); gl_FragColor = ' +
        'mix(texture2D(tDiffuse, vUv), gl_FragColor, uFilterMix); }',
    )
  })

  it('renames the source main so the wrapper can own the entry point', () => {
    const t = transpileFilter(COLOR_INVERT_FS)
    expect(code(t.frag)).toContain('void isf_main()')
    // Exactly one `void main` in the emitted body: the wrapper's.
    expect(code(t.frag).match(/void\s+main\s*\(/g)).toHaveLength(1)
  })

  it('substitutes the ISF built-ins the same way the scene path does', () => {
    const t = transpileFilter(
      filterIsf(
        [IMAGE_INPUT],
        'void main() { gl_FragColor = vec4(TIME, RENDERSIZE.x, isf_FragNormCoord.y, float(PASSINDEX)); }',
      ),
    )
    const body = code(t.frag)
    expect(body).toContain('vec4(uTime, uRes.x, vUv.y, float(0))')
    expect(body).not.toContain('RENDERSIZE')
  })

  it('namespaces every non-image input, leaving the ISF names behind', () => {
    const t = transpileFilter(BUMP_DISTORTION_FS, 'Bump Distortion.fs')
    expect(t.uniformNames).toEqual({
      inputImage: ISF_FILTER_IMAGE_UNIFORM,
      level: 'uIsfLevel',
      radius: 'uIsfRadius',
      center: 'uIsfCenter',
    })
    expect(t.uniforms.map((u) => [u.name, u.glslType])).toEqual([
      ['uIsfLevel', 'float'],
      ['uIsfRadius', 'float'],
      ['uIsfCenter', 'vec2'],
    ])
    expect(isfUniformSeed(t).uIsfCenter.value).toEqual([0.5, 0.5])
  })

  it('refuses an input that would collide with the filter prelude', () => {
    // The mirror of the scene path's rule, with the filter prelude's names.
    // `uFilterMix` deliberately sits outside the `uIsf*` namespace so no ISF
    // input can reach it — seven corpus filters declare an input named
    // `amount`, and `uIsfAmount` would have refused all of them.
    const src = filterIsf(
      [IMAGE_INPUT, { NAME: 'time', TYPE: 'float' }],
      'void main() { gl_FragColor = vec4(1.0); }',
    )
    // `time` -> uIsfTime, which is fine. `res` -> uIsfRes, also fine. Only a
    // body-level declaration can collide, so that is what is checked.
    expect(() => transpileFilter(src)).not.toThrow()
    const clash = filterIsf(
      [IMAGE_INPUT],
      'uniform float uFilterMix;\nvoid main() { gl_FragColor = vec4(1.0); }',
    )
    expect(() => transpileFilter(clash, 'Clash.fs')).toThrow(/declared by ISF_FILTER_PRELUDE/)
  })

  it('an input named "amount" imports cleanly, because uFilterMix is out of its namespace', () => {
    const t = transpileFilter(
      filterIsf(
        [IMAGE_INPUT, { NAME: 'amount', TYPE: 'float', DEFAULT: 0.5 }],
        'void main() { gl_FragColor = IMG_THIS_PIXEL(inputImage) * amount; }',
      ),
    )
    expect(t.uniformNames.amount).toBe('uIsfAmount')
    expect(FILTER_RESERVED_SYMBOLS).not.toContain('uIsfAmount')
  })

  it('refuses a body that redefines one of the image functions', () => {
    const src = filterIsf(
      [IMAGE_INPUT],
      'vec4 IMG_SIZE(sampler2D i) { return vec4(0.0); }\nvoid main() { gl_FragColor = vec4(1.0); }',
    )
    expect(() => transpileFilter(src, 'Own.fs')).toThrow(/ISF's own image functions/)
  })
})

describe('every vendored filter transpiles', () => {
  it.each(VENDORED)('%s', (id, source) => {
    const t = transpileFilter(source, `${id}.fs`)
    expect(t.kind).toBe('filter')
    expect(t.uniformNames.inputImage).toBe(ISF_FILTER_IMAGE_UNIFORM)
    expect(t.frag).toContain(ISF_FILTER_WRAPPER)
    // Nothing ISF-flavoured may survive into the emitted code: an `IMG_`
    // spelling this adapter missed, or an un-substituted built-in, would reach
    // GLSL as an undefined identifier and surface as a pass that draws nothing.
    const body = code(t.frag)
    for (const leftover of ['RENDERSIZE', 'isf_FragNormCoord', 'vv_FragNormCoord', 'inputImage']) {
      expect(body, `${id} still contains ${leftover}`).not.toContain(leftover)
    }
    for (const call of body.match(/IMG_[A-Za-z_0-9]+/g) ?? []) {
      expect(ISF_IMAGE_FUNCTIONS, `${id} calls ${call}`).toContain(call)
    }
  })

  it('reaches every ISF image function a single-image filter can reach', () => {
    const used = new Set<string>()
    for (const [id, source] of VENDORED) {
      for (const m of code(transpileFilter(source, id).frag).match(/IMG_[A-Za-z_0-9]+/g) ?? []) {
        used.add(m)
      }
    }
    // Two names are missing from this list and neither is a coverage gap:
    //
    //   IMG_NORM_THIS_PIXEL is the spelling the ISF docs print and the corpus
    //   never uses — it exists here so a shader written against the docs
    //   compiles, and no real file can exercise it.
    //
    //   IMG_SIZE appears 12 times in 371 corpus files and NOT ONCE on a filter
    //   this runtime accepts. Every live use asks the size of a SECOND image
    //   (`cursorImage`, `maskImage`), which is the shape filter mode refuses,
    //   and the two uses against `inputImage` (Radial Replicate) are commented
    //   out. That is not a coincidence: asking an image's size is only
    //   interesting when it differs from the render size, and for the one image
    //   a post pass can supply it never does. Its implementation is asserted
    //   directly above, and the synthetic case below proves it compiles through
    //   the transpiler.
    expect([...used].sort()).toEqual(['IMG_NORM_PIXEL', 'IMG_PIXEL', 'IMG_THIS_PIXEL'].sort())
    const t = transpileFilter(
      filterIsf(
        [IMAGE_INPUT],
        'void main() { gl_FragColor = IMG_PIXEL(inputImage, IMG_SIZE(inputImage) * 0.5); }',
      ),
    )
    expect(code(t.frag)).toContain('IMG_PIXEL(tDiffuse, IMG_SIZE(tDiffuse) * 0.5)')
  })

  it('Broken LCD keeps its own map()/noise(), which the scene path would refuse', () => {
    // The concrete case behind FILTER_RESERVED_SYMBOLS excluding the shared
    // chunks. Transpiled with the scene path's reserved set this file is
    // rejected; on the filter path it is fine, because nothing injects a
    // competing `map`.
    const parsed = parseFilter(BROKEN_LCD_FS, 'Broken LCD.fs')
    expect(() =>
      transpileISF(parsed, {
        origin: 'Broken LCD.fs',
        kind: 'filter',
        reserved: [...SHADER_LIB_SYMBOLS],
      }),
    ).toThrow(/collides with "map"/)
    expect(() => transpileISF(parsed, { origin: 'Broken LCD.fs', kind: 'filter' })).not.toThrow()
  })

  it('Broken LCD keeps its long input as an int menu uniform', () => {
    const t = transpileFilter(BROKEN_LCD_FS, 'Broken LCD.fs')
    const menu = t.uniforms.find((u) => u.name === 'uIsfPatternStyle')
    expect(menu?.glslType).toBe('int')
    expect(menu?.input?.labels?.[0]).toBe('Random1')
  })

  it('Bad TV animates off TIME, which becomes the pass-driven uTime', () => {
    const body = code(transpileFilter(BAD_TV_FS, 'Bad TV.fs').frag)
    expect(body).toContain('uTime')
    expect(body).not.toMatch(/\bTIME\b/)
  })

  it('CMYK Halftone keeps gl_FragCoord untouched — it means the same thing here', () => {
    // ISF defines gl_FragCoord in pixels of the current pass, and IsfFilterPass
    // renders a fullscreen quad into a target sized to the composer's buffer
    // with uRes set to the same numbers. No rewrite is needed, and adding one
    // would be a full-resolution offset.
    expect(code(transpileFilter(CMYK_HALFTONE_FS, 'CMYK Halftone.fs').frag)).toContain(
      'gl_FragCoord.xy',
    )
  })
})
