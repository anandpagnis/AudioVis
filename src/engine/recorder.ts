import { audioEngine } from '../audio/AudioEngine'

/**
 * Phase 8 export: capture the stage canvas (plus the analyzed audio, when a
 * source is running) into a downloadable video, and one-shot PNG screenshots.
 *
 * Video needs nothing special for the native case — `captureStream()` taps the
 * compositor directly. An `ExportPreset` other than `'native'` re-frames that
 * same stream onto an offscreen canvas first (see {@link startFramePump}) — a
 * 2D crop/scale of a frame already drawn once, not a second render of the
 * scene, so a social-media aspect costs a `drawImage` call, not a GPU pass.
 * Screenshots read the drawing buffer, which is only valid inside the tick that
 * drew it now that `preserveDrawingBuffer` is off; see {@link captureIfRequested}.
 */

/** Social-export shapes, plus the current window's own shape. */
export type ExportPreset = 'native' | '9:16' | '1:1' | '16:9' | '4:5'

/** Pixel dimensions for every non-native preset — the crop/scale target. */
const EXPORT_DIMENSIONS: Record<Exclude<ExportPreset, 'native'>, { width: number; height: number }> = {
  '9:16': { width: 1080, height: 1920 }, // Reels / TikTok / Stories
  '1:1': { width: 1080, height: 1080 }, // IG feed
  '16:9': { width: 1920, height: 1080 }, // YouTube
  '4:5': { width: 1080, height: 1350 }, // IG portrait feed
}

/**
 * MP4 tried first — a file that plays and posts everywhere without a "which
 * app opens .webm" detour — falling back to webm where the browser's
 * `MediaRecorder` can't produce mp4 directly (current Firefox; some Chrome/OS
 * combinations). No transcode step: whichever of these the browser actually
 * supports is what gets written, honestly reflected in the download's own
 * extension by {@link extensionFor}.
 */
const VIDEO_MIME_CANDIDATES = [
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4;codecs=avc1',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
]

function pickMime(): string | undefined {
  return VIDEO_MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m))
}

function extensionFor(mime: string | undefined): 'mp4' | 'webm' {
  return mime?.startsWith('video/mp4') ? 'mp4' : 'webm'
}

/** The in-flight recorder, or null when idle. Module-scoped: only one at a time. */
let recorder: MediaRecorder | null = null
/** Encoded segments accumulated during the current recording. */
let chunks: Blob[] = []
/** The container `recorder` is actually writing, decided once at start. */
let recordingMimeType: 'video/mp4' | 'video/webm' = 'video/webm'
/** Tears down the offscreen crop pump, when the current recording started one. */
let framePumpStop: (() => void) | null = null

/** The R3F canvas. Queried by selector because the renderer is owned by R3F. */
function stageCanvas(): HTMLCanvasElement | null {
  return document.querySelector<HTMLCanvasElement>('.stage canvas')
}

/** Filename-safe timestamp, e.g. `2026-07-29-22-31-04`. */
function stamp(): string {
  return new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  // Revoke on a delay: revoking synchronously after click() can cancel the
  // download before it starts in some browsers, especially large .webm blobs.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** Whether this browser exposes MediaRecorder at all (gates the record button). */
export function isRecordingSupported(): boolean {
  return typeof MediaRecorder !== 'undefined'
}

/**
 * `MediaStreamTrackProcessor` reads a track as `VideoFrame`s directly. It is
 * Chrome/Edge-only and, unlike `VideoFrame` itself, not part of this project's
 * `DOM` lib — it lives in `lib.webworker.d.ts`, and tsconfig.json already notes
 * why that lib can't be mixed into the main program (conflicting globals with
 * `DOM`). Declared minimally, locally, and only ever read behind the runtime
 * feature-detect in {@link startFramePump} — never assumed to exist.
 */
interface TrackProcessor {
  readable: ReadableStream<VideoFrame>
}
interface TrackProcessorCtor {
  new (init: { track: MediaStreamTrack }): TrackProcessor
}

/** Center-crop `source` to `targetW:targetH`, then scale to fill it exactly. */
function drawCropped(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  sourceW: number,
  sourceH: number,
  targetW: number,
  targetH: number,
): void {
  if (sourceW <= 0 || sourceH <= 0) return
  const targetAspect = targetW / targetH
  let sx = 0
  let sy = 0
  let sw = sourceW
  let sh = sourceH
  if (sourceW / sourceH > targetAspect) {
    sw = sourceH * targetAspect
    sx = (sourceW - sw) / 2
  } else {
    sh = sourceW / targetAspect
    sy = (sourceH - sh) / 2
  }
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, targetW, targetH)
}

/**
 * Re-frame the live canvas's own `captureStream()` onto an offscreen canvas
 * sized to the export target — a crop/scale of an already-rasterized frame,
 * not a second pass over the WebGL scene. Prefers `MediaStreamTrackProcessor`
 * (reads `VideoFrame`s with no intermediate element); falls back to a hidden
 * `<video>` pumped by `requestVideoFrameCallback` (or rAF, on the rare browser
 * with neither) where that API isn't available — currently Firefox and Safari.
 *
 * Returns the offscreen canvas's own stream to record from instead of the live
 * one, plus a `stop` that tears the whole pump down (called from
 * {@link stopRecording}).
 */
function startFramePump(liveStream: MediaStream, targetW: number, targetH: number): { stream: MediaStream; stop: () => void } {
  const canvas = document.createElement('canvas')
  canvas.width = targetW
  canvas.height = targetH
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
  // NO ARGUMENT — same idiom as `publishMirror`'s mirror stream: a frame is
  // produced whenever this canvas is drawn to, not on a fixed timer, so the
  // pump below is the only clock and idle time costs nothing extra.
  const outStream = canvas.captureStream()
  const videoTrack = liveStream.getVideoTracks()[0]

  const Processor = (window as unknown as { MediaStreamTrackProcessor?: TrackProcessorCtor })
    .MediaStreamTrackProcessor
  // `liveStream` exists only to feed this pump — stopping its track on
  // teardown, in both branches below, is what lets the browser drop the extra
  // 60fps canvas tap instead of it running on unread until GC gets to it.
  const stopLiveStream = () => liveStream.getTracks().forEach((t) => t.stop())

  if (Processor && videoTrack) {
    const reader = new Processor({ track: videoTrack }).readable.getReader()
    let cancelled = false
    const pump = () => {
      if (cancelled) return
      reader
        .read()
        .then(({ value: frame, done }) => {
          if (done || cancelled) return
          if (frame) {
            drawCropped(ctx, frame, frame.displayWidth, frame.displayHeight, targetW, targetH)
            frame.close()
          }
          pump()
        })
        .catch(() => {})
    }
    pump()
    return {
      stream: outStream,
      stop: () => {
        cancelled = true
        reader.cancel().catch(() => {})
        stopLiveStream()
      },
    }
  }

  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.srcObject = liveStream
  let cancelled = false
  let handle = 0
  const usesRvfc = typeof video.requestVideoFrameCallback === 'function'
  const pump = () => {
    if (cancelled) return
    if (video.videoWidth > 0) drawCropped(ctx, video, video.videoWidth, video.videoHeight, targetW, targetH)
    handle = usesRvfc ? video.requestVideoFrameCallback(pump) : requestAnimationFrame(pump)
  }
  video.play().then(pump).catch(() => {})
  return {
    stream: outStream,
    stop: () => {
      cancelled = true
      if (usesRvfc) video.cancelVideoFrameCallback(handle)
      else cancelAnimationFrame(handle)
      video.srcObject = null
      stopLiveStream()
    },
  }
}

/**
 * Begin recording the stage canvas, mixing in the analyzed audio when a source is
 * running, at the given export shape. Returns false — rather than throwing —
 * when recording can't start (no canvas yet, unsupported browser, already
 * recording, or no usable codec), so the caller can simply leave its toggle off.
 *
 * `preset` defaults to `'native'` — the current window's own shape, captured
 * directly with zero added compositing cost, exactly as before this existed.
 * Any other preset re-frames through {@link startFramePump} first.
 *
 * The finished file downloads from the recorder's own `onstop`, so stopping is
 * fire-and-forget for the caller.
 */
export function startRecording(preset: ExportPreset = 'native'): boolean {
  const canvas = stageCanvas()
  if (!canvas || !isRecordingSupported() || recorder) return false

  const liveStream = canvas.captureStream(60)
  let videoStream = liveStream
  let pump: { stream: MediaStream; stop: () => void } | null = null

  if (preset !== 'native') {
    const { width, height } = EXPORT_DIMENSIONS[preset]
    pump = startFramePump(liveStream, width, height)
    videoStream = pump.stream
  }

  const audio = audioEngine.recordingStream
  if (audio) for (const track of audio.getAudioTracks()) videoStream.addTrack(track)

  const mime = pickMime()

  try {
    recorder = new MediaRecorder(videoStream, {
      mimeType: mime,
      videoBitsPerSecond: 12_000_000,
    })
  } catch {
    pump?.stop()
    return false
  }

  recordingMimeType = mime?.startsWith('video/mp4') ? 'video/mp4' : 'video/webm'
  const extension = extensionFor(mime)
  framePumpStop = pump?.stop ?? null

  chunks = []
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data)
  }
  recorder.onstop = () => {
    if (chunks.length > 0) {
      download(new Blob(chunks, { type: recordingMimeType }), `audiovis-${stamp()}.${extension}`)
    }
    chunks = []
  }
  recorder.start(1000)
  return true
}

/** Stop recording and trigger the download. Safe to call when not recording. */
export function stopRecording() {
  recorder?.stop()
  recorder = null
  framePumpStop?.()
  framePumpStop = null
}

/* ------------------------------------------------------------ session log */

/**
 * Toggle the flight recorder, writing its three artefacts on stop.
 *
 * Returns the new recording state, so a caller can drive a toggle from it
 * without keeping its own copy.
 *
 * The summary goes to the clipboard rather than only to a file because it is
 * the artefact meant to be PASTED — the whole point of the recorder is to stop
 * a person having to read numbers off a panel and retype them. The clipboard
 * write is best-effort: it needs a user gesture in some browsers and this can
 * be reached from a BroadcastChannel command, so a failure is reported rather
 * than thrown, and the same text is in the .json and the .txt regardless.
 */
export async function toggleSessionLog(): Promise<boolean> {
  const { sessionLog } = await import('./sessionLog')
  if (!sessionLog.isRecording()) {
    sessionLog.start()
    return true
  }
  const { summary, json, sheet } = sessionLog.stop()
  const name = `audiovis-session-${stamp()}`
  download(new Blob([summary], { type: 'text/plain' }), `${name}.txt`)
  download(new Blob([json], { type: 'application/json' }), `${name}.json`)
  if (sheet) {
    sheet.toBlob((blob) => {
      if (blob) download(blob, `${name}-frames.png`)
    }, 'image/png')
  }
  try {
    await navigator.clipboard.writeText(summary)
  } catch {
    // Clipboard denied — the .txt is already downloading, which is the fallback.
  }
  return false
}

/**
 * Pending one-shot screenshot request, consumed by {@link captureIfRequested}.
 *
 * The renderer no longer runs with `preserveDrawingBuffer` (it forced a
 * framebuffer retain on every single frame to serve a feature used a handful of
 * times per session), so the drawing buffer is valid only *within* the rAF tick
 * that drew it. A `toBlob` called from a click handler therefore reads an
 * already-cleared buffer and returns a transparent PNG.
 *
 * Instead the click just raises this flag, and `ScreenshotCapture` — mounted
 * inside the Canvas at a priority after the post chain — reads the buffer in
 * the same tick the frame was composited.
 */
let screenshotPending = false

/**
 * Queue a PNG of the next rendered frame. Returns false if the canvas isn't
 * mounted yet; the download itself happens a frame later, from inside the
 * render loop.
 */
export function saveScreenshot(): boolean {
  if (!stageCanvas()) return false
  screenshotPending = true
  return true
}

/**
 * Consume a pending screenshot request. **Must be called from inside the render
 * loop, after the frame has been composited** — see {@link screenshotPending}.
 */
export function captureIfRequested(): void {
  if (!screenshotPending) return
  screenshotPending = false
  const canvas = stageCanvas()
  if (!canvas) return
  canvas.toBlob((blob) => {
    if (blob) download(blob, `audiovis-${stamp()}.png`)
  }, 'image/png')
}
