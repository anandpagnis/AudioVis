import { lazy, type ComponentType } from 'react'
import type * as THREE from 'three'
import type { MoodState } from '../audio/types'
import type { CameraAnchor } from '../engine/CameraDirector'
import type { CameraMode } from '../engine/performanceState'
import { deriveVA } from '../engine/moodValenceArousal'
import { MAX_PIXEL_BUDGET, MIN_PIXEL_BUDGET, resolvePixelBudget } from '../engine/renderScale'
import { vaDistance, type ValenceArousal } from '../engine/valenceArousal'
import { resolveManifest, type SceneManifestExt } from '../engine/streaming/sceneManifest'
import {
  resolveMode,
  summarizeContract,
  validateContract,
  type SceneContract,
  type SceneContractSummary,
} from './contract'

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
  heap: () => import('./HeapCorruptionScene').then((m) => ({ default: m.HeapCorruptionScene })),
  tunnel: () => import('./TunnelDriftScene').then((m) => ({ default: m.TunnelDriftScene })),
  orbs: () => import('./OrbitGlowScene').then((m) => ({ default: m.OrbitGlowScene })),
  kaleido: () => import('./KaleidoPulseScene').then((m) => ({ default: m.KaleidoPulseScene })),
  trail: () => import('./TrailLineScene').then((m) => ({ default: m.TrailLineScene })),
  synthgrid: () => import('./SynthGridScene').then((m) => ({ default: m.SynthGridScene })),
  panic: () => import('./KernelPanicScene').then((m) => ({ default: m.KernelPanicScene })),
  malachite: () => import('./MalachiteScene').then((m) => ({ default: m.MalachiteScene })),
  matrix: () => import('./MatrixRainScene').then((m) => ({ default: m.MatrixRainScene })),
  kifs: () => import('./KifsRoseScene').then((m) => ({ default: m.KifsRoseScene })),
  maze: () => import('./MazeFlightScene').then((m) => ({ default: m.MazeFlightScene })),
  wingfold: () => import('./WingfoldJuliaScene').then((m) => ({ default: m.WingfoldJuliaScene })),
  crystalfold: () => import('./CrystalFoldScene').then((m) => ({ default: m.CrystalFoldScene })),
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
 * Kick off every scene chunk's download at once. Idempotent and safe to call
 * repeatedly — `load()` de-dupes against `loaded`/`lazy`'s own module cache.
 *
 * Exists so a scene's cold-load cost (F127: a 2.3s freeze was traced to a
 * `maze` `import()` still in flight when the beat-locked commit's 2.5s
 * backstop expired) can be paid once, off the critical path, instead of on
 * whichever scene the show happens to request first. `requestScene`'s own
 * per-id `preloadScene` still fires on top of this — usually a no-op by
 * then, but it costs nothing to keep, and it is what covers a scene that
 * gets requested before this had a chance to run.
 */
export function preloadAllScenes(): void {
  for (const id of Object.keys(loaders)) preloadScene(id)
}

/**
 * Load a scene's chunk (if it isn't already) and then force its shaders to
 * compile + link + first-draw NOW, off the critical path — so the scene's first
 * real mount mid-show doesn't stall on a cold compile (F144: multi-second on
 * the roster's heaviest scenes).
 *
 * This has to go through `load()` rather than `getScene(id).component.prewarm`:
 * `component` is the `React.lazy` wrapper, which does NOT forward the `.prewarm`
 * static that `createShaderScene` puts on the real component, and at boot the
 * chunk hasn't been downloaded at all. The resolved module's `default` is the
 * prewarmable component.
 *
 * Fire-and-forget. A scene whose default has no `.prewarm` (a non-shader scene,
 * a future stock-material scene) is a silent no-op.
 */
export function prewarmScene(id: string, gl: THREE.WebGLRenderer): void {
  if (!loaders[id]) return
  void load(id)
    .then((m) => {
      const comp = m.default as { prewarm?: (gl: THREE.WebGLRenderer) => void }
      comp.prewarm?.(gl)
    })
    .catch(() => {})
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
const HeapCorruptionScene = lazyScene('heap')
const TunnelDriftScene = lazyScene('tunnel')
const OrbitGlowScene = lazyScene('orbs')
const KaleidoPulseScene = lazyScene('kaleido')
const TrailLineScene = lazyScene('trail')
const SynthGridScene = lazyScene('synthgrid')
const KernelPanicScene = lazyScene('panic')
const MalachiteScene = lazyScene('malachite')
const MatrixRainScene = lazyScene('matrix')
const KifsRoseScene = lazyScene('kifs')
const MazeFlightScene = lazyScene('maze')
const WingfoldJuliaScene = lazyScene('wingfold')
const CrystalFoldScene = lazyScene('crystalfold')

export type SceneRole = 'background' | 'primary' | 'accent' | 'overlay' | 'effect'

/** Musical events an effect scene can be triggered by. Rising edges, not levels. */
export type EffectTrigger = 'drop' | 'buildPeak' | 'sectionChange' | 'transient'

/**
 * What an `effect`-role scene declares.
 *
 * Effects are the one slot with a lifecycle rather than a tenancy: they are
 * fired by an event, run for `durationSec`, and retire themselves. A scene in
 * this slot receives `ctx.slotProgress` (0→1 across its lifetime) and **must
 * reach visual zero by 1** — the engine unmounts it there and does not fade it
 * out for you.
 */
export interface SceneEffectSpec {
  /** Events that can fire this effect. At least one required. */
  triggers: EffectTrigger[]
  /** Lifetime in seconds. Must be > 0. */
  durationSec: number
  /** Minimum gap between firings of THIS effect. Per-effect, not global. */
  cooldownSec?: number
}
/**
 * Licence posture of a scene's SOURCE material.
 *
 * This exists so a future packaging or marketplace step can mechanically
 * exclude anything it is not allowed to ship, rather than relying on someone
 * remembering which shader came from where.
 *
 * `unverified` is not a synonym for "probably fine". **Shadertoy's default
 * licence is CC BY-NC-SA 3.0** unless a shader states otherwise, so a port with
 * no explicit licence header must be treated as non-commercial until its author
 * is actually contacted. Anything not marked `original` or `attribution` should
 * be assumed unshippable.
 */
export type SceneLicense =
  /** Written for this project. No restriction. */
  | 'original'
  /** CC BY or equivalent — commercial use permitted WITH attribution. */
  | 'attribution'
  /** CC BY-NC-SA or equivalent. MUST NOT ship in a commercial build. */
  | 'noncommercial'
  /** Provenance unclear. Treat as `noncommercial` until confirmed. */
  | 'unverified'

export type SceneBand = 'bass' | 'mid' | 'high' | 'vocal' | 'energy'
export type SceneIntensity = 'calm' | 'medium' | 'high'
/**
 * How much of a frame a scene costs, in the units slotBudget.ts allocates
 * (low 1 / medium 2 / high 4).
 *
 * **Set these from `/bench`, not by eye.** They were guessed for a long time
 * and 10 of 16 were wrong — some by a lot, and in both directions. `network`
 * and `heap` were tagged `low` while measuring 6.3 ms and 5.2 ms of GPU time,
 * which mattered doubly for `network` because it is a LAYER: the budget thought
 * a `foldpath` + `network` composition cost 5 units of 6 when it actually cost
 * ~22 ms of a 16.7 ms frame. Meanwhile `synthgrid`, `torusfold`, `inversion`
 * and `pointcloud` were all tagged `high` while measuring 2-3 ms, so the budget
 * was refusing compositions the GPU could easily have carried.
 *
 * Thresholds, anchored on the measured roster so the buckets keep roughly the
 * 1 : 2 : 4 ratio the budget units imply:
 *
 *   low     < 2 ms      medium  2 - 4.5 ms      high  > 4.5 ms
 *
 * measured at tier 1 (the boot tier), GPU time, scene alone, no post chain.
 *
 * Two standing caveats on the numbers:
 *  - The particle scenes (`plasma`, `dissolve`, `pointcloud`) build geometry on
 *    a worker; their first benchmark run caught them partly unfilled and their
 *    tags are still the original guesses. Re-run and re-tag them.
 *  - The bench frames scenes with the default camera rather than
 *    CameraDirector, so scenes that read the real camera (`chrome`,
 *    `inversion`, `torusfold`) may be measured from an unrepresentative
 *    distance. Treat theirs as a floor.
 */
export type ScenePerformanceCost = 'low' | 'medium' | 'high'

export interface SceneMetadata {
  roles: SceneRole[]
  moods: MoodState[]
  bands: SceneBand[]
  intensity: SceneIntensity
  compatibleWith: string[]
  performanceCost: ScenePerformanceCost

  /**
   * Is this scene's cost per-pixel? **Defaults to true.**
   *
   * The one fact about its own cost that a scene knows and the engine cannot
   * derive. A fullscreen shader, an additive particle field and a feedback
   * accumulator all cost roughly one unit of work per physical pixel, so the
   * engine can make them cheaper by rendering fewer; a few hundred edge quads
   * or a handful of meshes cost the same at any resolution, and downscaling
   * those trades crispness for nothing.
   *
   * The default is the safe one, which is the point: a scene that declares
   * nothing — an import, a stranger's upload, a scene whose author never
   * thought about it — is assumed fill-bound and is scaled. Claiming `false`
   * is the assertion that buys full resolution, so it is the one that has to be
   * made out loud, and the one the engine declines to believe from an untrusted
   * registration (see `UNTRUSTED_MAX_BUDGET`).
   */
  fillBound?: boolean

  /**
   * Target internal megapixels, overriding what the engine would derive from
   * `performanceCost` and `fillBound`.
   *
   * Optional, and normally omitted. The engine solves the canvas scale that
   * holds this budget on whatever display is live — `sqrt(budget / fullResMP)`
   * — so a scene never reads the display itself and never names a resolution;
   * see engine/renderScale.ts.
   *
   * Reach for it only when a scene genuinely does not behave like its cost
   * class: it is a claim the engine cannot verify, which is why an untrusted
   * scene's is capped rather than honoured. Must sit in
   * {@link MIN_PIXEL_BUDGET}..{@link MAX_PIXEL_BUDGET} when present.
   */
  pixelBudget?: number
  /** Higher is a better fit for that mood; used by automatic directors. */
  moodFit?: Partial<Record<MoodState, number>>

  /**
   * Licence posture of the scene's source material. Absent means `original`.
   *
   * Anything other than `original` or `attribution` is excluded from
   * {@link commerciallyShippableScenes}, which is what a packaging step should
   * build from.
   */
  license?: SceneLicense

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

  /**
   * This scene genuinely reduces its own shader work when it is not the
   * primary — it reads `ctx.role` and scales step counts, iterations or
   * particle counts down accordingly.
   *
   * Opt-in because the composition budget discounts a scene one cost step in a
   * secondary slot, and discounting a scene that ignores `ctx.role` would be
   * budgeting for work it is still doing at full price. Absent means "charge me
   * full cost everywhere", which is always safe.
   */
  roleScalable?: boolean

  /**
   * Scene Contract v1 — the parameters this scene can be TOLD, in the shared
   * seven-name vocabulary, plus its named modes. See ./contract.ts.
   *
   * Optional, and validated when present. A scene without one is not steerable:
   * `ctx.p` hands it the neutral position for all seven, no panel rows appear
   * for it, the director cannot perform it, and a preset carries nothing for
   * it. That is exactly the pre-v1 behaviour, so the roster migrates one scene
   * at a time rather than in one commit — the same opt-in shape
   * {@link SceneMetadata.cameraAnchor} uses.
   */
  contract?: SceneContract

  /** Required when `roles` includes `'effect'`; ignored otherwise. */
  effect?: SceneEffectSpec
}

export interface SceneDef {
  id: string
  name: string
  component: ComponentType
  metadata: SceneMetadata

  /**
   * Was this scene reviewed alongside the engine, or registered from outside it?
   *
   * Absent means trusted — every entry in `SCENES` below is in-repo, and its
   * cost claims were reviewed with its shader. {@link registerScene} sets this
   * to `false` for anything arriving from a plugin, a custom build or a future
   * marketplace, and the engine then declines to take that scene's word for how
   * expensive it is (see `resolvePixelBudget` / `UNTRUSTED_MAX_BUDGET`).
   *
   * Provenance is a weak signal for a strong question, and it is deliberately
   * the ONLY thing gating on it today. The real answer measures what a scene
   * costs; this is what holds the line until that exists.
   */
  trusted?: boolean
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
      // Subject only. Dropping `accent` stops the engine compositing this over
      // another subject — with both roles, `primary: chrome` + `accent:
      // wireframe` was a legal composition and the director produced it, which
      // is two subjects fighting for the same frame.
      contract: {
        version: 1,
        modes: ['crystal', 'shard', 'cage'],
        params: { speed: 0.5, complexity: 0.5, fill: 0.5, tilt: 0.5, contrast: 0.5 },
        paramLabels: { '*': { complexity: 'facets', contrast: 'ink' } },
      },
      roles: ['primary'],
      moods: ['ambient', 'mellow', 'groove', 'building', 'peak', 'aggressive'],
      bands: ['bass', 'mid', 'high', 'energy'],
      intensity: 'medium',
      // Real edge geometry — a few hundred thin quads, cheaper than the
      // barycentric wireframe it supersedes.
      performanceCost: 'low',
      compatibleWith: ['plasma', 'dissolve', 'chrome'],
      moodFit: {
        ambient: 0.6,
        mellow: 0.56,
        groove: 0.62,
        building: 0.66,
        peak: 0.58,
        aggressive: 0.6,
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
      // F89: PlasmaFilamentScene reads ctx.role and cuts its particle draw
      // range by ROLE_SCALED_FRACTION outside 'primary' — a real vertex/fill
      // reduction (setDrawRange), not a cosmetic one. First scene in the
      // roster to actually earn this discount rather than just declaring it.
      roleScalable: true,
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
      contract: {
        version: 1,
        params: { speed: 0.5, fill: 0.5, tilt: 0.5, contrast: 0.85 },
        paramLabels: { '*': { contrast: 'polish' } },
      },
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
      // Peak dropped. Coverage, not fit, was making this the layer that appeared
      // most: it was the only calm layer tagged for `peak`, so it had a
      // near-monopoly there, and one extra mood over its peers meant more
      // opportunities everywhere else. `network` scores HIGHER at every mood
      // they share (0.90/0.84/0.76/0.70 against 0.72/0.70/0.64/0.68) and was
      // still picked less often. A flowing ribbon is also the wrong answer at
      // peak — that is what `plasma` is for.
      moods: ['ambient', 'mellow', 'groove', 'building'],
      bands: ['mid', 'vocal', 'high', 'energy'],
      intensity: 'medium',
      // A few dozen strips, all motion in the vertex shader.
      performanceCost: 'medium', // measured 2.14 ms GPU @ tier 1 (/bench)
      // F89: never primary (roles above), so `role !== 'primary'` holds on
      // every mount — FlowRibbonScene reads it and cuts its ribbon count by
      // ROLE_SCALED_FRACTION accordingly, on top of (not instead of) the
      // existing tier-based particleDensity cut.
      roleScalable: true,
      compatibleWith: ['wireframe', 'chrome', 'dissolve'],
      // Was 0.97/0.96/0.92/0.98/0.97 — the highest scores in the whole roster,
      // which made this the top-ranked layer candidate in five of six moods and
      // so the layer that actually appeared most of the time. Dropped into the
      // same band as its peers (network 0.70-0.90, plasma 0.70-0.94) so it
      // competes rather than dominates. This is a FREQUENCY control only; how
      // strong it looks when it does appear is the brightness scale in
      // FlowRibbonScene's fragment shader.
      moodFit: { ambient: 0.68, mellow: 0.66, groove: 0.62, building: 0.64 },
      cameraAnchor: { target: [0, 0, 0], distance: 10, height: 1.4 },
      cameraModes: ['cinematic', 'spiral', 'orbit', 'handheld', 'pull'],
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
    id: 'malachite',
    name: 'Malachite',
    component: MalachiteScene,
    metadata: {
      // CC0 from glslop, credited in-source to "claude-opus-4-8" (per the
      // requester, who sourced and supplied it directly). Replaces `ink` —
      // whose own provenance was never fully confirmed (see git history) — in
      // the background slot, which strictly improves the roster's licence
      // posture rather than just swapping the look.
      license: 'original',
      // Direct successor to `ink` in the same slot: background-ONLY. Full-
      // frame, no subject, no hard edges, reads at the background slot's 0.4
      // gain underneath something else without competing.
      // Ported from the lilim branch, which declared these three as flat
      // metadata. Same fields, same values, wrapped in the versioned
      // envelope this side uses — see ./contract.ts.
      contract: {
        version: 1,
        params: { speed: 0.5, complexity: 0.5, density: 0.5, fill: 0.5, contrast: 0.5 },
        paramLabels: {
        // The source's own knob names. `contrast` doubles as the source's
        // `tox` (toxicity/vividness) AND vein hardness — worth saying so
        // rather than leaving a performer to guess what either means here.
        '*': { complexity: 'warp', density: 'bands', fill: 'scale', contrast: 'toxicity' },
        },
      },
      roles: ['background'],
      // Same broad coverage `ink` had, for the same reason: ground should be
      // available almost everywhere. Stops short of `aggressive` — the
      // swirling bands have no hard edge in them, and under an aggressive
      // subject they would read as haze rather than as ground.
      moods: ['ambient', 'mellow', 'groove', 'building', 'peak'],
      // `bass` stands in for the kick-onset routing (`s.onKick` drives the
      // warp churn burst) — the SceneBand vocabulary has no onset-specific
      // entry, only level bands. Same convention `matrix` uses.
      bands: ['bass', 'mid', 'high', 'energy'],
      // Ground, not subject — composited at the background slot's 0.4 gain,
      // 100% coverage with no focal point by construction.
      intensity: 'calm',
      // Measured (Apple M1, ANGLE/Metal, offscreen draw, readPixels-forced
      // sync -- gl.finish() is a no-op under ANGLE and reports zero): 0.42 ms
      // at the shipped 1.3 MP budget, and 1.61 ms even fully unbudgeted at
      // 2560x1600. Five fbm calls (two for `q`, two for `r`, one for `f`) is
      // MORE calls than `ink`'s three, but this shader's hash-based value
      // noise is far cheaper per-sample than `ink`'s true simplex noise
      // (SIMPLEX3D_GLSL, documented there as ~10x a cheap hash-noise sample),
      // so it nets out well under the roster's own `low` threshold (<2 ms)
      // even without the budget doing any work. Confirm with /bench in situ.
      performanceCost: 'low',
      // Ground sits under anything. Listed against the scenes most likely to
      // want it — `getCompatibleScenes` is symmetric, so this reads both ways
      // and nothing else has to list `malachite` back.
      compatibleWith: ['wireframe', 'chrome'],
      // Held inside the roster's 0.6-0.9 band, same shape `ink` used:
      // strongest at the calm end where a slow field has time to be read,
      // weakest at `peak` where it is barely visible behind the subject.
      moodFit: {
        ambient: 0.86,
        mellow: 0.84,
        groove: 0.72,
        building: 0.68,
        peak: 0.62,
      },
      // Flat 2D screen-space noise; no ray, no camera concept at all — inert
      // to this scene's own rendering, exactly like `heap` and `juliawings`.
      // Declared because CameraDirector.test.ts requires every registered
      // scene to offer real framing variety, whether or not it samples the
      // camera.
      cameraAnchor: { target: [0, 0, 0], distance: 10.0, height: 1.5 },
      cameraModes: ['orbit', 'spiral', 'cinematic', 'handheld', 'hover'],
      // Five of seven: `shape` and `tilt` have nothing to bind to in a warped
      // noise field, same reasoning `ink` used.
    },
  },
  {
    id: 'matrix',
    name: 'Matrix Rain',
    component: MatrixRainScene,
    metadata: {
      // Adapted from an ISF generator credited "ChatGPT, direction fix by
      // Claude" — original code, not a Shadertoy derivative. No licence
      // encumbrance; absent would already mean this, but stated explicitly
      // given the provenance is worth being able to point at.
      license: 'original',
      // OVERLAY only, as requested. It reads as an assertive, saturated accent
      // over a calmer primary — the same slot `ribbons`/`orbs` occupy — not as
      // a subject or a ground: full-frame falling text has no depth of its own
      // to carry a frame, and it would fight a background scene's job of being
      // the least-noticed layer.
      // Ported from the lilim branch, which declared these three as flat
      // metadata. Same fields, same values, wrapped in the versioned
      // envelope this side uses — see ./contract.ts.
      contract: {
        version: 1,
        params: { speed: 0.5, density: 0.5, complexity: 0.5, contrast: 0.5 },
        paramLabels: {
        // `complexity` controls trail persistence; `contrast` controls
        // bloom/edge hardness. Neither name says that on its own.
        '*': { complexity: 'trail', contrast: 'glow' },
        },
      },
      roles: ['overlay'],
      // Bright, flickering, saturated text reads as energetic regardless of
      // density/speed settings — never the material for a quiet moment.
      moods: ['groove', 'building', 'peak', 'aggressive'],
      // `bass` stands in for the kick-onset routing (`s.onKick`), the same
      // convention `malachite` uses — the SceneBand vocabulary has no
      // onset-specific entry, only level bands.
      bands: ['bass', 'mid', 'high', 'energy'],
      intensity: 'high',
      // NOT MEASURED. Two hash() calls and a sin() per pixel, no loop, no
      // march — this estimate follows the roster's `orbs` (also two-ish cheap
      // calls, tagged low) rather than a hand guess in isolation, but per the
      // roster's own history (10 of 16 hand-tagged costs were wrong) this
      // should be confirmed with /bench before it funds a real composition.
      performanceCost: 'low',
      // Geometric/formal primaries a hacker-rain overlay complements without
      // fighting for the same visual territory.
      compatibleWith: ['wireframe', 'chrome'],
      // Mid-pack across its range, not maxed — `ribbons`'s history is the
      // warning here: one outlier mood weight gave it a near-monopoly on a
      // slot, and this keeps the same shape other overlay scenes use.
      moodFit: { groove: 0.6, building: 0.72, peak: 0.8, aggressive: 0.76 },
      // Flat 2D screen-space shader, no camera concept — inert here, declared
      // only for CameraDirector.test.ts's variety invariant, same as `malachite`.
      cameraAnchor: { target: [0, 0, 0], distance: 10.0, height: 1.5 },
      cameraModes: ['orbit', 'spiral', 'cinematic', 'handheld', 'hover'],
      // No `shape`/`fill`/`tilt` — there is no silhouette or camera-relative
      // axis in a full-frame column grid for those to bind to.
    },
  },
  {
    id: 'kifs',
    name: 'Fractal Rose Window',
    component: KifsRoseScene,
    metadata: {
      // CC0-1.0, sourced from glslop (shader fkdh866z), which records
      // `provenance_type: "witnessed_generation"` and `parents: []` — the
      // platform's own generation log, not a claimed upload, no fork lineage
      // to audit. Stronger provenance than a bare in-source credit comment.
      license: 'original',
      // Subject only — same reasoning as `kaleido`, its closest sibling: a
      // centred mandala owns the middle of the frame by construction.
      // Composited over another subject the two symmetries fight; behind one
      // it is entirely hidden by its own dark centre.
      // Ported from the lilim branch, which declared these three as flat
      // metadata. Same fields, same values, wrapped in the versioned
      // envelope this side uses — see ./contract.ts.
      contract: {
        version: 1,
        params: { speed: 0.5, shape: 0.5, complexity: 0.5, fill: 0.5, tilt: 0.5, contrast: 0.5 },
        paramLabels: {
        // The source's own input names — none of the canonical keys say this
        // on their own.
        '*': {
          shape: 'symmetry',
          complexity: 'iterations',
          fill: 'zoom',
          tilt: 'morph',
          contrast: 'glow',
        },
        },
      },
      roles: ['primary'],
      // `kaleido`'s range (groove/building/peak) plus `aggressive`: the
      // orbit-trap laser lines read harder-edged and more neon than
      // `kaleido`'s softer fractal, which is the reason to carry both rather
      // than have one shadow the other.
      moods: ['groove', 'building', 'peak', 'aggressive'],
      bands: ['bass', 'mid', 'high', 'energy'],
      intensity: 'high',
      // NOT MEASURED. Up to 20 loop iterations of abs/dot/divide/matrix-multiply
      // plus three orbit-trap distance evaluations per pixel — meaningfully
      // heavier than `kaleido`'s measured 3.15 ms (four iterations of
      // fract/length/sin/pow, no matrix multiply). Tagged `high` rather than
      // guessed at `medium` on that comparison; confirm with `/bench`.
      performanceCost: 'high',
      // Matches `kaleido`: a centred mandala primary doesn't want to sit as a
      // background or accent under something else.
      compatibleWith: [],
      // Same 0.6-0.9 band as `kaleido`, calibrated close but not copied — equal
      // weights would make the director's tie-break between the two mandala
      // scenes arbitrary.
      moodFit: { groove: 0.8, building: 0.84, peak: 0.88, aggressive: 0.82 },
      // Flat 2D fractal math, no camera concept — inert here, declared only
      // for CameraDirector.test.ts's variety invariant, same as `kaleido`.
      cameraAnchor: { target: [0, 0, 0], distance: 10.0, height: 1.5 },
      cameraModes: ['orbit', 'spiral', 'cinematic', 'handheld', 'hover'],
      // No `density` — nothing in an iterated fold has a discrete element
      // count for it to bind to.
    },
  },
  {
    id: 'maze',
    name: 'Maze Flight',
    component: MazeFlightScene,
    metadata: {
      // CC0-1.0 from glslop (shader gstbkfmm), `provenance_type:
      // "witnessed_generation"`, `parents: []` — platform generation log, not
      // a claimed upload, no fork lineage to audit.
      license: 'original',
      // Subject only, and not negotiable: this is a first-person flythrough
      // that owns the entire frame and its own camera. There is no version of
      // it that reads as ground or as an accent over something else.
      roles: ['primary'],
      // Forward motion with a hard beat is the whole premise, so it starts at
      // `groove`. Overlaps `tunnel`'s territory deliberately — both fly
      // forward — but the moodFit peaks are pulled apart below so they trade
      // rather than substitute.
      moods: ['groove', 'building', 'peak', 'aggressive'],
      bands: ['bass', 'mid', 'high', 'energy'],
      intensity: 'high',
      // Measured 5.4 ms at tier 0 on an M1 (offscreen, scene alone) — see the
      // file header for the method and the full ablation. That is just over the
      // >4.5 ms `high` threshold and in line with the roster's existing
      // heavyweights (`network` 6.3 ms). Worth re-confirming with /bench in
      // situ, since this was timed standalone rather than in a live frame.
      performanceCost: 'high',
      // Owns the frame; nothing composites with a first-person corridor.
      compatibleWith: [],
      // Peaks at `aggressive`, where `tunnel` peaks at `building` and `kifs` at
      // `peak` — three high-energy scenes that would otherwise shadow each
      // other across the same range.
      moodFit: { groove: 0.66, building: 0.74, peak: 0.82, aggressive: 0.88 },
      // The shader drives its own camera down the corridor; the engine's
      // camera is inert here. Declared only for CameraDirector.test.ts's
      // variety invariant, same as `malachite`/`kifs`.
      cameraAnchor: { target: [0, 0, 0], distance: 10.0, height: 1.5 },
      cameraModes: ['orbit', 'spiral', 'cinematic', 'handheld', 'hover'],
      // Defaults sit at the source's authored values rather than a uniform
      // 0.5, so the slider centre is not a different look from the one the
      // shader was tuned at: shape 0.82 -> turns 1.63, fill 0.62 -> fov 1.39,
      // density 1.0 -> 1.5.
      //
      // `complexity` is the exception, and deliberately: the source's 0.97
      // enables a third nesting level that measured a THIRD of the frame on its
      // own, most of it sub-pixel at this scene's render scale. 0.7 ships two
      // levels; maxing the slider still buys the third at ~9.5 ms.
      // Ported from the lilim branch, which declared `params` and
      // `paramLabels` as flat metadata. Same fields, same values, wrapped in
      // the versioned envelope this side uses — see ./contract.ts.
      contract: {
        version: 1,
        params: {
          speed: 0.5,
          shape: 0.82,
          complexity: 0.7,
          density: 1.0,
          fill: 0.62,
          tilt: 0.6,
          contrast: 0.5,
        },
        paramLabels: {
          // The source's own knob names — none of the canonical keys say this on
          // their own. `complexity` is additionally capped by the quality
          // governor, so at low tiers the slider's top end is unreachable.
          '*': {
            shape: 'turns',
            complexity: 'detail',
            density: 'openness',
            fill: 'fov',
            tilt: 'corner ease',
            contrast: 'glow',
          },
        },
      },
    },
  },
  {
    id: 'wingfold',
    name: 'Wingfold Julia',
    component: WingfoldJuliaScene,
    metadata: {
      // Written for this project from nothing but the public-domain Julia-set
      // formula (Gaston Julia, 1918) plus an original fold trick. Started as a
      // clean-room recreation attempt for `juliawings`; once that scene's real
      // reference art turned out to be an unrelated technique, this stood on
      // its own and earned its own slot instead of being discarded.
      license: 'original',
      // Subject only — a centred fractal owns the whole frame by
      // construction, same reasoning as `kifs`.
      // Ported from the lilim branch, which declared these three as flat
      // metadata. Same fields, same values, wrapped in the versioned
      // envelope this side uses — see ./contract.ts.
      contract: {
        version: 1,
        params: { speed: 0.5, shape: 0.5, complexity: 0.6, fill: 0.5, contrast: 0.5 },
        paramLabels: {
        // `shape` controls the c-orbit radius, which is the single biggest
        // lever on the set's character — worth its own name rather than
        // leaving a performer to guess what "shape" does here.
        '*': { shape: 'orbit', complexity: 'detail', fill: 'zoom' },
        },
      },
      roles: ['primary'],
      // Built to be "dancy": the zoom breathes on the beat-subdivision pulse
      // and kicks punch the orbit radius, so it wants a real beat to respond
      // to rather than a quiet passage. Peaks at `aggressive` rather than
      // `peak` (where `kifs` peaks) so the two centred fractals trade instead
      // of substituting for each other.
      moods: ['groove', 'building', 'peak', 'aggressive'],
      bands: ['bass', 'mid', 'high', 'energy'],
      intensity: 'high',
      // Measured (Apple M1, ANGLE/Metal, offscreen draw, readPixels-forced
      // sync -- gl.finish() is a no-op under ANGLE and reports zero): 0.52 ms
      // at full 2560x1600, 160-iteration cap. A single escape-time loop --
      // one complex square-and-add, one bailout check, no march, no
      // per-pixel normal/AO -- and most pixels escape in a handful of
      // iterations, not the full cap. An order of magnitude under `kifs`
      // (~5.4 ms), whose per-iteration KIFS fold does a rotation-matrix
      // multiply plus three accumulated distance terms. Comfortably inside
      // the roster's own `low` threshold (<2 ms); confirm with /bench in situ
      // before fully trusting a standalone offscreen measurement.
      performanceCost: 'low',
      // Owns the frame; nothing composites with a full-bleed fractal.
      compatibleWith: [],
      moodFit: { groove: 0.76, building: 0.82, peak: 0.86, aggressive: 0.9 },
      // Flat 2D fractal math, no camera concept — inert here, declared only
      // for CameraDirector.test.ts's variety invariant, same as `kifs`.
      cameraAnchor: { target: [0, 0, 0], distance: 10.0, height: 1.5 },
      cameraModes: ['orbit', 'spiral', 'cinematic', 'handheld', 'hover'],
      // No `density`/`tilt` — nothing in an iterated escape-time field has a
      // discrete element count or a camera-relative axis for those to bind to.
    },
  },
]

/**
 * Registered, built, and deliberately WITHHELD from the roster.
 *
 * Kept as real entries rather than deleted or commented out: the loaders and
 * lazy components stay live, so these still typecheck and build, and
 * re-enabling one is moving its entry back into `SCENES`. Nothing selects from
 * this array — automation, the HUD scene bar and `getScene()` all read `SCENES`
 * only, so a disabled id degrades to the `SCENES[0]` fallback exactly like an
 * unknown one.
 *
 * `tunnel` and `panic` are here on request while their look is still being
 * worked on. Note `panic` is ALSO non-commercial; see KNOWN_NC_SOURCE_IDS,
 * which deliberately tracks licence independently of whether a scene is
 * currently in the roster.
 */
export const DISABLED_SCENES: SceneDef[] = [
  {
    id: 'tunnel',
    name: 'Tunnel Drift',
    component: TunnelDriftScene,
    metadata: {
      // Shadertoy-derived (see TunnelDriftScene.tsx header) with no licence
      // attached to the source, so — same reasoning as its neighbours below —
      // treated as non-commercial until confirmed otherwise, independent of
      // why it is disabled (which is look/quality, not licensing).
      license: 'unverified',
      // Subject only. A fullscreen flythrough owns the whole frame by
      // construction — there is no ground to sit behind it and nothing sensible
      // to composite over a moving tunnel.
      roles: ['primary'],
      // Hypnotic and DRIVING, not violent — the opposite pole from `heap`.
      // Constant forward motion needs somewhere to be going, which is why it
      // starts at `groove` rather than `ambient`, and why it stops short of
      // `aggressive`: the piece has no chaos in it, so at full aggression it
      // would read as too composed for the music.
      moods: ['groove', 'building', 'peak'],
      bands: ['bass', 'mid', 'high', 'energy'],
      intensity: 'high',
      // 99-step march with a nested 4-iteration fractal warp per step, each
      // iteration doing sin/cos on vec3s plus an axis rotation. Comfortably the
      // most expensive scene in the roster; `uMaxSteps` is wired to the
      // governor exactly as TorusFold/Inversion do it.
      performanceCost: 'high',
      compatibleWith: [],
      // Peaks at `building` on purpose: a tunnel flying toward something IS the
      // build, visually. Held inside the roster's 0.6-0.9 band.
      moodFit: {
        groove: 0.86,
        building: 0.88,
        peak: 0.86,
      },
      // The scene flies its own scripted path and never reads the shared
      // camera, exactly like FoldPathScene — the flythrough IS the piece.
      // Declared anyway for CameraDirector.test.ts's variety invariant.
      cameraAnchor: { target: [0, 0, 0], distance: 10.0, height: 1.5 },
      cameraModes: ['orbit', 'spiral', 'cinematic', 'handheld', 'hover'],
    },
  },
  {
    id: 'panic',
    name: 'Kernel Panic',
    component: KernelPanicScene,
    metadata: {
      // ===== NON-COMMERCIAL — see the banner in KernelPanicScene.tsx =====
      // Unlicensed Shadertoy source; Shadertoy's default is CC BY-NC-SA 3.0, so
      // this is NC absent an explicit grant. Excluded from
      // commerciallyShippableScenes() via this field.
      license: 'noncommercial',
      // Subject only. A full-frame terminal has no room for anything over or
      // under it, and the text needs the whole grid to be legible at all.
      roles: ['primary'],
      // Peaked at `peak` rather than `aggressive` on purpose: `heap` already
      // owns the aggressive end (0.90) and is also a glitch scene. Two of them
      // topping out in the same place would just substitute for each other,
      // where the point of carrying both is that one is a grid of decaying
      // memory and this one is readable text tearing itself apart.
      moods: ['building', 'peak', 'aggressive'],
      bands: ['mid', 'high', 'energy'],
      intensity: 'high',
      // The full five-stage chain: four offscreen fullscreen passes plus the
      // display pass, and SIX HalfFloat render targets (ping-pong pairs for A
      // and B, singles for C and D) — roughly 100 MB resident at 1080p. The
      // per-pixel work is modest, but four extra passes and that much target
      // memory put it above `trail`, which pays for one pass and two targets.
      // As with `trail`, the budget model counts fragment work and has no
      // concept of render-target memory, so this tier is a judgement call.
      performanceCost: 'high',
      compatibleWith: [],
      moodFit: {
        building: 0.7,
        peak: 0.86,
        aggressive: 0.82,
      },
      // Flat 2D screen-space text; no camera concept. Declared for
      // CameraDirector.test.ts's variety invariant.
      cameraAnchor: { target: [0, 0, 0], distance: 10.0, height: 1.5 },
      cameraModes: ['orbit', 'spiral', 'cinematic', 'handheld', 'hover'],
    },
  },
  {
    id: 'network',
    name: 'Network Constellation',
    component: NetworkConstellationScene,
    metadata: {
      // MOVED OUT OF THE LIVE ROSTER (commercial-launch licence pass).
      // Source states an explicit non-commercial licence. See
      // KNOWN_NC_SOURCE_IDS and docs/ISSUES.md for the audit this came from.
      license: 'noncommercial',
      // Now primary-capable: a fullscreen procedural network shader, bold
      // enough to stand alone rather than only composite under/over another
      // scene.
      //
      // Deliberately NOT tagged 'background' despite being a plausible fit.
      // The background slot exists but has no authored content yet, and this
      // scene was composed as a subject — letting it default into the new slot
      // would debut the composition model with a scene never art-directed for
      // it. Re-add once intentional background scenes exist to compare against.
      roles: ['accent', 'overlay', 'primary'],
      moods: ['ambient', 'mellow', 'groove', 'building'],
      bands: ['bass', 'mid', 'high', 'energy'],
      intensity: 'medium',
      // Fullscreen shader, ~36 hash evals/pixel — cheaper than the CPU
      // O(n^2) link scan it replaced.
      performanceCost: 'high', // measured 6.26 ms GPU @ tier 1 (/bench)
      compatibleWith: ['wireframe', 'chrome', 'pointcloud'],
      moodFit: {
        ambient: 0.90,
        mellow: 0.84,
        groove: 0.76,
        building: 0.70,
      },
      // The scene's own rendering ignores these entirely (fullscreen quad,
      // no ctx.camera read — its motion is audio/autonomous-driven, see
      // NetworkConstellationScene's header comment). But CameraDirector's
      // test suite (CameraDirector.test.ts) enforces that every registered
      // scene — not just primary ones — declares enough camera-mode variety
      // to be framed meaningfully, since the director doesn't know per-scene
      // whether the camera matters. Restored rather than left off: found via
      // a failing `npm run check` I should have run before the first push.
      cameraAnchor: { target: [0, 0, 0], distance: 14.0, height: 1.5 },
      cameraModes: ['orbit', 'spiral', 'cinematic', 'handheld', 'hover'],
    },
  },
  {
    id: 'inversion',
    name: 'Inversion Machine',
    component: InversionMachineScene,
    metadata: {
      // MOVED OUT OF THE LIVE ROSTER (commercial-launch licence pass).
      // Shadertoy-derived with no licence attached to the source. Shadertoy's
      // OWN default licence for an unmarked upload is CC BY-NC-SA 3.0, so this
      // is treated as non-commercial until someone actually confirms otherwise
      // with the original author -- not a neutral "maybe fine".
      license: 'unverified',
      // The first true raymarched-SDF scene in the roster: a sphere-inversion
      // fractal, dense and alien enough to carry a frame on its own.
      roles: ['primary'],
      // Fills a real gap: aggressive was previously only covered by
      // wireframe/plasma, and nothing else brought lit-surface raymarching.
      moods: ['groove', 'building', 'peak', 'aggressive'],
      bands: ['bass', 'mid', 'high', 'energy'],
      intensity: 'high',
      // ~60-step raymarch + 6 calcNormal() calls/pixel, governed by uMaxSteps.
      performanceCost: 'medium', // measured 3.06 ms GPU @ tier 1 (/bench)
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
      // MOVED OUT OF THE LIVE ROSTER (commercial-launch licence pass).
      // Shadertoy-derived with no licence attached to the source. Shadertoy's
      // OWN default licence for an unmarked upload is CC BY-NC-SA 3.0, so this
      // is treated as non-commercial until someone actually confirms otherwise
      // with the original author -- not a neutral "maybe fine".
      license: 'unverified',
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
      // The scene flies its own scripted path() camera rather than reading
      // the real one (see FoldPathScene's header comment — the flythrough IS
      // the piece, unlike inversion's orbit-a-static-object case), so these
      // are inert to its own rendering. Declared anyway: every registered
      // scene needs enough camera-mode variety for CameraDirector's own
      // bookkeeping, per CameraDirector.test.ts — same fix as network.
      cameraAnchor: { target: [0, 0, 0], distance: 10.0, height: 1.5 },
      cameraModes: ['orbit', 'spiral', 'cinematic', 'handheld', 'hover'],
    },
  },
  {
    id: 'torusfold',
    name: 'Torus Fold',
    component: TorusFoldScene,
    metadata: {
      // MOVED OUT OF THE LIVE ROSTER (commercial-launch licence pass).
      // Shadertoy-derived with no licence attached to the source. Shadertoy's
      // OWN default licence for an unmarked upload is CC BY-NC-SA 3.0, so this
      // is treated as non-commercial until someone actually confirms otherwise
      // with the original author -- not a neutral "maybe fine".
      license: 'unverified',
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
      performanceCost: 'medium', // measured 1.99 ms GPU @ tier 1 (/bench)
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
      // MOVED OUT OF THE LIVE ROSTER (commercial-launch licence pass).
      // Shadertoy-derived with no licence attached to the source. Shadertoy's
      // OWN default licence for an unmarked upload is CC BY-NC-SA 3.0, so this
      // is treated as non-commercial until someone actually confirms otherwise
      // with the original author -- not a neutral "maybe fine".
      license: 'unverified',
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
      performanceCost: 'high', // measured 4.69 ms GPU @ tier 1 (/bench)
      compatibleWith: ['wireframe', 'network', 'ribbons'],
      moodFit: {
        ambient: 0.8,
        mellow: 0.85,
        groove: 0.8,
        building: 0.78,
        peak: 0.82,
      },
      // Pure 2D math, no ray/camera concept at all (unlike inversion/
      // torusfold) — inert to this scene's own rendering, same as network/
      // foldpath. Declared anyway for CameraDirector.test.ts's invariant:
      // every registered scene needs real camera-mode variety.
      cameraAnchor: { target: [0, 0, 0], distance: 10.0, height: 1.5 },
      cameraModes: ['orbit', 'spiral', 'cinematic', 'handheld', 'hover'],
    },
  },
  {
    id: 'heap',
    name: 'Heap Corruption',
    component: HeapCorruptionScene,
    metadata: {
      // MOVED OUT OF THE LIVE ROSTER (commercial-launch product decision).
      // Unlike its neighbours here this one genuinely has commercial
      // permission already: CC BY 4.0 allows commercial use, conditioned on
      // crediting the author. Held out anyway on request, pending a decision
      // on where that credit would live (about/credits screen).
      license: 'attribution',
      // Subject only. It fills the frame with a dense, high-contrast grid, so
      // compositing anything over it — or it over anything — just fights.
      roles: ['primary'],
      // Its whole character is decay under pressure, which needs energy to read
      // as anything. In `ambient` it would sit near-healthy and inert, so it is
      // deliberately not offered there.
      moods: ['groove', 'building', 'peak', 'aggressive'],
      bands: ['bass', 'mid', 'high', 'energy'],
      intensity: 'high',
      // Fullscreen, but cheap per pixel: hashes and one value-noise pair, no
      // march and no fbm. Comparable to `network`, nothing like the raymarchers.
      performanceCost: 'high', // measured 5.24 ms GPU @ tier 1 (/bench)
      compatibleWith: [],
      // Kept in the roster's 0.6-0.9 band on purpose. Strongest at `aggressive`,
      // where glitch and decay are the point, and weakest at `groove`.
      moodFit: {
        groove: 0.74,
        building: 0.84,
        peak: 0.88,
        aggressive: 0.9,
      },
      // Pure 2D screen-space math — no ray, no camera concept at all, so these
      // are inert to its own rendering. Declared because CameraDirector.test.ts
      // requires every registered scene to offer real framing variety, the same
      // reason network/foldpath/juliawings declare them.
      cameraAnchor: { target: [0, 0, 0], distance: 10.0, height: 1.5 },
      cameraModes: ['orbit', 'spiral', 'cinematic', 'handheld', 'hover'],
    },
  },
  {
    id: 'orbs',
    name: 'Orbit Glow',
    component: OrbitGlowScene,
    metadata: {
      // MOVED OUT OF THE LIVE ROSTER (commercial-launch licence pass).
      // Shadertoy-derived with no licence attached to the source. Shadertoy's
      // OWN default licence for an unmarked upload is CC BY-NC-SA 3.0, so this
      // is treated as non-commercial until someone actually confirms otherwise
      // with the original author -- not a neutral "maybe fine".
      license: 'unverified',
      // Layer-only, exactly like `ribbons` — three soft orbs on black have
      // nowhere near enough structure to carry a frame as the subject, but they
      // composite beautifully over one.
      //
      // This is the roster's strongest BACKGROUND and EFFECT candidate: it is
      // the cheapest scene here by a wide margin, and its per-orb glow gives it
      // the contrast dynamics a dimmed ground needs to still read as alive.
      // Neither role is claimed yet because both are inert — nothing selects
      // `background`, and an `effect` scene must additionally drive itself to
      // visual zero by `slotProgress` 1, which this does not yet do.
      contract: {
        version: 1,
        params: { speed: 0.5, density: 0.5, fill: 0.5, contrast: 0.5 },
        paramLabels: { '*': { density: 'spread', fill: 'orbit', contrast: 'glow' } },
      },
      roles: ['accent', 'overlay'],
      // The calm end of the roster. Deliberately stops at `building`: three
      // drifting orbs have no punch to offer a peak, and pretending otherwise
      // would just put a soft layer under a loud moment.
      moods: ['ambient', 'mellow', 'groove', 'building'],
      bands: ['bass', 'mid', 'high', 'energy'],
      intensity: 'calm',
      // Three length() calls and three divides per pixel. No march, no noise,
      // no loop — comfortably the cheapest scene in the roster, cheaper even
      // than `network`.
      performanceCost: 'low',
      compatibleWith: ['wireframe', 'chrome', 'dissolve', 'pointcloud', 'foldpath', 'juliawings'],
      // Sits just above `ribbons` at the calm end where it belongs and below it
      // by `groove`, so the two layer scenes trade places across the range
      // rather than one always winning. Both are inside the roster's 0.6-0.9
      // band after `ribbons` showed what a 0.98 outlier does to selection.
      moodFit: {
        ambient: 0.78,
        mellow: 0.75,
        groove: 0.63,
        building: 0.58,
      },
      // Flat 2D screen-space math, no camera concept at all — inert here, and
      // declared only for CameraDirector.test.ts's variety invariant.
      cameraAnchor: { target: [0, 0, 0], distance: 10.0, height: 1.5 },
      cameraModes: ['orbit', 'spiral', 'cinematic', 'handheld', 'hover'],
    },
  },
  {
    id: 'kaleido',
    name: 'Kaleido Pulse',
    component: KaleidoPulseScene,
    metadata: {
      // MOVED OUT OF THE LIVE ROSTER (commercial-launch licence pass).
      // Shadertoy-derived with no licence attached to the source. Shadertoy's
      // OWN default licence for an unmarked upload is CC BY-NC-SA 3.0, so this
      // is treated as non-commercial until someone actually confirms otherwise
      // with the original author -- not a neutral "maybe fine".
      license: 'unverified',
      // Subject only. A centred mandala owns the middle of the frame by
      // construction; composited over another subject the two symmetries fight,
      // and behind one it is entirely hidden by its own dark centre.
      contract: {
        version: 1,
        params: { speed: 0.5, complexity: 1, density: 0.5, contrast: 0.5 },
        paramLabels: { '*': { complexity: 'layers', density: 'fold', contrast: 'edge' } },
      },
      roles: ['primary'],
      // Same territory as `tunnel` — rhythmic and hypnotic — but the silhouette
      // is radial rather than forward, which is the reason to carry both. The
      // moodFit peaks differ so they do not simply substitute for each other:
      // `tunnel` peaks at `building` (flying toward something IS a build), this
      // one at `peak` (a mandala pulsing on the beat is an arrival).
      moods: ['groove', 'building', 'peak'],
      bands: ['bass', 'mid', 'high', 'energy'],
      intensity: 'high',
      // Four iterations of fract/length/sin/pow plus a cosine palette each.
      // No march, no noise field, no hashing — cheaper than `network`'s ~36
      // hash evaluations per pixel, and an order of magnitude under the
      // raymarchers. Iteration count is still governed; see uIters.
      performanceCost: 'medium', // measured 3.15 ms GPU @ tier 1 (/bench)
      compatibleWith: [],
      // Inside the roster's 0.6-0.9 band, and deliberately a little under
      // `tunnel` at `building` so the two trade rather than one shadowing the
      // other across their shared range.
      moodFit: {
        groove: 0.84,
        building: 0.86,
        peak: 0.88,
      },
      // Flat 2D fractal math — no ray, no camera concept at all, exactly like
      // `juliawings`. Inert to its own rendering; declared only because
      // CameraDirector.test.ts requires every registered scene to offer real
      // framing variety.
      cameraAnchor: { target: [0, 0, 0], distance: 10.0, height: 1.5 },
      cameraModes: ['orbit', 'spiral', 'cinematic', 'handheld', 'hover'],
    },
  },
  {
    id: 'trail',
    name: 'Trail Line',
    component: TrailLineScene,
    metadata: {
      // MOVED OUT OF THE LIVE ROSTER (commercial-launch licence pass).
      // Shadertoy-derived with no licence attached to the source. Shadertoy's
      // OWN default licence for an unmarked upload is CC BY-NC-SA 3.0, so this
      // is treated as non-commercial until someone actually confirms otherwise
      // with the original author -- not a neutral "maybe fine".
      license: 'unverified',
      // Subject only. Sparse enough on paper to make a good accent — one thin
      // glowing stroke on black — but it is the roster's only scene that pays
      // for a render-target pair, and spending two extra fullscreen passes on a
      // decoration is the wrong trade. Revisit if it ever earns its keep.
      roles: ['primary'],
      // Gestural and unhurried. The trail is the piece, and a trail needs time
      // to be read, so this sits at the calmer end and stops before `peak`
      // rather than pretending a smear can land a drop.
      moods: ['mellow', 'groove', 'building'],
      bands: ['bass', 'mid', 'energy'],
      intensity: 'medium',
      // Two fullscreen passes rather than one — the accumulate pass plus the
      // display pass — and a pair of HalfFloat render targets resident for as
      // long as it is mounted. The per-pixel work is modest (five sin() from
      // f()/grad(), one texture fetch), so the tier is driven by the extra pass
      // and the VRAM, not by shader complexity. This is a different KIND of
      // cost from the rest of the roster: the budget model counts fragment
      // work, and nothing in it accounts for render-target memory.
      performanceCost: 'medium',
      compatibleWith: [],
      // Deliberately overlapping `orbs` and `ribbons` at the calm end without
      // beating them — those are layers, this is a subject, so they coexist
      // rather than compete. Peaks at `groove` where a drifting stroke has
      // something to move against.
      moodFit: {
        mellow: 0.86,
        groove: 0.88,
        building: 0.78,
      },
      // Flat 2D screen-space, no camera concept — the `juliawings` pattern.
      // Declared only for CameraDirector.test.ts's variety invariant.
      cameraAnchor: { target: [0, 0, 0], distance: 10.0, height: 1.5 },
      cameraModes: ['orbit', 'spiral', 'cinematic', 'handheld', 'hover'],
    },
  },
  {
    id: 'synthgrid',
    name: 'Synth Grid',
    component: SynthGridScene,
    metadata: {
      // MOVED OUT OF THE LIVE ROSTER (commercial-launch licence pass).
      // Source states an explicit non-commercial licence. See
      // KNOWN_NC_SOURCE_IDS and docs/ISSUES.md for the audit this came from.
      // ===== NON-COMMERCIAL — see the banner in SynthGridScene.tsx =====
      // CC BY-NC-SA 3.0. Must not ship in a commercial build, marketplace
      // listing or paid release without separate permission from the author.
      // nonCommercialSceneIds() derives the packaging exclusion list from this
      // field, and sceneLicensing.test.ts fails if it is ever removed.
      license: 'noncommercial',
      // Subject only. A full raymarched city with its own post chain owns the
      // frame completely.
      roles: ['primary'],
      // Retro-futurist and propulsive rather than chaotic. Needs energy to
      // justify the forward travel, and tops out before `aggressive` — the
      // palette is neon nostalgia, not violence.
      moods: ['groove', 'building', 'peak'],
      bands: ['bass', 'mid', 'energy'],
      intensity: 'high',
      // By a wide margin the most expensive scene in the roster: a 200-step
      // primary march whose map() evaluates a ground plane, a repeating
      // skyline and four car fields, a shadow march of up to 110 steps at every
      // hit, three map() calls per normal, and then a second full pass doing a
      // 40-tap bloom plus three 14-tap chroma flares. Mitigated by rendering
      // the buffer at 0.6x and governing every loop, but it is still the
      // heaviest thing here.
      performanceCost: 'medium', // measured 2.22 ms GPU @ tier 1 (/bench)
      compatibleWith: [],
      // Sits under `tunnel` and `kaleido` in their shared range: it is the most
      // expensive scene registered, so it should not also be the most likely to
      // be picked.
      moodFit: {
        groove: 0.8,
        building: 0.86,
        peak: 0.84,
      },
      // The scene flies its own drifting camera and never reads the shared one,
      // like FoldPath and Tunnel Drift. Declared for CameraDirector.test.ts.
      cameraAnchor: { target: [0, 0, 0], distance: 10.0, height: 1.5 },
      cameraModes: ['orbit', 'spiral', 'cinematic', 'handheld', 'hover'],
    },
  },
  {
    id: 'crystalfold',
    name: 'Crystal Fold',
    component: CrystalFoldScene,
    metadata: {
      // HELD OUT ON ARRIVAL, not moved out — added directly from a pasted,
      // unattributed Shadertoy-style snippet (`mainImage`/`iTime`/
      // `iResolution` API, no author or licence comment attached). Shadertoy's
      // OWN default licence for an unmarked upload is CC BY-NC-SA 3.0, so per
      // F01/F02 in docs/ISSUES.md this is treated as non-commercial until the
      // actual source is confirmed original or permissively licensed — not a
      // neutral "maybe fine". Move this entry into SCENES once that happens.
      license: 'unverified',
      // Subject only. An orbiting-camera 3D fractal raymarch owns the frame by
      // construction, same reasoning as `torusfold`/`inversion`.
      // Ported from the lilim branch, which declared these three as flat
      // metadata. Same fields, same values, wrapped in the versioned
      // envelope this side uses — see ./contract.ts.
      contract: {
        version: 1,
        params: { speed: 0.5, shape: 0.5, complexity: 0.5, fill: 0.5, tilt: 0.5, contrast: 0.5 },
        paramLabels: {
        // The source's own knob names — none of the canonical keys say this
        // on their own.
        '*': { shape: 'fold width', complexity: 'iterations', fill: 'zoom', tilt: 'elevation' },
        },
      },
      roles: ['primary'],
      // A slow, ornate orbit rather than anything violent — closest in spirit
      // to `torusfold`'s hypnotic ring-pulse, so it shares that range.
      moods: ['mellow', 'groove', 'building', 'peak'],
      bands: ['bass', 'mid', 'high', 'energy'],
      intensity: 'high',
      // NOT MEASURED. Up to 64 march steps, each evaluating up to 12 fold
      // iterations of rotate/abs/subtract — cheaper per-iteration than
      // `kifs`'s fold (no division) but wrapped in an outer march loop `kifs`
      // doesn't have, and both loops are quality/param-governed. Tagged `high`
      // on comparison with the roster's other raymarchers rather than
      // guessed in isolation; confirm with `/bench`.
      performanceCost: 'high',
      // Owns the frame; nothing composites with a full-bleed 3D fractal.
      compatibleWith: [],
      moodFit: {
        mellow: 0.7,
        groove: 0.8,
        building: 0.84,
        peak: 0.78,
      },
      // The shader drives its own orbiting camera internally and never reads
      // the engine's real one — inert here, declared only for
      // CameraDirector.test.ts's variety invariant, same as `kifs`/`wingfold`.
      cameraAnchor: { target: [0, 0, 0], distance: 10.0, height: 1.5 },
      cameraModes: ['orbit', 'spiral', 'cinematic', 'handheld', 'hover'],
      // No `density` — nothing in an iterated box-fold has a discrete element
      // count for it to bind to, same reasoning as `kifs`/`wingfold`.
    },
  },
]

/**
 * Every scene whose SOURCE is non-commercial, tracked independently of the
 * roster.
 *
 * Licence facts must not disappear when a scene is temporarily disabled — that
 * is exactly when someone would re-enable it later having forgotten. The
 * licensing test asserts against this list intersected with what is actually
 * registered.
 */
export const KNOWN_NC_SOURCE_IDS: readonly string[] = ['synthgrid', 'panic']

/**
 * Scenes whose source licence forbids, or has not been confirmed to permit,
 * commercial use. **A packaging or marketplace build must exclude these.**
 *
 * Derived from metadata rather than hand-maintained as a list, so a new scene
 * cannot be added and quietly forgotten — the only way to be shippable is to
 * declare it.
 */
/**
 * Does this scene's licence forbid, or fail to confirm permission for,
 * commercial use? A pure predicate over one scene's metadata — exported (not
 * just inlined into {@link nonCommercialSceneIds}) so the licensing test can
 * exercise the real check against `DISABLED_SCENES` entries directly, rather
 * than duplicating the condition or depending on the live roster happening to
 * contain a restricted scene, which will not always be true — the whole point
 * of the roster is to drive that count toward zero.
 */
export function isNonCommercial(scene: SceneDef): boolean {
  const l = scene.metadata.license ?? 'original'
  return l !== 'original' && l !== 'attribution'
}

export function nonCommercialSceneIds(): string[] {
  return SCENES.filter((s) => {
    const l = s.metadata.license ?? 'original'
    return l !== 'original' && l !== 'attribution'
  }).map((s) => s.id)
}

/** The complement: scenes safe to include in a commercial build. */
export function commerciallyShippableScenes(): SceneDef[] {
  const blocked = new Set(nonCommercialSceneIds())
  return SCENES.filter((s) => !blocked.has(s.id))
}

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
 *
 * Pass `role` to restrict the pool to scenes that can actually occupy that
 * slot. Callers choosing a PRIMARY must pass `'primary'` (or use the
 * {@link getPrimaryScenesForMood} shorthand): several scenes are layer-only
 * (`ribbons` is `['accent','overlay']`) yet carry the highest `moodFit` in
 * their moods, so an unfiltered pick installs a scene as the subject that was
 * authored to composite over one — that was a real bug, since `requestScene`
 * has no role check of its own.
 */
export function getScenesForMood(mood: MoodState, role?: SceneRole): SceneDef[] {
  return SCENES.filter(
    (s) => s.metadata.moods.includes(mood) && (!role || s.metadata.roles.includes(role)),
  ).sort((a, b) => (b.metadata.moodFit?.[mood] ?? 0.5) - (a.metadata.moodFit?.[mood] ?? 0.5))
}

/** {@link getScenesForMood}, filtered to scenes actually eligible to be primary. */
export function getPrimaryScenesForMood(mood: MoodState): SceneDef[] {
  return getScenesForMood(mood).filter((s) => s.metadata.roles.includes('primary'))
}

/**
 * Every registered scene that can occupy the effect slot.
 *
 * Empty today — no effect scenes are authored yet — and that is a supported
 * steady state, not an error. Callers treat an empty result as "there is
 * nothing to fire" and carry on, which is what lets the effect machinery ship
 * ahead of its content.
 *
 * (There is deliberately no general `getScenesForRole` helper beside this:
 * `getScenesForMood(mood, role)` already covers it, and the layer pools go
 * through the director's own `compatibleWith` filtering rather than a
 * registry-level lookup.)
 */
export function getEffectScenes(): SceneDef[] {
  return SCENES.filter((s) => s.metadata.roles.includes('effect') && s.metadata.effect)
}

/**
 * Weighted-random pick with recency avoidance — the "good mix" primitive
 * both AutoPilot and PerformanceDirector use instead of deterministically
 * taking the single best-fit scene every time.
 *
 * Two failure modes this replaces: (1) always picking rank 0 (occasionally
 * rank 1) meant only the top 1-2 `moodFit` scenes for a mood were EVER
 * reachable, no matter how many others were registered for it; (2) ties in
 * `moodFit` resolve by `SCENES[]` array order (stable sort), which
 * structurally favors whichever scene sits earliest — `wireframe` is
 * `SCENES[0]` and is deliberately tagged for every mood as the safe
 * fallback, so it kept winning ties across the board. Fixing the algorithm
 * generalizes to every scene rather than special-casing wireframe's numbers.
 *
 * `recentIds` should be ordered most-recent-first. Recency is a soft
 * multiplicative penalty, not a hard exclusion — a mood with only 2-3
 * registered scenes (e.g. `aggressive`) must still be able to return
 * something rather than dead-end because both options were "recent."
 *
 * ## `currentVA` — fit onto the CONTINUOUS read, not just the 7-way label
 * (audit c2)
 *
 * `mood` alone routes every candidate through the same discrete `moodFit`
 * column regardless of how far into `groove` (say) the section actually is —
 * two `groove` passages can differ a great deal in how bright, how tense, how
 * energised they are, and `moodFit` cannot see that. Passed a live
 * valence/arousal read (`performanceState.valence`/`.arousal` in
 * production), each candidate's OWN position in that space is derived from
 * its existing `moodFit` table (`deriveVA` — no new authoring, see
 * `moodValenceArousal.ts`) and candidates whose derived position sits nearer
 * the live read get a further boost on top of their discrete mood fit.
 * Bounded to at most halving the weight of the worst-placed candidate — this
 * sharpens the existing preference, it does not replace it, since `moodFit`
 * is authored judgment this function has no reason to override.
 */
export function pickVariedScene(
  candidates: readonly SceneDef[],
  mood: MoodState,
  recentIds: readonly string[],
  /** Optional per-candidate weight multiplier — e.g. PerformanceDirector uses
   *  this to keep preferring whichever scene expresses the current dominant
   *  band, a signal `moodFit` alone doesn't carry. */
  boost?: (scene: SceneDef) => number,
  /** Live valence/arousal read — see the doc above. Omitted, every existing
   *  call site and every existing test is unaffected. */
  currentVA?: ValenceArousal,
): SceneDef | undefined {
  if (candidates.length === 0) return undefined
  if (candidates.length === 1) return candidates[0]

  // Normalises vaDistance's raw units (valence spans -1..1, arousal 0..1, so
  // the plane's own diagonal is the natural "as far apart as two points on it
  // usually get" reference) into a 0..1 penalty.
  const VA_PLANE_DIAGONAL = Math.sqrt(2 * 2 + 1 * 1)
  const VA_DAMPENING = 0.5

  const weights = candidates.map((scene) => {
    // Floor above zero: every candidate keeps a real (if small) chance,
    // which is what actually breaks the "only the top pick is reachable"
    // problem — a hard rank cutoff would just move the ceiling, not remove it.
    const fit = Math.max(0.2, scene.metadata.moodFit?.[mood] ?? 0.5)
    const recentIndex = recentIds.indexOf(scene.id)
    // Decaying penalty: the most recently shown scene is heavily
    // discounted, less so further back, gone after 4 picks.
    const recencyPenalty = recentIndex === -1 ? 1 : [0.1, 0.3, 0.55, 0.8][recentIndex]
    let vaFactor = 1
    if (currentVA && scene.metadata.moodFit) {
      const sceneVA = deriveVA(scene.metadata.moodFit)
      const normDistance = Math.min(1, vaDistance(sceneVA, currentVA) / VA_PLANE_DIAGONAL)
      vaFactor = 1 - VA_DAMPENING * normDistance
    }
    return fit * recencyPenalty * vaFactor * (boost ? boost(scene) : 1)
  })

  const total = weights.reduce((sum, w) => sum + w, 0)
  let roll = Math.random() * total
  for (let i = 0; i < candidates.length; i++) {
    roll -= weights[i]
    if (roll <= 0) return candidates[i]
  }
  return candidates[candidates.length - 1]
}

/**
 * Pick a mode for a scene, avoiding the one it is already showing.
 *
 * ## Why the directors need this at all
 *
 * The mode primitive has existed since Scene Contract v1 — declared modes,
 * `useSceneMode`, per-mode labels, mode-scoped contract summaries — and until
 * now **nothing but the HUD could reach it**. `setSceneMode` had exactly one
 * caller, a click handler. So a scene with three authored looks showed one of
 * them for the entire life of an autonomous show, and the other two existed
 * only for someone who opened the menu and found them.
 *
 * That is the same shape as the palette gap in F59: a capability the roster
 * declares, that the autonomy cannot use. A mode nothing selects is not variety,
 * it is dead weight in a file.
 *
 * Deterministic from `rotation` for the same reason `pickPalette` is — a
 * recorded set has to replay identically — and it refuses to return the current
 * mode so a "change" is always visible. Returns undefined when the scene has no
 * modes or only one, which is most of the roster today.
 */
export function pickVariedMode(
  sceneId: string,
  current: string | undefined,
  rotation: number,
): string | undefined {
  // Deliberately NOT via getSceneContract, which falls back to SCENES[0] for an
  // unknown id. That fallback is right for rendering — a stale persisted id
  // should still draw something — but wrong for a selector: asked to choose a
  // mode for a scene that does not exist, the honest answer is "none", not
  // "here is one belonging to a different scene", which would then be stored
  // against the bogus id.
  const scene = SCENES.find((sc) => sc.id === sceneId)
  const modes = scene?.metadata.contract?.modes
  if (!modes || modes.length < 2) return undefined
  const choices = modes.filter((m) => m !== current)
  if (choices.length === 0) return undefined
  return choices[Math.abs(rotation) % choices.length]
}

/**
 * Scenes the given scene is declared to layer well with.
 *
 * Silently drops ids that resolve to nothing, which is what makes unregistering
 * a scene safe without having to scrub every other scene's `compatibleWith`.
 */
export function getCompatibleScenes(id: string): SceneDef[] {
  const scene = getScene(id)
  const declared = new Set(scene.metadata.compatibleWith)
  // SYMMETRIC. "A layers well with B" is inherently mutual, and treating the
  // declaration as one-directional produced a lopsided topology: a scene added
  // later can declare who it suits, but no existing scene will ever list IT
  // back, so it is almost unreachable through this filter.
  //
  // Measured before this: over 40k simulated layer picks the accent slot went
  // plasma 47% / ribbons 32% / network 16% / orbs 5.3%, purely on inbound edge
  // count (ribbons is listed by five scenes, orbs by none). Same failure as the
  // {wireframe, plasma, dissolve, chrome} primary clique, on the layer side.
  for (const other of SCENES) {
    if (other.metadata.compatibleWith.includes(id)) declared.add(other.id)
  }
  declared.delete(id)
  return [...declared]
    .map((cid) => SCENES.find((s) => s.id === cid))
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
  // Checked, not required. An absent budget is the normal case — the engine
  // derives one from `performanceCost` — but a PRESENT one that is malformed or
  // out of range is a mistake worth refusing, because it would otherwise be
  // silently discarded and the scene would render at a resolution its author
  // did not choose and was never told about.
  const budget = def.metadata.pixelBudget
  if (budget !== undefined) {
    if (typeof budget !== 'number' || !isFinite(budget)) {
      issues.push(`Scene "${def.id}" declares a non-numeric pixelBudget.`)
    } else if (budget < MIN_PIXEL_BUDGET || budget > MAX_PIXEL_BUDGET) {
      issues.push(
        `Scene "${def.id}" declares pixelBudget ${budget}; must be between ` +
          `${MIN_PIXEL_BUDGET} and ${MAX_PIXEL_BUDGET} megapixels.`,
      )
    }
  }
  if (def.metadata.fillBound !== undefined && typeof def.metadata.fillBound !== 'boolean') {
    issues.push(`Scene "${def.id}" declares a non-boolean fillBound.`)
  }
  // The effect slot has a lifecycle, so its contract is enforced here rather
  // than discovered inside the render loop when a burst never retires.
  if (def.metadata.roles.includes('effect')) {
    const fx = def.metadata.effect
    if (!fx) {
      issues.push(`Effect scene "${def.id}" needs an \`effect\` spec.`)
    } else {
      if (fx.triggers.length === 0)
        issues.push(`Effect scene "${def.id}" needs at least one trigger.`)
      if (!(fx.durationSec > 0))
        issues.push(`Effect scene "${def.id}" needs a positive durationSec.`)
    }
  }
  // Validated here rather than where it is read, so a third-party scene with a
  // malformed contract is refused by registerScene instead of surfacing as a
  // panel of dead sliders and a director pushing parameters nothing honours.
  if (def.metadata.contract) {
    issues.push(...validateContract(def.id, def.metadata.contract))
  }
  return issues
}

/**
 * The internal-megapixel budget this scene actually gets: its own valid claim if
 * it made one, the engine's default for its cost class otherwise, capped if it
 * was registered from outside. See `resolvePixelBudget`.
 *
 * Goes through {@link getScene}, so an unknown id resolves to the fallback
 * scene's budget rather than throwing — the same degradation every other
 * metadata read gets. That matters more here than elsewhere: this feeds the
 * render-scale solve every frame, and a stale layer id must not be able to
 * produce a `NaN` budget and a full-resolution canvas.
 */
export function getScenePixelBudget(id: string): number {
  return scenePixelBudget(getScene(id))
}

/** {@link getScenePixelBudget} for a caller that already has the def in hand. */
export function scenePixelBudget(def: SceneDef): number {
  return resolvePixelBudget(def.metadata, def.trusted !== false)
}

/**
 * A scene's Scene Contract, or undefined if it does not declare one.
 *
 * Goes through {@link getScene}, so an unknown id resolves to the fallback
 * scene's contract rather than throwing — the same degradation a stale
 * persisted sceneId already gets everywhere else.
 */
export function getSceneContract(id: string): SceneContract | undefined {
  return getScene(id).metadata.contract
}

/** True if this scene can be steered through the shared vocabulary. */
export function isSteerable(id: string): boolean {
  return getSceneContract(id) !== undefined
}

/**
 * A valid mode for a scene: `raw` if the scene declares it, otherwise the
 * scene's default mode, or undefined for a scene with no modes (or no
 * contract). Every stored/imported/received mode string goes through here.
 */
export function resolveSceneMode(id: string, raw: unknown): string | undefined {
  const c = getSceneContract(id)
  return c ? resolveMode(c, raw) : undefined
}

/**
 * Every steerable scene's control surface, for a consumer that cannot read the
 * source: a marketplace listing, a generated MIDI/OSC map, an external
 * connector's parameter discovery, an API response.
 *
 * Built from {@link commerciallyShippableScenes} rather than SCENES, because
 * the callers are exactly the ones that must not enumerate material the project
 * is not allowed to ship. Pass `modes` to describe a specific mode per scene;
 * omitted, each scene is described in its default mode.
 */
export function sceneContracts(modes?: Record<string, string>): SceneContractSummary[] {
  const out: SceneContractSummary[] = []
  for (const s of commerciallyShippableScenes()) {
    const c = s.metadata.contract
    if (c) out.push(summarizeContract(s.id, s.name, c, modes?.[s.id]))
  }
  return out
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
  // Marked untrusted unless the caller has already said otherwise, so a scene
  // arriving through this door cannot claim its way out of the pixel budget.
  // A custom build that genuinely owns its scenes can pass `trusted: true`; that
  // is an explicit decision by whoever assembles the bundle, which is the only
  // party in a position to make it.
  if (!SCENES.some((s) => s.id === def.id)) SCENES.push({ trusted: false, ...def })
}
