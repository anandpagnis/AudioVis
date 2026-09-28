import { audioEngine } from '../audio/AudioEngine'
import { DEFAULT_COUPLING, tempoRate } from '../audio/tempoSpeed'
import { tempoCouplingOff } from './look/lookFlags'
import { performanceState } from './performanceState'

/** `?tempo=off`, read once at startup (a flag can never change mid-session). */
const TEMPO_OFF = tempoCouplingOff()

/**
 * The motion-rate multiplier the song's tempo asks for RIGHT NOW: `(bpm / 120) ** coupling`, where `coupling` is the
 * blended per-mood `tempoCoupling` of the live look profile (`DEFAULT_COUPLING` while no valid profile exists).
 * Exactly 1 with `?tempo=off`, at 120 BPM, and until the beat-tracking read is trustworthy (`tempoSpeed.ts`).
 *
 * The single choke point for every consumer (global speed in `moodParams.ts`, the shader-scene dial in
 * `createShaderScene.tsx`, the camera in `CameraDirector.tsx`), so they can never disagree. No allocation.
 */
export function currentTempoRate(): number {
  if (TEMPO_OFF) return 1
  const look = performanceState.look
  const coupling = look.valid ? look.tempoCoupling : DEFAULT_COUPLING
  return tempoRate(audioEngine.features.tempoOctaves, coupling)
}
