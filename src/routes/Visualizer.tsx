import { useEffect } from 'react'
import { Stage } from '../engine/Stage'
import { HUD } from '../ui/HUD'
import { isProjector } from '../engine/projector'

/** Idle time before the pointer disappears on the output surface. */
const CURSOR_HIDE_MS = 2000

export function Visualizer() {
  const projector = isProjector()
  useProjectorSurface(projector)

  return (
    <div className="app">
      <Stage />
      {/* No chrome in a projector window, and that includes the keyboard map:
          not mounting the HUD is what removes it. The output surface is driven
          entirely from the wire, so a stray keypress on the screen an audience
          is looking at cannot change the show. */}
      {!projector && <HUD />}
    </div>
  )
}

/**
 * The two things a projector surface owes an audience: no pointer, and a way
 * into fullscreen.
 *
 * Fullscreen cannot be requested on load — every browser requires a user
 * gesture — so the first click anywhere does it. That is the entire interaction
 * budget of this window, which is rather the point of it.
 */
function useProjectorSurface(active: boolean) {
  useEffect(() => {
    if (!active) return
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
      if (document.fullscreenElement) return
      // Rejected when the gesture is not trusted, or when the user has already
      // declined. Neither is worth surfacing: the window is still a perfectly
      // good OBS capture target at any size.
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
  }, [active])
}
