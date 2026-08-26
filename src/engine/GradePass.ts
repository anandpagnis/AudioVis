import * as THREE from 'three'
import { Pass } from 'postprocessing'
import { FULLSCREEN_VERT } from './glsl'
import { exposure } from './exposure'

/**
 * The finishing stage: one multiply on the composited frame, driven by the
 * adaptive exposure servo.
 *
 * ## Why this pass exists at all
 *
 * Two reasons, and the second is the one that made it worth adding.
 *
 * **It gives exposure somewhere to live.** A gain has to be applied after
 * everything that produces light — scenes, feedback, bloom, the lens rack — so
 * it belongs to a stage at the end of the chain. lilim has exactly this as
 * `finishPass`; this chain had no equivalent, which is why the servo had nowhere
 * to land.
 *
 * **It frees the lens rack.** `EffectComposer` flags the LAST pass added as the
 * one that renders to screen, and skips disabled passes before that happens — so
 * whichever pass is last can never switch itself off without freezing the canvas
 * on its final presented frame. `LensPass` was carrying that duty and paying an
 * unconditional fullscreen blit for it even when inert (logged as F54). Moving a
 * genuinely always-on stage to the end hands the duty to something that earns
 * it, and lets the lens go back to a plain `enabled` branch that costs nothing
 * at rest. **Net frame cost is unchanged** — the blit the lens was already
 * paying is now this pass, doing useful work instead of copying.
 *
 * ## Multiply, not offset
 *
 * `uGain` multiplies. This is not a stylistic choice: docs/09_Rendering_Engine.md
 * records that a previous grade attempt used `BrightnessContrast.brightness`,
 * which is an ADDITIVE offset, and that a negative value drove black negative —
 * which AgX's log-space transform then returned as a lifted mid-grey, producing
 * a full-frame wash even with every scene forced to zero. Exposure is a
 * multiply; anything else is a different operation wearing its name.
 *
 * ## It also owns the output colour-space conversion
 *
 * Being last carries a duty beyond presenting the frame: the composer works in
 * linear, the display is sRGB, and the final pass is what converts. See the
 * colorspace_fragment include in the shader — its absence is what made the
 * picture permanently dark while every individual file still looked correct.
 *
 * ## Where a filmic curve would go
 *
 * After this multiply, inside this pass, and nowhere else. The same document
 * records that a display transform must come LAST in the colour pipeline —
 * grading after AgX expanded an already-mapped signal into 39% of the frame
 * blown to pure white. It also records the real blocker: the scenes render hot,
 * so any tone mapper parks the whole image on its rolloff knee. The servo above
 * is the mechanism that addresses that blocker, by bringing the level down from
 * measurement rather than by hoping every scene is well behaved — but the curve
 * itself is deliberately NOT added here yet, because that document is equally
 * clear that exposure constants can only be calibrated against a real playing
 * track, and that has not been done.
 */

const GRADE_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D tDiffuse;
  uniform float uGain;
  varying vec2 vUv;

  void main() {
    vec3 col = texture2D(tDiffuse, vUv).rgb * uGain;
    // No clamp and no curve. Clamping here would hide exactly the blown
    // highlights the servo is measuring on the next sample, so the loop would
    // stop being able to see the fault it exists to correct.
    gl_FragColor = vec4(col, 1.0);
    // LINEAR -> DISPLAY. This is the last pass in the chain, so it owns the
    // output colour-space conversion, and omitting it is not subtle: the
    // composer's buffers are linear, and writing linear values straight to an
    // sRGB framebuffer presents every mid-tone far darker than it is. Measured,
    // the whole show was running about five times too dark.
    //
    // Every pass in this chain that this project wrote is a ShaderMaterial
    // without this line, and that was harmless for exactly as long as the LAST
    // pass was postprocessing's own merged EffectPass — its shaders all end with
    // this include, so it did the conversion on everyone's behalf. The moment
    // one of ours took the final position the conversion silently disappeared,
    // and nothing in any single file looked wrong.
    //
    // three injects linearToOutputTexel into the fragment prefix for a
    // ShaderMaterial (not a RawShaderMaterial), keyed on whether the pass is
    // rendering to a target or to screen, so this is correct in both cases
    // rather than assuming sRGB.
    #include <colorspace_fragment>
  }
`

export class GradePass extends Pass {
  private readonly material: THREE.ShaderMaterial
  private readonly fsScene: THREE.Scene
  private readonly quadGeometry: THREE.PlaneGeometry
  private readonly orthoCamera: THREE.OrthographicCamera

  constructor() {
    super('GradePass')
    this.needsSwap = true
    this.quadGeometry = new THREE.PlaneGeometry(2, 2)
    this.orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    this.material = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: GRADE_FRAG,
      depthWrite: false,
      depthTest: false,
      uniforms: {
        tDiffuse: { value: null },
        uGain: { value: 1 },
      },
    })
    this.fsScene = new THREE.Scene()
    this.fsScene.add(new THREE.Mesh(this.quadGeometry, this.material))
  }

  render(
    renderer: THREE.WebGLRenderer,
    inputBuffer: THREE.WebGLRenderTarget | null,
    outputBuffer: THREE.WebGLRenderTarget | null,
  ): void {
    if (!inputBuffer) return
    // Read the servo here rather than being pushed a value: this pass is the
    // only consumer, and going through the singleton means a context loss that
    // resets exposure reaches the shader on the very next frame.
    this.material.uniforms.uGain.value = exposure.gain
    this.material.uniforms.tDiffuse.value = inputBuffer.texture
    renderer.setRenderTarget(this.renderToScreen ? null : outputBuffer)
    renderer.render(this.fsScene, this.orthoCamera)
  }

  dispose(): void {
    this.material.dispose()
    this.quadGeometry.dispose()
    super.dispose()
  }
}
