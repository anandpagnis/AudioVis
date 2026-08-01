import { useMemo, useRef } from 'react'
import * as THREE from 'three'
import { applyToUniforms } from '../engine/AnimationDirector'
import { useSceneFrame } from '../engine/sceneFrame'
import { useDispose } from '../engine/useDispose'

/**
 * Flow Ribbons — long streamers drifting through a curl field.
 *
 * The fluid counterpart to Plasma Filament's point cloud: instead of 70k
 * independent dots, this is a small number of CONTINUOUS surfaces, so the
 * motion reads as flow rather than as sparkle. Continuity is the whole point —
 * a ribbon shows you the shape of the field it is travelling through, which a
 * particle cloud can only imply.
 *
 * Everything runs in the vertex shader: each ribbon is one triangle strip whose
 * spine is a closed-form function of (ribbon index, arc position, time). No
 * simulation, no ping-pong targets, no per-frame CPU work — the whole field is
 * a handful of draw calls and stays cheap enough to layer.
 *
 * **The ribbons TRACE THE SYNTH WAVEFORM.**
 * Each ribbon's spine is displaced by `features.midWaveform` — real
 * time-domain samples from a band-pass around the lead range — sampled along
 * its arc. The ribbon is therefore a literal oscilloscope of the synth line,
 * stretched into 3D and carried through a curl field. A held pad draws long
 * smooth undulations; a fast arpeggio draws tight ripples travelling down the
 * streamer; silence lets it settle flat.
 *
 * Tracing the FULL-mix waveform would just draw the drums — kick and bass
 * dominate the time domain — which is why the engine exposes a band-passed
 * copy specifically for this.
 *
 * **Rest of the routing**
 *   mid    → curl amplitude: harmonic density bends the flow. A dense chord
 *            section visibly writhes; a sparse one runs straight.
 *   voice  → ribbon WIDTH, brightness, and how deep the wave is carved
 *   bass   → how far the bundle spreads from the axis
 *   hihat  → travelling sparkle along the arc, nothing else
 *   snare  → a lateral kick to the whole bundle
 */

const RIBBONS = 22
/** Spine samples per ribbon. Each contributes 2 verts (left/right edge). */
const SEGMENTS = 90

/** Exported so the GLSL can be compiled on a real driver — tsc never sees it. */
export const VERT = /* glsl */ `
  attribute float aRibbon;   // which ribbon, 0..RIBBONS-1
  attribute float aT;        // arc position along the spine, 0..1
  attribute float aSide;     // -1 = left edge, +1 = right edge
  attribute float aRand;

  uniform float uTime;
  uniform float uMid;
  uniform float uVoice;
  uniform float uBass;
  uniform float uSnare;
  uniform float uPulse;
  uniform float uCount;
  uniform sampler2D uWave;   // band-passed synth waveform, 0.5 = silence
  uniform float uWaveAmp;

  varying float vT;
  varying float vSide;
  varying float vRand;
  varying float vSpeed;
  varying float vWave;

  // Divergence-free-ish sine field: cheap, and curling rather than converging
  // is what keeps ribbons from all collapsing onto one attractor.
  vec3 flow(vec3 p) {
    return vec3(
      sin(p.y * 0.9 + uTime * 0.4) + cos(p.z * 0.7 - uTime * 0.3),
      sin(p.z * 0.8 - uTime * 0.35) + cos(p.x * 0.6 + uTime * 0.25),
      sin(p.x * 0.7 + uTime * 0.3) + cos(p.y * 0.9 - uTime * 0.4)
    );
  }

  void main() {
    vT = aT;
    vSide = aSide;
    vRand = aRand;

    // Ribbons stream along +X, spread around a ring in the YZ plane.
    //
    // Travelling ACROSS frame rather than toward the camera is deliberate: an
    // earlier version streamed along -Z and, viewed head-on, every ribbon
    // splayed radially from the centre — a starburst, not a flow. Length has to
    // lie across the view for the eye to read it as movement through a field.
    float ang = (aRibbon / uCount) * 6.2831853;
    float ring = 0.9 + aRand * 1.3 + uBass * 1.2;
    vec3 p = vec3(-4.6 + aT * 9.2, cos(ang) * ring, sin(ang) * ring);

    // Integrate along the spine. Mid content sets how hard the field curls, so
    // harmonic density is directly legible as writhing. The +X bias is weak
    // relative to the field so the ribbons genuinely wander instead of running
    // as straight parallel rails.
    float curl = 0.5 + uMid * 1.5;
    vec3 dir = vec3(1.0, 0.0, 0.0);
    for (int i = 0; i < 5; i++) {
      dir = normalize(flow(p * 0.5 + aRand * 6.0) * (0.7 + uMid * 0.9) + vec3(0.9, 0.0, 0.0));
      p += dir * curl * 0.34;
    }
    // ---- Trace the synth waveform -------------------------------------
    // Sample the band-passed wave along the arc. Each ribbon reads a slightly
    // offset window so the bundle shows the same line phase-shifted rather
    // than N identical copies stacked on top of each other.
    float wOff = aRand * 0.35;
    float wave = texture2D(uWave, vec2(fract(aT * 0.85 + wOff), 0.5)).r - 0.5;
    // Displace ACROSS the flow, not along it — a wave that moved the spine
    // forward would just change spacing rather than draw a visible shape.
    vec3 waveAxis = normalize(cross(dir, vec3(0.0, 1.0, 0.0)) + vec3(0.0, 0.35, 0.0));
    // Taper at the ends so the trace emerges from and returns to the flow.
    p += waveAxis * wave * uWaveAmp * 4.0 * sin(aT * 3.14159);
    vWave = wave;

    // Snares shove the whole bundle sideways — a discrete event, not a wash.
    p.y += uSnare * 0.5 * sin(aRibbon * 2.1);
    vSpeed = curl;

    // Widen across the flow, in a plane that is DIFFERENT for every ribbon.
    // Crossing against a single fixed axis made every ribbon widen the same
    // way, so the bundle collapsed into coplanar horizontal sheets — venetian
    // blinds, not a flow. Using each ribbon's own radial direction as the
    // reference spreads the width planes around the bundle and restores depth.
    vec3 radial = vec3(0.0, cos(ang), sin(ang));
    vec3 across = normalize(cross(dir, radial) + vec3(0.001));
    float width = (0.03 + uVoice * 0.2 + uPulse * 0.03)
      // Taper both ends so ribbons don't terminate in hard rectangles.
      * sin(aT * 3.14159);
    p += across * aSide * width;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`

/** Exported so the GLSL can be compiled on a real driver — tsc never sees it. */
export const FRAG = /* glsl */ `
  precision highp float;
  uniform vec3 uColA;
  uniform vec3 uColB;
  uniform vec3 uColC;
  uniform float uVoice;
  uniform float uHihat;
  uniform float uEnergy;
  uniform float uTime;
  uniform float uAnimRipple;
  uniform float uFade;
  varying float vT;
  varying float vSide;
  varying float vRand;
  varying float vSpeed;
  varying float vWave;

  void main() {
    // Soft across-ribbon falloff so edges read as light, not as polygons.
    float edge = 1.0 - abs(vSide);
    float body = smoothstep(0.0, 0.55, edge);

    // Colour travels along the arc: cool at the tail, hot at the head.
    vec3 col = mix(uColA, uColB, vT);
    col = mix(col, uColC, smoothstep(0.55, 1.0, vT) * (0.35 + uVoice * 0.65));

    // Wave crests read hot, troughs cool — makes the traced shape legible as a
    // waveform rather than just a wobble in the ribbon's path.
    col = mix(col, uColC, clamp(abs(vWave) * 2.6, 0.0, 1.0) * 0.7);

    // Hats put a travelling glint on the ribbons and touch nothing else. The
    // glint travels on the tempo-locked ripple phase rather than wall-clock
    // time, so on a fast track the sparkle runs fast. uAnimRipple is a 0..1
    // sawtooth, so its multiplier MUST stay a whole number of turns (5.0 below)
    // — a fractional one steps the phase at every wrap and the glint stutters.
    float glint = pow(max(0.0, sin(vT * 26.0 - uAnimRipple * 6.2831853 * 5.0 + vRand * 6.28)), 18.0);
    col += uColC * glint * uHihat * 1.4;

    // Exposure discipline: many overlapping additive surfaces, so per-ribbon
    // contribution stays low (docs/09_Rendering_Engine.md). Brightness comes
    // from voice and energy, never from stacking opacity.
    float bright = (0.1 + uEnergy * 0.26 + uVoice * 0.42 + abs(vWave) * 0.8)
      * (0.5 + vRand * 0.5);

    gl_FragColor = vec4(col * body * bright * uFade, 1.0);
  }
`

/** One triangle strip per ribbon, joined into a single indexed buffer. */
function buildGeometry(): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry()
  const vertsPerRibbon = SEGMENTS * 2
  const total = RIBBONS * vertsPerRibbon

  const position = new Float32Array(total * 3) // placeholder; spine is in the shader
  const ribbon = new Float32Array(total)
  const t = new Float32Array(total)
  const side = new Float32Array(total)
  const rand = new Float32Array(total)

  const indices: number[] = []
  for (let r = 0; r < RIBBONS; r++) {
    const seed = Math.random()
    const base = r * vertsPerRibbon
    for (let s = 0; s < SEGMENTS; s++) {
      for (let e = 0; e < 2; e++) {
        const i = base + s * 2 + e
        ribbon[i] = r
        t[i] = s / (SEGMENTS - 1)
        side[i] = e === 0 ? -1 : 1
        rand[i] = seed
      }
      // Two triangles bridging this rung to the next, within this ribbon only.
      if (s < SEGMENTS - 1) {
        const a = base + s * 2
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
      }
    }
  }

  geo.setAttribute('position', new THREE.BufferAttribute(position, 3))
  geo.setAttribute('aRibbon', new THREE.BufferAttribute(ribbon, 1))
  geo.setAttribute('aT', new THREE.BufferAttribute(t, 1))
  geo.setAttribute('aSide', new THREE.BufferAttribute(side, 1))
  geo.setAttribute('aRand', new THREE.BufferAttribute(rand, 1))
  geo.setIndex(indices)
  return geo
}

/** Waveform texture width. Power of two so REPEAT wrapping is exact. */
const WAVE_SIZE = 256

export function FlowRibbonScene() {
  const geometry = useMemo(() => buildGeometry(), [])
  const smoothed = useRef(new Float32Array(WAVE_SIZE))

  const { waveTex, waveData } = useMemo(() => {
    const d = new Uint8Array(WAVE_SIZE).fill(128) // 128 = silence (0.5 in shader)
    const tex = new THREE.DataTexture(d, WAVE_SIZE, 1, THREE.RedFormat)
    tex.minFilter = THREE.LinearFilter
    tex.magFilter = THREE.LinearFilter
    tex.wrapS = THREE.RepeatWrapping
    tex.needsUpdate = true
    return { waveTex: tex, waveData: d }
  }, [])
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uTime: { value: 0 },
          uMid: { value: 0 },
          uVoice: { value: 0 },
          uBass: { value: 0 },
          uSnare: { value: 0 },
          uHihat: { value: 0 },
          uEnergy: { value: 0 },
          uPulse: { value: 0 },
          uAnimRipple: { value: 0 },
          uFade: { value: 0 },
          uCount: { value: RIBBONS },
          uWave: { value: waveTex },
          uWaveAmp: { value: 0 },
          uColA: { value: new THREE.Color('#00e5ff') },
          uColB: { value: new THREE.Color('#7c4dff') },
          uColC: { value: new THREE.Color('#00ffa3') },
        },
      }),
    [waveTex],
  )

  useDispose(material, geometry, waveTex)

  useSceneFrame(
    ({ f, dt, b, col, vis, state }) => {
      const u = material.uniforms

      // Density budget: whole ribbons drop out rather than every ribbon
      // getting shorter, so what remains still reads as continuous flow.
      const keep = Math.max(4, Math.floor(RIBBONS * state.particleDensity))
      geometry.setDrawRange(0, keep * (SEGMENTS - 1) * 6)

      // ---- Upload the synth waveform ------------------------------------
      // Decimate the band-passed time-domain buffer down to the texture width,
      // taking the extreme in each bucket rather than the mean: averaging a
      // waveform toward zero is exactly how an oscilloscope trace turns into a
      // flat line, and the peaks are the shape worth drawing.
      const src = f.midWaveform
      const step = src.length / WAVE_SIZE
      const sm = smoothed.current
      // Temporal smoothing keeps the trace legible instead of strobing, but
      // stays fast enough that an arpeggio still reads as separate notes.
      const k = Math.min(1, dt * 26)
      for (let i = 0; i < WAVE_SIZE; i++) {
        const start = Math.floor(i * step)
        const end = Math.min(src.length, Math.floor((i + 1) * step))
        let extreme = 0
        for (let j = start; j < end; j++) {
          if (Math.abs(src[j]) > Math.abs(extreme)) extreme = src[j]
        }
        sm[i] += (extreme - sm[i]) * k
        waveData[i] = Math.max(0, Math.min(255, Math.round(sm[i] * 380 + 128)))
      }
      waveTex.needsUpdate = true
      // Voice deepens the carve, so the trace is boldest exactly when there is
      // a sustained line worth looking at.
      u.uWaveAmp.value = 0.12 + b.voice * 0.5

      u.uTime.value = f.time
      u.uMid.value = b.mid
      u.uVoice.value = b.voice
      u.uBass.value = b.bass
      u.uSnare.value = b.snare
      u.uHihat.value = b.hihat
      u.uEnergy.value = b.energy
      u.uPulse.value = b.pulse
      // Opts this material into the director's primitives by name — only the
      // uniforms declared above are written.
      applyToUniforms(u)
      u.uFade.value = vis
      u.uColA.value.copy(col.a)
      u.uColB.value.copy(col.b)
      u.uColC.value.copy(col.c)
    },
    { visCeiling: 1.2, visFloor: 0.3 },
  )

  return (
    <mesh geometry={geometry} frustumCulled={false}>
      <primitive object={material} attach="material" />
    </mesh>
  )
}
