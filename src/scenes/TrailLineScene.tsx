import { useEffect, useMemo, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { FULLSCREEN_VERT } from '../engine/glsl'
import { bufferScale } from '../engine/renderScale'
import { useSceneFrame } from '../engine/sceneFrame'
import { useDispose } from '../engine/useDispose'

/**
 * Trail Line — a rotating, zooming sine-wave stroke that smears a glowing
 * motion trail behind itself. Gestural and oscilloscope-like; the trail is what
 * carries the piece, so it reads as drawing rather than as animation.
 *
 * Ported from a multi-pass Shadertoy (Common + Buffer A + Image). No author or
 * licence accompanied the source. The distance-to-implicit-curve trick in
 * `curveMask` is Inigo Quilez's (iquilezles.org/articles/distance).
 *
 * ## The only scene in the roster that renders to a texture
 *
 * Buffer A samples its own previous frame to accumulate the trail, so this
 * needs a ping-pong pair of render targets — read A, write B, swap. Nothing in
 * the project had that: `envMap.ts` uses PMREM (one-shot prefilter at startup),
 * `GenerativeLayer` crossfades textures fetched from a backend, and
 * `resourceCache` is a refcounted store for SHARED singletons. Deliberately not
 * routed through that cache — the buffers are per-instance state, and sharing
 * one pair between two mounted instances would have them corrupting each
 * other's trails.
 *
 * Ordering works out without new plumbing: `useSceneFrame` runs at `useFrame`
 * priority 0 and `EffectComposer` renders at priority 1, so the offscreen pass
 * issued below always lands before the composer takes the frame.
 *
 * `HalfFloatType` is required rather than preferred. The source clamps the
 * accumulator to 0..2, and an 8-bit target would clip everything above 1.0 —
 * the trail's whole highlight range.
 *
 * ## Frame-rate independence: the source's hack is dropped, its INTENT is not
 *
 * Shadertoy version skipped drawing on most frames (`mod(iFrame, floor(iFrameRate/30.))`)
 * so the stroke landed ~30 times a second regardless of refresh rate, and faded
 * with `1 - 1/(decay*iFrameRate)`.
 *
 * Both are replaced by real `dt` maths, and this is the substantive part of the
 * port:
 *
 *  - **Ink** is scaled by `dt * 30` instead of drawn on every Nth frame. Same
 *    total ink per second, but the stroke is laid down continuously rather than
 *    strobed, so a 144 Hz display gets a smooth smear where the original gave
 *    discrete stamps.
 *  - **Decay** becomes `exp(-dt / decaySeconds)`, which is exactly
 *    frame-rate-independent. The source's `1 - 1/(decay*fps)` was a first-order
 *    approximation of that, and it drifts once `fps` is unstable — precisely
 *    when it matters.
 *
 * ## Band routing
 *
 *   bass       → zoom. Pushes in on the stroke.
 *   mid        → rotation walk rate; transient adds a kick on top.
 *   energy     → stroke length, and the wander rate of every random walk.
 *   energy     → trail decay, INVERSELY. Calm passages hold long trails; busy
 *                ones snap short, so the picture declutters exactly when the
 *                music gets dense.
 *   palette    → hue, taken from the blender's primary. This is the one that
 *                ties it into the mood/key system: `AutoPilot` picks palettes
 *                by key family, so the stroke's colour follows the harmony
 *                rather than a 7-second wall-clock loop.
 *
 * Translation stays on the random walk, per the source — it is the ambient
 * drift that keeps the stroke off-centre and nothing musical wants to own it.
 *
 * Dropped from Common as dead: `line()`, `normSinFunct()`, `rgb2hsv()`, and the
 * unused `eps` local in the distance function. `lineLength` in the source adds
 * `minLength` twice (`minLength + rand*(max-min) + minLength`), so its real
 * range was 0.5..0.75 rather than the 0.25..0.5 the constants imply; that
 * expression is replaced by an audio-driven uniform, so the quirk is moot.
 */

/**
 * Overall brightness.
 *
 * The accumulator runs to 2.0 and the source lifts it further with a cubic
 * glow term, so the trail carries real highlight range. Sparse coverage — one
 * thin stroke — keeps the mean low. Not measured by rendering; a conservative
 * first pass.
 */
const BRIGHTNESS = 0.4

/** Shared by both passes. */
const COMMON_GLSL = /* glsl */ `
  #define PI 3.14159265359

  float sinNorm(float x){ return sin(x)*0.5+0.5; }

  float smoothVal(in float x, in float m) {
    return clamp(smoothstep(0.0,1.0,x/m)*(1.-smoothstep(0.0,1.0,x/m))*4.,0.,1.);
  }

  float rand(float seed) {
    return fract(sin(dot(vec2(seed, seed / PI), vec2(12.9898,78.233))) * 43758.5453);
  }

  vec3 hsv2rgb(vec3 c){
    vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
  }
`

/** Buffer A: draws the stroke and accumulates the trail from its own last frame. */
const BUFFER_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;

  ${COMMON_GLSL}

  uniform sampler2D uPrev;
  uniform vec2 uRes;
  /** Drives f()'s travelling wave. */
  uniform float uTime;
  /** Random-walk phase. Accumulates faster with energy — replaces iTime here. */
  uniform float uWalk;
  /** Independent, mid-driven walk for rotation. */
  uniform float uRotWalk;
  uniform float uZoom;
  uniform float uLineLen;
  uniform float uTransient;
  /** Per-frame trail retention, already exp(-dt/tau) in JS. */
  uniform float uKeep;
  /** dt * 30 — keeps ink-per-second constant, replacing the frame-skip. */
  uniform float uInk;
  uniform float uHue;
  uniform float uSat;

  float randSeed = 0.;
  #define FLOORI(x) float(int(floor(x)))

  // Source used iTime; the walk phase is audio-driven now.
  float smoothRand(float interval, float seed) {
    float next = rand(.000001*FLOORI(1000000.*(1.+FLOORI(uWalk/interval)+seed+randSeed)));
    float curr = rand(.000001*FLOORI(1000000.*(FLOORI(uWalk/interval)+seed+randSeed)));
    randSeed++;
    return mix(curr, next, fract(uWalk/interval));
  }

  float f(vec2 point){ return sin(point.x*2. + uTime*1.275) + point.y; }

  vec2 grad(in vec2 x){
    vec2 h = vec2(0.01, 0.0);
    return vec2(f(x+h.xy) - f(x-h.xy), f(x+h.yx) - f(x-h.yx)) / (2.0*h.x);
  }

  // https://iquilezles.org/articles/distance
  float curveMask(in vec2 point, in int lineWidth){
    float v = f(point);
    vec2 g = grad(point);
    float de = abs(v)/length(g);
    float normalizedLineRadius = (float(max(5, lineWidth)) / uRes.y) / 2.;
    if (normalizedLineRadius < 1./uRes.x) return 0.;
    return 1. - clamp(smoothstep(0., normalizedLineRadius, de), 0., 1.);
  }

  void main(){
    vec2 fragCoord = vUv * uRes;
    vec2 uv = fragCoord / uRes;
    vec2 point = vec2(fragCoord.xy - 0.5*uRes);
    point = 2.0 * point.xy / uRes.y;

    vec4 outCol = vec4(0.);

    // Zoom, rotation, translation — the walks are the source's, their phase is
    // audio-driven, and zoom takes a direct bass push.
    float z = uZoom;
    point /= vec2(z);

    float rot = smoothRand(0.5, 354.856)*PI + uTransient*0.6;
    point = vec2(cos(rot)*point.x + sin(rot)*point.y, -sin(rot)*point.x + cos(rot)*point.y);

    point.x += smoothRand(1., 842.546)*2. - 1.;

    // Stroke. Length is a uniform now; see the note on the source's doubled
    // minLength in the header.
    float lineLength = uLineLen;
    float linePoint = (point.x + lineLength/2.) / lineLength;
    int lineWidth = int(clamp(
      floor(smoothVal(linePoint*100., 100.) * uRes.x * 0.025 * z),
      2., floor(uRes.x * 0.025 * z)));

    if (point.x >= -lineLength/2. && point.x <= lineLength/2.) {
      // Scaled by dt*30 rather than drawn every Nth frame — same ink per
      // second, continuous instead of strobed.
      outCol += curveMask(vec2(point.x, point.y), lineWidth) * uInk;
    }

    // Hue from the palette blender rather than fract(iTime/7.).
    outCol.rgb *= hsv2rgb(vec3(uHue, uSat, 1.));
    outCol.rgb += pow((outCol.r + outCol.g + outCol.b)/3. + 0.25, 3.) - pow(0.25, 3.);

    // Trail. uKeep is exp(-dt/tau), computed in JS — exactly frame-rate
    // independent, unlike the source's 1 - 1/(decay*fps) approximation.
    outCol += texture2D(uPrev, uv) * uKeep;

    outCol.rgb = clamp(outCol.rgb, 0., 2.);
    gl_FragColor = vec4(outCol.rgb, 1.);
  }
`

/** Image pass: shows the accumulator. */
const DISPLAY_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uTex;
  uniform float uFade;
  const float U_BRIGHTNESS = ${BRIGHTNESS.toFixed(3)};
  void main(){
    gl_FragColor = vec4(texture2D(uTex, vUv).rgb * U_BRIGHTNESS * uFade, 1.0);
  }
`

export function TrailLineScene() {
  const gl = useThree((s) => s.gl)
  const size = useThree((s) => s.size)
  /** Buffer scale the targets are currently allocated at; see `sizeBuffers`. */
  const bufScale = useRef(0)
  const clock = useRef(0)
  const walk = useRef(0)
  const rotWalk = useRef(0)
  const hsl = useMemo(() => ({ h: 0, s: 0, l: 0 }), [])

  const bufferMaterial = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: FULLSCREEN_VERT,
        fragmentShader: BUFFER_FRAG,
        depthWrite: false,
        depthTest: false,
        uniforms: {
          uPrev: { value: null },
          uRes: { value: new THREE.Vector2(1, 1) },
          uTime: { value: 0 },
          uWalk: { value: 0 },
          uRotWalk: { value: 0 },
          uZoom: { value: 1 },
          uLineLen: { value: 0.5 },
          uTransient: { value: 0 },
          uKeep: { value: 0.9 },
          uInk: { value: 0.5 },
          uHue: { value: 0.5 },
          uSat: { value: 0.8 },
        },
      }),
    [],
  )

  const displayMaterial = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: FULLSCREEN_VERT,
        fragmentShader: DISPLAY_FRAG,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
        uniforms: { uTex: { value: null }, uFade: { value: 0 } },
      }),
    [],
  )

  const geometry = useMemo(() => new THREE.PlaneGeometry(2, 2), [])

  /**
   * Offscreen pass scaffolding.
   *
   * The buffer is sized in CSS pixels rather than device pixels — trails are
   * soft enough that retina resolution is wasted on them — and then scaled by
   * {@link bufferScale}, which is this scene's half of the engine's pixel
   * budget.
   *
   * That second factor is the part that was missing, and it was a real hole
   * rather than a refinement: this scene's expensive pass is the accumulator,
   * not the composite, and a CSS-sized target is invisible to the canvas DPR.
   * So on a machine dropping frames, every governor lever in the engine moved
   * and this scene's actual cost did not move at all.
   *
   * It is deliberately NOT the raw applied scale. Reallocating these targets
   * discards the trail — the whole subject vanishes and redraws over the next
   * second — so the size follows the budget in quarter steps, which move a
   * handful of times across a session instead of on every tier wobble. That is
   * the same trade the original CSS-pixel sizing was making, kept, but now
   * bounded by the budget instead of ignoring it.
   */
  const rt = useMemo(() => {
    const opts = { type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false }
    const a = new THREE.WebGLRenderTarget(1, 1, opts)
    const b = new THREE.WebGLRenderTarget(1, 1, opts)
    const scene = new THREE.Scene()
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    scene.add(new THREE.Mesh(geometry, bufferMaterial))
    return { a, b, scene, camera, read: a, write: b }
  }, [geometry, bufferMaterial])

  useDispose(bufferMaterial, displayMaterial, geometry, rt.a, rt.b)

  /**
   * Allocate the pair at the current budget, if it has moved.
   *
   * Driven by the render scale's VALUE, not by `viewport.dpr` — the DPR is
   * `baseDpr * scale`, so a real scale change can leave it unchanged (2x at 0.5
   * and 1x at 1.0 are both DPR 1) and an effect keyed on it would silently
   * never re-run. `setSize` is a no-op in three when the dimensions match, but
   * the guard is what makes the CSS-size path cheap to check every frame.
   */
  const sizeBuffers = () => {
    const scale = bufferScale()
    if (scale === bufScale.current) return
    bufScale.current = scale
    const w = Math.max(1, Math.floor(size.width * scale))
    const h = Math.max(1, Math.floor(size.height * scale))
    rt.a.setSize(w, h)
    rt.b.setSize(w, h)
    // The shader's idea of resolution is the BUFFER's: it sets the stroke's
    // pixel width and the aspect the curve is evaluated in, so passing the CSS
    // size here would draw a differently-shaped stroke than the one written.
    bufferMaterial.uniforms.uRes.value.set(w, h)
  }

  useEffect(() => {
    bufScale.current = 0
    sizeBuffers()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rt, bufferMaterial, size])

  useSceneFrame(({ f, dt, b, col, vis, params }) => {
    // Before anything reads uRes: the engine may have re-solved the budget
    // since the last frame, and the accumulator is this scene's expensive half.
    sizeBuffers()
    const u = bufferMaterial.uniforms

    clock.current += dt * params.speed
    // Every random walk shares one phase, advancing faster as the track opens
    // up — so the stroke reconfigures more often at high energy.
    walk.current += dt * (0.45 + b.energy * 1.1) * params.speed
    rotWalk.current += dt * (0.35 + b.mid * 1.3) * params.speed

    u.uTime.value = clock.current
    u.uWalk.value = walk.current
    u.uRotWalk.value = rotWalk.current
    // Bass pushes in. Source walked this randomly between 0.5 and 1.5.
    u.uZoom.value = 0.75 + b.bass * 0.55
    // Longer stroke as the track builds, tighter when it thins out.
    u.uLineLen.value = 0.28 + b.energy * 0.38 + (f.buildUp ? 0.08 : 0)
    u.uTransient.value = b.transient

    // Trail length, INVERSE to energy: calm holds, busy snaps short.
    const tau = 0.95 - Math.min(0.6, b.energy * 0.6)
    u.uKeep.value = Math.exp(-dt / tau)
    // Constant ink per second regardless of refresh rate. Clamped so a long
    // frame after a stall cannot dump a solid block of ink into the buffer.
    u.uInk.value = Math.min(2, dt * 30)

    // Hue follows the show palette, which AutoPilot picks by key family.
    col.a.getHSL(hsl)
    u.uHue.value = hsl.h
    u.uSat.value = 0.55 + hsl.s * 0.4

    displayMaterial.uniforms.uTex.value = rt.read.texture
    displayMaterial.uniforms.uFade.value = vis

    // --- offscreen pass ---------------------------------------------------
    // Runs at useFrame priority 0, before EffectComposer's priority 1.
    //
    // Skipped entirely while this instance contributes nothing to the frame.
    // `SceneManager` hides an invisible entry with `node.visible = false`, which
    // removes it from the main render traversal but has NO effect on a manual
    // `gl.render()` — so a scene warming as a pending candidate used to pay two
    // full-resolution passes every frame for as long as the commit took (up to
    // the 2.5 s safety timeout), while drawing nothing anyone could see.
    //
    // Safe to skip rather than defer: the buffer holds its last accumulated
    // state, and the trail is a decaying feedback loop, so it simply resumes
    // from where it left off when the fade lifts.
    if (vis <= 0.001) return

    u.uPrev.value = rt.read.texture
    const prevTarget = gl.getRenderTarget()
    gl.setRenderTarget(rt.write)
    gl.render(rt.scene, rt.camera)
    gl.setRenderTarget(prevTarget)

    const swap = rt.read
    rt.read = rt.write
    rt.write = swap

    displayMaterial.uniforms.uTex.value = rt.read.texture
  })

  return (
    <mesh frustumCulled={false}>
      <primitive object={geometry} attach="geometry" />
      <primitive object={displayMaterial} attach="material" />
    </mesh>
  )
}
