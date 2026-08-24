import { Suspense, useEffect, useMemo, useRef } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { audioEngine } from '../audio/AudioEngine'
import { updateAnimationSignals } from '../engine/AnimationDirector'
import { LightRig } from '../engine/LightRig'
import { performanceState } from '../engine/performanceState'
import { quality } from '../engine/quality'
import { renderScale } from '../engine/renderScale'
import { getScene, getScenePixelBudget, isSceneLoaded } from '../scenes'
import { GpuTimer } from './gpuTimer'
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
 */
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
    </Canvas>
  )
}

function BenchDriver({ runner, version }: { runner: BenchRunner; version: number }) {
  const gl = useThree((s) => s.gl)
  const setDpr = useThree((s) => s.setDpr)
  const size = useThree((s) => s.size)
  const timer = useMemo(() => new GpuTimer(), [])
  const appliedTier = useRef(-1)
  /** Scene the current DPR was solved for — the budget is per scene, not global. */
  const appliedScene = useRef('')

  useEffect(() => {
    timer.init(gl.getContext() as WebGL2RenderingContext)
    return () => timer.dispose()
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
    }

    timer.begin()
    gl.render(scene, camera)
    timer.end()

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

    runner.frame(delta * 1000, timer.poll(), timer.supported)
  }, 1)

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
