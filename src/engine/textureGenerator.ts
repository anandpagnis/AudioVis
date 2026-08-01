import * as THREE from 'three'
import type { MoodState } from '../audio/types'

/**
 * Client for the local sd-turbo texture server (backend/server.py).
 * Everything is best-effort: if the server isn't running, the app quietly
 * stays fully procedural. Textures are cached by (mood, palette, variant)
 * both here and on the server's disk, so repeats are instant.
 */

const BASE = 'http://127.0.0.1:8787'
const POLL_MS = 700
const POLL_TIMEOUT_MS = 90_000 // first-ever generation includes model warm-up
const HEALTH_RECHECK_SEC = 20
const CACHE_MAX = 12
const MAX_TEX = 512 // hard cap on uploaded texture size — bounds the GPU spike

/** Live status for the debug panel. */
export const genStatus = {
  available: false,
  ready: false, // model loaded on the server
  pending: 0,
  lastKey: '',
  lastError: '',
}

const MOOD_PROMPTS: Record<MoodState, string> = {
  silence: 'minimal dark void, faint distant glow',
  ambient: 'soft ambient gradients, hazy diffuse glow, smooth drifting abstract forms',
  mellow: 'dreamy flowing silk, gentle waves of light, soft bokeh, ethereal abstraction',
  groove: 'rhythmic flowing curves, smooth neon waves, layered abstract patterns',
  building: 'spiraling energy streams, converging light trails, rising abstract motion',
  peak: 'explosive radiant light burst, intense abstract plasma waves, dramatic energy',
  aggressive:
    'fractured glitch shards, harsh electric arcs, chaotic abstract energy, high contrast',
}

const PALETTE_WORDS: Record<string, string> = {
  aurora: 'cyan violet and emerald green colors, aurora borealis hues',
  ember: 'burning orange crimson and gold colors',
  violet: 'lavender pink and indigo colors',
  ocean: 'deep blue cyan and cobalt colors',
  mono: 'monochrome silver white and black',
  solar: 'blazing yellow orange and vermilion colors',
}

const STYLE_VARIANTS = [
  'volumetric light, deep atmosphere',
  'iridescent, long exposure light painting',
  'smoke and mist, liquid metal sheen',
]

const SUFFIX =
  'abstract digital art, seamless texture, dark background, no text, no letters, no objects, no faces'

export function buildPrompt(state: MoodState, paletteId: string, variant: number): string {
  return [
    MOOD_PROMPTS[state],
    PALETTE_WORDS[paletteId] ?? '',
    STYLE_VARIANTS[variant % STYLE_VARIANTS.length],
    SUFFIX,
  ]
    .filter(Boolean)
    .join(', ')
}

class TextureGenerator {
  private cache = new Map<string, THREE.Texture>()
  private pending = new Map<string, Promise<THREE.Texture | null>>()
  private lastHealthAt = -1000

  /**
   * Textures the display layer is currently sampling. The cache must never
   * dispose one of these — doing so deletes the GL texture out from under a
   * live shader, which spams INVALID_OPERATION and can lose the WebGL context
   * (the "SD textures crash the app" bug). The consumer keeps this in sync.
   */
  readonly inUse = new Set<THREE.Texture>()

  /** Throttled health probe; flips genStatus.available/ready. */
  async checkHealth(): Promise<boolean> {
    const now = performance.now() / 1000
    if (genStatus.available && genStatus.ready) return true
    if (now - this.lastHealthAt < HEALTH_RECHECK_SEC) return genStatus.available
    this.lastHealthAt = now
    try {
      const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) })
      const j = (await res.json()) as { ok: boolean; ready: boolean }
      genStatus.available = !!j.ok
      genStatus.ready = !!j.ready
    } catch {
      genStatus.available = false
      genStatus.ready = false
    }
    return genStatus.available
  }

  /**
   * Get (or kick off) the texture for a mood/palette combo. Resolves null
   * when the backend is unavailable or generation fails — callers just skip.
   */
  async request(
    state: MoodState,
    paletteId: string,
    variant: number,
  ): Promise<THREE.Texture | null> {
    if (state === 'silence') return null
    const key = `${state}_${paletteId}_v${variant % STYLE_VARIANTS.length}`
    const cached = this.cache.get(key)
    if (cached) return cached
    const inFlight = this.pending.get(key)
    if (inFlight) return inFlight

    const p = this.generate(key, buildPrompt(state, paletteId, variant))
    this.pending.set(key, p)
    genStatus.pending = this.pending.size
    void p.finally(() => {
      this.pending.delete(key)
      genStatus.pending = this.pending.size
    })
    return p
  }

  private async generate(key: string, prompt: string): Promise<THREE.Texture | null> {
    if (!(await this.checkHealth())) return null
    genStatus.lastKey = key
    try {
      const res = await fetch(`${BASE}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, prompt }),
      })
      let j = (await res.json()) as { status: string; url?: string; error?: string }

      const deadline = performance.now() + POLL_TIMEOUT_MS
      while (j.status !== 'done') {
        if (j.status === 'failed') throw new Error(j.error ?? 'generation failed')
        if (performance.now() > deadline) throw new Error('generation timed out')
        await sleep(POLL_MS)
        const poll = await fetch(`${BASE}/status/${key}`)
        j = await poll.json()
      }

      // Decode off the main thread and downscale to MAX_TEX so the GPU upload
      // is a bounded, predictable cost — a full-size synchronous decode on an
      // already-saturated frame is what tipped the context into a crash.
      const imgRes = await fetch(`${BASE}${j.url}`)
      if (!imgRes.ok) throw new Error(`texture http ${imgRes.status}`)
      const blob = await imgRes.blob()
      const bitmap = await createImageBitmap(blob, {
        resizeWidth: MAX_TEX,
        resizeHeight: MAX_TEX,
        resizeQuality: 'high',
      })
      const texture = new THREE.Texture(bitmap)
      texture.needsUpdate = true
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping
      texture.colorSpace = THREE.SRGBColorSpace
      this.cacheSet(key, texture)
      genStatus.lastError = ''
      return texture
    } catch (err) {
      genStatus.lastError = err instanceof Error ? err.message : String(err)
      return null
    }
  }

  private cacheSet(key: string, tex: THREE.Texture) {
    if (this.cache.size >= CACHE_MAX) {
      // Evict the oldest texture that isn't currently on screen. Skipping the
      // in-use ones guarantees we never dispose a texture a live shader samples.
      for (const [oldKey, oldTex] of this.cache) {
        if (this.inUse.has(oldTex)) continue
        oldTex.dispose()
        this.cache.delete(oldKey)
        break
      }
    }
    this.cache.set(key, tex)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export const textureGenerator = new TextureGenerator()
