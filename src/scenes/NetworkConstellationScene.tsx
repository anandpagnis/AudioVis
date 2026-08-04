import { useEffect, useMemo, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { FULLSCREEN_VERT } from '../engine/glsl'
import { useSceneFrame } from '../engine/sceneFrame'
import { useDispose } from '../engine/useDispose'

/**
 * Network Constellation — a living web of jittered, sparkling nodes, adapted
 * from "The Universe Within" (Martijn Steinrucken / BigWings, Shadertoy,
 * CC BY-NC-SA 3.0). Originally a hashed-grid procedural network with layered
 * parallax; ported here from a screen-space Shadertoy pass into a fullscreen
 * quad scene, replacing the previous CPU-side O(n^2) particle-link version
 * (see git history) with a GPU-only technique that also happens to be
 * substantially cheaper per frame.
 *
 * Three Shadertoy-specific pieces don't carry over and are replaced:
 *   - `iChannel0` FFT texel fetch -> real audio band uniforms (no texture).
 *   - `iMouse` parallax -> a slow autonomous drift (uSlowTime), nudged by
 *     energy/mid so it never sits dead still. An earlier version of this
 *     scene tried driving the field from the real camera instead (orbit
 *     angle -> rotation, height -> pan), but that made the network's motion
 *     read as camera movement rather than a response to the music — removed
 *     in favour of making the NODES themselves audio-reactive.
 *   - The 230s Shadertoy demo-loop fade -> the standard `vis` (SceneFade x
 *     mood intensity) multiplier every scene uses.
 *
 * Colour also moves from the original's independent trig-cycled RGB to the
 * blended palette (col.a/col.b), matching every other scene's identity
 * rather than inventing its own colour cycle.
 *
 * Node reactivity (the "little dot lights"): bass+energy widen each node's
 * jitter orbit (GetPos's amp param) so the whole web visibly breathes with
 * the music, high drives sparkle intensity, and pulse gives every node a
 * discrete flash on the beat — on top of mid driving connection brightness.
 */

/**
 * Overall brightness multiplier. The source shader renders full-frame,
 * additive, with no black negative space — exactly the "hot everywhere"
 * failure mode docs/09_Rendering_Engine.md documents (39% blown to white
 * before the exposure pivot). This scene is primary-capable now, so it has
 * to fit the same <=15%-lit / mean-luma-<20 / 0%-blown budget every other
 * primary does. This value is a conservative STARTING point, not a measured
 * one — verify against real audio (never an idle frame) and retune here.
 */
const BRIGHTNESS = 0.5

export const FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;

  // Starting-point gain, not a measured one — see the BRIGHTNESS comment above.
  const float U_BRIGHTNESS = ${BRIGHTNESS.toFixed(3)};

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

  #define S(a, b, t) smoothstep(a, b, t)
  const float NUM_LAYERS = 4.0;

  float N21(vec2 p) {
    vec3 a = fract(vec3(p.xyx) * vec3(213.897, 653.453, 253.098));
    a += dot(a, a.yzx + 79.76);
    return fract((a.x + a.y) * a.z);
  }

  // amp is the node's jitter-orbit radius — bass+energy widen it, so the
  // whole web visibly breathes with the music instead of jittering at a
  // fixed size regardless of what's playing.
  vec2 GetPos(vec2 id, vec2 offs, float t, float amp) {
    float n = N21(id + offs);
    float n1 = fract(n * 10.0);
    float n2 = fract(n * 100.0);
    float a = t + n;
    return offs + vec2(sin(a * n1), cos(a * n2)) * amp;
  }

  float df_line(in vec2 a, in vec2 b, in vec2 p) {
    vec2 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    return length(pa - ba * h);
  }

  float line(vec2 a, vec2 b, vec2 uv) {
    float r1 = 0.04;
    float r2 = 0.01;

    float d = df_line(a, b, uv);
    float d2 = length(a - b);
    float fade = S(1.5, 0.5, d2);

    fade += S(0.05, 0.02, abs(d2 - 0.75));
    return S(r1, r2, d) * fade;
  }

  // Mid drives connection brightness, high drives sparkle intensity, pulse
  // gives a discrete beat-synced kick on top of both — distinct band jobs
  // per docs/05_Scene_Architecture.md's binding discipline.
  float NetLayer(vec2 st, float n, float t) {
    vec2 id = floor(st) + n;
    st = fract(st) - 0.5;

    // GLSL ES 1.00 only allows a constant or the loop's own control variable
    // as an array index — the source shader's manual int i=0; ...; p[i++]=...
    // inside a nested loop is neither, and fails to compile (confirmed via a
    // standalone WebGL1 compile check). Unrolled into 9 explicit constant
    // indices instead; same 3x3 neighborhood, same iteration order (outer y,
    // inner x), so p[4] is still the center node the rest of the function
    // treats as "self".
    float amp = 0.4 + uBass * 0.35 + uEnergy * 0.25;
    vec2 p[9];
    p[0] = GetPos(id, vec2(-1.0, -1.0), t, amp);
    p[1] = GetPos(id, vec2(0.0, -1.0), t, amp);
    p[2] = GetPos(id, vec2(1.0, -1.0), t, amp);
    p[3] = GetPos(id, vec2(-1.0, 0.0), t, amp);
    p[4] = GetPos(id, vec2(0.0, 0.0), t, amp);
    p[5] = GetPos(id, vec2(1.0, 0.0), t, amp);
    p[6] = GetPos(id, vec2(-1.0, 1.0), t, amp);
    p[7] = GetPos(id, vec2(0.0, 1.0), t, amp);
    p[8] = GetPos(id, vec2(1.0, 1.0), t, amp);

    float m = 0.0;
    float sparkle = 0.0;

    for (int i = 0; i < 9; i++) {
      m += line(p[4], p[i], st);

      float d = length(st - p[i]);

      float s = (0.005 / (d * d));
      s *= S(1.0, 0.7, d);
      float pulse = sin((fract(p[i].x) + fract(p[i].y) + t) * 5.0) * 0.4 + 0.6;
      pulse = pow(pulse, 20.0);

      s *= pulse;
      sparkle += s;
    }

    m += line(p[1], p[3], st);
    m += line(p[1], p[5], st);
    m += line(p[7], p[5], st);
    m += line(p[7], p[3], st);
    m *= 1.0 + uMid * 0.4 + uPulse * 0.5;

    float sPhase = (sin(t + n) + sin(t * 0.1)) * 0.25 + 0.5;
    sPhase += pow(sin(t * 0.1) * 0.5 + 0.5, 50.0) * 5.0;
    // High is the continuous sparkle-intensity job, pulse is a discrete
    // per-node flash exactly on the beat — distinct jobs, same as m's
    // mid/pulse split above.
    sparkle *= (1.0 + uHigh * 1.5) * (1.0 + uPulse * 1.2);
    m += sparkle * sPhase;

    return m;
  }

  void main() {
    vec2 uv = (vUv - 0.5) * vec2(uRes.x / uRes.y, 1.0);

    // Autonomous slow rotation, replacing the source shader's iMouse (no
    // pointer in this app) and no longer coupled to the camera — the field's
    // motion should read as a response to the music, not to CameraDirector.
    float s = sin(uSlowTime);
    float c = cos(uSlowTime);
    mat2 rot = mat2(c, -s, s, c);
    vec2 st = uv * rot;
    vec2 M = vec2(sin(uSlowTime * 0.5), cos(uSlowTime * 0.37)) * (0.15 + 0.1 * uEnergy);
    M *= rot * 2.0;

    float m = 0.0;
    for (float i = 0.0; i < 1.0; i += 1.0 / NUM_LAYERS) {
      float z = fract(uSlowTime + i);
      float size = mix(15.0, 1.0, z);
      float fade = S(0.0, 0.6, z) * S(1.0, 0.8, z);

      m += fade * NetLayer(st * size - M * z, i, uTime);
    }

    float glow = -uv.y * uBass * 2.0;

    vec3 baseCol = mix(uColA, uColB, 0.5 + 0.5 * sin(uSlowTime));
    vec3 col = baseCol * m;
    col += baseCol * glow;

    col *= 1.0 - dot(uv, uv);
    col *= 1.0 + uEnergy * 0.3;
    col *= U_BRIGHTNESS;
    col *= uFade;

    // Alpha is irrelevant under additive blending (matches every other
    // additive scene in the roster, e.g. DissolveCageScene's FRAG) — the
    // colour channel already carries uFade, so hardcode it.
    gl_FragColor = vec4(col, 1.0);
  }
`

export function NetworkConstellationScene() {
  const size = useThree((s) => s.size)
  const dpr = useThree((s) => s.viewport.dpr)
  const slowClock = useRef(0)

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
          uColA: { value: new THREE.Color('#00e5ff') },
          uColB: { value: new THREE.Color('#7c4dff') },
          uFade: { value: 0 },
        },
      }),
    [],
  )

  const geometry = useMemo(() => new THREE.PlaneGeometry(2, 2), [])

  useDispose(material, geometry)

  useEffect(() => {
    material.uniforms.uRes.value.set(size.width * dpr, size.height * dpr)
  }, [material, size, dpr])

  useSceneFrame(({ f, dt, b, col, vis, params }) => {
    const u = material.uniforms

    slowClock.current += dt * (0.1 + b.energy * 0.06 + b.mid * 0.04) * params.speed

    u.uTime.value = f.time
    u.uSlowTime.value = slowClock.current
    u.uBass.value = b.bass
    u.uMid.value = b.mid
    u.uHigh.value = b.high
    u.uEnergy.value = b.energy
    u.uPulse.value = b.pulse
    u.uColA.value.copy(col.a)
    u.uColB.value.copy(col.c)
    u.uFade.value = vis
  })

  return (
    <mesh frustumCulled={false}>
      <primitive object={geometry} attach="geometry" />
      <primitive object={material} attach="material" />
    </mesh>
  )
}
