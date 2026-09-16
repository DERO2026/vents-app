// QA-ONLY Vite config for visual-regression screenshotting. Completely
// separate from vite.config.ts (the real app build), never referenced by
// it, never used for `npm run build`/`npm run dev`. Aliases the real
// Supabase client module to a fake, fixture-backed one so real components
// render with zero network access and zero risk of touching Production.
import { defineConfig } from 'vite';
import path from 'path';
import react from '@vitejs/plugin-react';

const FAKE_SUPABASE_PATH = path.resolve(__dirname, 'fakeSupabase.ts');

export default defineConfig({
  root: path.resolve(__dirname),
  plugins: [react()],
  // A hand-rolled resolveId plugin here previously never actually fired
  // (confirmed empty across a fresh process + cleared node_modules/.vite
  // cache while investigating TicketRefundScreen.tsx hanging on a real,
  // sandbox-blocked network call instead of the fixture) -- every screen
  // that "passed" visual review before this only did so because its
  // initial render didn't block on that fetch. resolve.alias is Vite's own
  // documented mechanism for exactly this and is what actually resolves
  // for a relative "../../lib/supabase" specifier.
  resolve: {
    // Vite's RegExp alias does a substring .replace(), not a whole-match
    // swap -- an unanchored /\/lib\/supabase$/ against "../../lib/supabase"
    // only replaces the matched tail, leaving a mangled
    // "../.." + absolute-path specifier that then fails to resolve at all.
    // Anchoring at both ends makes the whole specifier the match.
    alias: [
      { find: /^(\.\.\/)*lib\/supabase$/, replacement: FAKE_SUPABASE_PATH },
      // Files that already live inside src/lib/ (serviceProviders.ts,
      // userWallet.ts, ...) import the client as a same-dir relative
      // './supabase' rather than '../../lib/supabase' -- the pattern
      // above never matches that specifier, so those files hit the real
      // (sandbox-blocked) network instead of the fixture, hanging on
      // "Loading..." or surfacing a raw fetch error in the UI.
      { find: /^\.\/supabase$/, replacement: FAKE_SUPABASE_PATH },
    ],
  },
  server: { port: 5199, strictPort: true, fs: { strict: false } },
});
