// QA-ONLY Vite config for visual-regression screenshotting. Completely
// separate from vite.config.ts (the real app build), never referenced by
// it, never used for `npm run build`/`npm run dev`. Aliases the real
// Supabase client module to a fake, fixture-backed one so real components
// render with zero network access and zero risk of touching Production.
import { defineConfig } from 'vite';
import path from 'path';
import react from '@vitejs/plugin-react';

const FAKE_SUPABASE_PATH = path.resolve(__dirname, 'fakeSupabase.ts');

function fakeSupabasePlugin() {
  return {
    name: 'qa-fake-supabase',
    resolveId(source: string, importer: string | undefined) {
      if (/(^|\/)supabase$/.test(source)) {
        console.log('[qa-fake-supabase] redirecting', source, 'from', importer);
        return FAKE_SUPABASE_PATH;
      }
      return null;
    },
  };
}

export default defineConfig({
  root: path.resolve(__dirname),
  plugins: [fakeSupabasePlugin(), react()],
  server: { port: 5199, strictPort: true, fs: { strict: false } },
});
