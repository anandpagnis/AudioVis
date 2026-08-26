import { audioEngine } from '../audio/AudioEngine'
import type { AudioFeatures } from '../audio/types'
import { performanceState } from './performanceState'
import { useStore } from '../store'

/**
 * The output projector window: a second, chrome-free window showing the same
 * show, synced over `BroadcastChannel`.
 *
 * The laptop window tunes; the projector window stays clean. That closes the
 * OBS / second-screen / streaming gap for the browser tier without a native
 * build and without touching the renderer — the projector runs the ordinary
 * app with its decide band switched off and its inputs arriving on a wire.
 *
 * ## Roles, and why they are asymmetric
 *
 * Exactly one window is the **leader**: any window not opened with `?output`.
 * It owns the audio device, runs every director, and publishes what it decided.
 * Every `?output` window is a **follower**: it mounts no decide-band director,
 * never runs audio analysis, and applies what arrives.
 *
 * This asymmetry is what removes the echo problem outright. A symmetric mesh
 * has to tag every message with its origin so a sender can skip its own echo
 * (which is what lilim does, because there every tab is a peer). Here a
 * follower never publishes and a leader never applies, so a loop cannot form.
 *
 * ## The split of state, which is the whole design
 *
 * Three things have to reach the projector, and they travel differently:
 *
 *   **The look** (store: scene, layers, palette, params) is published on
 *   change, because that is when it changes. It is also the answer to `join` —
 *   see below.
 *
 *   **Audio features** are published every frame. The projector cannot analyse
 *   for itself: a file input, a mic stream and a `getDisplayMedia` capture all
 *   belong to the window that opened them and cannot be handed to another one.
 *   `AudioFeatures` is plain data throughout (two nested objects, three
 *   `Float32Array`s), so it rides the structured clone whole rather than as a
 *   hand-copied field list that would silently drift from the type.
 *
 *   **Director output** — bloom, fog, trails, the racks, camera mode, mood —
 *   is published every frame alongside it. Deliberately a SUBSET: see
 *   {@link WIRE_FIELDS}.
 *
 * ## What is deliberately NOT on the wire
 *
 * `scene`, `activeScene`, `layers` and `transition` are owned by the
 * follower's own `SceneManager`, which stays mounted because it is what
 * actually renders. It sees the same `sceneId` arrive on the look wire and it
 * has the same beat grid off the audio wire, so it commits its crossfade on the
 * same downbeat as the leader by computing it, not by being told.
 *
 * Syncing them instead would mean one window driving another window's mount
 * lifecycle, warm gates and fade clocks across a channel with no ordering
 * guarantee against the frames it is interleaved with. The cost of computing it
 * twice is one comparison per frame; the cost of the alternative is a whole
 * class of split-brain bug.
 *
 * The honest caveat: the two windows can land a switch on different frames if
 * their beat grids disagree, which happens for a few frames after a projector
 * opens mid-track. It converges as soon as the grid does.
 *
 * ## The join handshake, and why it is not optional
 *
 * The look publishes on CHANGE. A projector opened after the scene was picked
 * would therefore sit on the renderer's boot defaults for the rest of the
 * session — lilim's log records exactly this, an output window running one
 * scene while the main window ran another for a whole set.
 *
 * So a follower asks on open, and the leader answers with a full snapshot. Two
 * details are load-bearing:
 *
 *   - The answer is **addressed** to the joiner (`to`). Without that, a third
 *     window arriving would push a snapshot at two windows already in step.
 *   - The ask goes out at **module load**, before React has mounted. lilim
 *     measured 6.6 s between a projector's renderer being ready and its join
 *     reaching the other tab when the ask waited for app init — six seconds of
 *     projector showing the wrong thing. `useStore.setState` is safe this
 *     early, so the answer can and should beat the first render.
 */

/** One channel for the whole app. Same-origin, so no configuration. */
const CHANNEL = 'audiovis-projector'

/**
 * A follower stops trusting the wire this long after the last frame.
 *
 * A leader can go quiet for reasons that are not "closed": the tab was
 * backgrounded and rAF throttled, the machine slept, the track ended. Freezing
 * on the last frame would leave a projector — very possibly the one pointed at
 * an audience — showing a still image with no indication anything is wrong.
 *
 * Instead the follower falls back to `audioEngine.update()`, which with no
 * audio context of its own keeps time and the mood estimator advancing. The
 * picture keeps moving on its idle animation and resumes the moment frames
 * return. Same doctrine as lilim's 2 s remote timeout: a dying leader degrades
 * to idle motion, never to a frozen screen.
 */
export const STALE_MS = 2000

/**
 * Cap on publish rate.
 *
 * The leader publishes from its render loop, so on a 144 Hz laptop it would
 * otherwise push 144 frames/s of features at ~10 KB each — 1.5 MB/s of
 * structured clone — to a projector almost certainly running at 60. The
 * follower only ever reads the newest frame, so everything above its own
 * refresh is copied and discarded.
 */
export const PUBLISH_INTERVAL_MS = 1000 / 60

/** Fields of `performanceState` that ride the wire, and only these. */
export const WIRE_FIELDS = [
  'palette',
  'mood',
  'cameraMode',
  'animationIntensity',
  'particleDensity',
  'visualTension',
  'voiceFocus',
  'bloom',
  'bloomThreshold',
  'glitch',
  'caAngle',
  'vignette',
  'fog',
  'trails',
  'mirror',
  'lens',
  'rackAudio',
  'transitionStyle',
  'sceneParams',
] as const

/**
 * Fields deliberately excluded — the follower's own execute band owns them.
 *
 * Exported so a test can assert that every key of `performanceState` is in
 * exactly one of the two lists. Adding a director-owned field and forgetting to
 * publish it would otherwise be invisible: the projector would simply be a
 * little wrong, in a way only a human looking at two screens could catch.
 */
export const LOCAL_FIELDS = ['scene', 'activeScene', 'layers', 'transition'] as const

/** The look, as the leader publishes it and the follower applies it. */
export interface ProjectorLook {
  sceneId: string
  layerSceneIds: unknown
  paletteId: string
  params: unknown
  layerFx: unknown
  quality: unknown
  sceneParams: unknown
}

type Msg =
  | { t: 'join'; id: string }
  | { t: 'look'; to?: string; look: ProjectorLook }
  | { t: 'frame'; a: AudioFeatures; p: Record<string, unknown> }

/** Identifies this window on the channel, for addressing the join answer. */
const SELF_ID = `av-${Math.random().toString(36).slice(2, 10)}`

let channel: BroadcastChannel | null = null
let lastFrame: { a: AudioFeatures; p: Record<string, unknown> } | null = null
let lastFrameAt = -Infinity
let lastPublishAt = -Infinity
let unsubscribeLook: (() => void) | null = null

/** Is this window the chrome-free output surface? */
export function isProjector(): boolean {
  if (typeof window === 'undefined') return false
  return new URLSearchParams(window.location.search).has('output')
}

/** Open (or re-focus) the projector window. Bound to `O` in the HUD. */
export function openProjectorWindow(): void {
  if (typeof window === 'undefined') return
  const url = `${window.location.pathname}?output`
  // A NAME, not a fresh window each press: pressing O twice should focus the
  // projector, not open a second one that then also follows the wire.
  window.open(url, 'audiovis-output', 'popup=yes,width=1280,height=720')
}

function snapshotLook(): ProjectorLook {
  const s = useStore.getState()
  return {
    sceneId: s.sceneId,
    layerSceneIds: s.layerSceneIds,
    paletteId: s.paletteId,
    params: s.params,
    layerFx: s.layerFx,
    quality: s.quality,
    sceneParams: s.sceneParams,
  }
}

/**
 * Mirror `src` onto `dst` in place, preserving `dst`'s object identity.
 *
 * In place is not a style preference. Scenes, directors and passes capture
 * references to `audioEngine.features`, `features.percussion`,
 * `performanceState.mirror` and so on at mount and hold them for the session.
 * Replacing any of those objects would leave every holder pointed at the
 * previous one — the reader would keep working, silently, on state that had
 * stopped updating.
 *
 * `prune` controls what happens to keys `src` does not mention, and it is NOT a
 * detail. Nested objects always arrive whole, and one of them — `sceneParams` —
 * is a sparse steer block whose keys genuinely come and go (`clearSteer`), so a
 * key the leader has withdrawn has to be removed rather than left behind as a
 * standing instruction. But the TOP level of a `performanceState` payload is
 * deliberately a subset ({@link WIRE_FIELDS}), so pruning there deletes exactly
 * the fields the follower owns: `scene`, `layers`, `transition`. Measured, that
 * threw `cannot read 'effects' of undefined` on every frame and left the
 * projector blank.
 *
 * Hence: the caller's level never prunes, every level below it always does.
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
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
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

function handle(msg: Msg): void {
  if (isProjector()) {
    // Follower. Never answers a join — a projector asked what the picture is
    // would otherwise answer another projector with its own copy of the
    // question, and two followers would converge on each other rather than on
    // the leader.
    if (msg.t === 'frame') {
      lastFrame = { a: msg.a, p: msg.p }
      lastFrameAt = performance.now()
    } else if (msg.t === 'look' && (!msg.to || msg.to === SELF_ID)) {
      applyLook(msg.look)
    }
    return
  }
  // Leader.
  if (msg.t === 'join' && msg.id !== SELF_ID) {
    // Only a window actually running a show answers. Two control windows open
    // at once is genuinely ambiguous, and this at least narrows it to the one
    // holding the audio rather than letting an idle tab on the start card
    // stamp its defaults over a live set.
    if (useStore.getState().status === 'running') {
      channel?.postMessage({ t: 'look', to: msg.id, look: snapshotLook() } satisfies Msg)
    }
  }
}

function applyLook(look: ProjectorLook): void {
  // Straight into the store. The follower runs no AutoPilot and no
  // PerformanceDirector, so nothing downstream will treat this as a manual
  // gesture and back off from automation that is not running here anyway.
  useStore.setState({
    sceneId: look.sceneId,
    layerSceneIds: look.layerSceneIds,
    paletteId: look.paletteId,
    params: look.params,
    layerFx: look.layerFx,
    quality: look.quality,
    sceneParams: look.sceneParams,
  } as never)
}

/**
 * Join the channel. Safe to call more than once; safe before React mounts, and
 * for a follower that is the point (see the header on the join handshake).
 */
export function startProjectorLink(): void {
  if (channel || typeof BroadcastChannel === 'undefined') return
  channel = new BroadcastChannel(CHANNEL)
  channel.onmessage = (e) => handle(e.data as Msg)

  if (isProjector()) {
    channel.postMessage({ t: 'join', id: SELF_ID } satisfies Msg)
    return
  }
  // Leader: republish the look whenever it changes. Cheap and rare — these are
  // human gestures — so no coalescing, and immediacy is worth more than the
  // saved messages when someone is cueing a scene against a live projector.
  let prev = snapshotLook()
  unsubscribeLook = useStore.subscribe(() => {
    const next = snapshotLook()
    let changed = false
    for (const k of Object.keys(next) as (keyof ProjectorLook)[]) {
      if (next[k] !== prev[k]) changed = true
    }
    if (!changed) return
    prev = next
    channel?.postMessage({ t: 'look', look: next } satisfies Msg)
  })
}

/** Leave the channel. Used by tests; the app holds the link for its lifetime. */
export function stopProjectorLink(): void {
  unsubscribeLook?.()
  unsubscribeLook = null
  channel?.close()
  channel = null
  lastFrame = null
  lastFrameAt = -Infinity
  lastPublishAt = -Infinity
}

/**
 * Leader: publish the frame that was just decided.
 *
 * Called from the execute band, after every director has written
 * `performanceState`, so what crosses the wire is the state the leader itself
 * rendered rather than a half-updated one.
 */
export function publishFrame(nowMs = performance.now()): void {
  if (!channel || isProjector()) return
  if (useStore.getState().status !== 'running') return
  if (nowMs - lastPublishAt < PUBLISH_INTERVAL_MS) return
  lastPublishAt = nowMs
  const p: Record<string, unknown> = {}
  for (const k of WIRE_FIELDS) p[k] = (performanceState as unknown as Record<string, unknown>)[k]
  // `audioEngine.features` is posted by reference; structured clone copies it
  // synchronously during the call, so the mutable singleton being overwritten
  // on the next frame cannot reach the other side half-written.
  channel.postMessage({ t: 'frame', a: audioEngine.features, p } satisfies Msg)
}

/**
 * Follower: apply the newest frame from the wire.
 *
 * Returns false when there is nothing fresh to apply, which is the caller's cue
 * to run the ordinary local tick instead — see {@link STALE_MS}.
 */
export function applyIncomingFrame(nowMs = performance.now()): boolean {
  if (!lastFrame || nowMs - lastFrameAt > STALE_MS) return false
  mirrorInto(
    audioEngine.features as unknown as Record<string, unknown>,
    lastFrame.a as unknown as Record<string, unknown>,
  )
  mirrorInto(performanceState as unknown as Record<string, unknown>, lastFrame.p)
  return true
}

/** True while a follower is being driven by a live leader. For the HUD/debug. */
export function isReceiving(nowMs = performance.now()): boolean {
  return lastFrame !== null && nowMs - lastFrameAt <= STALE_MS
}
