# Withdrawals: PIN and two-admin approval (0211)

> **Superseded for approval and payment by 0213.** The VENTS Admin is now the sole final payout authority, with a 10-digit Admin Payout PIN. Admins and sub-admins review only. See `docs/payouts-vents-admin-authorization.md`. The user's 4-digit withdrawal PIN below is unchanged.

**Production status:** live since 2026-11-10 05:50 UTC. 0211 is applied, and the web app is at `22966a3`. Native store apps still need new builds. The record of the rollout is in `docs/withdrawal-rollout-checklist.md` §9.

## How a withdrawal works now

1. **The user requests it** in Wallet → Withdraw, with their 4-digit withdrawal PIN.
   - The first time, they create the PIN and enter it twice.
   - `request_withdrawal` checks the PIN against its bcrypt hash and enforces the ₦100 minimum.
   - It refuses an identical request made in the last 2 minutes, then moves the money from available to pending.
   - `request_organizer_payout` is no longer callable by clients.
2. **First approval.** Any admin or sub-admin uses Payouts → **Approve (1st)**, which calls `admin_first_approve_withdrawal`.
   - Each withdrawal has at most one open first approval.
   - The withdrawing user can never approve their own withdrawal.
   - The first approval records the bank recipient that was reviewed.
3. **Second approval.** A *different* admin or sub-admin uses **Approve (2nd)**, which calls `admin_approve_withdrawal`.
   - At least one of the two approvers must be a full admin, so two sub-admins cannot authorize a withdrawal alone.
   - If the bank recipient changed since the first approval, the second approval is refused.
   - Admin Actions (`approve_admin_action`) still works and follows the same rule.
4. **Pay now.** Any admin can press it once both approvals exist. It runs `admin-payout-action` → `admin_claim_payout_for_processing` → Paystack.
   - The claim and the 0205 guard refuse anything not approved twice.
   - The claim is atomic, so two clicks produce one transfer.
5. **Paid** only when Paystack confirms the transfer (webhook or Reconcile). If the transfer fails or is reversed, the money returns to the available balance.

Rejecting is still restricted to full admins (unchanged). Rejecting a withdrawal also closes any open first approval and tells the user why.

## Stages (the same everywhere)

`admin_list_withdrawals` (admins and sub-admins) and `get_my_withdrawals` (the user) return one of these stages:

- `pending_first_approval`
- `pending_second_approval`
- `approved` (ready to pay)
- `processing`
- `paid`
- `rejected`
- `failed`
- `cancelled`
- `reversed`

The admin list also says which actions *this* admin may take (`can_*`) and, when they can't, why (`action_note`).

## PIN rules

| Rule | Value |
|---|---|
| Length | 4 digits; refuses 1111, 1234, 4321, 1212-style PINs |
| Wrong attempts | 5 → locked 30 minutes; the 3rd lock in a row → must reset |
| Reset / change | Only with the account password entered in the last 5 minutes. Password checked by `/api/v1/wallet/save-bank` (`action: reset_withdrawal_pin`); the database also checks the token's `amr` time |
| After a reset | New withdrawals pause for 24 hours; the user is notified |
| Storage | bcrypt (cost 10) of `user_id:PIN`; table closed to every client role; never returned |

**Limit of any 4-digit PIN:** there are only 10,000 PINs. Online guessing is stopped by the attempt limits, but anyone holding a copy of the database could brute-force a hash offline. The PIN is a second factor on top of the login session, not a replacement for protecting the database.

## Deploy order

1. Take a fresh backup (Actions → Database backup).
2. Apply `supabase/migrations/0211_withdrawal_pin_and_two_admin_approval.sql` in one transaction.
   - Its drift guard refuses if the live guard or executor is not the 0205 / 0203 body it was written against.
3. Deploy the web app. Store apps need a new build.
   - A frontend deployed **before** 0211 keeps the previous flow (no PIN) until 0211 is applied.
   - After 0211, old app builds cannot request withdrawals (the old entry point is closed); users must update.

Every user creates a PIN on their next withdrawal. Existing pending withdrawals and their approvals are unchanged.

**Verify:**

```sql
select pg_get_functiondef('public.request_withdrawal(bigint,uuid,text,text)'::regprocedure);
select has_function_privilege('authenticated', 'public.request_organizer_payout(bigint,uuid,text)', 'execute'); -- false
```

**Old app builds (0212):** the old entry point `request_organizer_payout` is now a message that tells old store builds to update the app or use getvents.com (SQLSTATE `VU426`, detail `APP_UPDATE_REQUIRED`).
- The real function is `request_organizer_payout_core`. Clients cannot call it; only `request_withdrawal` uses it.
- Rollback: `SET vents.rollback_confirm = 'undo-0212';` then run `supabase/rollback/undo_0212.sql`.

**Rollback of 0211:** run undo_0212 first (undo_0211 refuses while 0212 is applied). Then `SET vents.rollback_confirm = 'undo-0211';` and run `supabase/rollback/undo_0211.sql`.
- PINs are kept (closed and unused), so re-applying 0211 restores them.
- Money, withdrawals, approvals and the ledger are untouched.
- The app falls back to the previous flow by itself; no redeploy is needed.

Full sequence: `docs/withdrawal-rollout-checklist.md`.

**Tests:**
- `scripts/local-pg-test/run-withdrawal-pin-approval-verification.sh`: 149 checks, including 0212 and its rollback, local throwaway database only.
- `scripts/ops/withdrawal-0211-prod-e2e.sql`: the same flow against production, as test accounts, inside one statement that always rolls back.
