import * as THREE from 'three'
import { Pass } from 'postprocessing'
import { FULLSCREEN_VERT } from './glsl'
import { isFeedbackActive, resolveFeedbackKnobs } from './feedbackParams'

/**
 * Image feedback: a ping-ponged history buffer resampled through zoom,
 * rotate, swirl and wobble every frame, then maxed against the live scene.
 * This is the MilkDrop/Butterchurn lineage — the single biggest look upgrade
 * available anywhere in this codebase, and it costs no new scene: every scene
 * that reaches the post chain gets trails, tunnels and recursive smear for
 * free, because the pass sits in the composer, not in any one scene.
 *
 * Ported from lilim's `FeedbackPass` (`lib/fx.js`), simplified from a
 * ping-ponged PAIR of history buffers to a single one. lilim's two buffers
 * exist because its blend draw writes into whichever history buffer it is
 * NOT currently reading — a real constraint when the blend target and the
 * history store are the same kind of object. Here they are not: the blend
 * draw writes into the composer's own `outputBuffer` (owned by
 * `EffectComposer`, ping-ponged across every pass in the chain already), and
 * a second, cheap copy draw then stores that result into this pass's OWN
 * single history target for next frame. Two different buffers are never read
 * and written in the same draw call, so one history target is enough — half
 * the VRAM and half the resize churn of the ported original.
 *
 * ## Two draws, not one
 *
 *  1. **Blend** — reads `inputBuffer` (this frame's scene) and `history`
 *     (last frame's, pre-warped), writes the composited result to
 *     `outputBuffer`. This is what the rest of the post chain (bloom, CA,
 *     vignette) sees.
 *  2. **Copy** — reads `outputBuffer` back, writes it into `history` for next
 *     frame. Cheap: an unlit `MeshBasicMaterial` sampling one texture, no
 *     warp math.
 *
 * ## Sits BEFORE bloom, not after
 *
 * `PostFXChain` inserts this pass as a `<primitive>` ahead of the merged
 * `Bloom`/`ChromaticAberration`/`Vignette` effect list — matching lilim's own
 * ordering (`feedbackPass` before `bloomPass` in `main.js`). Bloom then blooms
 * the accumulated trail, not just the current frame, which is most of why the
 * trails read as glowing rather than as a flat ghost image.
 *
 * A raw `Pass` (this) versus a merged `Effect` (Bloom/CA/Vignette) matters
 * mechanically, not just visually: `@react-three/postprocessing`'s
 * `<EffectComposer>` merges consecutive `Effect` children into one shader
 * program, and ADDING one is the multi-hundred-millisecond recompile
 * `PostFXChain`'s header warns about. A `Pass` is pushed as its own
 * separate chain entry instead — mounting this permanently and modulating it
 * by uniform (persist near zero reads as off) is not a workaround for that
 * cost, it costs nothing extra to begin with.
 *
 * ## Provenance, for later
 *
 * Image feedback is also the mechanism the entire MilkDrop preset format
 * depends on — tens of thousands of `.milk` files, already parsed in-browser
 * by Butterchurn, none of them renderable without a feedback pass. Nothing
 * about *importing* those presets is built here; this is the one piece of
 * engine plumbing an importer would be unable to exist without.
 */

/** History buffer format. Half-float so accumulated trails do not band or
 *  clip the way an 8-bit target would under repeated blending. */
function makeHistoryTarget(width: number, height: number): THREE.WebGLRenderTarget {
  const target = new THREE.WebGLRenderTarget(width, height, {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
  })
  target.texture.name = 'FeedbackPass.history'
  return target
}

const BLEND_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D tDiffuse;
  uniform sampler2D tHistory;
  uniform float uPersist;
  uniform float uZoom;
  uniform float uRotate;
  uniform float uSwirl;
  uniform float uWobble;
  uniform float uTime;
  uniform float uAspect;
  uniform vec3 uTint;
  varying vec2 vUv;

  void main() {
    vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
    float r = length(p);
    // Swirl adds extra rotation that falls off with distance from centre, so
    // the warp reads as a vortex rather than a uniform spin — ported verbatim
    // from lilim, which is where the 0.55 / 0.12 constants come from.
    float ang = uRotate + uSwirl * (0.55 - r) * 0.12;
    float c = cos(ang), s = sin(ang);
    p = mat2(c, -s, s, c) * p / uZoom;
    p += uWobble * 0.004 * vec2(
      sin(uTime * 0.7 + p.y * 9.0),
      cos(uTime * 0.9 + p.x * 8.0));
    vec2 huv = p / vec2(uAspect, 1.0) + 0.5;

    // Fade the sample to black near the history texture's edge so a zoom/warp
    // that samples outside 0..1 pulls in darkness rather than a stretched
    // border artifact (texture clamping would otherwise smear the edge pixel
    // across the whole visible margin).
    float edge = smoothstep(0.0, 0.03, huv.x) * smoothstep(1.0, 0.97, huv.x)
               * smoothstep(0.0, 0.03, huv.y) * smoothstep(1.0, 0.97, huv.y);
    vec3 hist = texture2D(tHistory, clamp(huv, 0.0, 1.0)).rgb;
    hist *= uPersist * uTint * edge;

    vec3 cur = texture2D(tDiffuse, vUv).rgb;
    // max, not add: an additive feedback loop is exactly the washout bug this
    // codebase's own exposure discipline (docs/09_Rendering_Engine.md) warns
    // against — persistent bright regions would compound every frame with no
    // ceiling. max lets a trail persist without the frame's overall exposure
    // ever exceeding what the current frame alone would have produced.
    gl_FragColor = vec4(max(cur, hist), 1.0);
  }
`

export class FeedbackPass extends Pass {
  private readonly blendMaterial: THREE.ShaderMaterial
  private readonly copyMaterial: THREE.MeshBasicMaterial
  private readonly blendScene: THREE.Scene
  private readonly copyScene: THREE.Scene
  private readonly quadGeometry: THREE.PlaneGeometry
  private readonly orthoCamera: THREE.OrthographicCamera
  private history: THREE.WebGLRenderTarget | null = null

  /** Monotonic clock for the wobble term. Guarded against a NaN `deltaTime`
   *  poisoning it permanently — see the render() comment. */
  private time = 0
  /** Current external dial, 0..1. See {@link setTrails}. */
  private trails = 0
  /**
   * History holds a frame from before the pass was last switched off, so the
   * first frame after re-enabling must not blend against it — see
   * {@link setTrails}.
   */
  private historyStale = true

  constructor() {
    super('FeedbackPass')
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
        tHistory: { value: null },
        uPersist: { value: 0 },
        uZoom: { value: 1 },
        uRotate: { value: 0 },
        uSwirl: { value: 0 },
        uWobble: { value: 0 },
        uTime: { value: 0 },
        uAspect: { value: 1 },
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
   * The one dial this pass takes from the outside — see feedbackParams.ts for
   * why it is one number and not five. Call once per frame; cheap regardless
   * of how often it is called (no allocation, no GL work).
   *
   * ## Bypassed entirely at zero
   *
   * At `trails = 0` this pass is a visual no-op: `persist` is 0, so the blend
   * resolves to `max(current, 0)` — the input frame, unchanged. It was still
   * costing two fullscreen draws every frame to produce it, which is a real
   * bill for nothing, and `trails` defaults to 0, so *every* session was paying
   * it. Measured at 1400x900 on a software rasterizer it was ~25% of total
   * frame time; on a GPU it is far less, but it is never zero and it is always
   * pointless.
   *
   * `enabled` is the right lever rather than an early return in `render`:
   * `EffectComposer` skips a disabled pass before the buffer swap
   * (`if (!pass.enabled) continue`), so the chain keeps reading the correct
   * buffer. Returning early from `render` while `needsSwap` is true would swap
   * anyway and hand the next pass a stale buffer. Toggling `enabled` costs no
   * recompile — the merged Bloom/CA/Vignette pass is a separate chain entry and
   * never sees it, which is the point of this being a `Pass` and not an
   * `Effect` (see the header).
   *
   * Set from `PostFXChain`'s frame callback at priority 0; the composer
   * renders at priority 1, so a change lands on the same frame it is made.
   */
  setTrails(trails: number): void {
    this.trails = trails
    const active = isFeedbackActive(trails)
    // Whatever is in `history` predates the switch-off and would otherwise
    // reappear as a frozen ghost on the first frame back. Flagged rather than
    // cleared here because this runs outside the render loop, with no renderer
    // in hand.
    if (active && !this.enabled) this.historyStale = true
    this.enabled = active
  }

  /** Tint the decaying history toward a colour (the palette's mid tone, by
   *  convention) rather than pure white, so trails pick up the show's colour
   *  instead of just brightening toward grey. Copies into the owned uniform
   *  colour rather than retaining the reference. */
  setTint(color: THREE.Color): void {
    this.blendMaterial.uniforms.uTint.value.copy(color)
  }

  render(
    renderer: THREE.WebGLRenderer,
    inputBuffer: THREE.WebGLRenderTarget | null,
    outputBuffer: THREE.WebGLRenderTarget | null,
    deltaTime?: number,
  ): void {
    if (!this.history || !inputBuffer || !outputBuffer) return

    // deltaTime is optional on the base Pass signature, and a backgrounded-tab
    // resume or a context-restore frame can hand back something non-finite. A
    // NaN here would poison `this.time` for the rest of the session — every
    // following frame's wobble term reads NaN forever, which is silent and
    // permanent in a way a single skipped frame of motion is not.
    const dt = Number.isFinite(deltaTime) ? (deltaTime as number) : 0
    this.time += dt

    // First frame back after a bypass: drop the pre-bypass contents so the
    // trail builds from this frame rather than blending against a frozen one.
    if (this.historyStale) {
      this.historyStale = false
      const prevTarget = renderer.getRenderTarget()
      renderer.setRenderTarget(this.history)
      renderer.clear(true, false, false)
      renderer.setRenderTarget(prevTarget)
    }

    const knobs = resolveFeedbackKnobs(this.trails)
    const u = this.blendMaterial.uniforms
    u.tDiffuse.value = inputBuffer.texture
    u.tHistory.value = this.history.texture
    u.uPersist.value = knobs.persist
    // Compounds multiplicatively per real elapsed time rather than per frame,
    // so the zoom rate reads the same at 30fps and 144fps — see
    // feedbackParams.ts for why this is a per-second LOG rate.
    u.uZoom.value = Math.exp(knobs.zoomRatePerSec * dt)
    u.uRotate.value = knobs.rotateRatePerSec * dt
    u.uSwirl.value = knobs.swirl
    u.uWobble.value = knobs.wobble
    u.uTime.value = this.time

    renderer.setRenderTarget(this.renderToScreen ? null : outputBuffer)
    renderer.render(this.blendScene, this.orthoCamera)

    // If this pass ever ends up rendering straight to screen (it should not —
    // see the header on chain ordering), there is nothing to read back into
    // history: skip the copy rather than sampling a null texture.
    if (this.renderToScreen) return

    this.copyMaterial.map = outputBuffer.texture
    renderer.setRenderTarget(this.history)
    renderer.render(this.copyScene, this.orthoCamera)
  }

  setSize(width: number, height: number): void {
    const w = Math.max(1, width)
    const h = Math.max(1, height)
    this.blendMaterial.uniforms.uAspect.value = w / h
    // Reallocates, which discards whatever trail was mid-decay — the same
    // trade every resizable render target in this codebase makes (see
    // bufferScale() in renderScale.ts). A resize is rare enough, and a
    // restarting trail reads as the loop settling rather than as a glitch.
    if (this.history) this.history.dispose()
    this.history = makeHistoryTarget(w, h)
    this.historyStale = true
  }

  dispose(): void {
    this.blendMaterial.dispose()
    this.copyMaterial.dispose()
    this.quadGeometry.dispose()
    this.history?.dispose()
    super.dispose()
  }
}
