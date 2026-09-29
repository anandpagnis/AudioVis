import { useMemo, useRef } from 'react'
import * as THREE from 'three'
import { DJCAM_EXIT_FADE_SEC } from '../engine/DjCamDirector'
import { djCamSource } from '../engine/djCamSource'
import { FULLSCREEN_VERT } from '../engine/glsl'
import { useSceneFrame } from '../engine/sceneFrame'
import { useDispose } from '../engine/useDispose'
import { useViewportResolution } from '../engine/viewportResolution'

/**
 * DJ Cam — the director's cutaway to a live camera of the DJ. A clean feed,
 * deliberately: no baked-in grade. Specific looks (filters, etc.) are a
 * separate, later addition — layered on top through the show's own filter
 * system rather than hand-tuned into this scene's shader.
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
 * ghost-free because there is nothing left of the feed to bleed through.
 *
 * ## The fragment shader
 *
 * Two things only:
 *
 *  1. COVER-FIT — the feed fills the frame with the overflow cropped, from the
 *     video's intrinsic aspect against the drawing buffer's. A squeezed camera
 *     image is the one thing this must not do.
 *  2. `uFade` — the crossfade weight (`ctx.vis`) times this scene's own
 *     `exitEnv`, then opaque `vec4(col * uFade, 1.0)`.
 *
 * Raw texels are sRGB; the composer's GradePass encodes the final frame, so
 * this hands it LINEAR — the same rule maze/truchet document. The `pow(x, 2.2)`
 * decode on sample is an approximation, which is all this needs.
 *
 * ## No `pixelBudget`
 *
 * A `VideoTexture` fullscreen blit is sub-millisecond, and downscaling a camera
 * feed then upscaling it just softens a photographic image for nothing. Full
 * drawing-buffer resolution, direct path. `performanceCost: 'low'`,
 * `fillBound: false`.
 */

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
  uniform vec2  uRes;         // target size, px — cover-fit only
  uniform float uVideoAspect; // video intrinsic width / height
  uniform float uFade;        // ctx.vis * exitEnv — crossfade weight + own dip

  void main() {
    if (uReady < 0.5) {
      gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }

    float screenAspect = uRes.x / uRes.y;

    // COVER-FIT: fill the frame, crop the overflow, centred on the middle.
    vec2 crop = vec2(1.0);
    if (screenAspect > uVideoAspect) crop.y = uVideoAspect / screenAspect;
    else                             crop.x = screenAspect / uVideoAspect;
    vec2 uv = (vUv - 0.5) * crop + 0.5;

    // sRGB texels -> linear; the composer's GradePass does the final encode, so
    // scenes hand it linear (same rule as maze / truchet).
    vec3 col = pow(texture2D(uMap, uv).rgb, vec3(2.2));

    // Crossfade weight (and this scene's own exit dip), then opaque.
    gl_FragColor = vec4(col * uFade, 1.0);
  }
`

export function DjCamScene() {
  const mesh = useRef<THREE.Mesh>(null)
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
    // Raw values — the shader does the sRGB->linear decode explicitly.
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
        },
      }),
    [texture],
  )

  const geometry = useMemo(() => new THREE.PlaneGeometry(2, 2), [])
  // Only this mount's own GPU objects — never djCamSource.video.
  useDispose(texture, material, geometry)

  // Cover-fit against the target each draw lands in (viewportResolution.ts),
  // not the canvas, which has not been the frame since F272 stage 5.
  useViewportResolution(mesh, material)

  useSceneFrame(
    ({ vis, dt, state }) => {
      const u = material.uniforms

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

      const v = djCamSource.video
      u.uVideoAspect.value =
        v.videoWidth > 0 && v.videoHeight > 0 ? v.videoWidth / v.videoHeight : 16 / 9

      u.uFade.value = vis * exitEnv.current
    },
    // A director cutaway is not a mood-modulated scene: the crossfade and the
    // exit dip alone govern its brightness, so mood intensity must not dim the
    // feed. With visFloor at 1, `vis` reduces to the raw crossfade weight.
    { visFloor: 1 },
  )

  return (
    <mesh ref={mesh} frustumCulled={false}>
      <primitive object={geometry} attach="geometry" />
      <primitive object={material} attach="material" />
    </mesh>
  )
}
