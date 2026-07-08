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
  base: './', // Vital for deployment
  assetsInclude: ['**/*.svg', '**/*.csv'],
  esbuild: {
    // Strip console.* and debugger statements from production bundles
    // so stack traces/debug output aren't shipped to the client.
    drop: mode === 'production' ? ['console', 'debugger'] : [],
  },
}))