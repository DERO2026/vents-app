import { defineConfig } from 'vite'
import path from 'path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    // Pinned to match .claude/launch.json's expected port — without this,
    // Vite defaults to 5173 (or auto-increments if taken) while the preview
    // harness proxies 5175, causing chrome-error://chromewebdata/ regardless
    // of app code correctness.
    port: 5175,
    strictPort: false,
  },
  base: './', // Vital for deployment
  assetsInclude: ['**/*.svg', '**/*.csv'],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom'],
        },
      },
    },
  },
  esbuild: {
    // Strip debugger statements from production bundles. console.* is
    // intentionally NOT stripped — console.error calls are the only
    // diagnostic trail we have for live auth/signup failures, and esbuild's
    // drop option can't selectively keep console.error while dropping
    // console.log, so we keep all of it rather than lose that visibility.
    drop: mode === 'production' ? ['debugger'] : [],
  },
}))