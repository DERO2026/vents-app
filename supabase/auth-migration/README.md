# InsForge → Supabase Auth user migration

**Status: built and dry-run tested against real production InsForge data. Not executed in apply mode. No writes have been made to Supabase or InsForge by this script.**

## What this is

A one-time, standalone migration tool for the 25 real VENTS users, isolated in its own `package.json` (installs `pg` here only — the main app's dependency tree is untouched). See `migrate-auth-users.js` for full inline documentation; this file is the operator-facing quick reference.

## Scope

Migrates users where an InsForge `auth.users` row has a matching, **not deleted** `public.users` profile. Three exclusions are applied at the SQL level (not just validation), each one found by actually investigating the data rather than assumed upfront:

1. Accounts with no `public.users` profile at all (the account deleted via the email-scrambling `deleted_<id>@deleted.vents` pattern).
2. Accounts with `public.users.deleted_at IS NOT NULL` (accounts deleted via the app's normal `delete_own_account()` flow, which leaves the profile row in place with `status='deleted'`).
3. Accounts with `public.users.status = 'deleted'` even when `deleted_at IS NULL` — found by a full database sweep comparing `status` against `deleted_at` for every user: exactly one account (`michael.tomakpan@gmail.com`) was marked deleted through some path that never set `deleted_at`/`deleted_by`/`reason`. Relying on `deleted_at` alone would have silently migrated this user's live credentials despite their account being deleted.

**Both exclusions were verified against real data, not assumed.** The second one was in fact *discovered* by this script's own dry-run — the original audit's simpler "does a profile row exist" check missed 2 accounts (`testerboy3@gmail.com`, `ventsresendtest2026@mailinator.com`) that have profiles but are marked deleted. The audit's original count of 29 is corrected to **27** as a result.

## Usage

```bash
cd supabase/auth-migration
npm install

# Dry run — read-only against InsForge, reports exactly what would be
# written, opens no connection to Supabase at all
SOURCE_DATABASE_URL="<insforge connection string>" npm run dry-run

# Dry run that ALSO checks which of these already exist on Supabase
# (adds a read-only SELECT against the target — still no writes)
SOURCE_DATABASE_URL="..." TARGET_DATABASE_URL="<supabase connection string>" \
  node migrate-auth-users.js --dry-run --check-target

# Apply — actually writes. Requires BOTH the --apply flag AND the exact
# CONFIRM_APPLY value below; neither alone is sufficient.
SOURCE_DATABASE_URL="..." TARGET_DATABASE_URL="..." \
  CONFIRM_APPLY="YES-MIGRATE-AUTH" node migrate-auth-users.js --apply
```

`TARGET_DATABASE_URL` must be a role with `INSERT` privilege on the `auth` schema (e.g. Supabase's `postgres` superuser connection or `supabase_auth_admin`) — the `anon`/`authenticated` PostgREST roles cannot and should not be able to write there.

**Getting `TARGET_DATABASE_URL` right (two real gotchas hit while testing this):**
1. Use the **Session Pooler** connection string (Project Settings → Database → Connection string → "Session pooler", port `5432`), not "Direct connection". The direct `db.<ref>.supabase.co` host is IPv6-only and will fail to resolve (`ENOTFOUND`) from IPv4-only environments.
2. The pooler requires the username in `postgres.<project-ref>` format, not bare `postgres` — using bare `postgres` against the pooler host fails with `password authentication failed for user "postgres"` regardless of whether the password itself is correct. The dashboard's copy-paste string for the Session Pooler option already has this right; don't hand-edit the username out.
3. If the password contains special characters (e.g. `$`), percent-encode them in the connection string URI.

## Safety properties

- **Fail-safe validation**: every source record is checked (valid UUID, valid email, bcrypt-format password hash or legitimately-null for anonymous accounts, boolean `email_verified`, no duplicate ids/emails, not soft-deleted). **Any single failure aborts the entire run before touching the target at all** — no partial import, no silently-skipped bad record.
- **Idempotent**: checks the target for existing rows by `id` before inserting, and every `INSERT` additionally carries `ON CONFLICT DO NOTHING` as a second, SQL-level guard. Safe to re-run after a partial apply or as new users sign up on InsForge before final cutover.
- **Double-confirmation for writes**: `--apply` alone does nothing without `CONFIRM_APPLY=YES-MIGRATE-AUTH` also set. This is deliberate — a copy-pasted command missing the env var fails closed, not open.
- **Per-user transactions**: each user's `auth.users` + `auth.identities` insert is wrapped in one transaction, so a failure partway through never leaves a user half-imported (an auth row with no identity, or vice versa).

## Field mapping (see `mapToSupabaseUser`/`mapToSupabaseIdentity` in the script for the authoritative version)

| InsForge | Supabase `auth.users` | Notes |
|---|---|---|
| `id` | `id` | Preserved exactly — this is what keeps every FK in `public.*` intact |
| `email` | `email` | Preserved exactly, typos and all — this script does not "fix" user data |
| `password` (bcrypt) | `encrypted_password` | Copied verbatim — same algorithm, no reset needed |
| `email_verified` | `email_confirmed_at` | `true` → `created_at` as the backfill timestamp; `false` → `NULL` |
| `profile->>'name'` | `raw_user_meta_data.full_name` | Only set if present |
| `metadata` | `raw_app_meta_data` | Always `{}` — confirmed empty for every user |
| `is_anonymous` | `is_anonymous` | Direct |
| — | `auth.identities` row | One per user, `provider='email'`, `provider_id=<user id>` — required for Supabase email/password login, has no InsForge equivalent |
| — | `phone`, `phone_confirmed_at`, `banned_until`, `deleted_at` | Deliberately left `NULL` — InsForge never had phone auth, and app-level ban/delete state lives in `public.users`, out of scope here |

## Dry-run results (2026-08-14, against real InsForge production data, read-only)

25 of 25 records passed validation with zero errors (started at 27 → 26 after the `status='deleted'` finding below → 25 after the `portalfix-org` product-decision exclusion). Full per-user report (redacted password hashes) was reviewed by the operator in the same session this script was built.

## Individual investigation of every unverified / unusual / test-pattern account

Every one of the following was pulled up individually (email, status, username, role, full_name) and reviewed, not just flagged by pattern-matching:

| Account | Finding | Disposition |
|---|---|---|
| `5eca7da6-...` `michael.tomakpan@gmail.com` | `status='deleted'` but `deleted_at`/`deleted_by`/`reason` all `NULL` — deleted through a path that bypassed the normal delete flow. Confirmed via a full-table sweep that this is the *only* account where `status` and `deleted_at` disagree. | **Excluded** — script fixed to check `status` independently of `deleted_at` (§Scope item 3) |
| `c9eb5eb6-...` `ventsappltd@gmail.com` | Verified, `role='admin'`, `username='vents'` — this is the hardcoded platform Root/superadmin id from the original backend audit. | Included — real, verified, highest-privilege account; flagging for extra care at actual apply time, not exclusion |
| `9f0343c3-...` `ventss@gmail.om` | Typo domain (`.om` not `.com`). Correctly unverified — the invalid domain could never receive a real verification email, consistent with InsForge's own state. | Included as-is — real bcrypt credential, real signup attempt, not modified per instruction not to alter data |
| `93d25d66-...` `fedrickemmanuel329@gmail.comf` | Typo domain (trailing `f`). Also unverified, same reasoning. Note: `00a75bc6-...` (`fedrickemmanuel329@gmail.com`, no typo) is a **separate, verified account created 70 seconds later** — almost certainly the same person immediately correcting the typo and signing up again. | Both included as-is — two distinct real accounts/credentials, not a duplicate to merge |
| `9a7fd475-...` `portalfix-org-1784293549518@vents-test.local` | `.local` TLD + a timestamp-suffixed username pattern (`portalfix-org-<unix-ms>`) — this has the signature of an automated QA/test-suite signup, not a human. Unverified, no username, no full_name beyond "Portal Fix Test". | **Excluded** — confirmed with the account owner 2026-08-14; hardcoded in `PRODUCT_EXCLUDED_IDS` |
| `d7899317-...` `deboraholumorin05@gmail.com` (unverified) and `5f98cdd7-...` `deboraholumorin578@gmail.com` (verified, `role='organizer'`) | Same name pattern, 6 minutes apart on the same day — almost certainly one real person's abandoned-then-successful signup, same as the fedrickemmanuel pair above. | Both included as-is — no red flags beyond the ordinary "tried twice" pattern |
| `5effde4c-...` `jetatic971@luckfeed.com` | Unusual, less-common email domain. Verified, has a real profile (`username='james'`, `full_name='Peter'` — name/username mismatch is mildly odd but not disqualifying). Domain is not on any list this script checked against as known-disposable. | Included — no concrete evidence of being fake, just an unfamiliar domain |
| `838beb9c-...` `anascrespo@ymail.com` | `ymail.com` is a legitimate (if old/uncommon) Yahoo-family domain, not a red flag on inspection. | Included — no actual concern |
| `857d7606-...` `testerboy2@gmail.com` and `91b0afb4-...` `bbgbbg1357@gmail.com` (`username='testerboy'`, `role='organizer'`) | Test-sounding usernames, but **real gmail addresses, real bcrypt hashes, both verified** — unlike the 4 accounts already deleted from InsForge (which had fabricated UUIDs/reserved-TLD emails), these look like the team's own dogfooding/QA accounts made with real email addresses, not synthetic data. | **Kept** — confirmed with the account owner 2026-08-14; real working credentials, not synthetic data |

Both open decisions were resolved by the account owner on 2026-08-14: `portalfix-org` excluded, both `testerboy`-named accounts kept. Re-run dry-run confirmed 25 of 25 records pass with the `portalfix-org` exclusion applied and `testerboy2@gmail.com`/`bbgbbg1357@gmail.com` present in the "would import" list.

## Target verification (`--check-target`, 2026-08-14, read-only)

Ran `--dry-run --check-target` against the real, linked Supabase project (`slrtjxtzhowhwhebjprv`). Read-only `SELECT id FROM auth.users WHERE id = ANY(...)` against the target, no writes. Result: **0 of the 25 already exist on Supabase, all 25 would be newly inserted** — expected, since the project's `auth.users` has no data yet. Independently re-confirmed `auth.users` is still 0 rows via the separate Management API path (not the same code path the script used) immediately after, to verify the check-target run itself made no writes.

## First `--apply` attempt (2026-08-14) — blocked by a real schema bug, safely, no data written

Ran with `CONFIRM_APPLY=YES-MIGRATE-AUTH`. Failed on the very first user's insert (`blessingjackson442@gmail.com`) with:

```
error: record "new" has no field "metadata"
```

**Root cause was in the earlier-applied Supabase schema, not this script.** `public.handle_new_user()` (the `AFTER INSERT ON auth.users` trigger that provisions the matching `public.users` profile) was ported verbatim from InsForge during the schema migration and still referenced `NEW.metadata` — an InsForge-specific column that doesn't exist on Supabase's real `auth.users`. `plpgsql` doesn't validate a trigger body's column references until it actually fires, so this shipped silently in the original schema apply and only surfaced now, on the first-ever real `INSERT INTO auth.users` in this project's lifetime. **This bug would have broken every future real signup on Supabase, not just this migration.**

Verified before touching anything: `auth.users`, `auth.identities`, and `public.users` were all confirmed still **0 rows** — this script's per-user transaction wrapping rolled back cleanly, no partial write.

**Fix (confirmed with the account owner before applying):** `NEW.metadata` → `NEW.raw_app_meta_data`. Behavior-identical — the audit already confirmed InsForge's `metadata` column was empty for every single user, and this script sets `raw_app_meta_data` to `{}` for every migrated user too, so the `role` check inside the trigger evaluates to `'attendee'` either way, matching current production behavior exactly. Applied live to Supabase, verified via `pg_get_functiondef`, and backported into `supabase/migrations/0004_functions.sql` so a fresh schema apply elsewhere doesn't reintroduce it. Re-confirmed all three tables still 0 rows immediately after the fix — it touched only the function definition.

**`--apply` was not resumed** — the account owner asked for the fix only, not an immediate retry. No auth data has been written to Supabase. Resume with the same `--apply` command whenever ready.
