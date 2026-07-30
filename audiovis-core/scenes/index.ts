import { lazy, type ComponentType } from 'react'
import type { MoodState } from '../audio/types'

/**
 * Scene registry. Each import() below becomes its own chunk, loaded the first
 * time the scene mounts (or earlier via preloadScene). SceneManager wraps scenes
 * in <Suspense fallback={null}>.
 *
 * To add a scene: write the component honouring the scene contract (see
 * FRESH-START.md §5), then add a loader entry, a lazyScene binding, and a SCENES
 * entry. Nothing else in the engine needs to change.
 */
const loaders: Record<string, () => Promise<{ default: ComponentType }>> = {
  schematic: () => import('./SchematicScene').then((m) => ({ default: m.SchematicScene })),
  wireframe: () => import('./WireframeHeroScene').then((m) => ({ default: m.WireframeHeroScene })),
  plasma: () => import('./PlasmaFilamentScene').then((m) => ({ default: m.PlasmaFilamentScene })),
  dissolve: () => import('./DissolveCageScene').then((m) => ({ default: m.DissolveCageScene })),
  chrome: () => import('./ChromeFormScene').then((m) => ({ default: m.ChromeFormScene })),
}

/** Scene chunks whose import() has resolved — drives SceneManager's warm gate. */
const loaded = new Set<string>()

function load(id: string): Promise<{ default: ComponentType }> {
  return loaders[id]().then((m) => {
    loaded.add(id)
    return m
  })
}

const lazyScene = (id: string): ComponentType => lazy(() => load(id))

/** Kick off a scene chunk download without mounting it. Safe to call often. */
export function preloadScene(id: string): void {
  if (loaders[id]) void load(id).catch(() => {})
}

/**
 * Has the scene's lazy chunk finished loading? SceneManager only starts a
 * warming scene's shader-compile countdown once this is true, so the warm window
 * is spent actually rendering rather than waiting on the download — otherwise a
 * slow chunk closes the window before the shader compiles and the compile stall
 * lands exactly on the beat.
 */
export function isSceneLoaded(id: string): boolean {
  return loaded.has(id)
}

const SchematicScene = lazyScene('schematic')
const WireframeHeroScene = lazyScene('wireframe')
const PlasmaFilamentScene = lazyScene('plasma')
const DissolveCageScene = lazyScene('dissolve')
const ChromeFormScene = lazyScene('chrome')

export type SceneRole = 'background' | 'primary' | 'accent' | 'overlay'
export type SceneBand = 'bass' | 'mid' | 'high' | 'vocal' | 'energy'
export type SceneIntensity = 'calm' | 'medium' | 'high'
export type ScenePerformanceCost = 'low' | 'medium' | 'high'

export interface SceneMetadata {
  roles: SceneRole[]
  moods: MoodState[]
  bands: SceneBand[]
  intensity: SceneIntensity
  compatibleWith: string[]
  performanceCost: ScenePerformanceCost
  /** Higher is a better fit for that mood; used by the automatic directors. */
  moodFit?: Partial<Record<MoodState, number>>
}

export interface SceneDef {
  id: string
  name: string
  component: ComponentType
  metadata: SceneMetadata
}

/**
 * The active roster — deliberately small.
 *
 * Every scene here holds a SUBJECT, keeps real NEGATIVE SPACE, and carries HARD
 * EDGES. That rubric exists because an earlier 17-scene roster of fullscreen
 * haze fields and environment flythroughs failed all three and read as tech
 * demos rather than art direction. Resist growing this list for variety's sake:
 * three or four refined looks beat seventeen decent ones.
 *
 * SCENES[0] is the fallback returned by getScene() for any unknown id, so it
 * must always be a safe, cheap default.
 */
export const SCENES: SceneDef[] = [
  {
    id: 'schematic',
    name: 'Schematic',
    component: SchematicScene,
    metadata: {
      roles: ['primary', 'accent'],
      moods: ['mellow', 'groove', 'building', 'peak', 'aggressive'],
      bands: ['bass', 'mid', 'high', 'energy'],
      intensity: 'medium',
      performanceCost: 'low',
      compatibleWith: ['wireframe', 'plasma', 'dissolve', 'chrome'],
      moodFit: { mellow: 0.5, groove: 0.74, building: 0.82, peak: 0.7, aggressive: 0.64 },
    },
  },
  {
    id: 'wireframe',
    name: 'Wireframe Hero',
    component: WireframeHeroScene,
    metadata: {
      roles: ['primary', 'accent'],
      moods: ['ambient', 'mellow', 'groove', 'building', 'peak', 'aggressive'],
      bands: ['bass', 'mid', 'high', 'energy'],
      intensity: 'medium',
      performanceCost: 'low',
      compatibleWith: ['schematic', 'plasma', 'dissolve', 'chrome'],
      moodFit: { ambient: 0.66, mellow: 0.62, groove: 0.8, building: 0.86, peak: 0.72, aggressive: 0.66 },
    },
  },
  {
    id: 'plasma',
    name: 'Plasma Filament',
    component: PlasmaFilamentScene,
    metadata: {
      roles: ['primary', 'accent', 'overlay'],
      moods: ['groove', 'building', 'peak', 'aggressive'],
      bands: ['bass', 'high', 'energy'],
      intensity: 'high',
      performanceCost: 'high',
      compatibleWith: ['schematic', 'wireframe', 'dissolve', 'chrome'],
      moodFit: { groove: 0.7, building: 0.84, peak: 0.94, aggressive: 0.9 },
    },
  },
  {
    id: 'dissolve',
    name: 'Dissolve Cage',
    component: DissolveCageScene,
    metadata: {
      roles: ['primary'],
      moods: ['mellow', 'groove', 'building', 'peak'],
      bands: ['bass', 'mid', 'energy'],
      intensity: 'medium',
      performanceCost: 'medium',
      compatibleWith: ['schematic', 'wireframe', 'plasma', 'chrome'],
      moodFit: { mellow: 0.66, groove: 0.82, building: 0.88, peak: 0.8 },
    },
  },
  {
    id: 'chrome',
    name: 'Chrome Form',
    component: ChromeFormScene,
    metadata: {
      roles: ['primary'],
      moods: ['ambient', 'mellow', 'groove', 'building', 'peak'],
      bands: ['bass', 'high', 'energy'],
      intensity: 'medium',
      performanceCost: 'medium',
      compatibleWith: ['schematic', 'wireframe', 'plasma', 'dissolve'],
      moodFit: { ambient: 0.7, mellow: 0.84, groove: 0.78, building: 0.7, peak: 0.62 },
    },
  },
]

export function getScene(id: string): SceneDef {
  return SCENES.find((s) => s.id === id) ?? SCENES[0]
}

export function getScenesForMood(mood: MoodState): SceneDef[] {
  return SCENES.filter((s) => s.metadata.moods.includes(mood)).sort(
    (a, b) => (b.metadata.moodFit?.[mood] ?? 0.5) - (a.metadata.moodFit?.[mood] ?? 0.5),
  )
}

export function getScenesForRole(role: SceneRole): SceneDef[] {
  return SCENES.filter((s) => s.metadata.roles.includes(role))
}

export function getScenesForBand(band: SceneBand): SceneDef[] {
  return SCENES.filter((s) => s.metadata.bands.includes(band))
}

export function getCompatibleScenes(id: string): SceneDef[] {
  const scene = getScene(id)
  return scene.metadata.compatibleWith
    .map((compatibleId) => SCENES.find((s) => s.id === compatibleId))
    .filter((s): s is SceneDef => Boolean(s))
}

export function isSceneCompatible(a: string, b: string): boolean {
  return getScene(a).metadata.compatibleWith.includes(b) || getScene(b).metadata.compatibleWith.includes(a)
}

export function validateSceneDef(def: SceneDef): string[] {
  const issues: string[] = []
  if (!def.id.trim()) issues.push('Scene id is required.')
  if (!def.name.trim()) issues.push(`Scene "${def.id}" needs a display name.`)
  if (def.metadata.roles.length === 0) issues.push(`Scene "${def.id}" needs at least one role.`)
  if (def.metadata.moods.length === 0) issues.push(`Scene "${def.id}" needs at least one mood.`)
  if (def.metadata.bands.length === 0) issues.push(`Scene "${def.id}" needs at least one audio band.`)
  return issues
}

/** Extension point: register a scene from outside the core bundle. */
export function registerScene(def: SceneDef) {
  const issues = validateSceneDef(def)
  if (issues.length > 0) {
    throw new Error(`Invalid scene registration:\n${issues.join('\n')}`)
  }
  if (!SCENES.some((s) => s.id === def.id)) SCENES.push(def)
}
