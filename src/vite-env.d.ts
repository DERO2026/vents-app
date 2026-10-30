/// <reference types="vite/client" />

// Compile-time flags from vite.config.ts (see src/lib/previewMode.ts).
// Both are `false` in production and native builds.
declare const __VENTS_VERCEL_PREVIEW__: boolean;
declare const __VENTS_PREVIEW_READ_ONLY__: boolean;
