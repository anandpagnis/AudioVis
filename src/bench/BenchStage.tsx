import { Suspense, useEffect, useMemo, useRef } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { audioEngine } from '../audio/AudioEngine'
import { updateAnimationSignals } from '../engine/AnimationDirector'
import { EffectsDirector } from '../engine/EffectsDirector'
import { memo } from 'react'
import { LightRig } from '../engine/LightRig'
import { performanceState } from '../engine/performanceState'
import { quality } from '../engine/quality'
import { renderScale } from '../engine/renderScale'
import { DEFAULT_ANCHOR } from '../engine/CameraDirector'
import { sceneCpu, takeSceneCpu } from '../engine/sceneFrame'
import { getScene, getScenePixelBudget, isSceneLoaded } from '../scenes'
import { GpuTimer } from './gpuTimer'
import { PROFILE_H, PROFILE_W } from './sceneProfile'
import type { BenchRunner } from './benchHarness'

/**
 * The benchmark's render surface: one scene, one pinned tier, nothing else.
 *
 * Deliberately NOT `Stage`. Everything Stage mounts — the post chain, the five
 * directors, SceneManager's crossfade machinery — is cost shared by every scene
 * equally, so including it would add a constant to every measurement and shrink
 * the ratios that are the entire point. `LightRig` is the one exception: the
 * physically-shaded scenes (`chrome`) render as black plastic without it, so
 * leaving it out would measure the wrong thing rather than a smaller thing.
 *
 * There is also no `PerfMonitor`. The tier is pinned per cell and its DPR is
 * applied directly here, because the governor reacting mid-measurement is
 * precisely what a benchmark must not allow.
 *
 * The camera is placed on the scene's own declared `cameraAnchor` and held
 * still. Not `CameraDirector`, for the same reason: its modes orbit and drift,
 * so the framing would differ between the warmup frames and the measured ones,
 * and between two runs of the same cell. A benchmark wants the representative
 * distance, not the movement.
 */
/**
 * Is this the PROFILE pass rather than the cost pass?
 *
 * The two want opposite things from the same harness and cannot share a run.
 *
 * The **cost** pass excludes the post chain, and must: it is a constant added
 * to every scene, so including it shrinks the ratios that are the entire point
 * of comparing scenes to each other.
 *
 * The **profile** pass has to include it, and must: the question a profile
 * answers is *what does a viewer see*, and a viewer sees the post chain. The
 * first roster run measured `ribbons` at `fill 0.000` — a working layer for the
 * whole life of the project, reading as an empty frame, because its output sits
 * below the lit threshold until bloom reaches it. Profiling without the chain
 * would have vetoed it.
 *
 * The consequence is accepted deliberately: the profile then depends on the
 * palette and on the exposure servo's gain. That is not contamination. A scene
 * that only reads through bloom is a scene that only reads through bloom, and a
 * role profile should say so.
 */
const PROFILE_PASS =
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('profile')

/**
 * `EffectsDirector`, wrapped so it can never re-render.
 *
 * Not a precaution — it crashed the sweep. `Bench` re-renders on every progress
 * update, which re-rendered this, and `@react-three/postprocessing` memoizes
 * effect args on `JSON.stringify(props)`. Under React 19 `ref` is an ordinary
 * prop, and its `.current` carries R3F's circular `__r3f` graph, so the
 * stringify throws: "Converting circular structure to JSON".
 *
 * This is F48 exactly, in a second place. That entry documents the same failure
 * taking the whole Canvas down in the app, and `EffectsDirector`'s own header
 * carries it as a numbered constraint — the component must not re-render. A
 * constraint that has now been violated twice by different callers is worth
 * enforcing at the boundary rather than restating.
 */
const StablePostChain = memo(function StablePostChain() {
  return <EffectsDirector />
})

export function BenchStage({ runner, version }: { runner: BenchRunner; version: number }) {
  return (
    <Canvas
      className="bench-canvas"
      gl={{ antialias: false, powerPreference: 'high-performance' }}
      camera={{ fov: 60, position: [0, 3, 13], near: 0.1, far: 400 }}
    >
      <color attach="background" args={['#000000']} />
      <LightRig />
      <BenchDriver runner={runner} version={version} />
      {/* Renders at priority 1 and takes the draw away from BenchDriver, which
          is why the driver skips its own `gl.render` in this mode — two
          renderers at the same priority would both run. */}
      {PROFILE_PASS && <StablePostChain />}
    </Canvas>
  )
}

function BenchDriver({ runner, version }: { runner: BenchRunner; version: number }) {
  const gl = useThree((s) => s.gl)
  const setDpr = useThree((s) => s.setDpr)
  const size = useThree((s) => s.size)
  const timer = useMemo(() => new GpuTimer(), [])
  /** Scratch for the role profile — allocated once, never in the loop. */
  const luma = useMemo(() => new Float32Array(PROFILE_W * PROFILE_H), [])
  const profileCtx = useMemo(() => {
    if (typeof document === 'undefined') return null
    const c = document.createElement('canvas')
    c.width = PROFILE_W
    c.height = PROFILE_H
    return c.getContext('2d', { willReadFrequently: true })
  }, [])
  const appliedTier = useRef(-1)
  /** Scene the current DPR was solved for — the budget is per scene, not global. */
  const appliedScene = useRef('')

  useEffect(() => {
    timer.init(gl.getContext() as WebGL2RenderingContext)
    // The whole point of a benchmark is attribution, so the scene-JS profiler
    // runs here even though it is off everywhere else.
    sceneCpu.on = true
    return () => {
      sceneCpu.on = false
      timer.dispose()
    }
  }, [timer, gl])

  // Analysis tick. No audio source is running during a benchmark, and
  // `audioEngine.update()` handles that case by keeping its clock advancing —
  // which matters, because a scene whose motion is frozen at t=0 can sit in an
  // unrepresentative state (a raymarch that happens to converge early, a
  // particle field still at its seed positions).
  useFrame(() => {
    audioEngine.update()
    updateAnimationSignals()
  }, -100)

  // Priority 1 takes rendering away from R3F's automatic pass, which is the
  // only way to wrap the draw itself in the GPU timer: an auto-render happens
  // AFTER every useFrame callback, so no callback can observe its end.
  useFrame(({ scene, camera }, delta) => {
    const cell = runner.current
    if (!cell) return

    // Pin the tier and its render scale before drawing anything for this cell.
    //
    // The scale is solved from the scene's own declared `pixelBudget` for this
    // display, exactly as PerfMonitor does it in the app — which is the point of
    // benchmarking at all. Before the budget existed every scene was measured at
    // the same tier-wide scale, so the numbers described a resolution no scene
    // actually renders at; a 1.5 MP raymarcher and a native-resolution wireframe
    // were being compared at the same pixel count.
    if (appliedTier.current !== cell.tier || appliedScene.current !== cell.sceneId) {
      appliedTier.current = cell.tier
      appliedScene.current = cell.sceneId
      quality.pinTier(cell.tier)
      renderScale.setDisplay(size.width, size.height, Math.min(2, window.devicePixelRatio || 1))
      renderScale.setSceneBudget(getScenePixelBudget(cell.sceneId))
      const scale = renderScale.solve()
      renderScale.applied = scale
      setDpr(renderScale.baseDpr * scale)
      // Particle scenes scale through `performanceState.particleDensity`, which
      // is normally written by PerformanceStateBridge — and the bench does not
      // mount it (it is a decide-band director that reads audio and writes a
      // dozen other fields). Without this the density stayed pinned at 1 and
      // `plasma`/`dissolve`/`pointcloud` did not respond to the tier at all,
      // making their first run's numbers meaningless. One line, mirroring
      // exactly what the bridge does.
      performanceState.particleDensity = quality.knobs.particleFraction

      // Frame the scene the way the show frames it (F34).
      //
      // The default Canvas camera sits at [0, 3, 13] for everything, and a
      // scene that reads the real camera is then measured from a distance no
      // viewer ever sees it at: `torusfold`'s anchor is 3.3 units, so at 13 it
      // is mostly empty space and marches out cheaply. Its row was a floor, not
      // a measurement — and it is one of the three rows the cost table had to
      // carry a caveat about.
      //
      // The scene's own declared anchor, held STILL. Not CameraDirector: its
      // modes orbit and drift, so the framing would differ between the warmup
      // frames and the measured ones, and between two runs of the same cell.
      // A benchmark needs the representative distance, not the movement.
      const anchor = getScene(cell.sceneId).metadata.cameraAnchor ?? DEFAULT_ANCHOR
      const [ax, ay, az] = anchor.target
      camera.position.set(ax, ay + anchor.height, az + anchor.distance)
      camera.lookAt(ax, ay, az)
      camera.updateMatrixWorld()
    }

    // In the profile pass `EffectsDirector` owns the draw (also priority 1), so
    // rendering here as well would draw the scene twice and time the wrong one.
    // GPU timings are meaningless in that pass and are not read.
    if (!PROFILE_PASS) {
      timer.begin()
      gl.render(scene, camera)
      timer.end()
    }

    // Do not feed the runner until the scene's lazy chunk has actually landed.
    // Scenes render inside Suspense, so for the first frames after a cell change
    // this canvas is EMPTY — counting those would spend the warmup budget on an
    // unmounted scene and then measure its cold shader compile.
    if (!isSceneLoaded(cell.sceneId)) return

    // ...and not until it is actually DRAWING something.
    //
    // The particle scenes build their geometry on a worker and hold
    // `setDrawRange(0, 0)` until it arrives, so a mounted-but-unfilled scene
    // renders a draw call over zero vertices — nearly free, and utterly
    // unrepresentative. The first bench run showed `plasma` at 2.43 ms in one
    // cell and 0.48 ms in the next, which no quality knob can explain; an
    // unfilled buffer can.
    //
    // Summing all three primitive counters rather than checking triangles
    // alone: point clouds and line scenes legitimately draw zero triangles
    // forever, so a triangle test would stall the runner on them permanently.
    const r = gl.info.render
    if (r.triangles + r.points + r.lines === 0) return

    runner.frame(delta * 1000, takeSceneCpu(), timer.poll(), timer.supported)
  }, 1)

  // Profile readback, at priority 2.
  //
  // After the composer rather than inside the render callback: in the profile
  // pass the post chain draws at priority 1, so a readback taken alongside it
  // would sample the frame BEFORE bloom, grade and the exposure gain — the
  // exact blind spot this pass exists to remove. Priority 2 is the first moment
  // the composited frame exists and the drawing buffer still holds it.
  useFrame((_, delta) => {
    if (!profileCtx || !runner.current) return
    try {
      profileCtx.drawImage(gl.domElement, 0, 0, PROFILE_W, PROFILE_H)
      const d = profileCtx.getImageData(0, 0, PROFILE_W, PROFILE_H).data
      for (let i = 0, j = 0; i < d.length; i += 4, j++) {
        // Rec.709 luma on the OUTPUT-space bytes. The profile reasons about
        // what a viewer sees, not about linear radiometry.
        luma[j] = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255
      }
      runner.profileFrame(luma, delta)
    } catch {
      // A tainted or zero-sized canvas: skip this frame's profile rather than
      // taking the whole sweep down.
    }
  }, 2)

  const cell = runner.current
  if (!cell) return null
  const Scene = getScene(cell.sceneId).component
  return (
    // Keyed on the cell so each one mounts a genuinely fresh instance rather
    // than reusing warmed state from the previous tier of the same scene.
    <Suspense fallback={null}>
      <Scene key={`${cell.sceneId}-${cell.tier}-${version}`} />
    </Suspense>
  )
}
