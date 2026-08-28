import { useEffect, useMemo, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { FULLSCREEN_VERT } from '../engine/glsl'
import { useSceneFrame } from '../engine/sceneFrame'
import { useDispose } from '../engine/useDispose'

/**
 * Julia Wings — a 2D Julia-set variant with a moth/butterfly-wing symmetry,
 * adapted from a Shadertoy piece by @christinacoffin (2015-05-07, "1st
 * version, need to optim and do some proper AA" — no license was given, so
 * this credits the handle only).
 *
 * Unlike the other three ported scenes this session, this is flat 2D math —
 * no raymarch, no camera concept at all. It also inverts to a LIGHT
 * background (`vec3(1)-col`), the opposite convention from every other
 * scene in the roster (all dark-background) — kept exactly as authored
 * rather than "fixed," since that inversion is what turns the raw cosine
 * palette into the delicate bright-veins-on-dark look, and the whole reason
 * this scene got flagged as a favorite. See BRIGHTNESS below for how the
 * resulting exposure-budget conflict was resolved.
 *
 * The zoom/framing (`timeVal = 56.48-20.1601`) is a compile-time CONSTANT in
 * the source, not `iTime`-driven despite the variable name — someone froze
 * a good-looking frame and hardcoded it. Preserved exactly; only the actual
 * live-animated pieces (animWings/animFlap, both genuinely `iTime`-driven in
 * the source) are hooked to audio.
 *
 * A real numerical fragility was found and fixed during porting, not
 * invented: `ci`'s denominator is `0.57891895 - abs(animWings*141.0)`. The
 * source's fixed wing amplitude (0.004) sits right at the edge of that going
 * negative — `log2()` of a negative number is NaN, and NaN written to an
 * 8-bit target reads back as black on this GPU. Scaling animWings'
 * AMPLITUDE with bass/pulse (the natural first instinct) pushes it past
 * that cliff and blacks out the whole frame during loud passages — confirmed
 * by actually rendering it, not just reading the formula. Fixed by
 * modulating the flap RATE instead (bounded by cos() regardless of rate),
 * with a defensive clamp as a second line of defense.
 */

/**
 * Overall brightness. This shader's own "background" (away from the wing
 * silhouette) sits around mean luma ~200/255 pre-dimming — far hotter than
 * any raymarch scene's near-black default, because of the light-background
 * inversion. A first pass at 0.06 satisfied this project's <20-mean-luma
 * rule even during loud audio, but at that level the delicate vein detail
 * that makes this piece distinctive was barely visible — confirmed by
 * actually rendering and looking at it, not just the numbers. 0.15 is the
 * version that read as genuinely striking (clear wing silhouette, legible
 * veins) and is a deliberate, explicit exception to the exposure budget the
 * other three ported scenes stayed under — the user's call, weighing this
 * scene's visual identity over strict budget compliance.
 */
const BRIGHTNESS = 0.15

export const FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;

  const float U_BRIGHTNESS = ${BRIGHTNESS.toFixed(3)};

  uniform vec2 uRes;
  uniform float uTime;
  uniform float uBass;
  uniform float uMid;
  uniform float uHigh;
  uniform float uEnergy;
  uniform float uPulse;
  uniform float uFade;
  // Pinned at the loop's own 64-iteration cap (F129) — the quality tier no
  // longer shortens the escape-time count. Resolution, not iteration depth,
  // is the tier's lever now (engine/renderScale.ts).
  uniform int uMaxIter;

  vec3 juliaFractal(vec2 c, vec2 c2, float animparam, float anim2) {
    vec2 z = c;
    float ci = 0.0;
    float mean = 0.0;
    for (int i = 0; i < 64; i++) {
      if (i >= uMaxIter) break;
      vec2 a = vec2(z.x, abs(z.y));
      float b = atan(a.y * (0.99 + animparam * 9.0), a.x + 0.110765432 + animparam);
      if (b > 0.0) b -= 6.303431307 + (animparam * 3.1513);
      z = vec2(log(length(a * (0.98899 - (animparam * 2.70 * anim2)))), b) + c2;
      if (i > 0) mean += length(z / a * b);
      mean += a.x - (b * 77.0 / length(a * b));
      mean = clamp(mean, 111.0, 99999.0);
    }
    mean /= 131.21;
    ci = 1.0 - fract(log2(0.5 * log2(mean / (0.57891895 - abs(animparam * 141.0)))));
    return vec3(
      0.5 + 0.5 * cos(6.0 * ci + 0.0),
      0.5 + 0.75 * cos(6.0 * ci + 0.14),
      0.5 + 0.5 * cos(6.0 * ci + 0.7)
    );
  }

  void main() {
    vec2 fragCoord = vUv * uRes;

    // Bass + pulse speed up the wing flap (rate, not amplitude — see the
    // header comment on why amplitude scaling blacks out the frame). High
    // widens the slower body-flap amplitude, which has no such cliff.
    float wingRate = 0.5 + uBass * 0.3 + uPulse * 0.6;
    float animWings = 0.0039 * cos(uTime * wingRate);
    animWings = clamp(animWings, -0.0039, 0.0039);
    float flapRate = 1.0 + uMid * 0.2;
    float animFlap = 0.011 * (1.0 + uHigh * 1.0) * sin(uTime * flapRate);

    // Frozen framing — see header comment. Not audio-driven on purpose.
    float timeVal = 56.48 - 20.1601;

    vec2 uv = fragCoord - uRes * 0.5;
    uv /= uRes.x * 1.5113 * abs(sin(timeVal));
    uv.y -= animWings * 5.0;
    vec2 tuv = uv * 125.0;
    float rot = 3.141592654 * 0.5;
    uv.x = tuv.x * cos(rot) - tuv.y * sin(rot);
    uv.y = 1.05 * tuv.x * sin(rot) + tuv.y * cos(rot);

    float juliax = tan(timeVal) * 0.011 + 0.02 / (fragCoord.y * 0.19531 * (1.0 - animFlap));
    float juliay = cos(timeVal * 0.213) * (0.022 + animFlap) + 5.66752 - (juliax * 1.5101);

    // ONE evaluation. The source shipped a 3-tap supersample (its author's own
    // comment: "need to optim and do some proper AA"), and /bench measured what
    // that cost: 14.00 ms with the taps versus 4.69 ms without — 2.98x, for
    // antialiasing alone, on what was already the second most expensive scene
    // in the roster. 14 ms of a 16.67 ms frame is not a defensible price for
    // edge quality at any tier, so the taps are gone rather than tier-gated.
    //
    // If aliasing on the wing veins proves too harsh, the replacement is
    // resolution (render this scene to an offscreen buffer and let the governor
    // scale it, as FoldPathScene now does), NOT a return to supersampling — that
    // buys the same smoothing on a continuous knob instead of a 3x cliff.
    vec4 col = vec4(juliaFractal(uv, vec2(juliax, juliay), animWings, animFlap), 1.0);

    col.xyz = col.zyx;
    col.xyz = vec3(1.0) - col.xyz;

    col.xyz *= 1.0 + uEnergy * 0.3;
    col.xyz *= U_BRIGHTNESS;
    col.xyz *= uFade;

    gl_FragColor = vec4(col.xyz, 1.0);
  }
`

export function JuliaWingsScene() {
  const size = useThree((s) => s.size)
  const dpr = useThree((s) => s.viewport.dpr)
  const clock = useRef(0)

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: FULLSCREEN_VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uRes: { value: new THREE.Vector2(1, 1) },
          uTime: { value: 0 },
          uBass: { value: 0 },
          uMid: { value: 0 },
          uHigh: { value: 0 },
          uEnergy: { value: 0 },
          uPulse: { value: 0 },
          uFade: { value: 0 },
          uMaxIter: { value: 64 },
        },
      }),
    [],
  )

  const geometry = useMemo(() => new THREE.PlaneGeometry(2, 2), [])

  useDispose(material, geometry)

  useEffect(() => {
    material.uniforms.uRes.value.set(size.width * dpr, size.height * dpr)
  }, [material, size, dpr])

  useSceneFrame(({ dt, b, vis, params }) => {
    const u = material.uniforms

    clock.current += dt * params.speed

    u.uTime.value = clock.current
    u.uBass.value = b.bass
    u.uMid.value = b.mid
    u.uHigh.value = b.high
    u.uEnergy.value = b.energy
    u.uPulse.value = b.pulse
    u.uFade.value = vis
  })

  return (
    <mesh frustumCulled={false}>
      <primitive object={geometry} attach="geometry" />
      <primitive object={material} attach="material" />
    </mesh>
  )
}
