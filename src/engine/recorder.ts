import { audioEngine } from '../audio/AudioEngine'

/**
 * Phase 8 export: capture the stage canvas (plus the analyzed audio, when a
 * source is running) into a downloadable .webm, and one-shot PNG screenshots.
 * Requires preserveDrawingBuffer on the renderer for screenshots.
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

/**
 * Download a one-shot PNG of the current frame. Returns false if the canvas isn't
 * mounted yet. Depends on `preserveDrawingBuffer: true` (set in Stage.tsx) —
 * without it the buffer is already cleared by the time toBlob reads it.
 */
export function saveScreenshot(): boolean {
  const canvas = stageCanvas()
  if (!canvas) return false
  canvas.toBlob((blob) => {
    if (blob) download(blob, `audiovis-${stamp()}.png`)
  }, 'image/png')
  return true
}
