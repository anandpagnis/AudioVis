import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { audioEngine, beatPulse } from '../audio/AudioEngine'
import type { MoodState } from '../audio/types'
import { FULLSCREEN_VERT, NOISE_GLSL } from './glsl'
import { getEffectiveParams } from './moodParams'
import { textureGenerator } from './textureGenerator'
import { useDispose } from './useDispose'
import { useStore } from '../store'

/** How strongly the generated art washes over each mood, 0..1. */
const GAIN: Record<MoodState, number> = {
  silence: 0,
  ambient: 0.3,
  mellow: 0.34,
  groove: 0.26,
  building: 0.3,
  peak: 0.38,
  aggressive: 0.36,
}

const FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uTexA;
  uniform sampler2D uTexB;
  uniform float uMix;
  uniform float uHasA;
  uniform float uAlpha;
  uniform float uTime;
  uniform float uWarp;
  uniform float uPulse;
  uniform vec2 uRes;

  ${NOISE_GLSL}

  void main() {
    vec2 uv = vUv;
    vec2 asp = vec2(uRes.x / uRes.y, 1.0);

    // Slow drift + audio-reactive fbm warp so still images feel alive.
    vec2 drift = vec2(uTime * 0.006, -uTime * 0.004);
    vec2 warp = vec2(
      fbm(uv * asp * 2.0 + uTime * 0.05),
      fbm(uv * asp * 2.0 + 7.3 - uTime * 0.04)
    ) - 0.5;
    vec2 suv = uv + drift + warp * uWarp;

    vec3 a = texture2D(uTexA, suv).rgb;
    vec3 b = texture2D(uTexB, suv + warp * 0.02).rgb;
    vec3 art = mix(a, b, uMix) * uHasA;

    // Deepen contrast so the additive wash reads as glow, not fog.
    art = art * art * 1.6;

    // Beat shimmer + soft edge falloff (projector-friendly).
    vec2 c = (uv - 0.5) * asp;
    float edge = 1.0 - smoothstep(0.45, 0.95, length(c));
    art *= (1.0 + uPulse * 0.35) * edge;

    gl_FragColor = vec4(art * uAlpha, 1.0);
  }
`

/**
 * The Tier-3 overlay: locally AI-generated, mood-matched art washed over
 * whatever scene is playing. Textures come from the sd-turbo backend; when
 * it isn't running the alpha just stays at zero and nothing is lost.
 * Crossfades between successive textures happen in-shader (uMix).
 */
export function GenerativeLayer() {
  const texA = useRef<THREE.Texture | null>(null)
  const texB = useRef<THREE.Texture | null>(null)
  const alpha = useRef(0)
  const kicked = useRef(false)
  const lastRequested = useRef('')
  const prefetched = useRef('')

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
          uTexA: { value: null },
          uTexB: { value: null },
          uMix: { value: 0 },
          uHasA: { value: 0 },
          uAlpha: { value: 0 },
          uTime: { value: 0 },
          uWarp: { value: 0.03 },
          uPulse: { value: 0 },
          uRes: { value: new THREE.Vector2(1, 1) },
        },
      }),
    [],
  )
  useDispose(material)

  // Tell the generator which textures are on screen so its cache never evicts
  // (disposes) one we're still sampling.
  const syncInUse = () => {
    textureGenerator.inUse.clear()
    if (texA.current) textureGenerator.inUse.add(texA.current)
    if (texB.current) textureGenerator.inUse.add(texB.current)
  }

  const applyTexture = (tex: THREE.Texture | null) => {
    if (!tex) return
    const u = material.uniforms
    if (!texA.current) {
      texA.current = tex
      u.uTexA.value = tex
      u.uHasA.value = 1
      u.uMix.value = 0
    } else if (tex !== texA.current) {
      texB.current = tex
      u.uTexB.value = tex
      // uMix animates 0 → 1 in useFrame, then B is promoted to A.
    }
    syncInUse()
  }

  useFrame(({ size }) => {
    const f = audioEngine.features
    const m = f.mood
    const s = useStore.getState()
    const u = material.uniforms
    const params = getEffectiveParams()

    // --- Request art on committed mood changes (plus one initial kick) ---
    const wantArt = s.generative && s.status === 'running' && !f.silence
    if (wantArt) {
      const key = `${m.state}_${s.paletteId}`
      if ((m.changed || !kicked.current) && lastRequested.current !== key) {
        kicked.current = true
        lastRequested.current = key
        void textureGenerator.request(m.state, s.paletteId, m.changeCount).then(applyTexture)
      }
      // Predictive prefetch: have the peak's art ready before the drop hits.
      const pKey = `${m.predictedState}_${s.paletteId}`
      if (
        m.predictedState !== m.state &&
        m.beatsTillTransition >= 0 &&
        m.beatsTillTransition < 8 &&
        prefetched.current !== pKey
      ) {
        prefetched.current = pKey
        void textureGenerator.request(m.predictedState, s.paletteId, m.changeCount + 1)
      }
    }

    // --- Texture crossfade ---
    if (texB.current) {
      u.uMix.value = Math.min(1, u.uMix.value + f.delta * 0.4)
      if (u.uMix.value >= 1) {
        texA.current = texB.current
        u.uTexA.value = texA.current
        texB.current = null
        u.uMix.value = 0
        syncInUse()
      }
    }

    // --- Alpha eases toward the mood's gain (0 when disabled/no art) ---
    const target = wantArt && texA.current ? GAIN[m.state] * params.intensity : 0
    alpha.current += (target - alpha.current) * Math.min(1, f.delta * 0.6)
    u.uAlpha.value = alpha.current

    u.uTime.value = f.time
    u.uWarp.value = 0.02 + f.energy * 0.05 * params.reactivity
    u.uPulse.value = beatPulse(f) * params.reactivity + (f.drop ? 0.5 : 0)
    u.uRes.value.set(size.width, size.height)
  })

  return (
    <mesh frustumCulled={false} renderOrder={10}>
      <planeGeometry args={[2, 2]} />
      <primitive object={material} attach="material" />
    </mesh>
  )
}
