/**
 * ISF header parsing — the gate a third-party `.fs` file passes through before
 * anything in this engine sees it.
 *
 * An ISF file is a leading `/*` … `*` `/` block comment holding JSON, followed
 * by GLSL ES 1.00. The JSON declares the shader's inputs, and this module's
 * whole job is to turn that declaration into a typed structure, or to REFUSE.
 *
 * ## Why refusal is the important half
 *
 * The corpus this feeds on (`Vidvox/ISF-Files`, MIT, 327 shaders) is not
 * uniform. Measured on a 25% sample: 21% use `PASSES` (multi-pass), 60% take an
 * `image` input, 2% declare audio inputs. Only the remainder are single-pass
 * generators — the thing this engine's `createShaderScene` can actually run.
 *
 * Every one of those three shapes fails SILENTLY if imported anyway. A
 * multi-pass shader still compiles as a single pass; it just renders the first
 * link of a chain and looks like a broken version of itself. A filter with no
 * source image samples an unbound sampler, which is legal GLSL returning black.
 * An audio input becomes a uniform nobody writes, which reads as a dead shader
 * that happens to draw something. None of these throw, none log, and all three
 * produce a scene that is *plausible enough to ship and wrong*.
 *
 * So the posture is: a loud refusal at import time, naming the key and what to
 * do about it, beats any amount of partial success. Everything this module
 * rejects is rejected because the failure it prevents is invisible.
 *
 * ## The filter mode, added for Track C
 *
 * The 60% figure above is the whole reason `kind: 'filter'` exists: 207 of the
 * 327 files in the corpus take an image, and they are MIT post-effects (Bad TV,
 * halftones, bump distortion, glitch) rather than scenes. They run on
 * `IsfFilterPass`, which does have a frame to give them — the composited image
 * arriving in the post chain — so on that path an image input is not a missing
 * dependency but the entire point.
 *
 * What does NOT change in filter mode is everything else. `PASSES`, `IMPORTED`
 * and audio inputs are refused identically, a second image input is refused,
 * and an image under any name but {@link ISF_FILTER_IMAGE_INPUT} is refused —
 * see that constant for why a transition's `startImage`/`endImage` must not be
 * quietly accepted as "the input". The mode widens exactly one hole and leaves
 * the rest of the gate intact, so a batch importer can still tell "skip this
 * one" from "the adapter is broken".
 *
 * Pure and dependency-free on purpose — the same separation
 * `bench/sceneProfile.ts` keeps from the renderer, for the same reason: the
 * interesting cases are malformed headers, and those are far easier to
 * construct as strings in a test than to obtain by finding a real shader that
 * happens to be broken.
 */

/**
 * Every `TYPE` the ISF spec defines for an `INPUTS` entry.
 *
 * Listed in full — including the two this engine always refuses and the one
 * (`image`) it accepts only in filter mode — because an unrecognised type and a
 * recognised-but-unsupported type need different error messages. "ISF type `image` is a filter input, out of scope" tells a curator
 * to pick a different shader; "unknown ISF type `imgae`" tells them the file is
 * malformed. Collapsing both into "unsupported" loses that distinction, and the
 * curator is the one person who can act on it.
 */
export const ISF_INPUT_TYPES = [
  'event',
  'bool',
  'long',
  'float',
  'point2D',
  'color',
  'image',
  'audio',
  'audioFFT',
] as const

export type IsfInputType = (typeof ISF_INPUT_TYPES)[number]

/** The types this wave can actually drive from a `createShaderScene` uniform. */
export const SUPPORTED_INPUT_TYPES: readonly IsfInputType[] = [
  'event',
  'bool',
  'long',
  'float',
  'point2D',
  'color',
]

/**
 * One `INPUTS` entry, normalised.
 *
 * Field names are lowerCamel rather than the source's SCREAMING keys: past this
 * boundary the data is ours, and carrying the wire format's casing into every
 * consumer is how a parser stops being a boundary. `raw` keeps the original
 * object for anything a later wave needs and this one does not model.
 */
export interface IsfInput {
  /** ISF `NAME` — a bare GLSL identifier in the source shader. */
  name: string
  type: IsfInputType
  /** ISF `LABEL`: the human-facing name, when the author supplied one. */
  label?: string
  /**
   * ISF `DEFAULT`, in the shape the type implies: a number for `float`/`long`,
   * a boolean for `bool`/`event`, `[x, y]` for `point2D`, `[r, g, b, a]` for
   * `color`. Absent when the author declared none — which is common across the
   * corpus and is NOT an error; see `resolveRange` in ./isfContract.ts for what
   * is done about it.
   */
  default?: number | boolean | number[]
  min?: number | number[]
  max?: number | number[]
  /** `long` only: the integer emitted for each menu entry. */
  values?: number[]
  /** `long` only: the menu entry captions, parallel to {@link values}. */
  labels?: string[]
  /** The unmodified source object, for keys this interface does not model. */
  raw: Readonly<Record<string, unknown>>
}

/** The parsed JSON header, normalised. */
export interface IsfHeader {
  /** ISF spec version the file declares (`"2"` for most of the corpus). */
  isfvsn?: string
  /** The file's OWN version, unrelated to {@link isfvsn}. */
  vsn?: string
  description?: string
  /** ISF `CREDIT` — the attribution string that belongs in `provenance.author`. */
  credit?: string
  categories: string[]
  inputs: IsfInput[]
  /** The unmodified parsed header, for keys this interface does not model. */
  raw: Readonly<Record<string, unknown>>
}

export interface ParsedISF {
  header: IsfHeader
  /**
   * The GLSL body.
   *
   * The header comment is replaced by an equal number of newlines rather than
   * removed, so **line N of `glsl` is line N of the source file**. A GLSL
   * compile error is the only diagnostic a shader gives you, it arrives as a
   * line number, and there is no source map — so keeping that one number
   * meaningful costs a `repeat()` and is worth more than the blank lines cost.
   */
  glsl: string
}

/**
 * A refusal, with the file it came from.
 *
 * A distinct class rather than a plain `Error` so a batch importer can tell
 * "this shader is out of scope" (skip it, keep going — that is most of the
 * corpus) from "the adapter has a bug" (stop).
 */
export class IsfImportError extends Error {
  override readonly name: string = 'IsfImportError'
  /** The `origin` passed to the parser — normally the source filename. */
  readonly origin?: string

  constructor(message: string, origin?: string) {
    super(origin ? `${origin}: ${message}` : message)
    this.origin = origin
  }
}

/**
 * Which of the two ISF shapes this engine can run a file is being read as.
 *
 * Not a property of the file — a `.fs` with an `inputImage` is a filter whether
 * or not anyone asked — but a property of the CALLER, and that is the point.
 * The scene path (`createShaderScene`) has nothing to feed an image input and
 * the filter path (`IsfFilterPass`) has no palette or `uFade`, so the same file
 * is legal on one and a silent black screen on the other. Making the caller
 * state which runtime it is importing for turns that into a refusal at import
 * time rather than a picture nobody can explain.
 *
 * `'generator'` is the default so every pre-filter caller keeps its exact
 * behaviour, including the "this is a FILTER, not a scene" refusal.
 */
export type IsfKind = 'generator' | 'filter'

/**
 * The ISF `NAME` a filter's source image is required to use.
 *
 * The spec does not mandate it, but `Vidvox/ISF-Files` is unanimous: all 207
 * filters in the corpus name their source `inputImage`, and every ISF host
 * treats an input of that name as the one the compositor connects upstream to.
 * Pinning it is what lets {@link IsfKind} `'filter'` mean one specific thing —
 * exactly one image, mapped onto the composer's `tDiffuse` — instead of "some
 * unknown number of textures the engine would have to find sources for".
 *
 * A filter whose image is named something else is refused rather than guessed
 * at, because the guess ("the only image input is the source") is wrong for the
 * shape it would most often hit: a transition, whose two images are `startImage`
 * and `endImage` and neither of which is "the input".
 */
export const ISF_FILTER_IMAGE_INPUT = 'inputImage'

export interface ParseIsfOptions {
  /** Filename or URL, used to prefix every error. Strongly recommended. */
  origin?: string
  /**
   * Which runtime this file is being imported for. Defaults to `'generator'`.
   *
   * `'filter'` permits — and REQUIRES — exactly one image input named
   * {@link ISF_FILTER_IMAGE_INPUT}. Everything else the generator path refuses
   * is still refused: `PASSES`, `IMPORTED`, audio inputs, and any second image.
   */
  kind?: IsfKind
}

/** GLSL identifiers, which is what an ISF `NAME` has to be to appear in code. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Split the leading JSON comment from the GLSL body.
 *
 * Exported separately from {@link parseISF} because the split and the schema
 * validation fail for completely different reasons, and a caller diagnosing one
 * should not have to reason about the other.
 *
 * Leading whitespace and `//` line comments are skipped before the block
 * comment. The spec puts the JSON blob first, full stop, but a hand-edited file
 * with a `// from https://…` line above it is otherwise perfectly good ISF, and
 * refusing it teaches a curator nothing.
 *
 * The comment ends at the FIRST closing delimiter, which is technically
 * defeatable by a JSON string containing that sequence. Nothing in the corpus
 * does it, GLSL itself cannot nest block comments either, and the alternative —
 * tracking JSON string state before the JSON has been parsed — is a second
 * parser to maintain for a case that does not occur.
 */
export function splitIsfHeader(
  source: string,
  opts: ParseIsfOptions = {},
): { json: string; glsl: string } {
  let i = source.charCodeAt(0) === 0xfeff ? 1 : 0
  for (;;) {
    while (i < source.length && /\s/.test(source[i])) i++
    if (!source.startsWith('//', i)) break
    const nl = source.indexOf('\n', i)
    if (nl < 0) {
      i = source.length
      break
    }
    i = nl + 1
  }

  if (!source.startsWith('/*', i)) {
    throw new IsfImportError(
      'no ISF header found. An ISF file must open with a JSON block comment ' +
        'declaring its INPUTS; a bare .frag/.glsl file is not ISF.',
      opts.origin,
    )
  }
  const end = source.indexOf('*/', i + 2)
  if (end < 0) {
    throw new IsfImportError(
      'the ISF header comment is never closed — no block-comment terminator ' +
        'after the opening delimiter.',
      opts.origin,
    )
  }

  const consumed = source.slice(0, end + 2)
  let newlines = 0
  for (let k = 0; k < consumed.length; k++) if (consumed.charCodeAt(k) === 10) newlines++
  return {
    json: source.slice(i + 2, end),
    // See ParsedISF.glsl: blanks stand in for the header so line numbers survive.
    glsl: '\n'.repeat(newlines) + source.slice(end + 2),
  }
}

/** Parse an ISF file, or throw {@link IsfImportError} explaining why not. */
export function parseISF(source: string, opts: ParseIsfOptions = {}): ParsedISF {
  const { json, glsl } = splitIsfHeader(source, opts)

  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (e) {
    throw new IsfImportError(
      `the ISF header is not valid JSON (${e instanceof Error ? e.message : String(e)}). ` +
        'JSON allows no trailing commas and no comments.',
      opts.origin,
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new IsfImportError('the ISF header must be a JSON object.', opts.origin)
  }
  const raw = parsed as Record<string, unknown>

  // --- the out-of-scope shapes, refused before anything else ----------------
  //
  // Checked first and on key presence alone, so the message names the actual
  // reason rather than whatever downstream symptom happens to surface first.

  if (raw.PASSES !== undefined) {
    throw new IsfImportError(
      'declares PASSES (multi-pass). Multi-pass ISF needs the render-target ' +
        'ownership this engine does not have yet, and rendering only the first ' +
        'pass would look like a broken version of the shader rather than an ' +
        'error. Pick a single-pass generator instead.',
      opts.origin,
    )
  }
  if (raw.IMPORTED !== undefined) {
    throw new IsfImportError(
      'declares IMPORTED (bundled image files). There is no texture loader on ' +
        'this path, so every image lookup would sample an unbound sampler and ' +
        'silently return black.',
      opts.origin,
    )
  }

  const header: IsfHeader = {
    isfvsn: optionalString(raw.ISFVSN, 'ISFVSN', opts),
    vsn: optionalString(raw.VSN, 'VSN', opts),
    description: optionalString(raw.DESCRIPTION, 'DESCRIPTION', opts),
    credit: optionalString(raw.CREDIT, 'CREDIT', opts),
    categories: parseCategories(raw.CATEGORIES, opts),
    inputs: parseInputs(raw.INPUTS, opts),
    raw,
  }

  // A filter with no source image is not a filter; it is a generator that has
  // been handed to the wrong runtime. Checked AFTER the inputs are parsed so a
  // malformed INPUTS entry still reports its own fault first — "input 3 has an
  // unknown TYPE" is actionable, "this shader declares no inputImage" when the
  // reason is a typo in the type is not.
  if (opts.kind === 'filter' && !imageInputs(header).some((i) => i === ISF_FILTER_IMAGE_INPUT)) {
    throw new IsfImportError(
      `was imported as a filter but declares no image input named ` +
        `"${ISF_FILTER_IMAGE_INPUT}". A filter reads the frame it is given; a ` +
        'shader with nothing to read is a generator, and belongs on the scene ' +
        'path (parseISF with no `kind`, or `kind: "generator"`).',
      opts.origin,
    )
  }
  return { header, glsl }
}

/** Every image input's NAME, in declaration order. */
function imageInputs(header: IsfHeader): string[] {
  return header.inputs.filter((i) => i.type === 'image').map((i) => i.name)
}

/**
 * ISF numbers arrive as JSON numbers, but a few corpus files write `"0.25"`.
 * Accepting the string form costs one branch and avoids a refusal that teaches
 * a curator nothing about the shader they picked.
 */
function num(v: unknown): number | undefined {
  if (typeof v === 'number' && isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    if (isFinite(n)) return n
  }
  return undefined
}

function optionalString(v: unknown, key: string, opts: ParseIsfOptions): string | undefined {
  if (v === undefined || v === null) return undefined
  // Numbers are tolerated because `"ISFVSN": 2` appears in the wild — the spec
  // says string, the corpus does not always agree, and the value is metadata
  // that nothing downstream computes on.
  if (typeof v === 'number') return String(v)
  if (typeof v !== 'string') {
    throw new IsfImportError(`header key ${key} must be a string.`, opts.origin)
  }
  return v
}

function parseCategories(v: unknown, opts: ParseIsfOptions): string[] {
  if (v === undefined || v === null) return []
  if (typeof v === 'string') return [v]
  if (!Array.isArray(v) || v.some((c) => typeof c !== 'string')) {
    throw new IsfImportError('header key CATEGORIES must be an array of strings.', opts.origin)
  }
  return v as string[]
}

function parseInputs(v: unknown, opts: ParseIsfOptions): IsfInput[] {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) {
    throw new IsfImportError('header key INPUTS must be an array.', opts.origin)
  }

  const out: IsfInput[] = []
  const seen = new Set<string>()
  /** NAME of the image input already accepted, in filter mode. */
  let seenImage: string | undefined
  for (let i = 0; i < v.length; i++) {
    const entry = v[i]
    const at = `INPUTS[${i}]`
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new IsfImportError(`${at} must be an object.`, opts.origin)
    }
    const e = entry as Record<string, unknown>

    const name = e.NAME
    if (typeof name !== 'string' || !IDENTIFIER.test(name)) {
      throw new IsfImportError(
        `${at} has NAME ${JSON.stringify(name)}; it must be a bare GLSL ` +
          'identifier, because the shader body references it as one.',
        opts.origin,
      )
    }
    if (seen.has(name)) {
      // Two inputs of the same name collapse onto one uniform, so one of the
      // two knobs would silently do nothing.
      throw new IsfImportError(`${at} redeclares input "${name}".`, opts.origin)
    }
    seen.add(name)

    const type = e.TYPE
    if (typeof type !== 'string' || !(ISF_INPUT_TYPES as readonly string[]).includes(type)) {
      throw new IsfImportError(
        `input "${name}" has unknown TYPE ${JSON.stringify(type)}; the ISF ` +
          `types are ${ISF_INPUT_TYPES.join(', ')}.`,
        opts.origin,
      )
    }
    const t = type as IsfInputType

    if (t === 'image') {
      if (opts.kind !== 'filter') {
        throw new IsfImportError(
          `input "${name}" is TYPE "image" — this is a FILTER, not a scene. It ` +
            'needs a source image to process (about 60% of the ISF corpus does), ' +
            'and there is nothing to feed it on the scene path. Import it with ' +
            '`{ kind: "filter" }` and run it through IsfFilterPass instead.',
          opts.origin,
        )
      }
      if (name !== ISF_FILTER_IMAGE_INPUT) {
        // Not "unsupported yet" — wrong shape. An image input under any other
        // name is a transition (`startImage`/`endImage`) or a compositor with
        // two sources, and neither has one obvious thing to bind to the post
        // chain's single upstream frame. Picking one anyway would render half
        // the effect against black and look like a bug in the shader.
        throw new IsfImportError(
          `input "${name}" is TYPE "image", but a filter's source image must be ` +
            `named "${ISF_FILTER_IMAGE_INPUT}" — that is the one input the post ` +
            'chain can bind, because it is the frame the chain already has. A ' +
            'shader wanting startImage/endImage is a TRANSITION and needs the ' +
            'transition engine, not this path.',
          opts.origin,
        )
      }
      if (seenImage) {
        // Unreachable while the name is pinned above (a duplicate NAME is
        // already refused), and kept because that pin is a policy rather than a
        // law of the format — if it ever loosens, this is the check that stops
        // a second sampler from silently reading black.
        throw new IsfImportError(
          `declares more than one image input ("${seenImage}" and "${name}"). ` +
            'The post chain has exactly one upstream frame to offer, so a second ' +
            'image would sample an unbound sampler and return black without ' +
            'erroring.',
          opts.origin,
        )
      }
      seenImage = name
      out.push({ name, type: t, raw: e })
      continue
    }
    if (t === 'audio' || t === 'audioFFT') {
      throw new IsfImportError(
        `input "${name}" is TYPE "${t}". Audio does not come in through ISF ` +
          'here: the engine drives it from SHADER_SCENE_PRELUDE (uKick, uSnare, ' +
          'uHihat, the band clocks, the beat oscillators), which is per-scene ' +
          'authored routing rather than a texture of raw samples. Importing ' +
          'this would leave a uniform nobody writes and a shader that looks ' +
          'dead rather than broken.',
        opts.origin,
      )
    }

    const input: IsfInput = { name, type: t, raw: e }

    const label = e.LABEL
    if (label !== undefined && label !== null) {
      if (typeof label !== 'string') {
        throw new IsfImportError(`input "${name}" has a non-string LABEL.`, opts.origin)
      }
      if (label.trim() !== '') input.label = label
    }

    const def = coerceValue(e.DEFAULT, t, name, 'DEFAULT', opts)
    if (def !== undefined) input.default = def
    const min = coerceValue(e.MIN, t, name, 'MIN', opts)
    if (min !== undefined && typeof min !== 'boolean') input.min = min
    const max = coerceValue(e.MAX, t, name, 'MAX', opts)
    if (max !== undefined && typeof max !== 'boolean') input.max = max

    if (t === 'long') {
      // A `long` is a pop-up menu, not a number: VALUES holds the integer the
      // shader actually sees and LABELS the caption beside it. A menu with more
      // captions than values (or the reverse) has entries that select nothing,
      // which is a knob position that does something undefined rather than
      // nothing — worth refusing over.
      const values = e.VALUES
      const labels = e.LABELS
      if (values !== undefined) {
        if (!Array.isArray(values) || values.some((x) => num(x) === undefined)) {
          throw new IsfImportError(
            `input "${name}" (long) has a VALUES that is not an array of numbers.`,
            opts.origin,
          )
        }
        input.values = values.map((x) => num(x) as number)
      }
      if (labels !== undefined) {
        if (!Array.isArray(labels) || labels.some((x) => typeof x !== 'string')) {
          throw new IsfImportError(
            `input "${name}" (long) has a LABELS that is not an array of strings.`,
            opts.origin,
          )
        }
        input.labels = labels as string[]
      }
      if (input.values && input.labels && input.values.length !== input.labels.length) {
        throw new IsfImportError(
          `input "${name}" (long) has ${input.values.length} VALUES but ` +
            `${input.labels.length} LABELS; each menu entry needs both.`,
          opts.origin,
        )
      }
    }

    out.push(input)
  }
  return out
}

/** Component count a type's DEFAULT/MIN/MAX arrays carry, or 0 for a scalar. */
function arity(t: IsfInputType): number {
  return t === 'point2D' ? 2 : t === 'color' ? 4 : 0
}

/**
 * Normalise one DEFAULT/MIN/MAX against its input's type.
 *
 * `color` is padded to four components: three-component colours appear in the
 * corpus, and an opaque alpha is the only reading of them that does not produce
 * a fully transparent scene. Over-long arrays are truncated rather than refused
 * for the mirror-image reason — a `color` with five entries is a typo in
 * metadata, not a reason to reject a shader that compiles fine.
 */
function coerceValue(
  v: unknown,
  t: IsfInputType,
  name: string,
  key: string,
  opts: ParseIsfOptions,
): number | boolean | number[] | undefined {
  if (v === undefined || v === null) return undefined

  if (t === 'event' || t === 'bool') {
    if (typeof v === 'boolean') return v
    // `"DEFAULT": 1` is how a good part of the corpus writes `true`.
    const n = num(v)
    if (n !== undefined) return n !== 0
    throw new IsfImportError(
      `input "${name}" has a ${key} that is neither a boolean nor 0/1.`,
      opts.origin,
    )
  }

  const n = arity(t)
  if (n === 0) {
    const scalar = num(v)
    if (scalar === undefined) {
      throw new IsfImportError(
        `input "${name}" (${t}) has a non-numeric ${key}: ${JSON.stringify(v)}.`,
        opts.origin,
      )
    }
    return scalar
  }

  if (!Array.isArray(v)) {
    throw new IsfImportError(
      `input "${name}" (${t}) needs ${key} as an array of ${n} numbers.`,
      opts.origin,
    )
  }
  const nums = v.map((x) => num(x))
  if (nums.some((x) => x === undefined)) {
    throw new IsfImportError(
      `input "${name}" (${t}) has a non-numeric component in ${key}.`,
      opts.origin,
    )
  }
  const list = nums as number[]
  if (list.length > n) return list.slice(0, n)
  // Pad a short colour with opaque alpha; pad a short point with zero.
  while (list.length < n) list.push(t === 'color' && list.length === 3 ? 1 : 0)
  return list
}
