import { audioEngine } from '../audio/AudioEngine'

/**
 * Phase 8 export: capture the stage canvas (plus the analyzed audio, when a
 * source is running) into a downloadable .webm, and one-shot PNG screenshots.
 * Requires preserveDrawingBuffer on the renderer for screenshots.
 */

let recorder: MediaRecorder | null = null
let chunks: Blob[] = []

function stageCanvas(): HTMLCanvasElement | null {
  return document.querySelector<HTMLCanvasElement>('.stage canvas')
}

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

export function isRecordingSupported(): boolean {
  return typeof MediaRecorder !== 'undefined'
}

export function startRecording(): boolean {
  const canvas = stageCanvas()
  if (!canvas || !isRecordingSupported() || recorder) return false

  const stream = canvas.captureStream(60)
  const audio = audioEngine.recordingStream
  if (audio) for (const track of audio.getAudioTracks()) stream.addTrack(track)

  const mime = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ].find((m) => MediaRecorder.isTypeSupported(m))

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

export function stopRecording() {
  recorder?.stop()
  recorder = null
}

export function saveScreenshot(): boolean {
  const canvas = stageCanvas()
  if (!canvas) return false
  canvas.toBlob((blob) => {
    if (blob) download(blob, `audiovis-${stamp()}.png`)
  }, 'image/png')
  return true
}
