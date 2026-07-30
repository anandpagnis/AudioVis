import { useContext, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { audioEngine, beatPulse } from '../audio/AudioEngine'
import { FULLSCREEN_VERT, NOISE_GLSL } from '../engine/glsl'
import { PaletteBlender, getPalette } from '../engine/palettes'
import { SceneFade } from '../engine/SceneManager'
import { getEffectiveParams } from '../engine/moodParams'
import { useDispose } from '../engine/useDispose'
import { useStore } from '../store'

const FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform float uTime;
  uniform float uWind;
  uniform float uBass;
  uniform float uHigh;
  uniform float uEnergy;
  uniform float uPulse;
  uniform float uDrop;
  uniform float uFade;
  uniform vec2 uRes;
  uniform vec3 uColA;
  uniform vec3 uColB;
  uniform vec3 uColC;

  ${NOISE_GLSL}

  void main() {
    vec2 uv = (vUv - 0.5) * vec2(uRes.x / uRes.y, 1.0);

    // A slow wandering sun that flares on the beat.
    vec2 sun = vec2(sin(uTime * 0.04) * 0.45, 0.22 + cos(uTime * 0.03) * 0.1);
    float sd = length(uv - sun);
    float disc = exp(-sd * sd * 60.0) * (1.2 + uPulse * 2.6 + uDrop * 2.0);

    // God rays sweep around the sun, breathing with the beat.
    vec2 d = uv - sun;
    float ang = atan(d.y, d.x);
    float rays = pow(max(0.0, sin(ang * 7.0 + uTime * 0.22)), 6.0)
               * exp(-sd * 1.8) * (0.14 + uPulse * 0.65);

    // Three parallax cloud decks; bass thickens the cover.
    float cover = 0.52 - uBass * 0.18;
    vec3 col = mix(uColA * 0.12, uColB * 0.22, uv.y + 0.5); // sky gradient
    for (int l = 0; l < 3; l++) {
      float fl = float(l);
      float sc = 1.4 + fl * 1.1;
      float sp = 0.5 + fl * 0.45;
      float c = fbm(uv * vec2(sc, sc * 2.1) + vec2(uWind * sp, fl * 7.31));
      float dens = smoothstep(cover, cover + 0.38, c);
      // Silver lining near the sun.
      float silver = pow(dens, 3.0) * exp(-sd * 1.5);
      vec3 cloudCol = mix(uColA * 0.35, uColB, dens * 0.75);
      cloudCol += uColC * silver * (0.9 + uPulse * 1.2);
      col = mix(col, cloudCol, dens * (0.55 - fl * 0.12));
    }

    col += mix(uColC, vec3(1.0), 0.35) * (disc + rays);

    // High end sparkles as ice crystals.
    float star = step(0.998, hash21(floor((uv + 0.5) * uRes.y * 0.4))) * uHigh;
    col += vec3(1.0) * star * 0.5;

    col *= (0.45 + uEnergy * 0.7);
    col *= 1.0 - dot(uv, uv) * 0.4;
    col *= uFade;
    gl_FragColor = vec4(col, 1.0);
  }
`

export function VolumetricCloudsScene() {
  const fade = useContext(SceneFade)
  const wind = useRef(0)
  const blender = useMemo(() => new PaletteBlender(getPalette(useStore.getState().paletteId)), [])

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: FULLSCREEN_VERT,
        fragmentShader: FRAG,
        depthWrite: false,
        depthTest: false,
        transparent: true,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uTime: { value: 0 },
          uWind: { value: 0 },
          uBass: { value: 0 },
          uHigh: { value: 0 },
          uEnergy: { value: 0 },
          uPulse: { value: 0 },
          uDrop: { value: 0 },
          uFade: { value: 0 },
          uRes: { value: new THREE.Vector2(1, 1) },
          uColA: { value: new THREE.Color() },
          uColB: { value: new THREE.Color() },
          uColC: { value: new THREE.Color() },
        },
      }),
    [],
  )

  useDispose(material)

  useFrame(({ size }) => {
    const f = audioEngine.features
    const u = material.uniforms
    const { paletteId } = useStore.getState()
    const params = getEffectiveParams()
    const R = params.reactivity

    blender.update(getPalette(paletteId), f.delta)
    wind.current += f.delta * (0.06 + f.energy * 0.25) * params.speed

    u.uTime.value = f.time
    u.uWind.value = wind.current
    u.uBass.value = f.bass * R
    u.uHigh.value = f.high * R
    u.uEnergy.value = f.energy * R
    u.uPulse.value = beatPulse(f) * R
    u.uDrop.value = f.drop ? 1 : 0
    u.uFade.value = fade.value * params.intensity
    u.uRes.value.set(size.width, size.height)
    u.uColA.value.copy(blender.a)
    u.uColB.value.copy(blender.b)
    u.uColC.value.copy(blender.c)
  })

  return (
    <mesh frustumCulled={false}>
      <planeGeometry args={[2, 2]} />
      <primitive object={material} attach="material" />
    </mesh>
  )
}
