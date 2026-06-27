/// <reference types="vite/client" />

// Public app env vars must be prefixed VITE_* — Vite inlines them at
// build time. Add per-var typing here so consumers get checked access.
interface ImportMetaEnv {
  /** Source URL for the stats_duck DuckDB extension (see statsDuckUrl.ts). */
  readonly VITE_STATS_DUCK_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
