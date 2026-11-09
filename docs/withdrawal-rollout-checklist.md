# Withdrawal security rollout (migration 0211): production checklist

**State on 2026-11-09:**
- PR #93 is merged: `b5efac7`.
- getvents.com serves `dpl_CrhYPDSYKWWzbagyopNA3BE5KkfT` (READY, commit `b5efac7`).
- 0211 is **not applied**. The live web app therefore runs its fallback: the previous withdrawal flow, with no PIN and the previous approval rules. Face ID is already gone from the wallet.

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

## 4. Native apps (Android / iOS)

Store builds bundle their own web code. **Builds from before `b5efac7` call `request_organizer_payout` directly. After step 2 they get "permission denied" and cannot withdraw.** They can still use getvents.com.

**Recommended order:**

1. **Before step 2:**
   - Build Android from `b5efac7` or later. The `android-release` secrets are needed, so this is [owner].
   - Build iOS (Apple signing and `GoogleService-Info.plist` [owner]).
   - Release both to the stores. These builds work with or without 0211.
2. Apply 0211 (step 2) once the new builds are live.
3. Raise `app_config.min_client_version` to the new version [owner, production write], so old builds are told to update rather than failing at withdrawal.

**If 0211 must go first:** tell app users to withdraw on getvents.com until the update ships.

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
5. **Pay now** (type PAY). Expect "Processing (Paystack)". In the Paystack dashboard, check the transfer reference `payout_<request id>`, the amount, and the recipient bank.
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
