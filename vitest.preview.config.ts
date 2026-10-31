import { defineConfig, configDefaults } from 'vitest/config';

// Compiles the app as a read-only Vercel Preview build (flags `true`) to
// test the real wiring in src/lib/supabase.ts and src/lib/paystack.ts.
// Runs as part of `npm test`; the main config excludes these files.
export default defineConfig({
  define: {
    __VENTS_VERCEL_PREVIEW__: 'true',
    __VENTS_PREVIEW_READ_ONLY__: 'true',
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.preview-build.test.ts'],
    exclude: configDefaults.exclude,
    env: {
      VITE_SUPABASE_URL: 'https://slrtjxtzhowhwhebjprv.supabase.co',
      VITE_SUPABASE_ANON_KEY: 'anon-key',
      VITE_PAYSTACK_PUBLIC_KEY: 'pk_test_preview',
    },
  },
});
