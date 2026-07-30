import { audioEngine } from './AudioEngine'

/**
 * Web MIDI clock adapter (Phase 7). Listens for MIDI timing ticks
 * (0xF8, 24 per quarter note) from any connected input — a DJ controller,
 * drum machine, or a DAW bridge — averages the tick spacing into a tempo,
 * and drives the beat grid through BpmEstimator.setExternalTempo(). Start
 * (0xFA) re-anchors the beat phase, so downbeats line up with the hardware.
 *
 * Only activated by an explicit user toggle (requestMIDIAccess prompts).
 */

export const midiStatus = {
  enabled: false,
  connected: false,
  device: '',
  bpm: 0,
}

let access: MIDIAccess | null = null
let tickTimes: number[] = []
let tickCount = 0

function onMessage(e: MIDIMessageEvent) {
  const status = e.data?.[0]
  if (status === 0xfa || status === 0xfb) {
    // Start/continue: the next tick begins a fresh beat.
    tickCount = 0
    tickTimes = []
    return
  }
  if (status !== 0xf8) return

  // Engine-clock timestamp (features.time is the AudioContext clock the beat
  // grid runs on; ±one frame of jitter is fine because we average 4 beats).
  const now = audioEngine.features.time
  tickTimes.push(now)
  if (tickTimes.length > 97) tickTimes.shift()
  tickCount++

  if (tickCount % 24 === 0 && tickTimes.length >= 25) {
    const last = tickTimes[tickTimes.length - 1]
    const span = Math.min(96, tickTimes.length - 1)
    const period = ((last - tickTimes[tickTimes.length - 1 - span]) / span) * 24
    if (period > 0.15 && period < 2.5) {
      const bpm = 60 / period
      midiStatus.bpm = bpm
      midiStatus.connected = true
      audioEngine.bpmEstimator.setExternalTempo(bpm, last, now)
    }
  }
}

function attachInputs() {
  if (!access) return
  const names: string[] = []
  for (const input of access.inputs.values()) {
    input.onmidimessage = onMessage
    if (input.name) names.push(input.name)
  }
  midiStatus.device = names.join(', ')
  if (names.length === 0) midiStatus.connected = false
}

export async function enableMidiSync(): Promise<boolean> {
  if (!('requestMIDIAccess' in navigator)) return false
  try {
    access = await navigator.requestMIDIAccess({ sysex: false })
  } catch {
    return false
  }
  midiStatus.enabled = true
  attachInputs()
  access.onstatechange = attachInputs
  return true
}

export function disableMidiSync() {
  if (access) {
    for (const input of access.inputs.values()) input.onmidimessage = null
    access.onstatechange = null
  }
  midiStatus.enabled = false
  midiStatus.connected = false
  midiStatus.bpm = 0
  tickTimes = []
  tickCount = 0
}
