/**
 * Vite plugins that keep AGPL / non-commercial material out of a commercial
 * build. Both are no-ops when the Essentia flag (`VITE_ENABLE_ESSENTIA=1`) is
 * on, and both apply to `vite build` only (dev and vitest are untouched).
 * `scripts/check-dist-licences.mjs` independently asserts the result.
 *
 * Lives in a plain .mjs (typed by the sibling .d.mts) because the project's
 * TypeScript setup has no Node typings for `node:fs` / `node:path`.
 */
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

const STUB_ID = '\0audiovis:essentia-provider-stub'

/**
 * 1. The provider chunk. `src/audio/intel/index.ts` reaches the Essentia
 *    provider through a dynamic `import()` behind a build-time constant. Rollup
 *    prunes that branch, but Vite's worker plugin has already bundled and
 *    emitted the three `new Worker(new URL(...))` targets (and through them
 *    essentia.js) by the time tree-shaking runs - a dead import still pulls the
 *    graph in. So when the flag is off the import is redirected to an empty
 *    stub and the real provider (and its workers) is never even loaded.
 *
 * 2. The models. Vite copies all of `public/` into the output verbatim, and
 *    `public/models` holds the MusiCNN weights (CC BY-NC-SA 4.0, non-
 *    commercial). Remove `<outDir>/models` again once the bundle is finished.
 *    `public/` itself is never touched, and `<outDir>/tfjs` (Apache-2.0 tfjs
 *    wasm backend, needed later by a permissive model) is kept.
 *
 * @param {boolean} essentiaEnabled true when VITE_ENABLE_ESSENTIA === '1'
 * @returns {import('vite').Plugin[]}
 */
export function commercialGate(essentiaEnabled) {
  if (essentiaEnabled) return []
  let outDir = ''
  return [
    {
      name: 'audiovis:no-music-intel-provider',
      apply: 'build',
      enforce: 'pre',
      resolveId(source, importer) {
        const from = (importer ?? '').replace(/\\/g, '/')
        if (source === './EssentiaProvider' && from.endsWith('/src/audio/intel/index.ts')) {
          return STUB_ID
        }
        return null
      },
      load(id) {
        if (id !== STUB_ID) return null
        return 'export class EssentiaProvider { constructor() { throw new Error("music-intel provider excluded from this build") } }'
      },
    },
    {
      name: 'audiovis:strip-nc-models',
      apply: 'build',
      configResolved(config) {
        outDir = resolve(config.root, config.build.outDir)
      },
      closeBundle() {
        if (!outDir) return
        rmSync(resolve(outDir, 'models'), { recursive: true, force: true })
      },
    },
  ]
}
