# Ticket payment integrity (migration 0220, OEL-01)

**Status:** implemented and verified **locally only**. Not applied to production. Not deployed.

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
`scripts/local-pg-test/run-ticket-integrity-verification.sh`: 60 checks.
- **Before 0220:** reproduces the defect. An unpaid ticket is minted, signed, and checked in by QR and manually.
- **After 0220:** free, 100%-promo, Paystack and wallet tickets work; transfers work; cancelled and refunded tickets are refused; duplicates are refused; the capacity race holds; the 0218/0219 guards hold; undo and re-apply work; drift is refused.

With 0220 removed, 17 checks fail.

The static pin is `src/lib/ticketPaymentIntegrity.security.test.ts`.

## Open decisions (owner)
1. **Existing pending tickets.** Any unpaid tickets already minted through the hole still exist and still count toward capacity. After 0220 they no longer admit anyone. Whether to count, cancel or keep them is a business decision. Counting them in production needs explicit authorization (an aggregate read only).
2. **Pending-ticket inventory and expiry.** Should a `pending` ticket hold a seat, and for how long? No expiry or cleanup was invented here.
3. **My Tickets UI.** A non-paid ticket now gets no QR. The ticket screen may show "Generating…" indefinitely instead of a clear "payment not confirmed" state. A small UI follow-up is suggested.
4. **OEL-02, orphan payments when finalization is refused,** is a separate fix and is not addressed here.
