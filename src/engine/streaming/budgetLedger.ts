import type { SceneLifecycleStatus } from './lifecycle'
import { isEvictable } from './lifecycle'

/**
 * The memory/budget algorithm. Three distinct, deliberately non-conflated
 * layers, since browsers expose no real VRAM query API
 * (`WEBGL_debug_renderer_info` gives a GPU name string, nothing more):
 *
 * 1. `performanceCost` (existing enum, `src/scenes/index.ts`) — untouched,
 *    still the sole input to the existing hard-cut/`maxHeavyLayers` logic.
 *    Tracks per-frame shader/ALU cost, not memory.
 * 2. Pre-build estimate (`SceneManifestExt.cost`) — used only to decide
 *    whether it's worth STARTING a fetch/build before anything is parsed.
 * 3. Measured (`ResourceCache.reportByteSize`) — once a resource is
 *    actually built, its real GPU byte cost is computable exactly. This
 *    module consumes whichever of #2/#3 the caller has for each entry; it
 *    doesn't care which, only that eviction never touches ACTIVE and never
 *    disrupts in-flight LOADING/PREWARMING work.
 */

export interface LedgerEntry {
  sceneId: string
  status: SceneLifecycleStatus
  vramMB: number
  measured: boolean
  priority: number
  lastActiveAtSec: number
}

export interface BudgetVerdict {
  totalMB: number
  ceilingMB: number
  overBy: number
  /** Scene ids to tear down, lowest-value first, sufficient to clear `overBy`. */
  evictionCandidates: string[]
}

/**
 * VRAM ceiling per quality tier, MB. Tier 0 (richest) gets the most headroom;
 * tier 4 (survival) the least — deliberately shedding background candidates
 * BEFORE the visible frame's own tier has to drop, since evicting a
 * READY/BACKGROUND scene is invisible while a renderScale/raymarchSteps cut
 * is not.
 *
 * Tuning guess, not a measured number — nothing in today's roster is
 * VRAM-heavy enough to calibrate against. Revisit once a real GLTF/KTX2
 * scene exists to measure.
 */
const CEILING_BY_TIER = [512, 384, 256, 192, 128]

export function ceilingForTier(tier: number): number {
  return CEILING_BY_TIER[Math.max(0, Math.min(CEILING_BY_TIER.length - 1, tier))]
}

/**
 * Only READY/BACKGROUND entries are evictable — ACTIVE is untouchable
 * (nothing may cut what's on screen), LOADING/PREWARMING are left to finish
 * rather than wasting in-flight work. Sorted lowest-priority, stalest-first.
 */
export function evaluateLedger(entries: LedgerEntry[], ceilingMB: number): BudgetVerdict {
  const totalMB = entries.reduce((sum, e) => sum + e.vramMB, 0)
  const overBy = Math.max(0, totalMB - ceilingMB)
  if (overBy <= 0) {
    return { totalMB, ceilingMB, overBy: 0, evictionCandidates: [] }
  }

  const evictable = entries
    .filter((e) => isEvictable(e.status))
    .sort((a, b) => a.priority - b.priority || a.lastActiveAtSec - b.lastActiveAtSec)

  const evictionCandidates: string[] = []
  let freed = 0
  for (const entry of evictable) {
    if (freed >= overBy) break
    evictionCandidates.push(entry.sceneId)
    freed += entry.vramMB
  }
  return { totalMB, ceilingMB, overBy, evictionCandidates }
}
