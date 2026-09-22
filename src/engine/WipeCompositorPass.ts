import * as THREE from 'three'
import { Pass } from 'postprocessing'
import { FULLSCREEN_VERT } from './glsl'
import { WIPE_STYLE_INDEX, type WipeStyle } from './transitionWipe'

/**
 * Composites the two `TransitionCapture` textures back into the frame through
 * one of the three wipe masks (`inkDissolve` / `irisWipe` / `datamosh`).
 *
 * Modelled structurally on `MirrorPass.ts`: a raw `Pass` (not a merged
 * `Effect` — see `FeedbackPass.ts`'s header for why that distinction is what
 * makes an always-mounted-but-usually-idle pass free), one fullscreen quad, a
 * `ShaderMaterial`, `needsSwap = true`, and `enabled` as the ONLY branch —
 * `PostFXChain.tsx` sets it directly from `shouldCapture(tx)`
 * (`transitionWipe.ts`), matching how `MirrorPass`/`LensPass` gate themselves
 * from their own `advance()` (`this.enabled = active`). When `enabled` is
 * `false` the composer skips this pass before its buffer swap, at zero cost —
 * same contract as every other rack pass in this chain.
 *
 * ## Mounted FIRST in the chain, before `<primitive object={mirrorPass} />`
 *
 * `tDiffuse` here is the COMPOSER's raw input for this frame — the merged
 * frame the auto-inserted `RenderPass` just produced. While a wipe is active,
 * both primaries sit on `WIPE_LAYER_OUT`/`WIPE_LAYER_IN` (see
 * `SceneManager.tsx`), off the main camera's default layer 0, so that merged
 * frame already contains only background/accent/overlay/effect layers — no
 * primary at all. This pass adds each primary's OWN capture back in through a
 * mask, and the rest of the chain (mirror, feedback, bloom, lens, grade) then
 * runs exactly ONCE over the composited result. Doing this anywhere else in
 * the chain (after mirror/feedback/bloom) would mean the wipe's masked
 * content skipped those effects, or got them applied twice relative to the
 * rest of the frame — see the plan's "no doubled bloom, no inconsistency"
 * reasoning. Verified safe against the runtime pass-order check in
 * `PostFXChain.tsx` (`warnedChainOrder`), which only asserts `GradePass` is
 * LAST — nothing pins first position or any pass count — and no test in this
 * repo asserts `composer.passes` length or index.
 *
 * ## The energy invariant, extended to two textures
 *
 * `transitions.ts`'s header requires `out(t) + in(t) === 1` for the scene
 * OPACITY mix. This pass has a parallel obligation for its OWN masks:
 * `maskOut + maskIn === 1` at every pixel, every frame, for all three styles:
 *
 *  - `inkDissolve`/`irisWipe`: `maskIn` comes from a single threshold
 *    (`smoothstep`), and the code below always computes `maskOut` as
 *    `1.0 - maskIn` — complementary by construction, nothing to verify at
 *    runtime.
 *  - `datamosh`: no shared scalar mask at all. Each of R/G/B independently
 *    picks EITHER `uCaptureOut` OR `uCaptureIn` via a hard boolean
 *    (`reveal`), never a blend of both. So for any single channel, exactly
 *    one of "sampled from out" / "sampled from in" is true — which is the
 *    per-channel version of the same complementary property, and is what
 *    keeps a hard block-glitch style from ever reading as a brightness flash
 *    the way an uncomplemented pair of masks could.
 *
 * ## Mirrors `transitionWipe.ts`'s pure math, not the other way round
 *
 * Every formula below has a comment pointing at the pure JS function it
 * mirrors (same algorithm, same named constants) — see that file's header
 * for why "mirrors" means algorithmically identical rather than
 * bit-identical: a `sin`-based hash evaluated in a GPU's 32-bit ALU will not
 * agree with 64-bit JS to the last bit, and nothing here depends on it doing
 * so.
 */

/**
 * `uBlockCount x uBlockCount` grid for `datamosh` (aspect-corrected row
 * count, same convention `LensPass.ts`'s `pixels` material uses for its own
 * grid — see the fragment shader). 16 is chosen to read clearly as a BLOCK
 * grid — big enough that neighbouring blocks are visibly distinct cells, not
 * fine enough to blur into noise — while staying far short of `pixels`'
 * own upper range (up to 220 cells wide), because datamosh's blocks need to
 * be individually large enough for their persistent offset and hard
 * reveal edge to actually read as "a block", not just add high-frequency
 * texture to the frame.
 */
export const DATAMOSH_BLOCK_COUNT = 16

const WIPE_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D tDiffuse;
  uniform sampler2D uCaptureOut;
  uniform sampler2D uCaptureIn;
  // Style index as a FLOAT compared with half-integer thresholds, matching
  // this codebase's existing enum-uniform convention (see LensPass.ts's own
  // uStyle) rather than a GLSL int uniform — the values are exactly
  // WIPE_STYLE_INDEX in transitionWipe.ts (0 = inkDissolve, 1 = irisWipe,
  // 2 = datamosh).
  uniform float uStyle;
  uniform float uProgress;
  uniform float uFeather;
  uniform float uSeed;
  uniform float uAspect;
  uniform float uBlockCount;
  varying vec2 vUv;

  vec2 hash2(vec2 p) {
    return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash2(i).x, hash2(i + vec2(1.0, 0.0)).x, f.x),
      mix(hash2(i + vec2(0.0, 1.0)).x, hash2(i + vec2(1.0, 1.0)).x, f.x), f.y);
  }

  // Ported from transitionWipe.ts's hash01(x, y) — same sin/fract formula,
  // same argument order. Keep the two in sync if either changes; they are
  // not expected to ever agree bit-for-bit (see this file's header).
  float hash01(float x, float y) {
    float s = sin(x * 127.1 + y * 311.7) * 43758.5453;
    return s - floor(s);
  }

  void main() {
    vec4 base = texture2D(tDiffuse, vUv);
    vec3 wipeColor = vec3(0.0);

    if (uStyle < 0.5) {
      // inkDissolve — mirrors transitionWipe.ts's inkMaskValue(noise01, progress, feather). Two octaves of
      // value noise (same vnoise/hash2 idiom LensPass.ts's melt material already uses) stand in for the
      // "static per-pixel noise field" the pure function assumes; uSeed offsets it so different transitions
      // don't all wipe through the identical pattern.
      float n = vnoise(vUv * 6.0 + uSeed) * 0.6 + vnoise(vUv * 13.0 + uSeed * 1.7 + 4.2) * 0.4;
      float maskIn = smoothstep(n - uFeather, n + uFeather, uProgress);
      wipeColor = texture2D(uCaptureOut, vUv).rgb * (1.0 - maskIn) + texture2D(uCaptureIn, vUv).rgb * maskIn;
    } else if (uStyle < 1.5) {
      // irisWipe — mirrors transitionWipe.ts's irisMaskValue(radiusFromCenter01, progress, feather).
      // Aspect-corrected UV, same (uv - 0.5) * vec2(aspect, 1.0) convention MirrorPass.ts's twist and
      // LensPass.ts's fly-eye/pixel-sort materials already use — matched exactly, not re-derived.
      vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
      float maxR = length(vec2(uAspect, 1.0) * 0.5); // aspect-corrected corner distance: radius01 reaches 1 there
      float radius01 = length(p) / max(maxR, 1e-4);
      float maskIn = smoothstep(radius01 - uFeather, radius01 + uFeather, uProgress);
      wipeColor = texture2D(uCaptureOut, vUv).rgb * (1.0 - maskIn) + texture2D(uCaptureIn, vUv).rgb * maskIn;
    } else {
      // datamosh — mirrors transitionWipe.ts's datamoshBlockOffset(seed, blockIndex, progress) and
      // datamoshChannelOffset(reveal, progress). Grid sized in SCREEN space (aspect-corrected row count),
      // same convention as LensPass.ts's pixels material (vec2 g = vec2(n, n / uAspect)).
      vec2 g = vec2(uBlockCount, uBlockCount / uAspect);
      vec2 blockId = floor(vUv * g);
      float blockIndex = blockId.x + blockId.y * uBlockCount;

      float hx = hash01(uSeed * 12.9898 + blockIndex * 78.233, 3.71);
      float hy = hash01(uSeed * 4.898 + blockIndex * 37.719, 91.3);
      float hr = hash01(uSeed * 7.31 + blockIndex * 269.5, 43.7);

      // DATAMOSH_MAX_DISPLACEMENT (0.05) in transitionWipe.ts.
      float settle = 1.0 - uProgress;
      vec2 disp = vec2(hx * 2.0 - 1.0, hy * 2.0 - 1.0) * 0.05 * settle;
      vec2 dispUv = clamp(vUv + disp, 0.0, 1.0);

      bool revealG = hr < uProgress;
      // datamoshChannelOffset(reveal, progress): the same triangular arc transitionRack's ramps use in
      // transitions.ts (zero at progress 0/1, peak at the midpoint), signed by revealG. DATAMOSH_CHANNEL_OFFSET_MAX
      // (0.02) in transitionWipe.ts — see that constant's doc for why this stays boundary-local rather than
      // frame-wide: only blocks whose OWN hr sits within a 0.04-wide band of uProgress ever get a channel
      // disagreement at all.
      float arc = smoothstep(0.0, 1.0, 1.0 - abs(uProgress * 2.0 - 1.0));
      float chOffset = (revealG ? 1.0 : -1.0) * 0.02 * arc;
      bool revealR = hr < (uProgress + chOffset);
      bool revealB = hr < (uProgress - chOffset);

      // Each channel independently samples ONE capture texture, never a blend of both — the per-channel
      // complementary property this file's header describes.
      wipeColor.r = revealR ? texture2D(uCaptureIn, dispUv).r : texture2D(uCaptureOut, dispUv).r;
      wipeColor.g = revealG ? texture2D(uCaptureIn, dispUv).g : texture2D(uCaptureOut, dispUv).g;
      wipeColor.b = revealB ? texture2D(uCaptureIn, dispUv).b : texture2D(uCaptureOut, dispUv).b;
    }

    gl_FragColor = vec4(base.rgb + wipeColor, 1.0);
  }
`

export class WipeCompositorPass extends Pass {
  private readonly material: THREE.ShaderMaterial
  private readonly fsScene: THREE.Scene
  private readonly quadGeometry: THREE.PlaneGeometry
  private readonly orthoCamera: THREE.OrthographicCamera

  constructor() {
    super('WipeCompositorPass')
    this.needsSwap = true
    // Idle until `PostFXChain.tsx` sets this from `shouldCapture(tx)` — see
    // this class's header. Starting disabled means a mount with no
    // transition in flight costs nothing, same as every rack pass.
    this.enabled = false
    this.quadGeometry = new THREE.PlaneGeometry(2, 2)
    this.orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    this.material = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: WIPE_FRAG,
      depthWrite: false,
      depthTest: false,
      uniforms: {
        tDiffuse: { value: null },
        uCaptureOut: { value: null },
        uCaptureIn: { value: null },
        uStyle: { value: 0 },
        uProgress: { value: 0 },
        uFeather: { value: 0.1 },
        uSeed: { value: 0 },
        uAspect: { value: 1 },
        uBlockCount: { value: DATAMOSH_BLOCK_COUNT },
      },
    })
    this.fsScene = new THREE.Scene()
    this.fsScene.add(new THREE.Mesh(this.quadGeometry, this.material))
  }

  /**
   * Push this frame's wipe state. Call only while {@link Pass.enabled} is
   * `true` (`PostFXChain.tsx` sets both from the same `shouldCapture(tx)`
   * gate) — calling it while disabled is harmless (it only writes uniforms
   * nothing will read this frame) but pointless.
   *
   * `captureOut`/`captureIn` are `TransitionCapture.outTarget.texture`/
   * `.inTarget.texture` — passed as textures rather than the capture object itself
   * so this class stays free of any `TransitionCapture` import (a `Pass`
   * inside the composer should not need to know how its inputs were
   * produced).
   */
  setWipe(
    style: WipeStyle,
    progress: number,
    feather: number,
    seed: number,
    captureOut: THREE.Texture | null,
    captureIn: THREE.Texture | null,
  ): void {
    const u = this.material.uniforms
    u.uStyle.value = WIPE_STYLE_INDEX[style]
    u.uProgress.value = progress
    u.uFeather.value = feather
    u.uSeed.value = seed
    u.uCaptureOut.value = captureOut
    u.uCaptureIn.value = captureIn
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
