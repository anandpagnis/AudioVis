import { Suspense, useState } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router'
import { isMobileDevice, supportsWebGL2 } from './audio/capabilities'
import { PageTransitionOverlay } from './landing/PageTransitionOverlay'
import { Landing } from './routes/Landing'
import { Bench, Visualizer } from './routes/lazyRoutes'
import { UnsupportedScreen } from './ui/UnsupportedScreen'

export default function App() {
  // Checked once per load, not on resize — a phone rotated to landscape is
  // still a phone. Lazy initializer keeps the (cheap but non-trivial) checks
  // out of the render path on every re-render. Gates the WHOLE site, not just
  // the visualizer: the landing tunnel is itself a WebGL experience and the
  // site is desktop-only by design, so there is no route worth reaching on
  // an unsupported device.
  const [gate] = useState<'mobile' | 'webgl' | null>(() => {
    if (isMobileDevice(navigator)) return 'mobile'
    if (!supportsWebGL2()) return 'webgl'
    return null
  })

  if (gate) return <UnsupportedScreen reason={gate} />

  return (
    <BrowserRouter>
      {/* Outside Suspense on purpose: the overlay is what covers a route swap,
          so it must stay mounted while the incoming route is still loading. */}
      <PageTransitionOverlay />
      {/* Only /app is code-split; Landing is static because every visitor
          needs it immediately (see routes/lazyRoutes.ts). The fallback is null
          rather than a spinner: the CTA fades to black BEFORE navigating, so a
          loading indicator would be a flash of chrome in the middle of a
          deliberate blackout. Landing prefetches the chunk while idle, so in
          practice this boundary is almost never hit. */}
      <Suspense fallback={null}>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/app" element={<Visualizer />} />
          {/* Developer tool. `Bench` is null in production builds — the guard
              is on the export, not here, so the chunk is never emitted. */}
          {Bench && <Route path="/bench" element={<Bench />} />}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  )
}
