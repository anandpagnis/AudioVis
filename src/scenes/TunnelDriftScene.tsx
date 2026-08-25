import { useEffect, useMemo, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { FULLSCREEN_VERT } from '../engine/glsl'
import { quality } from '../engine/quality'
import { useSceneFrame } from '../engine/sceneFrame'
import { bipolar, drastic } from './contract'
import { useDispose } from '../engine/useDispose'

/**
 * Tunnel Drift — a raymarched flythrough down a winding, glowing tunnel.
 * Hypnotic and driving rather than violent: constant forward motion, long
 * lazy turns, and a rhythmic glow banding the walls.
 *
 * Ported from https://www.shadertoy.com/view/MfVfz3 (no author or licence was
 * given on the source, so this credits the URL only). `stepNoise` is noted in
 * the original as coming from a Kamoshika shader.
 *
 * ## Two structural changes that were required, not stylistic
 *
 * 1. **Loop form.** The source uses `for(;i++<99.;)` and `for(float j=0.;j++<4.;)`.
 *    GLSL ES 1.00 — the Three.js `ShaderMaterial` default this project targets —
 *    requires constant loop bounds, so both are rewritten to `int` counters with
 *    an early `break`. Note the original's counters are POST-incremented in the
 *    condition, so inside the body they run 1..99 and 1..4, not 0-based; `fi`
 *    and `fj` reproduce that exactly. Getting this wrong would shift
 *    `exp(i*i*e)` by one step and quietly change the falloff.
 * 2. **`pal()` is dead in the source** — defined, never called. Dropped rather
 *    than carried, since an unused cosine palette in a scene that takes its
 *    colour from uniforms is just confusing.
 *
 * ## Band routing
 *
 * The source is entirely wall-clock: flight speed, turn shape, camera roll and
 * the glow pulse all key off `iTime`. Each is replaced by the envelope that
 * should have been driving it:
 *
 *   energy + explode → FORWARD VELOCITY. Accumulated as distance in JS rather
 *                      than `iTime * speed`, because multiplying a running
 *                      clock by a changing speed makes the whole tunnel jump
 *                      backwards the moment the speed drops. `anim.explode`
 *                      adds the drop surge on top.
 *   mid / bass       → PATH CURVATURE, via slow JS-side envelopes. Deliberately
 *                      slow: `path()` is evaluated per march sample, so a fast
 *                      envelope warps the whole tunnel within a frame and reads
 *                      as swimming rather than as turning.
 *   transient        → CAMERA ROLL magnitude, so the wobble is hit-reactive.
 *   beat grid        → GLOW PHASE (see below).
 *   pulse            → GLOW INTENSITY, so bands flash on the beat.
 *   anim.inflate     → TUNNEL RADIUS, so the walls breathe with bass mass.
 *
 * ## The glow phase, and why it is not `b.pulse` directly
 *
 * The highest-impact term is `100.*exp(-20.*fract(p.z*.25+iTime))` — a sharp
 * band that sweeps along the tunnel, already rhythmic but locked to wall clock.
 *
 * Driving that phase from `b.pulse` directly does not work: `pulse` is an
 * ENVELOPE that rises and falls on each beat, so feeding it into `fract()`
 * would run the bands forward and then straight back again — a visible judder,
 * not a pulse. The phase has to be MONOTONIC to scroll.
 *
 * So the phase comes from the beat grid itself, `beatIndex + beatProgress`,
 * which advances exactly 1.0 per beat and never goes backwards. The bands step
 * one full period per beat, which is what "locked to the beat" actually
 * requires. `b.pulse` then drives the band's INTENSITY, so the flash lands on
 * the hit. Both halves are needed: the grid for timing, the envelope for
 * dynamics.
 *
 * ## Scene Contract
 *
 *   speed     flight speed (and the shape clock with it)
 *   shape     path curvature — "bend", straight corridor to rollercoaster
 *   tilt      roll baseline — "roll", how much the camera banks at rest
 *   contrast  rail glow against wall and fog — "rails"
 *
 * `complexity` and `density` are deliberately absent even though the march has
 * an obvious step count: `uMaxSteps` belongs to the quality governor, and this
 * scene degrades to flat fog rather than to a coarser picture below ~72 steps
 * (see the floor at the bottom of the frame callback). A dial that could reach
 * that floor would be a dial that breaks the scene, and the governor already
 * owns the trade it is making. `fill` is meaningless for a flythrough.
 */

/**
 * Overall brightness.
 *
 * Hotter than the roster's raymarch scenes for a specific reason: the source
 * ends on `mix(col, vec3(.9,.9,1.1), 1-exp(-.01*g*g*g))`, a distance fog toward
 * near-WHITE. Everything past the near field saturates to a bright wash, which
 * on an additive black ground fills the frame — the same exposure conflict
 * JuliaWingsScene documents for its inverted background.
 *
 * Raised from an initial 0.12, which rendered as little more than a haze: with
 * the fog softened below, far less of the frame is replaced by the fog colour,
 * so the accumulated glow has to actually be visible.
 */
const BRIGHTNESS = 0.3

export const FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;

  const float U_BRIGHTNESS = ${BRIGHTNESS.toFixed(3)};

  uniform vec2 uRes;
  uniform float uTime;
  /** Accumulated flight distance. Replaces the source's iTime * 5. */
  uniform float uDist;
  /** Slow per-axis turn amplitudes. Source had both hardcoded to 5. */
  uniform float uCurveX;
  uniform float uCurveY;
  /** Camera-roll magnitude, transient-driven. */
  uniform float uRoll;
  /** Monotonic beat phase: advances exactly 1.0 per beat. */
  uniform float uBeatPhase;
  /** Glow band intensity. Source had this hardcoded to 100. */
  uniform float uGlow;
  /** Bass swell widening the tunnel. */
  uniform float uInflate;
  uniform vec3 uColRail;
  uniform vec3 uColWall;
  uniform vec3 uColFog;
  uniform float uFade;
  uniform int uMaxSteps;

  /**
   * Distance-fog density.
   *
   * The source used .01 against g-cubed, which saturates to pure fog by g = 10.
   * This march steps roughly 0.6 units near the camera, so nearly every ray was
   * fully fogged within ~17 steps and the frame became a flat grey wash with
   * the tunnel invisible behind it.
   *
   * At .0006 the wall hits (g around 4-8) take only 10-25% fog and stay dark,
   * while axial rays down the shaft still saturate by g = 20. That separation
   * is the whole look: black walls, a bright mouth of light at the end.
   */
  #define FOG_DENSITY (0.0006)

  #define tdHash(x) fract(sin(x) * 43758.5453123)

  // From Kamoshika shader, per the source.
  float stepNoise(float x, float n) {
    const float factor = 0.3;
    float i = floor(x);
    float f = x - i;
    float u = smoothstep(0.5 - factor, 0.5 + factor, f);
    float res = mix(floor(tdHash(i) * n), floor(tdHash(i + 1.) * n), u);
    res /= (n - 1.) * 0.5;
    return res - 1.;
  }

  // Turn amplitudes are uniforms now; the source hardcoded both to 5.
  vec3 path(vec3 p){
    vec3 o = vec3(0.);
    o.x += stepNoise(p.z*.05, 5.) * uCurveX;
    o.y += stepNoise(p.z*.07, 3.975) * uCurveY;
    return o;
  }

  float diam2(vec2 p, float s){ p = abs(p); return (p.x + p.y - s) * inversesqrt(3.); }
  vec3 erot(vec3 p, vec3 ax, float t){ return mix(dot(ax,p)*ax, p, cos(t)) + cross(ax,p)*sin(t); }

  void main(){
    vec2 fragCoord = vUv * uRes;
    vec2 uv = (fragCoord - .5*uRes) / uRes.y;

    vec3 col = vec3(0.);

    vec3 ro = vec3(0.,0.,-1.), rt = vec3(0.);
    // Accumulated distance, not clock * speed — see the header.
    ro.z += uDist;
    rt.z += uDist;
    ro += path(ro);
    rt += path(rt);

    vec3 z = normalize(rt - ro);
    vec3 x = vec3(z.z, 0., -z.x);
    // Roll magnitude is transient-driven; the source applied the raw stepNoise
    // at full amplitude (about +/- 1 radian) on every frame regardless.
    float roll = stepNoise(uTime + tdHash(uv.x*uv.y*uTime)*.05, 6.) * uRoll;
    vec3 rd = mat3(x, cross(z,x), z) * erot(normalize(vec3(uv,1.)), vec3(0.,0.,1.), roll);

    float fi = 0., e = 0., g = 0.;
    // Constant bound + early break: GLSL ES 1.00 has no dynamic loop bounds,
    // and uMaxSteps is the quality governor's raymarch knob.
    for (int i = 0; i < 99; i++) {
      if (i >= uMaxSteps) break;
      fi += 1.;   // source post-increments, so the body sees 1..99

      vec3 p = ro + rd*g;
      p -= path(p);

      float r = 0.;
      vec3 pp = p;
      float sc = 1.;
      for (int j = 0; j < 4; j++) {
        float fj = float(j) + 1.;   // source body sees 1..4
        r = clamp(r + abs(dot(sin(pp*3.), cos(pp.yzx*2.))*.3 - .1)/sc, -.5, .5);
        pp = erot(pp, normalize(vec3(.1,.2,.3)), .785 + fj);
        pp += pp.yzx + fj*50.;
        sc *= 1.5;
        pp *= 1.5;
      }

      // Bass swell widens the bore. The source's constant was a flat 3.
      float h = abs(diam2(p.xy, 7.)) - (3. + uInflate*0.7) - r;

      p = erot(p, vec3(0.,0.,1.), path(p).x*.5 + p.z*.2);
      float t = length(abs(p.xy) - .5) - .1;
      h = min(t, h);
      g += e = max(.001, t == h ? abs(h) : h);

      // Glow phase from the beat grid (monotonic), intensity from the beat
      // envelope. See the header for why pulse cannot supply the phase.
      float band = uGlow * exp(-20. * fract(p.z*.25 + uBeatPhase));
      float checker = mod(floor(p.z*4.) + mod(floor(p.y*4.), 2.), 2.);
      vec3 hit = t == h ? uColRail * band * checker : uColWall;
      col += hit * .0325 / exp(fi*fi*e);
    }

    col = mix(col, uColFog, 1. - exp(-FOG_DENSITY*g*g*g));

    gl_FragColor = vec4(col * U_BRIGHTNESS * uFade, 1.0);
  }
`

/**
 * Base flight speed.
 *
 * The source flew at a flat 5 units/second. That reads as far too fast here,
 * because unlike Shadertoy this is also being driven UP by energy — at a loud
 * passage the old multiplier reached 5 x 2.85 = 14 u/s, nearly three times the
 * original. 2.4 with a tighter multiplier keeps the range at roughly 1.2-4 u/s,
 * so a peak still surges without the tunnel becoming a blur.
 */
const BASE_SPEED = 2.4

/**
 * The source's three colour constants, preserved as the VALUE structure of the
 * shot. Palette tinting is applied around these rather than replacing them.
 */
const WALL_BASE = new THREE.Color(0.1, 0.1, 0.1)
const RAIL_BASE = new THREE.Color(0.3, 0.2, 0.1)
const FOG_BASE = new THREE.Color(0.9, 0.9, 1.1)

export function TunnelDriftScene() {
  const size = useThree((s) => s.size)
  const dpr = useThree((s) => s.viewport.dpr)
  const clock = useRef(0)
  const dist = useRef(0)
  // Scratch, so the per-frame tinting allocates nothing.
  const tintWall = useMemo(() => new THREE.Color(), [])
  const tintRail = useMemo(() => new THREE.Color(), [])
  const tintFog = useMemo(() => new THREE.Color(), [])
  /** Slow turn envelopes — see the note on path() in the header. */
  const curveX = useRef(5)
  const curveY = useRef(5)

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
          uDist: { value: 0 },
          uCurveX: { value: 5 },
          uCurveY: { value: 5 },
          uRoll: { value: 0.25 },
          uBeatPhase: { value: 0 },
          uGlow: { value: 100 },
          uInflate: { value: 0 },
          uColRail: { value: new THREE.Color('#4c3319') },
          uColWall: { value: new THREE.Color('#1a1a1a') },
          uColFog: { value: new THREE.Color('#e6e6ff') },
          uFade: { value: 0 },
          uMaxSteps: { value: 99 },
        },
      }),
    [],
  )

  const geometry = useMemo(() => new THREE.PlaneGeometry(2, 2), [])

  useDispose(material, geometry)

  useEffect(() => {
    material.uniforms.uRes.value.set(size.width * dpr, size.height * dpr)
  }, [material, size, dpr])

  useSceneFrame(({ f, dt, b, anim, col, vis, params, p }) => {
    const u = material.uniforms

    // One rate for both clocks, so the dial cannot desynchronise the tunnel's
    // shape animation from its flight.
    const rate = params.speed * drastic(p.speed)
    clock.current += dt * rate

    // Distance ACCUMULATES. Multiplying a running clock by a varying speed
    // would jump the tunnel backwards whenever the speed fell.
    const speed = BASE_SPEED * (0.5 + b.energy * 0.6 + anim.explode * 0.8) * rate
    dist.current += dt * speed

    // Turn amplitudes ease over seconds rather than tracking the envelope
    // frame-to-frame, so the tunnel banks instead of swimming.
    //
    // `shape` is the silhouette of the flight path: at 0 the tunnel runs
    // straight and the piece reads as a corridor, at 1 it winds hard and reads
    // as a rollercoaster. It scales the whole amplitude including the
    // audio-driven part, because a straight tunnel that still swerves on the
    // bass is not straight — the dial has to win over the band or it is not a
    // shape control.
    const bend = drastic(p.shape)
    const k = Math.min(1, dt * 0.6)
    curveX.current += ((3.5 + b.mid * 5.5) * bend - curveX.current) * k
    curveY.current += ((3.5 + b.bass * 5.0) * bend - curveY.current) * k

    u.uTime.value = clock.current
    u.uDist.value = dist.current
    u.uCurveX.value = curveX.current
    u.uCurveY.value = curveY.current
    // Baseline raised from 0.18: the source rolled at the raw stepNoise
    // amplitude (about +/- 1 rad) constantly, and at 0.18 the frame was nearly
    // static between hits, which flattened the sense of flight.
    //
    // `tilt` moves that baseline. Bipolar so 0.5 keeps the authored 0.45, and
    // floored at 0.05 rather than 0 — a tunnel with no roll at all loses the
    // sense of flight this baseline was raised to restore.
    u.uRoll.value = Math.max(0.05, 0.45 + bipolar(p.tilt, 0.4)) + b.transient * 0.75
    // Monotonic, exactly 1.0 per beat — the phase the glow bands scroll on.
    // Wrapped: the phase is consumed inside fract(), so subtracting whole beats
    // is invisible, while an unbounded beatIndex would lose float precision
    // over a long session and quantise the glow bands into steps.
    u.uBeatPhase.value = (f.beatIndex % 1024) + f.beatProgress
    // Floor raised from 0.4: the source's constant was a flat 100, so at rest
    // the rails were reading at under half their intended strength.
    //
    // `contrast` scales the rails against the wall and fog, which is what the
    // tonal range of this picture actually is: low is a soft foggy corridor,
    // high is hot filament rails cutting through it.
    u.uGlow.value = 100 * (0.6 + b.pulse * 1.0) * (0.4 + p.contrast * 1.2)
    u.uInflate.value = Math.min(1.5, anim.inflate)
    // Palette TINTS these; it must not set their brightness. The source's three
    // constants encode a deliberate value hierarchy — near-black wall, warm
    // gold rail, near-white fog — and substituting palette colours wholesale
    // flattened all three to mid-grey, which is what turned the frame into a
    // haze. Each is now the original value blended a little toward the palette.
    u.uColWall.value.copy(WALL_BASE).lerp(tintWall.copy(col.a).multiplyScalar(0.12), 0.5)
    u.uColRail.value.copy(RAIL_BASE).lerp(tintRail.copy(col.c).multiplyScalar(0.3), 0.35)
    u.uColFog.value.copy(FOG_BASE).lerp(tintFog.copy(col.b).multiplyScalar(0.9), 0.25)
    u.uFade.value = vis

    // Floored at 72 rather than tracking the governor all the way down.
    // Unlike a solid SDF, this scene builds its image by ACCUMULATING glow
    // along the ray — cut the step count and rays stop reaching the geometry at
    // all, so the frame degrades to flat fog rather than to a coarser version
    // of itself. Below ~72 there is nothing left to look at, which makes a
    // cheap render pointless.
    u.uMaxSteps.value = Math.max(72, Math.min(99, quality.knobs.raymarchSteps))
  })

  return (
    <mesh frustumCulled={false}>
      <primitive object={geometry} attach="geometry" />
      <primitive object={material} attach="material" />
    </mesh>
  )
}
