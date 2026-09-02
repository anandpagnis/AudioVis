import * as THREE from 'three'
import { Pass } from 'postprocessing'
import { FULLSCREEN_VERT } from './glsl'
import { renderScale } from './renderScale'
import { exposure } from './exposure'
import { approach, performanceState } from './performanceState'
import { getPalette } from './palettes'
import { useStore } from '../store'
import { audioEngine } from '../audio/AudioEngine'

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
 * ## `uFog`, and why atmosphere moved out of the scene graph
 *
 * `performanceState.fog` drove `scene.fog`, an exponential `FogExp2` attached
 * for the whole session. The plumbing was perfect and it reached almost no
 * pixels: three applies `scene.fog` only to materials that opt in,
 * `ShaderMaterial.fog` defaults to false, and no scene in the roster sets it.
 * The one fog-capable material was `chrome`'s `MeshPhysicalMaterial`. So a
 * director moving `fog` was steering something that answered on **one scene of
 * sixteen** (F46).
 *
 * Per-material fog could never have fixed that, because most of this roster is
 * a fullscreen quad with no depth to fog. The two honest options were sixteen
 * hand-written copies of the same term — sixteen chances to drift — or one
 * post-chain effect that reaches every scene by construction. This is the
 * second.
 *
 * It is veiling glare, not distance fog, because distance is not available:
 * the quad scenes write no usable depth. Veiling is what atmosphere actually
 * looks like anyway — light scattered out of the subject into the air in front
 * of it — and unlike a depth ramp it acts on a black field, which is what this
 * roster mostly is.
 *
 * ## `uIris`, and why the vignette needed a partner
 *
 * The intent behind `performanceState.vignette` is "the frame tightens through
 * a build". A vignette delivers that by darkening the periphery — a MULTIPLY —
 * and measured on `kaleido`, which fills the frame, it does exactly that: the
 * edge falls from 0.85 of centre luminance to 0.31, a 2.7x relative darkening.
 *
 * On most of this roster it can do nothing at all, and that is not a bug in the
 * vignette. Measured on `wireframe`, the edge sits at **4% of centre luminance
 * before the vignette touches anything** — the periphery is already black, and
 * multiplying black by a smaller number is still black. The exposure discipline
 * that makes the show look the way it does (a bright subject on true black, see
 * docs/09_Rendering_Engine.md) is precisely what leaves the vignette nothing to
 * act on. That was F47.
 *
 * So the dial keeps the vignette AND gains a term that works on a black field:
 * a small inward scale. Pushing in magnifies the subject, which reads as the
 * frame closing regardless of what is in the corners. One dial, two mechanisms,
 * and between them it now does something visible on every scene in the roster
 * rather than on the four that fill the frame.
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
 *
 * **Correcting an external mischaracterisation of the AgX failure (2026-09):**
 * a competitive audit of this engine, written without reading this file, guessed
 * the AgX regression was caused by metering off a whole-frame MEAN on
 * black-dominant content, and proposed retrying AgX after switching the exposure
 * servo to a percentile statistic. That is not what the paragraph above says
 * happened, and it is worth being explicit about the difference: the actual
 * cause was an ADDITIVE brightness offset going negative and AgX's log-space
 * transform having no representation for negative light, which is a different
 * bug, in a different stage, already fixed by the specific discipline this
 * pass's own `uGain` enforces — "Exposure is a multiply; anything else is a
 * different operation wearing its name" (see above). `exposure.ts` gained a
 * `p50` statistic in the same pass that corrected this comment, which is a
 * genuine improvement (a percentile is more robust than a mean to a few
 * outlier-bright pixels) but is not what unblocks AgX — the blocker named two
 * paragraphs up, a live-track calibration pass, is unrelated to it and remains
 * the actual gate.
 */

const GRADE_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D tDiffuse;
  uniform float uGain;
  uniform float uIris;
  uniform float uFog;
  uniform float uLuma;
  uniform vec3 uFogColor;
  uniform float uSharpen;
  uniform vec2 uTexel;

  /**
   * Contrast-adaptive sharpening, run on the frame before the browser stretches
   * it to the canvas (F122).
   *
   * ## Why sharpening, and why here
   *
   * The render-scale governor lowers the DRAWING BUFFER and leaves the canvas's
   * CSS size alone, so the browser stretches the result with plain bilinear
   * filtering. On a 2560x1440 panel at scale 0.40 that is 1536x864 blown up to
   * 2560x1440 — a 1.67x linear stretch with no reconstruction at all, which is
   * exactly the "everything looks soft" the tier ladder trades away.
   *
   * The ladder is not the thing to change: shedding pixels IS how the frame gets
   * cheap, and the recordings show it working. What was missing is that nothing
   * ever put the detail back. Sharpening before the upscale is the standard
   * answer — it is what FSR1's RCAS stage does, and it is deployed exactly this
   * way, as the last thing before display scaling.
   *
   * ## Why it lives inside the grade rather than as its own pass
   *
   * A separate pass would be a whole extra fullscreen draw, and F110 exists
   * because fullscreen draws are the dominant cost in this chain. GradePass is
   * already the final pass and already samples this texture, so folding the
   * filter in costs FOUR EXTRA TAPS instead of a full-frame read/write cycle.
   * The taps are also at the INTERNAL resolution, so the pass gets cheaper at
   * exactly the moment the sharpening is needed most.
   *
   * ## The algorithm
   *
   * AMD's CAS, in its 5-tap form. The point of the "adaptive" part is that a
   * fixed unsharp mask ruins the frame it is meant to help: it rings on
   * high-contrast edges (the wireframe scenes are nothing but high-contrast
   * edges) and amplifies noise in flat regions. CAS instead measures local
   * contrast and sharpens INVERSELY to it, so a flat area gets a lot and an
   * already-crisp edge gets almost none.
   */
  vec3 casSharpen(vec2 uv, vec3 centre) {
    // Cross neighbourhood. The 3x3 corners are deliberately skipped: they cost
    // four more taps for a difference that does not survive a 1.6x stretch.
    vec3 up    = texture2D(tDiffuse, uv + vec2(0.0, -uTexel.y)).rgb;
    vec3 down  = texture2D(tDiffuse, uv + vec2(0.0,  uTexel.y)).rgb;
    vec3 left  = texture2D(tDiffuse, uv + vec2(-uTexel.x, 0.0)).rgb;
    vec3 right = texture2D(tDiffuse, uv + vec2( uTexel.x, 0.0)).rgb;

    // Contrast is measured per channel and then reduced, which keeps a strongly
    // coloured edge (this roster is full of them) from being treated as flat
    // just because its luma happens not to move.
    vec3 mn = min(min(up, down), min(left, min(right, centre)));
    vec3 mx = max(max(up, down), max(left, max(right, centre)));

    // How much headroom the neighbourhood has before it clips, in either
    // direction. Near-black and near-white regions get less, which is what
    // stops the filter from tearing halos out of a bloom bloom-out.
    vec3 amp = clamp(min(mn, 1.0 - mx) / max(mx, 0.0001), 0.0, 1.0);
    amp = sqrt(amp);

    // Negative lobe. Normalising by the total weight keeps the average level
    // unchanged, so this sharpens without shifting exposure — which matters
    // because the exposure servo is watching this same frame.
    float w = -(1.0 / mix(8.0, 5.0, uSharpen)) * dot(amp, vec3(0.3333));
    vec3 sum = centre + (up + down + left + right) * w;
    return clamp(sum / (1.0 + 4.0 * w), 0.0, 1.0e4);
  }
  varying vec2 vUv;

  void main() {
    // Iris: push in toward the centre. See the note on uIris below for why the
    // vignette needed a partner that works on a black field.
    //
    // Scaling UV toward the centre magnifies, so the subject grows and the
    // frame reads as closing in. Deliberately tiny — 4% at full — because this
    // rides a director dial that moves through every build, and anything a
    // viewer can identify as a zoom stops reading as tension and starts reading
    // as a camera move, which CameraDirector already owns.
    vec2 uv = (vUv - 0.5) * (1.0 - uIris * 0.04) + 0.5;
    vec3 col = texture2D(tDiffuse, uv).rgb;
    // Sharpen BEFORE the gain, so the filter's clamp works in the same range it
    // was derived for. Skipped entirely when the frame is already native — the
    // branch is on a uniform, so every fragment takes the same path and the
    // taps genuinely are not paid for at scale 1.
    if (uSharpen > 0.001) col = casSharpen(uv, col);
    col *= uGain;

    // Atmosphere, as veiling glare rather than as distance fog.
    //
    // Two terms, both of which act on a black field — which is the whole reason
    // this is here rather than on scene.fog. See the note above.
    //
    //   LIFT: light scattered out of the subject and into the surrounding air,
    //   so the blacks rise in proportion to how much light is actually in the
    //   frame. uLuma is the exposure servo's own whole-frame mean, already
    //   measured every 0.18 s for a different purpose, so this costs a uniform
    //   rather than a pass.
    //
    //   VEIL: contrast collapses toward that same scattered level. Held low on
    //   purpose. The director really does reach fog 1.0 on a sparse ambient
    //   passage (sparse*0.6 + 0.25 + relaxed*0.2), so full deflection has to be
    //   heavy weather rather than a white-out — measured at the first pass, 1.0
    //   lifted a black edge from 8.7 to 119 of 255, which is not atmosphere,
    //   it is erasure.
    if (uFog > 0.0001) {
      float scatter = uLuma * uFog;
      col += uFogColor * scatter * 0.45;
      col = mix(col, vec3(scatter), uFog * 0.18);
    }
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

/**
 * Absolute ceiling on `uSharpen`, from any combination of sources.
 *
 * Past this point CAS stops recovering detail and starts manufacturing edges
 * of its own (see {@link sharpenForScale}'s own header) — a false edge on a
 * wireframe scene reads far worse than a soft true one. Named and exported so
 * every contributor to `uSharpen` (the render-scale ramp below, and the
 * `sparkle`-driven shimmer term in {@link GradePass.render}) clamps against
 * the SAME number rather than two copies of `0.85` silently drifting apart.
 */
export const CAS_SHARPEN_CEILING = 0.85

/**
 * How hard to sharpen, given the scale the frame was rendered at (F122).
 *
 * Pure and exported because it is the whole tuning surface of the upscale, and
 * a mapping that silently returned a non-zero value at scale 1 would sharpen a
 * native frame that has nothing to reconstruct — spending taps to add edges
 * that were never lost.
 *
 * The ramp reaches its cap at scale 0.4, which is `RENDER_SCALE_FLOOR`: the
 * softest the governor may ever go, and therefore the frame most in need of
 * reconstruction. It is capped BELOW 1 on purpose — past roughly 0.85 CAS stops
 * recovering detail and starts manufacturing edges of its own, and a false edge
 * on a wireframe scene reads far worse than a soft true one.
 */
export function sharpenForScale(scale: number): number {
  if (!isFinite(scale) || scale >= 1) return 0
  return Math.min(CAS_SHARPEN_CEILING, Math.max(0, (1 - scale) * 1.4))
}

/**
 * Ease rate for the `sparkle`-driven shimmer term below — see the render()
 * comment for why this exists at all. `sparkle` is already adaptively
 * normalized per-band (BandNormalizer's own attack/release), but that
 * smoothing is tuned for "does the visualizer feel responsive", not for "is
 * this a stable input to a sharpening filter" — a filter parameter that moves
 * every frame reads as texture crawl on a static-looking scene. Matches the
 * ballpark of `performanceState.approach`'s own camera-distance rate (3) —
 * fast enough to feel tied to the music within well under a second, slow
 * enough that a single loud transient can't spike it.
 */
const SPARKLE_SHARPEN_EASE_RATE = 4

/**
 * Ceiling on how much of {@link CAS_SHARPEN_CEILING}'s headroom the `sparkle`
 * shimmer term may spend, on top of whatever `sharpenForScale` already
 * contributed. Small on purpose: this is a cosmetic cue, not
 * a substitute for the reconstruction sharpening exists to do, and the total
 * is still hard-clamped to `CAS_SHARPEN_CEILING` in `render()` regardless —
 * this cap is what keeps that clamp from ever being the thing doing the work
 * (a term that only ever matters via the outer clamp is a term whose own
 * number is meaningless).
 */
const SPARKLE_SHARPEN_MAX = 0.15

/**
 * Combine the render-scale sharpen base with the sparkle shimmer term.
 *
 * Pure and exported for the same reason `sharpenForScale` is: this is the
 * part of the shimmer feature that actually carries the design — the additive
 * (not multiplicative) combination, and the fact that the total is clamped to
 * `CAS_SHARPEN_CEILING` regardless of how each input got there — and it is
 * checkable with no GPU. `easedSparkle01` is taken already eased toward 0..1:
 * the raw-value guard and the temporal easing both live in `render()`,
 * against the live `audioEngine`/`approach` singletons, which is the part
 * that genuinely needs a frame loop and is deliberately not re-tested here
 * (see isfFilterPass.test.ts's header for this file's own precedent on
 * stating rather than faking the GPU-bound half). Still total against a
 * non-finite/out-of-range input, same discipline as `sharpenForScale` and
 * `computeValenceArousal` — a NaN reaching a shader uniform is a permanently
 * blank/broken frame, not a one-frame glitch.
 */
export function sharpenWithSparkle(scaleBase: number, easedSparkle01: number): number {
  const sparkleIn = Number.isFinite(easedSparkle01) ? easedSparkle01 : 0
  const sparkleTerm = Math.min(1, Math.max(0, sparkleIn)) * SPARKLE_SHARPEN_MAX
  const baseIn = Number.isFinite(scaleBase) ? scaleBase : 0
  return Math.min(CAS_SHARPEN_CEILING, Math.max(0, baseIn) + sparkleTerm)
}

export class GradePass extends Pass {
  private readonly material: THREE.ShaderMaterial
  private readonly fsScene: THREE.Scene
  private readonly quadGeometry: THREE.PlaneGeometry
  private readonly orthoCamera: THREE.OrthographicCamera
  /** Eased copy of `f.sparkle` for the shimmer term — see render()'s comment
   *  on why the raw per-frame band value is never read straight into a
   *  visual parameter. */
  private easedSparkle = 0

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
        uIris: { value: 0 },
        uFog: { value: 0 },
        uLuma: { value: 0 },
        uFogColor: { value: new THREE.Color(0.05, 0.06, 0.09) },
        uSharpen: { value: 0 },
        uTexel: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
      },
    })
    this.fsScene = new THREE.Scene()
    this.fsScene.add(new THREE.Mesh(this.quadGeometry, this.material))
  }

  render(
    renderer: THREE.WebGLRenderer,
    inputBuffer: THREE.WebGLRenderTarget | null,
    outputBuffer: THREE.WebGLRenderTarget | null,
    deltaTime?: number,
  ): void {
    if (!inputBuffer) return
    // deltaTime is optional on the base Pass signature (same guard FeedbackPass
    // uses for its own wobble clock) — a backgrounded-tab resume or a
    // context-restore frame can hand back something non-finite, and letting
    // that poison `easedSparkle` would leave the shimmer term stuck at
    // whatever it last eased toward for the rest of the session.
    const dt = Number.isFinite(deltaTime) ? (deltaTime as number) : 0
    // Read the servo here rather than being pushed a value: this pass is the
    // only consumer, and going through the singleton means a context loss that
    // resets exposure reaches the shader on the very next frame.
    this.material.uniforms.uGain.value = exposure.gain
    this.material.uniforms.uIris.value = performanceState.vignette
    const u = this.material.uniforms
    u.uFog.value = performanceState.fog
    // The servo's mean is in output space and updates on its own 0.18 s cadence,
    // which is far slower than the eye needs for a haze level — atmosphere that
    // snapped per frame would read as flicker, so the lag is a feature.
    u.uLuma.value = exposure.mean
    // Haze takes the palette's own ground colour. Scattered light is the colour
    // of what it scatters through, and `bg` is exactly that slot.
    ;(u.uFogColor.value as THREE.Color).set(getPalette(useStore.getState().paletteId).slots.bg)
    // Sharpening tracks how far the frame is from native, because that is
    // exactly how much bilinear stretching the browser is about to do to it.
    //
    // The ramp reaches its cap by scale 0.4, which is RENDER_SCALE_FLOOR — the
    // blurriest the governor is ever allowed to get, and so the case that needs
    // the most reconstruction. Capped below 1 deliberately: past about 0.85 CAS
    // stops recovering detail and starts drawing its own edges, and a false
    // edge on a wireframe scene is worse than a soft real one.
    //
    // A small `sparkle`-driven shimmer term rides on top of this same uniform
    // rather than getting its own pass or its own uniform.
    // `sparkle` (AudioFeatures.sparkle — mean magnitude 16 kHz-Nyquist) was
    // computed every frame and read only by the debug/analytics panels; CAS's
    // negative-lobe unsharp is, by construction, a HIGH-FREQUENCY-DETAIL
    // emphasis filter, so nudging it from a literal high-frequency-energy
    // reading is a more honest "shimmer" cue than it might look at first
    // glance — turning up the same knob that already exists to recover high
    // frequencies, in response to there being more of them in the source.
    //
    // Reusing `uSharpen` rather than introducing a new uniform/pass keeps this
    // inside the file's no-new-GLSL, no-new-fullscreen-draw discipline (see
    // this file's own header on F110/F122). The alternative this bundle's
    // brief also sanctioned — nudging Bloom's `luminanceThreshold` in
    // PostFXChain.tsx — was rejected: that uniform is a DIRECTOR-owned dial
    // (`performanceState.bloomThreshold`, single-writer by convention, see
    // performanceState.ts's header), so an audio-reactive nudge would need to
    // land inside PostFXChain's own useFrame and read as a second, competing
    // writer on the same value the director layer already claims outright.
    // `uSharpen` has no such owner — GradePass computes 100% of it already —
    // so adding a second additive contributor here is a strictly local change
    // with no cross-layer contract to reason about.
    //
    // Raw `sparkle` is clamped defensively (BandNormalizer's own doc gives no
    // hard ceiling) and eased locally via `approach` before it ever reaches a
    // visual parameter — see SPARKLE_SHARPEN_EASE_RATE's own doc for why a
    // per-band-normalized value still isn't smooth enough for this use. The
    // additive term is capped at SPARKLE_SHARPEN_MAX (0.15) and the TOTAL is
    // still hard-clamped to CAS_SHARPEN_CEILING (0.85, the same ceiling
    // `sharpenForScale` itself never exceeds) — so a native-resolution frame
    // (base 0) can pick up at most a gentle 0.15 of shimmer, and the frame
    // already at the render-scale ramp's own cap can add nothing further.
    const rawSparkle = Number.isFinite(audioEngine.features.sparkle)
      ? Math.min(1, Math.max(0, audioEngine.features.sparkle))
      : 0
    this.easedSparkle = approach(this.easedSparkle, rawSparkle, SPARKLE_SHARPEN_EASE_RATE, dt)
    u.uSharpen.value = sharpenWithSparkle(sharpenForScale(renderScale.applied), this.easedSparkle)
    ;(u.uTexel.value as THREE.Vector2).set(1 / inputBuffer.width, 1 / inputBuffer.height)
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
