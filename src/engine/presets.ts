import { SCENES } from '../scenes'
import type { LayerFx, LayerRole, PerformanceCue, VisualParams } from '../store'

export interface Preset {
  id: string
  name: string
  sceneId: string
  accentSceneId?: string | null
  overlaySceneId?: string | null
  /** Per-layer intensity/blend captured with the preset (optional, additive). */
  layerFx?: Record<LayerRole, LayerFx>
  /** Authored performance timeline captured with the preset (optional). */
  cues?: PerformanceCue[]
  paletteId: string
  params: VisualParams
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
  return { accent: clean(o.accent), overlay: clean(o.overlay) }
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
      accentSceneId: known(c.accentSceneId) ? (c.accentSceneId as string) : null,
      overlaySceneId: known(c.overlaySceneId) ? (c.overlaySceneId as string) : null,
      paletteId: typeof c.paletteId === 'string' ? c.paletteId : 'aurora',
      params: {
        intensity: num(p.intensity, 1),
        speed: num(p.speed, 1),
        reactivity: num(p.reactivity, 1),
      },
      layerFx:
        sanitizeLayerFx(c.layerFx) ?? {
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

/** Validate an imported preset-ish object; returns a clean Preset or null. */
export function sanitizePreset(raw: unknown): Preset | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (typeof o.name !== 'string' || typeof o.sceneId !== 'string' || typeof o.paletteId !== 'string')
    return null
  const p = (o.params ?? {}) as Record<string, unknown>
  const num = (v: unknown, d: number) =>
    typeof v === 'number' && isFinite(v) ? Math.min(2, Math.max(0.2, v)) : d
  return {
    id: typeof o.id === 'string' && !o.id.startsWith('builtin-') ? o.id : crypto.randomUUID(),
    name: o.name.slice(0, 40),
    sceneId: o.sceneId,
    accentSceneId: typeof o.accentSceneId === 'string' ? o.accentSceneId : null,
    overlaySceneId: typeof o.overlaySceneId === 'string' ? o.overlaySceneId : null,
    layerFx: sanitizeLayerFx(o.layerFx),
    cues: sanitizeCues(o.cues),
    paletteId: o.paletteId,
    params: {
      intensity: num(p.intensity, 1),
      speed: num(p.speed, 1),
      reactivity: num(p.reactivity, 1),
    },
  }
}
