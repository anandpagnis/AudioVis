import { tunnelAudio } from './tunnelAudio'

const FADE_SEC = 0.85
const HOLD_MS = 120

/**
 * Cross-fade between routes — specifically the tunnel's exit into `/app`.
 * A plain CSS-transitioned overlay (not a per-frame rAF loop): this is a
 * one-shot, low-frequency animation, so there's no reason to fight the
 * rAF-throttling issues a continuous loop would hit in a backgrounded tab.
 *
 * Singleton + an imperatively-attached DOM ref, matching `scroll`/
 * `tunnelAudio` elsewhere in this module — the overlay itself is mounted
 * once at the router root (outside <Routes>) so it survives the route swap.
 */
class PageTransition {
  private el: HTMLDivElement | null = null

  attach(el: HTMLDivElement) {
    this.el = el
  }

  /** Fades to black (and the tunnel's music with it), navigates, fades back in. */
  enter(navigate: (to: string) => void, to: string) {
    const el = this.el
    if (!el) {
      navigate(to)
      return
    }
    tunnelAudio.fadeOut(FADE_SEC)
    el.classList.add('active')
    window.setTimeout(
      () => {
        navigate(to)
        requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('active')))
      },
      FADE_SEC * 1000 + HOLD_MS,
    )
  }
}

export const pageTransition = new PageTransition()
