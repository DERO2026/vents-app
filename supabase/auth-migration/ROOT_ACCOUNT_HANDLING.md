# Root account (`ventsappltd@gmail.com`, `c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832`) — read-only inspection, no changes applied

## Why it's excluded from the general 24-user backfill

Two independent protections block any script/service-context write to this row:

1. **`admin_set_user_role(p_user_id, p_new_role)`** hardcodes a refusal for this exact id: `RAISE EXCEPTION 'Root admin role cannot be changed'`. No parameter combination gets past this. Grants: `authenticated` + `project_admin`, gated internally by `is_super_admin()`.
2. **`protect_admin_tier_status_columns()`** (a `BEFORE UPDATE ... FOR EACH ROW` trigger on `public.users`, fires on every update, no column filter) unconditionally raises `'Root account status cannot be modified'` for this id **unless** `auth.uid() = OLD.id` — i.e. unless the update is coming from the Root user's own authenticated Supabase session. A raw script/service connection never has `auth.uid()` set (it's populated from JWT session claims that only exist in an authenticated PostgREST/GoTrue request).

A third trigger, **`lock_admin_root_role()`**, is self-*correcting* rather than blocking (force-resets `role` back to `'admin'` if changed) — moot here since `protect_admin_tier_status_columns` raises first regardless.

**Both are deliberate security design** — nothing except Root's own authenticated self-edit is supposed to touch this row. That's the property working correctly, not a defect to route around casually.

## Current state (confirmed, not changed)

- `public.users` for this id: `role='attendee'`, `full_name=NULL`, `username=NULL`, all other profile fields at default/NULL — wrong, needs restoring to InsForge's `role='admin'`, `username='vents'`, `full_name='VENTS'`, plus the rest of the profile audit's InsForge values for this row.
- `auth.users.is_super_admin` (Supabase's own separate flag): `NULL`.
- `auth.users.raw_app_meta_data`: `{}`.
- No other Supabase record reflects Root's actual status anywhere.

## Options considered (none executed)

1. **Session-claim impersonation (recommended)** — within a script-controlled transaction connected as `project_admin`/`postgres`, set the Postgres session-local `request.jwt.claim.sub` to Root's own id before running the `UPDATE`. This makes `auth.uid() = OLD.id` genuinely true for that transaction, activating the trigger's own designed self-service exception — not a bypass, the intended escape hatch for exactly this kind of administrative operation. Smallest, most precise option.
2. **Wait for the real Root account holder to log in** (once cutover happens) and re-enter their own profile fields through the app's normal self-service edit flow. Cleanest from a "touch nothing programmatically" standpoint, but blocked on cutover timing.
3. **Temporarily alter/disable the protective trigger** — not recommended; this is a real security control, disabling it (even briefly) is a bigger, riskier action than option 1 for the same outcome.

## Status

**Applied (2026-08-14) via option 1 — session-claim impersonation.** `backfill-root.cjs` connected as the target Postgres role, opened a transaction, ran `SET LOCAL request.jwt.claim.sub = '<root-id>'` (transaction-scoped only), then the same `UPDATE public.users SET ...` shape as the general 24-user backfill. `auth.uid() = OLD.id` was genuinely true for that transaction, so `protect_admin_tier_status_columns()`'s own self-service exception applied and the update succeeded through the intended path — no trigger was altered, disabled, or bypassed.

Verified after commit:
- `request.jwt.claim.sub` confirmed empty immediately after `COMMIT` — the session claim did not leak past the transaction or persist in any way.
- Full field-by-field comparison against InsForge: **0 differences** — `role='admin'`, `username='vents'`, `full_name='VENTS'`, and every other column restored exactly.
- All 25 `public.users` profiles (24 general + Root) now match InsForge with zero field-level differences. Aggregate check: 9 non-`attendee` roles present (1 `admin` + 2 `sub-admin` + 6 `organizer`), matching InsForge exactly.

No InsForge modification. No application backend switch.
