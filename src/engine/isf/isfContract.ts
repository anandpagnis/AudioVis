import {
  clamp01,
  NEUTRAL,
  SCENE_CONTRACT_VERSION,
  SCENE_PARAM_KEYS,
  steps,
  validateContract,
  type SceneContract,
  type SceneParamKey,
  type SceneParams,
  type SceneParamLabels,
} from '../../scenes/contract'
import { IsfImportError, type IsfHeader, type IsfInput } from './parseISF'
import { isfUniformName } from './transpileISF'

/**
 * Derive a `SceneContract` — and, more importantly, its remap curves — from an
 * ISF header.
 *
 * ## What is curated and what is generated
 *
 * The seven canonical parameter names are a CLOSED vocabulary
 * (`validateContract` rejects an eighth), so deciding that an ISF input called
 * `width` is this scene's `fill` and not its `density` is a judgement about
 * what the picture does. Nothing in the ISF header carries that; a `LABEL` of
 * "Width" is a caption, not a semantic. So the key mapping arrives here as an
 * argument and is never guessed. Guessing it would produce a director steering
 * `density` and watching the scale change, which is worse than a scene with no
 * contract at all.
 *
 * What IS generated is the **remap curve**, and it is the whole automation win
 * of this phase. Writing one by hand is the fiddliest part of authoring a
 * descriptor — `MalachiteScene.tsx` carries three of them:
 *
 * ```ts
 * u.uScale.value = P.fill < 0.5 ? 1.0 + P.fill * 2.8 : 2.4 + (P.fill - 0.5) * 5.2
 * ```
 *
 * Those six magic numbers encode exactly three facts: the knob's minimum (1.0),
 * the value the shader was AUTHORED at (2.4), and its maximum (5.0). ISF states
 * all three, as `MIN` / `DEFAULT` / `MAX`. {@link isfRemap} reconstructs the
 * expression above from them, and a test pins the two against each other across
 * a sweep so the derivation is checked against the hand-written original rather
 * than only against itself.
 *
 * ## Why the curve bends at the default
 *
 * The obvious mapping — linear from `MIN` to `MAX` — puts the contract's
 * neutral `0.5` at the arithmetic midpoint, which is not where the shader's
 * author put it. Malachite's scale would sit at 3.0 instead of 2.4, so the
 * scene at rest would not be the scene the author tuned. Two straight segments
 * meeting at `DEFAULT` fix that with no other cost: the endpoints still reach
 * the authored bounds exactly, and every position in between is still
 * monotonic, so a director sweeping the dial never sees it change direction.
 */

/** A scalar ISF input's three authored numbers, after defaults are resolved. */
export interface IsfRange {
  min: number
  /** The value the shader was authored at. `neutral` maps to exactly this. */
  def: number
  max: number
}

/** A generated 0..1 -> shader-value mapping. */
export interface IsfRemap {
  range: IsfRange
  /**
   * The 0..1 position at which {@link map} returns {@link IsfRange.def}.
   *
   * `0.5` in the normal case, and it is what a scene's `contract.params` entry
   * is set to, so a scene at its declared defaults renders exactly what the ISF
   * author tuned. It moves to `0` or `1` when the default sits ON a bound — see
   * {@link isfRemap}.
   */
  neutral: number
  /** Map a 0..1 contract parameter onto the shader value. */
  map: (p: number) => number
}

/**
 * How close to a bound the default has to be before the curve is treated as
 * degenerate, as a fraction of the full span.
 *
 * Relative rather than absolute, because these ranges are arbitrary: an ISF
 * input might run 0..1 or 0..4096, and a fixed epsilon means one of those two
 * cases is being judged on a scale that does not apply to it.
 */
const DEGENERATE_FRACTION = 1e-9

/**
 * Build the piecewise-linear map for one scalar input.
 *
 * Normal case — `MIN < DEFAULT < MAX`:
 *
 * ```
 *   p = 0    -> MIN
 *   p = 0.5  -> DEFAULT      (exactly, not approximately)
 *   p = 1    -> MAX
 * ```
 *
 * ## The two edge cases
 *
 * When `DEFAULT` sits exactly on `MIN` or `MAX` — which happens constantly, any
 * knob authored as "off by default" has `DEFAULT == MIN` — the piecewise shape
 * has nothing to put in one of its halves. Pinning `0.5` to the default anyway
 * would leave half the dial flat: a director could sweep `complexity` from 0 to
 * 0.5 and see nothing move, which reads as a broken scene rather than as a
 * scene whose default is at the bottom of its range.
 *
 * So in that case the curve becomes plain linear across the whole range, and
 * {@link IsfRemap.neutral} moves to the end the default sits on. The promise
 * being kept is the one that matters — **the scene at its declared default
 * renders what the ISF author authored** — while the whole dial stays useful.
 * The `0.5 == DEFAULT` identity is a means to that, not the point of it.
 *
 * A zero-width range (`MIN == MAX`) collapses to a constant. Nothing here can
 * produce a `NaN`: every division is by the fixed constant `0.5`, and the only
 * subtractions that could vanish are the ones the degenerate branches catch.
 */
export function isfRemap(range: IsfRange): IsfRemap {
  const min = range.min
  const max = range.max
  // A DEFAULT outside its own declared bounds appears in the corpus. Clamping
  // rather than refusing keeps a usable curve, and the clamped value is still
  // the closest thing to the authored intent that the range permits.
  const def = Math.min(max, Math.max(min, range.def))
  const resolved: IsfRange = { min, def, max }
  const span = max - min

  if (!(span > 0)) {
    // MIN == MAX (or an inverted range). There is one legal value; say so
    // rather than dividing by the span and producing Infinity.
    return { range: resolved, neutral: NEUTRAL, map: () => def }
  }

  const lower = def - min
  const upper = max - def
  const tol = span * DEGENERATE_FRACTION

  if (lower <= tol) {
    return { range: resolved, neutral: 0, map: (p) => min + span * clamp01(p) }
  }
  if (upper <= tol) {
    return { range: resolved, neutral: 1, map: (p) => min + span * clamp01(p) }
  }

  return {
    range: resolved,
    neutral: NEUTRAL,
    // Two segments, each spanning half the dial, so the slopes are
    // `(def - min) / 0.5` and `(max - def) / 0.5` — which is precisely the
    // `* 2.8` / `* 5.2` pair MalachiteScene writes out by hand.
    map: (p) => {
      const t = clamp01(p)
      return t < NEUTRAL ? min + lower * t * 2 : def + upper * (t - NEUTRAL) * 2
    },
  }
}

/**
 * Range multiplier used when an ISF input declares a DEFAULT but no MIN/MAX.
 *
 * `MIN`/`MAX` are optional in the ISF spec and a large share of the corpus
 * omits them — the `width` input of the Checkerboard fixture does. Refusing
 * those would throw away most of the automation, so a range is synthesised, and
 * the factor is not arbitrary: 4 is exactly the span `drastic()` gives every
 * hand-authored magnitude knob in this repo (0.25x at 0, 1x at 0.5, 4x at 1).
 * An ISF input with no declared range therefore behaves like every other
 * magnitude in the app rather than like something imported.
 */
export const DERIVED_RANGE_FACTOR = 4

/**
 * Settle one input's `{min, def, max}`, filling in whatever ISF left out.
 *
 * The fallbacks, and why each is the least-surprising reading:
 *
 *  - **MIN and MAX both given** — used as-is. The author stated the range.
 *  - **Neither given, DEFAULT given** — the {@link DERIVED_RANGE_FACTOR} span
 *    around it. A `DEFAULT` of 0 has no such span (0/4 == 0*4 == 0), so it
 *    falls through to 0..1, which is what an ISF float with no range and a zero
 *    default nearly always is.
 *  - **Neither given, DEFAULT absent** — 0..1 with the default at the midpoint.
 *    There is no authored value to honour, so the neutral position is the only
 *    remaining meaning for 0.5.
 *  - **One of the two given** — the missing bound is derived from the other and
 *    the default the same way, rather than assumed to be 0.
 *
 * `override` is how a curator narrows a range that is technically correct and
 * practically unusable — an ISF `MAX` of 100 on an iteration count that costs
 * 3ms at 20. That is a per-scene performance decision, so it belongs at the
 * call site, not in a heuristic here.
 */
export function resolveRange(input: IsfInput, override?: Partial<IsfRange>): IsfRange {
  const declaredMin = scalar(input.min)
  const declaredMax = scalar(input.max)
  const declaredDef = scalar(input.default)

  const givenMin = override?.min ?? declaredMin
  const givenMax = override?.max ?? declaredMax
  const def = override?.def ?? declaredDef

  let min: number
  let max: number
  if (givenMin !== undefined && givenMax !== undefined) {
    min = givenMin
    max = givenMax
  } else if (givenMin === undefined && givenMax === undefined) {
    if (def !== undefined && def !== 0) {
      min = Math.min(def / DERIVED_RANGE_FACTOR, def * DERIVED_RANGE_FACTOR)
      max = Math.max(def / DERIVED_RANGE_FACTOR, def * DERIVED_RANGE_FACTOR)
    } else {
      min = 0
      max = 1
    }
  } else if (givenMin === undefined) {
    max = givenMax as number
    min = Math.min(max, def ?? 0, max / DERIVED_RANGE_FACTOR)
  } else {
    min = givenMin
    max = Math.max(min, def ?? 0, min === 0 ? 1 : min * DERIVED_RANGE_FACTOR)
  }

  return { min, max, def: def ?? (min + max) / 2 }
}

/** DEFAULT/MIN/MAX as a single number, or undefined for a vector or a boolean. */
function scalar(v: number | boolean | number[] | undefined): number | undefined {
  return typeof v === 'number' ? v : undefined
}

/* ------------------------------------------------------------- the contract */

/** How one contract key is wired to one ISF input. */
export interface IsfParamMapping {
  /** ISF `NAME` of the input this key drives. */
  input: string
  /** Narrow or widen the derived range — see {@link resolveRange}. */
  range?: Partial<IsfRange>
  /** Override the caption. Defaults to the input's `LABEL`, else its `NAME`. */
  label?: string
}

/**
 * The curatorial half: which ISF input each canonical key drives.
 *
 * A bare string is shorthand for `{ input: name }`, because the range override
 * is the exception rather than the rule.
 */
export type IsfParamMap = Partial<Record<SceneParamKey, string | IsfParamMapping>>

/** One resolved key -> uniform wiring, ready for a scene's `update()`. */
export interface IsfBinding {
  key: SceneParamKey
  /** The ISF input behind it. */
  input: IsfInput
  /** The uniform `transpileISF` generated for that input. */
  uniform: string
  remap: IsfRemap
  /** The scene's own word for the knob, as it will appear in the panel. */
  label: string
}

export interface IsfContractBuild {
  contract: SceneContract
  bindings: IsfBinding[]
}

export interface BuildIsfContractOptions {
  /** Named modes, if the scene declares any. Never inferred from the header. */
  modes?: string[]
  /** Filename or URL, for error messages. */
  origin?: string
}

/**
 * Build the contract and the bindings for one curated ISF scene.
 *
 * The contract is run through `validateContract` before it is returned, so a
 * malformed mapping fails at module load rather than at `registerScene` — the
 * difference between a stack trace pointing at the scene file and one pointing
 * at the registry.
 *
 * `paramLabels` is populated from the ISF `LABEL`, falling back to `NAME`. That
 * is the convention `MalachiteScene` follows (the source's own knob names), and
 * it is worth more than a tidier caption would be: a VJ reading "toxicity" can
 * search the original shader for it, where a renamed "vividness" leads nowhere.
 * Every label is registered under `'*'` — a mode-specific label is a claim that
 * the parameter MEANS something different in that mode, which is a judgement
 * about the picture and so belongs with the curator, not here.
 */
export function buildIsfContract(
  sceneId: string,
  header: IsfHeader,
  mapping: IsfParamMap,
  opts: BuildIsfContractOptions = {},
): IsfContractBuild {
  const byName = new Map(header.inputs.map((i) => [i.name, i]))
  const bindings: IsfBinding[] = []
  const params: SceneParams = {}
  const labels: Partial<Record<SceneParamKey, string>> = {}

  // Iterated in canonical order rather than in the mapping's own key order, so
  // the emitted contract is byte-stable regardless of how the curator typed it.
  for (const key of SCENE_PARAM_KEYS) {
    const entry = mapping[key]
    if (entry === undefined) continue
    const spec: IsfParamMapping = typeof entry === 'string' ? { input: entry } : entry

    const input = byName.get(spec.input)
    if (!input) {
      throw new IsfImportError(
        `contract maps "${key}" to an input named "${spec.input}", which this ` +
          `shader does not declare. Its inputs are: ${[...byName.keys()].join(', ') || '(none)'}.`,
        opts.origin,
      )
    }

    bindings.push({
      key,
      input,
      uniform: isfUniformName(input.name),
      remap: remapFor(input, spec.range, opts.origin),
      label: spec.label ?? input.label ?? input.name,
    })
  }

  for (const b of bindings) {
    params[b.key] = clamp01(b.remap.neutral)
    labels[b.key] = b.label
  }

  const paramLabels: SceneParamLabels = { '*': labels }
  const contract: SceneContract = {
    version: SCENE_CONTRACT_VERSION,
    ...(opts.modes ? { modes: opts.modes } : {}),
    params,
    paramLabels,
  }

  const issues = validateContract(sceneId, contract)
  if (issues.length > 0) throw new IsfImportError(issues.join(' '), opts.origin)

  return { contract, bindings }
}

/**
 * The right curve for one input's TYPE.
 *
 * Only the scalar types can be driven from a single 0..1 parameter, and the
 * refusal for the others is deliberate rather than a gap: a `point2D` or a
 * `color` needs two-to-four independent numbers, and collapsing them onto one
 * dial would mean inventing a path through the space that the ISF author never
 * described. Those inputs are still transpiled and still get a uniform — they
 * are simply written by the scene's own `update()`, from the palette or from
 * audio, which is where a two-dimensional decision belongs.
 */
function remapFor(
  input: IsfInput,
  override: Partial<IsfRange> | undefined,
  origin: string | undefined,
): IsfRemap {
  switch (input.type) {
    case 'float':
      return isfRemap(resolveRange(input, override))

    case 'long': {
      const values = input.values
      if (!values || values.length === 0) {
        // A `long` with no VALUES is just an integer knob. Same curve as a
        // float, rounded — GLSL will truncate toward zero on the `int` uniform
        // otherwise, which would make the top of the range unreachable.
        const base = isfRemap(resolveRange(input, override))
        return { ...base, map: (p) => Math.round(base.map(p)) }
      }
      // A real pop-up menu: the dial selects an ENTRY, not a number. Mapping
      // linearly over the numeric values instead would be wrong whenever they
      // are not evenly spaced, and they frequently are not — a menu of
      // 1/2/4/8/16 would spend two thirds of the dial on the last step.
      const top = values.length - 1
      const chosen = typeof input.default === 'number' ? values.indexOf(input.default) : -1
      const at = chosen >= 0 ? chosen : 0
      return {
        range: { min: Math.min(...values), def: values[at], max: Math.max(...values) },
        neutral: top > 0 ? at / top : 0,
        map: (p) => values[steps(p, 0, top)],
      }
    }

    case 'bool':
    case 'event': {
      // 1/0 rather than true/false: three writes a GLSL `bool` uniform through
      // `gl.uniform1i`, which takes a number, and keeping the sink numeric lets
      // every binding share one write path.
      const on = input.default === true ? 1 : 0
      return {
        range: { min: 0, def: on, max: 1 },
        neutral: on,
        map: (p) => (clamp01(p) >= NEUTRAL ? 1 : 0),
      }
    }

    default:
      throw new IsfImportError(
        `input "${input.name}" is TYPE "${input.type}", which has ` +
          `${input.type === 'color' ? 'four components' : 'two components'} and ` +
          'cannot be driven from a single 0..1 contract parameter. Drive its ' +
          'uniform directly from the scene update() instead.',
        origin,
      )
  }
}

/**
 * Build the parameter half of a scene's `update()`.
 *
 * Everything a `createShaderScene` scene does with `P` mechanically — read the
 * dial, run it through the curve, write the uniform — for every bound key at
 * once. What is left for the scene author is the part no header can describe:
 * the audio routing (`s.onKick`, `s.mids`, the band clocks), which is exactly
 * the split the plan for this work identified as the real per-scene cost.
 *
 * ```ts
 * const applyParams = isfParamUpdater(bindings)
 * // …
 * update({ u, s, P, dt, st }) {
 *   applyParams(u, P)
 *   st.phase += dt * 0.4 * (1 + s.mids)
 *   u.uIsfPhase.value = st.phase
 * }
 * ```
 *
 * Throws rather than skipping when a uniform is missing. A scene whose
 * `uniforms` factory has drifted from its transpiled shader would otherwise run
 * with dead dials and no indication of it, which is the same silent-partial
 * failure the parser refuses files over — and this one fires on the first
 * frame, in development, where it is cheap.
 */
export function isfParamUpdater(
  bindings: readonly IsfBinding[],
): (u: Record<string, { value: number }>, P: Readonly<Record<SceneParamKey, number>>) => void {
  return (u, P) => {
    for (const b of bindings) {
      const target = u[b.uniform]
      if (!target) {
        throw new Error(
          `ISF scene is missing the uniform "${b.uniform}" for parameter ` +
            `"${b.key}". Build the scene's uniforms with isfUniformSeed(), which ` +
            'is generated from the same transpile as the shader.',
        )
      }
      target.value = b.remap.map(P[b.key])
    }
  }
}
