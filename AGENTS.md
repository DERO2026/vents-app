# AGENTS.md

## Supabase backend

This project runs entirely on [Supabase](https://supabase.com): Postgres database, Auth, Storage, and Realtime. It previously ran on InsForge; that migration is complete (`supabase/CUTOVER_PLAN.md` has the full history) — there is no InsForge code, config, or dependency left anywhere in this repo. Do not apply InsForge-specific instructions, patterns, or skills to this codebase.

- **Project:** VENTS (Supabase project ref `slrtjxtzhowhwhebjprv`, URL `https://slrtjxtzhowhwhebjprv.supabase.co`)
- **Client:** app code uses `@supabase/supabase-js` via `src/lib/supabase.ts` — session storage is Keychain-backed (`SecureStorage`) on native/Capacitor, `localStorage` on web.
- **Migrations:** `supabase/migrations/*.sql`, applied in order. A migration file's own header comment about whether it's "deployed to production" has repeatedly been found stale in both directions — always verify the live database directly (`pg_get_functiondef`, `pg_policies`, `information_schema`) rather than trusting the file's claim.
- **Credentials:** app code reads `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` from environment (`.env.local` locally, Vercel env vars in production); server-side API routes additionally use `PROJECT_ADMIN_DATABASE_URL`/`SUPABASE_JWT_SECRET` for privileged operations. Never hardcode or commit keys.

Key patterns:

- Database inserts take an array: `.insert([{ ... }])`.
- Reference users with `auth.users(id)` / `public.users(id)`; RLS policies gate on `auth.uid()`.
- Privileged mutations (admin actions, payments, refunds) are `SECURITY DEFINER` Postgres functions called via `supabase.rpc(...)`, not direct table writes — they do their own internal authorization check (`is_admin()`, `is_super_admin()`, ownership checks) rather than relying solely on RLS or on the function being reachable only from a "trusted" UI path.
- Storage uploads go to named buckets (e.g. `avatars`, `events`, `verification-docs`) via `supabase.storage.from(bucket)`; persist the resulting `url` (and `key`/path where the schema has a column for it).
- Admin dual-control (maker-checker) actions go through `request_admin_action` + `approve_admin_action` rather than calling an `admin_*` function directly from the client, so a second admin's approval is required and self-approval is blocked.
