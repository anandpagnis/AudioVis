/**
 * MP3 → mono Float32Array PCM, for the calibration harness only. NOT shipped.
 *
 * `mpg123-decoder` is a pure-WASM decoder (devDependency); nothing under `src/`
 * or in `npm run check` imports it. If it ever fails to load, `decodeMp3File`
 * throws and the calling `.calib.ts` is expected to `skip`.
 */
import { readFile } from 'node:fs/promises'
import { MPEGDecoder } from 'mpg123-decoder'

export interface DecodedAudio {
  pcm: Float32Array
  sampleRate: number
  channels: number
}

/** Decode one MP3 file to a mono mixdown. */
export async function decodeMp3File(path: string): Promise<DecodedAudio> {
  const bytes = new Uint8Array(await readFile(path))
  const decoder = new MPEGDecoder()
  await decoder.ready
  try {
    const { channelData, samplesDecoded, sampleRate } = decoder.decode(bytes)
    const channels = channelData.length
    if (samplesDecoded === 0 || channels === 0) {
      throw new Error(`no audio decoded from ${path}`)
    }
    const mono = new Float32Array(samplesDecoded)
    if (channels === 1) {
      mono.set(channelData[0].subarray(0, samplesDecoded))
    } else {
      const l = channelData[0]
      const r = channelData[1]
      for (let i = 0; i < samplesDecoded; i++) mono[i] = (l[i] + r[i]) * 0.5
    }
    return { pcm: mono, sampleRate, channels }
  } finally {
    decoder.free()
  }
}
