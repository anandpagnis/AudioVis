import { beginHandoff, endHandoff, handSource, isOutput } from './outputLink'

/**
 * The live camera feed behind DJ Cam — one shared `<video>`, acquired in the
 * control window and handed to the output window by direct reference.
 *
 * ## Why this looks like `audioEngine`, not a hook
 *
 * The stream is a live object that must be acquired inside a user gesture (a
 * freshly opened output window has no transient activation) and then read from
 * the render loop of a *different* window. That is the exact shape the mic
 * already solved: the control window prompts, `outputLink.handSource` carries
 * the `MediaStream` across the same-origin heap, and the output window collects
 * it (`claimSource`). So this is a module singleton with the mic's hardening
 * copied verbatim — a {@link DjCamSource.startToken} re-entrancy guard, a
 * {@link withTimeout} backstop and an already-denied pre-check — not a
 * component.
 *
 * ## What it owns, and what it does not
 *
 * Just the stream and the `<video>`. The `THREE.VideoTexture` that samples it is
 * a renderer object with a per-window GL context, so it belongs to `DjCamScene`
 * (created in a `useMemo`, released with `useDispose`). This singleton never
 * creates the texture and never disposes the `<video>`.
 */

/**
 * Camera acquisition must never hang. Chrome leaves `getUserMedia()` pending
 * forever when the camera permission is already denied — it does not reject —
 * exactly as it does for the mic, so this carries the same 30 s backstop as
 * `MIC_TIMEOUT_MS` in `audio/AudioEngine.ts`.
 */
const CAM_TIMEOUT_MS = 30_000

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

/**
 * Is camera access already blocked? Checked up front so a denied permission
 * fails immediately with actionable guidance instead of hanging until the
 * timeout above. Returns false when the Permissions API is unavailable — the
 * timeout still protects us. Mirrors `micPermissionBlocked`.
 */
async function cameraPermissionBlocked(): Promise<boolean> {
  try {
    const status = await navigator.permissions.query({ name: 'camera' as PermissionName })
    return status.state === 'denied'
  } catch {
    return false
  }
}

/** One place to turn a capture failure into something a human can act on —
 *  the camera counterpart of `store.ts`'s `describeStartError`. */
function describeCamError(err: unknown): string {
  if (err instanceof DOMException) {
    if (err.name === 'NotAllowedError') {
      return 'Camera permission denied — allow access and try again.'
    }
    if (err.name === 'NotFoundError' || err.name === 'OverconstrainedError') {
      return 'No camera matched. Pick a different device and try again.'
    }
    if (err.name === 'NotReadableError') {
      return 'The camera is in use by another app. Close it there and try again.'
    }
  }
  return err instanceof Error ? err.message : 'Could not start the camera.'
}

/**
 * The shared offscreen `<video>`. Never attached to the document — the frame
 * path reads it through a `THREE.VideoTexture` and the Console preview binds the
 * same element by ref. `autoplay muted playsInline` so a stream plays the
 * moment it is attached with no gesture of its own.
 *
 * The `node` test environment has no `document`; nothing in a test reaches the
 * getter that calls this, but the guard keeps a stray transitive import from
 * throwing at module load.
 */
function makeVideo(): HTMLVideoElement {
  if (typeof document === 'undefined') return {} as HTMLVideoElement
  const el = document.createElement('video')
  el.autoplay = true
  el.muted = true
  el.playsInline = true
  el.setAttribute('playsinline', '') // iOS Safari wants the attribute form too
  return el
}

/**
 * A tiny snapshot for the Console preview and telemetry. Mutated in place so a
 * reader can hold the reference — the same contract as `audioEngine.features`.
 * There is no subscription: readers that need to react (the Console) already
 * re-render on the telemetry tick.
 */
export interface DjCamStatus {
  /** A `MediaStream` is attached to {@link DjCamSource.video} in THIS window. */
  hasStream: boolean
  /** Label of the live video track, when the browser exposes one. */
  deviceLabel: string | null
  /** Last acquisition / stream error, human-readable. Cleared on the next
   *  `acquire()`; set again on permission denial or a track ending. */
  error: string | null
}

class DjCamSource {
  readonly status: DjCamStatus = { hasStream: false, deviceLabel: null, error: null }

  private _video: HTMLVideoElement | null = null

  /**
   * Invalidation token for in-flight `acquire()` calls — the mic's `startToken`
   * pattern. `getUserMedia` takes no `AbortSignal`, so a pending prompt cannot
   * be cancelled; every acquire captures the token and, on settle, a stale
   * token means "release whatever was granted and bind nothing".
   */
  private startToken = 0

  /** The shared offscreen `<video>`. Created once, lazily, and kept for the
   *  life of the window — `DjCamScene` wraps it in a `VideoTexture` and the
   *  Console preview binds it by ref, so its identity must be stable. */
  get video(): HTMLVideoElement {
    if (!this._video) this._video = makeVideo()
    return this._video
  }

  /**
   * `true` once the `<video>` has decodable data AND its track is still live.
   * The `DjCamDirector` gate reads this to arm a cutaway, and its fail-closed
   * release reads it every frame to bail the instant the feed drops.
   */
  get ready(): boolean {
    const v = this._video
    if (!v) return false
    const stream = v.srcObject as MediaStream | null
    const track = stream?.getVideoTracks()[0]
    return v.readyState >= 2 && !!track && track.readyState === 'live'
  }

  /**
   * Acquire a camera in the CONTROL window, inside a user gesture, and hand the
   * live stream to the output window.
   *
   * Resolves on success. On failure it BOTH sets {@link DjCamStatus.error} and
   * rejects with an `Error` whose message is already fit to show — a caller can
   * `await` in a `try/catch` or read `status.error`, whichever suits it.
   */
  async acquire(deviceId?: string): Promise<void> {
    if (isOutput()) {
      // The output window has no gesture and nothing to hand to; it receives
      // the stream through `adoptStream` instead.
      throw new Error('The camera is connected from the control window.')
    }
    const token = ++this.startToken
    this.status.error = null

    // Fail fast on an already-blocked camera: Chrome hangs `getUserMedia`
    // forever in that state rather than rejecting, which would strand the
    // Console's connect flow.
    if (await cameraPermissionBlocked()) {
      const msg =
        'Camera access is blocked for this site. Click the lock/settings icon in the address bar, allow Camera, then try again.'
      this.status.error = msg
      throw new Error(msg)
    }

    // Holds telemetry off the output window's `status` for the length of the
    // prompt, exactly as the mic hand-off does — see `outputLink.shouldAdoptStatus`.
    beginHandoff()
    let stream: MediaStream
    try {
      stream = await withTimeout(
        navigator.mediaDevices.getUserMedia({
          video: {
            deviceId: deviceId ? { exact: deviceId } : undefined,
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        }),
        CAM_TIMEOUT_MS,
        'The camera permission prompt never returned. Check the address-bar permission for this site and try again.',
      )
    } catch (err) {
      endHandoff()
      // Superseded or stopped while the prompt was open — the failure is no
      // longer anyone's problem.
      if (token !== this.startToken) return
      const msg = describeCamError(err)
      this.status.error = msg
      throw new Error(msg, { cause: err })
    }

    if (token !== this.startToken) {
      // Permission landed after the operator moved on. Release it explicitly —
      // nothing else can, and the OS camera light stays on until something does.
      stream.getTracks().forEach((t) => t.stop())
      endHandoff()
      return
    }

    // Bind it locally first so the Console preview shows the feed immediately,
    // then hand the SAME live object to the output window.
    this.bindStream(stream)
    if (!handSource({ kind: 'camera', stream })) {
      // No output window took it. Keep the local preview — the operator can
      // still frame the shot — but say the cut has nowhere to land.
      this.status.error = 'No output window. Open the output window — it is where the cut happens.'
    }
    endHandoff()
  }

  /**
   * Output window: adopt the stream the control window handed over. Called from
   * the one `claimSource()` consumer (`routes/Visualizer.tsx`). Synchronous —
   * `play()` is fire-and-forget, the same as every other autoplay `<video>` here.
   */
  adoptStream(stream: MediaStream): void {
    this.startToken++ // cancel any acquire somehow still in flight in this window
    this.bindStream(stream)
  }

  /**
   * Stop every track and detach. Safe to call when nothing is connected. The
   * director calls this on fail-closed; the Console calls it on disconnect.
   * Leaves {@link DjCamStatus.error} intact so a "device unplugged" message
   * survives the teardown it triggers.
   */
  stop(): void {
    this.startToken++
    const v = this._video
    const stream = v?.srcObject as MediaStream | null
    stream?.getTracks().forEach((t) => t.stop())
    if (v) v.srcObject = null
    this.status.hasStream = false
    this.status.deviceLabel = null
  }

  /**
   * Every camera device the browser will name. Mirrors `store.refreshDevices`
   * for the mic — labels are blank until a camera permission has been granted
   * once, so a picker built from this is best populated after `acquire()`.
   */
  async listDevices(): Promise<{ id: string; label: string }[]> {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      return devices
        .filter((d) => d.kind === 'videoinput')
        .map((d, i) => ({ id: d.deviceId, label: d.label || `Camera ${i + 1}` }))
    } catch {
      // Device enumeration is best-effort, same as the mic path.
      return []
    }
  }

  /** Attach a stream to the shared `<video>` and wire its teardown. Idempotent
   *  for the same stream, so a double poll or a re-render cannot double-bind. */
  private bindStream(stream: MediaStream): void {
    const v = this.video
    if (v.srcObject === stream) return
    // Reconnecting to a different camera: stop the previous stream's tracks
    // first. Nothing else holds a reference to it, and the OS camera light
    // stays on until every track is stopped.
    const prev = v.srcObject as MediaStream | null
    if (prev) prev.getTracks().forEach((t) => t.stop())
    v.srcObject = stream
    const track = stream.getVideoTracks()[0] ?? null
    this.status.hasStream = true
    this.status.deviceLabel = track?.label || null
    this.status.error = null
    // A device unplugged mid-set fires 'ended' on the track. Mirror the mic:
    // tear down and surface the reason. `DjCamDirector`'s gate fails closed off
    // `ready` regardless; this just makes the cause visible on the Console.
    track?.addEventListener('ended', () => {
      if ((this._video?.srcObject as MediaStream | null) === stream) {
        this.stop()
        this.status.error = 'The camera stream ended (device unplugged or released).'
      }
    })
    // Autoplay is set, but an explicit play() covers an element created before
    // any gesture. Failure is not fatal — the texture just shows nothing until
    // frames arrive.
    if (typeof v.play === 'function') void v.play().catch(() => {})
  }
}

/** The one instance. Imported by `DjCamScene`, `DjCamDirector`, `ui/Console.tsx`
 *  and the output window's `claimSource` consumer in `routes/Visualizer.tsx`. */
export const djCamSource = new DjCamSource()
