import type { PostHog } from 'posthog-js'

const key = import.meta.env.VITE_POSTHOG_KEY as string | undefined

/**
 * Region defaults to US cloud — PostHog's token format doesn't encode which
 * region a project lives in, and this deploy's project was created without
 * confirming that. If events silently don't show up in the dashboard, this
 * is the first thing to check (EU projects need `https://eu.i.posthog.com`).
 */
const API_HOST = 'https://us.i.posthog.com'

let posthog: PostHog | null = null
let initStarted = false

type QueuedCall =
  | { kind: 'capture'; name: string; properties?: Record<string, unknown> }
  | { kind: 'identify'; userId: string; properties?: Record<string, unknown> }
  | { kind: 'reset' }

/**
 * Calls made before the idle-deferred import below resolves (very plausible
 * — the very first `$pageview`, fired from App.tsx on initial mount, almost
 * always beats an idle callback) are queued here and replayed in order once
 * `posthog` is set, rather than silently dropped. Losing that first pageview
 * specifically would mean never seeing the actual top of the funnel — the
 * tunnel load itself.
 */
const queue: QueuedCall[] = []

function flush(): void {
  if (!posthog) return
  const ph = posthog
  for (const call of queue) {
    if (call.kind === 'capture') ph.capture(call.name, call.properties)
    else if (call.kind === 'identify') ph.identify(call.userId, call.properties)
    else ph.reset()
  }
  queue.length = 0
}

/**
 * No-ops everywhere (including this function) when the key isn't configured
 * — same graceful-degradation posture as `lib/supabaseClient.ts`, so a
 * deploy that hasn't set up PostHog yet keeps working exactly as before.
 *
 * `posthog-js` is a genuinely heavy dependency (~100 kB gzipped) and this is
 * imported from `main.tsx`, which is NOT code-split — a static top-level
 * import would land it in the tunnel's entry bundle, the one chunk this
 * codebase is most careful about keeping light (see lazyRoutes.ts's own
 * doc on why `Landing` stays a static import but the visualizer doesn't).
 * Deferred via `requestIdleCallback` + dynamic `import()`, same pattern
 * `preloadVisualizer` already uses — analytics has no business competing
 * with the tunnel's own first frames for bandwidth or main thread.
 *
 * Deliberately narrow capture surface once loaded, not PostHog's defaults:
 * `autocapture` and `capture_pageview` are both off, and session recording
 * is off outright — none of those were asked for, and turning them on would
 * mean tracking far more than the funnel steps this was actually built for
 * (see trackEvent's callers: demo connects, the Pro CTA, sign-in/out).
 * Pageviews are captured manually instead (see the router tracker in
 * App.tsx), which is also what makes hash changes (`#pricing`,
 * `#marketplace`) show up as distinct URLs rather than being invisible to a
 * plain onload pageview.
 */
export function initAnalytics(): void {
  if (!key || initStarted) return
  initStarted = true

  const load = () => {
    void import('posthog-js').then((mod) => {
      const ph = mod.default
      ph.init(key, {
        api_host: API_HOST,
        person_profiles: 'identified_only',
        autocapture: false,
        capture_pageview: false,
        disable_session_recording: true,
      })
      posthog = ph
      flush()
    })
  }

  const ric = window.requestIdleCallback
  if (ric) ric(load, { timeout: 4000 })
  else window.setTimeout(load, 2000)
}

/** Manual pageview capture — see initAnalytics's doc for why this isn't automatic. */
export function trackPageview(): void {
  if (!key) return
  if (posthog) posthog.capture('$pageview')
  else queue.push({ kind: 'capture', name: '$pageview' })
}

/** Named funnel events. The string here is the ONE place an event name is spelled. */
export function trackEvent(name: string, properties?: Record<string, unknown>): void {
  if (!key) return
  if (posthog) posthog.capture(name, properties)
  else queue.push({ kind: 'capture', name, properties })
}

/**
 * Ties whatever anonymous activity preceded sign-in to the now-known user —
 * without this, PostHog has no way to connect "visited /home, viewed
 * pricing, clicked sign up" to the account that activity actually became.
 * Called from authStore's SIGNED_IN handler.
 */
export function identifyUser(userId: string, properties?: Record<string, unknown>): void {
  if (!key) return
  if (posthog) posthog.identify(userId, properties)
  else queue.push({ kind: 'identify', userId, properties })
}

/**
 * Clears the identified user so a later anonymous session on the same
 * browser (e.g. a shared machine) doesn't get attributed to whoever signed
 * out. Called from authStore's SIGNED_OUT handler.
 */
export function resetIdentity(): void {
  if (!key) return
  if (posthog) posthog.reset()
  else queue.push({ kind: 'reset' })
}
