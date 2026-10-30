# VENTS → Supabase schema — APPLIED to Supabase, InsForge untouched

**Status: the schema is live on Supabase project `slrtjxtzhowhwhebjprv` ("VENTS"), fully verified against InsForge.** InsForge production remains completely untouched throughout (a manual backup, `pre-supabase-migration-audit`, still exists as a restore point from Step 1; every InsForge operation in this step was a read-only `SELECT`). The VENTS application still points at InsForge — **the backend connection has not been switched**, and **no application/production data has been migrated** — only the schema (tables, functions, constraints, indexes, RLS, triggers, grants) now exists on Supabase, empty of data.

## What actually happened

13 migrations were applied in order via `supabase db push` (list below). The apply was not a single clean pass — it surfaced and required fixing four real defects that only became visible once Postgres actually tried to execute the SQL, which is exactly why this was done as a staged, verified process rather than a one-shot script. Each is documented in detail further down. In summary:

1. **Array column type bug** (`0002_tables.sql`): InsForge's export tool rendered array columns as the literal (invalid) type name `ARRAY` instead of `text[]`, for `events.categories`, `events.gallery_urls`, `users.interests`. Fixed before first apply.
2. **Missing PRIMARY KEY / UNIQUE / CHECK constraints** (new `0005_primary_unique_check_constraints.sql`): the InsForge export tool never emitted these at all — not a parsing miss, a genuine tool limitation. Discovered when `0005_foreign_keys.sql` failed with "no unique constraint matching given keys for referenced table users." Reconstructed all 42 PKs, 18 UNIQUE constraints, and 43 CHECK constraints from a live, read-only query against InsForge's actual `pg_constraint` catalog. Several of the UNIQUE constraints are load-bearing for business logic, not just data hygiene — see below.
3. **Duplicate/fan-out trigger definitions** (`0009_triggers.sql`): 9 triggers were split into 2 lines each by the export (e.g. `trg_event_payout_account` appeared as both a separate `BEFORE INSERT` and `BEFORE UPDATE` trigger with the identical name) — an artifact of querying `information_schema.triggers`, which fans a single multi-event trigger out into one row per event. Merged back into single `BEFORE INSERT OR UPDATE` triggers, matching the real underlying object.
4. **A genuinely missing trigger**: `on_auth_user_created` (the trigger that provisions a `public.users` profile row on every signup) lives on `auth.users`, not any `public` table — entirely outside the scope of the public-schema-only export. Added by hand, verified against InsForge's live `pg_get_triggerdef()` output.
5. **`auth.users.email_verified` doesn't exist on Supabase** (`0004_functions.sql`): InsForge's `auth.users` has a custom `email_verified` boolean column; Supabase's standard schema uses `email_confirmed_at timestamptz` instead. Affected 5 functions, 7 call sites (`add_bank_account_confirmed`, `admin_get_new_user_stats`, `check_user_exists`, `is_email_verified`, `reclaim_unverified_signup`). Only 1 of the 5 (`is_email_verified`, `LANGUAGE sql`) failed loudly at apply time — the other 4 are `LANGUAGE plpgsql`, which doesn't validate body references until the function actually *runs*, so they would have deployed silently and broken the first time a real user hit them. Found by cross-referencing every `auth.users` column reference in the function bodies against Supabase's actual `auth.users` schema, not just fixing the one visible error.
6. **Extension functions/views leaked into the grants file**: InsForge installs `pgcrypto`, `pg_trgm`, `unaccent`, `pg_stat_statements`, and an `http` extension directly into `public` (not a dedicated schema like Supabase's `extensions`), so a broad grants-reconstruction query swept up 94 extension-owned functions and 2 extension-owned views as if they were app objects. Stripped (182 grant lines + 9 view-grant lines removed); confirmed none of them are actually called by any VENTS business logic (the `http` extension in particular — not enabled on Supabase, not needed).
7. **Supabase's default table privileges** (new `0012_fix_default_table_grants.sql`, `0013_fix_view_grants.sql`): Supabase automatically grants broad privileges — including `TRUNCATE` — to `anon`/`authenticated` on every new table at `CREATE TABLE` time. This is a platform default, not something any migration file requested, and it was **not** part of InsForge's actual grant state. Caught during post-apply verification: `anon`/`authenticated` had `TRUNCATE` on `tickets`, `pending_purchases`, and `organizer_bank_accounts` — `TRUNCATE` bypasses RLS entirely, so this would have let any client wipe those tables outright, a real regression from InsForge's actual security posture, not a cosmetic gap. Fixed by explicitly `REVOKE ALL ... FROM PUBLIC, anon, authenticated` on every table before re-affirming the exact InsForge-matching grants. Verified clean afterward: `TRUNCATE` now belongs only to `postgres`/`project_admin`/`service_role`, nowhere client-reachable.
8. **`0004_functions.sql` was reordered** (no live-database change — this was a file-only fix after the fact): the original export listed functions alphabetically, not in dependency order. `LANGUAGE sql` functions validate their references at `CREATE` time (unlike `plpgsql`, which defers), so several forward references failed on first apply (e.g. `admin_pending_request_count` calling `is_super_admin()`, defined later in the file). This was worked around live via `apply_functions_multipass.cjs` (iteratively retries functions that fail on a "does not exist" error until the dependency graph resolves — kept in this folder as a reusable fallback tool). The file itself has since been topologically resorted so a **fresh** `supabase db push` against an empty project would now succeed in one pass, without needing the side-channel script. No cycles were found in the dependency graph.

## Migration files (applied, in order)

| File | Contents |
|---|---|
| `0001_extensions_schemas_roles.sql` | `pg_trgm`, `unaccent` extensions; `private` schema; `project_admin` role |
| `0002_tables.sql` | 42 tables — columns, defaults, types (array-type bug fixed) |
| `0003_private_schema.sql` | `private.app_secrets` table (HMAC secret placeholder — see below) |
| `0004_functions.sql` | 155 functions/RPCs (`email_verified`→`email_confirmed_at` fix; dependency-reordered) |
| `0005_primary_unique_check_constraints.sql` | 42 PKs, 18 UNIQUE, 43 CHECK constraints — reconstructed, not from the export |
| `0006_foreign_keys.sql` | 51 FK constraints |
| `0007_indexes.sql` | 71 indexes (89 exported minus 18 that duplicated UNIQUE-constraint backing indexes) |
| `0008_rls_and_policies.sql` | RLS enabled on 40/42 tables + 84 policies |
| `0009_triggers.sql` | 24 triggers (32 exported lines, 9 fan-out duplicates merged; `on_auth_user_created` added by hand) |
| `0010_views.sql` | `public_profiles` view |
| `0011_grants.sql` | Function `EXECUTE` + table DML grants, reconstructed from InsForge's live privilege state (94 extension-function and 2 extension-view leaks stripped) |
| `0012_fix_default_table_grants.sql` | Strips Supabase's default `TRUNCATE`/etc. grants, restores exact InsForge-matching table privileges |
| `0013_fix_view_grants.sql` | Same fix for the `public_profiles` view |

## Production migration history: out-of-band applies

Later migrations are normally applied with the Supabase MCP `apply_migration` tool, which records a row in `supabase_migrations.schema_migrations` with a **timestamp** version (e.g. 0197 = `20261027210120 vents_earn_notifications_use_valid_type`), not the `NNNN` file number. Never use `supabase db push` against production: history and filenames don't line up. Migrations applied any other way leave no history row, and are recorded here.

- **`0198_notifications_type_check_allow_announcement.sql`: applied manually, history reconciled.**
  - Run manually in the Supabase dashboard SQL Editor on **2026-10-28** (Postgres log: `2026-10-28T05:35:40Z`, `source: dashboard`). This was a hand-formatted equivalent of the file: the same constraint (original 8 types + `'announcement'`) and the same `DROP FUNCTION public.send_event_reminders()`.
  - The missing history row was then backfilled with a history-only, guarded insert (no DDL re-run): version **`20261028053540`**, name **`notifications_type_check_allow_announcement`**, `statements` = this file verbatim at `main` `ffa4a25` (md5 `009d1108e8df47e70f9d01fd57846226`), `created_by` NULL.
  - Do **not** re-apply this migration. Its `DROP FUNCTION` would fail on the already-dropped function. Do not edit the file either: the history row stores its exact text.
- **`0195_direct_messages_storage_private_access.sql`: applied manually, history reconciled.**
  - PR #64 merged the file on 2026-10-27 at 15:51 UTC and stated it was *not* applied to the live database.
  - Run manually in the Supabase dashboard SQL Editor on **2026-10-27 at 16:06:49 UTC** (Postgres log: `2026-10-27T16:06:49Z`, `source: dashboard`). This was a hand-formatted equivalent of the file: the same `UPDATE storage.buckets SET public = false`, `DROP POLICY IF EXISTS` and `CREATE POLICY storage_objects_dm_select`.
  - Verified read-only on 2026-10-28 before reconciling: the bucket is private, and `storage_objects_dm_select` is `FOR SELECT`, permissive, `TO authenticated`, with no `WITH CHECK`. Its `USING` text is identical to what the file produces.
  - The missing history row was then backfilled with a history-only, guarded insert (no DDL re-run): version **`20261027160649`**, name **`direct_messages_storage_private_access`**, `statements` = this file verbatim at `main` `eadf414` (md5 `a0fb3ce3c245f74c5b956d4a2265ce57`), `created_by` NULL. It sorts between 0194 (`20261027012403`) and 0196 (`20261027201600`).
  - Do **not** re-apply this migration: it is already live and recorded. Do not edit the file either: the history row stores its exact text.

## Production apply records

- **`0199_private_realtime_user_and_dm_topics.sql`: applied with `apply_migration`, verified.**
  - Pre-apply, read-only (2026-10-29): the live `notify_new_direct_message`, `notify_new_notification` and `notify_vc_update` matched `0004_functions.sql` (all `private = false`; the DM broadcast carried `'body'`). `realtime.messages` had RLS enabled and no policies; `can_access_dm_realtime_topic` did not exist; there was no 0199 history row.
  - Client compatibility checked first: production deployment `dpl_Ht6sWCjFai2FfD5KfAiZPF23qvDT` (aliased to `getvents.com`) is built from `main` `5141f01` (PR #77). Its live bundle joins every `user:<id>` and `dm:<a>:<b>` channel with `{ private: true }`.
  - Applied on **2026-10-29 at 23:48:59 UTC** with the Supabase MCP `apply_migration` tool, using the file verbatim from `main` `5141f01`. History row: version **`20261029234859`**, name **`0199_private_realtime_user_and_dm_topics`**, `statements` md5 `a663e28a5d18d21f73e021a01a24b97b` (6,242 bytes). This is identical to the file.
  - Post-apply, read-only: all three triggers send `private = true` and the DM payload has no `'body'`. `can_access_dm_realtime_topic` is `SECURITY DEFINER`, `STABLE`, `search_path=""`, executable by `authenticated` only (not `anon`). The policies `vents_private_topics_receive` (SELECT) and `vents_private_topics_send` (INSERT) exist, both `TO authenticated`.
  - Behaviour probe on production (35/35 passed): a single `DO` block that always ends by raising an exception, so every write was rolled back. A follow-up read-only check found no leftover rows. It mirrored the authorization and broadcast checks of `scripts/local-pg-test/run-private-realtime-verification.sh`, run as the real `authenticated`/`anon` roles:
    - who can receive on and send into `user:` topics;
    - participant-only access to `dm:` topics;
    - blocking in both directions, and unblocking;
    - malformed topics refused;
    - one real DM insert proving the broadcast is private, goes to the recipient's topic and carries no body.
  - The notification trigger was verified only from its definition, not by inserting a row: `notifications` has a push trigger that makes an external HTTP call.
  - Known impact: iOS/Android builds made before PR #77 bundle JavaScript that joins public channels, so they stop receiving live DM, notification and typing events until updated. Messages still load when a thread is opened.
  - Do **not** edit the file: the history row stores its exact text. It can be re-run safely (`CREATE OR REPLACE`, `DROP POLICY IF EXISTS`), but there is no need to.

- **`0200_revoke_anon_execute_realtime_trigger_functions.sql`: applied with `apply_migration`, verified.**
  - Pre-apply, read-only (2026-10-30): `notify_new_direct_message()`, `notify_new_notification()` and `notify_vc_update()` each had ACL `{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,project_admin=X/postgres}` (no `PUBLIC` entry), owner `postgres`, bodies matching 0199 (`prosrc` md5 `be5ba97c…`, `d13b4873…`, `e67a241f…`), and their triggers (`trg_realtime_new_dm`, `trg_realtime_new_notification`, `trg_realtime_vc`) enabled. Latest history row was 0199 (`20261029234859`); 138 rows.
  - Reviewed and merged first: PR #79, merge commit `e2ffc0a`. Tested on local PostgreSQL with the same ACLs: applying it twice removed only `anon`, and the triggers still fired for inserts made as `anon` and as `authenticated` (Postgres does not check EXECUTE when a trigger fires).
  - Applied on **2026-10-30 at 01:40:37 UTC** with the Supabase MCP `apply_migration` tool, using the file verbatim from `main` `e2ffc0a`. History row: version **`20261030014037`**, name **`0200_revoke_anon_execute_realtime_trigger_functions`**, `statements` md5 `50bead46f2ea169a64b21803e0bbb2c0` (457 bytes). This is identical to the file. 139 rows.
  - Post-apply, read-only: all three functions now have ACL `{postgres=X/postgres,authenticated=X/postgres,project_admin=X/postgres}`. `anon` cannot execute them; `authenticated`, `project_admin` and `postgres` still can. Owner, bodies (same `prosrc` md5s) and enabled triggers are unchanged, and both 0199 `realtime.messages` policies are still present.
  - Not verified on production: no live DM, notification or VC transaction was sent after the apply to watch a trigger fire. That behaviour was only checked locally, as above.
  - Scope: only these three functions. Other `public` trigger functions still grant EXECUTE to `anon`, including the other `realtime.send` triggers (`notify_admin_stats_*`, `notify_door_*`, `notify_organizer_events_*`).
  - Do **not** edit the file: the history row stores its exact text. Re-running it is a no-op (revoking a privilege that is not held does nothing), but there is no need to.

- **`0201_vents_earn_representative_rewards.sql`: NOT applied.** Verified only against local Postgres: `scripts/local-pg-test/run-representative-rewards-verification.sh` (167 checks) and the payout-gate security audit `scripts/local-pg-test/run-payout-gate-audit.sh` (27 checks). Adds two `organizer_transactions` types and unique indexes for reward credits and reversals in the earnings wallet. Applying it patches the live `approve_admin_action` / `request_admin_action` in place (asserted anchors) and ships with payouts disabled. See `docs/vents-work-earn.md`.

## Architectural decision made here — still needs your sign-off

**`project_admin` is a real, narrowly-scoped Postgres role — not Supabase's `service_role`.** `service_role` bypasses RLS entirely, strictly more powerful than what these functions were designed to trust; substituting it would be a security *weakening*, which you explicitly asked me not to do for convenience. The cost: Supabase's PostgREST/RPC HTTP API only authenticates as `anon`/`authenticated`/`service_role` — it cannot assume a custom role. The Paystack webhook and payout endpoints will need a **direct Postgres connection** (`SET ROLE project_admin`) instead of the HTTP RPC calls they use against InsForge today. This is real application-code work for a later phase — flagged now as a known, deliberate decision.

## Full verification results (2026-08-14, post-apply, all read-only comparisons)

| Category | InsForge | Supabase | Match |
|---|---|---|---|
| Base tables | 42 | 42 | ✅ exact |
| Functions (excl. extension-owned) | 155 | 155 | ✅ exact |
| Foreign keys | 51 | 51 | ✅ exact |
| Primary keys | 42 | 42 | ✅ exact |
| Unique constraints | 18 | 18 | ✅ exact |
| Check constraints | 43 | 43 | ✅ exact |
| Indexes (excl. PK/UNIQUE backing) | 71 | 71 | ✅ exact |
| RLS-enabled tables | 40/42 | 40/42 | ✅ exact (same 2 excluded: `rate_limits`, `search_synonyms`) |
| RLS policies | 84 | 84 | ✅ exact |
| Triggers (public + `auth.users`) | 24 | 24 | ✅ exact |
| `project_admin` role | exists | exists | ✅ |
| `pg_trgm`, `unaccent` extensions | enabled | enabled | ✅ |
| `private.app_secrets` table | exists | exists | ✅ (secret value not copied — see below) |

**Security-sensitive payment/ticket logic — specifically verified:**
- `confirm_ticket_payment`, `credit_organizer_wallet`, `complete_organizer_payout`, `fail_organizer_payout`, `finalize_ticket_refund`, `fail_ticket_refund`, `_vc_deduct`, `notify_user`, `lift_expired_bans`, `send_event_reminders` — every one confirmed **`project_admin`-only** on Supabase (`anon`/`authenticated` both `EXECUTE: false`), matching InsForge exactly. Full 20-function `project_admin`-only list diffed name-for-name and signature-for-signature between InsForge and Supabase — identical.
- `tickets`, `organizer_bank_accounts`: `anon`/`authenticated` limited to `SELECT` only (no direct writes) — matches InsForge.
- `pending_purchases`: `anon`/`authenticated` have **zero** privileges — matches InsForge's `REVOKE ALL`.
- `direct_messages`: `anon` has `DELETE,INSERT,SELECT,UPDATE`, `authenticated` has `DELETE,SELECT,UPDATE` (no `INSERT`) — reproduces InsForge's exact asymmetric grant (insert only via the `send_direct_message` RPC).
- `TRUNCATE` privilege confirmed absent from `anon`/`authenticated` on every table after the `0012`/`0013` fix — only `postgres`/`project_admin`/`service_role` retain it.

## What's still deliberately NOT done

- **No application/production data migrated.** Schema only — every table is empty.
- **The application still connects to InsForge.** No backend switch has happened.
- **The HMAC secret is a placeholder.** `0003_private_schema.sql` creates `private.app_secrets` but does not insert a real `ticket_hmac_v2` value — inserting a freshly random one would invalidate every unscanned ticket already issued. Must be copied from InsForge's live value through a secure channel at actual cutover, never via git or chat.
- **Scheduled jobs.** Only `lift_expired_bans` is confirmed to run anywhere (InsForge's native hourly schedule). `_vc_deduct` and `notify_user` have no `pg_cron` equivalent set up yet — per the audit, needs a product answer on whether they're meant to be dormant before building one. `send_event_reminders` was dead (superseded by `run_event_reminder_sweep`, and its `'event_reminder'` type was rejected by `notifications_type_check`) and is dropped by `0198_notifications_type_check_allow_announcement.sql`.
- **`project_admin` connection wiring** in `api/webhook/paystack.ts` and the `api/wallet/*` payout endpoints — still calling InsForge's REST API today; needs the direct-Postgres-connection rework described above before cutover.
