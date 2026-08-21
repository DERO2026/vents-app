import { defineConfig, loadEnv } from 'vite'
import path from 'path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  // Every native (iOS/Android) build is produced locally via `npm run build`
  // + `cap sync` -- there is no CI/CD pipeline for this project. Unlike the
  // web deploy, which Vercel builds with its own Production env var
  // (overriding anything in the repo), a local production build silently
  // falls back to whatever VITE_PAYSTACK_PUBLIC_KEY is in the committed
  // .env.production -- which is a pk_test_ key. That is exactly how a
  // TestFlight build shipped with Paystack's yellow "TEST" banner: nothing
  // failed, it just silently built with the wrong key. Fail loud instead.
  if (mode === 'production') {
    const env = loadEnv(mode, process.cwd(), '');
    const paystackKey = env.VITE_PAYSTACK_PUBLIC_KEY || '';
    // Catches both the original failure (a committed pk_test_ value) and the
    // gap that opened once .env.production's key was cleared to close that
    // hole: an empty/missing key doesn't start with 'pk_test_', so it would
    // otherwise sail through this guard and build "successfully" -- just
    // with Paystack's popup silently refusing to open at runtime instead
    // (openPaystackPopup()'s own !publicKey guard is a console.error + a
    // quiet onClose(), not a build-time failure). Either case means the same
    // thing: no real key was supplied for this build.
    if (!paystackKey.startsWith('pk_live_')) {
      throw new Error(
        `[build guard] VITE_PAYSTACK_PUBLIC_KEY is ${paystackKey ? 'a pk_test_ key' : 'missing'} in a production build. ` +
        'Set the real pk_live_ key as an actual environment variable (export it in your ' +
        'shell, or via your CI secrets) before building for iOS/Android/TestFlight -- ' +
        'never put a live key in a committed .env file. Vercel\'s web deploy is unaffected: ' +
        'its own Production environment variable already overrides the committed value.'
      );
    }
  }
  return {
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
  };
})