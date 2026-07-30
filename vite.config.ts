import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: { port: 5183 },
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
