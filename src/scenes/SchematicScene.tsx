import { useContext, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { audioEngine, beatPulse } from '../audio/AudioEngine'
import { CameraRig } from '../engine/CameraRig'
import { PaletteBlender, getPalette } from '../engine/palettes'
import { SceneFade } from '../engine/SceneManager'
import { getEffectiveParams } from '../engine/moodParams'
import { useDispose } from '../engine/useDispose'
import { useStore } from '../store'

/**
 * Schematic — the first scene of the "crystal-cut" art direction (VISION.md).
 *
 * A slowly rotating hero object drawn as pure LINE ART on dead black: a
 * displaced icosphere and a faceted scan-ring rendered as antialiased
 * barycentric wireframe, over a ground grid. No fullscreen glow field — one
 * readable subject surrounded by negative space, hard phosphor edges that stay
 * 1px sharp at any internal resolution (fwidth screen-space derivatives). This
 * is the Ghost-in-the-Shell blueprint look, and it's cheap: a couple of
 * thousand line fragments, so it stays butter-smooth by construction.
 */

/** Give a mesh a per-vertex barycentric attribute so the shader can draw its edges. */
function withBarycentric(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = geo.toNonIndexed()
  const count = g.getAttribute('position').count
  const bary = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    const v = i % 3
    bary[i * 3] = v === 0 ? 1 : 0
    bary[i * 3 + 1] = v === 1 ? 1 : 0
    bary[i * 3 + 2] = v === 2 ? 1 : 0
  }
  g.setAttribute('barycentric', new THREE.BufferAttribute(bary, 3))
  return g
}

const WIRE_VERT = /* glsl */ `
  attribute vec3 barycentric;
  varying vec3 vBary;
  varying float vDepth;
  uniform float uTime;
  uniform float uBass;
  uniform float uMid;
  uniform float uPulse;
  uniform float uTransient;
  uniform float uWobble;

  void main() {
    vBary = barycentric;
    vec3 pos = position;
    // Gentle surface wobble along the normal — an organism being scanned —
    // plus a beat/bass breathing pulse on the whole form. Mid content agitates
    // the surface, so harmonic density is legible as texture rather than
    // everything keying off the kick.
    float w =
      sin(pos.y * 3.0 + uTime * 1.4) * 0.5 +
      sin(pos.x * 4.0 - uTime * 1.1) * 0.3 +
      sin(pos.z * 3.5 + uTime * 0.9) * 0.2;
    pos += normal * w * uWobble * (0.4 + uBass + uMid * 0.7);
    pos *= 1.0 + uPulse * 0.06 + uBass * 0.05 + uTransient * 0.04;
    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    vDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`

const WIRE_FRAG = /* glsl */ `
  precision highp float;
  varying vec3 vBary;
  varying float vDepth;
  uniform vec3 uColLine;
  uniform vec3 uColHot;
  uniform float uFade;
  uniform float uPulse;
  uniform float uPresence;
  uniform float uTransient;
  uniform float uThickness;
  uniform float uNear;
  uniform float uFar;

  // Antialiased wireframe: the barycentric coord is ~0 exactly on a triangle
  // edge; fwidth gives a constant screen-space (pixel) width regardless of the
  // internal render resolution — that is what keeps the strokes crystal sharp.
  float edgeFactor() {
    vec3 d = fwidth(vBary);
    // Presence widens the stroke: snares and plucks sharpen/thicken the outline
    // independently of the kick, which only breathes the form.
    vec3 a3 = smoothstep(vec3(0.0), d * (uThickness + uPresence * 0.9), vBary);
    return min(min(a3.x, a3.y), a3.z);
  }

  void main() {
    float line = 1.0 - edgeFactor();
    if (line < 0.002) discard;
    // Depth cue — far edges recede, near edges read hot (GitS z-fade).
    float depthFade = clamp(1.0 - (vDepth - uNear) / (uFar - uNear), 0.14, 1.0);
    vec3 col = mix(uColLine, uColHot, uPulse * 0.5) * line * depthFade;
    // Strong base so the line-art subject always reads (line art, not glow that
    // dies in the quiet); the beat/energy add punch on top.
    col *= (1.1 + uPulse * 1.5 + uTransient * 1.1) * uFade;
    // Additive over black: alpha 1, brightness carries the line — thin coverage
    // keeps the frame ~90% true black (negative space), so no grey haze.
    gl_FragColor = vec4(col, 1.0);
  }
`

interface WireUniforms {
  uTime: THREE.IUniform<number>
  uBass: THREE.IUniform<number>
  uMid: THREE.IUniform<number>
  uPresence: THREE.IUniform<number>
  uPulse: THREE.IUniform<number>
  uTransient: THREE.IUniform<number>
  uWobble: THREE.IUniform<number>
  uColLine: THREE.IUniform<THREE.Color>
  uColHot: THREE.IUniform<THREE.Color>
  uFade: THREE.IUniform<number>
  uThickness: THREE.IUniform<number>
  uNear: THREE.IUniform<number>
  uFar: THREE.IUniform<number>
}

function makeWireMaterial(wobble: number, thickness: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: WIRE_VERT,
    fragmentShader: WIRE_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: false, // x-ray blueprint — see the whole cage, front and back
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uBass: { value: 0 },
      uMid: { value: 0 },
      uPresence: { value: 0 },
      uPulse: { value: 0 },
      uTransient: { value: 0 },
      uWobble: { value: wobble },
      // Non-black defaults so the wireframe is never black-on-black before the
      // first useFrame copies the live palette in (phosphor cyan → green).
      uColLine: { value: new THREE.Color('#00e5ff') },
      uColHot: { value: new THREE.Color('#00ffa3') },
      uFade: { value: 0 },
      uThickness: { value: thickness },
      uNear: { value: 6 },
      uFar: { value: 13 },
    },
  })
}

export function SchematicScene() {
  const fade = useContext(SceneFade)
  const lastFade = useRef(0)
  const rig = useMemo(() => new CameraRig(), [])
  const blender = useMemo(() => new PaletteBlender(getPalette(useStore.getState().paletteId)), [])

  const heroRef = useRef<THREE.Group>(null)
  const ringRef = useRef<THREE.Mesh>(null)
  const spin = useRef(0)

  const heroGeo = useMemo(() => withBarycentric(new THREE.IcosahedronGeometry(2, 3)), [])
  const ringGeo = useMemo(() => withBarycentric(new THREE.TorusGeometry(3.1, 0.34, 6, 44)), [])
  const heroMat = useMemo(() => makeWireMaterial(0.16, 1.3), [])
  const ringMat = useMemo(() => makeWireMaterial(0, 1.0), [])

  const grid = useMemo(() => {
    const g = new THREE.GridHelper(60, 60)
    const m = g.material as THREE.LineBasicMaterial
    m.transparent = true
    m.opacity = 0
    m.depthWrite = false
    g.position.y = -4.2
    return g
  }, [])

  useDispose(heroGeo, ringGeo, heroMat, ringMat, grid.material as THREE.Material)

  useFrame(({ camera }) => {
    const f = audioEngine.features
    const { paletteId } = useStore.getState()
    const params = getEffectiveParams()
    const R = params.reactivity
    blender.update(getPalette(paletteId), f.delta)

    const pulse = beatPulse(f) * R
    // Mood modulates brightness but never crushes the subject below ~half — a
    // line-art hero must stay readable through quiet sections (negative space +
    // a visible subject is the whole point), unlike the old glow-field scenes.
    const fadeAmt = Math.min(1.6, fade.value * (0.5 + 0.5 * params.intensity))

    for (const mat of [heroMat, ringMat]) {
      const u = mat.uniforms as unknown as WireUniforms
      u.uTime.value = f.time
      u.uBass.value = f.bass * R
      u.uMid.value = f.mid * R
      u.uPresence.value = f.presence * R
      u.uPulse.value = pulse
      u.uTransient.value = f.transient * R
      u.uFade.value = fadeAmt
      // Cyan body lines easing to the green/accent on the beat — phosphor CRT.
      u.uColLine.value.copy(blender.a)
      u.uColHot.value.copy(blender.c)
    }

    // Ground grid: faint, palette-tinted. The HIGHS own it — hats and cymbals
    // light the floor, so a kick-only passage leaves it dark and the grid
    // becomes a readout of the top end rather than a second copy of the beat.
    const gridMat = grid.material as THREE.LineBasicMaterial
    gridMat.color.copy(blender.a)
    gridMat.opacity = fadeAmt * (0.06 + f.high * R * 0.3 + pulse * 0.06)

    // Subject rotates; camera stays a fixed hover so it reads centered in black.
    spin.current += f.delta * (0.12 + f.energy * 0.35) * params.speed
    if (heroRef.current) {
      heroRef.current.rotation.y = spin.current
      heroRef.current.rotation.x = Math.sin(f.time * 0.15) * 0.25
    }
    if (ringRef.current) {
      ringRef.current.rotation.x = Math.PI * 0.5 + Math.sin(f.time * 0.2) * 0.3
      ringRef.current.rotation.z = -spin.current * 0.6
    }

    const drivesCamera = fade.value >= lastFade.current
    lastFade.current = fade.value
    if (drivesCamera) {
      rig.hover(camera, f, { pos: [0, 1.4, 9], look: [0, 0.3, 0], bob: 0.6 })
    }
  })

  return (
    <group>
      <primitive object={grid} />
      <group ref={heroRef}>
        <mesh geometry={heroGeo} material={heroMat} frustumCulled={false} />
      </group>
      <mesh ref={ringRef} geometry={ringGeo} material={ringMat} frustumCulled={false} />
    </group>
  )
}
