# Ticket payment integrity (migration 0220, OEL-01)

**Status:** implemented and verified locally on top of `main` (0221–0225 present). Not applied to production. Tracked as C1 in `docs/repair-tracker.md`.

## Defect
Three repository functions, taken together, gave free entry to a paid event:
- `purchase_ticket` (0124) is granted to `anon` and `authenticated`. Called directly for a paid tier, it inserted an `active` ticket with `payment_status = 'pending'` and charged nothing.
- `generate_ticket_token` (0024) signed an entry pass for any ticket its owner held, paid or not.
- `verify_entry_pass` and `manual_check_in` (0147) admitted any `active` ticket. Neither function read `payment_status`.

The app never takes this path: it uses `purchase_ticket_with_tokens` → `purchase_ticket` for free orders only. A direct RPC call is all an attacker needs.

## Fix (0220)
| Function | Change |
|---|---|
| `purchase_ticket` | Raises when the effective price (tier price less any promo) is above 0. Free tiers and 100% promos are unchanged: still issued `paid` at ₦0. |
| `generate_ticket_token` | Signs only a ticket that is `active` and `paid`. For any other ticket it returns **NULL** and does not raise, because `finalize_pending_purchase` calls it mid-transaction on the wallet path while the ticket is still pending. Raising would abort legitimate wallet purchases. |
| `verify_entry_pass`, `manual_check_in` | Refuse `payment_status <> 'paid'` with reason `not_paid`, logged to `scan_log` as `invalid`. The refusal comes before the duplicate check. Row lock, HMAC, expiry and holder checks, atomic check-in and duplicate detection are untouched. |

**Not changed:**
- `create_pending_purchase`, `finalize_pending_purchase`, `confirm_ticket_payment(_via_wallet)`;
- refunds, transfers, 0218/0219 cancellation;
- fees, earnings;
- grants.

No rows are changed and no money moves.

## How it is applied
Each function is patched **in place** from `pg_get_functiondef`. Each anchor must match exactly once and each patch is marked `[0220]`. Any drift refuses the whole migration, which runs as one transaction and is idempotent.

**Before production:** confirm, read-only, that the live bodies of the four functions match the repository versions. The repository versions are 0124, 0024 and 0147 respectively. If they differ, the migration refuses rather than mis-patching, and the anchors must be re-derived from the live text.

**Rollback:** `supabase/rollback/undo_0220.sql`, gated by `SET vents.rollback_confirm = 'undo-0220'`. It restores the exact prior bodies (verified locally by hash).

## Verification
Both commands run against a local PostgreSQL over its Unix socket (start it with `sudo pg_ctlcluster 16 main start`). They create and always drop the throwaway database `vents_local_pg_ticket_integrity`.

```bash
scripts/local-pg-test/run-ticket-integrity-verification.sh      # 141 checks, with 0220
scripts/local-pg-test/run-ticket-integrity-mutation-test.sh     # with and without 0220
```

**Mutation test.** It runs the harness twice:
- **With 0220:** all 141 checks must pass.
- **Without 0220** (`WITHOUT_0220=1`): 0220 is not applied, and the 23 migration-mechanics checks are skipped. The run must reproduce the hole. Exactly the 18 checks tagged `[0220]` must fail: no fewer, so each one detects the missing fix; and no more, so every other check covers behaviour that doesn't depend on 0220.

**What the harness covers.** Every scenario calls the real database functions:
- **Fidelity:** each function the harness loads is re-checked, byte for byte, against its latest migration (`check-verbatim-functions.py`).
- **Reproduction** of the defect before 0220.
- **Direct purchases:** a paid tier is refused; free and 100%-promo tickets are still issued.
- **Paystack and Someone Else Pays:** `create_pending_purchase` → `finalize_pending_purchase` → `confirm_ticket_payment`.
- **VENTS Wallet:** the wallet function's first call (no pre-finalize); retry; a refused purchase that rolls back completely; insufficient balance then top-up; two simultaneous first calls.
- **Transfers:** `initiate_ticket_transfer` → `accept_ticket_transfer` (refuses until the fee is paid) → `initiate_transfer_fee_payment` → `confirm_transfer_fee_payment`, plus refusals for unpaid, checked-in, refunded, refund-pending and cancelled tickets.
- **Refunds and reversal:** wallet refund; Paystack refund in flight; `admin_revert_stuck_refund`; the `fail_ticket_refund` and `finalize_ticket_refund` webhooks.
- **QR passes:** tampered signature, wrong secret, expiry.
- **Duplicates and concurrent check-in:** one session holds the row lock while a second one waits; also five simultaneous double scans.
- **Capacity and cancellation:** the capacity race; the 0218/0219 guards.
- **Function attributes:** owner, SECURITY DEFINER, `search_path` and the full ACL, read from `pg_proc` before and after 0220, after undo, and after a refused apply. Anon is refused at call time.
- **Undo and drift:** undo; then drift of `generate_ticket_token`, where 0220 refuses, names that function, and leaves every function exactly as it was.

**Set directly, as labelled test setup, not through a product function:**
- users, events and promo codes;
- one wallet top-up;
- the reset of the reproduction check-ins;
- one `failed` payment;
- one deliberately inconsistent cancelled-but-paid ticket. No product path produces it.

**Not under test:** rate limits (`check_rate_limit` is a local no-op stub) and VENTS Cents accounting (`award_vc_reward` is a stub).

**Static checks.** `src/lib/ticketPaymentIntegrity.security.test.ts` pins the 0220 text and the harness's fidelity rules: no simulated transfers, no wallet pre-finalize, the drift test, and the mutation comparison.

**Apply 0220 in one transaction.** Applied in one transaction, a drift refusal rolls back every patch; the harness proves this. Applied statement by statement (`psql -f` without `-1`), the same refusal leaves the earlier functions patched. `undo_0220` cleans that partial state up, as the harness shows.

**Existing behaviour, not changed by 0220.** A wallet payment refused for insufficient balance leaves its ticket created and `pending`. 0220 makes that ticket unusable until the same checkout is paid; paying it then confirms the same ticket, with no duplicate.

## Open decisions (owner)
1. **Existing pending tickets.** Any unpaid tickets already minted through the hole still exist and still count toward capacity. After 0220 they no longer admit anyone. Whether to count, cancel or keep them is a business decision. Counting them in production needs explicit authorization (an aggregate read only).
2. **Pending-ticket inventory and expiry.** Should a `pending` ticket hold a seat, and for how long? No expiry or cleanup was invented here.
3. **My Tickets UI.** A non-paid ticket now gets no QR. The ticket screen may show "Generating…" indefinitely instead of a clear "payment not confirmed" state. A small UI follow-up is suggested.
4. **OEL-02, orphan payments when finalization is refused,** is a separate fix and is not addressed here.
