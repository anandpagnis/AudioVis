/**
 * Browser/device capability checks for the start-card gate.
 *
 * Pure functions over an injectable `nav`-like object so the detection logic
 * is unit-testable without a DOM — this project's test environment is
 * `node` (see vite.config.ts), so there is no real `navigator` in tests.
 */

export interface NavLike {
  userAgent: string
  maxTouchPoints?: number
  mediaDevices?: { getDisplayMedia?: unknown }
}

/**
 * Phones/tablets: system-audio capture doesn't exist as a concept there, the
 * render budget is unproven on mobile GPUs, and the HUD's panels aren't laid
 * out for a small touch viewport. Rather than let visitors hit a half-broken
 * experience, App.tsx gates the whole app behind this before Stage/HUD mount.
 */
export function isMobileDevice(nav: NavLike): boolean {
  if (/Android|iPhone|iPad|iPod|Mobile|Windows Phone/i.test(nav.userAgent)) return true
  // iPadOS 13+ reports a desktop-Safari UA ("Macintosh…") by default — the one
  // case the regex above can't catch. Touch-point count is the tell: a real
  // Mac reports 0, an iPad reports 5.
  return /Macintosh/i.test(nav.userAgent) && (nav.maxTouchPoints ?? 0) > 2
}

/**
 * Best-effort: `getDisplayMedia` existing doesn't guarantee an audio track is
 * obtainable from it — Safari exposes the API for video-only screen share, so
 * it's excluded outright rather than trusted on the API's mere presence.
 * `AudioEngine.acquireStream` still carries its own runtime error handling
 * for the case this heuristic is wrong in either direction.
 */
export function supportsSystemAudioCapture(nav: NavLike): boolean {
  if (!nav.mediaDevices?.getDisplayMedia) return false
  const isSafari = /Safari/i.test(nav.userAgent) && !/Chrome|CriOS|Chromium|Edg/i.test(nav.userAgent)
  return !isSafari
}

/**
 * Hard requirement — every scene renders through WebGL2, with no fallback
 * rendering path. Checked via a throwaway canvas; not unit-tested (needs a
 * real DOM), same as the rest of the audio/render graph.
 */
export function supportsWebGL2(): boolean {
  try {
    const canvas = document.createElement('canvas')
    return !!canvas.getContext('webgl2')
  } catch {
    return false
  }
}
