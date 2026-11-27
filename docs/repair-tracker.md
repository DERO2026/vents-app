# VENTS repair tracker (A–Z audit, 2026-11-26)

Source: the A–Z audit of `main` at `815ec94` (31 findings), plus the open items from the earlier lifecycle audit (OEL) and checkout audit (CF).

## P0 incident: website username login (2026-11-27)

- **Symptom:** "We couldn't verify your login right now. Please check your connection and try again." on getvents.com, for username logins only.
- **Root cause (production API logs):**
  - Since #125 (26 Nov) the website calls `resolve_login_email`, which migration 0227 creates.
  - 0227 is not applied in production, so every call returned **404** (6 between 14:05 and 14:36 UTC on 27 Nov, all with referer getvents.com). The login screen mapped that to the generic message above.
  - Email login was never affected (`/auth/v1/token` 200).
  - The installed iOS app (pre-#125 build, no referer) still logs in by username through `resolve_username_to_email` (200), because **0228 is not applied either**.
- **Fix (code only, no migration):** `src/lib/loginLookup.ts`.
  - The website falls back to the pre-0227 lookup, and the pre-0227 status check, **only** when the server says the 0227 function does not exist (PGRST202 / 404 / 42883).
  - Other failures are reported honestly:
    - network: "couldn't reach the server";
    - lookup service down: "username login temporarily unavailable, use your email".
  - No-account and wrong-password are still the same generic answer.
  - The H2 test now allows the old lookups only behind that guard.
- **Permanent fix (needs approval):** apply 0227 after the read-only state check. The fallback then never runs. Apply 0228 (D7) only after 0227 **and** after the store apps are updated, or installed apps lose username login.

## Financial safety follow-up: transfer fees (2026-11-27)

Found by the read-only production investigation (owner-authorized):
- Live `confirm_transfer_fee_payment` is 0043's version with one untracked edit, `p_amount_kobo < fee_kobo` instead of strict equality. The owner keeps that rule.
- **0064 was never applied** (none of its four refund functions exist).

**Code fixes (no migration):**
- **False refund promise (P0, user-facing).** When a paid fee couldn't complete the transfer, the verify path told the payer "a refund has been started automatically and should appear on your statement shortly". In production nothing was started or recorded.
  - Every outcome now states only what the database recorded: `not_recorded` means "No refund has been started yet", with the payment reference and a pointer to support; `pending_review` is used only when a payment exception exists.
  - The response also returns `reference` and `refundState`.
  - The message helper defines six states (`api/_lib/transferFeeRefundMessages.ts`): not recorded, pending review, approved, submitted to Paystack, succeeded, failed. None promises a date.
- **Unrecognised answers are no longer successes.** The verify path used to report any unrecognised answer as a success. Now only `confirmed` and `already_paid` succeed.
- **No automatic transfer-fee refunds.** Two administrators are required. The webhook's automatic Paystack refund for 0064's `:refund_claimed` answer is removed; it never ran in production.
- **Refund-event chain (pre-existing bug).** With 0064 absent, `finalize_/fail_transfer_fee_refund` raised 42883 and the webhook answered 500 for every refund event that wasn't a ticket refund. Service-booking refunds could therefore never be finalized. A missing function now counts as `not_found` and the chain continues; any other error still returns 500.
- **0239's overpayment answer.** The parser understands `:excess_refund_queued`. My Tickets shows "transfer complete, extra amount recorded for refund".

**Tests:** `transferFeeRefundPolicy.security.test.ts` covers expired, cancelled, declined, not-pending, ineligible, not-found, underpaid and duplicate payments, on both entry points, plus unknown answers, overpayment and the refund-event chain. 20 of the new tests fail on the old webhook. `transferFeeRefundMessages.test.ts` covers the messages.

## P0 incident: Coming Soon publish, `sales_open_at` schema error (2026-11-27)

This is audit finding **H4**, now observed live.

- **Symptom:** on Create Event → Preview, "Could not find the 'sales_open_at' column of 'events' in the schema cache" appeared under a green "Ready to publish!", and the button still offered "Publish as Coming Soon".
- **Root cause:** migration **0224 is not applied in production**. It is a missing column, not a stale schema cache.
  - 0224 is the only migration that adds `events.sales_open_at`. It also adds:
    - the `coming_soon` status,
    - `open_event_sales` / `open_due_event_sales`,
    - the sale-alert functions,
    - pg_cron.
  - Production API logs (27 Nov):
    - Coming Soon inserts: 400.
    - `get_my_event_sale_alert_counts` (a 0224 function): **404**. A stale cache would not make a function disappear.
    - Normal publishes: 201.
    - 0221's `show_attendance_count` is accepted, so 0221 is applied and the gap starts at 0224.
- **Who was affected:**
  - Coming Soon / scheduled sales only. "Open now" publishing never sends `sales_open_at` and was unaffected.
  - The Home "Coming Soon" rail and the dashboard's sale schedule read the column too. Both already fail quietly (empty list), but they add 400s to the logs.
- **No partial records:** the insert is a single statement, so each rejected publish created nothing (no event row and no ticket tiers). Nothing needs cleaning up.
- **Fix (code only, no migration):** `src/lib/comingSoonSupport.ts` and `CreateEventScreen.tsx`.
  - On Preview, a one-row read of `sales_open_at` checks whether the database supports Coming Soon (once per session). If it doesn't, Coming Soon is not offered and the organizer sees "Scheduling ticket sales for later (Coming Soon) isn't available yet".
  - If a publish is rejected for the missing 0224 schema:
    - the banner says **"Not published"** (never "Ready to publish!");
    - the message is plain language ("Coming Soon isn't available yet, so your event was not published…"), never the raw schema text;
    - Coming Soon is withdrawn and the form returns to "Open now".
  - Any other failure also shows "Not published" with its own message. Other schema-cache errors get a generic "needs an update on our side; nothing was published".
- **Tests:**
  - `CreateEventScreen.comingSoonUnavailable.test.tsx` (6 tests) runs the real wizard, flyer gate included, against a mock that answers as production does. It covers:
    - normal publish;
    - the probe hiding the option;
    - the rejected Coming Soon publish;
    - re-publishing as "Open now";
    - Coming Soon on a 0224 database (status `coming_soon` plus the UTC sales time);
    - a non-schema failure.
  - Four of the six fail on the unfixed screen.
  - `comingSoonSupport.test.ts` covers error detection, message mapping and probe caching.
- **Permanent fix (needs approval):** apply **0224** after the read-only migration-state check. Once it is applied, the probe succeeds and Coming Soon reappears with no further deploy.
  - 0224 also enables **pg_cron** and schedules `open_due_event_sales` to run every minute. That is part of the approval.
  - 0225 (H3) is **not** needed for this bug and does not depend on 0224: its rule only accepts `live` / `published`, with or without the `coming_soon` status. It stays a separate approval.

## Batch 1: financial integrity and access hardening (2026-11-27)

- **Policy update (owner, 2026-11-27):** transfer-fee refunds also need two admins.
  - Migration **0238** queues them as payment exceptions; nothing is refunded automatically.
  - Owed refunds that never started are backfilled into the queue.
- **Production readiness:**
  - read-only state check: `scripts/ops/batch1-migration-state-check.sql` (tested, 35 checks; not yet run on production);
  - windows: W1 0226 if missing; W2 0233 → 0234 → 0238 together; W3 0235–0237;
  - reverse-order-only undo guards;
  - backup steps in `docs/batch1-financial-security.md` §1–§5.

Full detail, prechecks and the approval request: `docs/batch1-financial-security.md`.

- **Code merged and deployed with the web app. Migrations 0233–0237 are NOT applied to production.** Until they are, AZ-08, AZ-10, AZ-32, AZ-16 and AZ-33 are fixed in code only.
- **AZ-09 correction:** the payout-reject race is already closed in production's function (atomic claim, captured 2026-10-30). The audit compared against the older 0124 body. A concurrency suite with a mutation check proves it; no migration is needed. 0187 must still never be applied.
- **Local suites:**
  - reject concurrency: 43/43
  - transfer-fee attempts (0233): 56/56
  - two-admin refunds (0234): 68/68
  - access hardening (0235–0237): 50/50
- **Static CI guards:** `src/lib/batch1FinancialSecurity.security.test.ts`.

## Current state (consolidation, 2026-11-27)

Supersedes the "Verified state" section below, which describes `main` at `8663202`.

- **`main` = production = `818d0df`** ("Merge pull request #134"). `getvents.com` → `dpl_8RKLbddeS7JTdz892r3sbt9oXwHU` (READY, built from `818d0df`). No Vercel runtime errors in the 24 hours before the check.
- **Merged since `8663202`:** #128 (post-merge audit docs), #129 (N1, 0230), #130 (N2, 0232), #131 (N3, 0231), #132–#134 (backup tooling). No open PRs.
- **Branch consolidation (patch content compared with `main`):** nothing completed is left off `main`.
  - Superseded by merged work: `claude/amazing-knuth-72smkr` (0220/0221 identical on main), `prep/f15-f16-f21-vc-pool-accounting` (0170 identical), `feat/centralize-promotion-pricing` (#30), `claude/admin-send-announcement` (0191 identical), `claude/awesome-pascal-adus2b` (0198 identical), `claude/hopeful-gates-dmxdkb` (`89b1ccd`), `claude/payout-incident-batch-d` (#84, ported and closed).
  - Kept off `main` on purpose: `claude/o4-cloud-rehearsal` and `claude/prod-visual-check` (throwaway rehearsals); `claude/project-thread-oesvkg` (speculative `exploreTab` change its own commit says has no visible effect; bug never reproduced).
- **Production database:** migration state for 0180–0232 is still **unknown** (no production query made). Nothing has been applied since the records in the migration register.
- **Backups:** the scheduled backup has failed since 10 Nov (missing `BACKUP_ENCRYPTION_PASSPHRASE`). The last good artifact (run #22, 11 Nov) expires 2026-12-11.

### Registration pause (AZ-50)

- **Mechanism:** the production row `app_config.disable_signups = true`. Not code, an environment variable, a feature flag or a deployment.
- **Who could set it:** only the root account. The `app_config` update policy and `admin_update_app_config` have required `is_root()` since 0083/0124 (Sept 2026); no migration or script in the repository sets it. It is changed from Admin → System → New Sign-ups and logged in `admin_logs` with action `app_config_update` (readable in the Admin audit log; not read here).
- **When:** first recorded as already on in the read-only production facts of 2026-10-30 (`docs/LAUNCH_READINESS_MASTER.md`, commit `877d2af`). The exact date is in that `admin_logs` entry.
- **Authorization:** the owner confirmed on 2026-11-27 that the pause was approved until launch readiness.
- **Gap (AZ-45):** the pause is enforced only by the app. `handle_new_user` (the `auth.users` trigger) does not check it, so a direct Supabase Auth sign-up with the public anon key is not blocked unless the Supabase dashboard sign-up setting is also off (not visible here). Fixed in the registration batch together with a server-enforced tester allowlist. **Sign-ups stay paused.**

## Verified state (post-merge audit, 2026-11-26)

Verified from the repository, GitHub and Vercel deployment records. **No production database was queried.**

**`main` is at `86632029516288510f12201bf83524b8eaf2915c`** ("Merge pull request #123"). Since #121 (`815ec94`), only these six PRs were merged; no other commits.

| PR | Scope | Merged (UTC) | Merge commit | Merged head = reviewed head | CI on the PR | Deployed to production |
|---|---|---|---|---|---|---|
| #122 | C1 (0220) + tracker | 11:07:52 | `bae3858` | ✅ `d6b3adc` | none (the workflow didn't exist yet) | ✅ superseded by later deploys |
| #127 | D2a (0229) | 11:08:11 | `3d71e8c` | ✅ `08a9ef6` | none | ✅ |
| #126 | D1a | 11:08:35 | `a17772b` | ✅ `b09e345` | none | ✅ |
| #125 | H2/L4/M8/L5 (0227, 0228) | 11:09:13 | `2b51a0b` | ✅ `c419c72` | none | ✅ (its own build was cancelled; the code is in later builds) |
| #124 | H1 (0226) | 11:09:41 | `7dc64e6` | ✅ `22dbc9d` | none | ✅ |
| #123 | H5 (PR checks) | 11:10:01 | `8663202` | ✅ `48b36c3` | ✅ green (run 45760298118) | ✅ **production = `8663202`** (`dpl_JwBzcwgAWhZG4NBbg4Qce2b3mgjB`, READY) |

- **CI:** `PR checks` passed on the `main` push at `8663202` (run 45808079181). PRs #122 and #124–#127 had **no** CI run before merge.
- **Branch protection:** not verifiable with this access; still an owner action (`docs/release-safeguards.md`).

### ⚠️ Production risk right now: code merged and deployed before its migrations

The PRs required each migration to be applied **before** merging. All six merged within about 2 minutes and were deployed. Whether 0220 to 0229 are applied in production is **unknown** here (no production query was made). If they aren't:

| Missing in production | Effect on the live app (`8663202`) |
|---|---|
| **0227** | **Username login on the website fails** ("We couldn't verify your login right now"): the web client calls `resolve_login_email`, and the failed-login status check calls `get_login_account_status`. Email login is unaffected. |
| **0226** | A captured payment that can't become a ticket makes the signed webhook answer 500 (Paystack retries; nothing is lost once 0226 exists). Successful payments log a warning. Admin → Payouts → Payment exceptions shows an error. |
| **0229** | Ticket-tier renames are as unsafe as before #127 (oversell, broken in-flight orders). The editor's `key` field is ignored harmlessly. |
| 0220 | C1 remains open (unpaid tickets usable for entry). |
| 0224 | "Publish as Coming Soon" fails (H4). **Confirmed missing, 27 Nov** (P0 above); the UI now hides the option. |
| 0225 | The free-promotion hole remains (H3). |

Vercel runtime logs (Hobby keeps 1 hour) showed no `payment_exception` messages and no runtime errors in the last 24 hours. That is **not** evidence either way.

## Status columns

Each finding has five separate status columns. A finding is **Resolved** only when all five are ✅ and nothing in "Remaining risk" is open.

| Column | Meaning | Evidence required |
|---|---|---|
| **Local** | Implemented on a branch | Commit |
| **Main** | Merged into `main` | Merge commit on `main` |
| **Tests** | Proven by automated tests on `main` | The named suite passes on the current `main` |
| **Prod applied** | Live in production: the frontend is deployed, **and** the migration is applied | Deployment record **and** an owner-confirmed migration apply. A merged PR or a migration file is **not** evidence of an apply. |
| **Prod verified** | Behaviour checked in production after release | An explicit post-release check |

**Symbols:** ✅ done (with evidence) · 🔶 partly · ❓ unknown (no evidence available here) · ⏸ waiting on an owner decision · ⬜ not started · — not applicable.

## Decision register

Approved decisions are binding for every batch. A decision being approved does not mean any production operation has run.

| ID | Decision (owner-approved) | Date | Implications | Affected work | Status |
|---|---|---|---|---|---|
| D1 | **All approved organizers may sell paid tickets.** No extra identity-verification requirement for paid-ticket sales. | 2026-11-26 | Verification stays a trust badge (and representative-reward eligibility), not a condition for selling. Paid-ticket checkout doesn't change. | M5, OEL-10 | ✅ Decided. **Follow-up D1a is open** (below). |
| D2 | **Organizers may change ticket prices after sales begin.** Every existing ticket and transaction keeps its original price and amount paid. Completed purchases and financial records are never changed retroactively. | 2026-11-26 | Price edits stay allowed. B5 adds a test that a price change leaves every existing `tickets.amount`, pending purchase and ledger row unchanged. Deleting a tier that has sales, or cutting its quantity below the number sold, is still refused: that isn't a price change, and it orphans existing tickets. | M4 | ✅ Decided. **Follow-up D2a is open** (below). |
| D3 | **Leave existing promotions untouched.** Don't investigate, expire, delete or modify them. | 2026-11-26 | No production query for promotions organizers may have given themselves, and no cleanup. 0225 is compatible as written: it only stops new writes from the app (it drops the write policies and revokes the grants) and doesn't touch existing rows. | H3 | ✅ Decided. No further work. |
| D4 | **Every refund of a payment charged without a ticket needs two separate authorized admin approvals. No automatic refunds.** | 2026-11-26 | The refund is built as a two-admin action (`request_admin_action` → `approve_admin_action`): one admin requests it, a different admin approves it, and an admin can't approve their own request. It runs through the existing refund engine only after the second approval. Nothing refunds automatically. | H1 (#124, new batch B3c) | ✅ Decided. #124 needs an adjustment (below). |
| D5 | **Cancel all existing confirmed unpaid tickets after 0220 is applied**, and only after a separate production review (gate G-D5) is approved. Exclude successful payments, pending payment attempts, charged-but-unreconciled payments and ambiguous records. **Nothing is cancelled yet.** | 2026-11-26 | Two steps, each needing its own approval. Step 1 is a read-only production review listing the exact qualifying tickets, counts, capacity impact per event, and every excluded record with the reason. Step 2 is the cancellation itself, as a reviewed, single-transaction, reversible operation covering only the records approved in step 1. | C1 follow-up | ✅ Decided. Blocked on gate G-D5. |
| D6 | H6 needs a schema-only `pg_dump` of production so the repo can rebuild the database from a baseline. It's read-only, but it is a production operation: will you run it, or approve me running it? | — | — | H6, M10 | ⏸ **Still open** (unchanged at the 2026-11-26 post-merge audit) |
| D7 | **Revoke the old username lookups immediately, through 0228.** Older installed iOS and Android versions may lose username login and may need email login or an app update. Release and support notes are prepared. | 2026-11-26 | "Immediately" means as soon as it's safe: apply 0227 → merge #125 and deploy the web app → apply 0228 straight after. Applying 0228 before the web deploy would also break username login on the website. ⚠️ See the compatibility risk below. | H2, L4 (#125) | ✅ Decided |

### Follow-up decisions

| ID | Decision (owner-approved) | Date | Implications | Affected work | Status |
|---|---|---|---|---|---|
| D1a | **Choosing the Organizer role is enough.** A user who selects it is approved to operate as an organizer. No separate admin approval before publishing events or selling paid tickets. | 2026-11-26 | Sign-up already worked this way (`set_signup_role`). After sign-up, "Become an Organizer" (VENTS Work) filed an application and waited "1–3 business days" for admin review, which is a separate approval. #126 makes it the same one-step choice as sign-up, with no database or permission change. Legacy pending or rejected applications no longer block anyone. Admins can still read old requests. Unchanged: event creation still needs the organizer capability; payouts still need a verified bank account, the PIN and two-admin approval; `promote_to_organizer` stays revoked; staff are never offered the option. | M5, OEL-04, OEL-10 | ✅ Decided; implemented in #126 |
| D2a | **Organizers may rename a ticket tier after sales begin.** Existing tickets keep their purchase-time name; transactions, payments, receipts, refunds and reports are never rewritten; ownership, door scanning and check-in keep working; the event shows the new name. | 2026-11-26 | Tickets store the tier **name**, and capacity, availability and analytics matched by the current name. Without a fix, a rename oversold the tier, broke orders already in checkout (charged, no ticket) and split reports. Migration 0229 (additive) gives each tier a stable key and server-kept previous names, and makes purchase, capacity and reporting count every name the tier has had. No ticket or financial row is written. | M4 (renaming), #127 | ✅ Decided; implemented in #127 |

### Confirmed policies (owner, 2026-11-27)

Binding for every batch. They match the latest decisions already in the code; none of them changes code or production.

| ID | Policy | Source it confirms | Note |
|---|---|---|---|
| P1 | **Withdrawals: the VENTS Super Admin alone approves, with the 10-digit Admin Payout PIN.** | 0213 (owner decision 2026-11-10) | Replaces the "two-admin approval" wording in D1a above and the 0211 rule. Admin and sub-admin reviews stay advisory. |
| P2 | **Attendee service fee 1.5%; organizer commission 3.5%.** | 0208 (owner instruction 2026-11-08), `docs/business-model.md` | The 4% + 5% model of 0203 is retired. |
| P3 | **Eligible organizer and service-provider earnings release within 48 hours (or sooner) after the event ends or the service is completed.** | 0203 (approved 2026-10-30) | Representative rewards keep their own 7-day hold (0201). |
| P4 | **A successful payment without an issued ticket is refunded only with two-admin approval.** | D4 above | Still to build (batch B3c / AZ-10). |
| P5 | **Public sign-ups stay paused until launch readiness; controlled reopening for live testing only.** | AZ-50 above | |
| P6 | **Phone number is optional at registration** (label "PHONE NUMBER (OPTIONAL)"; no phone verification when none is given). | Owner requirement 2026-11-27 | Next batch. The database and RPCs already accept a missing phone; only `AuthScreen.tsx` requires it. |

### ⚠️ D7 compatibility risk

Once 0228 is applied, **installed iOS and Android builds from before #125** can no longer log in with a **username**. For those builds:
- the screen shows "We couldn't verify your login right now. Please check your connection and try again.";
- **logging in with email and password still works** in every build;
- updating the app brings username login back.

The website is unaffected once #125 is deployed. Old builds can't be given a better message, because they show that same text for any lookup failure. Support guidance and a release-note line are in `docs/support-username-login-0228.md`.

## Verification on `main` at `8663202` (2026-11-26)

| Command | Result |
|---|---|
| `npm ci` (lockfile) | ✅ (the container restart had removed `node_modules`) |
| `npx tsc --noEmit` (TypeScript 5.9.3, as locked) | ✅ exit 0 |
| `npm test` (vitest, both configs) | ✅ **3,865/3,865** + 4/4. 3,811 before the repairs + 11 (0220) + 4 (B2) + 19 (B3) + 10 (B4) + 11 (D2a) − 1 (D1a) |
| `scripts/local-pg-test/run-*.sh` (40 suites) | ✅ **40/40**, including 0220 141/141 + mutation, 0226 59/59, 0227/0228 57/57, 0229 42/42, Coming Soon 195/195, payouts, withdrawals, wallet transfers, fees, cancellation. Two suites first failed for environment reasons only (pg_cron and `node_modules` missing after the restart); after restoring local pg_cron (background workers) and `npm ci`, both pass. No code or test was changed. |
| Production build (`vite build`, placeholder environment values) | ✅ |
| Native-release checks (`nativeReleaseVersion`, `WalletScreen.withdrawalPin`) | ✅ 19/19 |
| Android/iOS binary builds | ⬜ skipped: no Android SDK or Xcode in this environment |
| GitHub `PR checks` on `main` push | ✅ run 45808079181 |

## Approval gates

Each gate needs its own explicit approval, recorded here, before anything behind it runs.

| Gate | What must be approved | Status |
|---|---|---|
| G-0224, G-0225, G-0223, G-0220 | Applying each migration to production, in the apply order below | ⬜ Waiting |
| G-0226 | Applying 0226, **before** merging #124 | ❗ #124 is merged and deployed; 0226 apply status unknown. |
| G-0227 / G-0228 | 0227 before merging #125; 0228 straight after the web deploy (D7) | ❗ #125 is merged and deployed; **0227 apply status unknown**. Apply 0227 first (or confirm it is applied), then 0228. |
| G-0229 | Applying 0229, before merging #127 | ❗ #127 is merged and deployed; 0229 apply status unknown. The N3 fix is a separate migration (0231, #131); 0229 itself is unchanged. Apply 0231 together with 0229 if approved. |
| G-0230 / G-0231 / G-0232 | Merging #129 / #131 / #130, then applying each migration. **Apply each migration before its PR is merged** (lesson from N4). | ⬜ Waiting for review |
| **G-D5** (mandatory, separate) | A **read-only production review** before any unpaid ticket is cancelled. It must show: (1) the exact qualifying ticket ids, each with its event, tier, owner and creation date; (2) counts per event and in total; (3) the capacity impact per event (sold, unpaid and remaining, before and after); (4) every **excluded** record and why: successful payments, payment attempts still open (`pending_purchases` or payment attempts), payments charged but not reconciled (an open `payment_exceptions` row, or a Paystack charge with no confirmed ticket), and anything ambiguous. Approving the review does **not** approve the cancellation: that needs a second approval of the exact list. | ⬜ Not started (needs 0220 applied first) |
| G-D4 | Each refund of a payment exception: two separate admin approvals in the app (built in B3c) | ⬜ Not built. The #124 panel wording still tells a single admin to refund in Paystack, which conflicts with D4. |
| G-D6 | The production schema dump for H6 | ⏸ Waiting on decision D6 |

## PRs and migrations affected by these decisions

| Item | Change needed | Why |
|---|---|---|
| #124 (H1, 0226) | Change the Payment exceptions panel and its docs. They must no longer tell an admin to refund in the Paystack dashboard and then record it. "Record resolution" must no longer let a single admin close out a refund. One admin can still record a **non-refund** outcome (for example, the ticket was issued another way), or that could also move to two approvals. The two-admin refund itself is B3c. 0226's tables and the server-side recording are unaffected. | D4: one admin refunding outside the app is a single-approval refund |
| New batch B3c | A two-admin refund action for payment exceptions, using `request_admin_action` / `approve_admin_action` and run through the existing refund engine. It comes with a local Postgres test suite proving: an admin can't approve their own request, a payment can't be refunded twice, and the refund equals the amount charged. | D4 |
| #127 (D2a, 0229) | New. Apply 0229 before merging #127. | D2a |
| #126 (D1a) | New. No database change. | D1a |
| #125 (H2, 0227/0228) | Update the PR description: 0228 is now approved to apply immediately after the web deploy (D7). Link the support notes. No code change: 0227 and 0228 already match D7. | D7 |
| 0220 / #122 | No change. The D5 cancellation is a separate, later operation behind gate G-D5, not part of 0220. | D5 |
| 0225 | No change. It doesn't touch existing promotion rows. | D3 |
| B5 (M4) | Keep price edits allowed. Refuse deleting a tier with sales or shrinking it below the number sold, counting sales under the tier's previous names (0229). Add the test that a price change never touches existing tickets or ledger rows. Renaming is allowed (D2a, #127). | D2, D2a |
| M5 (organizer capability) | Done in #126 (D1a): "Become an Organizer" after sign-up is now the same one-step self-selection as sign-up. | D1, D1a |

## Findings

| ID | Sev | Finding | Root cause | Batch | Fix | Tests | PR | Local | Main | Tests on main | Prod applied | Prod verified | Remaining risk |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| C1 | Critical | Unpaid tickets can be used for entry; inventory lock-up (OEL-01) | `purchase_ticket` (anon/auth) issues paid-tier tickets as `pending`+`active`; signing and check-in never read `payment_status` | B1 | 0220: `purchase_ticket` free tiers only; sign only `paid`; `verify_entry_pass` and `manual_check_in` refuse `not_paid`. Plus `undo_0220`. | 141-check local suite; mutation test (without 0220, exactly 18 checks fail); verbatim check; vitest guard (11) | #122 | ✅ | ✅ #122 `bae3858` | ✅ 141/141 + mutation; static 11 | ❓ 0220 not confirmed | ⬜ | D5: existing unpaid tickets, cancel only after gate G-D5. 0220 apply needs owner approval. |
| H1 | High | Captured payment with no ticket, refund or record (OEL-02) | Finalize failure only logged; verify/webhook return "not found" | B3 | 0226 `payment_exceptions` + record/close (server only, idempotent) + admin list/resolve; both payment paths record (provable ticket refs only); truthful buyer message; Admin → Payouts → Payment exceptions | 0226 local suite 59/59 + 3 mutations caught; webhook/verify behaviour tests 12; panel tests 7 | #124 | ✅ | ✅ #124 `7dc64e6` | ✅ 59/59 + 19 vitest | 🔶 API deployed; ❓ 0226 not confirmed | ⬜ | **D4 adjustment not done:** the panel still says "refund in Paystack, then record it here", which is single-admin. Two-admin refund (B3c) not built. |
| H2 | High | Username → email lookup open to anyone | `resolve_username_to_email` is anon `SECURITY DEFINER` and returns the email | B4 | 0227 `resolve_login_email(username, password)` (email only with the right password, rate limited); client switched; 0228 revokes the old lookup | 0227+0228 local suite 57/57 + 3 mutations caught; static guard 10 | #125 | ✅ | ✅ #125 `2b51a0b` | ✅ 57/57 + 10 vitest | 🔶 web client deployed; ❓ 0227/0228 not confirmed | ⬜ | If 0227 is not applied, web username login is broken now. D7: 0228 immediately after 0227. Old native builds lose username login. |
| H3 | High | Organizers can self-promote for free | 0008 write policies on `event_promotions` | — | 0225 (merged in #119/#120) | `promotionEligibility.security.test.ts`; local suite | #119, #120 | ✅ | ✅ #119/#120 | ✅ 0225 suite (in Coming Soon suite) | ❓ 0225 not confirmed | ⬜ | Existing rows left untouched by decision (D3). |
| H4 | High | "Publish as Coming Soon" fails in production | UI shipped (#119) before 0224 was applied | — | 0224 (merged in #119) | Coming Soon local suite | #119 | ✅ | ✅ #119 | ✅ 195/195 | 🔶 UI deployed; ❌ 0224 confirmed missing (P0, 27 Nov; prod logs) | ⬜ | Applying 0224 also turns on pg_cron. Until then, the UI hides Coming Soon (P0 fix) |
| H5 | High | No tests run before merging | No PR workflow | B2 | `.github/workflows/pr-checks.yml` (typecheck + vitest) + guard test | Clean-checkout replay; first GitHub run green on #123 | #123 | ✅ | ✅ #123 `8663202` | ✅ CI green on `main` | — | ⬜ branch protection unverified | Branch protection is your setting (docs/release-safeguards.md) |
| H6 | High | Database can't be rebuilt from the repo | Tables created outside migrations; unrecorded history; production-only seeds | B9 | planned | planned | — | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | D6 |
| M1 | Medium | 1-hour reminders almost never sent | Reminder sweep only runs in the daily 08:00 UTC Vercel cron | B6 | planned: pg_cron schedule (after 0224) | planned | — | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | Depends on H4 (pg_cron) |
| M2 | Medium | Ticket email depends on the buyer's browser (CF-07) | Email only sent from the client after verify | B3 | planned | planned | — | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | |
| M3 | Medium | Draft and admin-hidden events readable by anyone (OEL-06) | `select_events` only filters `deleted_at` | B5 | planned | planned | — | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | |
| M4 | Medium | Tier with sales can be removed or shrunk (OEL-08) | No database check for sold tiers | B5 | planned: refuse deleting a tier with sales or shrinking it below the number sold (counting sales under previous names); price changes allowed (D2); renaming allowed and made safe by 0229 (D2a, #127) | rename part: 0229 local suite 42/42; static guard 11 | #127 (rename part) | 🔶 rename only | 🔶 #127 `3d71e8c` | ✅ 42/42 (rename); ⬜ delete/shrink guard | ❓ 0229 not confirmed | ⬜ | Delete/shrink guard (B5) not built. **N3:** the 0229 older-app fallback can mis-link tiers. |
| M5 | Medium | Anyone can self-grant organizer (OEL-04) | `set_signup_role` | — | Accepted by policy (D1, D1a): choosing Organizer is the approval. #126 removes the post-sign-up admin review so both paths match | workRoles, VENTS Work render, organizerCapabilityStates, promoteToOrganizerSelfEscalation (restated to D1a) | #126 | ✅ | ✅ #126 `a17772b` | ✅ vitest (restated tests) | ✅ frontend deployed (`8663202`); no migration needed | ⬜ | None (policy accepted) |
| M6 | Medium | Purchase intent lost at sign-in (CF-01) | `handleAuthSuccess` clears the stack and goes Home | B7 | planned | planned | — | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | |
| M7 | Medium | "Popular" ordering counts only the viewer's own saves | `saved_events` RLS is own-row only | B5 | planned: count RPC | planned | — | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | |
| M8 | Medium | Anyone can wipe another person's unconfirmed sign-up | `reclaim_unverified_signup` anon, no ownership proof | B4 | 0227: reclaim only after 1 hour (email-code lifetime) + rate limit | in 0227 suite | #125 | ✅ | ✅ #125 | ✅ in 0227 suite | ❓ 0227 not confirmed | ⬜ | |
| M9 | Medium | Desktop layout clipped (OEL-03) | `.phone-frame` capped at 560px | B8 | planned | planned | — | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | |
| M10 | Medium | Seeded production IDs and drift in migrations (part of H6) | See H6 | B9 | with H6 | — | — | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | D6 |
| M11 | Medium | Payment link loses intent; payer needs an account (CF-04) | As M6 | B7 | planned (intent resume; account requirement unchanged unless you decide) | planned | — | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | |
| M12 | Medium | Push, email and SMS configuration in production unverified | Env vars not readable from here | B10 | planned: health check in `prod-smoke`; you confirm in the Vercel dashboard | planned | — | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | Needs you |
| L1 | Low | Representative Rewards screen unreachable | No navigation path | B8 | planned | planned | — | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | |
| L2 | Low | Dead screen types `search`, `ticket-detail` | Leftover | B8 | planned | planned | — | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | |
| L3 | Low | `boost_event_vc` charges VC for nothing | Feature never wired up | B5 | planned: revoke | planned | — | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | |
| L4 | Low | Anonymous account-status and existence lookups | Anon grants on helper RPCs | B4 | 0227: owner-only `get_login_account_status`; `email_exists` revoked; `check_user_exists` rate limited; 0228 revokes `get_account_status` | in 0227 suite | #125 | ✅ | ✅ #125 | ✅ in 0227 suite | ❓ 0227/0228 not confirmed | ⬜ | Rate limit per IP may affect shared mobile IPs (60/5 min) |
| L5 | Low | `users.email` editable, drifts from login email | No column guard | B4 | 0227 trigger: client roles can't change `email`/`original_email` | in 0227 suite | #125 | ✅ | ✅ #125 | ✅ in 0227 suite | ❓ 0227 not confirmed | ⬜ | |
| L6 | Low | Leftover glows and gradients | Older styles | B8 | planned | planned | — | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | |
| L7 | Low | InsForge leftovers; 33 root screenshot scripts | Not cleaned up | B8 | planned | — | — | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | |
| L8 | Low | Placeholder features (AI tabs, booking, Work, non-NGN) | Not built | B8 | planned: mark clearly unavailable; no new features | planned | — | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | |
| L9 | Low | Phone not pre-filled at checkout (CF-05) | Not wired | B7 | planned | planned | — | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | |
| L10 | Low | Extra attendees need email and phone (CF-06) | Validation | B7 | planned | planned | — | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | Check door/transfer use of those fields first |
| L11 | Low | Public QR images never cleaned up (CF-14) | Stored publicly | B3 | planned | planned | — | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | |
| L12 | Low | Anyone can review an organizer without attending | Insert policy only checks `reviewer_id` | B5 | planned | planned | — | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | |

## Found during repairs (not in the original 31)

| ID | Sev | Finding | Root cause | Evidence | Status | Proposed fix |
|---|---|---|---|---|---|---|
| N1 | High | A price (or promo) change while a buyer is mid-checkout breaks the purchase. **Paystack path:** a raise means charged with no ticket; a cut means the buyer overpays with no record or refund. **Wallet path:** a raise means the wallet is debited more than agreed. A buyer who retries within 30 minutes is stuck on "price changed". | `create_pending_purchase` stores only the total (`amount_kobo`). `finalize_pending_purchase` re-reads the **current** tier price and promo. `confirm_ticket_payment(_via_wallet)` computes the expected amount (and the wallet debit) from those values. The 30-minute reuse ignores price changes. | Code trace (`docs/n1-checkout-price-snapshot.md`); reproduced locally (9 defects) | ✅ **Merged: [#129](https://github.com/DERO2026/vents-app/pull/129)**, migration **0230** | See "N1–N3 fixes" below. |
| N2 | High (per owner brief; was Low) | Staff exclusion from self-selecting Organizer was enforced only in the UI: `set_signup_role` refused only `role = 'admin'`, so a **sub-admin**, or **root** when its role isn't `'admin'`, could make themselves an organizer by calling the RPC directly. | 0121 checks `v_current_role = 'admin'` only | Code (0121); reproduced locally | ✅ **Merged: [#130](https://github.com/DERO2026/vents-app/pull/130)**, migration **0232** | See "N1–N3 fixes" below. |
| N3 | Critical (per owner brief) | **0229's older-app fallback can link the wrong tier.** An older app build (no tier keys) that deletes a tier and adds or renames another in the same save makes the new tier inherit the deleted tier's identity and sales; an order already in checkout for the deleted tier **finalizes at the other tier's price** (₦9,000 order issued as ₦50 and confirmed). An event with **two tiers of the same name can't be edited**. Also found while fixing: an older build re-saving a tier the current app renamed drops its earlier names (sales stop counting), and the current app can delete a sold tier and add a new one with the same name, which takes over its sales. | The fallback matches by the per-save positional `id`; legacy duplicate names fail the identity check; no rule ties a sold name to its tier. | Local Postgres test (6 defects reproduced) | ✅ **Merged: [#131](https://github.com/DERO2026/vents-app/pull/131)**, migration **0231** | See "N1–N3 fixes" below. |
| N4 | High (operational) | PRs were merged and deployed before their migrations were confirmed applied (see "Production risk right now"). | Merge = deploy on Vercel; the apply-before-merge order wasn't followed | GitHub and Vercel records | Open: **owner must confirm which of 0220–0229 are applied** | Confirm the production state (owner), then apply any missing migrations in the order below. |

## N1–N3 fixes (2026-11-26, owner-authorized; merged 2026-11-26 as #129–#131, nothing applied)

Each fix is its own branch and PR from `main` `8663202`, with no shared files. They merge cleanly together (checked on a local throwaway merge that was not pushed). All three migrations were applied together on one local database and every suite was run there.

| | N1: checkout price snapshot | N2: staff role guard | N3: safe tier identity |
|---|---|---|---|
| PR | [#129](https://github.com/DERO2026/vents-app/pull/129) `claude/n1-checkout-price-snapshot` | [#130](https://github.com/DERO2026/vents-app/pull/130) `claude/n2-staff-role-guard` | [#131](https://github.com/DERO2026/vents-app/pull/131) `claude/n3-tier-identity-safe` |
| Migration / undo | `0230_checkout_price_snapshot.sql` / `undo_0230.sql` | `0232_signup_role_staff_guard.sql` / `undo_0232.sql` | `0231_ticket_tier_identity_safe.sql` / `undo_0231.sql` |
| Depends on | 0229, 0203, 0208, 0060 | 0121, 0004 | 0229 (exact trigger function) |
| Root cause | Only the order total was fixed at creation; after payment, tickets, confirmation, wallet debit and refunds used the tier's and promo's **current** values | `set_signup_role` refused only `role='admin'` | Positional `id` fallback for keyless (older-app) tiers; legacy duplicate names refused; no rule tied a sold name to its tier |
| Fix | Immutable quote snapshot on `pending_purchases` (unit price, discount, quantity, face, service fee, discount amount, organizer deduction, `NGN`, tier key, time); finalize issues at the snapshot and refuses a different tier; confirm and wallet cross-check the agreed total; no new card or wallet charge starts on a stale quote (order untouched); reuse only at the same quote | Selecting Organizer refuses root, admin and sub-admin on the server; ordinary users unchanged (D1a) | Keyless tiers match by current name only (never `id`); an older-app drop of a sold or ordered tier together with an unmatched add is refused with an "update the app" message; a sold name can't move to another tier (any app version); no new duplicate names; legacy duplicates stay editable (`VIP`, `VIP#2`); `SECURITY DEFINER` so RLS can't hide sales |
| Files | migration, undo, `undo_0229.sql` (refuses while 0230 is applied), DB suite, mutation test, `checkoutPriceSnapshot.security.test.ts` | migration, undo, DB suite, mutation test, `signupRoleStaffGuard.security.test.ts`, one new test in `ventsWork.render.test.tsx` | migration, undo, DB suite, mutation test, `ticketTierIdentitySafe.security.test.ts` |
| App code changed | none | none | none |
| DB suite | **69/69** (9 defects reproduced without 0230) | **51/51** (sub-admin and root escalation reproduced) | **46/46** (6 defects reproduced; saves made as the organizer under RLS) |
| Mutation test | 5/5 caught | 2/2 caught | 4/4 caught |
| `npm test` on branch | 3,877/3,877 + 4/4 | 3,872/3,872 + 4/4 | 3,877/3,877 + 4/4 |

| Status | N1 | N2 | N3 |
|---|---|---|---|
| Implemented (branch) | ✅ | ✅ | ✅ |
| Tested locally | ✅ | ✅ | ✅ |
| Merged to `main` | ⬜ awaiting review | ⬜ awaiting review | ⬜ awaiting review |
| Applied in production | ⬜ not authorized | ⬜ not authorized | ⬜ not authorized |
| Verified in production | ⬜ | ⬜ | ⬜ |

**Combined verification** (local merge of all three, not pushed):
- `npm run typecheck`: clean.
- `npm test`: see the verification log below.
- All database suites: see the verification log below.
- Production build: ✅ (placeholder values).
- Native release checks: ✅ 19/19.
- Android and iOS binary builds: skipped (no SDK here).

The fixes back each other up: with 0230 alone, the N3 in-checkout order is issued at its agreed ₦9,000; with 0231, the tier-swap save behind N1's last case is refused outright.

**Fee note:** the brief said to "retain the 4% attendee / 5% organizer" fees. The deployed model is 0208's `v3_15_35` (**1.5% attendee, 3.5% organizer**), which forbids 4% + 5%. Nothing changed the fee model; a static test asserts that 0230 redefines no fee helper.

**Verification log (combined local merge of #129, #130 and #131)**

| Check | Result |
|---|---|
| `npm run typecheck` | ✅ clean |
| `npm test` | ✅ 3,896/3,896 + 4/4 (was 3,865 on `main`; +31 new tests) |
| Database suites (`scripts/local-pg-test/run-*.sh`) | ✅ **46/46**: the 40 existing ones, plus 0230 (69), 0232 (51), 0231 (46) and their 3 mutation tests (5/5, 2/2, 4/4 caught) |
| Production build (`vite build`, placeholder values) | ✅ |
| Native release checks | ✅ 19/19 |
| Android and iOS binary builds | ⬜ skipped (no SDK or Xcode here) |
| Production | Nothing run, applied, deployed or changed |

**Remaining risks**
- **N1:** orders created before 0230 that are already mid-payment when it's applied still finalize at the then-current price. A paid order refused at finalize (tier removed, capacity full, event ended) is recorded by 0226, but refunding it needs B3c (D4), which isn't built. The existing `max_uses` race on promos is unchanged. Ordinary orders still have no expiry: a stale order simply can't start a new payment.
- **N2:** staff who self-escalated before 0232 keep `is_organizer`. Checking that needs a read-only production query, which isn't authorized.
- **N3:** older builds are refused when they rename or replace a sold tier (the message says to update the app; consider a support-note line). Removing a sold tier outright is still allowed, so an order mid-payment for it becomes a 0226 exception. Sales made before the fix on legacy duplicate-name tiers stay shared by name.
- **All three:** **apply each migration before merging its PR** so the N4 situation doesn't repeat. 0230 needs 0229 applied first, and 0231 needs 0229's exact function.

## Earlier audits: status of every open item

| ID | Item | Status on `main` (2026-11-26) | Now tracked as |
|---|---|---|---|
| OEL-01 | Unpaid tickets usable for entry | Open (0220 never merged) | C1 |
| OEL-02 | Orphan payments | Open | H1 |
| OEL-03 | Desktop clipping | Open | M9 |
| OEL-04 | Self-grant organizer | Accepted by policy (D1, D1a); app made consistent in #126 | M5 |
| OEL-05 | Anyone can read any event's sales counts | Fixed in code by 0221: pending, cancelled, refunded counts and revenue are organizer/admin only. Production: applied but unrecorded (Stage A) | H6 (record history) |
| OEL-06 | Drafts and hidden events readable | Open | M3 |
| OEL-07 | Revenue stat counts gross `amount × 100` | Re-check in B5 | B5 |
| OEL-08 | Capacity and tier quantity checks client-side only | Open | M4 |
| OEL-09 | No delegated door-staff role | Open: a product feature, not a defect. Recorded as intentionally unavailable. | L8 group |
| OEL-10 | No pre-publication review | Policy: not required by D1 | D1 |
| OEL-11 | Dead `'published'` status in HomeScreen | Re-check in B8 (0225 treats `published` as on sale) | B8 |
| OEL-12 | Desktop rules scattered | With M9 | M9 |
| CF-01 | Purchase intent lost after auth | Open | M6 |
| CF-02 | ~10 sign-up fields before first purchase | Product decision (sign-up redesign); not a defect | Recorded |
| CF-03 | Mandatory 8-digit code before buying | Product decision; not a defect | Recorded |
| CF-04 | Payment link needs an account; intent lost | Open | M11 |
| CF-05 | Phone retyped | Open | L9 |
| CF-06 | Extra attendees need email and phone | Open | L10 |
| CF-07 | Ticket email depends on the browser | Open | M2 |
| CF-08 | Free RSVP needs a full account | Product decision | Recorded |
| CF-09 | No box office or comp tickets | Product feature | Recorded |
| CF-10 | Web verify link tries `vents://` first | Needs a device test; re-check in B7 | B7 |
| CF-11 | Capacity checked after payment | Same root cause as H1 | H1 |
| CF-12 | Typed promo must be applied by hand | Re-check in B7 | B7 |
| CF-13 | Default login mode | Re-check in B7 | B7 |
| CF-14 | Public QR images | Open | L11 |

## Migration register (0218–0232)

Dependencies are taken from each file's SQL prechecks and from what it patches. **"Applied in production" is not inferred from merging:** only 0218 and 0219 have a recorded apply (2026-11-19). Stage A (2026-11-25, read-only) listed "0221 applied but unrecorded" only as an **assumption**. Because 0229 depends on 0221's function body, that must be confirmed before 0229.

| # | Purpose | Depends on (from the SQL) | In `main` | Undo | Applied in production |
|---|---|---|---|---|---|
| 0218 | Event cancellation workflow | 0208 (`ticket_fee_buyer_charge_kobo`), `refund_ticket` | ✅ | ✅ | ✅ recorded 2026-11-19 |
| 0219 | Cancellation safety fixes | 0218 | ✅ | ✅ | ✅ recorded 2026-11-19 |
| 0220 | Ticket payment integrity (C1) | purchase/sign/check-in functions at their 0124/0024/0147 bodies (in-place anchors) | ✅ | ✅ (exact-reverse anchors) | ❓ not confirmed |
| 0221 | Attendance visibility | md5-pinned function bodies | ✅ | ✅ | ❓ **assumed** applied but unrecorded (listed as an assumption, not a finding, in Stage A on 2026-11-25) |
| 0222 | Announcements drafts/publish | — | ✅ | ✅ | 🔶 functions matched the repo (Stage A); history ❓ |
| 0223 | Internal-test announcement audience | 0222 | ✅ | ✅ | ❓ |
| 0224 | Coming Soon + scheduler | 0218; pg_cron available | ✅ | ✅ | ❓ |
| 0225 | Promotion eligibility (H3) | 0218, `event_effective_end_at` (0051); md5 pins (#120) | ✅ | ✅ | ❓ |
| 0226 | Payment exceptions (H1) | `pending_purchases`, `admin_logs.actor_role`, `is_admin`/`is_super_admin` | ✅ | ✅ | ❓ |
| 0227 | Auth lookup hardening | pgcrypto, `check_rate_limit`, `client_ip`; reclaim (0004) and check_user_exists (0027) bodies | ✅ | ✅ (refuses while 0228 is on) | ❓ |
| 0228 | Revoke the old open lookups (D7) | **0227** (refuses without it) | ✅ | ✅ | ❓ |
| 0229 | Ticket-tier rename (D2a) | **0221's** availability body; create/finalize anchors (verified to survive 0203/0208); purchase_ticket anchors (verified to survive 0220) | ✅ | ✅ (exact reverse; refuses while 0230 is applied, once #129 merges) | ❓ |
| 0230 | N1: checkout price snapshot | **0229** (refuses without it), 0203, 0208, 0060; in-place anchors in create/finalize/confirm/wallet/initiate | ⬜ #129 open | ✅ `undo_0230` (exact reverse; keeps snapshot columns) | ⬜ not applied |
| 0231 | N3: safe tier identity (replaces 0229's trigger function) | **0229's exact trigger function** (refuses on drift) | ⬜ #131 open | ✅ `undo_0231` (restores 0229's function verbatim) | ⬜ not applied |
| 0232 | N2: staff guard in `set_signup_role` | 0121's `set_signup_role` body (one anchor) | ⬜ #130 open | ✅ `undo_0232` (exact reverse) | ⬜ not applied |

**Required apply order** (each step needs its own approval; resolves the earlier conflicting notes):
1. 0224 (needs 0218 and pg_cron) → 0225 (needs 0218)
2. 0223 (needs 0222)
3. 0220
4. 0226
5. **0227**, and confirm web username login works
6. **0228** immediately after (D7)
7. **0229** (needs 0221)
8. **0230, 0231, 0232** if approved (after 0229; independent of each other, any order; verified applied together locally)
9. Backfill migration history for 0221–0232

0220, 0226, 0227 and 0229 don't depend on each other. 0220 and 0229 patch disjoint text in `purchase_ticket`, and both undos reverse their own text exactly, so either rollback order works. That's verified statically, not run together.

## Batches and dependencies

| Batch | Scope | Depends on |
|---|---|---|
| B1 | C1: 0220 onto `main` | — |
| B2 | H5: PR checks | — (lands early so every later batch is checked) |
| B3 | H1: payment exceptions (#124; needs the D4 adjustment) | 0226 applied before merge |
| B3b | M2, L11: server-side ticket email, private QR hosting | — |
| B3c | D4: two-admin refund of payment exceptions | #124 merged; 0226 applied |
| B4 | H2, M8, L4, L5: auth and personal-data RPCs | Done without a new API route (sign-in stays on the device) |
| B5 | M3, M4, M7, L3, L12, OEL-07: database correctness | New migrations numbered after 0229; D2/D2a decided; M4's guard must count previous names (0229) |
| D1a | M5: organizer self-selection (#126) | — |
| D2a | M4 rename part: migration 0229 (#127) | Apply 0229 before merging #127 |
| B6 | M1: reminder schedule | 0224 applied in production (H4) |
| B7 | M6, M11, L9, L10, CF re-checks: checkout and sign-in flow | — |
| B8 | M9, L1, L2, L6, L7, L8, OEL-11: UI, navigation, cleanup | — |
| B9 | H6, M10: reproducible database, migration history | D6 |
| B10 | M12 and release safeguards | You (dashboard) |

**Production migration apply order** (each one needs your approval; you or an approved session runs it):
0224 → 0225 → 0223 → 0220 → 0226 (before merging #124) → 0227 (before merging #125) → 0228 (immediately after #125 is deployed, D7) → 0229 (before merging #127) → backfill migration history.
After 0220: gate G-D5 (read-only review), then a separately approved cancellation.
0224 goes before 0225 because 0225's eligibility rule treats `coming_soon` as not on sale; it is safe either way.
