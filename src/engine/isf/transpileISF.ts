import { NOISE_GLSL } from '../glsl'
import {
  CURL_NOISE_GLSL,
  NOISE3D_GLSL,
  PALETTE_RAMP_GLSL,
  RAYMARCH_GLSL,
  SDF_GLSL,
  SIMPLEX3D_GLSL,
} from '../shaderLib'
import { IsfImportError, type IsfInput, type IsfKind, type ParsedISF } from './parseISF'

/**
 * Rewrite ISF GLSL into GLSL this engine's `createShaderScene` can compile.
 *
 * ISF and this repo describe the same thing — a fullscreen fragment shader —
 * in two different vocabularies. ISF hands the shader `TIME`, `RENDERSIZE` and
 * a bare uniform per declared input; `createShaderScene` prepends
 * `SHADER_SCENE_PRELUDE` and hands it `uTime`, `uRes` and a palette. The gap is
 * entirely mechanical, which is exactly why it should be done by code rather
 * than by a human with a text editor once per scene: a hand port is where a
 * missing `uFade` multiply or a half-applied rename gets in, and neither of
 * those announces itself.
 *
 * Three rules here are load-bearing and each has a failure mode that is silent
 * if it is got wrong:
 *
 * 1. **The rename is token-level.** ISF input names are bare and often very
 *    short (`width`, `offset`, `size`). A `String.replace` on `width` corrupts
 *    `lineWidth`, `widthScale`, and every occurrence inside a comment — and the
 *    result usually still compiles, because the corrupted identifier is
 *    frequently *also* a valid identifier. See {@link tokenizeGlsl}.
 *
 * 2. **Collisions are fatal, not merged.** The prelude is unconditionally
 *    prepended, so a body that declares its own `uTime` produces a GLSL
 *    redeclaration error at first mount — which in this engine surfaces as a
 *    scene that renders nothing, from inside a `.prewarm()` call at boot. Far
 *    better to fail at import.
 *
 * 3. **`uFade` is honoured.** Every scene in this engine multiplies its output
 *    by `uFade` (crossfade x slot gain x mood intensity). A scene that does not
 *    will not fade: it pops in and out at full brightness on every transition,
 *    which looks like a director bug rather than a scene bug. ISF shaders know
 *    nothing about it, so the wrapper below is added unconditionally.
 *
 * ## Two targets, and why rule 3 inverts for the second one
 *
 * `kind: 'generator'` emits for `createShaderScene` and everything above
 * applies. `kind: 'filter'` emits for `IsfFilterPass`, which is a post-chain
 * stage rather than a scene, and there the third rule is not merely unnecessary
 * but wrong: `uFade` is crossfade x slot gain x mood intensity, all three of
 * which are properties of a SCENE. A post effect has no slot, is not
 * crossfading, and multiplying an already-composited frame by the outgoing
 * scene's fade would dim the whole show every time the director changed scene.
 *
 * So a filter gets {@link ISF_FILTER_PRELUDE} instead of `SHADER_SCENE_PRELUDE`
 * — no palette, no audio, no `uFade` — and {@link ISF_FILTER_WRAPPER} instead
 * of the fade multiply: a wet/dry mix against the untouched input, so the
 * effect can be dialled in rather than only switched on.
 *
 * Single-pass only. `parseISF` already refused anything else.
 */

/* ---------------------------------------------------------------- symbols */

/**
 * Every name `SHADER_SCENE_PRELUDE` declares.
 *
 * Hardcoded rather than derived, because deriving it means importing
 * `createShaderScene.tsx`, which pulls in three, React and `@react-three/fiber`
 * — a renderer dependency inside a module whose entire value is being pure.
 *
 * The rot risk that trade normally carries is closed from the other side:
 * `__tests__/transpileISF.test.ts` reads `createShaderScene.tsx` as text and
 * asserts this list equals the uniforms and varyings the prelude actually
 * declares. Add a uniform to the prelude without adding it here and that test
 * fails, which is the property a hardcoded list usually cannot offer.
 *
 * `vUv` is in the list even though it is a varying rather than a uniform: it is
 * declared in the same prepended block, so redeclaring it fails identically.
 */
export const PRELUDE_SYMBOLS: readonly string[] = [
  'vUv',
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
]

/** GLSL scalar/vector/matrix type keywords, for the two extraction regexes below. */
const GLSL_TYPES =
  'void|bool|int|float|vec2|vec3|vec4|ivec2|ivec3|ivec4|bvec2|bvec3|bvec4|mat2|mat3|mat4|sampler2D|samplerCube'

/**
 * Every function and global a GLSL chunk of OURS defines.
 *
 * Derived by scanning the chunk strings rather than listed, deliberately: these
 * are the sets that grow. `shaderLib.ts` gains a helper every time a scene needs
 * one, and a hardcoded copy would be correct on the day it was written and
 * quietly wrong a month later — at which point the failure is a redefinition
 * error inside a shader nobody is looking at.
 *
 * The scan is two regexes over source that is *known* — these are our own
 * strings, in a house style, not arbitrary GLSL — so a real parser would buy
 * nothing. It is emphatically NOT for third-party ISF bodies; those go through
 * {@link topLevelDeclarations}, which is written to be wrong in the safe
 * direction on source it has never seen.
 */
export function glslChunkSymbols(...chunks: string[]): string[] {
  // `type name (` — a function definition or prototype.
  const fn = new RegExp(`\\b(?:${GLSL_TYPES})\\s+([A-Za-z_]\\w*)\\s*\\(`, 'g')
  // `uniform|varying|attribute|const type name` — a chunk-level global.
  const global = new RegExp(
    `\\b(?:uniform|varying|attribute|const)\\s+(?:${GLSL_TYPES})\\s+([A-Za-z_]\\w*)`,
    'g',
  )
  const found = new Set<string>()
  for (const chunk of chunks) {
    for (const m of chunk.matchAll(fn)) found.add(m[1])
    for (const m of chunk.matchAll(global)) found.add(m[1])
  }
  return [...found].sort()
}

/**
 * Every symbol the shared `shaderLib.ts` / `glsl.ts` chunks define.
 *
 * `FULLSCREEN_VERT` is deliberately excluded: it is the vertex stage, a
 * separate program, and including it would reserve `main`.
 */
export const SHADER_LIB_SYMBOLS: readonly string[] = glslChunkSymbols(
  NOISE_GLSL,
  CURL_NOISE_GLSL,
  SIMPLEX3D_GLSL,
  PALETTE_RAMP_GLSL,
  NOISE3D_GLSL,
  SDF_GLSL,
  RAYMARCH_GLSL,
)

/**
 * The default reserved set: the prelude plus every shared chunk.
 *
 * Both halves are reserved by default even though only the first is
 * unconditionally true. The prelude is always prepended, so a collision with it
 * is always fatal. A shared chunk is only present when the scene passes
 * `include:` — so an ISF shader carrying its own `fbm` is perfectly safe in a
 * scene with no `include`, and the strict default refuses it anyway.
 *
 * That is the right way round. The cost of the strict default is a curator
 * seeing a refusal they can lift in one argument; the cost of the lax default
 * is a scene that compiles today and stops compiling the day someone adds
 * `include: NOISE_GLSL` to pick up a palette ramp — a change with no visible
 * connection to the failure it causes. See {@link TranspileIsfOptions.reserved}
 * for the escape hatch.
 */
export const RESERVED_SYMBOLS: readonly string[] = [...PRELUDE_SYMBOLS, ...SHADER_LIB_SYMBOLS]

/* ------------------------------------------------------------ filter mode */

/**
 * The uniform an ISF filter's `inputImage` becomes.
 *
 * `tDiffuse` rather than `uIsfInputImage` because that is the post chain's own
 * convention for "the frame arriving from the previous pass" — `GradePass`,
 * `LensPass`, `MirrorPass` and `FeedbackPass` all name it that, and
 * `IsfFilterPass` binds it from `inputBuffer.texture` exactly as they do. A
 * filter is not a special kind of pass; it is a pass whose body happens to have
 * been written elsewhere, and it should read like one.
 */
export const ISF_FILTER_IMAGE_UNIFORM = 'tDiffuse'

/**
 * The wet/dry uniform, 0 = untouched input, 1 = the filter's own output.
 *
 * **Deliberately NOT `uIsfAmount`**, which is what the obvious reading of the
 * `uIsf` convention would suggest, because `uIsf<Name>` is the namespace ISF
 * INPUTS are mapped into and `amount` is a name seven filters in the corpus
 * already use — `Chromatic Aberration`, `Twirl`, `v002 Bleach Bypass`,
 * `v002 Dilate`, `v002 Erode`, `v002 Light Leak`, `v002 Technicolor`. Taking
 * `uIsfAmount` for the engine's own knob would make those seven collide with
 * the reserved list and refuse to import, and they are among the most useful
 * filters in the set. `uFilter*` is a namespace `isfUniformName` cannot reach
 * (it always emits `uIsf…`), so this is collision-proof by construction rather
 * than by nobody having tried yet.
 */
export const ISF_FILTER_MIX_UNIFORM = 'uFilterMix'

/**
 * ISF's image-sampling functions, implemented for this engine.
 *
 * **Nothing else in the adapter matters if these are missing**: 1371 of the
 * 1371 image reads across `Vidvox/ISF-Files` go through one of these five
 * names, and an ISF filter that cannot sample its input is not a filter. The
 * spec calls them macros and says they "should be used *instead of*
 * `texture2D()`", which every filter in the corpus does.
 *
 * ## Functions, not `#define`s
 *
 * The JS reference implementation
 * (`msfeldstein/interactive-shader-format-js`) expands these with regexes over
 * the source, and the regexes cannot survive a nested paren: its `IMG_PIXEL`
 * pattern is `/IMG_PIXEL\((.+?)\s?,\s?(.+?\)?\.?.*)\)/`, which mis-splits
 * `IMG_PIXEL(inputImage, vec2(x, 0.0))` — a call `Broken LCD` makes six times.
 * GLSL ES 1.00 permits `sampler2D` as a function parameter (4.1.7: samplers
 * "may only be declared as function parameters or uniform variables"), so
 * declaring real functions gets correct argument handling from the compiler for
 * free, and the rename pass that turns `inputImage` into `tDiffuse` then passes
 * straight through the call site as an ordinary identifier.
 *
 * ## The semantics, checked against the reference implementation
 *
 *  - `IMG_NORM_PIXEL(img, n)` — normalised coords, so a plain `texture2D`.
 *  - `IMG_PIXEL(img, p)` — PIXEL coords. Divided by the image size; the JS
 *    reference divides by `RENDERSIZE` instead, which is the same number here
 *    and only differs for a host feeding an image whose resolution is not the
 *    render resolution. That host is not this one — the only image a filter can
 *    receive is the post chain's own buffer — so the two agree, and dividing by
 *    `IMG_SIZE` keeps the pair self-consistent if that ever stops being true.
 *  - `IMG_THIS_PIXEL(img)` / `IMG_THIS_NORM_PIXEL(img)` — the current fragment.
 *    Both resolve to `texture2D(img, vUv)`; despite the names, the reference
 *    implementation expands BOTH to the normalised form, because the "pixel"
 *    variant means "the pixel being rendered", not "in pixel units".
 *  - `IMG_SIZE(img)` — the image's size in pixels, `vec2`.
 *
 * `IMG_NORM_THIS_PIXEL` is an alias of `IMG_THIS_NORM_PIXEL`. It is the
 * spelling **docs.isf.video/ref_functions.html actually prints**, while all 104
 * uses in the corpus use the other order — so the documentation and the corpus
 * disagree, and a shader hand-written against the docs would otherwise fail to
 * compile for a reason no error message would explain. Three lines of alias is
 * cheaper than that.
 */
export const ISF_IMAGE_SAMPLERS_GLSL = /* glsl */ `
  vec2 IMG_SIZE(sampler2D image) { return uRes; }
  vec4 IMG_NORM_PIXEL(sampler2D image, vec2 normCoord) { return texture2D(image, normCoord); }
  vec4 IMG_PIXEL(sampler2D image, vec2 pixelCoord) { return texture2D(image, pixelCoord / IMG_SIZE(image)); }
  vec4 IMG_THIS_PIXEL(sampler2D image) { return texture2D(image, vUv); }
  vec4 IMG_THIS_NORM_PIXEL(sampler2D image) { return texture2D(image, vUv); }
  vec4 IMG_NORM_THIS_PIXEL(sampler2D image) { return texture2D(image, vUv); }
`

/**
 * The GLSL prepended to every transpiled FILTER, in place of
 * `SHADER_SCENE_PRELUDE`.
 *
 * Four uniforms and the image functions, and the omissions are the point.
 * `SHADER_SCENE_PRELUDE` carries `uFade`, the five palette slots and eight
 * audio uniforms, and **not one of them means anything to a post-chain pass**:
 * there is no slot to fade, the palette has already been baked into the pixels
 * arriving in `tDiffuse`, and a filter is a look rather than a performer.
 * Prepending it anyway would cost thirteen uniforms nobody writes and, worse,
 * would tempt a filter into honouring `uFade` — which is the OUTGOING scene's
 * crossfade, so the whole show would dim every time the director cut.
 *
 * `uTime` is kept because ISF's `TIME` maps onto it and animated filters (`Bad
 * TV`'s rolling distortion) are most of the interesting ones. `uRes` is kept
 * because `RENDERSIZE` and `IMG_SIZE` both resolve to it.
 */
export const ISF_FILTER_PRELUDE = /* glsl */ `
  precision highp float;
  varying vec2 vUv;

  /** The frame arriving from the previous pass — ISF's \`inputImage\`. */
  uniform sampler2D ${ISF_FILTER_IMAGE_UNIFORM};
  /** Render-buffer resolution in pixels — ISF's \`RENDERSIZE\` and \`IMG_SIZE\`. */
  uniform vec2 uRes;
  /** Seconds since the pass was created — ISF's \`TIME\`. */
  uniform float uTime;
  /** Wet/dry: 0 passes the input through untouched, 1 is the filter at full. */
  uniform float ${ISF_FILTER_MIX_UNIFORM};
${ISF_IMAGE_SAMPLERS_GLSL}`

/** Every name {@link ISF_FILTER_PRELUDE} declares. Derived, never listed. */
export const FILTER_PRELUDE_SYMBOLS: readonly string[] = glslChunkSymbols(ISF_FILTER_PRELUDE)

/**
 * Symbols a transpiled filter body may not declare, by default.
 *
 * The filter prelude and nothing else — **`SHADER_LIB_SYMBOLS` is deliberately
 * absent**, and the asymmetry with {@link RESERVED_SYMBOLS} is load-bearing.
 * A scene may set `include:` and pull `fbm`/`map`/`rot2` in beside its body, so
 * the strict default protects it from a collision it has not caused yet.
 * `IsfFilterPass` has no `include` mechanism at all — the prelude above is the
 * complete list of what gets prepended — so reserving those names would refuse
 * filters carrying their own noise helper (which is most of the glitch
 * category) to prevent a conflict that cannot occur.
 */
export const FILTER_RESERVED_SYMBOLS: readonly string[] = [...FILTER_PRELUDE_SYMBOLS]

/**
 * The five ISF image functions, plus the documentation's alternate spelling.
 *
 * Used to tell "this filter samples its input" from "this filter calls an
 * `IMG_` name we have never heard of" — the second is a spec feature this
 * adapter does not implement, and it has to be a refusal rather than an
 * undefined-function compile error thrown from inside a prewarm.
 */
export const ISF_IMAGE_FUNCTIONS: readonly string[] = [
  'IMG_PIXEL',
  'IMG_NORM_PIXEL',
  'IMG_THIS_PIXEL',
  'IMG_THIS_NORM_PIXEL',
  'IMG_NORM_THIS_PIXEL',
  'IMG_SIZE',
]

/* --------------------------------------------------------- ISF built-ins */

/**
 * ISF built-ins that the prelude already supplies under another name.
 *
 * `gl_FragCoord` is deliberately absent — it needs no rewrite. ISF defines it
 * in pixels of the current pass, and both of `createShaderScene`'s paths agree:
 * the direct path renders at the full buffer size with `uRes` set to it, and
 * the budgeted path sets `target.viewport` to exactly the active rect and
 * `uRes` to the same numbers. `gl_FragCoord / RENDERSIZE` therefore lands where
 * the ISF author expected it in both.
 *
 * `PASSINDEX` becomes the literal `0` rather than a uniform: `parseISF` refuses
 * `PASSES`, so there is exactly one pass and the value is a constant. Emitting
 * a uniform instead would leave a knob whose only legal value is 0.
 */
export const ISF_BUILTIN_SUBSTITUTIONS: Readonly<Record<string, string>> = {
  TIME: 'uTime',
  RENDERSIZE: 'uRes',
  isf_FragNormCoord: 'vUv',
  // The pre-2.0 spelling. Still present across a good part of the corpus, and
  // it means exactly the same thing.
  vv_FragNormCoord: 'vUv',
  PASSINDEX: '0',
}

/** An ISF built-in with no prelude equivalent, so the scene has to feed it. */
export interface IsfBuiltinUniform {
  name: string
  glslType: string
  value: number | number[]
  /** What the scene's `update()` should write into it. */
  note: string
}

/**
 * ISF built-ins that become per-scene uniforms.
 *
 * These three have no prelude equivalent and, unlike `PASSINDEX`, are not
 * constant. They are only declared when the body actually references them —
 * an unused uniform is harmless to the GPU but is a lie in the emitted source,
 * and {@link TranspiledISF.builtinsUsed} is what tells a scene author which
 * ones their `update()` is now obliged to write.
 *
 * `DATE` is here because the ISF spec declares it and the plan for this work
 * did not list it: a shader using it would otherwise reference an undeclared
 * identifier and fail to compile, which is precisely the silent-black-scene
 * outcome the rest of this module exists to prevent.
 */
export const ISF_BUILTIN_UNIFORMS: Readonly<Record<string, IsfBuiltinUniform>> = {
  TIMEDELTA: {
    name: 'uIsfTimeDelta',
    glslType: 'float',
    value: 0,
    note: 'seconds since the previous frame — write `ctx.dt`',
  },
  FRAMEINDEX: {
    name: 'uIsfFrameIndex',
    glslType: 'int',
    value: 0,
    note: 'frames since mount — increment it in `update()`',
  },
  DATE: {
    name: 'uIsfDate',
    glslType: 'vec4',
    value: [0, 0, 0, 0],
    note: 'ISF DATE: [year, month, day, seconds-into-day]',
  },
}

/**
 * ISF type -> GLSL type.
 *
 * `long` is a pop-up menu of integers, so `int`. `event` is a momentary button,
 * which is a `bool` that happens to be true for one frame — the momentariness
 * is the scene's business, not the shader's.
 */
export const ISF_TYPE_TO_GLSL: Readonly<Record<string, string>> = {
  float: 'float',
  bool: 'bool',
  long: 'int',
  point2D: 'vec2',
  color: 'vec4',
  event: 'bool',
}

/** The name the source's `void main` is renamed to, so the fade wrapper can own `main`. */
export const ISF_MAIN = 'isf_main'

/**
 * The wrapper appended to every transpiled shader.
 *
 * Byte-for-byte the shape the plan specifies, and emitted on one line so a test
 * can assert its presence literally rather than by re-deriving whitespace.
 *
 * `.rgb` and not `.rgba`: the engine composites additively and the alpha
 * channel is not what carries a fade here — see `SHADER_SCENE_PRELUDE`'s own
 * note on `uFade` being crossfade x slot gain x mood intensity.
 */
export const ISF_FADE_WRAPPER = `void main() { ${ISF_MAIN}(); gl_FragColor.rgb *= uFade; }`

/**
 * The wrapper appended to every transpiled FILTER, in place of the fade.
 *
 * A wet/dry mix rather than a multiply, because the two do different things and
 * only one of them is right here. `gl_FragColor.rgb *= uFade` on a filter would
 * fade the effect toward BLACK; what a user turning a filter down wants is the
 * frame they had before it, which is `tDiffuse` itself. So this interpolates
 * between the input and the filter's output, and at `${ISF_FILTER_MIX_UNIFORM}`
 * = 0 the pass is an exact pass-through (`IsfFilterPass` still disables itself
 * entirely when no filter is selected — this is the dial, not the off switch).
 *
 * ## The whole vec4, alpha included
 *
 * Mixing `.rgb` only and keeping the filter's alpha was considered and is
 * worse. The case that settles it is `Bump Distortion`, which writes
 * `gl_FragColor = vec4(0.0)` — transparent black — for every fragment whose
 * sample lands outside the image. An `.rgb`-only mix at 0 would leave that
 * alpha of 0 behind on a frame that was otherwise supposed to be untouched, so
 * "dialled fully off" would not be a true pass-through. Mixing the vec4 makes
 * the 0 end exactly the input pixel, alpha and all, which is the only defensible
 * meaning of "off".
 *
 * Carrying the filter's alpha through at the wet end is harmless in this chain:
 * the pass's material has `transparent: false`, so three disables blending and
 * the value is written rather than composited, and `GradePass` — which is
 * always last — emits `vec4(col, 1.0)` regardless. Verified against all five
 * vendored filters; `Bump Distortion` is the only one that writes an alpha
 * other than the source's or 1.0.
 */
export const ISF_FILTER_WRAPPER =
  `void main() { ${ISF_MAIN}(); gl_FragColor = ` +
  `mix(texture2D(${ISF_FILTER_IMAGE_UNIFORM}, vUv), gl_FragColor, ${ISF_FILTER_MIX_UNIFORM}); }`

/* --------------------------------------------------------------- tokenizer */

export type GlslTokenKind = 'ws' | 'comment' | 'ident' | 'number' | 'punct'

export interface GlslToken {
  kind: GlslTokenKind
  text: string
}

const isSpace = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f'
const isDigit = (c: string) => c >= '0' && c <= '9'
const isIdentStart = (c: string) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_'
const isIdentPart = (c: string) => isIdentStart(c) || isDigit(c)

/**
 * Split GLSL into tokens, losslessly — concatenating `text` reproduces the input.
 *
 * This exists because the rename this module performs cannot be done with
 * regexes, and the reasons are worth stating since a word-boundary regex looks
 * like it would work:
 *
 *  - **Comments.** `\bwidth\b` rewrites the word inside `// half the width`,
 *    turning a comment into something that reads as generated slop and, if the
 *    comment happens to sit inside a `/* … *` `/`, is invisible in review.
 *  - **Numbers.** `1.0e5` contains `e5`. An input genuinely named `e5` is
 *    unlikely; an adapter that silently corrupts float literals when one turns
 *    up is not a thing to leave lying around.
 *  - **Field selectors.** `offset.x` and `splitPos.x` both appear in the
 *    Checkerboard fixture. An input named `x` would rewrite the swizzle and
 *    produce `offset.uIsfX`, which is a compile error at best and a different
 *    component at worst.
 *
 * Deliberately NOT a GLSL parser. It classifies characters, nothing more; every
 * consumer below layers its own small amount of structure on top. The one thing
 * it must get exactly right is the lossless round-trip, because the output of
 * this module is source a human will read.
 *
 * Preprocessor directives are tokenized like ordinary code, with `#` as a punct
 * token. That is the useful behaviour rather than a shortcut: `#define SCALE
 * width` should have `width` renamed along with every other use of it.
 */
export function tokenizeGlsl(src: string): GlslToken[] {
  const out: GlslToken[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]

    if (isSpace(c)) {
      const start = i
      while (i < src.length && isSpace(src[i])) i++
      out.push({ kind: 'ws', text: src.slice(start, i) })
      continue
    }

    if (c === '/' && src[i + 1] === '/') {
      const start = i
      while (i < src.length && src[i] !== '\n') i++
      out.push({ kind: 'comment', text: src.slice(start, i) })
      continue
    }

    if (c === '/' && src[i + 1] === '*') {
      const start = i
      const end = src.indexOf('*/', i + 2)
      i = end < 0 ? src.length : end + 2
      out.push({ kind: 'comment', text: src.slice(start, i) })
      continue
    }

    // A number swallows its own exponent, so `1.0e5` never offers `e5` as an
    // identifier. The leading-dot form (`.5`) is a number too.
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1]))) {
      const start = i
      while (i < src.length && (isDigit(src[i]) || src[i] === '.')) i++
      if (src[i] === 'e' || src[i] === 'E') {
        const mark = i
        i++
        if (src[i] === '+' || src[i] === '-') i++
        if (isDigit(src[i])) while (i < src.length && isDigit(src[i])) i++
        else i = mark // a bare trailing `e` is an identifier, not an exponent
      }
      // GLSL ES 3.00 integer suffixes; harmless to accept in 1.00 source.
      if (src[i] === 'u' || src[i] === 'U') i++
      out.push({ kind: 'number', text: src.slice(start, i) })
      continue
    }

    if (isIdentStart(c)) {
      const start = i
      while (i < src.length && isIdentPart(src[i])) i++
      out.push({ kind: 'ident', text: src.slice(start, i) })
      continue
    }

    out.push({ kind: 'punct', text: c })
    i++
  }
  return out
}

/* --------------------------------------------------- declaration detection */

/**
 * Qualifiers that may precede a type in a declaration.
 *
 * `precision` is in the list so `precision highp float;` does not look like a
 * `highp float` declaration named `float`.
 */
const QUALIFIERS = new Set([
  'const',
  'uniform',
  'varying',
  'attribute',
  'in',
  'out',
  'inout',
  'highp',
  'mediump',
  'lowp',
  'precision',
  'invariant',
  'flat',
  'smooth',
  'centroid',
])

/**
 * Names declared at file scope: functions, prototypes, globals, struct types.
 *
 * A detector, not a parser, and the asymmetry is deliberate. A false negative
 * costs nothing new — the name simply reaches the GLSL compiler, which reports
 * the redefinition itself. A false positive refuses a shader that would have
 * worked, which is a curator chasing a phantom. So every branch here only fires
 * on a shape that is unambiguously a declaration, and anything it cannot read
 * is skipped rather than guessed at.
 *
 * Depth tracking is what confines it to file scope: parameters, locals and
 * struct members all sit inside brackets of some kind and are never counted.
 */
export function topLevelDeclarations(tokens: readonly GlslToken[]): string[] {
  const sig = tokens.filter((t) => t.kind !== 'ws' && t.kind !== 'comment')
  const names: string[] = []
  let brace = 0
  let paren = 0
  let bracket = 0

  for (let i = 0; i < sig.length; i++) {
    const t = sig[i]

    if (t.kind === 'punct') {
      if (t.text === '{') brace++
      else if (t.text === '}') brace = Math.max(0, brace - 1)
      else if (t.text === '(') paren++
      else if (t.text === ')') paren = Math.max(0, paren - 1)
      else if (t.text === '[') bracket++
      else if (t.text === ']') bracket = Math.max(0, bracket - 1)
      continue
    }
    if (brace > 0 || paren > 0 || bracket > 0) continue
    if (t.kind !== 'ident') continue

    if (t.text === 'struct') {
      const named = sig[i + 1]
      if (named && named.kind === 'ident') {
        names.push(named.text)
        i++
      }
      continue
    }
    if (QUALIFIERS.has(t.text)) continue

    // `t` is standing in for a type; a declaration needs an identifier after it.
    const named = sig[i + 1]
    if (!named || named.kind !== 'ident' || QUALIFIERS.has(named.text)) continue
    const after = sig[i + 2]
    if (!after || after.kind !== 'punct') continue

    if (after.text === '(') {
      names.push(named.text)
      // Advance to the name only, so the `(` is still seen by the punct branch
      // and the parameter list is skipped by depth rather than by luck.
      i += 1
      continue
    }

    if (after.text === ';' || after.text === '=' || after.text === ',' || after.text === '[') {
      names.push(named.text)
      // `float a, b = f(1, 2), c;` — every name in one declaration statement.
      // The nested depth counter is what keeps the comma inside `f(1, 2)` from
      // being read as another declarator.
      let j = i + 2
      let depth = 0
      for (; j < sig.length; j++) {
        const s = sig[j]
        if (s.kind !== 'punct') continue
        if (s.text === '(' || s.text === '[' || s.text === '{') depth++
        else if (s.text === ')' || s.text === ']' || s.text === '}') depth--
        else if (depth <= 0 && s.text === ';') break
        else if (depth <= 0 && s.text === ',') {
          const more = sig[j + 1]
          if (more && more.kind === 'ident') {
            names.push(more.text)
            j++
          }
        }
      }
      i = j
      continue
    }
  }
  return names
}

/* ---------------------------------------------------------------- transpile */

/** One uniform the generated shader declares and the scene must create. */
export interface IsfUniformDecl {
  /** The `uIsf`-prefixed GLSL name. */
  name: string
  glslType: string
  /** The ISF input it came from, or undefined for a built-in-backed uniform. */
  input?: IsfInput
  /**
   * Initial value in a plain-JS shape.
   *
   * Arrays rather than `THREE.Vector2`/`Vector4`, which keeps this module free
   * of a three import. That is not a compromise: `WebGLUniforms` accepts a
   * plain array for any vector uniform (it branches on `v.x === undefined` and
   * falls through to `uniformNfv`), so the arrays below can be handed straight
   * to `createShaderScene`'s `uniforms` factory.
   */
  value: number | boolean | number[]
}

export interface TranspiledISF {
  /** Which runtime this was emitted for — see {@link TranspileIsfOptions.kind}. */
  kind: IsfKind
  /**
   * The fragment shader body.
   *
   * Ready for `ShaderSceneSpec.frag` (generator), or for `IsfFilterPass`
   * (filter). In BOTH cases the prelude is NOT included: the consumer prepends
   * it, exactly as `createShaderScene` prepends `SHADER_SCENE_PRELUDE` today.
   */
  frag: string
  /** Every uniform `frag` declares, in emission order. */
  uniforms: IsfUniformDecl[]
  /** ISF input NAME -> the uniform it became. */
  uniformNames: Readonly<Record<string, string>>
  /**
   * ISF built-ins the body actually used and the scene's `update()` therefore
   * has to write. Empty for most shaders.
   */
  builtinsUsed: readonly string[]
}

export interface TranspileIsfOptions {
  /** Filename or URL, used to prefix every error and to head the emitted source. */
  origin?: string
  /**
   * Which runtime to emit for. Defaults to `'generator'`.
   *
   * Must match the `kind` the file was parsed with — a filter parsed as a
   * generator never gets past `parseISF`, and a generator transpiled as a
   * filter would be wrapped in a wet/dry mix against a texture it never reads.
   */
  kind?: IsfKind
  /**
   * Symbols the transpiled body may not declare. Defaults to
   * {@link RESERVED_SYMBOLS} for a generator and
   * {@link FILTER_RESERVED_SYMBOLS} for a filter.
   *
   * Pass {@link PRELUDE_SYMBOLS} alone for a scene that is certain never to set
   * `include:`, which lets an ISF shader keep its own `fbm`/`rot2`/`map`. That
   * is a real and common case, and it is an argument rather than the default
   * for the reason spelled out on {@link RESERVED_SYMBOLS}.
   */
  reserved?: Iterable<string>
}

/**
 * `width` -> `uIsfWidth`.
 *
 * The `u` prefix is this repo's uniform convention; the `Isf` infix is what
 * makes the mapping collision-proof by construction rather than by luck. Two
 * ISF inputs cannot produce the same uniform, because `parseISF` already
 * refuses a duplicate NAME and this transform only touches the first character.
 */
export function isfUniformName(isfName: string): string {
  return `uIsf${isfName.charAt(0).toUpperCase()}${isfName.slice(1)}`
}

/** The value a uniform starts at, from the input's DEFAULT or a typed zero. */
function seedValue(input: IsfInput): number | boolean | number[] {
  if (input.default !== undefined) return input.default
  switch (input.type) {
    case 'bool':
    case 'event':
      return false
    case 'point2D':
      return [0, 0]
    case 'color':
      // Opaque black rather than [0,0,0,0]: a scene whose colour input was
      // never written should read as unlit, not as fully transparent.
      return [0, 0, 0, 1]
    case 'long':
      return input.values?.[0] ?? 0
    default:
      return 0
  }
}

/** A one-line comment describing an input, for the emitted uniform block. */
function describeInput(input: IsfInput): string {
  const bits = [`ISF ${input.type}`]
  if (input.label) bits.push(`"${input.label}"`)
  if (input.default !== undefined) bits.push(`DEFAULT ${JSON.stringify(input.default)}`)
  if (input.min !== undefined && input.max !== undefined) {
    bits.push(`${JSON.stringify(input.min)}..${JSON.stringify(input.max)}`)
  }
  return bits.join(', ')
}

/** Turn a parsed ISF file into prelude-compatible GLSL, or throw explaining why not. */
export function transpileISF(parsed: ParsedISF, opts: TranspileIsfOptions = {}): TranspiledISF {
  const origin = opts.origin
  const kind: IsfKind = opts.kind ?? 'generator'
  const isFilter = kind === 'filter'
  const reserved = new Set(opts.reserved ?? (isFilter ? FILTER_RESERVED_SYMBOLS : RESERVED_SYMBOLS))
  const tokens = tokenizeGlsl(parsed.glsl)

  // On the SCENE path an `IMG_` name can only be reaching for an `image` input
  // or an `IMPORTED` buffer, and `parseISF` refused both. Left alone it would
  // reference an undeclared function, so this is only ever a clearer version of
  // an error that was going to happen anyway — but it names the cause.
  //
  // On the FILTER path the five real ones are implemented by
  // ISF_IMAGE_SAMPLERS_GLSL and pass straight through; anything else is a spec
  // feature this adapter does not have, and has to be refused here rather than
  // becoming an undefined-function error inside a prewarm.
  for (const t of tokens) {
    if (t.kind !== 'ident' || !t.text.startsWith('IMG_')) continue
    if (isFilter && ISF_IMAGE_FUNCTIONS.includes(t.text)) continue
    throw new IsfImportError(
      isFilter
        ? `calls \`${t.text}\`, which is not one of ISF's image functions ` +
            `(${ISF_IMAGE_FUNCTIONS.join(', ')}). This adapter implements those ` +
            'and nothing else, so the name would reach GLSL undefined.'
        : `uses the ISF image built-in \`${t.text}\`, but declares no image ` +
            'input for it to read. Image sampling is out of scope on the scene ' +
            'path; this shader is a filter — transpile it with `kind: "filter"`.',
      origin,
    )
  }

  /* --- build the rename table ------------------------------------------- */

  const subs = new Map<string, string>(Object.entries(ISF_BUILTIN_SUBSTITUTIONS))
  for (const [isfName, u] of Object.entries(ISF_BUILTIN_UNIFORMS)) subs.set(isfName, u.name)
  // The source's entry point steps aside so the fade wrapper can own `main`.
  subs.set('main', ISF_MAIN)

  const uniformNames: Record<string, string> = {}
  for (const input of parsed.header.inputs) {
    if (subs.has(input.name)) {
      // ISF reserves its own built-in names (and `main`), so this is a
      // malformed file rather than a naming clash to resolve. Renaming it
      // anyway would either shadow the built-in or silently drop the input,
      // and both of those compile.
      throw new IsfImportError(
        `input "${input.name}" shadows the ISF built-in (or entry point) of ` +
          'the same name, which ISF does not permit.',
        origin,
      )
    }
    if (input.type === 'image') {
      // Filter mode only — `parseISF` refuses an image input on the scene path,
      // and refuses any name but `inputImage` here. No uniform is generated:
      // ISF_FILTER_PRELUDE declares `tDiffuse` and IsfFilterPass binds it from
      // the composer's input buffer, so the input is SATISFIED rather than
      // exposed as a knob nobody could turn.
      uniformNames[input.name] = ISF_FILTER_IMAGE_UNIFORM
      subs.set(input.name, ISF_FILTER_IMAGE_UNIFORM)
      continue
    }

    const glslType = ISF_TYPE_TO_GLSL[input.type]
    if (!glslType) {
      // Unreachable through parseISF, which refuses every type without a
      // mapping. Kept because this function is exported and can be called with
      // a hand-built header.
      throw new IsfImportError(
        `input "${input.name}" has type "${input.type}", which has no GLSL ` +
          'equivalent on the scene path.',
        origin,
      )
    }
    const name = isfUniformName(input.name)
    if (reserved.has(name)) {
      throw new IsfImportError(collisionMessage(name, `input "${input.name}"`, kind), origin)
    }
    uniformNames[input.name] = name
    subs.set(input.name, name)
  }

  /* --- rewrite ----------------------------------------------------------- */

  const usedBuiltins = new Set<string>()
  const body = rewrite(tokens, subs, usedBuiltins)

  const declared = topLevelDeclarations(tokenizeGlsl(body))
  if (!declared.includes(ISF_MAIN)) {
    throw new IsfImportError(
      'has no `void main()`. Every ISF shader needs one; a file without it is ' +
        'a fragment of one, or the entry point is hidden behind a macro this ' +
        'adapter does not expand.',
      origin,
    )
  }
  const emitted = new Set(Object.values(uniformNames))
  for (const name of declared) {
    if (reserved.has(name)) {
      throw new IsfImportError(collisionMessage(name, 'the shader', kind), origin)
    }
    if (emitted.has(name)) {
      throw new IsfImportError(
        `declares "${name}" at file scope, which is also the uniform generated ` +
          `for one of its own ISF inputs.`,
        origin,
      )
    }
  }

  /* --- emit -------------------------------------------------------------- */

  const uniforms: IsfUniformDecl[] = []
  const lines: string[] = []
  lines.push(
    `// Transpiled from ISF${origin ? ` (${origin})` : ''} as a ${kind} ` +
      'by engine/isf/transpileISF.ts.',
  )
  if (parsed.header.credit) lines.push(`// CREDIT: ${oneLine(parsed.header.credit)}`)
  if (parsed.header.description) lines.push(`// ${oneLine(parsed.header.description)}`)

  for (const input of parsed.header.inputs) {
    const name = uniformNames[input.name]
    if (input.type === 'image') {
      // A comment rather than a uniform: the prelude already declares this one.
      lines.push(`// ${input.name} (ISF image) -> ${name}, declared by ISF_FILTER_PRELUDE`)
      continue
    }
    const glslType = ISF_TYPE_TO_GLSL[input.type]
    uniforms.push({ name, glslType, input, value: seedValue(input) })
    lines.push(`uniform ${glslType} ${name}; // ${input.name} (${describeInput(input)})`)
  }

  const builtinsUsed: string[] = []
  for (const [isfName, u] of Object.entries(ISF_BUILTIN_UNIFORMS)) {
    if (!usedBuiltins.has(isfName)) continue
    builtinsUsed.push(isfName)
    uniforms.push({ name: u.name, glslType: u.glslType, value: u.value })
    lines.push(`uniform ${u.glslType} ${u.name}; // ${isfName} — ${u.note}`)
  }

  // No prelude uniform is ever redeclared here: `uTime`, `uRes` and the rest
  // arrive with SHADER_SCENE_PRELUDE (or ISF_FILTER_PRELUDE), which the
  // consumer prepends, and a second declaration of any of them is a GLSL error
  // rather than a shadow.
  const wrapper = isFilter ? ISF_FILTER_WRAPPER : ISF_FADE_WRAPPER
  const frag = `${lines.join('\n')}\n${body}\n\n${wrapper}\n`

  return { kind, frag, uniforms, uniformNames, builtinsUsed }
}

/**
 * Uniform seeds in the shape `ShaderSceneSpec.uniforms` wants.
 *
 * A factory result rather than a shared object, matching the contract that
 * field states: two instances of one scene must not share a uniform object, or
 * a scene mounted in two slots writes over itself.
 */
export function isfUniformSeed(t: TranspiledISF): Record<string, { value: unknown }> {
  const out: Record<string, { value: unknown }> = {}
  for (const u of t.uniforms) {
    out[u.name] = { value: Array.isArray(u.value) ? [...u.value] : u.value }
  }
  return out
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function collisionMessage(name: string, what: string, kind: IsfKind): string {
  if (kind === 'filter') {
    if (ISF_IMAGE_FUNCTIONS.includes(name)) {
      return (
        `${what} collides with "${name}", one of ISF's own image functions — ` +
        'ISF_IMAGE_SAMPLERS_GLSL implements it, so a body redefining it is a ' +
        'GLSL redefinition error. A filter that ships its own IMG_ helper is ' +
        'not something to work around; it means this file was written for a ' +
        'host that does not provide them, and it needs a look before importing.'
      )
    }
    return (
      `${what} collides with "${name}", declared by ISF_FILTER_PRELUDE. The ` +
      'filter prelude is prepended to every transpiled filter unconditionally, ' +
      'so this is a GLSL redeclaration error that would surface as a post pass ' +
      'drawing nothing. Rename it in the source .fs before importing.'
    )
  }
  if (PRELUDE_SYMBOLS.includes(name)) {
    return (
      `${what} collides with "${name}", declared by SHADER_SCENE_PRELUDE. The ` +
      'prelude is prepended to every scene unconditionally, so this is a GLSL ' +
      'redeclaration error that would surface as a scene rendering nothing. ' +
      'Rename it in the source .fs before importing.'
    )
  }
  if (SHADER_LIB_SYMBOLS.includes(name)) {
    return (
      `${what} collides with "${name}", declared by a shared GLSL chunk in ` +
      'engine/shaderLib.ts or engine/glsl.ts. That only actually conflicts when ' +
      'the scene sets `include:` — if this one never will, pass ' +
      '`{ reserved: PRELUDE_SYMBOLS }` to transpileISF rather than editing the ' +
      'source.'
    )
  }
  return `${what} collides with the reserved symbol "${name}".`
}

/**
 * Apply the rename table across a token stream.
 *
 * Two positions are skipped, and both are cases where an identifier is not
 * naming the thing it looks like it is naming:
 *
 *  - **After a `.`** — a field selector or swizzle. A `.` only ever survives
 *    tokenization as punct when it is one of those, because the number scanner
 *    consumes the dot in `1.0` and `.5` before this ever sees it.
 *  - **Inside a `struct { … }` body** — a member declaration. Renaming the
 *    member but not the `s.member` uses that reference it (which are field
 *    selectors, and skipped) would split one name into two.
 *
 * Everything else is renamed unconditionally, including local variables that
 * happen to share an input's name. That is not a hazard but a property: a
 * consistent rename of every occurrence of an identifier preserves scoping
 * exactly, so a local `float width` simply becomes a local `float uIsfWidth`
 * that shadows the uniform in the same places it shadowed the input before.
 */
function rewrite(
  tokens: readonly GlslToken[],
  subs: ReadonlyMap<string, string>,
  usedBuiltins: Set<string>,
): string {
  let out = ''
  let brace = 0
  let structPending = false
  let structBrace = -1
  let prevSig: GlslToken | undefined

  for (const tok of tokens) {
    if (tok.kind === 'ws' || tok.kind === 'comment') {
      out += tok.text
      continue
    }

    if (tok.kind === 'punct') {
      if (tok.text === '{') {
        brace++
        if (structPending) {
          structBrace = brace
          structPending = false
        }
      } else if (tok.text === '}') {
        if (structBrace === brace) structBrace = -1
        brace = Math.max(0, brace - 1)
      } else if (tok.text === ';') {
        structPending = false
      }
      out += tok.text
      prevSig = tok
      continue
    }

    if (tok.kind === 'ident') {
      if (tok.text === 'struct') structPending = true
      const isField = prevSig?.kind === 'punct' && prevSig.text === '.'
      const inStructBody = structBrace >= 0
      const sub = isField || inStructBody ? undefined : subs.get(tok.text)
      if (sub !== undefined) {
        // `Object.hasOwn`, not `in`: `in` walks the prototype chain, so a
        // shader with an identifier called `constructor` or `toString` would
        // otherwise be recorded as having used an ISF built-in.
        if (Object.hasOwn(ISF_BUILTIN_UNIFORMS, tok.text)) usedBuiltins.add(tok.text)
        out += sub
        prevSig = tok
        continue
      }
    }

    out += tok.text
    prevSig = tok
  }
  return out
}
