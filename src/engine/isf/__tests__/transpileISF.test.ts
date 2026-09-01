import { describe, expect, it } from 'vitest'
import { parseISF, type ParsedISF } from '../parseISF'
import {
  ISF_FADE_WRAPPER,
  isfUniformName,
  isfUniformSeed,
  PRELUDE_SYMBOLS,
  SHADER_LIB_SYMBOLS,
  tokenizeGlsl,
  transpileISF,
} from '../transpileISF'
import CHECKERBOARD_FS from './fixtures/Checkerboard.fs?raw'
import CREATE_SHADER_SCENE_SRC from '../../createShaderScene.tsx?raw'

/** Build a one-off ISF file with the given inputs and body. */
function isf(inputs: unknown[], body: string): ParsedISF {
  return parseISF(`/*${JSON.stringify({ ISFVSN: '2', INPUTS: inputs })}*/\n${body}\n`)
}

/** A body that satisfies the "must have a main" rule and nothing else. */
const TRIVIAL_MAIN = 'void main() { gl_FragColor = vec4(1.0); }'

/**
 * The emitted CODE, with the generated commentary dropped.
 *
 * The uniform block documents each uniform with the ISF name it came from, so
 * `TIMEDELTA` legitimately survives into the output as prose. An assertion that
 * no built-in name is left behind is about the code, and would otherwise be
 * asserting that the generated source is undocumented.
 */
function code(frag: string): string {
  return tokenizeGlsl(frag)
    .filter((t) => t.kind !== 'comment')
    .map((t) => t.text)
    .join('')
}

describe('the reserved symbol lists stay in step with the code they describe', () => {
  /**
   * The pin that makes a hardcoded PRELUDE_SYMBOLS safe.
   *
   * Read as TEXT rather than imported: importing `createShaderScene.tsx` pulls
   * three, React and @react-three/fiber into a unit test for a pure module. The
   * point of the assertion is that the list has not drifted from the prelude,
   * and the prelude's source text answers that as well as its runtime value
   * would — with none of the dependency.
   */
  it('PRELUDE_SYMBOLS is exactly what SHADER_SCENE_PRELUDE declares', () => {
    const start = CREATE_SHADER_SCENE_SRC.indexOf('SHADER_SCENE_PRELUDE')
    expect(start).toBeGreaterThan(-1)
    const open = CREATE_SHADER_SCENE_SRC.indexOf('`', start)
    // The prelude's doc comments contain escaped backticks, so the closing
    // delimiter has to be found by scanning past escapes rather than by indexOf.
    let close = open + 1
    while (close < CREATE_SHADER_SCENE_SRC.length) {
      if (CREATE_SHADER_SCENE_SRC[close] === '\\') {
        close += 2
        continue
      }
      if (CREATE_SHADER_SCENE_SRC[close] === '`') break
      close++
    }
    const prelude = CREATE_SHADER_SCENE_SRC.slice(open + 1, close)

    const declared = [...prelude.matchAll(/\b(?:uniform|varying)\s+\w+\s+(\w+)\s*;/g)].map(
      (m) => m[1],
    )
    expect(declared.length).toBeGreaterThan(15)
    expect([...declared].sort()).toEqual([...PRELUDE_SYMBOLS].sort())
  })

  it('SHADER_LIB_SYMBOLS finds every shared chunk symbol a scene could collide with', () => {
    // Spot-checked against the names the shared chunks actually export. The
    // extraction is a regex over our own strings, so this is the assertion that
    // the regex still matches the house style those strings are written in.
    for (const name of [
      'fbm',
      'fbm3',
      'map',
      'uOctaves',
      'uMaxSteps',
      'hash21',
      'noise2',
      'hash13',
      'noise3',
      'snoise',
      'snoiseVec3',
      'curlNoise',
      'mixOklab',
      'paletteRamp',
      'paletteLit',
      'rot2',
      'sdSphere',
      'sdBox',
      'sdRoundBox',
      'sdTorus',
      'opSmoothUnion',
      'opSmoothSubtract',
      'opSmoothIntersect',
      'opTwist',
      'calcNormal',
      'raymarch',
      'mod289',
      'permute',
      'taylorInvSqrt',
    ]) {
      expect(SHADER_LIB_SYMBOLS).toContain(name)
    }
    // FULLSCREEN_VERT is the vertex stage and is deliberately not scanned;
    // reserving `main` would refuse every ISF shader in existence.
    expect(SHADER_LIB_SYMBOLS).not.toContain('main')
  })
})

describe('built-in substitution', () => {
  const BODY = `
    void main() {
      float t = TIME;
      vec2 res = RENDERSIZE;
      vec2 a = isf_FragNormCoord;
      vec2 b = vv_FragNormCoord;
      int pass = PASSINDEX;
      float dt = TIMEDELTA;
      int frame = FRAMEINDEX;
      vec4 when = DATE;
      gl_FragColor = vec4(t + dt + when.w, res.x, a.x + b.y, float(pass + frame));
    }
  `
  const out = transpileISF(isf([], BODY))

  it('maps every ISF built-in onto its prelude equivalent', () => {
    expect(out.frag).toContain('float t = uTime;')
    expect(out.frag).toContain('vec2 res = uRes;')
    expect(out.frag).toContain('vec2 a = vUv;')
    expect(out.frag).toContain('vec2 b = vUv;')
  })

  it('folds PASSINDEX to the literal 0, since there is only ever one pass', () => {
    expect(out.frag).toContain('int pass = 0;')
  })

  it('turns TIMEDELTA, FRAMEINDEX and DATE into per-scene uniforms', () => {
    expect(out.frag).toContain('float dt = uIsfTimeDelta;')
    expect(out.frag).toContain('int frame = uIsfFrameIndex;')
    expect(out.frag).toContain('vec4 when = uIsfDate;')
    expect(out.frag).toContain('uniform float uIsfTimeDelta;')
    expect(out.frag).toContain('uniform int uIsfFrameIndex;')
    expect(out.frag).toContain('uniform vec4 uIsfDate;')
    expect(out.builtinsUsed).toEqual(['TIMEDELTA', 'FRAMEINDEX', 'DATE'])
  })

  it('leaves no ISF built-in name behind', () => {
    const body = code(out.frag)
    for (const name of [
      'TIME',
      'RENDERSIZE',
      'isf_FragNormCoord',
      'vv_FragNormCoord',
      'PASSINDEX',
      'TIMEDELTA',
      'FRAMEINDEX',
      'DATE',
    ]) {
      expect(body).not.toMatch(new RegExp(`\\b${name}\\b`))
    }
  })

  it('leaves gl_FragColor alone — ISF is already GLSL ES 1.00', () => {
    expect(out.frag).toContain('gl_FragColor = vec4(')
  })

  it('declares nothing for a built-in the shader never mentions', () => {
    const bare = transpileISF(isf([], TRIVIAL_MAIN))
    expect(bare.builtinsUsed).toEqual([])
    expect(bare.frag).not.toContain('uIsfTimeDelta')
  })
})

describe('the uFade wrapper', () => {
  const out = transpileISF(isf([], 'void main() { gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0); }'))

  it('renames the source entry point out of the way', () => {
    expect(out.frag).toContain('void isf_main() {')
    expect(out.frag).not.toMatch(/void\s+main\s*\(\s*\)\s*\{\s*gl_FragColor\s*=\s*vec4\(1\.0/)
  })

  it('appends the wrapper that honours uFade', () => {
    expect(out.frag).toContain(ISF_FADE_WRAPPER)
    expect(ISF_FADE_WRAPPER).toBe('void main() { isf_main(); gl_FragColor.rgb *= uFade; }')
  })

  it('refuses a shader with no entry point at all', () => {
    expect(() => transpileISF(isf([], 'float helper() { return 1.0; }'))).toThrow(
      /has no `void main\(\)`/,
    )
  })
})

describe('the rename is token-level, not textual', () => {
  it('does not corrupt an identifier that merely contains the input name', () => {
    const out = transpileISF(
      isf(
        [{ NAME: 'width', TYPE: 'float', DEFAULT: 0.25 }],
        `
        // width of the stroke
        void main() {
          float lineWidth = width * 2.0;
          float widthScale = width;
          float w = lineWidth + widthScale;
          gl_FragColor = vec4(w);
        }
        `,
      ),
    )
    expect(out.frag).toContain('float lineWidth = uIsfWidth * 2.0;')
    expect(out.frag).toContain('float widthScale = uIsfWidth;')
    expect(out.frag).toContain('float w = lineWidth + widthScale;')
    // A naive replace would leave `uIsfWidthScale` / `lineuIsfWidth` behind.
    expect(out.frag).not.toContain('uIsfWidthScale')
    expect(out.frag).not.toContain('lineuIsfWidth')
  })

  it('leaves comments untouched', () => {
    const out = transpileISF(
      isf([{ NAME: 'width', TYPE: 'float' }], `/* set the width */\n${TRIVIAL_MAIN}`),
    )
    expect(out.frag).toContain('/* set the width */')
  })

  it('does not rewrite a swizzle or field selector that shares the name', () => {
    const out = transpileISF(
      isf(
        [{ NAME: 'x', TYPE: 'float' }],
        'void main() { vec2 v = vec2(1.0); gl_FragColor = vec4(v.x + x); }',
      ),
    )
    expect(out.frag).toContain('v.x + uIsfX')
    expect(out.frag).not.toContain('v.uIsfX')
  })

  it('does not find an identifier inside a float literal', () => {
    const out = transpileISF(
      isf(
        [{ NAME: 'e5', TYPE: 'float' }],
        'void main() { float f = 1.0e5 + e5; gl_FragColor = vec4(f); }',
      ),
    )
    expect(out.frag).toContain('1.0e5 + uIsfE5')
  })

  it('leaves struct members alone, since their uses are field selectors', () => {
    const out = transpileISF(
      isf(
        [{ NAME: 'width', TYPE: 'float' }],
        `
        struct Knob { float width; };
        void main() {
          Knob k;
          k.width = width;
          gl_FragColor = vec4(k.width);
        }
        `,
      ),
    )
    // Renaming the member but not `k.width` would split one name into two.
    expect(out.frag).toContain('struct Knob { float width; };')
    expect(out.frag).toContain('k.width = uIsfWidth;')
  })
})

describe('symbol collisions are fatal', () => {
  it('throws when the shader declares a prelude uniform', () => {
    expect(() =>
      transpileISF(isf([], `uniform float uTime;\n${TRIVIAL_MAIN}`), { origin: 'Clash.fs' }),
    ).toThrow(/SHADER_SCENE_PRELUDE/)
  })

  it('throws for every prelude symbol, not just the famous ones', () => {
    for (const name of PRELUDE_SYMBOLS) {
      const decl = name === 'vUv' ? `varying vec2 ${name};` : `uniform float ${name};`
      expect(() => transpileISF(isf([], `${decl}\n${TRIVIAL_MAIN}`))).toThrow(
        new RegExp(`"${name}"`),
      )
    }
  })

  it('throws when the shader declares a shared-chunk symbol', () => {
    expect(() =>
      transpileISF(isf([], `float fbm(vec2 p) { return p.x; }\n${TRIVIAL_MAIN}`)),
    ).toThrow(/shaderLib\.ts/)
    expect(() =>
      transpileISF(isf([], `float map(vec3 p) { return p.x; }\n${TRIVIAL_MAIN}`)),
    ).toThrow(/"map"/)
  })

  it('lets a shared-chunk name through when the scene will never set include:', () => {
    // The escape hatch, and the reason the strict set is the default rather
    // than the only option.
    const out = transpileISF(isf([], `float fbm(vec2 p) { return p.x; }\n${TRIVIAL_MAIN}`), {
      reserved: PRELUDE_SYMBOLS,
    })
    expect(out.frag).toContain('float fbm(vec2 p)')
  })

  it('does not mistake a local or a parameter for a file-scope declaration', () => {
    // `uTime` here is a parameter name and a local, both of which legally
    // shadow the prelude. Refusing them would be a false positive.
    const out = transpileISF(
      isf([], 'float f(float uTime) { float uFade = uTime; return uFade; }\n' + TRIVIAL_MAIN),
    )
    expect(out.frag).toContain('float f(float uTime)')
  })

  it('refuses an ISF image built-in, naming it as a filter', () => {
    expect(() =>
      transpileISF(isf([], 'void main() { gl_FragColor = IMG_THIS_PIXEL(tex); }')),
    ).toThrow(/this shader is a filter/)
  })
})

describe('the emitted uniform block', () => {
  const parsed = parseISF(CHECKERBOARD_FS, { origin: 'Checkerboard.fs' })
  const out = transpileISF(parsed, { origin: 'Checkerboard.fs' })

  it('namespaces every input under uIsf', () => {
    expect(out.uniformNames).toEqual({
      width: 'uIsfWidth',
      offset: 'uIsfOffset',
      color1: 'uIsfColor1',
      color2: 'uIsfColor2',
      splitPos: 'uIsfSplitPos',
    })
    expect(isfUniformName('width')).toBe('uIsfWidth')
  })

  it('maps each ISF type onto its GLSL type', () => {
    expect(out.frag).toContain('uniform float uIsfWidth;')
    expect(out.frag).toContain('uniform vec2 uIsfOffset;')
    expect(out.frag).toContain('uniform vec4 uIsfColor1;')
    const typed = transpileISF(
      isf(
        [
          { NAME: 'flag', TYPE: 'bool' },
          { NAME: 'go', TYPE: 'event' },
          { NAME: 'mode', TYPE: 'long', VALUES: [0, 1], LABELS: ['a', 'b'] },
        ],
        TRIVIAL_MAIN,
      ),
    )
    expect(typed.frag).toContain('uniform bool uIsfFlag;')
    expect(typed.frag).toContain('uniform bool uIsfGo;')
    expect(typed.frag).toContain('uniform int uIsfMode;')
  })

  it('rewrites the body against those names', () => {
    expect(out.frag).toContain('float\t\tsize = uIsfWidth * uRes.x;')
    expect(out.frag).toContain('uIsfOffset.x')
    expect(out.frag).toContain('uIsfSplitPos.y')
    expect(out.frag).toContain('out_color = uIsfColor1;')
  })

  it('redeclares no prelude uniform', () => {
    for (const name of PRELUDE_SYMBOLS) {
      expect(out.frag).not.toMatch(new RegExp(`(?:uniform|varying)\\s+\\w+\\s+${name}\\s*;`))
    }
  })

  it('seeds uniforms from the ISF defaults, in a shape three accepts', () => {
    const seed = isfUniformSeed(out)
    expect(seed.uIsfWidth.value).toBe(0.25)
    expect(seed.uIsfOffset.value).toEqual([0, 0])
    expect(seed.uIsfColor1.value).toEqual([1, 1, 1, 1])
    // A factory result, not shared state: two mounts must not alias one array.
    expect(isfUniformSeed(out).uIsfOffset.value).not.toBe(seed.uIsfOffset.value)
  })

  it('credits the source in the emitted header', () => {
    expect(out.frag).toContain('CREDIT: by VIDVOX')
    expect(out.frag).toContain('Checkerboard.fs')
  })
})

describe('tokenizeGlsl', () => {
  it('round-trips losslessly, which is what makes the rewrite safe', () => {
    const src = '/* a */ void main() { float x = 1.0e-5; // done\n}'
    expect(
      tokenizeGlsl(src)
        .map((t) => t.text)
        .join(''),
    ).toBe(src)
  })

  it('keeps an exponent inside its number', () => {
    const nums = tokenizeGlsl('1.0e5 + .5 + 2.').filter((t) => t.kind === 'number')
    expect(nums.map((t) => t.text)).toEqual(['1.0e5', '.5', '2.'])
  })

  it('treats a trailing bare e as an identifier rather than an exponent', () => {
    const kinds = tokenizeGlsl('1.0e').map((t) => `${t.kind}:${t.text}`)
    expect(kinds).toEqual(['number:1.0', 'ident:e'])
  })
})
