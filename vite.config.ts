import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: { port: 5183 },
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
})
