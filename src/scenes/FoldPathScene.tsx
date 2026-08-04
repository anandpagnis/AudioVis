import { useEffect, useMemo, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { FULLSCREEN_VERT } from '../engine/glsl'
import { quality } from '../engine/quality'
import { useSceneFrame } from '../engine/sceneFrame'
import { useDispose } from '../engine/useDispose'

/**
 * Fold Path — a fixed-step heightfield flythrough with a recursive IFS-fold
 * fractal texture, adapted from an unattributed Shadertoy piece (the pasted
 * source carried no author/title comment, unlike the two prior scenes — this
 * name is descriptive, not a reproduced title).
 *
 * Structurally the most unusual scene in the roster: `map()` isn't a real
 * SDF, it's a 2D heightfield h(x,z), and the ray march is FIXED-step
 * (st=.025 for up to 600 iterations) rather than adaptive sphere-tracing —
 * classic heightfield technique: march forward in fixed steps until the ray
 * drops below the surface, then binary-search (bsearch()) to refine the hit.
 * The fractal texture itself is extracted via a global mutable `col`
 * accumulator: every call to map() (during the march, the binary search, AND
 * the 4 finite-difference samples in normal()) has the side effect of adding
 * fractal(p)'s contribution to the global `col`; shade() zeroes it, calls
 * normal() to repopulate it from 4 nearby samples, then averages. This is
 * fragile if the variable shadowing is disturbed (`march()` and `main()`
 * each declare their OWN local `col` that shadows the global one) — ported
 * with that shadowing preserved exactly, not restructured.
 *
 * Camera: unlike InversionMachineScene (which reads the real R3F camera
 * because a raymarched OBJECT genuinely benefits from being orbited), this
 * scene keeps its own scripted path(t) flythrough camera — the flythrough
 * IS the piece's identity, not a neutral viewpoint onto a static subject, so
 * substituting CameraDirector's camera would replace what this scene is
 * rather than just how it's viewed. Same "self-contained camera" call as
 * NetworkConstellationScene, for an analogous reason. path(t)'s traversal
 * speed is audio-driven (bass/energy) instead of raw elapsed time, so the
 * flythrough itself rides the music.
 *
 * Quality governor: this march's absolute step budget (600) is on a totally
 * different scale than shaderLib's adaptive-SDF convention (raymarchSteps
 * tops out at 96) — reusing that value directly here would truncate the
 * march to a tiny fraction of its intended 15-unit range even at the best
 * tier. Instead this scene derives its OWN step cap as the same PROPORTION
 * quality.knobs.raymarchSteps represents of its own max (96), applied to its
 * native 600-step budget — same relative response to load, correct absolute
 * scale. See the component body.
 */

/**
 * Overall brightness multiplier. Measured via the same standalone-WebGL
 * compile+draw technique used for the other two ported scenes this session:
 * 0.35 landed quiet-state mean luma ~11 (fine) but the loud/all-bands-hot
 * state came out ~25, over this project's <20 target. 0.22 holds both a
 * quiet state (~7) and a loud one (~16) under budget with margin. Still a
 * synthetic-state measurement, not a real-audio one.
 */
const BRIGHTNESS = 0.22

export const FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;

  const float U_BRIGHTNESS = ${BRIGHTNESS.toFixed(3)};
  const float MAXDIST = 15.0;

  uniform vec2 uRes;
  uniform float uTime;
  uniform float uSlowTime;
  uniform float uBass;
  uniform float uMid;
  uniform float uHigh;
  uniform float uEnergy;
  uniform float uPulse;
  uniform vec3 uColA;
  uniform vec3 uColB;
  uniform float uFade;
  // Derived from quality.knobs.raymarchSteps as a PROPORTION of this
  // shader's own 600-step native budget (see the file header comment) — not
  // the shared raymarchSteps value directly, which is scaled for a
  // different march style entirely.
  uniform int uMaxSteps;

  float st = 0.025;
  vec3 ldir = vec3(0.0, -1.0, -1.0);
  vec3 col = vec3(0.0);

  mat2 rot(float a) {
    float s = sin(a), c = cos(a);
    return mat2(c, s, -s, c);
  }

  // Bass brightens the glowing fold veins, high raises how many cells glow.
  vec3 fractal(vec2 p) {
    vec2 pos = p;
    float d, ml = 100.0;
    vec2 mc = vec2(100.0);
    p = abs(fract(p * 0.1) - 0.5);
    vec2 c = p;
    for (int i = 0; i < 8; i++) {
      d = dot(p, p);
      p = abs(p + 1.0) - abs(p - 1.0) - p;
      p = p * -1.5 / clamp(d, 0.5, 1.0) - c;
      mc = min(mc, abs(p));
      if (i > 2) ml = min(ml * (1.0 + float(i) * 0.1), abs(p.y - 0.5));
    }
    mc = max(vec2(0.0), 1.0 - mc);
    mc = normalize(mc) * 0.8;
    ml = pow(max(0.0, 1.0 - ml), 6.0);
    float flicker = step(0.7 - uHigh * 0.15, fract(d * 0.1 + uTime * 0.5 + pos.x * 0.2));
    return (vec3(mc, d * 0.4) * ml * flicker - ml * 0.1) * (1.0 + uBass * 0.6);
  }

  // Mid + pulse breathe the two landmark bumps as you fly past them.
  float map(vec2 p) {
    vec2 pos = p;
    float t = uTime;
    col += fractal(p);
    vec2 p2 = abs(0.5 - fract(p * 8.0 + 4.0));
    float h = 0.0;
    h += sin(length(p) + t);
    p = floor(p * 2.0 + 1.0);
    float l = length(p2 * p2);
    h += (cos(p.x + t) + sin(p.y + t)) * 0.5;
    float bump = 1.5 * (1.0 + uMid * 0.8 + uPulse * 0.5);
    h += max(0.0, 5.0 - length(p - vec2(18.0, 0.0))) * bump;
    h += max(0.0, 5.0 - length(p + vec2(18.0, 0.0))) * bump;
    p = p * 2.0 + 0.2345;
    t *= 0.5;
    h += (cos(p.x + t) + sin(p.y + t)) * 0.3;
    return h;
  }

  vec3 normal(vec2 p, float td) {
    vec2 eps = vec2(0.0, 0.001);
    return normalize(vec3(map(p + eps.yx) - map(p - eps.yx), 2.0 * eps.y, map(p + eps.xy) - map(p - eps.xy)));
  }

  vec2 hit(vec3 p) {
    float h = map(p.xz);
    return vec2(step(p.y, h), h);
  }

  vec3 bsearch(vec3 from, vec3 dir, float td) {
    vec3 p;
    st *= -0.5;
    td += st;
    float h2 = 1.0;
    for (int i = 0; i < 20; i++) {
      p = from + td * dir;
      float h = hit(p).x;
      if (abs(h - h2) > 0.001) {
        st *= -0.5;
        h2 = h;
      }
      td += st;
    }
    return p;
  }

  // High sharpens the specular glint, energy lifts overall brightness.
  vec3 shade(vec3 p, vec3 dir, float h, float td) {
    ldir = normalize(ldir);
    col = vec3(0.0);
    vec3 n = normal(p.xz, td);
    col *= 0.25;
    float dif = max(0.0, dot(ldir, -n));
    vec3 ref = reflect(ldir, dir);
    float spe = pow(max(0.0, dot(ref, -n)), 8.0) * (1.0 + uHigh * 1.2);
    return col + (dif * 0.5 + 0.2 * (1.0 + uEnergy * 0.5) + spe * vec3(1.0, 0.8, 0.5)) * 0.2;
  }

  vec3 march(vec3 from, vec3 dir) {
    vec3 p, mcol = vec3(0.0);
    float td = 0.5, k = 0.0;
    vec2 h;
    for (int i = 0; i < 600; i++) {
      if (i >= uMaxSteps) break;
      p = from + dir * td;
      h = hit(p);
      if (h.x > 0.5 || td > MAXDIST) break;
      td += st;
    }
    if (h.x > 0.5) {
      p = bsearch(from, dir, td);
      mcol = shade(p, dir, h.y, td);
    }
    mcol = mix(mcol, 2.0 * vec3(mod(gl_FragCoord.y, 4.0) * 0.1), pow(td / MAXDIST, 3.0));
    return mcol * vec3(0.9, 0.8, 1.0);
  }

  mat3 lookAtDir(vec3 dir, vec3 up) {
    dir = normalize(dir);
    vec3 rt = normalize(cross(dir, normalize(up)));
    return mat3(rt, cross(rt, dir), dir);
  }

  // The flythrough's own trajectory — audio drives HOW FAST it's travelled
  // (see uSlowTime below), not this curve's shape.
  vec3 path(float t) {
    return vec3(cos(t) * 5.5, 1.5 - cos(t) * 0.0, sin(t * 2.0)) * 2.5;
  }

  void main() {
    vec2 uv = vUv - 0.5;
    uv.x *= uRes.x / uRes.y;

    float t = uSlowTime;
    vec3 from = path(t);
    vec3 dir = normalize(vec3(uv, 0.7));
    vec3 adv = path(t + 0.1) - from;
    dir = lookAtDir(adv + vec3(0.0, -0.2 - (1.0 + sin(t * 2.0)), 0.0), vec3(adv.x * 0.1, 1.0, 0.0)) * dir;

    vec3 sceneCol = march(from, dir) * 1.5;
    sceneCol *= 1.0 + uPulse * 0.3;

    vec3 baseCol = mix(uColA, uColB, 0.5 + 0.5 * sin(uSlowTime * 0.6));
    vec3 tinted = sceneCol * mix(vec3(1.0), baseCol, 0.6);
    tinted *= U_BRIGHTNESS;
    tinted *= uFade;

    gl_FragColor = vec4(tinted, 1.0);
  }
`

export function FoldPathScene() {
  const size = useThree((s) => s.size)
  const dpr = useThree((s) => s.viewport.dpr)
  const fastClock = useRef(0)
  const pathClock = useRef(0)

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
          uSlowTime: { value: 0 },
          uBass: { value: 0 },
          uMid: { value: 0 },
          uHigh: { value: 0 },
          uEnergy: { value: 0 },
          uPulse: { value: 0 },
          uColA: { value: new THREE.Color('#33ffc9') },
          uColB: { value: new THREE.Color('#7c4dff') },
          uFade: { value: 0 },
          uMaxSteps: { value: 600 },
        },
      }),
    [],
  )

  const geometry = useMemo(() => new THREE.PlaneGeometry(2, 2), [])

  useDispose(material, geometry)

  useEffect(() => {
    material.uniforms.uRes.value.set(size.width * dpr, size.height * dpr)
  }, [material, size, dpr])

  useSceneFrame(({ dt, b, col, vis, params }) => {
    const u = material.uniforms

    fastClock.current += dt * params.speed
    pathClock.current += dt * (0.2 + b.bass * 0.08 + b.energy * 0.06) * params.speed

    u.uTime.value = fastClock.current
    u.uSlowTime.value = pathClock.current
    u.uBass.value = b.bass
    u.uMid.value = b.mid
    u.uHigh.value = b.high
    u.uEnergy.value = b.energy
    u.uPulse.value = b.pulse
    u.uColA.value.copy(col.a)
    u.uColB.value.copy(col.c)
    u.uFade.value = vis

    // Proportional, not literal, reuse of the governor's raymarchSteps knob
    // — see the file header comment on why this shader's own 600-step
    // native budget can't be driven by that value directly.
    const qualityFraction = quality.knobs.raymarchSteps / 96
    u.uMaxSteps.value = Math.max(60, Math.round(600 * qualityFraction))
  })

  return (
    <mesh frustumCulled={false}>
      <primitive object={geometry} attach="geometry" />
      <primitive object={material} attach="material" />
    </mesh>
  )
}
