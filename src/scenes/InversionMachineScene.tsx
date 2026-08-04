import { useEffect, useMemo, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { FULLSCREEN_VERT } from '../engine/glsl'
import { quality, applyQualityUniforms } from '../engine/quality'
import { useSceneFrame } from '../engine/sceneFrame'
import { useDispose } from '../engine/useDispose'

/**
 * Inversion Machine — a raymarched sphere-inversion fractal ("Kali tiling"),
 * adapted from "The Inversion Machine" by Kali (Shadertoy). The first true
 * raymarched-SDF scene in the live roster (`src/engine/shaderLib.ts`'s
 * RAYMARCH_GLSL/SDF_GLSL chunks exist but nothing currently uses them — this
 * scene doesn't either, since its distance estimator (de()) is a bespoke
 * sphere-inversion fold rather than a composition of the shared primitives,
 * and its march loop carries extra per-step glow accumulation the shared
 * raymarch() doesn't support). It does reuse the quality governor's uMaxSteps
 * convention (see below), the one piece that generalizes.
 *
 * Unlike NetworkConstellationScene (a flat screen-space effect where an
 * earlier attempt at camera-coupling was removed in favour of pure audio
 * reactivity — see that file's history), this is a genuine 3D raymarcher:
 * SceneFrame threads a read-only `camera` in specifically so fullscreen
 * raymarch scenes can build real rays and stay drivable by CameraDirector
 * (see sceneFrame.ts's SceneFrame.camera doc comment) — this is that
 * intended use. So the split here is: VIEWPOINT (ray origin + basis) comes
 * from the real camera, but the fractal's own animation (fold wiggle, roll,
 * scale breathing) stays audio+autonomous-clock driven, same as every other
 * scene's content — CameraDirector controls where you're looking from, not
 * what the music does to the subject.
 *
 * Two Shadertoy-specific pieces don't carry over:
 *   - The two demo-loop fades (`mix(col, .5+ra+ral*.5, max(0,3-iTime)/3)` on
 *     entry, `*clamp(60.-iTime,0.,1.)` on exit) — Shadertoy's own loop
 *     intro/outro, not a real effect. Replaced by the standard `vis` (uFade)
 *     multiplier every scene uses.
 *   - The output was monochrome (`fragColor = vec4(col)`, a scalar broadcast
 *     to all channels). Tinted through the blended palette instead, matching
 *     every other scene's identity.
 *
 * The grain/glitch terms (ra/rab/rac/ral) are kept — this project's own
 * VISION doc explicitly wants "filmic degradation... at brutal contrast" as
 * a non-negotiable, and this shader's noise-driven glitch happens to fit
 * that brief unusually well. The glitch branch (originally gated on a
 * time-random threshold) is nudged by transient so a hit in the music can
 * visibly trigger it, instead of firing on a purely arbitrary schedule.
 */

/**
 * Overall brightness multiplier. Measured, not guessed: a standalone WebGL
 * compile+draw check (same technique used for the compile-error checks
 * elsewhere in this scene's history) rendered this exact shader at several
 * brightness candidates and read back real pixel data. The first guess
 * (0.75) came out at mean luma ~30-36 — well past this project's <20 target
 * (docs/09_Rendering_Engine.md). 0.25 landed at mean luma ~10-12 with max
 * luma ~70-80 (nowhere near the 255 blowout ceiling) across both a quiet and
 * a loud synthetic audio state. This is still a synthetic-state measurement,
 * not a real-audio one — the project's own rule is calibrate against real
 * audio, never an idle frame — but it is a measured starting point, not a
 * blind guess.
 */
const BRIGHTNESS = 0.25

export const FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;

  const float U_BRIGHTNESS = ${BRIGHTNESS.toFixed(3)};
  const float WIDTH = 0.22;
  const float DETAIL = 0.002;
  const vec3 LIGHT_DIR = vec3(0.2, 0.5, 1.0);

  uniform vec2 uRes;
  uniform vec3 uRayOrigin;
  uniform vec3 uForward;
  uniform vec3 uRight;
  uniform vec3 uUp;
  uniform float uTime;
  uniform float uSlowTime;
  uniform float uScale;
  uniform float uBass;
  uniform float uMid;
  uniform float uHigh;
  uniform float uEnergy;
  uniform float uPulse;
  uniform float uTransient;
  uniform vec3 uColA;
  uniform vec3 uColB;
  uniform float uFade;
  // Max march iterations, capped by the quality governor — same convention
  // as RAYMARCH_GLSL in shaderLib.ts (uMaxSteps early-break), applied here
  // via applyQualityUniforms() even though the march loop itself is bespoke.
  uniform int uMaxSteps;

  float rand(vec2 co) {
    return fract(sin(dot(co.xy, vec2(12.9898, 78.233))) * 43758.5453);
  }

  // Bass widens the fold's micro-wiggle amplitude, mid/pulse breathe the
  // fold scale (via uScale) — the fractal visibly shudders and tucks with
  // the music instead of animating on a fixed schedule.
  float de(vec3 p) {
    float t = uTime;
    float dotp = dot(p, p);
    p.x += sin(t * 40.0) * (0.007 + uBass * 0.02);
    p = p / dotp * uScale;
    p = sin(p + vec3(sin(1.0 + t) * 2.0, -t, -t * 2.0));
    float d = length(p.yz) - WIDTH;
    d = min(d, length(p.xz) - WIDTH);
    d = min(d, length(p.xy) - WIDTH);
    d = min(d, length(p * p * p) - WIDTH * 0.3);
    return d * dotp / uScale;
  }

  vec3 calcNormal(vec3 p) {
    vec3 e = vec3(0.0, DETAIL, 0.0);
    return normalize(vec3(
      de(p + e.yxx) - de(p - e.yxx),
      de(p + e.xyx) - de(p - e.xyx),
      de(p + e.xxy) - de(p - e.xxy)
    ));
  }

  // High is the specular-intensity job — glinting edges sharpen with the hats.
  float lightAt(vec3 p, vec3 dir) {
    vec3 ldir = normalize(LIGHT_DIR);
    vec3 n = calcNormal(p);
    float diff = max(0.0, dot(ldir, -n)) + 0.1 * max(0.0, dot(normalize(dir), -n));
    vec3 r = reflect(ldir, n);
    float spec = max(0.0, dot(dir, -r));
    return diff + pow(spec, 20.0) * (0.7 + uHigh * 1.0);
  }

  float raymarch(in vec3 from, in vec3 dir, in vec2 uv) {
    float st = 0.0;
    float totdist = 0.0;
    float d = 0.0;
    vec3 p = from;
    float ra = rand(uv.xy * uTime) - 0.5;
    float ras = max(0.0, sign(-0.5 + rand(vec2(1.3456, 0.3573) * floor(30.0 + uTime * 20.0))));
    float rab = rand(vec2(1.2439, 2.3453) * floor(10.0 + uTime * 40.0)) * ras;
    float rac = rand(vec2(1.1347, 1.0331) * floor(40.0 + uTime));
    float ral = rand(1.0 + floor(uv.yy * 300.0) * uTime) - 0.5;

    for (int i = 0; i < 60; i++) {
      if (i >= uMaxSteps) break;
      p = from + totdist * dir;
      d = de(p);
      if (d < DETAIL || totdist > 2.0) break;
      totdist += d;
      st += max(0.0, 0.04 - d);
    }

    float backg = 0.45 * pow(1.5 - min(1.0, length(uv + vec2(0.0, -0.6))), 1.5);
    float col;
    if (d < DETAIL) {
      col = lightAt(p - DETAIL * dir, dir);
    } else {
      col = backg;
    }
    col += smoothstep(0.0, 1.0, st) * 0.8 * (0.1 + rab);
    col += pow(max(0.0, 1.0 - length(p)), 8.0) * (0.5 + 10.0 * rab) * (1.0 + uEnergy * 0.8);
    col += pow(max(0.0, 1.0 - length(p)), 30.0) * 50.0 * (1.0 + uPulse * 0.6);
    col = mix(col, backg, 1.0 - exp(-0.25 * pow(totdist, 3.0)));
    // Glitch branch nudged by transient: a sharp hit can visibly tear the
    // frame instead of firing on a purely time-random schedule.
    if (rac > 0.7 - uTransient * 0.4) {
      col = col * 0.7 + (0.3 + ra + ral * 0.5) * mod(uv.y + uTime * 2.0, 0.25);
    }
    return col + ra * 0.03 + (ral * 0.1 + ra * 0.1) * rab;
  }

  void main() {
    vec2 uv = (vUv - 0.5) * 2.0;
    uv.x *= uRes.x / uRes.y;

    // Autonomous roll — a decorative spin of the view axis, same "content
    // motion stays audio/autonomous, not camera" principle as
    // NetworkConstellationScene. It rolls the RAY, not the fractal field, so
    // it reads as a slow Dutch-angle drift rather than the subject turning.
    float s = sin(uSlowTime);
    float c = cos(uSlowTime);
    mat2 rot = mat2(c, s, -s, c);
    vec2 ruv = uv * rot;

    vec3 dir = normalize(uForward + ruv.x * uRight + ruv.y * uUp);
    float col = raymarch(uRayOrigin, dir, uv);
    col = pow(max(col, 0.0), 1.25);

    vec3 baseCol = mix(uColA, uColB, 0.5 + 0.5 * sin(uSlowTime * 0.7));
    vec3 tinted = col * baseCol;
    tinted *= U_BRIGHTNESS;
    tinted *= uFade;

    gl_FragColor = vec4(tinted, 1.0);
  }
`

/** Original camera sat ~1.2 units from the origin (`from=vec3(0,.1,-1.2)`) —
 *  the fractal's own coordinate scale is small, so this anchor stays close
 *  rather than using the 8-17 range other (unit-sphere-scale) scenes use. */
const ANCHOR_DISTANCE = 1.4
const ANCHOR_HEIGHT = 0.15

export function InversionMachineScene() {
  const size = useThree((s) => s.size)
  const dpr = useThree((s) => s.viewport.dpr)
  const fastClock = useRef(0)
  const slowClock = useRef(0)
  const rightVec = useRef(new THREE.Vector3())
  const upVec = useRef(new THREE.Vector3())
  const forwardVec = useRef(new THREE.Vector3())

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
          uRayOrigin: { value: new THREE.Vector3(0, ANCHOR_HEIGHT, -ANCHOR_DISTANCE) },
          uForward: { value: new THREE.Vector3(0, 0, 1) },
          uRight: { value: new THREE.Vector3(1, 0, 0) },
          uUp: { value: new THREE.Vector3(0, 1, 0) },
          uTime: { value: 0 },
          uSlowTime: { value: 0 },
          uScale: { value: 4.0 },
          uBass: { value: 0 },
          uMid: { value: 0 },
          uHigh: { value: 0 },
          uEnergy: { value: 0 },
          uPulse: { value: 0 },
          uTransient: { value: 0 },
          uColA: { value: new THREE.Color('#ff5c33') },
          uColB: { value: new THREE.Color('#7c4dff') },
          uFade: { value: 0 },
          uMaxSteps: { value: quality.knobs.raymarchSteps },
        },
      }),
    [],
  )

  const geometry = useMemo(() => new THREE.PlaneGeometry(2, 2), [])

  useDispose(material, geometry)

  useEffect(() => {
    material.uniforms.uRes.value.set(size.width * dpr, size.height * dpr)
  }, [material, size, dpr])

  useSceneFrame(({ dt, b, col, vis, params, camera }) => {
    const u = material.uniforms

    fastClock.current += dt * params.speed
    slowClock.current += dt * (0.2 + b.mid * 0.08 + b.energy * 0.04) * params.speed

    // Viewpoint from the real camera: CameraDirector's chosen mode/anchor
    // genuinely moves where this scene is looked from, same as any
    // geometry-based scene. Basis vectors read straight off matrixWorld
    // rather than via getWorldDirection() etc. — one allocation-free path,
    // reused every frame through the same Vector3 refs.
    const m = camera.matrixWorld.elements
    rightVec.current.set(m[0], m[1], m[2])
    upVec.current.set(m[4], m[5], m[6])
    forwardVec.current.set(-m[8], -m[9], -m[10])

    u.uRayOrigin.value.copy(camera.position)
    u.uForward.value.copy(forwardVec.current)
    u.uRight.value.copy(rightVec.current)
    u.uUp.value.copy(upVec.current)

    u.uTime.value = fastClock.current
    u.uSlowTime.value = slowClock.current
    u.uScale.value = 4.0 + b.mid * 0.4 - b.pulse * 0.15
    u.uBass.value = b.bass
    u.uMid.value = b.mid
    u.uHigh.value = b.high
    u.uEnergy.value = b.energy
    u.uPulse.value = b.pulse
    u.uTransient.value = b.transient
    u.uColA.value.copy(col.a)
    u.uColB.value.copy(col.c)
    u.uFade.value = vis

    applyQualityUniforms(u)
  })

  return (
    <mesh frustumCulled={false}>
      <primitive object={geometry} attach="geometry" />
      <primitive object={material} attach="material" />
    </mesh>
  )
}
