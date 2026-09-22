import { NullProvider, type MusicIntelProvider } from './MusicIntelProvider'

export type { MusicIntelProvider, MusicIntelStatus } from './MusicIntelProvider'
export { NullProvider } from './MusicIntelProvider'

/**
 * The ONE place `AudioEngine` gets its music-intelligence provider from.
 *
 * `VITE_ENABLE_ESSENTIA === '1'` selects the Essentia provider (AGPL code +
 * non-commercial MusiCNN models - internal / local-dev builds only). Anything
 * else, including unset, selects `NullProvider`.
 *
 * The Essentia provider is pulled in with a DYNAMIC `import()` inside a branch
 * whose condition Vite resolves at build time (`import.meta.env.X` is inlined
 * as a literal). With the flag off the branch is dead, Rollup drops the import,
 * and neither `essentia.js`, the essentia/voice/structure workers nor tfjs ever
 * reach `dist/` (vite.config.ts also drops `dist/models`, and
 * scripts/check-dist-licences.mjs fails the build if any of it leaks).
 *
 * Local dev: put `VITE_ENABLE_ESSENTIA=1` in `.env.local` (see .env.example).
 *
 * Never rejects: a failed chunk load degrades to `NullProvider`, the same
 * fail-soft path as a missing worker.
 */
export async function createMusicIntelProvider(): Promise<MusicIntelProvider> {
  if (import.meta.env.VITE_ENABLE_ESSENTIA === '1') {
    try {
      const { EssentiaProvider } = await import('./EssentiaProvider')
      return new EssentiaProvider()
    } catch (err) {
      console.warn('[audio] Essentia provider failed to load; running without it', err)
    }
  }
  return new NullProvider()
}
