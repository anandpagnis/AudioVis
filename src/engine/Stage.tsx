import { Suspense, lazy, useRef, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { AutoPilot } from './AutoPilot'
import { CueTimeline } from './CueTimeline'
import { SceneManager } from './SceneManager'
import { LightRig } from './LightRig'
import { PostFX } from './PostFX'
import { PerfMonitor } from './PerfMonitor'
import { PerformanceDirector } from './PerformanceDirector'
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
 * priorities so the audio pipeline ticks before anything reads it:
 * `SceneManager` (-100, calls `audioEngine.update()`) → `AutoPilot` (-90) →
 * `CueTimeline` (-88) → `PerformanceDirector` (-85) → scenes (default) → PostFX.
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
      <AutoPilot />
      <CueTimeline />
      <PerformanceDirector />
      <LightRig />
      <SceneManager key={`scenes-${glEpoch}`} />
      {everEnabled.current && (
        <Suspense fallback={null}>
          <GenerativeLayer key={`gen-${glEpoch}`} />
        </Suspense>
      )}
      <PostFX key={`fx-${glEpoch}`} />
    </Canvas>
  )
}
