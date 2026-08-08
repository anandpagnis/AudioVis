/**
 * Message contract for the voice/mood classifier worker.
 *
 * Deliberately separate from the rhythm worker's protocol (`protocol.ts`) —
 * the two run in different workers so a slow model inference can never stall
 * beat-grid updates, and neither throttle can inflate the other's.
 */

export interface VoiceRequest {
  id: number
  /** Mono PCM at the capture rate; the worker resamples to MusiCNN's 16 kHz. */
  pcm: Float32Array
  sampleRate: number
}

/** Mood heads, all sharing the MusiCNN embedding. 0..1, positive class. */
export interface MoodScores {
  happy: number
  aggressive: number
  party: number
  relaxed: number
}

export interface VoiceResult {
  id: number
  type: 'voice'
  /**
   * Share of ~3 s patches in this window whose p(voice) cleared the decision
   * threshold. NOT a mean — see VOICE_THRESHOLD's comment in the worker.
   */
  voiceFraction: number
  /** Per-patch p(voice) for this window, so the bridge can keep a longer
   * rolling window than one request covers. */
  patchProbs: number[]
  /** Mean over the window's patches — moods are sustained character, unlike
   * vocals which come and go. */
  moods: MoodScores
  /** Wall-clock ms for mel extraction and for inference, separately: mel is
   * the expensive half and the one worth optimising. */
  melMs: number
  inferMs: number
}

export interface VoiceError {
  id: number
  type: 'error'
  message: string
  /** True when the models simply aren't present (not fetched yet). The bridge
   * stops retrying on this rather than hammering a 404 every section. */
  missing: boolean
}

export type VoiceResponse = VoiceResult | VoiceError
