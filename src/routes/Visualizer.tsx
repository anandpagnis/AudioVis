import { useEffect } from 'react'
import { Stage } from '../engine/Stage'
import { Console } from '../ui/Console'
import { audioEngine } from '../audio/AudioEngine'
import { claimSource, isOutput } from '../engine/outputLink'
import { useStore } from '../store'

/** Idle time before the pointer disappears on the output surface. */
const CURSOR_HIDE_MS = 2000

/**
 * One route, two entirely different windows.
 *
 * `?output` is the show: the engine, the scenes, the post chain, and nothing
 * else — no chrome, no keyboard map, no pointer. Everything else is the DJ's
 * control surface, which runs no engine at all and watches the output through a
 * mirror stream. See engine/outputLink.ts for why the split falls this way.
 */
export function Visualizer() {
  return isOutput() ? <OutputSurface /> : <ControlSurface />
}

/**
 * The one window that renders.
 *
 * It also starts the audio, because the source it was handed by the control
 * window is a live object that cannot be analysed anywhere else — see
 * `claimSource`.
 */
function OutputSurface() {
  useHandedSource()
  useCleanSurface()
  return (
    <div className="app app-output">
      <Stage />
    </div>
  )
}

function ControlSurface() {
  return (
    <div className="app app-control">
      <Console />
    </div>
  )
}

/**
 * Start whatever the control window handed us.
 *
 * Polled rather than pushed: this window is still loading while the control
 * window is putting the source down, and there is no listener to push into
 * until React has mounted. A short poll is simpler than a second handshake and
 * ends the moment a source arrives.
 */
function useHandedSource() {
  useEffect(() => {
    let alive = true
    const tick = () => {
      if (!alive) return
      const src = claimSource()
      if (!src) {
        window.setTimeout(tick, 100)
        return
      }
      // Routed through the store rather than the engine so the output window's
      // own `status` follows the source, which is what the post chain and the
      // directors gate on.
      if (src.kind === 'file') void useStore.getState().startAudioFile(src.file)
      else void useStore.getState().startHandedStream(src.stream, src.kind === 'system')
    }
    tick()
    return () => {
      alive = false
    }
  }, [])
}

/**
 * The two things an output surface owes an audience: no pointer, and a way into
 * fullscreen.
 *
 * Fullscreen cannot be requested on load — every browser requires a gesture —
 * so the first click anywhere does it. That is the entire interaction budget of
 * this window, which is rather the point of it.
 */
function useCleanSurface() {
  useEffect(() => {
    let timer = window.setTimeout(() => {
      document.body.style.cursor = 'none'
    }, CURSOR_HIDE_MS)

    const hideLater = () => {
      document.body.style.cursor = ''
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        document.body.style.cursor = 'none'
      }, CURSOR_HIDE_MS)
    }
    const goFullscreen = () => {
      // Every gesture, before anything else. This window is opened
      // programmatically and so may never have had user activation, which
      // leaves its AudioContext suspended — perfect silence, no error
      // anywhere. `connectStream` installs its own resume listener, but only
      // once a graph exists; this covers the window before that.
      audioEngine.resumeContext()
      if (document.fullscreenElement) return
      // Rejected when the gesture is untrusted or already declined. Neither is
      // worth surfacing: the window is a perfectly good capture target at any
      // size.
      void document.documentElement.requestFullscreen().catch(() => {})
    }

    window.addEventListener('mousemove', hideLater)
    window.addEventListener('pointerdown', goFullscreen)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('mousemove', hideLater)
      window.removeEventListener('pointerdown', goFullscreen)
      document.body.style.cursor = ''
    }
  }, [])
}
