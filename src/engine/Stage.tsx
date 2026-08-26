import { useEffect, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { captureIfRequested } from './recorder'
import { frameSampler } from './frameSampler'
import { AutoPilot } from './AutoPilot'
import { CameraDirector } from './CameraDirector'
import { CueTimeline } from './CueTimeline'
import { EffectDirector } from './EffectDirector'
import { EffectsDirector } from './EffectsDirector'
import { SceneManager } from './SceneManager'
import { LightRig } from './LightRig'
import { ExposureSampler } from './ExposureSampler'
import { PerfMonitor } from './PerfMonitor'
import { PerformanceDirector } from './PerformanceDirector'
import { PerformanceStateBridge } from './PerformanceStateBridge'
import { resetExposure } from './exposure'
import { resourceCache } from './streaming/resourceCache'
import { noteFrame, publishDetail, publishMirror, publishTelemetry } from './outputLink'
import { useStore } from '../store'

/**
 * The WebGL stage: owns the R3F Canvas and the fixed order of engine systems
 * inside it.
 *
 * Child order is not cosmetic — the systems run on explicit `useFrame`
 * priorities, in three bands:
 *
 *   analysis   `SceneManager` (-100, calls `audioEngine.update()` first)
 *   decide     `PerformanceStateBridge` (-95) → `AutoPilot` (-90) →
 *              `CueTimeline` (-88) → `EffectDirector` (-86) →
 *              `PerformanceDirector` (-85)
 *   execute    `CameraDirector` (-80) → scenes (0) → `EffectsDirector` (1) →
 *              `ExposureSampler` / `ScreenshotCapture` (2)
 *
 * Everything in the first two bands runs from mount. The post chain and the
 * exposure servo do not — see `PostChain` below, which gates them on the show
 * actually starting.
 *
 * The rule the bands encode: everything in "decide" may write
 * `performanceState`, nothing in "execute" may — executors only read it and
 * apply. Keeping that boundary is what allows a new decision-maker (or a whole
 * new renderer) to be added without touching the other side.
 *
 * One non-obvious Canvas setting:
 *  - `antialias: false` — PostFX resolves its own AA; MSAA on the default
 *    framebuffer would be wasted work behind the composer.
 *
 * `preserveDrawingBuffer` is deliberately NOT set. It made the driver retain a
 * copy of the framebuffer on every frame of the session to serve screenshots,
 * which happen a handful of times at most; `ScreenshotCapture` below gets the
 * same result by reading the buffer inside the tick that drew it. Debugging
 * note: without the retain, a stalled render loop now goes black rather than
 * showing its last good frame.
 *
 * No `dpr` prop: PerfMonitor owns device pixel ratio, driving it from the
 * quality governor's current tier.
 */
export function Stage() {
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
      // The servo's gain describes a frame produced by a context that no longer
      // exists; carrying it across would apply a correction to a picture that
      // was never measured.
      resetExposure()
      // Nothing measured before the loss describes the context we are about to
      // rebuild in, and the rebuild itself is one long stall. Drop the history
      // outright rather than letting the governor read a restore as load.
      frameSampler.reset()
      frameSampler.suspend(120)
      console.warn('[AudioVis] WebGL context restored — remounting render tree')
      setGlEpoch((n) => n + 1)
    })
  }

  return (
    <Canvas
      className="stage"
      gl={{ antialias: false, powerPreference: 'high-performance' }}
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
      <EffectDirector />
      <PerformanceDirector />
      {/* execute */}
      <CameraDirector />
      <LightRig />
      <SceneManager key={`scenes-${glEpoch}`} />
      <PostChain glEpoch={glEpoch} />
      <ScreenshotCapture />
      <MirrorPublisher />
    </Canvas>
  )
}

/**
 * Hands this window's canvas to the control window as a `MediaStream`, once.
 *
 * `captureStream` is the whole reason the show is rendered exactly once: the
 * control window's mini mirror is a `<video>` fed from here, not a second
 * renderer. Measured across two windows — 480x270, `readyState` 4, frames
 * advancing — so what the DJ watches costs a frame copy, not a frame.
 *
 * Runs at priority 2 and stops publishing itself after the first success:
 * `captureStream` needs a canvas that has actually drawn, and the first
 * composited frame is the earliest moment that is true.
 */
function MirrorPublisher() {
  const gl = useThree((s) => s.gl)
  const done = useRef(false)
  useFrame((_, delta) => {
    if (!done.current) done.current = publishMirror(gl.domElement)
    // Rate-limited inside; see TELEMETRY_INTERVAL_MS. Published from the render
    // loop rather than a timer so it cannot report a frame rate the window is
    // no longer producing.
    publishTelemetry()
    // Every frame, unsmoothed — the analytics panel's whole subject is the tail
    // and a mean would hide it. Buffered, and a no-op when nobody is watching.
    noteFrame(delta * 1000)
    publishDetail()
  }, 2)
  return null
}

/**
 * The post chain, plus the exposure servo that reads its output — mounted only
 * once the user has committed to starting a show.
 *
 * ## Why this is gated when nothing else in the tree is
 *
 * The start card is a translucent scrim (`.overlay`, 0.25-0.72 black), so the
 * stage behind it is deliberately visible — an idling preview is the product's
 * first impression and worth keeping. What is NOT worth keeping is the full
 * eighteen-pass bloom pyramid running underneath a dialog. Bisected: removing
 * only the post chain took that screen from **133 ms to 16.7 ms per frame**, so
 * it was roughly 87% of the cost of a screen showing a picker (F50).
 *
 * That cost was not merely wasted, it was actively harmful. `PerfMonitor` feeds
 * every idle frame to the quality governor, so a 133 ms picker screen walked the
 * tier down to survival before a single note played — and the show then started
 * already pinned, which is what made three of the six transition styles
 * unreachable (F84). Hence the reset below: the governor's view of the idle
 * screen describes a frame the show will never render.
 *
 * ## Why `starting` and not just `running`
 *
 * Building the composer means allocating its buffers and compiling the merged
 * effect shader. Doing that on the transition to `running` would land the stall
 * on the first bar of the track — the single worst moment available. `starting`
 * covers device permission, decode and analysis warm-up, which is both long
 * enough to hide the build and a moment where the user already expects a wait.
 *
 * The cheaper half-measure — dropping bloom's `mipmapBlur` while idle — was
 * rejected: changing the effect list rebuilds the merged shader anyway (see
 * `EffectsDirector`'s header), so it pays the same cost without shedding the
 * pass.
 */
function PostChain({ glEpoch }: { glEpoch: number }) {
  const live = useStore((s) => s.status === 'running' || s.status === 'starting')
  const wasLive = useRef(live)

  useEffect(() => {
    if (live === wasLive.current) return
    wasLive.current = live
    if (!live) return
    // The servo's gain was measured against frames the composer never touched
    // (no chain means no GradePass, so no output conversion and no gain), and
    // the governor's history describes a picker screen. Neither describes what
    // is about to render. Same reasoning as the context-restore path above, and
    // the same numbers: 120 frames is ~2 s, enough to cover the composer build
    // and the first shader compiles.
    resetExposure()
    frameSampler.reset()
    frameSampler.suspend(120)
  }, [live])

  if (!live) return null
  return (
    <>
      <EffectsDirector key={`fx-${glEpoch}`} />
      {/* Priority 2: after the composer has drawn, while the buffer is still
          readable. Keyed on glEpoch so a restored context starts a fresh loop. */}
      <ExposureSampler key={`exp-${glEpoch}`} />
    </>
  )
}

/**
 * Reads the drawing buffer for a pending screenshot, in the same tick that drew
 * it.
 *
 * Priority 2 is what makes this correct: `EffectComposer` takes over rendering
 * at priority 1, so anything above that runs after the frame is fully
 * composited but before the browser hands the buffer back. With
 * `preserveDrawingBuffer` off (see the Canvas comment) that window is the only
 * moment `toBlob` returns actual pixels rather than transparency.
 */
function ScreenshotCapture() {
  useFrame(() => captureIfRequested(), 2)
  return null
}
