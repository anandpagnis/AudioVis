/**
 * Extended per-scene streaming manifest — what the engine needs to know about
 * a scene before/while loading it, beyond the existing `SceneMetadata` (roles,
 * moods, bands, `performanceCost`).
 *
 * Deliberately has no import from `src/scenes/index.ts` — that file imports
 * from here, not the reverse, so there's no cycle.
 *
 * Every field is optional at the declaration site (`SceneDef.metadata.streaming`)
 * and resolved to a real value here, so none of the existing scenes need to
 * hand-author anything for this to work.
 */

export type AssetKind = 'gltf' | 'texture' | 'ktx2'

export interface SceneAssetRef {
  type: AssetKind
  url: string
  draco?: boolean
  /**
   * Author-declared, pre-parse budgeting only — real byte size isn't knowable
   * until the loader actually resolves the asset.
   */
  estBytes?: number
}

export type CostSource = 'estimated' | 'measured'

export interface SceneCost {
  /** Pre-build VRAM estimate, MB. A resource cache report can supersede this
   *  once the scene's resources are actually built — see `ResourceCache`. */
  vramMB: number
  /** Estimated main-thread-equivalent build cost, ms — regardless of whether
   *  that work ultimately runs on a worker. */
  buildMs: number
  source: CostSource
}

export interface SceneManifestExt {
  assets: SceneAssetRef[]
  /** Loading priority — higher loads first under contention. Neutral = 0. */
  priority: number
  /** End-to-end LOADING+PREWARMING estimate, ms. */
  estPreloadMs: number
  cost: SceneCost
  /**
   * Optional per-quality-tier fidelity override. Absent means the scene only
   * obeys the global `quality.knobs` — today's behavior for all 5 built-ins.
   */
  qualityLevels?: Partial<Record<number, { drawFraction: number }>>
}

/**
 * Small fallback table keyed by the EXISTING `performanceCost` enum. This is
 * an orthogonal axis, not a replacement: today's one 'high' scene (Plasma,
 * 70k particles) has a large per-frame shader cost but a tiny (~2MB) real
 * VRAM footprint. Conflating the two would be a real bug, so `performanceCost`
 * stays exactly as-is, feeding only the existing hard-cut/maxHeavyLayers logic.
 */
const DEFAULT_COST: Record<'low' | 'medium' | 'high', SceneCost> = {
  low: { vramMB: 8, buildMs: 5, source: 'estimated' },
  medium: { vramMB: 24, buildMs: 15, source: 'estimated' },
  high: { vramMB: 64, buildMs: 40, source: 'estimated' },
}

/**
 * Fills every `SceneManifestExt` field a scene doesn't declare. Called once
 * per scene (memoized by the caller — see `getResolvedManifest` in
 * `src/scenes/index.ts`), never per-frame.
 */
export function resolveManifest(
  performanceCost: 'low' | 'medium' | 'high',
  declared?: Partial<SceneManifestExt>,
): SceneManifestExt {
  const defaultCost = DEFAULT_COST[performanceCost]
  return {
    assets: declared?.assets ?? [],
    priority: declared?.priority ?? 0,
    estPreloadMs: declared?.estPreloadMs ?? defaultCost.buildMs * 4,
    cost: declared?.cost ?? defaultCost,
    qualityLevels: declared?.qualityLevels,
  }
}
