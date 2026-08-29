import * as THREE from 'three'
import { Pass } from 'postprocessing'
import { FULLSCREEN_VERT } from './glsl'
import { isMirrorActive, type MirrorRackState } from './opticalRack'

/**
 * The mirror rack: bilateral / quad / n-fold kaleidoscopic symmetry, plus
 * mirror-repeat tiling, a radial twist, and shear slicing — all as one
 * UV remap on the composited frame.
 *
 * Ported from lilim's `MirrorShader` (`lib/fx.js`), unchanged in its maths.
 * The four transforms compose in a fixed order and that order is the design:
 * slice shears first (so the slabs themselves get folded), then tiling
 * (so every cell holds the already-sheared frame), then twist, then symmetry
 * last — which means the kaleidoscope folds the *result* of everything else
 * rather than being decorated by it.
 *
 * ## Where it sits, and why
 *
 * Before `FeedbackPass`, matching lilim (`mirror → feedback → bloom → lens`).
 * That ordering is load-bearing rather than incidental: feedback samples the
 * previous frame, so putting symmetry ahead of it means the trail accumulates
 * *through* the fold and the pattern compounds into itself. Behind feedback it
 * would merely be a symmetric copy of a trail that was built asymmetrically.
 *
 * ## Never mounted, never unmounted
 *
 * A raw `Pass`, constructed once and left in the chain for the session. See
 * opticalRack.ts for why the effect list's shape is fixed and `enabled` is the
 * only branch — the short version is that changing the list rebuilds the
 * composer's merged shader, which is a multi-hundred-millisecond stall.
 */

const MIRROR_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D tDiffuse;
  uniform float uSegments;
  uniform float uAspect;
  uniform float uAngle;
  uniform float uTiles;
  uniform float uTwist;
  uniform float uSlice;
  varying vec2 vUv;

  float hash1(float n) { return fract(sin(n * 127.1) * 43758.5453); }

  void main() {
    vec2 uv = vUv;

    // slice: alternating shear slabs — architectural, not glitch. Deterministic
    // per band, because the lens rack owns chaos and two sources of randomness
    // in one chain read as noise rather than as two effects.
    if (uSlice > 0.001) {
      float band = floor(uv.y * 12.0);
      float dir = mod(band, 2.0) * 2.0 - 1.0;
      uv.x += uSlice * dir * (0.15 + 0.25 * hash1(band));
    }

    // tiles: mirror-repeat wallpaper — the translational sibling of symmetry.
    // Every cell holds the whole frame, and the seams kaleidoscope rather than
    // hard-cutting, because alternate cells are flipped.
    if (uTiles >= 1.5) {
      vec2 t = uv * uTiles;
      vec2 cell = floor(t);
      vec2 f = t - cell;
      if (mod(cell.x, 2.0) > 0.5) f.x = 1.0 - f.x;
      if (mod(cell.y, 2.0) > 0.5) f.y = 1.0 - f.y;
      uv = f;
    }

    // twist: vortex — rotation strongest at the centre, like stirred paint.
    if (abs(uTwist) > 0.001) {
      vec2 p = (uv - 0.5) * vec2(uAspect, 1.0);
      float r = length(p);
      float a = atan(p.y, p.x) + uTwist * exp(-r * 1.6);
      p = vec2(cos(a), sin(a)) * r;
      uv = p / vec2(uAspect, 1.0) + 0.5;
    }

    if (uSegments >= 0.5 && uSegments < 1.5) {
      uv.x = uv.x < 0.5 ? uv.x : 1.0 - uv.x;
    } else if (uSegments >= 1.5 && uSegments < 2.5) {
      uv.x = uv.x < 0.5 ? uv.x : 1.0 - uv.x;
      uv.y = uv.y < 0.5 ? uv.y : 1.0 - uv.y;
    } else if (uSegments >= 2.5) {
      vec2 p = (uv - 0.5) * vec2(uAspect, 1.0);
      float r = length(p);
      float a = atan(p.y, p.x) + uAngle;
      float seg = 6.2831853 / uSegments;
      a = mod(a, seg);
      a = abs(a - seg * 0.5);
      p = vec2(cos(a), sin(a)) * r;
      uv = p / vec2(uAspect, 1.0) + 0.5;
    }

    // Mirror-wrap anything the transforms pushed out of frame, so edges fold
    // back instead of streaking a clamped border pixel across the margin.
    //
    // Identity on [0,1], and the +0.5 phase is load-bearing: without it this
    // maps in-range uv to 1-uv and silently rotates every frame 180 degrees.
    // lilim shipped that bug (its comment records the upside-down analyser);
    // the constant is copied deliberately, not incidentally.
    uv = abs(fract(uv * 0.5 + 0.5) * 2.0 - 1.0);
    gl_FragColor = texture2D(tDiffuse, uv);
  }
`

export class MirrorPass extends Pass {
  private readonly material: THREE.ShaderMaterial
  private readonly fsScene: THREE.Scene
  private readonly quadGeometry: THREE.PlaneGeometry
  private readonly orthoCamera: THREE.OrthographicCamera

  /** Accumulated kaleidoscope rotation. Advanced by {@link advance}. */
  private angle = 0

  constructor() {
    super('MirrorPass')
    this.needsSwap = true
    this.quadGeometry = new THREE.PlaneGeometry(2, 2)
    this.orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    this.material = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: MIRROR_FRAG,
      depthWrite: false,
      depthTest: false,
      uniforms: {
        tDiffuse: { value: null },
        uSegments: { value: 0 },
        uAspect: { value: 1 },
        uAngle: { value: 0 },
        uTiles: { value: 0 },
        uTwist: { value: 0 },
        uSlice: { value: 0 },
      },
    })
    this.fsScene = new THREE.Scene()
    this.fsScene.add(new THREE.Mesh(this.quadGeometry, this.material))
  }

  /**
   * Push this frame's rack settings, and advance the spin.
   *
   * `dt` and `mids` drive the rotation the same way lilim does — spin scales
   * with mid content, so the kaleidoscope turns faster through busy material
   * and settles in a breakdown. Called once per frame from `PostFXChain`;
   * allocation-free.
   *
   * Also sets {@link Pass.enabled}, which is the whole branch: an inert rack is
   * a pass the composer skips before its buffer swap, not a fullscreen draw
   * proving it had nothing to do. See opticalRack.ts.
   */
  advance(m: MirrorRackState, dt: number, mids: number): void {
    const active = isMirrorActive(m)
    this.enabled = active
    if (!active) return
    const step = isFinite(dt) ? dt : 0
    this.angle += m.spin * step * 0.12 * (0.5 + mids)
    const u = this.material.uniforms
    u.uSegments.value = m.segments
    u.uAngle.value = this.angle
    u.uTiles.value = m.tiles
    u.uTwist.value = m.twist
    u.uSlice.value = m.slice
  }

  render(
    renderer: THREE.WebGLRenderer,
    inputBuffer: THREE.WebGLRenderTarget | null,
    outputBuffer: THREE.WebGLRenderTarget | null,
  ): void {
    if (!inputBuffer) return
    this.material.uniforms.tDiffuse.value = inputBuffer.texture
    renderer.setRenderTarget(this.renderToScreen ? null : outputBuffer)
    renderer.render(this.fsScene, this.orthoCamera)
  }

  setSize(width: number, height: number): void {
    this.material.uniforms.uAspect.value = Math.max(1, width) / Math.max(1, height)
  }

  dispose(): void {
    this.material.dispose()
    this.quadGeometry.dispose()
    super.dispose()
  }
}
