import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  // Same constants as vite.config.ts; tests run as a non-preview build.
  define: {
    __VENTS_VERCEL_PREVIEW__: 'false',
    __VENTS_PREVIEW_READ_ONLY__: 'false',
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}', 'api/**/*.test.{ts,tsx}'],
    // Compiled as a Preview build by vitest.preview.config.ts instead.
    exclude: [...configDefaults.exclude, 'src/**/*.preview-build.test.ts'],
    globals: true,
  },
});
