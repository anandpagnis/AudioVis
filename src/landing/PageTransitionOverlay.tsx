import { useEffect, useRef } from 'react'
import { pageTransition } from './pageTransition'

/**
 * Mounted once at the router root (outside <Routes>) so it persists across
 * the Landing → Visualizer swap instead of unmounting with the page that
 * triggered it. `pageTransition` drives its opacity directly via classList,
 * not React state — see pageTransition.ts.
 */
export function PageTransitionOverlay() {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (ref.current) pageTransition.attach(ref.current)
  }, [])

  return <div className="page-transition-overlay" ref={ref} />
}
