import { useState } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router'
import { isMobileDevice, supportsWebGL2 } from './audio/capabilities'
import { PageTransitionOverlay } from './landing/PageTransitionOverlay'
import { Landing } from './routes/Landing'
import { Visualizer } from './routes/Visualizer'
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
      <PageTransitionOverlay />
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/app" element={<Visualizer />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
