/**
 * Self-contained audio analyser for the landing tunnel — deliberately NOT
 * `audioEngine`. That engine is built for analyzing a live performance
 * (BPM/mood/phrase detection); the tunnel only ever needs three smoothed
 * bands, a beat pulse, and a track to react to, so a lighter purpose-built
 * module avoids dragging the full analysis stack into the marketing bundle.
 *
 * Singleton, mutable, updated once per rAF tick — same shape as
 * `audioEngine`/`quality`/`MidiClock` elsewhere in this codebase: the render
 * loop owns it, nothing subscribes through React state.
 */

const PRESET_TRACK_SRC = '/landing/fractures.mp3'
const PRESET_TRACK_NAME = 'Fractures'

class TunnelAudio {
  ctx: AudioContext | null = null
  private el: HTMLAudioElement | null = null
  private srcNode: MediaElementAudioSourceNode | null = null
  private analyser: AnalyserNode | null = null
  private gain: GainNode | null = null
  private freqData: Uint8Array | null = null

  bass = 0
  mid = 0
  treble = 0
  level = 0
  beat = 0
  trackName = ''

  /** True once the analyser is actually receiving signal. */
  started = false
  /** True once the master gain has been ramped up (post fade-in). */
  audible = false
  muted = false
  source: 'none' | 'file' | 'preset' | 'gen' = 'none'

  private peakBass = 0.02
  private peakMid = 0.02
  private peakTreble = 0.02
  private onsetHistory: number[] = []
  private lastOnsetAt = 0
  private generative: { stop: () => void } | null = null

  onTrackChange: ((name: string) => void) | null = null
  onToast: ((msg: string, ms?: number) => void) | null = null

  private boot(): boolean {
    if (this.ctx) return true
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return false
    this.ctx = new AC()
    this.gain = this.ctx.createGain()
    this.gain.gain.value = 0
    this.analyser = this.ctx.createAnalyser()
    this.analyser.fftSize = 2048
    this.analyser.smoothingTimeConstant = 0.72
    this.freqData = new Uint8Array(this.analyser.frequencyBinCount)

    const comp = this.ctx.createDynamicsCompressor()
    comp.threshold.value = -14
    comp.knee.value = 22
    comp.ratio.value = 8
    comp.attack.value = 0.004
    comp.release.value = 0.22

    this.gain.connect(comp)
    comp.connect(this.analyser)
    this.analyser.connect(this.ctx.destination)

    this.el = new Audio()
    this.el.loop = true
    this.el.preload = 'auto'
    return true
  }

  private resume() {
    if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume()
  }

  /** Wires the baked-in track at startup — playing still needs a real click (autoplay policy). */
  loadPresetTrack() {
    if (!this.boot() || !this.el) return
    if (!this.srcNode) {
      this.srcNode = this.ctx!.createMediaElementSource(this.el)
      this.srcNode.connect(this.gain!)
    }
    this.el.onerror = () => {
      this.onToast?.('Could not load the preset track', 4600)
      this.setTrack('Track unavailable — press Play audio')
    }
    this.el.src = PRESET_TRACK_SRC
    this.source = 'preset'
    this.setTrack(PRESET_TRACK_NAME)
    this.onToast?.('Track ready — press Play audio', 3200)
  }

  loadFile(file: File) {
    if (!this.boot() || !this.el) return
    this.resume()
    this.el.onerror = null
    if (this.generative) {
      this.generative.stop()
      this.generative = null
    }
    if (!this.srcNode) {
      this.srcNode = this.ctx!.createMediaElementSource(this.el)
      this.srcNode.connect(this.gain!)
    }
    if (this.el.src.indexOf('blob:') === 0) URL.revokeObjectURL(this.el.src)
    this.el.src = URL.createObjectURL(file)
    this.source = 'file'
    this.setTrack(file.name.replace(/\.[a-z0-9]+$/i, ''))
    this.play(2.0)
  }

  play(fadeSec = 3.0) {
    this.resume()
    if (!this.el) return
    const ok = () => {
      this.started = true
      this.audible = true
      this.fadeTo(this.muted ? 0 : 1, fadeSec)
    }
    const fail = () => {
      this.onToast?.('Browser blocked playback — press play again')
      this.startGenerative()
    }
    const p = this.el.play()
    if (p && typeof p.then === 'function') p.then(ok).catch(fail)
    else ok()
  }

  /** Fallback score so the tunnel is never silent and reactivity is always visible. */
  startGenerative() {
    if (!this.boot() || this.generative || !this.ctx || !this.gain) return
    this.resume()
    const ctx = this.ctx
    const out = this.gain
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const padGain = ctx.createGain()
    padGain.gain.value = 0.075
    const padFilt = ctx.createBiquadFilter()
    padFilt.type = 'lowpass'
    padFilt.frequency.value = 620
    padFilt.Q.value = 3.5
    padFilt.connect(padGain)
    padGain.connect(out)

    const oscs: OscillatorNode[] = []
    ;[82.41, 123.47, 164.81, 246.94].forEach((f, i) => {
      const o = ctx.createOscillator()
      o.type = i % 2 ? 'triangle' : 'sawtooth'
      o.frequency.value = f
      o.detune.value = (i - 1.5) * 7
      const g = ctx.createGain()
      g.gain.value = 0.3 / (i + 1)
      o.connect(g)
      g.connect(padFilt)
      o.start()
      oscs.push(o)
    })

    const lfo = ctx.createOscillator()
    lfo.frequency.value = 0.05
    const lfoGain = ctx.createGain()
    lfoGain.gain.value = 420
    lfo.connect(lfoGain)
    lfoGain.connect(padFilt.frequency)
    lfo.start()
    oscs.push(lfo)

    let step = 0
    let next = ctx.currentTime + 0.08
    const spb = 60 / 84

    const kick = (at: number) => {
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.type = 'sine'
      o.frequency.setValueAtTime(132, at)
      o.frequency.exponentialRampToValueAtTime(38, at + 0.14)
      g.gain.setValueAtTime(0.0001, at)
      g.gain.exponentialRampToValueAtTime(0.52, at + 0.008)
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.42)
      o.connect(g)
      g.connect(out)
      o.start(at)
      o.stop(at + 0.5)
    }
    const bell = (at: number, f: number) => {
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.type = 'sine'
      o.frequency.value = f
      g.gain.setValueAtTime(0.0001, at)
      g.gain.exponentialRampToValueAtTime(0.1, at + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, at + 1.5)
      o.connect(g)
      g.connect(out)
      o.start(at)
      o.stop(at + 1.6)
    }
    const scale = [329.63, 392.0, 493.88, 587.33, 659.25]

    const schedule = () => {
      if (stopped) return
      while (next < ctx.currentTime + 0.25) {
        if (step % 2 === 0) kick(next)
        if (step % 8 === 3 || step % 8 === 6) bell(next, scale[(step * 3) % scale.length])
        next += spb / 2
        step++
      }
      timer = setTimeout(schedule, 60)
    }
    schedule()

    this.generative = {
      stop: () => {
        stopped = true
        if (timer) clearTimeout(timer)
        oscs.forEach((o) => {
          try {
            o.stop()
          } catch {
            /* already stopped */
          }
        })
        try {
          padGain.disconnect()
        } catch {
          /* already disconnected */
        }
      },
    }
    this.source = 'gen'
    this.started = true
    this.audible = true
    this.setTrack('Ambient drone (built in)')
    this.fadeTo(this.muted ? 0 : 1, 3.5)
  }

  /** Starts audio if it hasn't already — real playback still needs the user's own click upstream. */
  begin() {
    if (this.audible) return
    if (this.el?.src) this.play(3.2)
    else this.startGenerative()
  }

  /** Public wrapper for `fadeTo` toward silence — used by the page transition into `/app`. */
  fadeOut(secs: number) {
    this.fadeTo(0, secs)
  }

  private fadeTo(v: number, secs: number) {
    if (!this.gain || !this.ctx) return
    const now = this.ctx.currentTime
    this.gain.gain.cancelScheduledValues(now)
    this.gain.gain.setValueAtTime(this.gain.gain.value, now)
    this.gain.gain.linearRampToValueAtTime(v, now + secs)
  }

  setMuted(m: boolean) {
    this.muted = m
    this.fadeTo(m ? 0 : 1, 0.35)
  }

  private setTrack(name: string) {
    this.trackName = name
    this.onTrackChange?.(name)
  }

  hasPresetSrc() {
    return this.el?.src.includes(PRESET_TRACK_SRC) ?? false
  }

  getFreqData(): Uint8Array | null {
    return this.freqData
  }

  /** Called once per rAF tick from the tunnel's render loop. */
  update(dt: number, now: number) {
    this.beat *= Math.exp(-dt * 6.5)
    if (!this.analyser || !this.freqData || !this.started) {
      this.bass = this.mid = this.treble = this.level = 0
      return
    }
    this.analyser.getByteFrequencyData(this.freqData)
    const f = this.freqData

    const band = (a: number, b: number) => {
      let s = 0
      for (let i = a; i < b; i++) s += f[i]
      return s / ((b - a) * 255)
    }
    const rawBass = band(1, 10) // ~20-215 Hz
    const rawMid = band(10, 90) // ~215Hz-1.9kHz
    const rawTreble = band(90, 380) // ~1.9-8kHz

    // auto-gain: quiet tracks still light the tunnel up
    this.peakBass = Math.max(rawBass, this.peakBass * 0.9988, 0.02)
    this.peakMid = Math.max(rawMid, this.peakMid * 0.9988, 0.02)
    this.peakTreble = Math.max(rawTreble, this.peakTreble * 0.9988, 0.02)

    const nb = Math.min(1, rawBass / this.peakBass)
    const nm = Math.min(1, rawMid / this.peakMid)
    const nt = Math.min(1, rawTreble / this.peakTreble)

    const k = 1 - Math.exp(-dt * 14)
    this.bass += (nb - this.bass) * k
    this.mid += (nm - this.mid) * k
    this.treble += (nt - this.treble) * k
    this.level += (nb * 0.5 + nm * 0.35 + nt * 0.15 - this.level) * (1 - Math.exp(-dt * 5))

    // onset detection on the low band
    this.onsetHistory.push(rawBass)
    if (this.onsetHistory.length > 44) this.onsetHistory.shift()
    const avg = this.onsetHistory.reduce((a, b) => a + b, 0) / this.onsetHistory.length
    if (rawBass > avg * 1.24 && rawBass > 0.08 && now - this.lastOnsetAt > 0.18) {
      this.beat = 1
      this.lastOnsetAt = now
    }
  }

  dispose() {
    if (this.generative) {
      this.generative.stop()
      this.generative = null
    }
    this.el?.pause()
    if (this.el?.src.indexOf('blob:') === 0) URL.revokeObjectURL(this.el.src)
    void this.ctx?.close().catch(() => {})
    this.ctx = null
  }
}

export const tunnelAudio = new TunnelAudio()
