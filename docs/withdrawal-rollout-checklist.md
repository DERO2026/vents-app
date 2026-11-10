# Withdrawal security rollout (migration 0211): production checklist

**State on 2026-11-10 (deployed):**
- Code: PR #93 (`b5efac7`) and PR #94 (`22966a3`) are merged into `main`.
- Web: getvents.com serves `dpl_Dv8Riq6Zs6eB9q9xkzswqU7k4yfL` (READY, commit `22966a3`). The bundle served at getvents.com is the same as that deployment's (`main-DKcCx8Um.js`).
- Database: **0211 is applied** in production, at 2026-11-10 05:50:53 UTC.
  - Applied as one transaction through the `release_backup_20261109.migration_fetch` process.
  - Source: `raw.githubusercontent.com/DERO2026/vents-app/22966a3/supabase/migrations/0211_withdrawal_pin_and_two_admin_approval.sql`, md5 `7a4be60b25da7e194b8eb19394dec354`. This is the same file as on `main`.
  - Followed by `NOTIFY pgrst, 'reload schema'`.
- Backup taken first: Actions run 42712563242, artifact `vents-db-backup-20261109T223108Z`.
  - sha256 `12ae3c69…ec952`.
  - `restore_tables=103/103`, `restore_rows=103/103`.
- The live web app now uses the PIN flow and two-admin approval. The old no-PIN entry point (`request_organizer_payout`) is closed to clients.
- **0212 is applied** in production, at 2026-11-10 09:02:03 UTC, from `3999b70` (md5 `7c66471d…`). Old store builds that try to withdraw are now told to update the app or use getvents.com. Before that they saw "permission denied".
- **Web:** getvents.com serves `dpl_7qysDv4Tbxgnw1BNKtpCBDPbqhys` (commit `3999b70`), and the bundle reports `VENTS v1.3.0`.
- **Native 1.3.0 is prepared and verified unsigned** (§4). The signed store builds wait on the owner's secrets (§10).
- `app_config.min_client_version` is still `1.1.0`, deliberately.

The record of what was run and what came back is in §9.

Every step marked **[owner]** needs the owner's explicit go-ahead. Nothing here moves money, except step 7, which is a deliberate test withdrawal.

## 0. Read-only pre-checks [owner authorizes one read-only query]

Run this in the SQL editor (or let Claude run it) inside `BEGIN READ ONLY; … ROLLBACK;`. It changes nothing.

```sql
BEGIN READ ONLY;
-- Drift guard: the bodies 0211 replaces must be exactly these.
SELECT md5(prosrc) = 'a4db3afdceb377970bf22dc65e21ee3c' AS guard_is_0205
  FROM pg_proc WHERE oid = 'public.organizer_withdrawal_requests_guard()'::regprocedure;
SELECT md5(prosrc) = '5bc15fbc84de4edbc0242d5069fa4bc7' AS executor_is_0203
  FROM pg_proc WHERE oid = 'public.execute_withdrawal_authorization(uuid)'::regprocedure;
SELECT md5(prosrc) = 'c6748dc9c25657120e126d942f283bf5' AS assert_recent_auth_is_0004  -- undo_0211 restores this body
  FROM pg_proc WHERE oid = 'public.assert_recent_auth()'::regprocedure;
SELECT to_regprocedure('public.request_withdrawal(bigint,uuid,text,text)') IS NULL AS not_yet_applied;
SELECT extname, extnamespace::regnamespace AS schema FROM pg_extension WHERE extname = 'pgcrypto';
SELECT oid::regprocedure FROM pg_proc WHERE proname = 'request_organizer_payout';      -- expect only (bigint,uuid,text)
-- Supabase is recording password sign-ins in the amr claim (see §6).
SELECT authentication_method, count(*) FROM auth.mfa_amr_claims
 WHERE updated_at > now() - interval '30 days' GROUP BY 1;
-- What is in flight (0211 leaves all of it as it is).
SELECT status, count(*), sum(amount_kobo) FROM public.organizer_withdrawal_requests
 WHERE status IN ('pending', 'processing') GROUP BY 1;
SELECT target_id, count(*) FROM public.admin_action_requests
 WHERE action_type = 'authorize_withdrawal' AND status = 'pending' GROUP BY 1 HAVING count(*) > 1;  -- old duplicate first approvals
ROLLBACK;
```

**Proceed only if:**
- all three `md5` checks are `true` and `not_yet_applied` is `true`;
- pgcrypto is installed;
- `amr_claims` shows `password` rows.

Duplicate first approvals from before 0211 don't block anything. Reject the extra ones in Admin Actions; 0211 stops new duplicates.

## 1. Backup [owner]

1. Run Actions → Database backup on `claude/o4-cloud-rehearsal`. Until `main` is allowed in the `o4-backup` environment, that branch is the only one that can run it.
2. Require a green run whose summary shows `restore_tables=N/N` and `restore_rows=N/N` (last good run: 103/103 on 2026-11-09).
3. Note the artifact name.

## 2. Apply 0211 [owner]

1. Apply `supabase/migrations/0211_withdrawal_pin_and_two_admin_approval.sql` as **one transaction**, never with `supabase db push`. It refuses before changing anything if §0's fingerprints differ.
2. Run `NOTIFY pgrst, 'reload schema';` so the API sees the new functions at once.
3. Verify (read-only):

```sql
SELECT has_function_privilege('authenticated', 'public.request_organizer_payout(bigint,uuid,text)', 'EXECUTE');  -- false
SELECT has_function_privilege('authenticated', 'public.request_withdrawal(bigint,uuid,text,text)', 'EXECUTE');    -- true
SELECT has_table_privilege('authenticated', 'public.withdrawal_pins', 'SELECT');                                  -- false
SELECT tgname FROM pg_trigger WHERE tgname IN ('authorize_withdrawal_first_approval_check', 'withdrawal_close_open_authorizations');
```

## 3. Web

There's nothing to deploy. `b5efac7` is live, and it switches to the PIN flow as soon as `get_my_withdrawal_pin_status` exists. Hard-refresh getvents.com: the wallet shows "Withdrawal PIN · Not set".

## 4. Native apps (Android / iOS): release 1.3.0

Store builds bundle their own copy of the web code. Builds from before `b5efac7` call `request_organizer_payout` directly.

- **Since 0212**, that call returns a plain message instead of "permission denied": *"Please update VENTS to withdraw. Withdrawals now need a 4-digit withdrawal PIN… Update the app from the App Store or Google Play, or withdraw on getvents.com."*
  - Old builds show this text as their withdrawal error.
  - No withdrawal is created and no money moves.
- **1.3.0** is the first native release with the PIN flow.
  - Android: `versionCode 5`, `versionName 1.3.0`.
  - iOS: `MARKETING_VERSION 1.3.0`, build 5.
  - Web: `APP_VERSION` in `src/lib/appVersion.ts`. This is now the single source; App.tsx uses it.

### Secrets (names only; add them in GitHub → Settings → Environments, never in chat)

**Environment `android-release`:**

| Secret | What |
|---|---|
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_GOOGLE_PLACES_API_KEY` | Same values as Vercel Production |
| `VITE_PAYSTACK_PUBLIC_KEY` | The `pk_live_` key (the build refuses anything else) |
| `ANDROID_KEYSTORE_BASE64` | The Play **upload** keystore (.jks) as base64 |
| `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` | For that keystore |
| `GOOGLE_SERVICES_JSON_BASE64` | `google-services.json` from Firebase (Android app `com.getvents.app`) as base64. Push needs it. |

**Environment `ios-release`** (create it):

| Secret | What |
|---|---|
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_PAYSTACK_PUBLIC_KEY`, `VITE_GOOGLE_PLACES_API_KEY` | As above |
| `GOOGLE_SERVICE_INFO_PLIST_BASE64` | `GoogleService-Info.plist` from Firebase (iOS app `com.getvents.app`) as base64. The app stops at launch without it. |
| `APP_STORE_CONNECT_API_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID` | App Store Connect → Users and Access → Integrations → Keys |
| `APP_STORE_CONNECT_API_KEY_P8_BASE64` | That key's `AuthKey_<id>.p8` as base64. The key needs the **Admin** role, because Xcode-managed distribution signing creates the certificate and profile itself. |

Both workflows list every missing secret **by name** in the run summary, then stop before building.

### Build

1. **Android:**
   - Actions → *Android release* → Run workflow on `main` (signed ticked).
   - The run does all of the following:
     - checks the versions match;
     - runs the withdrawal and release regression tests;
     - builds the production web app;
     - checks the bundled app contains the PIN flow;
     - builds and signs `app-release.aab`, then verifies it.
   - Artifact: `vents-android-release-<sha>` (14 days).
   - With signed unticked, it builds the same AAB **unsigned**, as a verification only and not for the store.
2. **iOS:**
   - Actions → *iOS release* → Run workflow on `main`.
   - The run does all of the following:
     - the same version, test and bundle checks;
     - a signed App Store archive;
     - an `.ipa` export;
     - checks of the bundle id, version, signature, `GoogleService-Info.plist` and the PIN flow.
   - Artifact: `vents-ios-release-<sha>` (14 days).
3. **Upload (owner):**
   - `.aab` → Play Console (production or a testing track).
   - `.ipa` → Transporter or Xcode Organizer → App Store Connect.
   - Then submit both for review. Nothing in this repo uploads to a store.

### Only after both 1.3.0 builds are live in the stores

Raise `app_config.min_client_version` to `1.3.0` [owner, production write]. Every older build then shows "Update Required":
- on iOS and Android it sends the user to the App Store or Google Play listing;
- on the web it reloads.

The web app is already 1.3.0 once this release is deployed, so web users are never blocked. **Do not raise it earlier.** Until both stores serve 1.3.0, a raised minimum would lock app users out of the whole app, not just withdrawals.

## 5. PIN: create / change / reset (on the owner's own account, after step 2)

**No money moves in these checks:**
- Wallet → Withdrawal PIN → **Create**.
  - `1234` is refused, as are mismatched entries.
  - A good PIN entered twice gives "Set — required for every withdrawal".
  - A "Withdrawal PIN created" notification arrives.
- Withdraw sheet with a wrong PIN shows "Wrong PIN. 4 attempts left". The PIN field clears.
- **Change** → new PIN twice → account password.
  - Expect "Withdrawal PIN changed… paused for 24 hours".
  - A "Withdrawal PIN changed" notification arrives.
  - This also proves the `amr` check works in production (§6).
- Adding a bank account still works with the password, which also tests `assert_recent_auth`.

**If Change or bank-add fails with "Password confirmation failed":** stop and check §6. Roll back with §8 if needed.

## 6. The `amr` password-recency check

**What it assumes:**
- Supabase Auth puts `amr: [{method, timestamp}]` in every access token, most recent first.
- A password sign-in adds `{method: "password", timestamp: <sign-in time>}`.
- A token refresh keeps the original timestamp.

This matches Supabase's own documentation (JWT claims reference; "How do I check when a user went through MFA?"). That page recommends exactly this pattern for requiring a recent password.

**How it is used:** `save-bank` re-checks the password with a fresh `grant_type=password` sign-in and calls the database with *that* token, so the timestamp is seconds old.

**What could break it:**
- A **Custom Access Token hook** that drops `amr`.
- A future Auth change.

**Verify safely, without production SQL or money:**
1. Dashboard → Authentication → Hooks: no "Customize Access Token" hook, or one that keeps `amr`.
2. In the browser console on getvents.com, signed in:

   ```js
   JSON.parse(atob(JSON.parse(localStorage.getItem('vents_supabase_auth')).access_token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))).amr
   ```

   It reads only your own session in your own browser and sends nothing anywhere.

   Or decode the token at any offline JWT decoder. Expect `[{ method: 'password', timestamp: … }]`.
3. The read-only `auth.mfa_amr_claims` query in §0 shows `password` rows.
4. After step 2, run the Change PIN test in §5.

## 7. Two-admin approval and the Paystack transfer [owner: this moves real money]

Use a small real withdrawal (for example ₦100) from an organizer account that is **not** one of the two approving admins:

1. Payouts shows it as "Needs 1st approval" for an admin *and* a sub-admin, the same row in both.
2. A sub-admin presses **Approve (1st)**. Expect "Needs 2nd approval" and the user sees "Waiting for second approval".
3. The same sub-admin has no **Approve (2nd)** button; the note says a different admin must give it. A second sub-admin is told it needs a full admin.
4. A full admin presses **Approve (2nd)** and types APPROVE. Expect "Approved · ready to pay" and the user is notified.
5. **Pay now** (type PAY). Expect "Processing (Paystack)". In the Paystack dashboard, check the transfer reference `payout_<request id without dashes>` (from `payout_transfer_reference()`), the amount, and the recipient bank.
6. The webhook `transfer.success` changes it to **Paid**. If it doesn't arrive, press Reconcile. Then check:
   - the user's wallet history shows "Paid";
   - `admin_earnings_reconciliation()` shows no gaps (run it as an admin per runbook §3a);
   - Check payout exceptions shows none.
7. Optional: reject a second small request while it waits for its first approval. The money returns, the user sees the reason, and the open first approval is closed.

## 8. Rollback [owner]

1. `SET vents.rollback_confirm = 'undo-0211';` then run `supabase/rollback/undo_0211.sql` in one transaction, followed by `NOTIFY pgrst, 'reload schema';`.
2. **What it restores:**
   - the 0203 executor, the 0205 guard and the 0004 `assert_recent_auth` (verbatim);
   - clients' access to `request_organizer_payout`.
3. **What it never touches:**
   - money, wallets, the ledger;
   - withdrawal requests and approvals;
   - admin requests, admin logs and notifications.
4. **PIN data is kept.** `withdrawal_pins` and `withdrawal_pin_events` stay, closed to clients and unused. Re-applying 0211 restores every PIN.
5. The live web app falls back to the previous flow automatically; no redeploy is needed.
6. Approvals already given under 0211 stay valid. New second approvals need a super admin again.
7. Verified locally: the exact pre-0211 functions, grants, constraints and triggers; history, approvals and PINs kept; re-apply equal to the first apply.

## 9. Production record (2026-11-09 / 2026-11-10)

### §0 pre-check (read-only), before applying

| Check | Result |
|---|---|
| `guard_is_0205` / `executor_is_0203` / `assert_recent_auth_is_0004` | true / true / true |
| `not_yet_applied` | true |
| pgcrypto | installed (schema `extensions`) |
| `request_organizer_payout` overloads | only `(bigint,uuid,text)` |
| `amr` claims, last 30 days | `password` 12, `otp` 23 |
| Open withdrawals | 6 pending, ₦49,300 in total; 0 processing |
| Duplicate / open first approvals | 0 / 0 |
| Custom access-token hook | none |
| `payouts_disabled()` | false |

### §1 Backup

- Run 42712563242 on `claude/o4-cloud-rehearsal`: success.
- 103/103 tables restored, 103/103 row counts match.
- Function fingerprints are only *reported* by this workflow (0/19), not enforced.

### §2 Apply and verify (read-only queries after the apply)

- `authenticated` can execute `request_organizer_payout`: **false**. The same holds for `anon`.
- `authenticated` can execute `request_withdrawal`: **true**. For `anon` it is false.
- `withdrawal_pins` and `withdrawal_pin_events` are readable by clients: **false**.
- Both triggers are present: `authorize_withdrawal_first_approval_check` and `withdrawal_close_open_authorizations`.
- Guard md5 is `03cd98dc…` and executor md5 is `c46d5a83…`; both are the 0211 bodies.
- **Real data was unchanged by the apply.** These hashed byte-for-byte identical before and after:
  - `organizer_withdrawal_requests` (20 rows)
  - `admin_action_requests` (10 rows)
  - `organizer_wallets`
  - `user_wallets`
  - `user_wallet_transactions`
  - `vents_wallets`

### No old path bypasses the new rules (production, read-only)

- **Withdrawal rows are created by only two functions:**
  - `request_organizer_payout`, which clients cannot execute;
  - `request_withdrawal`, which checks the PIN and then calls it internally.
- **No client role can write directly** to `organizer_withdrawal_requests`, `admin_action_requests`, `organizer_wallets`, `user_wallets`, `organizer_bank_accounts` or `withdrawal_pins`. `anon` and `authenticated` have no INSERT, UPDATE or DELETE on any of them.
- **`vc_withdrawal_requests`:**
  - it has 0 rows;
  - no function inserts into it;
  - clients have no INSERT or UPDATE on it.
- **Server API routes** never call `request_organizer_payout`.
- **The web app** falls back to the old call only when the 0211 functions are missing. Even then the server refuses it.

### §5/§7 equivalent: production end-to-end run, rolled back

`scripts/ops/withdrawal-0211-prod-e2e.sql` ran once against production as a single `DO` block that ends by raising an exception. Postgres therefore rolled back every row it wrote.

**How it ran:**
- **Accounts:** only test accounts, with uuid `…e2xx` and emails `@example.invalid`.
- **Calls:** every call was made as the real `authenticated` role with the user's JWT claims.
- **Paystack was never called.** Claim, complete and fail are the database functions the webhook uses.

**Result: 84 of 85 checks passed.** The one failure was the script's own expectation. It assumed the reference format `payout_<uuid with dashes>`, but the reference is `payout_<uuid without dashes>` (the pre-existing `payout_transfer_reference()`). The script in the repo now expects the real format.

**Covered:**
- **Old paths closed:**
  - the old entry point;
  - `anon`;
  - direct INSERT;
  - a raw UPDATE to `processing`, refused by the guard;
  - `admin_mark_payout_processing` on an unapproved request, which is refused and leaves the request unchanged.
- **PIN creation:**
  - length, mismatch, 1234 and 1111 refused;
  - bcrypt cost 10;
  - the table and the internal check are closed to clients;
  - the status never contains the PIN;
  - the "created" notification.
- **Wrong PIN:**
  - 4 attempts left after the first, with no money moved;
  - locked after 5, for 30 minutes, and the correct PIN is refused while locked;
  - the 3rd lock in a row requires a reset;
  - the "locked" notification;
  - audit events.
- **Recovery:**
  - refused with no password, with a password 1 hour old, or after an OTP sign-in;
  - accepted with a password just entered;
  - the old PIN is dead afterwards;
  - a 24-hour pause;
  - the "changed" notification;
  - `assert_recent_auth` refuses an iat-only token and accepts a fresh password `amr`.
- **Requests:**
  - below ₦100, over the balance, and another user's bank are refused;
  - success moves ₦30,000 to pending;
  - a replay with the same key creates no second debit;
  - an identical request with a new key is refused as a duplicate;
  - the user's history shows the stage and a masked account;
  - other users cannot see it.
- **Approvals:**
  - non-admins are refused;
  - nothing can be claimed before both approvals;
  - a first approval with the wrong amount is refused;
  - a sub-admin's first approval records the recipient;
  - a duplicate first approval is refused, including via `request_admin_action`;
  - the first approver cannot give the second;
  - two sub-admins are refused, including via `approve_admin_action`;
  - the dashboard note is shown;
  - a full admin's second approval gives "approved", and the user is notified;
  - a third approval is refused;
  - admin and sub-admin lists are identical.
- **Payout:**
  - one claim per withdrawal (a second click does not claim);
  - processing until Paystack confirms;
  - `complete_organizer_payout` gives paid, with pending cleared;
  - admin-first then sub-admin-second works;
  - `fail_organizer_payout` gives failed, with the money back.
- **Rejection:**
  - a sub-admin is refused;
  - a full admin rejects, which closes the open first approval, returns the money and tells the user the reason;
  - a rejected withdrawal cannot be approved afterwards.
- **Own withdrawal and recipient changes:**
  - an admin cannot approve their own withdrawal, at either step;
  - only the first approver can withdraw the first approval;
  - a bank recipient changed between approvals refuses the second approval.
- **Real data:** every real withdrawal, approval and wallet row was unchanged during the run, and the test ledger reconciles.

**After the run (read-only):**
- 0 test users and 0 PINs remain.
- The withdrawal and wallet hashes equal the pre-apply values.
- `net.http_request_queue` is empty, so no push was sent.

### Not verified, and why

- **A real Paystack transfer.** No money may be moved for testing. Step 7 (a small real withdrawal) is the owner's call.
- **The browser UI on getvents.com against production**, signed in. It needs a real account's password, and it is covered by the component tests in #93.

### Remaining external blockers

- **Android:**
  - The signed build, run 42712583395, failed with `Secret VITE_SUPABASE_URL is missing in the android-release environment`.
  - The owner must add the `android-release` secrets listed in `.github/workflows/android-release.yml`, run "Android release", then upload the `.aab` to Play.
- **iOS:**
  - The unsigned compile check was dispatched on `main`.
  - A store build needs the owner's Apple Developer team, an App Store Connect record and `GoogleService-Info.plist` (`IOS_LAUNCH_CHECKLIST.md`).
- **Old store builds:**
  - Until the new builds ship, their users get "permission denied" at withdrawal and must use getvents.com.
  - After the builds ship, raise `app_config.min_client_version` (§4.3).
- **Backups from `main`:** the backup workflow still runs only from `claude/o4-cloud-rehearsal` until `main` is allowed in the `o4-backup` environment.

## 10. Native release 1.3.0 and 0212: production record (2026-11-10)

**Merged:** PR #96 (`3999b70`).
- Migration 0212 and `undo_0212`.
- Version 1.3.0 everywhere: web, Android versionCode 5, iOS build 5.
- The update screen sends app users to their store.
- Android workflow hardening, and a new `ios-release.yml`.
- `GoogleService-Info.plist` is now bundled by the Xcode project.

**0212 apply (production):**
- **Backup first:** run 42786555398, artifact `vents-db-backup-20261110T085632Z`, `restore_tables=105/105`, `restore_rows=105/105`.
- **Applied** as one transaction through `migration_fetch` with an md5 check, followed by `NOTIFY pgrst`.
- **After applying:**
  - `request_organizer_payout`: `authenticated` true, `anon` false, not SECURITY DEFINER.
  - `request_organizer_payout_core`: `authenticated` and `anon` false. Its body md5 is `e23e0e8b…`, byte-identical to the function before the rename.
  - `request_withdrawal` calls the core.
  - Withdrawal, approval, organizer wallet, user wallet, wallet transaction, organizer transaction and PIN tables are byte-identical before and after the apply.

**Production end-to-end, rolled back** (`scripts/ops/withdrawal-0211-prod-e2e.sql`, updated for 0212): **87 of 87 passed.**
- It includes the new checks:
  - an old-app call returns "Please update VENTS to withdraw… getvents.com.";
  - that call creates no request and moves no money;
  - clients cannot call the core function.
- After the run: 0 test users, unchanged hashes, an empty push queue.

**Native builds on `main` (`3999b70`):**
- **iOS compile check** (unsigned, simulator): success.
- **Android, unsigned verification** (run 42794755494): success.
  - The AAB is versionName 1.3.0, versionCode 5, and its bundled web app contains the PIN flow.
  - Artifact `vents-android-UNSIGNED-not-for-store-3999b70…` (6.98 MB, 3 days). It is not for the store.
- **Android, signed** (run 42786560303): stopped at the secrets check. Missing in `android-release`:
  - `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_PAYSTACK_PUBLIC_KEY`, `VITE_GOOGLE_PLACES_API_KEY`;
  - `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`;
  - `GOOGLE_SERVICES_JSON_BASE64`.
- **iOS, signed** (run 42786564447): stopped at the secrets check. Missing in `ios-release`:
  - `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_PAYSTACK_PUBLIC_KEY`, `VITE_GOOGLE_PLACES_API_KEY`;
  - `GOOGLE_SERVICE_INFO_PLIST_BASE64`;
  - `APP_STORE_CONNECT_API_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`, `APP_STORE_CONNECT_API_KEY_P8_BASE64`.

**What only the owner can do:**
1. Add the secrets above. Values come from:
   - Vercel Production;
   - the Play upload keystore;
   - Firebase project settings (Android and iOS apps `com.getvents.app`);
   - an App Store Connect API key with the Admin role.
2. Run *Android release* (signed) and *iOS release* on `main`.
3. Download the `.aab` and `.ipa` artifacts, upload them to Play Console and App Store Connect, and submit them for review.
4. Once both 1.3.0 builds are live in the stores, raise `app_config.min_client_version` to `1.3.0`. Not before.

No store submission has been made, and none is claimed.
