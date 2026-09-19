/**
 * Virtual scroll — wheel/keyboard feed one damped progress value (0..1)
 * instead of real document scroll, since the tunnel is a fixed full-bleed
 * canvas with nothing to scroll under it. Desktop-only (no touch handling):
 * the site gates mobile visitors out entirely at the App level.
 *
 * Hard-capped short of 1: the tunnel's true end (the last stretch of
 * TunnelScene's 1600m curve) isn't part of the ride — scroll physically
 * stops at 1460m/1600m so visitors never reach past it.
 */
const MAX_PROGRESS = 1460 / 1600

class ScrollController {
  target = 0
  value = 0
  private bound = false
  private reducedMotion = false

  onAdvance: (() => void) | null = null

  add(delta: number) {
    this.target = Math.max(0, Math.min(MAX_PROGRESS, this.target + delta))
    this.onAdvance?.()
  }

  // Stable instance references (not inline closures) so `unbind()` can
  // actually remove them — `removeEventListener` needs the SAME function
  // reference that was passed to `addEventListener`.
  private onWheel = (e: WheelEvent) => {
    e.preventDefault()
    let d = e.deltaY
    if (e.deltaMode === 1) d *= 18
    else if (e.deltaMode === 2) d *= window.innerHeight
    this.add(d * 0.00024)
  }

  private onKeydown = (e: KeyboardEvent) => {
    const k = e.key
    if (k === 'ArrowDown' || k === 'PageDown' || k === ' ') {
      e.preventDefault()
      this.add(k === ' ' ? 0.05 : 0.025)
    } else if (k === 'ArrowUp' || k === 'PageUp') {
      e.preventDefault()
      this.add(-0.025)
    } else if (k === 'Home') {
      this.target = 0
      this.onAdvance?.()
    } else if (k === 'End') {
      this.target = MAX_PROGRESS
      this.onAdvance?.()
    }
  }

  bind(reducedMotion: boolean) {
    if (this.bound) return
    this.bound = true
    this.reducedMotion = reducedMotion
    window.addEventListener('wheel', this.onWheel, { passive: false })
    window.addEventListener('keydown', this.onKeydown)
  }

  /**
   * Tears down what `bind()` attached. `scroll` is a module-level singleton
   * that outlives the route — Landing is the tunnel's only mount point and
   * unmounts on every navigation away from `/`, but without this the wheel
   * listener's unconditional `preventDefault()` (needed to turn real scroll
   * into the tunnel's virtual progress value) keeps eating every other
   * page's native scroll forever after the first tunnel visit (F243).
   * Landing calls this from the same effect's cleanup that calls `bind()`.
   */
  unbind() {
    if (!this.bound) return
    this.bound = false
    window.removeEventListener('wheel', this.onWheel)
    window.removeEventListener('keydown', this.onKeydown)
  }

  update(dt: number) {
    const k = 1 - Math.exp(-dt * (this.reducedMotion ? 12 : 4.2))
    this.value += (this.target - this.value) * k
  }
}

export const scroll = new ScrollController()
