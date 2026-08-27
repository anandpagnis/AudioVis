import { audioEngine } from '../audio/AudioEngine'
import { essentiaBridge } from '../audio/essentia/EssentiaBridge'
import { voiceBridge } from '../audio/essentia/VoiceBridge'
import { analytics } from './analyticsMetrics'
import { exposure } from './exposure'
import { frameLoad } from './frameLoad'
import { keyPaletteTracker } from './keyPalette'
import { perf, frameTimeWindow } from './PerfMonitor'
import { performanceState } from './performanceState'
import { quality } from './quality'
import { sessionLog } from './sessionLog'
import { frameSampler } from './frameSampler'
import { transitionMetrics } from './transitionMetrics'
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
  /**
   * The output window's REAL audio status.
   *
   * The control window used to set its own `status` to `running` the moment it
   * handed the source over, which is optimism rather than knowledge: if the
   * output window failed to decode the file or the track ended, the console
   * went on showing a running transport with a Stop button for a show that had
   * already finished. What is playing is a fact only the output window has.
   */
  status: string
  sourceType: string | null
  recording: boolean
  /**
   * Session recorder state, reported by the window that is actually running it.
   *
   * On the wire rather than kept in the console for the reason the `Command`
   * doc above already records the hard way: a console that tracks its own
   * belief about a remote action shows a lit button for something that never
   * happened. `logSec` is what makes it unambiguous — a number that is visibly
   * counting cannot be a stale flag.
   */
  logging: boolean
  logSec: number
  /** AudioContext state in the output window: none / suspended / running. */
  audioState: string
  /** True once a graph has been built, whether or not it is running. */
  hasSource: boolean
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
/** Window name, so a lost handle can be re-acquired rather than re-opened. */
const OUTPUT_WINDOW_NAME = 'audiovis-output'
/** Telemetry cadence. Fast enough for a beat dot, far below the frame rate. */
export const TELEMETRY_INTERVAL_MS = 100
/** The control surface calls the output dead after this long without a packet. */
export const TELEMETRY_STALE_MS = 1500

/**
 * Things only the output window can do, asked for from the control window.
 *
 * Not state, and that is why they are a separate message rather than more
 * fields on the look. Stopping audio, arming the recorder and saving a frame
 * all act on objects that live exclusively in the output window — the
 * `AudioContext`, the `MediaRecorder`, the canvas — and the control window's
 * own copies of those are idle and empty. Calling them locally, which is what
 * the console did at first, stopped nothing and recorded nothing while the
 * button lit up as though it had worked.
 */
export type Command =
  | 'stop'
  | 'cancel-start'
  | 'toggle-record'
  | 'screenshot'
  | 'toggle-session-log'

/**
 * Everything the operator's diagnostic panels read, in one packet.
 *
 * The three panels — audio debug, fps meter, analytics — are operator tools, so
 * they belong on the console. But every singleton they read now lives in the
 * output window. Rather than rewrite three panels to take props, this ships the
 * singletons themselves and the console mirrors them into its own idle copies:
 * the panels then work unmodified, reading exactly what they always read.
 *
 * **Sent only while a panel is open.** It is an order of magnitude heavier than
 * the base telemetry (a 512-bin spectrum and two 1024-sample waveforms), and
 * for most of a set nobody is looking at it. The console asks; the output
 * window stops the moment it stops being asked.
 */
export interface Detail {
  f: unknown
  ps: unknown
  fl: unknown
  perf: unknown
  exp: unknown
  an: unknown
  es: unknown
  vo: unknown
  kf: string
  /** RAW frame times since the last packet, not a smoothed mean. */
  ms: number[]
  tx: unknown[]
  tier: number
}

type Msg =
  | { t: 'hello'; from: string }
  | { t: 'want-detail'; on: boolean }
  | { t: 'detail'; d: Detail }
  | { t: 'look'; look: Look }
  | { t: 'tele'; d: Telemetry }
  | { t: 'cmd'; c: Command }
  | { t: 'ctl'; id: string }
  | { t: 'closing' }

/**
 * Identifies this window on the channel.
 *
 * Sorts, because the arbitration between two control windows is "lowest id
 * wins" and a random string gives a stable total order with no negotiation.
 */
const SELF_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

/** Other control windows seen recently, and when. Used only for the election. */
const peers = new Map<string, number>()
/** How long a controller stays counted after its last announcement. */
const PEER_TTL_MS = 2500
/** Announcement cadence. Well inside the TTL so one dropped message is nothing. */
const CTL_ANNOUNCE_MS = 800

let channel: BroadcastChannel | null = null
let unsubscribe: (() => void) | null = null
let announceTimer = 0
let detailWanted = false
let lastDetailAt = -Infinity
const rawFrameMs: number[] = []
let lastTeleAt = -Infinity
let lastTelePublish = -Infinity
let telemetry: Telemetry | null = null
let mirrorStream: MediaStream | null = null
let mirrorListener: ((s: MediaStream | null) => void) | null = null
let outputWindow: Window | null = null

/**
 * How long a hand-off may hold off telemetry adoption.
 *
 * Sized against the acquisition it covers, not against a frame: the share
 * picker's own timeout is 60 s and the operator is choosing a window in it. A
 * shorter grace would re-open the bug for anyone who hesitates.
 */
export const HANDOFF_GRACE_MS = 70_000

let handoffUntil = -Infinity

/** Mark a source acquisition as in progress. Called before the prompt opens. */
export function beginHandoff(): void {
  handoffUntil = performance.now() + HANDOFF_GRACE_MS
}

/** Clear it — on success, on failure, and on cancel. */
export function endHandoff(): void {
  handoffUntil = -Infinity
}

export function handoffInFlight(): boolean {
  return performance.now() < handoffUntil
}

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
      else if (m.t === 'cmd') runCommand(m.c)
      else if (m.t === 'want-detail') detailWanted = m.on
      return
    }
    if (m.t === 'tele') {
      telemetry = m.d
      lastTeleAt = performance.now()
      adoptCommittedScene(m.d)
      adoptOutputStatus(m.d)
    } else if (m.t === 'hello') {
      // The output window has (re)loaded and has nothing. Only the active
      // controller answers, or two consoles would race to define the look.
      if (isActiveController()) {
        channel?.postMessage({ t: 'look', look: snapshotLook() } satisfies Msg)
      }
    } else if (m.t === 'detail') {
      applyDetail(m.d)
    } else if (m.t === 'ctl') {
      if (m.id !== SELF_ID) peers.set(m.id, performance.now())
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
    channel.postMessage({ t: 'hello', from: SELF_ID } satisfies Msg)
    window.addEventListener('pagehide', () => {
      channel?.postMessage({ t: 'closing' } satisfies Msg)
    })
    return
  }

  // Announce so other control windows can see this one. See isActiveController.
  channel.postMessage({ t: 'ctl', id: SELF_ID } satisfies Msg)
  announceTimer = window.setInterval(() => {
    channel?.postMessage({ t: 'ctl', id: SELF_ID } satisfies Msg)
  }, CTL_ANNOUNCE_MS)

  let prev = snapshotLook()
  unsubscribe = useStore.subscribe(() => {
    const next = snapshotLook()
    let changed = false
    for (const k of LOOK_FIELDS) if (next[k] !== prev[k]) changed = true
    if (!changed) return
    prev = next
    // A passive controller watches; it does not drive. Without this, two open
    // consoles both publish and the output window takes whichever message
    // landed last — the show flickering between two people's ideas of it.
    if (!isActiveController()) return
    channel?.postMessage({ t: 'look', look: next } satisfies Msg)
  })
}

export function stopLink(): void {
  unsubscribe?.()
  unsubscribe = null
  if (announceTimer !== 0) window.clearInterval(announceTimer)
  announceTimer = 0
  peers.clear()
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
export function openOutput(opts: { focus?: boolean } = {}): Window | null {
  if (typeof window === 'undefined') return null
  if (outputWindow && !outputWindow.closed) {
    // Focus only when the operator asked for this window directly. On the start
    // path the very next thing is a capture prompt owned by THIS window, and
    // pulling focus away from it first is asking for trouble.
    if (opts.focus) outputWindow.focus()
    return outputWindow
  }
  // A window already open under this name is REUSED by `window.open`, so a
  // control window that lost its handle recovers it here rather than opening a
  // second output.
  const url = `${window.location.pathname}?output`
  outputWindow = window.open(url, OUTPUT_WINDOW_NAME, 'popup=yes,width=1280,height=720')
  return outputWindow
}

/**
 * Is an output window alive?
 *
 * **Telemetry, not the handle.** The handle is module state, so it is null
 * after any reload of the control window (every HMR update in dev, and any
 * refresh in production) while the output window carries on rendering and
 * publishing perfectly happily. Reading presence off the handle made the
 * console say "output down" in the same breath as it displayed that window's
 * tier, frame time and current scene — which is where this was found.
 *
 * A packet inside {@link TELEMETRY_STALE_MS} is proof; the handle is a
 * secondary signal for the case where the window has opened but not yet drawn
 * its first frame.
 */
export function outputIsOpen(): boolean {
  if (readTelemetry()) return true
  return !!outputWindow && !outputWindow.closed
}

/**
 * Recover a lost handle to an already-open output window.
 *
 * `window.open` with a NAME and an empty URL returns the existing window
 * without navigating it — the standard way to re-acquire a handle. Guarded on
 * telemetry because with no such window that same call would CREATE a blank
 * popup, which is worse than the problem.
 */
function reacquireOutput(): Window | null {
  if (outputWindow && !outputWindow.closed) return outputWindow
  if (!readTelemetry()) return null
  try {
    outputWindow = window.open('', OUTPUT_WINDOW_NAME)
  } catch {
    outputWindow = null
  }
  return outputWindow
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
  // Recover first. Losing the handle used to mean the acquired stream was
  // stopped and the operator got "No output window" while an output window sat
  // there rendering.
  const w = reacquireOutput() ?? outputWindow
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
      status: useStore.getState().status,
      sourceType: useStore.getState().sourceType,
      recording: useStore.getState().isRecording,
      logging: sessionLog.isRecording(),
      logSec: sessionLog.elapsedSec(),
      audioState: audioEngine.contextState,
      hasSource: audioEngine.running,
    },
  } satisfies Msg)
}

/**
 * Is this the control window that drives the output?
 *
 * Lowest id wins, over the set of controllers that have announced recently.
 * There is no handshake and no leader term: every controller can evaluate the
 * same rule from the same evidence, and a controller that closes simply stops
 * announcing and ages out. The cost of being wrong for one interval is one
 * duplicated look message, which is idempotent.
 *
 * The output window is never a controller and always returns false.
 */
export function isActiveController(): boolean {
  if (isOutput()) return false
  const now = performance.now()
  for (const [id, at] of peers) {
    if (now - at > PEER_TTL_MS) peers.delete(id)
    else if (id < SELF_ID) return false
  }
  return true
}

/** How many other control windows are currently announcing. For the console. */
export function peerControllerCount(): number {
  const now = performance.now()
  let n = 0
  for (const [id, at] of peers) {
    if (now - at > PEER_TTL_MS) peers.delete(id)
    else n++
  }
  return n
}

/**
 * Ask the output window to do something only it can do.
 *
 * Fire and forget: the result comes back as a changed telemetry packet rather
 * than as a reply, because the console is already rendering from telemetry and
 * a second path would give it two answers that could disagree.
 */
export function sendCommand(c: Command): void {
  channel?.postMessage({ t: 'cmd', c } satisfies Msg)
}

/**
 * Should the control window take the output window's `status` right now?
 *
 * No, while a hand-off is in flight — and getting this wrong killed every
 * screen-share start. The sequence: the console sets `starting` and opens the
 * share picker, which the operator can sit in for many seconds. Telemetry keeps
 * arriving from an output window that is still idle, and adopting it wrote
 * `idle` over `starting` within 100 ms. When the picker finally resolved,
 * `startAudio`'s cancellation guard (`status !== 'starting'`) read `idle`,
 * concluded the user had backed out, stopped the tracks and returned silently.
 * No error, no status change, console back to its source buttons, output window
 * never handed anything. The file path never hit it because nothing is awaited
 * between setting `starting` and handing over.
 *
 * `hasSource` ends the exemption early: once the output window actually has a
 * graph, its status is the truth again whatever this window believes.
 *
 * Pure and exported so the rule can be tested without a share picker.
 */
export function shouldAdoptStatus(
  d: Pick<Telemetry, 'status' | 'hasSource'>,
  handoffInFlight: boolean,
): boolean {
  if (!d.status) return false
  if (d.hasSource) return true
  return !handoffInFlight
}

/**
 * Adopt the output window's audio status.
 *
 * The control window has no engine, so its own `status` is a guess it made when
 * it handed the source over. This replaces the guess with the fact — including
 * the case that motivated it: a track ending in the output window used to leave
 * the console showing a live transport indefinitely.
 */
function adoptOutputStatus(d: Telemetry): void {
  const s = useStore.getState()
  const patch: Record<string, unknown> = {}
  if (d.hasSource) endHandoff()
  if (shouldAdoptStatus(d, handoffInFlight()) && d.status !== s.status) patch.status = d.status
  if (d.sourceType !== s.sourceType) patch.sourceType = d.sourceType
  if (d.recording !== s.isRecording) patch.isRecording = d.recording
  if (Object.keys(patch).length > 0) useStore.setState(patch as never)
}

/**
 * Run a command in the output window.
 *
 * Imported lazily: `recorder` pulls in the capture path, and the control window
 * has no use for any of it.
 */
async function runCommand(c: Command): Promise<void> {
  const store = useStore.getState()
  if (c === 'stop') store.stopAudio()
  else if (c === 'cancel-start') store.cancelStartAudio()
  else if (c === 'toggle-record') store.toggleRecording()
  else if (c === 'screenshot') {
    const { saveScreenshot } = await import('./recorder')
    saveScreenshot()
  } else if (c === 'toggle-session-log') {
    // Runs HERE, in the render window, because that is where every singleton
    // it samples actually lives — `perf`, `frameLoad`, `performanceState` and
    // the canvas itself. The console only owns the button.
    const { toggleSessionLog } = await import('./recorder')
    await toggleSessionLog()
  }
}

/* -------------------------------------------------------- diagnostic detail */

/** Detail cadence. Heavier than telemetry, so slower. */
export const DETAIL_INTERVAL_MS = 200

/**
 * Ask the output window to start or stop sending diagnostic detail.
 *
 * Idempotent, and called whenever the set of open panels changes rather than on
 * a timer: the output window holds the flag, so a console that closes without
 * saying so leaves detail running. That is a wasted packet every 200 ms, not a
 * correctness problem, and the next console to open turns it off or on again.
 */
export function requestDetail(on: boolean): void {
  channel?.postMessage({ t: 'want-detail', on } satisfies Msg)
}

/**
 * Record one frame's real duration, for the analytics panel's tail statistics.
 *
 * Raw, deliberately. Shipping `perf.ms` — which is smoothed — would give the
 * console a p95 computed over means, which understates the tail precisely where
 * the panel exists to show it. These are the actual per-frame values, buffered
 * between packets and drained on send.
 */
export function noteFrame(ms: number): void {
  if (!detailWanted || !isOutput()) return
  // Bounded: a console that stops reading must not grow this without limit.
  if (rawFrameMs.length < 240) rawFrameMs.push(ms)
}

/** Output window: publish the diagnostic packet, if anyone is watching. */
export function publishDetail(nowMs = performance.now()): void {
  if (!channel || !isOutput() || !detailWanted) return
  if (nowMs - lastDetailAt < DETAIL_INTERVAL_MS) return
  lastDetailAt = nowMs
  const d: Detail = {
    f: audioEngine.features,
    ps: performanceState,
    fl: frameLoad,
    perf,
    exp: exposure,
    an: analytics,
    es: essentiaBridge.status,
    vo: voiceBridge.status,
    kf: keyPaletteTracker.family,
    ms: rawFrameMs.slice(),
    tx: transitionMetrics.history,
    tier: quality.tier,
  }
  rawFrameMs.length = 0
  channel.postMessage({ t: 'detail', d } satisfies Msg)
}

/**
 * Mirror `src` onto `dst` in place, preserving `dst`'s object identity.
 *
 * In place is not a style preference: the panels captured references to
 * `audioEngine.features`, `essentiaBridge.status` and the rest at module load
 * and hold them for the session, and several of those are `readonly` fields
 * that cannot be reassigned at all. Replacing any of them would leave every
 * reader pointed at an object that had stopped updating — silently.
 *
 * `prune` is off at the caller's level and on below it. Nested objects always
 * arrive whole, and one of them (`sceneParams`) is a sparse block whose keys
 * genuinely come and go; but a top-level payload may legitimately be a subset,
 * and pruning there would delete live state. That distinction has already cost
 * one blank-output bug.
 */
export function mirrorInto(
  dst: Record<string, unknown>,
  src: Record<string, unknown>,
  prune = false,
): void {
  for (const key of Object.keys(src)) {
    const v = src[key]
    const cur = dst[key]
    if (v instanceof Float32Array) {
      if (cur instanceof Float32Array && cur.length === v.length) cur.set(v)
      else dst[key] = new Float32Array(v)
    } else if (Array.isArray(v)) {
      dst[key] = v
    } else if (v && typeof v === 'object') {
      if (!cur || typeof cur !== 'object') dst[key] = {}
      mirrorInto(dst[key] as Record<string, unknown>, v as Record<string, unknown>, true)
    } else {
      dst[key] = v
    }
  }
  if (!prune) return
  for (const key of Object.keys(dst)) {
    if (!(key in src)) delete dst[key]
  }
}

/** Control window: write the packet into this window's own idle singletons. */
function applyDetail(d: Detail): void {
  const rec = (o: unknown) => o as Record<string, unknown>
  mirrorInto(rec(audioEngine.features), rec(d.f))
  mirrorInto(rec(performanceState), rec(d.ps))
  mirrorInto(rec(frameLoad), rec(d.fl))
  mirrorInto(rec(perf), rec(d.perf))
  mirrorInto(rec(exposure), rec(d.exp))
  mirrorInto(rec(analytics), rec(d.an))
  mirrorInto(rec(essentiaBridge.status), rec(d.es))
  mirrorInto(rec(voiceBridge.status), rec(d.vo))
  // `family` is a getter over `committed`, so the backing field is the one that
  // can be written.
  ;(keyPaletteTracker as unknown as Record<string, unknown>).committed = d.kf
  quality.pinTier(d.tier)
  transitionMetrics.history.length = 0
  transitionMetrics.history.push(...(d.tx as never[]))
  // Real per-frame durations, stamped with this window's clock. The VALUES are
  // the output window's; only the timestamps are local, which is all the
  // rolling window needs to age them out.
  const now = performance.now() / 1000
  for (const ms of d.ms) frameTimeWindow.push(now, ms)
}
