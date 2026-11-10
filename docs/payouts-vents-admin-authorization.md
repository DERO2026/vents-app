# Payouts: VENTS Admin authority and the Admin Payout PIN (0213)

**The rule.** The VENTS Super Admin is the only person who can approve a withdrawal for payment and start the Paystack transfer.
- In the database, the VENTS Super Admin is `is_root()`: one fixed account id, not a role anyone can edit.
- Every transfer needs that admin's 10-digit **Admin Payout PIN**.
- Other admins and sub-admins can review a withdrawal and forward it, but they can never pay it.

This replaces 0211's "two different admins" approval.

**What did not change:** fees, the ₦100 minimum, settlement holds, refunds, the user's 4-digit withdrawal PIN, and every existing withdrawal, balance and ledger row.

## The two paths

| Path | Stages |
|---|---|
| **A: direct** | `pending_review` → `vents_admin_approved` → `processing` → `paid` |
| **B: reviewed** | `pending_review` → `forwarded_to_vents_admin` (or `rejection_recommended`) → `vents_admin_approved` → `processing` → `paid` |

**About reviews:**
- A review is optional and advisory. It never authorizes anything.
- The VENTS Admin can approve with or without one.
- A review is tied to the amount and bank recipient it saw. If either changes, the review is marked *outdated* and the request goes back to `pending_review`.

**Every other ending:**
- `rejected`: the money goes back to the user's available balance, with the reason shown to them.
- `failed` or `reversed`: Paystack's outcome. The money goes back.
- `cancelled`: older requests only.

A request is `paid` **only** when Paystack confirms the transfer, through the `transfer.success` webhook or Reconcile.

## Who can do what (server-enforced)

| Action | VENTS Admin (root) | Admin | Sub-admin | User / signed out |
|---|---|---|---|---|
| See requests, history and totals | ✓ | ✓ | ✓ | ✗ |
| Review: forward or recommend rejection, with a note | ✗ (approves or rejects directly) | ✓ | ✓ | ✗ |
| Reject (money back to the user) | ✓ | ✓ | ✗ (can recommend it) | ✗ |
| Approve for Payment | ✓ | ✗ | ✗ | ✗ |
| Authorize & Pay (PIN, Paystack) | ✓ | ✗ | ✗ | ✗ |
| Create, change or reset the Admin Payout PIN | ✓ (with password) | ✗ | ✗ | ✗ |
| Approve or pay their **own** withdrawal | ✗ | ✗ | ✗ | – |

**Buttons come from the server.** Each row's `can_review`, `can_approve`, `can_authorize_pay` and `can_reject` come from `admin_list_withdrawals`. The database refuses anything else, whatever a screen shows.

**Account numbers:** sub-admins see only the masked number. Full admins and the VENTS Admin see the full one.

## Admin Payout PIN

**Format:**
- Exactly 10 digits.
- Repeated or sequential patterns are refused, for example `0000000000`, `0123456789`, `9876543210`, `1212121212` and `1234512345`.

**Create, change or reset:**
- Payouts → *VENTS Admin Payout PIN* → Create / Change / Reset.
- The account password is re-checked by a fresh sign-in (`/api/v1/wallet/save-bank`, `action: set_admin_payout_pin`).
- The database also requires the token's `amr` password time to be within 5 minutes.
- The account receives a notification on every create, change and reset.

**After a change or reset:** payouts pause for **1 hour**. If you didn't make the change, change your password at once.

**Storage:**
- bcrypt, cost 12, of `vents_admin_payout:<root id>:<PIN>`.
- The tables `admin_payout_pins` and `admin_payout_pin_events` are closed to every client role.
- The PIN is never logged, returned, notified or written into an audit record.

**Wrong PINs:**
- 5 wrong PINs lock payouts for 30 minutes.
- The 3rd lock in a row requires a reset with the password.
- Each lock notifies the account.
- A wrong PIN is counted even though nothing is paid.

**The weakness of any PIN:** 10 digits is 10¹⁰ combinations. Online guessing is stopped by the locks. Offline guessing would need a copy of the database plus bcrypt cost 12 per guess. The PIN adds a second factor on top of the root session; it doesn't replace protecting that session.

## Authorize & Pay: what happens

1. The VENTS Admin presses **Authorize & Pay** and enters the PIN. The client sends:
   - the request id;
   - the reviewed amount;
   - the PIN;
   - a fresh idempotency key. A retry of the same attempt reuses the key.
2. `admin-payout-action` (`action: authorize_pay`) checks the rate limits. It allows 20 per hour per admin and 100 per hour in total, and refuses if either check itself fails.
3. It calls `admin_authorize_and_claim_payout`. In **one transaction**, that function:
   - checks that the caller is root and payouts aren't paused;
   - locks the withdrawal;
   - checks that the request is `pending`, approved for payment, not the admin's own, at the exact amount, with the approved bank account and recipient still active;
   - verifies the PIN;
   - records a `payout_authorizations` row bound to the request, amount, bank account, recipient, admin, key and **this database transaction**;
   - moves the request to `processing` with the fixed reference `payout_<request id without dashes>`.
4. The withdrawal guard refuses `pending → processing` unless such an authorization was created **in the same transaction**. The old claim, a raw UPDATE, Admin Actions and any other path therefore cannot start a transfer.
5. **Only a call that claimed the request** sends the Paystack transfer, with the fixed reference.
   - The same key again returns *already authorized*, and no second transfer is sent.
   - A second click with a new key finds the request already `processing`.
   - Concurrent clicks are serialized by the row lock: one claims, the other is refused.

## When Paystack fails or times out

| What Paystack says | What happens |
|---|---|
| Accepted | Stays `processing` until the webhook or Reconcile says success (→ `paid`) or failure (→ `failed`, money back). |
| Error, timeout or unreadable | The route asks Paystack about the fixed reference first. |
| Reference found | Recorded as sent; no second transfer. |
| Reference not found | The claim is released back to approved. The old authorization is spent, so paying again needs a new PIN entry. |
| Paystack unreachable | Left `processing`. Nothing is marked paid or released. Run **Reconcile**. |

Never create a second transfer for a request that is `processing`. Reconcile it.

## Reconciliation

- **Reconcile Processing** asks Paystack about every `processing` request and settles it.
- **Check payout exceptions** reports transfers whose state differs between Paystack and VENTS. It changes nothing.
- **Totals** come from `admin_payout_overview()` over **every** withdrawal, not from the page in the browser. Outstanding means pending plus processing.

## Deployment sequence

1. **Backup:** Actions → Database backup, with full restore parity.
2. **Apply 0213** as one transaction through `migration_fetch` plus md5, then `NOTIFY pgrst, 'reload schema'`.
   - Its drift guards refuse unless the guard, executor and `get_my_withdrawals` are 0211's.
3. **Merge**, so Vercel deploys the new Payouts screen. A screen deployed before 0213 shows "payout system is being upgraded".
4. **The VENTS Admin creates the Admin Payout PIN.** Until then, no payout is possible at all.

## Rollback

1. Pay or reject every withdrawal that is approved only by the VENTS Admin. `undo_0213` refuses while one is open.
2. Run `SET vents.rollback_confirm = 'undo-0213';`, then `supabase/rollback/undo_0213.sql` in one transaction, then `NOTIFY pgrst, 'reload schema'`.

**Restored:** 0211's two-admin guard, executor, first-approval check, list and user view; grants on the old claim; release for any admin; and the 0203 two-admin constraint. The constraint comes back `NOT VALID` if there are past VENTS-Admin-only approvals, which stay as history.

**Kept, closed to clients:** reviews, authorizations, the PIN and its events. Re-applying 0213 restores them.

**Order:** run `undo_0213` before `undo_0212` and `undo_0211`.

## Tests

- **`scripts/local-pg-test/run-payout-authorization-verification.sh`:** 141 checks on a local throwaway database. It covers:
  - the PIN rules;
  - both paths;
  - every bypass;
  - replay and concurrency;
  - bank changes;
  - lockout and recovery;
  - totals;
  - the exact rollback and re-apply.
- **API tests:**
  - `api/_lib/payoutEngine.security.test.ts`
  - `api/_lib/payoutApproval*.security.test.ts`
  - `api/_lib/adminPayoutPin.security.test.ts`
- **UI test:** `src/app/components/admin/PayoutRequestsPanel.test.tsx`.
