import { Suspense, lazy, useRef, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { AutoPilot } from './AutoPilot'
import { CameraDirector } from './CameraDirector'
import { CueTimeline } from './CueTimeline'
import { EffectsDirector } from './EffectsDirector'
import { SceneManager } from './SceneManager'
import { LightRig } from './LightRig'
import { PerfMonitor } from './PerfMonitor'
import { PerformanceDirector } from './PerformanceDirector'
import { PerformanceStateBridge } from './PerformanceStateBridge'
import { resourceCache } from './streaming/resourceCache'
import { useStore } from '../store'

// The AI-texture path ships as its own chunk and only downloads the first
// time the user enables it. Once loaded it stays mounted so toggling off
// fades gracefully (the layer's own alpha easing) instead of popping.
const GenerativeLayer = lazy(() =>
  import('./GenerativeLayer').then((m) => ({ default: m.GenerativeLayer })),
)

/**
 * The WebGL stage: owns the R3F Canvas and the fixed order of engine systems
 * inside it.
 *
 * Child order is not cosmetic — the systems run on explicit `useFrame`
 * priorities, in three bands:
 *
 *   analysis   `SceneManager` (-100, calls `audioEngine.update()` first)
 *   decide     `PerformanceStateBridge` (-95) → `AutoPilot` (-90) →
 *              `CueTimeline` (-88) → `PerformanceDirector` (-85)
 *   execute    `CameraDirector` (-80) → scenes (0) → `EffectsDirector`
 *
 * The rule the bands encode: everything in "decide" may write
 * `performanceState`, nothing in "execute" may — executors only read it and
 * apply. Keeping that boundary is what allows a new decision-maker (or a whole
 * new renderer) to be added without touching the other side.
 *
 * Two non-obvious Canvas settings:
 *  - `antialias: false` — PostFX resolves its own AA; MSAA on the default
 *    framebuffer would be wasted work behind the composer.
 *  - `preserveDrawingBuffer: true` — required for screenshots/recording. Side
 *    effect worth knowing while debugging: the canvas retains its last drawn
 *    frame, so a stalled render loop shows a stale image instead of going black.
 *
 * No `dpr` prop: PerfMonitor owns device pixel ratio, driving it from the
 * quality governor's current tier.
 */
export function Stage() {
  const generative = useStore((s) => s.generative)
  const everEnabled = useRef(generative)
  if (generative) everEnabled.current = true

  // Bumped when the GPU context is lost and restored. Keying the
  // resource-holding subtrees on it forces their render targets / materials to
  // rebuild after a restore, instead of sampling dead GPU handles.
  const [glEpoch, setGlEpoch] = useState(0)

  const handleCreated = ({ gl }: { gl: { domElement: HTMLCanvasElement } }) => {
    const canvas = gl.domElement
    canvas.addEventListener(
      'webglcontextlost',
      (e) => {
        // Preventing the default is what allows the browser to fire a restore;
        // without it the context is gone for good and the show hard-crashes.
        e.preventDefault()
        console.warn('[AudioVis] WebGL context lost — attempting recovery')
      },
      false,
    )
    canvas.addEventListener('webglcontextrestored', () => {
      // Every cached GPU resource — pinned or not — is dead: the handles
      // belong to a context that no longer exists. Clear the cache before
      // remounting so the first post-restore acquire() rebuilds from
      // scratch rather than handing back a texture pointing at nothing.
      resourceCache.invalidateAll()
      console.warn('[AudioVis] WebGL context restored — remounting render tree')
      setGlEpoch((n) => n + 1)
    })
  }

  return (
    <Canvas
      className="stage"
      gl={{ antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: true }}
      camera={{ fov: 60, position: [0, 3, 13], near: 0.1, far: 400 }}
      onCreated={handleCreated}
    >
      <color attach="background" args={['#000000']} />
      {/* PerfMonitor owns the DPR, so no static dpr prop — it sets it from the
          quality governor on mount and as tiers change. */}
      <PerfMonitor />
      {/* decide */}
      <PerformanceStateBridge />
      <AutoPilot />
      <CueTimeline />
      <PerformanceDirector />
      {/* execute */}
      <CameraDirector />
      <LightRig />
      <SceneManager key={`scenes-${glEpoch}`} />
      {everEnabled.current && (
        <Suspense fallback={null}>
          <GenerativeLayer key={`gen-${glEpoch}`} />
        </Suspense>
      )}
      <EffectsDirector key={`fx-${glEpoch}`} />
    </Canvas>
  )
}
