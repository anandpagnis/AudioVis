import { defineConfig } from 'vitest/config'

/**
 * Separate vitest project for the offline calibration harness
 * (`scripts/calibrate/`). Deliberately NOT part of `npm run check` — it decodes
 * real audio, pulls in a WASM MP3 decoder, and takes minutes. Run it on demand:
 *
 *   npm run calibrate
 *
 * With no audio present it runs only the synthetic sanity checks in
 * `unit.calib.ts` and skips the corpus harness.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['scripts/calibrate/**/*.calib.ts'],
    globals: false,
    testTimeout: 300_000,
    hookTimeout: 120_000,
  },
})
