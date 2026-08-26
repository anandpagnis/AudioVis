import { audioEngine } from '../audio/AudioEngine'
import { performanceState } from './performanceState'
import { quality } from './quality'
import { frameSampler } from './frameSampler'
import { useStore } from '../store'

/**
 * The two-window contract: a DJ-facing control surface and the one window that
 * actually renders.
 *
 * ## The shape, and the constraint that forces it
 *
 * The output window **is the app**. It owns the audio device, runs every
 * director, mounts the scenes and draws the frame. The control window runs no
 * engine at all: it is a control surface plus a `<video>` showing the output
 * window's own canvas.
 *
 * That split exists to satisfy one requirement — *the main processing happens
 * once*. The obvious two-window design renders the show twice, once per window,
 * and doubles the cost of exactly the scenes that can least afford it
 * (`synthgrid` and `network` are ~22 ms each on the bench GPU). Here nothing is
 * rendered twice: the mini mirror is a `MediaStream` off the output canvas, so
 * the DJ's preview costs a frame copy rather than a frame.
 *
 * ## Two channels, deliberately different
 *
 * **Live objects go by direct reference**, not over a wire. Same-origin windows
 * share a heap for this purpose, so the control window can hand the output
 * window an actual `MediaStream` or `File`, and the output window can hand a
 * `MediaStream` back. Verified in both directions before this was built:
 * a captured stream arrives with its track `live`, and a WebGL canvas captured
 * in one window decodes in a `<video>` in the other (`readyState` 4, frames
 * advancing). Neither object is structured-cloneable, so this is not merely the
 * faster path, it is the only one.
 *
 * **State goes over `BroadcastChannel`**: the look and every control downward,
 * a small telemetry packet upward. Both are plain data and both are small.
 *
 * ## Why the audio source is acquired in the CONTROL window
 *
 * `getDisplayMedia` and `getUserMedia` need transient user activation, and a
 * freshly opened window does not reliably have any — the click happened in the
 * opener. So the control window acquires (inside the click that also opens the
 * output window) and hands the live stream across. A `File` from an `<input>`
 * travels the same way.
 *
 * ## What happens when the output window is not there
 *
 * Nothing renders, and the control surface says so with a button to open it.
 * The deliberate non-choice is falling back to rendering in the control window:
 * that reintroduces the second render this whole design exists to remove, and
 * it would do it silently, at exactly the moment someone is on stage.
 */

/** Store fields that describe the show. Everything here is mirrored downward. */
const LOOK_FIELDS = [
  'sceneId',
  // The request, not the commitment. `requestScene` only sets this; the output
  // window's SceneManager is what promotes it to `sceneId`, on a downbeat, once
  // the incoming scene has warmed. Publishing only `sceneId` meant a scene
  // press in the control window changed nothing at all — measured, the output
  // sat on `wireframe` through every press.
  'pendingSceneId',
  'layerSceneIds',
  'paletteId',
  'params',
  'layerFx',
  'sceneParams',
  'quality',
  'autoPilot',
  'moodDrive',
  'cueFollow',
  'cues',
  'debugPostFx',
] as const

export type LookField = (typeof LOOK_FIELDS)[number]
export type Look = Record<LookField, unknown>

/** What the output window reports back for the control surface's readouts. */
export interface Telemetry {
  bpm: number
  confidence: number
  energy: number
  beatInBar: number
  phraseProgress: number
  mood: string
  scene: string
  palette: string
  tier: number
  fps: number
  frameMs: number
  running: boolean
}

const CHANNEL = 'audiovis-link'
/** Telemetry cadence. Fast enough for a beat dot, far below the frame rate. */
export const TELEMETRY_INTERVAL_MS = 100
/** The control surface calls the output dead after this long without a packet. */
export const TELEMETRY_STALE_MS = 1500

type Msg =
  | { t: 'hello' }
  | { t: 'look'; look: Look }
  | { t: 'tele'; d: Telemetry }
  | { t: 'closing' }

let channel: BroadcastChannel | null = null
let unsubscribe: (() => void) | null = null
let lastTeleAt = -Infinity
let lastTelePublish = -Infinity
let telemetry: Telemetry | null = null
let mirrorStream: MediaStream | null = null
let mirrorListener: ((s: MediaStream | null) => void) | null = null
let outputWindow: Window | null = null

/** Handed across by direct reference; consumed once by the output window. */
export type HandedSource =
  | { kind: 'file'; file: File }
  | { kind: 'mic' | 'system'; stream: MediaStream }

interface LinkGlobals {
  __avSource?: HandedSource | null
  __avTakeMirror?: (stream: MediaStream) => void
}

/** Is this window the output surface? */
export function isOutput(): boolean {
  if (typeof window === 'undefined') return false
  return new URLSearchParams(window.location.search).has('output')
}

function snapshotLook(): Look {
  const s = useStore.getState() as unknown as Record<string, unknown>
  const look = {} as Look
  for (const k of LOOK_FIELDS) look[k] = s[k]
  return look
}

// ---------------------------------------------------------------------------
// Channel
// ---------------------------------------------------------------------------

export function startLink(): void {
  if (channel || typeof BroadcastChannel === 'undefined') return
  channel = new BroadcastChannel(CHANNEL)
  channel.onmessage = (e) => {
    const m = e.data as Msg
    if (isOutput()) {
      // The control window is the source of truth for the look; the output
      // window only ever applies it. A follower that could also publish would
      // echo its own applies straight back.
      if (m.t === 'look') useStore.setState(m.look as never)
      else if (m.t === 'hello') channel?.postMessage({ t: 'look', look: snapshotLook() } satisfies Msg)
      return
    }
    if (m.t === 'tele') {
      telemetry = m.d
      lastTeleAt = performance.now()
      adoptCommittedScene(m.d)
    } else if (m.t === 'hello') {
      // The output window has (re)loaded and has nothing. Answer immediately —
      // it is showing the boot defaults until this lands.
      channel?.postMessage({ t: 'look', look: snapshotLook() } satisfies Msg)
    } else if (m.t === 'closing') {
      telemetry = null
      lastTeleAt = -Infinity
      setMirror(null)
    }
    return
  }

  if (isOutput()) {
    // Ask before rendering anything: the control window holds the real look and
    // this window is otherwise about to open on whatever `persist` restored.
    channel.postMessage({ t: 'hello' } satisfies Msg)
    window.addEventListener('pagehide', () => {
      channel?.postMessage({ t: 'closing' } satisfies Msg)
    })
    return
  }

  let prev = snapshotLook()
  unsubscribe = useStore.subscribe(() => {
    const next = snapshotLook()
    let changed = false
    for (const k of LOOK_FIELDS) if (next[k] !== prev[k]) changed = true
    if (!changed) return
    prev = next
    channel?.postMessage({ t: 'look', look: next } satisfies Msg)
  })
}

export function stopLink(): void {
  unsubscribe?.()
  unsubscribe = null
  channel?.close()
  channel = null
  telemetry = null
  lastTeleAt = -Infinity
}

// ---------------------------------------------------------------------------
// Control window
// ---------------------------------------------------------------------------

/**
 * Open the output window, or focus the one already open.
 *
 * Must be called inside a user gesture or the popup blocker eats it, which is
 * why this is folded into the same click that starts audio rather than fired on
 * load. Returns the window so the caller can tell whether it was blocked.
 */
export function openOutput(): Window | null {
  if (typeof window === 'undefined') return null
  if (outputWindow && !outputWindow.closed) {
    outputWindow.focus()
    return outputWindow
  }
  const url = `${window.location.pathname}?output`
  outputWindow = window.open(url, 'audiovis-output', 'popup=yes,width=1280,height=720')
  return outputWindow
}

export function outputIsOpen(): boolean {
  return !!outputWindow && !outputWindow.closed
}

/**
 * Hand a live audio source to the output window.
 *
 * By assignment onto the other window's global rather than through the channel:
 * neither a `MediaStream` nor an open `File` handle survives a structured
 * clone. The output window may not have finished loading, so this is left for
 * it to collect (see {@link claimSource}) rather than pushed into a listener
 * that might not exist yet.
 */
export function handSource(src: HandedSource): boolean {
  const w = outputWindow
  if (!w || w.closed) return false
  try {
    ;(w as Window & LinkGlobals).__avSource = src
    return true
  } catch {
    // Cross-origin, which should be impossible for a window we opened at our
    // own path — but a failure here must not take the start flow down.
    return false
  }
}

/** Subscribe to the mirror stream. Fires immediately if one has already arrived. */
export function onMirror(cb: (stream: MediaStream | null) => void): () => void {
  mirrorListener = cb
  if (mirrorStream) cb(mirrorStream)
  return () => {
    mirrorListener = null
  }
}

function setMirror(stream: MediaStream | null): void {
  mirrorStream = stream
  mirrorListener?.(stream)
}

/**
 * Expose the hook the output window calls to hand its canvas back.
 *
 * Installed before the window is opened, deliberately: the output window
 * publishes as soon as it has drawn a frame, and a hook that appears later
 * would miss that call. (The first version of this probe called the hook before
 * defining it, which is precisely the failure this ordering prevents.)
 */
export function installMirrorHook(): void {
  if (typeof window === 'undefined') return
  ;(window as Window & LinkGlobals).__avTakeMirror = (stream: MediaStream) => setMirror(stream)
}

/**
 * Adopt the output window's committed scene as ours.
 *
 * The two windows own different halves of a scene change: the control window
 * owns the REQUEST and the output window owns the COMMITMENT, because only it
 * knows when the incoming scene has warmed and where the next downbeat is. So
 * `sceneId` has to travel back up, or the control window would keep publishing
 * the scene the operator asked for before the switch and undo it.
 *
 * Converges rather than loops: writing the value the output already holds
 * republishes the same value, and the second pass is a no-op.
 */
function adoptCommittedScene(d: Telemetry): void {
  const s = useStore.getState()
  if (!d.scene || d.scene === s.sceneId) return
  useStore.setState({ sceneId: d.scene, pendingSceneId: null } as never)
}

/** Latest telemetry from the output window, or null when it has gone quiet. */
export function readTelemetry(): Telemetry | null {
  if (!telemetry) return null
  return performance.now() - lastTeleAt > TELEMETRY_STALE_MS ? null : telemetry
}

// ---------------------------------------------------------------------------
// Output window
// ---------------------------------------------------------------------------

/**
 * Take the audio source the control window left for us, if any.
 *
 * Consumed — cleared on read — so a re-render cannot restart the same source
 * twice, and so a stale handle cannot be picked up after the track ended.
 */
export function claimSource(): HandedSource | null {
  if (typeof window === 'undefined') return null
  const g = window as Window & LinkGlobals
  const src = g.__avSource ?? null
  g.__avSource = null
  return src
}

/**
 * Hand this window's canvas to the control window as a live stream.
 *
 * Returns true once it has succeeded, so the caller can stop trying. Fails
 * quietly while the canvas has not drawn yet, when there is no opener (someone
 * navigated to `?output` directly), or when the opener has gone.
 */
export function publishMirror(canvas: HTMLCanvasElement): boolean {
  if (typeof window === 'undefined') return false
  const opener = window.opener as (Window & LinkGlobals) | null
  if (!opener || opener.closed) return false
  const take = opener.__avTakeMirror
  if (typeof take !== 'function') return false
  if (canvas.width === 0 || canvas.height === 0) return false
  try {
    // NO ARGUMENT, and it matters. `captureStream(0)` does not mean "whenever
    // the canvas changes" — it means frames are only produced when something
    // calls `track.requestFrame()`, so the mirror arrived with `readyState` 4
    // and `currentTime` pinned at 0 forever. Omitting the rate is what gives a
    // frame per canvas update: no timer, no fixed cadence, and nothing produced
    // while the show is idle.
    take(canvas.captureStream())
    return true
  } catch {
    return false
  }
}

/** Publish the readouts the control surface shows. Cheap, and rate-limited. */
export function publishTelemetry(nowMs = performance.now()): void {
  if (!channel || !isOutput()) return
  if (nowMs - lastTelePublish < TELEMETRY_INTERVAL_MS) return
  lastTelePublish = nowMs
  const f = audioEngine.features
  const mean = frameSampler.display.mean()
  channel.postMessage({
    t: 'tele',
    d: {
      bpm: f.bpm,
      confidence: f.confidence,
      energy: f.energy,
      beatInBar: f.beatInBar,
      phraseProgress: f.phraseProgress,
      mood: f.mood.state,
      scene: performanceState.activeScene,
      palette: performanceState.palette,
      tier: quality.tier,
      fps: mean > 0 ? 1000 / mean : 0,
      frameMs: mean,
      running: audioEngine.running,
    },
  } satisfies Msg)
}
