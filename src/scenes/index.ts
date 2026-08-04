import { lazy, type ComponentType } from 'react'
import type { MoodState } from '../audio/types'
import type { CameraAnchor } from '../engine/CameraDirector'
import type { CameraMode } from '../engine/performanceState'
import { resolveManifest, type SceneManifestExt } from '../engine/streaming/sceneManifest'

/**
 * Built-in scenes are code-split: each import() below becomes its own chunk,
 * loaded the first time the scene is mounted (or earlier via preloadScene —
 * requestScene/setLayer call it, so the chunk usually arrives well before the
 * downbeat commit). SceneManager wraps scenes in <Suspense fallback={null}>.
 */
const loaders: Record<string, () => Promise<{ default: ComponentType }>> = {
  wireframe: () => import('./WireframeHeroScene').then((m) => ({ default: m.WireframeHeroScene })),
  plasma: () => import('./PlasmaFilamentScene').then((m) => ({ default: m.PlasmaFilamentScene })),
  dissolve: () => import('./DissolveCageScene').then((m) => ({ default: m.DissolveCageScene })),
  chrome: () => import('./ChromeFormScene').then((m) => ({ default: m.ChromeFormScene })),
  ribbons: () => import('./FlowRibbonScene').then((m) => ({ default: m.FlowRibbonScene })),
  network: () => import('./NetworkConstellationScene').then((m) => ({ default: m.NetworkConstellationScene })),
  pointcloud: () => import('./PointCloudScanScene').then((m) => ({ default: m.PointCloudScanScene })),
  inversion: () => import('./InversionMachineScene').then((m) => ({ default: m.InversionMachineScene })),
  foldpath: () => import('./FoldPathScene').then((m) => ({ default: m.FoldPathScene })),
  torusfold: () => import('./TorusFoldScene').then((m) => ({ default: m.TorusFoldScene })),
  juliawings: () => import('./JuliaWingsScene').then((m) => ({ default: m.JuliaWingsScene })),
}

/** Scene chunks whose import() has resolved — drives SceneManager's warm gate. */
const loaded = new Set<string>()

/** Load a scene chunk, recording completion so {@link isSceneLoaded} can report it. */
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
 * warming scene's compile countdown once this is true, so the warm window is
 * spent actually rendering (compiling the shader) rather than waiting on the
 * download — otherwise a slow chunk closes the window before the shader ever
 * compiles and the stall lands back on the beat.
 */
export function isSceneLoaded(id: string): boolean {
  return loaded.has(id)
}

const WireframeHeroScene = lazyScene('wireframe')
const PlasmaFilamentScene = lazyScene('plasma')
const DissolveCageScene = lazyScene('dissolve')
const ChromeFormScene = lazyScene('chrome')
const FlowRibbonScene = lazyScene('ribbons')
const NetworkConstellationScene = lazyScene('network')
const PointCloudScanScene = lazyScene('pointcloud')
const InversionMachineScene = lazyScene('inversion')
const FoldPathScene = lazyScene('foldpath')
const TorusFoldScene = lazyScene('torusfold')
const JuliaWingsScene = lazyScene('juliawings')

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
  /** Higher is a better fit for that mood; used by automatic directors. */
  moodFit?: Partial<Record<MoodState, number>>

  /**
   * Where this scene can be looked at — subject centre, comfortable distance,
   * eye height. Declaring it hands camera control to the CameraDirector; a
   * scene without one keeps driving its own camera (the pre-refactor path).
   * This is the opt-in switch that lets scenes migrate one at a time.
   */
  cameraAnchor?: CameraAnchor
  /** Camera modes that frame this scene well. First entry is the default. */
  cameraModes?: CameraMode[]

  /**
   * Streaming/cost hints for the scene streamer (asset dependencies, VRAM/
   * build-time estimates, load priority). Additive and optional — absent
   * means `resolveManifest()` computes sane defaults from `performanceCost`,
   * so nothing here forces hand-authoring for existing or third-party scenes.
   */
  streaming?: Partial<SceneManifestExt>
}

export interface SceneDef {
  id: string
  name: string
  component: ComponentType
  metadata: SceneMetadata
}

/**
 * The active roster.
 *
 * Automation only ever selects from this array (AutoPilot/PerformanceDirector
 * go through getScenesForMood/getCompatibleScenes), the HUD builds its scene bar
 * and digit shortcuts by mapping it, and getScene() falls back to SCENES[0] for
 * any id it does not find — so a stale persisted sceneId, preset, cue, or
 * `?scene=` param degrades to the fallback instead of breaking.
 *
 * SCENES[0] is that fallback, so it should always be a safe, cheap default.
 */
export const SCENES: SceneDef[] = [
  {
    id: 'wireframe',
    name: 'Wireframe Hero',
    component: WireframeHeroScene,
    metadata: {
      roles: ['primary', 'accent'],
      moods: ['ambient', 'mellow', 'groove', 'building', 'peak', 'aggressive'],
      bands: ['bass', 'mid', 'high', 'energy'],
      intensity: 'medium',
      // Real edge geometry — a few hundred thin quads, cheaper than the
      // barycentric wireframe it supersedes.
      performanceCost: 'low',
      compatibleWith: ['plasma', 'dissolve', 'chrome'],
      moodFit: {
        ambient: 0.66,
        mellow: 0.62,
        groove: 0.8,
        building: 0.86,
        peak: 0.72,
        aggressive: 0.66,
      },
      cameraAnchor: { target: [0, 0, 0], distance: 9.5, height: 1.6 },
      // `push` is what separates this scene's build from its peak — without it
      // every high-energy mood resolves to the same spiral.
      cameraModes: ['orbit', 'cinematic', 'spiral', 'hover', 'push'],
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
      // 70k advected points — the one genuinely heavy scene in the roster.
      performanceCost: 'high',
      compatibleWith: ['wireframe', 'dissolve', 'chrome'],
      moodFit: { groove: 0.7, building: 0.84, peak: 0.94, aggressive: 0.9 },
      // Wide field — the particle cloud needs distance to read as a form.
      cameraAnchor: { target: [0, 0, 0], distance: 17, height: 2.4 },
      cameraModes: ['orbit', 'spiral', 'handheld', 'cinematic'],
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
      compatibleWith: ['wireframe', 'plasma', 'chrome'],
      moodFit: { mellow: 0.66, groove: 0.82, building: 0.88, peak: 0.8 },
      cameraAnchor: { target: [0, 0, 0], distance: 11.5, height: 1.1 },
      cameraModes: ['hover', 'push', 'cinematic', 'locked'],
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
      compatibleWith: ['wireframe', 'plasma', 'dissolve'],
      moodFit: { ambient: 0.7, mellow: 0.84, groove: 0.78, building: 0.7, peak: 0.62 },
      // Specular hero — orbiting is what makes the reflections travel.
      cameraAnchor: { target: [0, 0, 0], distance: 8.2, height: 1.2 },
      cameraModes: ['orbit', 'cinematic', 'spiral', 'topdown', 'pull'],
    },
  },
  {
    id: 'ribbons',
    name: 'Flow Ribbons',
    component: FlowRibbonScene,
    metadata: {
      roles: ['accent', 'overlay'],
      moods: ['ambient', 'mellow', 'groove', 'building', 'peak'],
      bands: ['mid', 'vocal', 'high', 'energy'],
      intensity: 'medium',
      // A few dozen strips, all motion in the vertex shader.
      performanceCost: 'low',
      compatibleWith: ['wireframe', 'chrome', 'dissolve'],
      moodFit: { ambient: 0.97, mellow: 0.96, groove: 0.92, building: 0.98, peak: 0.97 },
      cameraAnchor: { target: [0, 0, 0], distance: 10, height: 1.4 },
      cameraModes: ['cinematic', 'spiral', 'orbit', 'handheld', 'pull'],
    },
  },
  {
    id: 'network',
    name: 'Network Constellation',
    component: NetworkConstellationScene,
    metadata: {
      // Now primary-capable: a fullscreen procedural network shader, bold
      // enough to stand alone rather than only composite under/over another
      // scene.
      roles: ['background', 'accent', 'overlay', 'primary'],
      moods: ['ambient', 'mellow', 'groove', 'building'],
      bands: ['bass', 'mid', 'high', 'energy'],
      intensity: 'medium',
      // Fullscreen shader, ~36 hash evals/pixel — cheaper than the CPU
      // O(n^2) link scan it replaced.
      performanceCost: 'low',
      compatibleWith: ['wireframe', 'chrome', 'pointcloud'],
      moodFit: {
        ambient: 0.90,
        mellow: 0.84,
        groove: 0.76,
        building: 0.70,
      },
      // No cameraAnchor/cameraModes: the scene is a fullscreen quad whose
      // vertex shader ignores the camera transform entirely (clip-space
      // positions, per FULLSCREEN_VERT), and — unlike an earlier version of
      // this scene — it no longer reads ctx.camera either, so declaring
      // camera fields here would be dead config. Its motion is driven by
      // audio (bass/mid/high/energy/pulse) and an autonomous slow drift
      // instead.
    },
  },
  {
    id: 'pointcloud',
    name: 'PCD LIDAR Scan',
    component: PointCloudScanScene,
    metadata: {
      // Exclusively primary as requested, serving as the central visual subject
      roles: ['primary'],
      moods: ['ambient', 'mellow', 'groove', 'building', 'peak'],
      bands: ['bass', 'high', 'energy'],
      intensity: 'high',
      // High particle density (60k points), similar to PlasmaFilamentScene
      performanceCost: 'high',
      compatibleWith: ['wireframe', 'dissolve', 'ribbons'],
      moodFit: {
        ambient: 0.78,
        mellow: 0.82,
        groove: 0.86,
        building: 0.90,
        peak: 0.88,
      },
      cameraAnchor: { target: [0, 0, 0], distance: 11.0, height: 1.4 },
      cameraModes: ['orbit', 'cinematic', 'spiral', 'handheld', 'push'],
    },
  },
  {
    id: 'inversion',
    name: 'Inversion Machine',
    component: InversionMachineScene,
    metadata: {
      // The first true raymarched-SDF scene in the roster: a sphere-inversion
      // fractal, dense and alien enough to carry a frame on its own.
      roles: ['primary'],
      // Fills a real gap: aggressive was previously only covered by
      // wireframe/plasma, and nothing else brought lit-surface raymarching.
      moods: ['groove', 'building', 'peak', 'aggressive'],
      bands: ['bass', 'mid', 'high', 'energy'],
      intensity: 'high',
      // ~60-step raymarch + 6 calcNormal() calls/pixel, governed by uMaxSteps.
      performanceCost: 'high',
      compatibleWith: ['wireframe', 'network', 'ribbons'],
      moodFit: {
        groove: 0.68,
        building: 0.82,
        peak: 0.92,
        aggressive: 0.9,
      },
      // The field's own coordinate scale is small (see InversionMachineScene's
      // ANCHOR_DISTANCE comment) — a much closer anchor than other scenes'
      // 8-17 range, tuned to the source shader's original ~1.2-unit distance.
      cameraAnchor: { target: [0, 0, 0], distance: 1.4, height: 0.15 },
      cameraModes: ['orbit', 'push', 'hover', 'handheld', 'cinematic'],
    },
  },
  {
    id: 'foldpath',
    name: 'Fold Path',
    component: FoldPathScene,
    metadata: {
      // Dense and glowing enough to carry a frame alone, same reasoning as
      // pointcloud/inversion.
      roles: ['primary'],
      // A hypnotic flythrough rather than a violent one — sits alongside
      // inversion's aggressive slot instead of doubling up on it.
      moods: ['ambient', 'mellow', 'groove', 'building'],
      bands: ['bass', 'mid', 'high', 'energy'],
      intensity: 'high',
      // Fixed-step heightfield march, up to 600 steps/pixel plus a 20-step
      // binary-search refine and 4 normal() samples — the heaviest scene in
      // the roster; see FoldPathScene's own quality-governor comment.
      performanceCost: 'high',
      compatibleWith: ['wireframe', 'network', 'ribbons'],
      moodFit: {
        ambient: 0.72,
        mellow: 0.8,
        groove: 0.76,
        building: 0.7,
      },
      // No cameraAnchor/cameraModes: the scene flies its own scripted path()
      // camera rather than reading the real one — see FoldPathScene's header
      // comment for why (the flythrough IS the piece, unlike inversion's
      // orbit-a-static-object case).
    },
  },
  {
    id: 'torusfold',
    name: 'Torus Fold',
    component: TorusFoldScene,
    metadata: {
      // A fixed, orbitable fold+torus structure — dense enough to carry a
      // frame alone, same reasoning as the other raymarch scenes.
      roles: ['primary'],
      // Hypnotic ring-pulse rather than glitchy or violent — spans a wider
      // mood range than foldpath since it has real punch at peak too.
      moods: ['mellow', 'groove', 'building', 'peak'],
      bands: ['bass', 'mid', 'high', 'energy'],
      intensity: 'high',
      // 100-step adaptive SDF march, 6-iteration fold per step — cheaper
      // than inversion (no per-step normal calc) but still substantial.
      performanceCost: 'high',
      compatibleWith: ['wireframe', 'network', 'ribbons'],
      moodFit: {
        mellow: 0.7,
        groove: 0.8,
        building: 0.78,
        peak: 0.74,
      },
      // Real camera, like inversion: the fold+torus structure sits fixed at
      // the origin (only its internal fold rotates), so orbiting it is the
      // natural fit — see TorusFoldScene's header comment for the
      // camera-vs-self-contained decision this session settled on.
      cameraAnchor: { target: [0, 0, 0], distance: 3.3, height: 0 },
      cameraModes: ['orbit', 'push', 'hover', 'handheld', 'cinematic'],
    },
  },
  {
    id: 'juliawings',
    name: 'Julia Wings',
    component: JuliaWingsScene,
    metadata: {
      // Vivid and dense enough to hold a frame alone — deliberately not
      // accent/overlay: this one was explicitly tuned brighter than the
      // roster's usual budget (see JuliaWingsScene's BRIGHTNESS comment),
      // which would read as too loud composited as a layer over a primary.
      roles: ['primary'],
      // Broad range on purpose — a hypnotic, colorful piece rather than a
      // violent one, versatile enough to hold peak too.
      moods: ['ambient', 'mellow', 'groove', 'building', 'peak'],
      bands: ['bass', 'mid', 'high', 'energy'],
      intensity: 'high',
      // 64 iterations x up to 3 AA taps/pixel, quality-gated on both axes
      // (iteration count and whether the extra taps run at all).
      performanceCost: 'high',
      compatibleWith: ['wireframe', 'network', 'ribbons'],
      moodFit: {
        ambient: 0.8,
        mellow: 0.85,
        groove: 0.8,
        building: 0.78,
        peak: 0.82,
      },
      // No cameraAnchor/cameraModes: pure 2D math, no ray/camera concept at
      // all (unlike inversion/torusfold) — same reasoning as network/foldpath.
    },
  },
]

/**
 * Look up a scene by id, falling back to `SCENES[0]`.
 *
 * The fallback is deliberate and load-bearing: a persisted `sceneId`, a preset,
 * a cue, or a `?scene=` param can all name a scene that is no longer registered,
 * and every one of those must degrade to a working scene rather than throw.
 */
export function getScene(id: string): SceneDef {
  return SCENES.find((s) => s.id === id) ?? SCENES[0]
}

/** Resolved manifests, memoized per scene id — computed once, not per-frame. */
const manifestCache = new Map<string, SceneManifestExt>()

/**
 * The scene's fully-resolved streaming manifest (cost/priority/assets),
 * computed from `metadata.streaming` with defaults filled in from
 * `performanceCost`. Never called from `getScene()`'s own lookup path, so a
 * stale id still degrades via the `SCENES[0]` fallback exactly as before this
 * existed.
 */
export function getResolvedManifest(id: string): SceneManifestExt {
  const cached = manifestCache.get(id)
  if (cached) return cached
  const scene = getScene(id)
  const resolved = resolveManifest(scene.metadata.performanceCost, scene.metadata.streaming)
  manifestCache.set(id, resolved)
  return resolved
}

/**
 * Scenes tagged for a mood, best fit first (`moodFit`, defaulting to 0.5 when a
 * scene declares the mood but gives it no explicit score). This is the pool both
 * autonomy directors pick from, so ordering here directly shapes the show.
 */
export function getScenesForMood(mood: MoodState): SceneDef[] {
  return SCENES.filter((s) => s.metadata.moods.includes(mood)).sort(
    (a, b) => (b.metadata.moodFit?.[mood] ?? 0.5) - (a.metadata.moodFit?.[mood] ?? 0.5),
  )
}

/**
 * Scenes the given scene is declared to layer well with.
 *
 * Silently drops ids that resolve to nothing, which is what makes unregistering
 * a scene safe without having to scrub every other scene's `compatibleWith`.
 */
export function getCompatibleScenes(id: string): SceneDef[] {
  const scene = getScene(id)
  return scene.metadata.compatibleWith
    .map((compatibleId) => SCENES.find((s) => s.id === compatibleId))
    .filter((s): s is SceneDef => Boolean(s))
}

/**
 * Collect problems with a scene definition; empty array means valid. Used by
 * {@link registerScene} to reject malformed third-party scenes at registration
 * time rather than letting them fail later inside the render loop.
 */
export function validateSceneDef(def: SceneDef): string[] {
  const issues: string[] = []
  if (!def.id.trim()) issues.push('Scene id is required.')
  if (!def.name.trim()) issues.push(`Scene "${def.id}" needs a display name.`)
  if (def.metadata.roles.length === 0) issues.push(`Scene "${def.id}" needs at least one role.`)
  if (def.metadata.moods.length === 0) issues.push(`Scene "${def.id}" needs at least one mood.`)
  if (def.metadata.bands.length === 0)
    issues.push(`Scene "${def.id}" needs at least one audio band.`)
  return issues
}

/**
 * Extension point: register a scene from outside the core bundle (plugin, custom
 * build, future marketplace). Call before the app mounts so it appears in the
 * scene bar and can be picked by the autonomy directors.
 *
 * Intentionally has no in-repo callers — it is public API documented in
 * README.md / ARCHITECTURE.md, not dead code. Do not "clean it up".
 */
export function registerScene(def: SceneDef) {
  const issues = validateSceneDef(def)
  if (issues.length > 0) {
    throw new Error(`Invalid scene registration:\n${issues.join('\n')}`)
  }
  if (!SCENES.some((s) => s.id === def.id)) SCENES.push(def)
}
