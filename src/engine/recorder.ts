import { audioEngine } from '../audio/AudioEngine'

/**
 * Phase 8 export: capture the stage canvas (plus the analyzed audio, when a
 * source is running) into a downloadable .webm, and one-shot PNG screenshots.
 *
 * Video needs nothing special — `captureStream()` taps the compositor directly.
 * Screenshots read the drawing buffer, which is only valid inside the tick that
 * drew it now that `preserveDrawingBuffer` is off; see {@link captureIfRequested}.
 */

/** The in-flight recorder, or null when idle. Module-scoped: only one at a time. */
let recorder: MediaRecorder | null = null
/** Encoded segments accumulated during the current recording. */
let chunks: Blob[] = []

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
 * Begin recording the stage canvas, mixing in the analyzed audio when a source is
 * running. Returns false — rather than throwing — when recording can't start
 * (no canvas yet, unsupported browser, already recording, or no usable codec), so
 * the caller can simply leave its toggle off.
 *
 * The finished file downloads from the recorder's own `onstop`, so stopping is
 * fire-and-forget for the caller.
 */
export function startRecording(): boolean {
  const canvas = stageCanvas()
  if (!canvas || !isRecordingSupported() || recorder) return false

  const stream = canvas.captureStream(60)
  const audio = audioEngine.recordingStream
  if (audio) for (const track of audio.getAudioTracks()) stream.addTrack(track)

  const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find(
    (m) => MediaRecorder.isTypeSupported(m),
  )

  try {
    recorder = new MediaRecorder(stream, {
      mimeType: mime,
      videoBitsPerSecond: 12_000_000,
    })
  } catch {
    return false
  }

  chunks = []
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data)
  }
  recorder.onstop = () => {
    if (chunks.length > 0) {
      download(new Blob(chunks, { type: 'video/webm' }), `audiovis-${stamp()}.webm`)
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
