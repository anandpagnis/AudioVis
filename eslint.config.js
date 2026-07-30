import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

/**
 * Lint config for AudioVis.
 *
 * Tuned for a real-time render loop, which breaks a few assumptions the stock
 * React/TS presets make. Where a rule is relaxed the reason is stated inline —
 * none of these are "the linter was annoying", they are cases where the rule is
 * actively wrong for this codebase.
 */
export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'audiovis-core', 'backend'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,

      // --- Rules relaxed for the render loop -----------------------------------
      // This app drives ~60fps WebGL. Audio features and visual state are held in
      // mutable objects that scenes read and write inside useFrame, deliberately
      // never through React state — pushing per-frame values through React would
      // re-render the tree 60x/s and is the single thing this architecture exists
      // to avoid. The four rules below all encode the opposite assumption, so
      // they fire on correct code. Each is off for a specific, stated reason, not
      // because it was noisy.

      // Fires on `mat.opacity = …`, `u.uBass.value = …` etc. inside useFrame —
      // i.e. on every scene in the project. Mutating materials and uniforms in
      // place IS the design; allocating new ones per frame would thrash the GPU.
      'react-hooks/immutability': 'off',

      // Fires on Math.random() inside useMemo(..., []) initializers, which scenes
      // use to generate a per-mount particle/shard distribution. Memoized with an
      // empty dep list, so it is computed once and never recomputed; the rule's
      // "unstable across re-renders" concern does not apply.
      'react-hooks/purity': 'off',

      // Fires on SceneManager reading entriesRef.current during render. That is
      // intentional: it mutates the entry list in useFrame and then calls an
      // explicit force-update, so the render always follows a deliberate
      // invalidation rather than relying on React to notice the mutation.
      'react-hooks/refs': 'off',

      // Scenes construct geometries/materials/render targets in useMemo(..., [])
      // and hand them to useDispose for the component's whole life. Adding the
      // "missing" deps would rebuild GPU resources mid-performance, which is the
      // exact stutter the engine is built to avoid. Kept as a warning so genuine
      // stale-closure bugs in non-scene code still surface.
      'react-hooks/exhaustive-deps': 'warn',
      'react-hooks/use-memo': 'warn',

      // Several engine modules intentionally export a component plus the mutable
      // singleton it drives (SceneManager + SceneFade, PerfMonitor + perf). That
      // pairing is the point; it only costs HMR granularity in dev.
      'react-refresh/only-export-components': 'off',

      // Unused args are common in R3F callbacks that destructure only part of
      // the frame state ({ camera } out of many fields). Enforce on variables,
      // allow on args, and allow a leading underscore as explicit intent.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'none',
          varsIgnorePattern: '^_',
          caughtErrors: 'none', // `catch {}` is used deliberately for best-effort cleanup
        },
      ],
    },
  },
  {
    // GLSL uniform blocks are typed as index signatures by three, so reading
    // them back requires a cast. Confined to scenes, where it is idiomatic.
    files: ['src/scenes/**/*.tsx'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
)
