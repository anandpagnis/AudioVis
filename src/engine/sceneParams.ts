import { useEffect, useMemo, useRef } from 'react'
import { getScene } from '../scenes'
import { useStore } from '../store'

/**
 * The canonical per-scene parameter vocabulary.
 *
 * Seven names, the same seven in every scene that declares any of them. This is
 * lilim's vocabulary, adopted verbatim, and the fixedness is the entire point:
 * it is why one generic slider panel drives every scene, why a preset survives
 * a scene swap, and why anything that wants to reach *inside* a scene — a cue,
 * a future MIDI map, a director that wants a scene denser rather than merely
 * different — can address it without knowing what the scene is.
 *
 * Before this existed, the only knobs were three globals (`intensity`, `speed`,
 * `reactivity`) plus per-slot gain. A preset could say "scene X, palette Y,
 * three globals" and nothing else; a scene's internals were unreachable.
 *
 * **Do not add an eighth key to serve one scene.** A scene that needs a knob
 * outside this set should express it as a {@link SceneModeSpec} mode instead —
 * that is what modes are for. Adding a key here costs every scene, every
 * preset, and the panel layout.
 */
export const SCENE_PARAM_KEYS = [
  /** Autonomous motion rate. The one key {@link drastic} is applied to. */
  'speed',
  /** Silhouette / form selection — what the thing *is*. */
  'shape',
  /** Iteration counts, octaves, structural detail. */
  'complexity',
  /** How much stuff there is — particle counts, element counts. */
  'density',
  /** Scale/zoom of the pattern within the frame. */
  'fill',
  /** Camera or field inclination, where a scene has one. */
  'tilt',
  /** Tone curve bias: below 0.5 lifts shadows, above 0.5 hardens. */
  'contrast',
] as const

export type SceneParamKey = (typeof SCENE_PARAM_KEYS)[number]

/**
 * What a scene declares, and what a user override stores. Sparse on purpose:
 * **a key's presence is the declaration that the scene uses it**, which is what
 * lets the panel show exactly the sliders that do something. A scene that
 * declares `{ speed, complexity }` gets two sliders, not seven dead ones.
 */
export type SceneParams = Partial<Record<SceneParamKey, number>> & {
  /** Named mode, when the scene declares {@link SceneModeSpec.modes}. */
  mode?: string
}

/**
 * Fully-populated parameters handed to a scene, so scene bodies never
 * null-check. Every key is present; keys the scene did not declare sit at
 * {@link DEFAULT_PARAM_VALUE} and are simply unread.
 */
export type ResolvedSceneParams = Record<SceneParamKey, number> & {
  /** Active mode name, or `''` when the scene declares no modes. */
  mode: string
  /** Index of `mode` in the scene's declared list — feed this to a `uMode` int
   *  uniform. `0` when the mode is unknown, matching lilim's fallback. */
  modeIndex: number
}

/**
 * Neutral value for an undeclared parameter.
 *
 * 0.5 rather than 0 or 1, because every parameter is a bipolar 0..1 control
 * whose *centre* is the authored look — {@link drastic} maps 0.5 to 1×, and the
 * `contrast` convention treats 0.5 as untouched. A default of 0 would mean
 * "every undeclared knob is pinned to its extreme".
 */
export const DEFAULT_PARAM_VALUE = 0.5

/**
 * The slider response curve: 0.25× at 0, 1× at 0.5, 4× at 1.
 *
 * lilim's curve, and the reason its sliders feel like different worlds at the
 * ends rather than like a 10% trim. A linear 0..1 knob spends most of its travel
 * in a range that looks identical; this spends it either side of the authored
 * value, geometrically.
 *
 * Applied to `speed` in every scene that has one (`drastic(P.speed)`). Every
 * other parameter is consumed raw as a 0..1 lerp/remap factor by the scene
 * itself — that asymmetry is intentional, because `speed` is the only key whose
 * meaning is multiplicative.
 */
export const drastic = (p: number): number => Math.pow(4, (p - 0.5) * 2)

/** What a scene declares about its named modes. */
export interface SceneModeSpec {
  /**
   * Mode names, in the order the shader's `uMode` branch expects. **Append-only
   * per scene**: the index reaches a uniform and is persisted in presets and
   * cues, so reordering silently changes what a saved look renders.
   */
  modes: string[]
  /**
   * Per-mode slider relabelling, keyed by mode name (or `'*'` for all modes).
   * A `null` label **hides** that slider — the mechanism for a parameter that
   * genuinely does nothing in one mode. Purely cosmetic; it never changes the
   * value a scene reads.
   */
  paramLabels?: Record<string, Partial<Record<SceneParamKey, string | null>>>
}

/**
 * Resolve declared defaults against user overrides into a fully-populated set.
 *
 * Pure and total — every branch yields a usable object, because this sits in the
 * render path and a persisted override naming a mode the scene no longer
 * declares must degrade to the scene's own default rather than render nothing.
 */
export function resolveSceneParams(
  declared: SceneParams | undefined,
  overrides: SceneParams | undefined,
  spec?: SceneModeSpec,
): ResolvedSceneParams {
  const out = {} as ResolvedSceneParams
  for (const key of SCENE_PARAM_KEYS) {
    const raw = overrides?.[key] ?? declared?.[key] ?? DEFAULT_PARAM_VALUE
    // Clamp rather than trust: these values come back from localStorage, an
    // imported preset, and a share URL, none of which are ours to believe.
    out[key] = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : DEFAULT_PARAM_VALUE
  }
  const modes = spec?.modes ?? []
  const wanted = overrides?.mode ?? declared?.mode ?? modes[0] ?? ''
  const index = modes.indexOf(wanted)
  // An unregistered mode name falls back to the scene's first mode, not to the
  // stale name — a scene branching on `uMode` would otherwise render its
  // `else` case, which is usually nothing at all.
  out.mode = index >= 0 ? wanted : (modes[0] ?? '')
  out.modeIndex = index >= 0 ? index : 0
  return out
}

/**
 * Which sliders a scene's panel should show, and what to call them.
 *
 * Returns declared keys only, in {@link SCENE_PARAM_KEYS} order (so the panel
 * layout is stable across scenes rather than following object-literal order),
 * with mode-specific relabelling applied and `null`-labelled keys dropped.
 */
export function visibleSceneParams(
  declared: SceneParams | undefined,
  mode: string,
  spec?: SceneModeSpec,
): { key: SceneParamKey; label: string }[] {
  if (!declared) return []
  const labels = { ...spec?.paramLabels?.['*'], ...spec?.paramLabels?.[mode] }
  const out: { key: SceneParamKey; label: string }[] = []
  for (const key of SCENE_PARAM_KEYS) {
    if (declared[key] === undefined) continue
    const label = labels[key]
    if (label === null) continue
    out.push({ key, label: label ?? key })
  }
  return out
}

/**
 * The active parameters for a scene, refreshed without re-rendering it.
 *
 * Returns one stable object mutated in place, for the same reason
 * `useSceneFrame`'s context is: a scene's GPU resources live in `useMemo(…, [])`
 * and its uniforms are written imperatively, so a React re-render buys nothing
 * and a re-render *per slider frame* while someone drags a control is pure
 * waste. The store subscription writes into the object; the scene reads it
 * inside its frame callback and sees the new value on the next frame.
 *
 * Pass the scene's own registry id. A scene mounted in two slots at once gets
 * two hook instances resolving the same values, which is correct — parameters
 * are a property of the scene, not of the slot (slot gain and blend mode are
 * the per-slot controls, and those live in `layerFx`).
 */
export function useSceneParams(sceneId: string): Readonly<ResolvedSceneParams> {
  // Read through `metadata.contract`, not from flat metadata fields.
  //
  // This module and `scenes/contract.ts` were built independently on the two
  // branches to solve the same problem, and they landed on the same three
  // fields — `params`, `modes`, `paramLabels`. The only real difference is that
  // the engine side wraps them in a versioned envelope, which exists precisely
  // for the third-party case. So the vocabulary and the resolver here are kept
  // and the declaration is read from the envelope.
  const spec = useMemo<SceneModeSpec | undefined>(() => {
    const c = getScene(sceneId).metadata.contract
    return c?.modes ? { modes: c.modes, paramLabels: c.paramLabels } : undefined
  }, [sceneId])

  const declared = useMemo(() => getScene(sceneId).metadata.contract?.params, [sceneId])

  const params = useRef<ResolvedSceneParams>(
    resolveSceneParams(declared, useStore.getState().sceneParams?.[sceneId], spec),
  )

  useEffect(() => {
    const apply = (overrides: SceneParams | undefined) =>
      Object.assign(params.current, resolveSceneParams(declared, overrides, spec))
    // Re-resolve immediately: `sceneId` may have changed since the ref was
    // initialised, and the store may have moved between render and effect.
    apply(useStore.getState().sceneParams?.[sceneId])
    return useStore.subscribe((state, prev) => {
      const next = state.sceneParams?.[sceneId]
      if (next !== prev.sceneParams?.[sceneId]) apply(next)
    })
  }, [sceneId, declared, spec])

  return params.current
}
