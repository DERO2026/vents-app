# Earnings and withdrawals: money-flow audit

Audit of 2026-10-30. It covers organizer, service-provider and representative
withdrawable earnings, which all share one earnings wallet.

**Evidence:**
- live production function definitions, grants and RLS (read-only);
- read-only aggregates of production money tables;
- the repo's API handlers and UI.

**Fixes:** migration `0202_payout_engine_safety.sql` and the API changes,
on PR #82. **Not applied to production.**

## Flow

| Stage | Where |
|---|---|
| Earn (ticket) | `confirm_ticket_payment` / `confirm_ticket_payment_via_wallet` → `credit_organizer_wallet` (row lock on the ticket, one credit per ticket) |
| Earn (booking) | `confirm_service_booking_payment(_via_wallet)` → `credit_provider_wallet_for_booking` (row lock, one credit per booking) |
| Earn (representative) | 0201: claim → organizer confirms → two admins → profit-pool reserve → `claim_representative_reward` (one credit per claim) |
| Bank account | `api/wallet/save-bank.ts`: Paystack resolve + transfer recipient → `add_bank_account_confirmed`. Clients cannot write bank, wallet, ledger or withdrawal tables directly (no INSERT/UPDATE/DELETE grants). |
| Request | `request_organizer_payout`: available → pending, under a row lock, with an idempotency key |
| Approve | `api/wallet/admin-payout-action.ts`: `admin_claim_payout_for_processing` (pending → processing, sets the fixed reference) → Paystack `POST /transfer` → `admin_mark_payout_processing` |
| Confirm | Signed webhook `api/webhook/paystack.ts`: <br>• `transfer.success` → `complete_organizer_payout`; <br>• `transfer.failed` → `fail_organizer_payout`; <br>• `transfer.reversed` → `reverse_organizer_payout` |
| Reconcile | `api/wallet/reconcile-payouts.ts`: asks Paystack by transfer code or reference |
| Refund | `refund_ticket`, `finalize_ticket_refund`, `cancel_service_booking`, `finalize_service_booking_refund` |

The ledger invariant is: credits − debits = available + pending. It is
checked by `admin_earnings_reconciliation()`.

## Status

| # | Defect | Status |
|---|---|---|
| P0-1 | Cancelling a payout already sent to Paystack returned the money while the transfer could still succeed (paid twice). Production has 4 such ₦100 test requests, cleared by hand on 2026-07-12. | **Fixed in 0202.** <br>• Cancel refuses once a reference or code exists. <br>• A success for an already-cancelled request takes the returned money back, never below zero; any shortfall goes to the admin log. <br>• The admin screen says to use Reconcile. |
| P0-2 | `transfer.reversed` after `transfer.success` was ignored, so the organizer lost the money. | **Fixed:** `reverse_organizer_payout` returns it to the available balance once (status `reversed`, ledger `payout_reversal`). |
| P0-3 | A random reference per attempt plus unchecked bookkeeping could send a second transfer on retry, or leave a transfer with no record. | **Fixed:** <br>• one fixed reference per request (`payout_<id>`), unique, kept across releases; <br>• the "mark sent" step checks its result; <br>• a release happens only on an explicit Paystack "not found"; <br>• an unknown outcome stays processing; <br>• Reconcile works by reference. |
| P1-6 | Ledger and balance disagree. Cancelling wrote a credit with no matching debit. 2 of 5 production wallets mismatch: one holds ₦32,150 more than its ledger explains, the other ₦1,000 less. | **Fixed going forward:** cancel writes no ledger credit, and `admin_earnings_reconciliation()` reports any gap. **The historical mismatch is not changed:** it needs a person to explain each entry before any adjustment. |
| P1-4 | A refund after a withdrawal debits only the available balance; the shortfall goes to the admin log and VENTS absorbs it. | **Needs a decision:** carry a negative balance, or set future earnings against the debt? |
| P1-5 | Organizer and provider earnings are withdrawable as soon as payment confirms (no settlement hold). | **Needs a decision:** a hold length, or none. Representatives already have the confirmed 7-day hold. |
| P1-7 | Payout approval is single-admin. `AGENTS.md` expects maker-checker for payments. | **Needs a decision:** route approvals through `request_admin_action` + `approve_admin_action`. This adds a second approver to every withdrawal. |
| P2 | 5 requests pending since September (₦49,100), including two identical ₦20,000 requests 10 seconds apart; no platform-level reconciliation against the Paystack balance; VENTS Cents cash-out not audited. | Open (operations / later). |

## Tests

- `scripts/local-pg-test/run-payout-engine-verification.sh` (49 checks):
  - the full lifecycle on 0201 + 0202 with the live functions;
  - the fixed reference and its uniqueness;
  - cancel refused;
  - completion once;
  - reversal once;
  - failure before success;
  - release keeps the reference;
  - legacy cancel-then-success, with and without a shortfall;
  - permissions and grants;
  - the ledger invariant after every step.
- `api/_lib/payoutEngine.security.test.ts` (15 tests, Paystack and Supabase mocked, no network):
  - approval on success, timeout, rejection, unknown outcome and a failed "mark sent";
  - Reconcile release rules and reversal routing.

  12 of the 15 fail against the previous code.
