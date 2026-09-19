import { Suspense, useEffect, useState } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router'
import { isMobileDevice, supportsWebGL2 } from './audio/capabilities'
import { PageTransitionOverlay } from './landing/PageTransitionOverlay'
import { Landing } from './routes/Landing'
import { Account, Bench, Help, Home, SignIn, Visualizer } from './routes/lazyRoutes'
import { UnsupportedScreen } from './ui/UnsupportedScreen'
import { trackPageview } from './lib/posthogClient'

/**
 * Fires a PostHog pageview on every navigation, including a hash-only change
 * (`/home` → `/home#pricing`) — `posthog-js`'s own `capture_pageview` only
 * fires once on initial load, which would make every in-app navigation on
 * this SPA invisible. Keyed on `location.key` (react-router's own per-
 * navigation identity, stable across re-renders that don't navigate) rather
 * than `pathname`, specifically so a hash-only change — same pathname,
 * different key — still re-fires this. Must live inside `<BrowserRouter>` to
 * read location at all; outside `<Suspense>` so a still-loading lazy route
 * doesn't delay or skip the pageview for the navigation that got it there.
 */
function AnalyticsPageviewTracker() {
  const location = useLocation()
  useEffect(() => {
    trackPageview()
  }, [location.key])
  return null
}

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
      <AnalyticsPageviewTracker />
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
          {/* Same lazy chunk as /app — Visualizer() branches on the path via
              isDemoWindow() rather than this being a second route module, so
              there is exactly one shared bundle for all three surfaces. */}
          <Route path="/demo" element={<Visualizer />} />
          <Route path="/home" element={<Home />} />
          <Route path="/account" element={<Account />} />
          <Route path="/sign-in" element={<SignIn />} />
          <Route path="/help" element={<Help />} />
          {/* Developer tool. `Bench` is null in production builds — the guard
              is on the export, not here, so the chunk is never emitted. */}
          {Bench && <Route path="/bench" element={<Bench />} />}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  )
}
