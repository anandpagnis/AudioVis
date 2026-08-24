import { lazy } from 'react'

/**
 * Route-level code splitting.
 *
 * Both routes used to be statically imported by `App`, so one entry chunk
 * carried the landing tunnel, the whole HUD, every engine system and the store
 * — a visitor who read the landing page and left still downloaded the entire
 * visualizer, on top of Three itself.
 *
 * ## Only the visualizer is split, deliberately
 *
 * `Landing` stays a static import. It is the site's entry point, so every
 * visitor needs it immediately; splitting it out moved its code from the entry
 * chunk into a second request that cannot even *start* until the entry has
 * parsed, buying a round trip of blank screen in exchange for nothing. The
 * bytes a landing visitor downloads are the same either way — what F13 is
 * actually about is not shipping the *visualizer* to someone who never opens
 * it, and that needs exactly one lazy boundary.
 *
 * Note what route splitting cannot help with here: `three` (699 kB) and the
 * postprocessing chunk (239 kB) are shared, because the landing tunnel is
 * itself a WebGL scene with its own post chain. Those dominate the payload and
 * no amount of route splitting touches them.
 *
 * The loader lives in this module rather than inline in `App` so `Landing` can
 * warm the chunk (see {@link preloadVisualizer}) without importing `App` and
 * creating a cycle.
 */

/** Shared so the prefetch and the lazy component resolve to the SAME chunk. */
const loadVisualizer = () => import('./Visualizer').then((m) => ({ default: m.Visualizer }))

export const Visualizer = lazy(loadVisualizer)

/**
 * The scene cost benchmark (`/bench`). Developer tool — **null in production**.
 *
 * The ternary is load-bearing and is not the same as gating the <Route>. Vite
 * substitutes `import.meta.env.DEV` with the literal `false` at build time, so
 * the whole branch constant-folds away and Rollup never sees a reachable
 * `import('./Bench')` — no chunk is emitted.
 *
 * Gating only the route in App.tsx does NOT achieve that: the `import()` would
 * still sit unconditionally in this module, and Rollup emits a chunk for every
 * dynamic import it can reach whether or not anything renders it. That was the
 * first attempt here, and the benchmark shipped in `dist/`.
 */
export const Bench = import.meta.env.DEV
  ? lazy(() => import('./Bench').then((m) => ({ default: m.Bench })))
  : null

/**
 * Start downloading the visualizer chunk without mounting it.
 *
 * The landing CTA fades to black and *then* navigates, so a cold chunk fetch
 * would land inside that fade and the fade-in could reveal an empty Suspense
 * boundary rather than the app. Calling this while the landing page is idle
 * means the chunk is almost always resident before the user ever clicks.
 *
 * Safe to call repeatedly — module imports are cached, so subsequent calls
 * resolve from memory. Errors are swallowed: this is an optimisation, and a
 * failed prefetch must not break the real navigation, which will simply retry
 * the import.
 */
export function preloadVisualizer(): void {
  void loadVisualizer().catch(() => {})
}
