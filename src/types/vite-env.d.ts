/// <reference types="vite/client" />

// Brings in Vite's `ImportMetaEnv` (`import.meta.env.DEV` and friends).
// Needed because tsconfig.json does not list "vite/client" in `types`, and the
// dev-only /bench route in App.tsx gates on `import.meta.env.DEV`.
