import { SCENES, getSceneContract, resolveSceneMode } from '../scenes'
import { sanitizeParamBlock, type SceneParams } from '../scenes/contract'
import type { LayerFx, LayerRole, PerformanceCue, VisualParams } from '../store'

export interface Preset {
  id: string
  name: string
  sceneId: string
  /**
   * Composition slots. Optional and partial so a preset shared before the
   * background slot existed — or one authored by hand — still loads; the
   * sanitizer fills the rest. `accentSceneId`/`overlaySceneId` are the pre-v1
   * spelling, still read here because presets also arrive by import and URL,
   * paths the store's persist migration never sees.
   */
  layerSceneIds?: Partial<Record<LayerRole, string | null>>
  accentSceneId?: string | null
  overlaySceneId?: string | null
  /** Per-layer intensity/blend captured with the preset (optional, additive). */
  layerFx?: Record<LayerRole, LayerFx>
  /** Authored performance timeline captured with the preset (optional). */
  cues?: PerformanceCue[]
  paletteId: string
  params: VisualParams

  /**
   * Scene Contract dial positions, in the shared vocabulary.
   *
   * Stored contract-AGNOSTICALLY — the whole seven-name block, not just the
   * keys the preset's scene happens to honour. That is what lets a preset be
   * re-pointed at a different scene and still mean something: `retargetPreset`
   * hands the same block to the new scene, which keeps whatever it declares and
   * ignores the rest. Sanitizing at save time would have thrown those keys away
   * before the swap could ever use them.
   *
   * Optional: a preset written before v1 (or by hand) simply carries no dials
   * and the target scene's own defaults stand.
   */
  sceneParams?: SceneParams
  /** Scene mode captured with the preset. Dropped if the target scene has no such mode. */
  sceneMode?: string

  builtIn?: boolean
}

const BLENDS = ['add', 'screen', 'normal', 'multiply'] as const

function sanitizeLayerFx(raw: unknown): Record<LayerRole, LayerFx> | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const o = raw as Record<string, { intensity?: unknown; blend?: unknown }>
  const clean = (v: { intensity?: unknown; blend?: unknown } | undefined): LayerFx => ({
    intensity:
      typeof v?.intensity === 'number' && isFinite(v.intensity)
        ? Math.min(1.5, Math.max(0, v.intensity))
        : 1,
    blend: BLENDS.includes(v?.blend as (typeof BLENDS)[number])
      ? (v?.blend as LayerFx['blend'])
      : 'add',
  })
  // Background defaults dimmer than the detail slots — it is the ground, not a
  // second subject. Matches the store's own defaultLayerFx.
  return {
    background: o.background ? clean(o.background) : { intensity: 0.4, blend: 'add' },
    accent: clean(o.accent),
    overlay: clean(o.overlay),
  }
}

/**
 * Composition slots from a stored/imported object, accepting both the record
 * and the pre-v1 pair of scalars. Unknown scene ids are dropped rather than
 * carried, matching how the rest of this file treats a stale id.
 */
function sanitizeLayerScenes(
  raw: unknown,
  legacy: { accentSceneId?: unknown; overlaySceneId?: unknown },
): Record<LayerRole, string | null> {
  const known = (id: unknown) => (typeof id === 'string' && SCENES.some((s) => s.id === id) ? id : null)
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  return {
    background: known(o.background),
    accent: known(o.accent) ?? known(legacy.accentSceneId),
    overlay: known(o.overlay) ?? known(legacy.overlaySceneId),
  }
}

/** Validate imported cues; cues pointing at unregistered scenes are dropped. */
function sanitizeCues(raw: unknown): PerformanceCue[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const known = (id: unknown) => typeof id === 'string' && SCENES.some((s) => s.id === id)
  const num = (v: unknown, d: number) =>
    typeof v === 'number' && isFinite(v) ? Math.min(2, Math.max(0.2, v)) : d
  const cues: PerformanceCue[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const c = item as Record<string, unknown>
    if (!known(c.sceneId)) continue
    if (typeof c.beat !== 'number' || !isFinite(c.beat) || c.beat < 0) continue
    const p = (c.params ?? {}) as Record<string, unknown>
    cues.push({
      id: typeof c.id === 'string' ? c.id : crypto.randomUUID(),
      beat: Math.round(c.beat),
      sceneId: c.sceneId as string,
      layerSceneIds: sanitizeLayerScenes(c.layerSceneIds, c),
      paletteId: typeof c.paletteId === 'string' ? c.paletteId : 'aurora',
      params: {
        intensity: num(p.intensity, 1),
        speed: num(p.speed, 1),
        reactivity: num(p.reactivity, 1),
      },
      layerFx: sanitizeLayerFx(c.layerFx) ?? {
        background: { intensity: 0.4, blend: 'add' },
        accent: { intensity: 1, blend: 'add' },
        overlay: { intensity: 1, blend: 'add' },
      },
    })
  }
  cues.sort((a, b) => a.beat - b.beat)
  return cues.length > 0 ? cues : undefined
}

/**
 * One preset per registered scene, each picking the palette and response that
 * shows that look at its best. Trimmed alongside the scene cull (docs/09_Rendering_Engine.md)
 * — the previous eight all pointed at unregistered scenes, which would have
 * silently collapsed every one of them onto the SCENES[0] fallback.
 */
export const BUILTIN_PRESETS: Preset[] = [
  {
    id: 'builtin-blueprint',
    name: 'Blueprint',
    sceneId: 'wireframe',
    paletteId: 'aurora',
    params: { intensity: 1, speed: 0.8, reactivity: 1.1 },
    builtIn: true,
  },
  {
    id: 'builtin-ion-core',
    name: 'Ion Core',
    sceneId: 'plasma',
    paletteId: 'ember',
    params: { intensity: 1.1, speed: 1, reactivity: 1.4 },
    builtIn: true,
  },
  {
    id: 'builtin-reassembly',
    name: 'Reassembly',
    sceneId: 'dissolve',
    paletteId: 'violet',
    params: { intensity: 1, speed: 0.9, reactivity: 1.2 },
    builtIn: true,
  },
  {
    id: 'builtin-liquid-metal',
    name: 'Liquid Metal',
    sceneId: 'chrome',
    paletteId: 'ocean',
    params: { intensity: 1, speed: 0.75, reactivity: 1 },
    builtIn: true,
  },
]

/**
 * Point a preset at a different scene, keeping everything the new scene can
 * honour.
 *
 * The concrete reason the Scene Contract's vocabulary is shared. Before it, a
 * preset's look was a bag of private uniforms that meant nothing outside one
 * scene, so "same look, different scene" was not a request the system could
 * even represent — the dials collapsed to defaults and the user re-dialled by
 * hand. Now `complexity: 0.8` is a sentence both scenes understand, so the
 * request has an answer.
 *
 * Deliberately lossy in one direction only: keys the target scene does not
 * declare are dropped from what it will USE, but the preset returned keeps the
 * full block, so retargeting A→B→A is not a one-way trip through B's smaller
 * vocabulary.
 */
export function retargetPreset(preset: Preset, sceneId: string): Preset {
  return {
    ...preset,
    id: crypto.randomUUID(),
    sceneId,
    // Full block preserved on purpose (see above); the mode cannot survive,
    // because a mode name is scene-private in a way a parameter name is not.
    sceneParams: preset.sceneParams ? { ...preset.sceneParams } : undefined,
    sceneMode: resolveSceneMode(sceneId, preset.sceneMode),
    builtIn: false,
  }
}

/** Validate an imported preset-ish object; returns a clean Preset or null. */
export function sanitizePreset(raw: unknown): Preset | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (
    typeof o.name !== 'string' ||
    typeof o.sceneId !== 'string' ||
    typeof o.paletteId !== 'string'
  )
    return null
  const p = (o.params ?? {}) as Record<string, unknown>
  const num = (v: unknown, d: number) =>
    typeof v === 'number' && isFinite(v) ? Math.min(2, Math.max(0.2, v)) : d
  return {
    id: typeof o.id === 'string' && !o.id.startsWith('builtin-') ? o.id : crypto.randomUUID(),
    name: o.name.slice(0, 40),
    sceneId: o.sceneId,
    layerSceneIds: sanitizeLayerScenes(o.layerSceneIds, o),
    layerFx: sanitizeLayerFx(o.layerFx),
    cues: sanitizeCues(o.cues),
    paletteId: o.paletteId,
    params: {
      intensity: num(p.intensity, 1),
      speed: num(p.speed, 1),
      reactivity: num(p.reactivity, 1),
    },
    // Vocabulary-checked but NOT contract-checked — see Preset.sceneParams.
    // The mode is contract-checked, because an unknown mode name has no generic
    // meaning to preserve and resolveSceneMode degrades it to the scene default.
    sceneParams: sanitizeParamBlock(o.sceneParams),
    sceneMode: getSceneContract(o.sceneId)
      ? resolveSceneMode(o.sceneId, o.sceneMode)
      : undefined,
  }
}
