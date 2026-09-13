import * as THREE from 'three'
import { Pass } from 'postprocessing'
import { FULLSCREEN_VERT } from './glsl'
import { ECHO_TAP_COUNT, isEchoActive, resolveEchoKnobs } from './echoParams'

/**
 * Discrete multi-tap echo/delay: {@link ECHO_TAP_COUNT} FIXED snapshots of
 * the frame, taken at a beat-locked spacing (see
 * `echoParams.ts#resolveEchoTapSpacingSec`), held rigid and composited as
 * separate ghost copies at falling opacity — Resolume's stock "RGB
 * Delay"/echo family, or a strobe-multiplied photograph, not the MilkDrop
 * continuous-feedback family `FeedbackPass` already covers. The two read as
 * genuinely different effects: trails is one buffer smeared through
 * zoom/rotate/swirl every frame and never has a "moment," while echo has
 * several literal past moments, each sharp and separately identifiable. Sits
 * immediately after `FeedbackPass` in the chain (see `PostFXChain.tsx`) for
 * the same reason that pass sits before bloom: both are history effects, and
 * both want bloom to bloom the accumulated result rather than only the live
 * frame.
 *
 * ## Taps store the DRY input, not the blended output
 *
 * `FeedbackPass`'s copy step reads `outputBuffer` — its OWN blend result —
 * back into `history`, which is correct there because a continuously
 * decaying trail is supposed to compound: each frame's history already
 * contains a faded trace of everything before it. A discrete echo must NOT
 * do that: if each tap recorded the post-blend frame (this pass's own
 * ghosts already composited in), every tap would progressively accumulate
 * every earlier tap inside it, and several intended-to-be-crisp snapshots
 * would decohere into the same kind of soft accumulating wash `FeedbackPass`
 * already provides — duplicating that effect under a different name instead
 * of offering the sharp, separately-legible repeats this pass exists for. So
 * the copy step here reads `inputBuffer` — the frame arriving into this pass,
 * before its own blend — which is what an actual multi-tap delay line does:
 * independent reads of the same dry signal at several different delays, no
 * feedback path between them.
 *
 * ## Rotating references, not rotating buffers
 *
 * A ping-ponged history needs its blend target and its storage target to be
 * different objects (see `FeedbackPass`'s header on why one target is enough
 * there); several fixed targets have the identical constraint that many
 * times over. Solved by keeping `taps` as a plain JS array in
 * `[newest, ..., oldest]` order and rotating the ARRAY, not the GPU objects,
 * on the frame a new tap is due: `taps.unshift(taps.pop())` costs nothing —
 * no GL call, no allocation — and afterward the now-stale "oldest" reference
 * sits at index 0, ready to be overwritten with this frame's copy. `taps[0]`
 * is always the most recently recorded snapshot, `taps[ECHO_TAP_COUNT - 1]`
 * the most distant one still held.
 *
 * ## `enabled` tracks a SLOW envelope of `echo`, not the raw value (F232)
 *
 * `echo` itself is now a fast, beat-pulse-shaped strength (see
 * `opticalDirector.ts#echoTarget`'s F232 rewrite) — it spikes at every beat
 * and decays toward zero before the next one, by design. If `setEcho()` set
 * `this.enabled` straight off that raw value, the pass would flip off between
 * every pair of beats and back on at the next one, and `tapsStale` (which
 * only exists to blank a genuinely long-idle set of taps) would fire on that
 * same cadence — clearing every tap every single beat, so none would ever
 * survive long enough to become an "older" ghost. The echo would never
 * accumulate past whatever the current beat alone produced. `recentEcho`
 * fixes this: a small internal envelope of `echo` that rises fast (one strong
 * beat is enough to prove the rack is genuinely in play this passage) and
 * decays slow (several consecutive quiet beats before it actually counts as
 * off), computed in `setEcho()` itself using the real frame delta it is now
 * passed for exactly this reason. `enabled`/`tapsStale` gate off THIS
 * envelope; the raw per-frame `echo` value still drives the blend weight
 * directly in `render()`, which is what gives each individual beat its own
 * sharp rise and fall.
 *
 * ## Five taps, not three (F234)
 *
 * Explicit request: "more ghost images... last a bit longer." Both halves
 * come from the same change, `ECHO_TAP_COUNT` 3 -> 5 in `echoParams.ts`
 * (alongside a `DECAY` retune — see that constant's own doc for why the two
 * had to move together): more taps is directly more ghosts, AND the total
 * span the echo covers is `ECHO_TAP_COUNT * tapSpacingSec`, so five taps at
 * the same beat-locked spacing already covers 5/3 of the time three did,
 * with no separate "duration" knob needed. `ECHO_TAP_COUNT` is a
 * compile-time constant, not a runtime dial — see that constant's own doc in
 * echoParams.ts for why (no dynamic sampler-array indexing anywhere in this
 * codebase) and what changing it again requires: every `tTapN`/`wN` uniform
 * and assignment below is manually unrolled to match, the same explicit,
 * hand-written-shader convention every other pass in this engine uses
 * (`LensPass.ts`'s seven materials are not programmatically generated
 * either) rather than building the GLSL source with a loop.
 */

/** Tap buffer format. Half-float for the same reason `FeedbackPass`'s history
 *  target is: an 8-bit target would band or clip under repeated sampling at
 *  the max-composited brightness these taps get read at. */
function makeTapTarget(width: number, height: number, index: number): THREE.WebGLRenderTarget {
  const target = new THREE.WebGLRenderTarget(width, height, {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
  })
  target.texture.name = `EchoPass.tap${index}`
  return target
}

const BLEND_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D tDiffuse;
  uniform sampler2D tTap0;
  uniform sampler2D tTap1;
  uniform sampler2D tTap2;
  uniform sampler2D tTap3;
  uniform sampler2D tTap4;
  uniform float uDecay;
  uniform float uEcho;
  uniform vec3 uTint;
  varying vec2 vUv;

  void main() {
    vec3 cur = texture2D(tDiffuse, vUv).rgb;
    vec3 t0 = texture2D(tTap0, vUv).rgb * uTint;
    vec3 t1 = texture2D(tTap1, vUv).rgb * uTint;
    vec3 t2 = texture2D(tTap2, vUv).rgb * uTint;
    vec3 t3 = texture2D(tTap3, vUv).rgb * uTint;
    vec3 t4 = texture2D(tTap4, vUv).rgb * uTint;
    // uEcho multiplies every tap's weight (F232): echo is now the current
    // beat's pulse strength, sharply peaked at the beat and decayed by the
    // next one, so the ghosts must rise and fall WITH it rather than sitting
    // at a fixed decay-only weight the instant the pass is enabled. Without
    // this the taps would appear at full uDecay-only strength for the entire
    // time enabled stays true (a whole passage, via recentEcho's hysteresis
    // — see the class header), instead of flashing in on each beat the way
    // the rest of the redesign intends.
    float w0 = uEcho * uDecay;
    float w1 = w0 * uDecay;
    float w2 = w1 * uDecay;
    float w3 = w2 * uDecay;
    float w4 = w3 * uDecay;

    // max, never additive — identical reasoning to FeedbackPass's BLEND_FRAG:
    // this codebase's exposure discipline (docs/09_Rendering_Engine.md)
    // targets <=15% of frame lit, mean luma <20, 0% blown to white, and
    // summing several extra ghost copies on top of the live frame every
    // frame is exactly the washout an additive history loop produces. max
    // lets every ghost read as present without the composited frame ever
    // exceeding what its single brightest contributor already was.
    vec3 blended = max(cur, max(max(t0 * w0, t1 * w1), max(max(t2 * w2, t3 * w3), t4 * w4)));
    gl_FragColor = vec4(blended, 1.0);
  }
`

/** `recentEcho` rise rate, in "fraction of the remaining gap closed per
 *  second" — see `approach()` in `performanceState.ts` for the identical
 *  shape used everywhere else in this engine. Fast: a single strong beat
 *  should be enough to prove the rack is in play, well inside one beat at
 *  any working tempo. */
const RECENT_ECHO_RISE_PER_SEC = 10
/** `recentEcho` decay rate — much slower than the rise, so a brief gap
 *  between beats (or one quiet beat in an otherwise busy passage) does not
 *  read as "the rack turned off." Roughly a 1.5s time constant. */
const RECENT_ECHO_FALL_PER_SEC = 0.7

export class EchoPass extends Pass {
  private readonly blendMaterial: THREE.ShaderMaterial
  private readonly copyMaterial: THREE.MeshBasicMaterial
  private readonly blendScene: THREE.Scene
  private readonly copyScene: THREE.Scene
  private readonly quadGeometry: THREE.PlaneGeometry
  private readonly orthoCamera: THREE.OrthographicCamera
  /** `[newest, ..., oldest]`, length {@link ECHO_TAP_COUNT} — see the header
   *  on why this rotates instead of the underlying GPU targets. Empty until
   *  the first `setSize`. */
  private taps: THREE.WebGLRenderTarget[] = []

  /** Seconds accumulated since the last tap was recorded. Subtracted, not
   *  zeroed, when a tap fires — see the render() comment. */
  private elapsed = 0
  /** Current external strength dial, 0..1 — the raw per-frame beat pulse.
   *  See {@link setEcho} and the class header's `recentEcho` section. */
  private echo = 0
  /** Slow envelope of {@link echo}; gates `enabled`/`tapsStale`. See the
   *  class header. */
  private recentEcho = 0
  /** Current tap spacing, seconds — beat-locked, resolved by the caller
   *  (`PerformanceStateBridge.tsx`, off `resolveEchoTapSpacingSec`) since this
   *  pass reads no audio itself. See {@link setEcho}. */
  private tapSpacingSec = 0.25
  /**
   * Taps hold frames from before the pass was last switched off, and must not
   * reappear as a frozen ghost the moment it is switched back on — the exact
   * problem, and the exact fix, as `FeedbackPass.historyStale`.
   */
  private tapsStale = true

  constructor() {
    super('EchoPass')
    this.needsSwap = true

    this.quadGeometry = new THREE.PlaneGeometry(2, 2)
    this.orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)

    this.blendMaterial = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: BLEND_FRAG,
      depthWrite: false,
      depthTest: false,
      uniforms: {
        tDiffuse: { value: null },
        tTap0: { value: null },
        tTap1: { value: null },
        tTap2: { value: null },
        tTap3: { value: null },
        tTap4: { value: null },
        uDecay: { value: 0 },
        uEcho: { value: 0 },
        uTint: { value: new THREE.Color(1, 1, 1) },
      },
    })
    this.blendScene = new THREE.Scene()
    this.blendScene.add(new THREE.Mesh(this.quadGeometry, this.blendMaterial))

    this.copyMaterial = new THREE.MeshBasicMaterial({ depthWrite: false, depthTest: false })
    this.copyScene = new THREE.Scene()
    this.copyScene.add(new THREE.Mesh(this.quadGeometry, this.copyMaterial))
  }

  /**
   * The dials this pass takes from the outside. `echo` is the current beat's
   * pulse strength (0..1, sharply peaked and decaying — see the class
   * header), `tapSpacingSec` the current beat-locked tap interval, and `dt`
   * the frame delta — needed HERE, not just in `render()`, because
   * `recentEcho`'s hysteresis has to update even on frames this pass is about
   * to newly enable or has already disabled (`render()` is skipped by
   * `EffectComposer` whenever `enabled` is false, so it cannot be the place
   * that ever decides to turn back on).
   *
   * Same bypass contract as `FeedbackPass.setTrails()` otherwise: `enabled`
   * is the lever `EffectComposer` checks before the buffer swap, so while
   * `recentEcho` sits at or below the off threshold this pass costs nothing
   * beyond the branch here.
   *
   * Set from `PostFXChain`'s frame callback at priority 0; the composer
   * renders at priority 1, so a change lands on the same frame it is made —
   * identical scheduling contract to every other pass in this chain.
   */
  setEcho(echo: number, tapSpacingSec: number, dt: number): void {
    this.echo = Number.isFinite(echo) ? echo : 0
    this.tapSpacingSec = Number.isFinite(tapSpacingSec) ? tapSpacingSec : this.tapSpacingSec
    const step = Number.isFinite(dt) ? dt : 0

    const rising = this.echo > this.recentEcho
    const rate = rising ? RECENT_ECHO_RISE_PER_SEC : RECENT_ECHO_FALL_PER_SEC
    // Same exponential-approach shape as `approach()` in performanceState.ts,
    // reimplemented locally rather than imported: this pass otherwise has no
    // dependency on that module, and the shape is three lines.
    this.recentEcho += (this.echo - this.recentEcho) * Math.min(1, rate * step)

    const active = isEchoActive(this.recentEcho)
    if (active && !this.enabled) this.tapsStale = true
    this.enabled = active
  }

  /** Tint the taps toward a colour (the palette's mid tone, by convention),
   *  same reasoning and contract as `FeedbackPass.setTint()`: copies into the
   *  owned uniform colour rather than retaining the reference, so ghosts pick
   *  up the show's colour instead of drifting toward white/grey. */
  setTint(color: THREE.Color): void {
    this.blendMaterial.uniforms.uTint.value.copy(color)
  }

  render(
    renderer: THREE.WebGLRenderer,
    inputBuffer: THREE.WebGLRenderTarget | null,
    outputBuffer: THREE.WebGLRenderTarget | null,
    deltaTime?: number,
  ): void {
    if (this.taps.length < ECHO_TAP_COUNT || !inputBuffer || !outputBuffer) return

    // See FeedbackPass's identical guard: a non-finite deltaTime (a
    // backgrounded-tab resume, a context-restore frame) must not poison the
    // accumulator for the rest of the session.
    const dt = Number.isFinite(deltaTime) ? (deltaTime as number) : 0

    if (this.tapsStale) {
      this.tapsStale = false
      this.elapsed = 0
      const prevTarget = renderer.getRenderTarget()
      for (const tap of this.taps) {
        renderer.setRenderTarget(tap)
        renderer.clear(true, false, false)
      }
      renderer.setRenderTarget(prevTarget)
    }

    this.elapsed += dt
    if (this.elapsed >= this.tapSpacingSec) {
      // Subtracted, not zeroed: at a variable frame rate `elapsed` routinely
      // overshoots the interval by a fractional frame, and zeroing it would
      // throw that overshoot away on every single tick, compounding into a
      // cadence that drifts progressively slower than `tapSpacingSec` actually
      // asks for. Subtracting keeps the running total exact — the same
      // real-elapsed-time accounting `FeedbackPass`/`quality.ts` already rely
      // on elsewhere in this engine, just against a fixed interval instead of
      // a per-second rate.
      this.elapsed -= this.tapSpacingSec
      this.taps.unshift(this.taps.pop()!)
      this.copyMaterial.map = inputBuffer.texture
      renderer.setRenderTarget(this.taps[0])
      renderer.render(this.copyScene, this.orthoCamera)
    }

    const knobs = resolveEchoKnobs()
    const u = this.blendMaterial.uniforms
    u.tDiffuse.value = inputBuffer.texture
    u.tTap0.value = this.taps[0].texture
    u.tTap1.value = this.taps[1].texture
    u.tTap2.value = this.taps[2].texture
    u.tTap3.value = this.taps[3].texture
    u.tTap4.value = this.taps[4].texture
    u.uDecay.value = knobs.decay
    u.uEcho.value = this.echo

    renderer.setRenderTarget(this.renderToScreen ? null : outputBuffer)
    renderer.render(this.blendScene, this.orthoCamera)
  }

  setSize(width: number, height: number): void {
    const w = Math.max(1, width)
    const h = Math.max(1, height)
    // Reallocates, which discards whatever taps were held — the same trade
    // FeedbackPass.setSize makes for its history target. A resize is rare
    // enough, and the ghosts restarting from empty reads as the loop
    // settling in rather than as a glitch.
    for (const tap of this.taps) tap.dispose()
    this.taps = Array.from({ length: ECHO_TAP_COUNT }, (_, i) => makeTapTarget(w, h, i))
    this.tapsStale = true
  }

  dispose(): void {
    this.blendMaterial.dispose()
    this.copyMaterial.dispose()
    this.quadGeometry.dispose()
    for (const tap of this.taps) tap.dispose()
    super.dispose()
  }
}
