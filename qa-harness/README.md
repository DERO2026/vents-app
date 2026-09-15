# VENTS QA Harness (visual regression, no Production access)

Renders the REAL app components with fixture data, never touching
Production Supabase/Paystack. Kept for future redesign passes (items
18-21 of `VENTS_REDESIGN_IMPLEMENTATION_CHECKPOINT.md` are far from
finished) rather than deleted after one use.

## What it is
- `vite.harness.config.ts` — separate Vite config, own port (5199),
  redirects any `.../supabase` import to `fakeSupabase.ts` via a
  `resolveId` plugin. Never referenced by the real `vite.config.ts`.
- `fakeSupabase.ts` — a minimal chainable `.from(table).select()...`
  mock returning static fixture rows. Extend `FIXTURES` for more tables
  as needed.
- `.env` — fake, non-functional, clearly-labeled values so
  `createClient()` doesn't throw. Real queries fail (no network to a
  fake host), which is itself useful: it exercises each screen's loading/
  error states for free.
- `main.tsx` — add a new screen by importing the real component and
  adding an entry to `SCREENS`, matching its real props interface exactly
  (check the component's own `interface ...Props` first).
- `screenshot.mjs` — CLI: `node qa-harness/screenshot.mjs <screen> <width> <height> <outPath>`

## Running it
```
npx vite --config qa-harness/vite.harness.config.ts --port 5199
# in another shell:
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node qa-harness/screenshot.mjs home 390 844 /tmp/out.png
```
Playwright is installed globally in this environment, not as a project
dependency — `screenshot.mjs` imports it via its absolute path
(`/opt/node22/lib/node_modules/playwright/index.mjs`). Adjust if running
elsewhere.

## Safety
- Never mutates anything -- `fakeSupabase.ts`'s `.rpc()` always returns
  `{ data: null, error: null }`, no writes of any kind are possible.
- Never touches real Production credentials -- `.env` here is separate
  from the repo's real `.env.production` and is never read by the real
  build (`vite.config.ts` doesn't know this directory exists).
- Not part of `npm run build`/`npm run dev` -- entirely opt-in, separate
  config, separate port.
