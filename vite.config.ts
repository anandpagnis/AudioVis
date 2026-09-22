import { loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
// Plain .mjs (with a .d.mts) because this repo's TS setup has no @types/node.
import { commercialGate } from './scripts/vite-commercial-gate.mjs'

export default defineConfig(({ mode }) => {
  // `VITE_ENABLE_ESSENTIA=1` (env var or .env.local) opts in to the AGPL
  // Essentia analysers + non-commercial MusiCNN models. Unset = commercial-safe
  // default. The same flag is read at runtime by src/audio/intel/index.ts.
  const essentia = loadEnv(mode, '.', 'VITE_').VITE_ENABLE_ESSENTIA === '1'
  return {
    plugins: [react(), ...commercialGate(essentia)],
    server: { port: 5183 },
    // The essentia worker lazy-imports the WASM core, so it is itself a
    // code-splitting build — which rules out the default 'iife' worker format.
    worker: { format: 'es' },
    test: {
      environment: 'node',
      include: ['src/**/*.test.ts'],
      globals: false,
    },
    build: {
      rollupOptions: {
        output: {
          // Keep the heavyweight libraries in their own long-cacheable chunks;
          // scenes and the AI layer split themselves via dynamic import().
          manualChunks: {
            three: ['three'],
            react: ['react', 'react-dom'],
            fx: ['@react-three/fiber', '@react-three/postprocessing', 'postprocessing'],
          },
        },
      },
    },
  }
})
