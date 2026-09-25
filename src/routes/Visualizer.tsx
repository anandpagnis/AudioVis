import { useEffect, useState } from 'react'
import { Link, Navigate } from 'react-router'
import { Stage } from '../engine/Stage'
import { Console } from '../ui/Console'
import { LookDebug } from '../ui/LookDebug'
import { StructureLog } from '../ui/StructureLog'
import { audioEngine } from '../audio/AudioEngine'
import { claimSource, isDemoWindow, isOutput } from '../engine/outputLink'
import { djCamSource } from '../engine/djCamSource'
import { FREE_TIER_SCENE_IDS, preloadAllScenes, setSceneWhitelist } from '../scenes'
import { useAuth, useEntitlement } from '../auth/authStore'
import { trackEvent } from '../lib/posthogClient'
import { LAYER_ROLES, useStore } from '../store'

/** Idle time before the pointer disappears on the output surface. */
const CURSOR_HIDE_MS = 2000

/**
 * One route, three entirely different windows.
 *
 * `?output` is the show: the engine, the scenes, the post chain, and nothing
 * else — no chrome, no keyboard map, no pointer. `/demo` is the same bare
 * render, self-contained and restricted to a fixed scene pool, for a public
 * visitor with no control window at all (see DemoSurface). Everything else is
 * the DJ's control surface, which runs no engine at all and watches the output
 * through a mirror stream. See engine/outputLink.ts for why the split falls
 * this way.
 */
export function Visualizer() {
  if (isDemoWindow()) return <DemoSurface />
  return isOutput() ? <OutputSurface /> : <ControlSurface />
}

/**
 * The public, anonymous funnel: a handful of whitelisted scenes, driven by the
 * visitor's own mic or system audio, with zero DJ control chrome — no Console,
 * no keyboard map, just a source picker and two badges. Structurally an
 * OutputSurface with its own connect affordance instead of a handoff to wait
 * for, since there is no paired control window here (see isDemoWindow's doc
 * in outputLink.ts for why this can't just be `?output`).
 *
 * The scene renders immediately, same as OutputSurface waiting for a handoff
 * — there's no blocking "start" modal. `useCleanSurface` is deliberately NOT
 * active until a source is actually connected (`status === 'running'`): it
 * used to run unconditionally, which meant clicking ANY of this surface's own
 * buttons — the source picker, the free badge — triggered "click anywhere
 * goes fullscreen" as a side effect, since that behavior was written for
 * OutputSurface, which has no on-screen UI at all to misfire on.
 */
function DemoSurface() {
  const status = useStore((s) => s.status)
  const error = useStore((s) => s.error)
  const [sourceOpen, setSourceOpen] = useState(false)
  useCleanSurface(status === 'running')

  useEffect(() => {
    setSceneWhitelist(FREE_TIER_SCENE_IDS)
    // The whitelist above only restricts FUTURE autopilot picks — it does
    // nothing about whatever scene is already active. `sceneId` (and
    // `layerSceneIds`) are in store.ts's `partialize` allowlist, persisted
    // to localStorage for the whole origin with no per-route scoping. A
    // visitor on the SAME browser as a prior Console session (the site's own
    // owner, most likely) would otherwise land on whatever non-free scene
    // was last active there — outside the free tier, in the one place that's
    // supposed to guarantee it. `immediate: true` bypasses the normal dwell
    // floor so this corrects before the visitor sees anything, not on the
    // engine's own schedule.
    const s = useStore.getState()
    if (!FREE_TIER_SCENE_IDS.includes(s.sceneId)) {
      s.requestScene(FREE_TIER_SCENE_IDS[0], { auto: true, immediate: true })
    }
    for (const role of LAYER_ROLES) {
      const layerId = s.layerSceneIds[role]
      if (layerId && !FREE_TIER_SCENE_IDS.includes(layerId)) {
        s.setLayer(role, null)
      }
    }
    // Same leak as sceneId above, different field: `autoPilot` is also in
    // partialize, so a visitor on the same browser as a prior Console session
    // that had flipped the "picking scenes for you" toggle to manual inherits
    // that here too — the corrected scene above would land once and then
    // never advance again, with no error anywhere (AutoPilot.tsx's tick bails
    // at `!s.autoPilot` before it ever looks at the whitelist).
    if (!s.autoPilot) s.toggleAutoPilot()
    return () => setSceneWhitelist(null)
  }, [])

  const pick = (kind: 'mic' | 'system') => {
    setSourceOpen(false)
    // The funnel signal that matters here isn't "loaded /demo" (the
    // pageview already covers that) — it's "actually connected audio,"
    // proof someone engaged rather than bounced off a blank canvas.
    trackEvent('demo_source_connected', { kind })
    void useStore.getState().startAudio(kind)
  }

  return (
    <div className="app app-output demo-surface">
      <Stage />
      <div className="demo-chrome">
        <Link className="demo-logo" to="/home#pricing" title="See what Pro unlocks">
          LILIM
        </Link>
        <div className="demo-controls">
          <Link className="demo-free-badge" to="/home#pricing" title="See what Pro unlocks">
            Free
          </Link>
          {status !== 'running' && (
            <div className="demo-source">
              <button
                className="demo-source-btn"
                disabled={status === 'starting'}
                onClick={() => setSourceOpen((v) => !v)}
              >
                {status === 'starting' ? 'Connecting…' : 'Connect audio'}
              </button>
              {sourceOpen && (
                <div className="demo-source-panel">
                  <button onClick={() => pick('mic')}>Microphone</button>
                  <button onClick={() => pick('system')}>System audio</button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      {/* The scene renders but has nothing driving it until a source
          connects — without this, a first-time visitor just sees a black
          screen with no cue that the small top-right button is the reason.
          Also itself a shortcut into the same picker, not just a label. */}
      {(status === 'idle' || status === 'error') && (
        <button className="demo-hint" onClick={() => setSourceOpen(true)}>
          <span className="demo-hint-arrow">↗</span>
          Connect your audio to bring this to life
        </button>
      )}
      {error && <p className="demo-error">{error}</p>}
    </div>
  )
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
  usePrefetchScenes()
  return (
    <div className="app app-output">
      <Stage />
      {/* `?lookdebug` only (renders nothing otherwise): the mood look profile and what it applied. */}
      <LookDebug />
      {/* `?structurelog` only (renders nothing otherwise): the tap-to-mark section-change ground-truth logger. */}
      <StructureLog />
    </div>
  )
}

/**
 * Fetch every scene chunk once this window is idle, so a scene the show has
 * never shown yet — `maze` in the case this was measured against — is
 * already in the module cache by the time AutoPilot first requests it.
 *
 * F127: a session recording caught a 2.3s frame freeze on a cold `maze`
 * switch, landing exactly at the beat-locked commit's 2.5s backstop. The
 * warm gate that backstop protects only covers shader compile time; it
 * assumes the chunk itself is already in hand, which for a scene never
 * shown this session it was not. This pays that download cost once, off
 * the critical path, rather than on whichever scene the show happens to
 * request first — the same idle-prefetch shape `Landing` already uses for
 * the `/app` route chunk.
 *
 * Deferred to idle, same reason as `Landing`: it must never compete with
 * the FIRST scene's own load for bandwidth or main thread, or this would
 * just move the stall earlier instead of removing it.
 */
function usePrefetchScenes() {
  useEffect(() => {
    const ric = window.requestIdleCallback
    if (ric) {
      const handle = ric(() => preloadAllScenes(), { timeout: 8000 })
      return () => window.cancelIdleCallback?.(handle)
    }
    const timer = window.setTimeout(preloadAllScenes, 4000)
    return () => window.clearTimeout(timer)
  }, [])
}

/**
 * /app, signed-in-and-gated. There is no paywall screen here (see F244) — a
 * visitor who can't use the full console is redirected straight to the
 * surface they CAN use, rather than shown a card explaining why they can't:
 *
 *   pro       → the real thing, right here
 *   free      → /demo (the exact same restricted experience /demo already
 *               is; running it a second time in its own screen here would
 *               just be the same component behind a second URL)
 *   anonymous → /home, where the pitch, pricing, and sign-up actually live
 *
 * `Navigate` fires before paint (no flash of an empty /app), same pattern
 * App.tsx already uses for its catch-all route.
 */
function ControlSurface() {
  const plan = useEntitlement()
  // Briefly true on load while Supabase checks for a stored session. Held
  // blank rather than redirecting immediately, or a returning Pro visitor
  // gets bounced through /demo or /home before flipping to the console they
  // already have access to.
  const authLoading = useAuth().status === 'loading'
  if (authLoading) return <div className="app app-control" />
  if (plan === 'pro') {
    return (
      <div className="app app-control">
        <Console />
      </div>
    )
  }
  if (plan === 'free') return <Navigate to="/demo" replace />
  return <Navigate to="/home" replace />
}

/**
 * Start whatever the control window hands us — now, or later.
 *
 * Polled rather than pushed: this window is still loading while the control
 * window is putting the first source down, and there is no listener to push
 * into until React has mounted.
 *
 * The poll does NOT stop after the first source. The audio source lands once at
 * startup, but the DJ-cam stream is handed over whenever the operator clicks
 * "Connect camera" — seconds or minutes later, and again on every reconnect. A
 * one-shot claim (the original shape) meant the camera never reached this
 * window and the "Cut to DJ Cam" punch did nothing. `claimSource` clears the
 * slot on read, so an idle poll is just a cheap `null` check.
 */
function useHandedSource() {
  useEffect(() => {
    let alive = true
    const tick = () => {
      if (!alive) return
      const src = claimSource()
      if (src) {
        // Routed through the store rather than the engine so the output
        // window's own `status` follows the source, which is what the post
        // chain and the directors gate on.
        if (src.kind === 'file') void useStore.getState().startAudioFile(src.file)
        // The camera is not an audio source — it feeds `DjCamScene`'s texture,
        // not the analysis graph — so it goes straight to its own singleton and
        // never touches `status`.
        else if (src.kind === 'camera') djCamSource.adoptStream(src.stream)
        else void useStore.getState().startHandedStream(src.stream, src.kind === 'system')
      }
      window.setTimeout(tick, 100)
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
 *
 * `active` gates this off entirely — pass false while there's real UI on
 * screen to click (DemoSurface's audio-source picker, before a source is
 * connected). Without this, clicking ANY button — including a plain
 * navigation link — went fullscreen as a side effect, which is exactly wrong
 * for a button that isn't "start the show." `OutputSurface` has no such UI
 * ever, so it doesn't pass this and stays always-on.
 */
function useCleanSurface(active = true) {
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
    // `active` matters here: DemoSurface flips it true only once a source
    // actually connects, and the effect has to re-run to attach the
    // listeners at that point rather than only on mount.
  }, [active])
}
