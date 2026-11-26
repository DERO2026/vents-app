# N1: price changes during an open checkout (investigation and proposed fix)

**Status:** investigated on `main` at `8663202` (2026-11-26). **Not implemented. Waiting for owner approval.**
**Severity:** High. Money is charged and then judged against a price the buyer never agreed to.

## How the amount flows today

Function bodies are as production should have them after 0203, 0208, 0220 and 0229 (`scripts/local-pg-test/live-money-functions.sql` plus those migrations' in-place patches).

| Stage | Code | Source of the amount |
|---|---|---|
| 1. Ticket selection | `TicketSelectScreen`, `useTicketQuote` → `ticket_fee_quote` | The tier's **current** price, quoted by the server |
| 2. Order created | `create_pending_purchase` | Computes `amount_kobo` from the **current** price × attendees, the promo discount and the 0208 buyer fee, and stores it in `pending_purchases.amount_kobo` with `fee_model`. **The unit price and discount are not stored.** |
| 3. Order reused | same function | An identical pending order from the last 30 minutes is returned **with its old `amount_kobo`**, even if the price has changed since. |
| 4. Payment attempt | `initiate_ticket_payment_attempt` (0060) | Returns `pending_purchases.amount_kobo` and a `PSK-` reference |
| 5. Paystack popup | `CheckoutScreen.tsx` (`amountMatchesQuote`) | Charges exactly `pending_purchases.amount_kobo`. The screen refuses to open Paystack if that differs from the quote it displayed, so **the buyer is never charged an amount they didn't see**. |
| 6. Verify / webhook | `api/webhook/paystack.ts` → `finalizeAndConfirmPurchase` | Paystack's reported `amount` (what was actually charged) |
| 7. Ticket issued | `finalize_pending_purchase` | **Re-reads the tier's CURRENT price** (by current or previous name since 0229) and **re-reads the promo** (no active, expiry or usage check), and writes them to `tickets.amount` and `tickets.discount_percentage`. |
| 8. Payment confirmed | `confirm_ticket_payment` (0203/0208) | Expected = `ticket_fee_buyer_charge_kobo(sum(tickets.amount), …)`, i.e. based on the **current** price. The charge is accepted if `paid ≥ expected`. The organizer is credited from `tickets.amount`. |
| 8w. Wallet payment | `confirm_ticket_payment_via_wallet` | **Debits the wallet by the expected amount computed from `tickets.amount` (current price)**, not by `pending_purchases.amount_kobo`. |
| 9. Refund | `refund_ticket` / `finalize_ticket_refund` (0208) | Computed from `tickets.amount`, i.e. the price at step 7 |
| 10. Exceptions | 0226 `payment_exceptions` | Records `not_found` / `amount_mismatch` after step 8 |

**Root cause:** the agreed amount is only fixed at step 2, and only as a total. From step 7 on, every money calculation uses whatever the tier and promo say at that moment.

## What goes wrong

| Change made by the organizer between steps 2 and 7 | Paystack path | Wallet path |
|---|---|---|
| **Price raised** | Paid < expected, so `amount_mismatch`: **charged, no ticket** (recorded as a payment exception by 0226) | **Wallet debited more than the agreed amount** |
| **Price lowered** | Accepted. The ticket records the lower price, the organizer is credited on it, and **the buyer's overpayment is kept with no record or refund**. Refunds later return only the lower amount. | Wallet debited less than agreed (buyer gains) |
| Promo deleted or percentage changed | Same as raised or lowered | Same |
| Tier deleted, or re-linked by an older app build (finding N3) | `Ticket type not found`, or the ticket is issued **at another tier's price** | Same |
| Price changed, buyer retries within 30 minutes | Step 3 returns the old amount, the screen refuses it ("price changed"), and **the buyer is stuck until the 30-minute window passes** | Same |

Also seen: ordinary pending purchases have no expiry and nothing cleans them up. Only "someone else is paying" requests expire, after 48 hours.

## Proposed fix (migration 0230; additive; fee model unchanged)

1. **Immutable snapshot at step 2.** Add `pending_purchases.unit_price_kobo` and `pending_purchases.discount_pct` (nullable, additive). `create_pending_purchase` stores the exact unit price and discount it used to compute `amount_kobo`.
2. **Finalize uses the snapshot.** When the snapshot is present, `finalize_pending_purchase` writes `tickets.amount` and `tickets.discount_percentage` from it and never re-reads the tier price or the promo. Capacity, event state and attendee checks stay as they are. Rows created before 0230 (snapshot NULL) keep today's behaviour, so nothing in flight changes meaning.
3. **The agreed total is authoritative at confirmation.**
   - `confirm_ticket_payment`: when a pending purchase exists, expected = `pending_purchases.amount_kobo`. With the snapshot this equals today's formula by construction. If they ever differ, return `amount_mismatch` (recorded by 0226) instead of guessing.
   - `confirm_ticket_payment_via_wallet`: debit exactly `pending_purchases.amount_kobo`.
   - Organizer credit and deduction keep the 0208 formulas, applied to the snapshot price, so the fee model is unchanged.
4. **No stale reuse.** The 30-minute reuse in `create_pending_purchase` also requires the same unit price and discount. A price change produces a fresh order at the new price, so the screen's "price changed" check can actually move on.
5. **Idempotency:** unchanged. Finalize still locks the pending row and no-ops once completed; confirm still no-ops once paid; 0226 records stay idempotent per reference.
6. **Charged but not issued** (capacity reached, event ended or cancelled, tier deleted): stays recorded by 0226, and is refunded only with two admin approvals (D4, batch B3c).
7. **Not changed:** fee rates and formulas (0208), Paystack integration, client quote logic, refund policy, existing tickets and ledgers (no backfill).

## Files to change
- **New:** `supabase/migrations/0230_checkout_price_snapshot.sql` (in-place patches with exact anchors, refusing on drift, coexisting with 0203, 0208, 0220 and 0229), `supabase/rollback/undo_0230.sql`.
- **Patched functions:** `create_pending_purchase`, `finalize_pending_purchase`, `confirm_ticket_payment`, `confirm_ticket_payment_via_wallet`.
- **App code:** none required. `CheckoutScreen` already refuses a charge that differs from the quote. Optionally add a clearer "the price changed, here is the new total" retry.
- **Tests:** `scripts/local-pg-test/run-checkout-price-snapshot-verification.sh`, on the same production-copy stack as the 0229 suite. It should cover:
  - raise and cut between create and finalize, on both the Paystack and wallet paths;
  - promo deleted or changed;
  - legacy NULL-snapshot rows unchanged;
  - reuse after a price change;
  - organizer credit and deduction on the agreed price;
  - refund amount equals what was charged;
  - drift refusal and undo.

  Plus a static vitest guard.

## Open questions for the owner
- When an order's agreed price differs from the current price, should the organizer still be credited on the **agreed** price? That's what the proposal does, and it matches what the buyer paid.
- Should ordinary pending purchases get an expiry (for example 24 hours) so a very old quote can't be finalized? This is a policy choice; the proposal doesn't add one.
