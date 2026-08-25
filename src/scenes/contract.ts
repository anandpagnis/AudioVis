/**
 * Scene Contract v1 — the canonical parameter vocabulary.
 *
 * `SceneMetadata` (see ./index.ts) already declares what a scene IS: its roles,
 * moods, bands, cost, camera anchor, licence. What it could not declare is what
 * a scene can be TOLD. Every knob was private: a scene invented its own
 * uniforms, read them from its own closure, and nothing outside the file could
 * name them. That is fine while every scene is in-repo and every caller is a
 * scene author — and it is a hard ceiling the moment a caller is not.
 *
 * This module is the other half: seven parameter names that mean the same thing
 * in every scene, plus optional named modes. A scene declares which of the
 * seven it honours and what each one is CALLED in its own language — `density`
 * reads as "fold" in one scene and "arches" in another — so a generic caller
 * addresses `density` while a human sees the scene's own word for it.
 *
 * The vocabulary is not a convenience. It is the difference between a director
 * that can only pick scenes and one that can PERFORM them:
 *
 *  - The AI Performance Director steers `complexity` and `density` against
 *    musical tension without knowing which scene is mounted, including scenes
 *    that did not exist when the director was written.
 *  - A preset stores dial positions in the shared vocabulary, so it survives
 *    being pointed at a different scene instead of collapsing to defaults.
 *  - A marketplace listing, MIDI map, automation lane or Resolume connector
 *    enumerates a scene's controls from {@link summarizeContract} rather than
 *    from a human reading its source.
 *
 * ## Normalisation
 *
 * Every parameter is 0..1, always, with no exceptions and no per-scene ranges.
 * A generic caller must be able to write 0.7 into any parameter of any scene
 * without a lookup table. Scenes expand that unit range themselves — most
 * through {@link drastic} for a magnitude or {@link bipolar} for a signed
 * offset — and the neutral position is 0.5 for both.
 *
 * ## Relationship to VisualParams
 *
 * `VisualParams` (store.ts: intensity/speed/reactivity) is the GLOBAL response
 * layer — how hard the whole show leans on the music — and its values are
 * multipliers around 1. These seven are PER-SCENE art direction, normalised
 * 0..1. They are separate systems that happen to share the word "speed":
 * `ctx.params.speed` scales autonomous motion everywhere, `ctx.p.speed` is this
 * scene's own rate dial. Both apply; neither replaces the other.
 */

/**
 * The vocabulary. Seven names, fixed, in panel order.
 *
 * Fixed because the value is in every scene meaning the same thing by the same
 * name — an eighth name added for one scene's convenience is a name every
 * generic caller has to special-case, which is the ceiling this exists to
 * remove. A scene whose control does not fit one of the seven should pick the
 * closest and relabel it (see `paramLabels`), which is what the labels are for.
 *
 *  - `speed`       rate of the scene's own motion (0.5 = its natural rate)
 *  - `shape`       which silhouette/layout, within one scene's family
 *  - `complexity`  detail, iterations, subdivision — how much structure
 *  - `density`     how many, how packed, how deep the stack
 *  - `fill`        how much of the frame it occupies; scale, coverage, length
 *  - `tilt`        signed viewpoint/orientation offset (0.5 = level)
 *  - `contrast`    tonal range, edge hardness, falloff
 */
export const SCENE_PARAM_KEYS = [
  'speed',
  'shape',
  'complexity',
  'density',
  'fill',
  'tilt',
  'contrast',
] as const

export type SceneParamKey = (typeof SCENE_PARAM_KEYS)[number]

/** A sparse set of parameter values — only the keys a caller means to set. */
export type SceneParams = Partial<Record<SceneParamKey, number>>

/**
 * All seven, always present. What a scene reads as `ctx.p`.
 *
 * Total rather than partial so a scene can read `ctx.p.tilt` unconditionally:
 * a parameter it did not declare resolves to {@link NEUTRAL}, which every
 * expansion helper treats as "no offset, natural rate". Reading an undeclared
 * parameter is therefore harmless rather than `undefined`.
 */
export type ResolvedSceneParams = Record<SceneParamKey, number>

/**
 * Per-mode display labels: `paramLabels[mode][key]`, with `'*'` applying to
 * every mode. A specific mode's entry wins over `'*'`.
 *
 * A `null` label means the parameter is INERT in that mode — the scene ignores
 * it there, so UI hides the slider, {@link liveParamKeys} omits it, and a
 * generic write to it is dropped rather than silently doing nothing. This is
 * the honest half of the contract: a dial that is visible but dead is worse
 * than no dial, and a director that thinks it is steering something it is not
 * will keep pushing a parameter that cannot answer.
 */
export type SceneParamLabels = Record<string, Partial<Record<SceneParamKey, string | null>>>

/** Contract revision. Bumped only for a breaking change to this shape. */
export const SCENE_CONTRACT_VERSION = 1

/**
 * What a scene declares it can be told.
 *
 * Optional on `SceneMetadata` and validated when present: a scene with no
 * contract is simply not steerable, which is the pre-v1 behaviour and stays
 * legal so the roster can migrate one scene at a time (the same opt-in shape
 * `cameraAnchor` uses).
 */
export interface SceneContract {
  /**
   * Must equal {@link SCENE_CONTRACT_VERSION}. Present so a stored preset or a
   * third-party scene built against an older shape can be detected rather than
   * misread.
   */
  version: typeof SCENE_CONTRACT_VERSION

  /**
   * Named modes — genuinely different pictures inside one scene, not a
   * continuum (that is what a parameter is for). First entry is the default.
   *
   * A mode may change what the parameters MEAN, which is why labels are keyed
   * by mode. Absent means the scene has exactly one mode.
   */
  modes?: string[]

  /**
   * The parameters this scene honours, with their default positions.
   *
   * Declaring a key is a promise that the scene actually reads it. Only
   * declared keys are steerable, presetable, or shown.
   */
  params: SceneParams

  /** The scene's own word for each parameter, per mode. See {@link SceneParamLabels}. */
  paramLabels?: SceneParamLabels
}

/** Neutral position for every parameter: natural rate, no offset, mid range. */
export const NEUTRAL = 0.5

export function clamp01(v: number): number {
  if (!isFinite(v)) return NEUTRAL
  return v > 1 ? 1 : v < 0 ? 0 : v
}

/**
 * Expand a 0..1 parameter into a multiplier: 0.25x at 0, 1x at 0.5, 4x at 1.
 *
 * The standard expansion for anything that is a MAGNITUDE — a rate, a count, a
 * scale. Exponential rather than linear so both ends of the slider are worth
 * visiting: a linear 0..2 spends its bottom half between "barely different" and
 * "slightly slower", where this reaches a genuine quarter speed.
 */
export function drastic(p: number): number {
  return Math.pow(4, (clamp01(p) - NEUTRAL) * 2)
}

/**
 * Expand a 0..1 parameter into a signed offset in +/-`span`, 0 at neutral.
 *
 * The standard expansion for anything DIRECTIONAL — a tilt, a fold, a bipolar
 * warp — where the middle of the slider must be "off", not "half on".
 */
export function bipolar(p: number, span = 1): number {
  return (clamp01(p) - NEUTRAL) * 2 * span
}

/**
 * Map a 0..1 parameter onto an inclusive integer range, evenly.
 *
 * For discrete controls — ring counts, subdivisions, arch counts — so a scene
 * exposes them through the same normalised vocabulary as everything else rather
 * than inventing an integer parameter a generic caller cannot write blind.
 */
export function steps(p: number, min: number, max: number): number {
  const n = min + Math.round(clamp01(p) * (max - min))
  return n < min ? min : n > max ? max : n
}

/** The mode a scene boots in, or undefined for a single-mode scene. */
export function defaultMode(c: SceneContract): string | undefined {
  return c.modes?.[0]
}

/** A valid mode for this scene: `raw` if the scene declares it, else the default. */
export function resolveMode(c: SceneContract, raw: unknown): string | undefined {
  if (typeof raw === 'string' && c.modes?.includes(raw)) return raw
  return defaultMode(c)
}

/**
 * The scene's own word for a parameter in a given mode, or `null` if the
 * parameter is inert there — or undeclared, which is inert in every mode.
 *
 * Undeclared collapsing to `null` is deliberate: a caller asking "can I show
 * this dial" and a caller asking "will a write land" want the same answer, and
 * for an undeclared parameter both are no.
 */
export function paramLabel(
  c: SceneContract,
  mode: string | undefined,
  key: SceneParamKey,
): string | null {
  if (!(key in c.params)) return null
  const perMode = (mode !== undefined ? c.paramLabels?.[mode] : undefined) ?? {}
  if (key in perMode) return perMode[key] ?? null
  const all = c.paramLabels?.['*'] ?? {}
  if (key in all) return all[key] ?? null
  return key
}

/** Does a write to this parameter reach the scene in this mode? */
export function isParamLive(
  c: SceneContract,
  mode: string | undefined,
  key: SceneParamKey,
): boolean {
  return paramLabel(c, mode, key) !== null
}

/**
 * The steerable parameters in this mode, in canonical order.
 *
 * This is the list a panel builds rows from, a MIDI map assigns CCs to, and a
 * marketplace listing shows — anything enumerating a stranger's controls.
 */
export function liveParamKeys(c: SceneContract, mode: string | undefined): SceneParamKey[] {
  return SCENE_PARAM_KEYS.filter((k) => isParamLive(c, mode, k))
}

/** Declared defaults, filled to all seven with {@link NEUTRAL}. */
export function defaultSceneParams(c: SceneContract): ResolvedSceneParams {
  const out = {} as ResolvedSceneParams
  for (const k of SCENE_PARAM_KEYS) out[k] = clamp01(c.params[k] ?? NEUTRAL)
  return out
}

/**
 * The scene's defaults with `overrides` applied — what a scene reads as `ctx.p`.
 *
 * Overrides to parameters that are undeclared or inert in `mode` are IGNORED
 * rather than written through, so a preset or automation lane carrying values
 * for a different scene (or a different mode of this one) cannot push a dial
 * the scene does not honour. The result is always all seven keys.
 *
 * `into` lets a per-frame caller reuse one object instead of allocating.
 */
export function resolveSceneParams(
  c: SceneContract,
  mode: string | undefined,
  overrides: SceneParams | undefined,
  into?: ResolvedSceneParams,
): ResolvedSceneParams {
  const out = into ?? ({} as ResolvedSceneParams)
  for (const k of SCENE_PARAM_KEYS) {
    const declared = c.params[k]
    let v = declared ?? NEUTRAL
    if (overrides !== undefined && declared !== undefined && isParamLive(c, mode, k)) {
      const o = overrides[k]
      if (typeof o === 'number' && isFinite(o)) v = o
    }
    out[k] = clamp01(v)
  }
  return out
}

/**
 * Resolve the three layers a live dial is made of: the scene's authored default,
 * the director's steer over it, and the user's own position over that.
 *
 * **The user always wins.** Not because their taste is better, but because a
 * dial that argues back is not a dial: a VJ who moves `complexity` and watches
 * the director ease it away over the next three seconds has been told the
 * control is a suggestion. So a key present in `user` ends the resolution for
 * that key, and the director keeps the rest. That is also why the steer is
 * sparse — see engine/sceneSteer.ts, which declines two of the seven outright
 * so there is always something a human owns uncontested.
 *
 * Both layers are still filtered by the contract: neither the director nor a
 * stored user value can push a parameter the scene does not declare, or one that
 * is inert in the current mode.
 *
 * `into` lets the per-frame caller reuse one object instead of allocating.
 */
export function resolveSteeredParams(
  c: SceneContract,
  mode: string | undefined,
  steer: SceneParams | undefined,
  user: SceneParams | undefined,
  into?: ResolvedSceneParams,
): ResolvedSceneParams {
  const out = into ?? ({} as ResolvedSceneParams)
  for (const k of SCENE_PARAM_KEYS) {
    const declared = c.params[k]
    let v = declared ?? NEUTRAL
    if (declared !== undefined && isParamLive(c, mode, k)) {
      const s = steer?.[k]
      if (typeof s === 'number' && isFinite(s)) v = s
      const u = user?.[k]
      if (typeof u === 'number' && isFinite(u)) v = u
    }
    out[k] = clamp01(v)
  }
  return out
}

/**
 * Clean an untrusted param block against a scene's contract: drops keys the
 * scene does not honour in `mode`, drops non-finite values, clamps the rest.
 *
 * The gate every external write goes through — imported preset, URL param,
 * MIDI/OSC message, a third-party scene's own stored state. Sparse in, sparse
 * out: absent means "leave at the scene default", which is not the same as 0.5.
 */
export function sanitizeSceneParams(
  c: SceneContract,
  mode: string | undefined,
  raw: unknown,
): SceneParams {
  const out: SceneParams = {}
  if (typeof raw !== 'object' || raw === null) return out
  const o = raw as Record<string, unknown>
  for (const k of SCENE_PARAM_KEYS) {
    if (!(k in c.params)) continue
    if (!isParamLive(c, mode, k)) continue
    const v = o[k]
    if (typeof v !== 'number' || !isFinite(v)) continue
    out[k] = clamp01(v)
  }
  return out
}

/**
 * Clean an untrusted param block WITHOUT a contract to check it against: keeps
 * only the seven vocabulary names, drops non-finite values, clamps to 0..1.
 *
 * This is the form a preset stores. Sanitizing against a contract at save time
 * would be the bug that makes a preset scene-specific: the block would lose
 * every key the preset's original scene did not honour, and re-pointing it at a
 * scene that DOES honour them would find those dials already thrown away. So a
 * preset holds the whole vocabulary and {@link resolveSceneParams} decides, at
 * apply time, which of it the target scene can hear.
 */
export function sanitizeParamBlock(raw: unknown): SceneParams {
  const out: SceneParams = {}
  if (typeof raw !== 'object' || raw === null) return out
  const o = raw as Record<string, unknown>
  for (const k of SCENE_PARAM_KEYS) {
    const v = o[k]
    if (typeof v === 'number' && isFinite(v)) out[k] = clamp01(v)
  }
  return out
}

/** One parameter, as an external consumer sees it. */
export interface SceneParamDescriptor {
  /** Canonical name — what a caller writes. */
  key: SceneParamKey
  /** The scene's own word for it — what a human reads. */
  label: string
  /** Default position, 0..1. */
  default: number
}

/** One scene, as an external consumer sees it. */
export interface SceneContractSummary {
  id: string
  name: string
  version: number
  /** Modes, or an empty array for a single-mode scene. */
  modes: string[]
  /** The mode the `params` below describe. */
  mode?: string
  params: SceneParamDescriptor[]
}

/**
 * Describe a scene's controls for a consumer that cannot read its source: a
 * marketplace listing, a generated MIDI/OSC map, a Resolume or Max for Live
 * device's dial captions, an API response.
 *
 * Mode-scoped because labels and liveness are per mode — the same scene
 * genuinely exposes a different control surface in each, and a caption that
 * lies about which is worse than no caption.
 */
export function summarizeContract(
  id: string,
  name: string,
  c: SceneContract,
  mode?: string,
): SceneContractSummary {
  const m = resolveMode(c, mode)
  return {
    id,
    name,
    version: c.version,
    modes: c.modes ? [...c.modes] : [],
    mode: m,
    params: liveParamKeys(c, m).map((k) => ({
      key: k,
      label: paramLabel(c, m, k) ?? k,
      default: clamp01(c.params[k] ?? NEUTRAL),
    })),
  }
}

/**
 * Structural problems with a contract, as human-readable strings. Empty means
 * valid. Called by `validateSceneDef`, so a third-party scene registering a
 * malformed contract is rejected at `registerScene` rather than producing a
 * panel of dead sliders.
 */
export function validateContract(sceneId: string, c: SceneContract): string[] {
  const issues: string[] = []
  const at = `Scene "${sceneId}"`

  if (c.version !== SCENE_CONTRACT_VERSION) {
    issues.push(`${at} declares contract version ${c.version}; expected ${SCENE_CONTRACT_VERSION}.`)
  }

  if (typeof c.params !== 'object' || c.params === null) {
    issues.push(`${at} contract needs a \`params\` object.`)
    return issues
  }

  const declared = SCENE_PARAM_KEYS.filter((k) => k in c.params)
  if (declared.length === 0) {
    issues.push(`${at} contract declares no parameters; omit the contract instead.`)
  }
  for (const k of Object.keys(c.params)) {
    if (!(SCENE_PARAM_KEYS as readonly string[]).includes(k)) {
      issues.push(
        `${at} declares unknown parameter "${k}"; the vocabulary is ${SCENE_PARAM_KEYS.join(', ')}.`,
      )
    }
  }
  for (const k of declared) {
    const v = c.params[k]
    if (typeof v !== 'number' || !isFinite(v) || v < 0 || v > 1) {
      issues.push(`${at} parameter "${k}" defaults to ${String(v)}; must be a number in 0..1.`)
    }
  }

  if (c.modes !== undefined) {
    if (!Array.isArray(c.modes) || c.modes.length === 0) {
      issues.push(`${at} declares \`modes\` but it is empty; omit it for a single-mode scene.`)
    } else {
      const seen = new Set<string>()
      for (const m of c.modes) {
        if (typeof m !== 'string' || m.trim() === '') issues.push(`${at} has a blank mode name.`)
        else if (seen.has(m)) issues.push(`${at} declares mode "${m}" twice.`)
        else seen.add(m)
      }
    }
  }

  if (c.paramLabels !== undefined) {
    for (const [mode, labels] of Object.entries(c.paramLabels)) {
      if (mode !== '*' && !c.modes?.includes(mode)) {
        issues.push(`${at} labels mode "${mode}", which it does not declare in \`modes\`.`)
      }
      for (const [k, label] of Object.entries(labels)) {
        if (!(SCENE_PARAM_KEYS as readonly string[]).includes(k)) {
          issues.push(`${at} labels unknown parameter "${k}" in mode "${mode}".`)
        } else if (!(k in c.params)) {
          issues.push(
            `${at} labels "${k}" in mode "${mode}" but does not declare it in \`params\`.`,
          )
        } else if (label !== null && (typeof label !== 'string' || label.trim() === '')) {
          issues.push(`${at} has a blank label for "${k}" in mode "${mode}".`)
        }
      }
    }
    // A parameter inert in every mode is a default nothing can ever reach:
    // either the scene reads it (so it should be live somewhere) or it does
    // not (so it should not be declared).
    const modes: (string | undefined)[] = c.modes?.length ? c.modes : [undefined]
    for (const k of declared) {
      if (!modes.some((m) => isParamLive(c, m, k))) {
        issues.push(`${at} declares "${k}" but it is inert in every mode; remove the declaration.`)
      }
    }
  }

  return issues
}
