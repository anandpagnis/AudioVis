import { useMemo, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { DJCAM_EXIT_FADE_SEC } from '../engine/DjCamDirector'
import { djCamSource } from '../engine/djCamSource'
import { FULLSCREEN_VERT } from '../engine/glsl'
import { useSceneFrame } from '../engine/sceneFrame'
import { useDispose } from '../engine/useDispose'

/**
 * DJ Cam — the director's cutaway to a live camera of the DJ, graded as a
 * deliberate cinemascope broadcast insert rather than a raw webcam feed.
 *
 * This is NOT a normal roster scene: it is out of every automatic selection
 * pool (`moods: []`), out of every by-hand picker (`HIDDEN_PICKER_IDS`), and
 * only `DjCamDirector` (engine/DjCamDirector.tsx, `useFrame` -87) ever routes
 * the show onto it — automatically on a rare high-confidence drop, or by the
 * Console "Cut to DJ Cam" button. See docs/13_DJ_Cam.md.
 *
 * ## Hand-written, not `createShaderScene`
 *
 * The factory caches one `ShaderMaterial` per scene id across every mount and
 * has no concept of an external, per-frame, opaque texture. This scene owns a
 * `THREE.VideoTexture` built from the *shared* `djCamSource.video` element
 * (engine/djCamSource.ts — one `<video>`, created once, `srcObject` set to the
 * live `MediaStream` handed over from the Console window). `useDispose` releases
 * ONLY that texture (plus this mount's material/geometry) on unmount; the video
 * element outlives every cutaway and is the stream singleton's to manage, never
 * this scene's.
 *
 * `VideoTexture` self-updates each frame once the element has data, so there is
 * no per-frame `needsUpdate` here. Nothing is sampled before `djCamSource.ready`
 * — the shader outputs pure black until then, so a torn or undecoded first
 * frame can never reach the screen.
 *
 * ## Enter hard, leave soft
 *
 * `DjCamDirector` hard-cuts INTO this scene (a drop is a hard cut anyway, and a
 * hard cut never ghosts an opaque frame). It cannot use `dipToBlack` on the way
 * OUT — that style is disabled engine-wide — so this scene does the dip itself:
 * when `ctx.state.djCam.releasing` goes true, `exitEnv` ramps 1 -> 0 over
 * {@link DJCAM_EXIT_FADE_SEC} and is folded into the output alongside the
 * crossfade weight. The director then commits the return scene NON-immediate,
 * so it dissolves up from a frame that is already fully black — smooth, and
 * ghost-free because there is nothing left of the feed to bleed through the
 * letterbox bars.
 *
 * ## The grade (fragment shader)
 *
 *  1. COVER-FIT — the feed fills the frame with the overflow cropped, from the
 *     video's intrinsic aspect against the drawing buffer's. A squeezed camera
 *     image is the one thing a "cinemascope" look must not do; the black bars
 *     in (2) are the deliberate part, an anamorphic stretch is not.
 *  2. 2.39:1 LETTERBOX — applied LAST, as a mask, so the tone ops in (3)-(6)
 *     cannot lift the bars off true black.
 *  3. CONTRAST — a gentle lift about linear mid-grey (`CONTRAST_PIVOT`), ~1.12x
 *     at the dial's neutral.
 *  4. DESATURATION — ~15% of the colour pulled toward Rec.709 luma at neutral.
 *  5. VIGNETTE — an aspect-corrected radial darkening, ~0.30 at neutral.
 *  6. GRAIN — very faint film grain, mostly driven by `ctx.b.energy` with a
 *     small always-on floor so a held cutaway never reads as a paused JPEG
 *     (HoldScene's header records why a frame that goes fully static looks
 *     broken).
 *  7. `uFade` — the crossfade weight (`ctx.vis`) times this scene's own
 *     `exitEnv`, then opaque `vec4(col * uFade, 1.0)`.
 *
 * Raw texels are sRGB; the composer's GradePass encodes the final frame, so
 * this hands it LINEAR — the same rule maze/truchet document. The `pow(x, 2.2)`
 * decode on sample is an approximation, which is all a look this loose needs.
 *
 * ## Scene Contract — the grade is live-tunable
 *
 * Five of the seven vocabulary dials drive the grade, so the Console can adjust
 * the look with no code edit (the manual-punch button is the loop for exactly
 * this). Neutral 0.5 on every dial IS the locked cinemascope look, so the panel
 * centre is not a different picture from the one this shader was tuned at.
 *
 *   fill        -> letterbox target aspect   ("letterbox")     0.5 -> 2.39:1
 *   contrast    -> contrast-lift slope       ("contrast")      0.5 -> ~1.12x
 *   shape       -> vignette strength         ("vignette")      0.5 -> ~0.30
 *   complexity  -> desaturation amount       ("desaturation")  0.5 -> ~15%
 *   density     -> grain amplitude           ("grain")         0.5 -> very faint
 *
 * `speed` and `tilt` are not declared — a static insert has neither an
 * autonomous motion rate nor a viewpoint axis. The contract literal lives on
 * the `djcam` SceneDef in scenes/index.ts (the roster inlines every contract
 * there); this scene only reads the resolved `ctx.p`.
 *
 * ## No `pixelBudget`
 *
 * A `VideoTexture` fullscreen blit is sub-millisecond, and downscaling a camera
 * feed then upscaling it just softens a photographic image for nothing. Full
 * drawing-buffer resolution, direct path. `performanceCost: 'low'`,
 * `fillBound: false`.
 */

/** Linear mid-grey the contrast lift pivots about (~ sRGB 18% grey). */
const CONTRAST_PIVOT = 0.18

/**
 * Exported so the shader can be compiled/linked outside the app — the roster
 * convention (see MatrixRainScene / HoldScene / StrobeBarsScene). Full source
 * is `FULLSCREEN_VERT` + this; there is no shared `include`.
 */
export const FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;

  uniform sampler2D uMap;     // THREE.VideoTexture(djCamSource.video) — raw sRGB
  uniform float uReady;       // 1 once djCamSource.ready — black until then
  uniform vec2  uRes;         // drawing-buffer size, px — cover-fit + grain seed
  uniform float uVideoAspect; // video intrinsic width / height
  uniform float uFade;        // ctx.vis * exitEnv — crossfade weight + own dip
  uniform float uEnergy;      // ctx.b.energy — grain breathes with the level
  uniform float uTime;        // seconds since mount — grain seed animation

  // Grade dials, resolved from the Scene Contract (see the header table).
  uniform float uBarAspect;   // fill       -> 2.39 at neutral
  uniform float uContrast;    // contrast   -> ~1.12 at neutral
  uniform float uVignette;    // shape      -> ~0.30 at neutral
  uniform float uSaturation;  // complexity -> keep-colour factor, ~0.85 at neutral
  uniform float uGrain;       // density    -> ~0.045 at neutral

  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  void main() {
    if (uReady < 0.5) {
      gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }

    float screenAspect = uRes.x / uRes.y;

    // (1) COVER-FIT: fill the frame, crop the overflow, centred on the middle.
    vec2 crop = vec2(1.0);
    if (screenAspect > uVideoAspect) crop.y = uVideoAspect / screenAspect;
    else                             crop.x = screenAspect / uVideoAspect;
    vec2 uv = (vUv - 0.5) * crop + 0.5;

    // sRGB texels -> linear; the composer's GradePass does the final encode, so
    // scenes hand it linear (same rule as maze / truchet).
    vec3 col = pow(texture2D(uMap, uv).rgb, vec3(2.2));

    // (3) gentle contrast lift about linear mid-grey.
    col = (col - ${CONTRAST_PIVOT.toFixed(2)}) * uContrast + ${CONTRAST_PIVOT.toFixed(2)};

    // (4) pull a little saturation (Rec.709 luma weights).
    float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(vec3(luma), col, uSaturation);

    // (5) aspect-corrected radial vignette — stays circular on any display.
    float r = length((vUv - 0.5) * vec2(screenAspect, 1.0));
    col *= 1.0 - uVignette * smoothstep(0.35, 1.15, r);

    // (6) faint grain, mostly on the level with a small always-on floor; the
    // seed shifts every frame but never grows (fract keeps it bounded).
    float g = hash21(vUv * uRes + fract(uTime) * 431.0);
    col += (g - 0.5) * uGrain * (0.35 + 0.9 * uEnergy);

    col = max(col, vec3(0.0));

    // (2) 2.39:1 cinemascope bars, applied last as a mask so the tone ops above
    // cannot lift them off black. visH is the visible height fraction; == 1
    // (no bars) once the dial opens the window past the screen aspect.
    float visH = min(1.0, screenAspect / uBarAspect);
    float edge = 0.5 * visH - abs(vUv.y - 0.5);
    float bar = visH >= 1.0 ? 1.0 : smoothstep(0.0, 1.5 / uRes.y, edge);
    col *= bar;

    // (7) crossfade weight (and this scene's own exit dip), then opaque.
    gl_FragColor = vec4(col * uFade, 1.0);
  }
`

export function DjCamScene() {
  const gl = useThree((s) => s.gl)
  /** Mount-relative seconds — a bounded, monotonic grain clock that does not
   *  care whether the engine clock has rewound on a source change. */
  const elapsed = useRef(0)
  /** 1 while the cutaway is live, ramping to 0 over DJCAM_EXIT_FADE_SEC once
   *  `performanceState.djCam.releasing` goes true — this scene's own "dip to
   *  black" on the way out, since the engine's `dipToBlack` style is disabled. */
  const exitEnv = useRef(1)

  // One VideoTexture per mount, from the SHARED video element. Dispose the
  // texture on unmount — NEVER djCamSource.video, which the stream singleton
  // owns and reuses across every cutaway.
  const texture = useMemo(() => {
    const t = new THREE.VideoTexture(djCamSource.video)
    t.minFilter = THREE.LinearFilter
    t.magFilter = THREE.LinearFilter
    t.generateMipmaps = false
    // Raw values — the shader does the sRGB->linear decode explicitly, the same
    // way KernelPanicScene keeps its atlas untouched.
    t.colorSpace = THREE.NoColorSpace
    return t
  }, [])

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: FULLSCREEN_VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        // Paints every pixel including its own black — replace, not blend, for
        // the same reason HoldScene does. BlendedLayer rewrites the on-screen
        // material's blend to the slot's mode regardless; the hard-cut in and
        // the scene-owned fade out are what keep an opaque scene from ghosting.
        blending: THREE.NoBlending,
        uniforms: {
          uMap: { value: texture },
          uReady: { value: 0 },
          uRes: { value: new THREE.Vector2(1, 1) },
          uVideoAspect: { value: 16 / 9 },
          uFade: { value: 0 },
          uEnergy: { value: 0 },
          uTime: { value: 0 },
          uBarAspect: { value: 2.39 },
          uContrast: { value: 1.12 },
          uVignette: { value: 0.3 },
          uSaturation: { value: 0.85 },
          uGrain: { value: 0.045 },
        },
      }),
    [texture],
  )

  const geometry = useMemo(() => new THREE.PlaneGeometry(2, 2), [])
  // Only this mount's own GPU objects — never djCamSource.video.
  useDispose(texture, material, geometry)

  useSceneFrame(
    ({ vis, b, dt, p, state }) => {
      const u = material.uniforms
      const el = gl.domElement

      elapsed.current += dt

      // Scene-owned exit dip: ramp toward 0 while the director is releasing,
      // recover toward 1 otherwise (covers a re-entered cutaway reusing a
      // mount, though the hard-cut enter normally gives a fresh one). Clamps
      // AT the target, not at 0/1 — clamping at 0 while the target is still 0
      // makes the ramp bounce a step back up every frame and strobe the feed.
      const target = state.djCam.releasing ? 0 : 1
      const step = dt / Math.max(0.05, DJCAM_EXIT_FADE_SEC)
      exitEnv.current =
        target < exitEnv.current
          ? Math.max(target, exitEnv.current - step)
          : Math.min(target, exitEnv.current + step)

      u.uReady.value = djCamSource.ready ? 1 : 0
      // Live drawing-buffer size, read every frame — PerfMonitor moves DPR as
      // the quality tier steps, so a mount-time value goes wrong under load.
      u.uRes.value.set(Math.max(1, el.width), Math.max(1, el.height))

      const v = djCamSource.video
      u.uVideoAspect.value =
        v.videoWidth > 0 && v.videoHeight > 0 ? v.videoWidth / v.videoHeight : 16 / 9

      u.uFade.value = vis * exitEnv.current
      u.uEnergy.value = b.energy
      u.uTime.value = elapsed.current

      // Contract dials, piecewise so the neutral 0.5 lands exactly on the
      // locked cinemascope look rather than an arbitrary point in each range.
      // `ctx.p` sits at NEUTRAL for all seven until the `djcam` SceneDef
      // actually carries the contract, so an un-wired registry still renders
      // the correct locked grade — it just isn't tunable.

      // fill -> letterbox target aspect. Below neutral thickens the bars, above
      // opens the frame until they vanish (visH clamps at 1 in the shader).
      u.uBarAspect.value =
        p.fill < 0.5 ? 2.39 + (0.5 - p.fill) * 1.62 : 2.39 - (p.fill - 0.5) * 1.58

      // contrast -> lift slope about CONTRAST_PIVOT. 0 flat, 0.5 gentle, 1 hard.
      u.uContrast.value =
        p.contrast < 0.5 ? 1.0 + p.contrast * 0.24 : 1.12 + (p.contrast - 0.5) * 0.76

      // shape -> vignette strength. 0 none, 0.5 ~0.30, 1 ~0.75.
      u.uVignette.value = p.shape < 0.5 ? p.shape * 0.6 : 0.3 + (p.shape - 0.5) * 0.9

      // complexity -> desaturation (keep-colour factor). 0 full colour, 0.5
      // ~15% pull, 1 ~60% pull.
      u.uSaturation.value =
        p.complexity < 0.5 ? 1.0 - p.complexity * 0.3 : 0.85 - (p.complexity - 0.5) * 0.9

      // density -> grain amplitude. 0 clean, 0.5 very faint, 1 heavy.
      u.uGrain.value = p.density < 0.5 ? p.density * 0.09 : 0.045 + (p.density - 0.5) * 0.19
    },
    // A director cutaway is not a mood-modulated scene: the crossfade and the
    // exit dip alone govern its brightness, so mood intensity must not dim the
    // feed. With visFloor at 1, `vis` reduces to the raw crossfade weight.
    { visFloor: 1 },
  )

  return (
    <mesh frustumCulled={false}>
      <primitive object={geometry} attach="geometry" />
      <primitive object={material} attach="material" />
    </mesh>
  )
}
