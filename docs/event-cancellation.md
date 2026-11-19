# Event cancellation, refunds and attendee protection (Batch 2: migrations 0218 + 0219)

- `supabase/migrations/0218_event_cancellation_workflow.sql`: the workflow.
- `supabase/migrations/0219_event_cancellation_safety_fixes.sql`: fixes from the pre-release review (`docs/event-cancellation-review.md`).

**Status:**
- **Neither migration has been applied by this work.** Applying them needs owner approval and an authorized operator; nothing here has been run against production.
- **The frontend half of 0218 is already live.** PR #112 was merged and deployed to production on 2026-11-18, before 0218 was applied. What that means is under *Runbook*.

## What was wrong
- An organizer could soft-delete an event with paid tickets, through `soft_delete_event` or a direct `UPDATE events SET deleted_at`. The events RLS policy lets the owner update any column. Nothing refunded the ticket holders or told them anything.
- `select_events` then hid the event from its own ticket holders, because `deleted_at IS NOT NULL` is visible only to the organizer and admins.
- There was no cancellation workflow. The Terms and Refund Policy describe organizer cancellations, but only per-ticket refunds existed.

## How it works now
1. **Deletion guard** (trigger `events_cancellation_guard`, which also covers direct UPDATEs):
   - An event with any ticket that is `paid` (free RSVPs included) or `refund_pending`, or with a pending purchase, cannot be deleted by anyone. The error tells the organizer to request a cancellation instead.
   - Events with no obligations delete as before.
   - Hiding an event (status `draft`) is unchanged and is **not** a cancellation.
   - A cancelled event can never go back on sale, be un-cancelled or be deleted.
2. **Organizer request** (`request_event_cancellation`, Manage Events → event options → *Cancel Event*):
   - Only the event's organizer can request it, with a reason of at least 10 characters (ticket holders see it).
   - One open request per event. Sales stay open until a decision.
   - The organizer gets a confirmation, and every Super Admin gets a review notice.
3. **Admin decision** (`admin_decide_event_cancellation`, Admin Console → *Cancellations*):
   - Super Admin only, never the event's organizer. The row is locked, so two concurrent decisions produce exactly one.
   - The review shows paid tickets by payment method, with the amounts the server would refund, plus checked-in tickets, pending purchases and every affected ticket.
   - **Reject** (note required): the event stays on sale, nothing is refunded, and the organizer is told why.
   - **Approve:** the event is stamped `cancelled_at` and set to `draft`, which takes it off sale because every purchase path refuses a non-live event. A refund row is queued per affected ticket. Every ticket holder is told once, and the organizer is told.
4. **Refunds go only through the existing per-ticket path.** Admin → *Process refunds* (Super Admin only, from 0219) claims up to 10 queued tickets (`FOR UPDATE SKIP LOCKED`, at most 5 attempts each). A failed row whose ticket is still paid can be re-queued by a Super Admin, with a note that goes to the audit log (0219). A run stops calling the API after a rate-limit refusal. Each ticket is sent to `/api/wallet/refund-ticket` exactly as the attendee list's *Refund* button sends it:
   - **VENTS Wallet:** `refund_ticket` credits the wallet at once through its unique refund ledger row, and debits the organizer's earnings by their net.
   - **Free (₦0):** cancelled, no money moves.
   - **Card or bank (Paystack):** the ticket becomes `refund_pending`, the API calls Paystack `/refund` for that ticket's amount and records the refund id, and the `refund.processed` webhook (`finalize_ticket_refund`) completes it and debits earnings. A `refund.failed` webhook (`fail_ticket_refund`) returns the ticket to `paid`, the row shows **failed**, the attendee is told once, and the next run retries it.
   - **An uncertain Paystack outcome is never released.** This covers a timeout (8 s), a network error, a 5xx, or a success-shaped answer with no refund id. The ticket stays `refund_pending` with no refund id, and the admin view marks it *check it in Paystack before reverting*. Only a definitive rejection (4xx with `status: false`) returns the ticket to `paid` for a retry.
   - **If the refund id cannot be recorded**, the API retries once. It then returns 202 and logs `REFUND ID NOT RECORDED` with the id: the webhook matches only by that id, so it must be attached by hand.
   - **Checked-in tickets:** a ticket of a cancelled event cannot be checked in (0219 trigger). A ticket checked in by a scan that overlapped the approval is marked *blocked*, a manual decision.
5. **Tracking:** a trigger mirrors every ticket transition into `event_cancellation_refunds`, from refund_ticket, attach, the webhook and admin revert.
   - Request status: `processing`, or `attention` if any refund failed or is blocked, or `completed` (with the organizer told once).
   - A payment that completes after the cancellation is queued too.
6. **Visibility:**
   - **Organizer:** status and refund progress on the event card.
   - **Attendee:** the event stays visible. Tickets show *Event cancelled · Refund pending / processing / needs attention / Refunded*, and the ticket opens a refund view instead of a QR code.
   - **Notifications** use the existing `notifications` table (no new provider). Each is sent once per stage, deduplicated by `push_data`.

**Amounts and money.** 0218 never writes a wallet, ledger, earnings or Paystack record. Each refund amount is computed by `refund_ticket` from the ticket row (`ticket_fee_buyer_charge_kobo`), the same function used to charge it; the client never supplies an amount. Duplicate refunds are prevented by:
- `refund_ticket`'s row lock and status checks;
- the wallet ledger's unique refund row;
- the API making no Paystack call for a ticket already `refund_pending`;
- one refund row per ticket, with claims that skip locked rows;
- the webhook's own idempotency (`already_refunded`).

**Review (2026-11-19):** `docs/event-cancellation-review.md` has worked fee examples, the earnings, transfer, Paystack and in-flight findings, and the exact changes each decision below would need.

## Business decisions needed (nothing was invented)
1. **Who pays the fees.** The existing refund code returns the attendee's full charge (ticket price plus the 1.5% service fee) and debits the organizer only their net (price minus 3.5%). VENTS therefore absorbs its fee and Paystack's processing fee (logged as `refund_platform_fee_absorbed`). The Refund Policy and Terms say organizers who cancel bear all refund costs, including Paystack fees. Cancellations use the existing code as-is; which rule should apply?
2. **Earnings already withdrawn.** If the organizer has already withdrawn the money, `earnings_debit_for_refund` records a shortfall or recovery (existing rule). Holds for a cancelled event are not frozen while refunds are pending; freezing them would change the settlement rules. Decide whether cancellation should freeze those holds.
3. **One Super Admin decides.** This matches existing refund authority (an organizer or any admin can refund a single ticket). Decide whether cancellations should need two admins.
4. **Checked-in tickets** are not refunded automatically (`refund_ticket` refuses them). They show as *Needs a manual decision*.
5. **Throughput.** Existing limits apply: `refund_ticket` allows 30 refunds per admin per hour, and the API has a global Paystack ceiling of 100 refunds per hour. A large event takes several runs. Decide whether to keep these limits for cancellations.
6. **Purchases in flight at approval.** `finalize_pending_purchase` refuses a non-live event. A Paystack payment that completes after approval may therefore have no ticket to refund; this is the existing behaviour for hidden events. The admin review shows pending purchases. A reconciliation path for such payments is needed.
7. **Paystack partial refunds.** Each ticket of a multi-ticket payment is refunded separately against the same transaction (existing behaviour). Confirm with Paystack that several partial refunds per transaction are supported for every channel used.
8. **Transferred tickets and payment requests.** A Paystack refund goes back to the card that paid. A wallet refund credits the ticket's current holder (`refund_ticket`, existing). Decide whether a transferred, wallet-paid ticket should refund the original payer.
9. **Withdrawing a request.** An organizer can't withdraw a pending request (an admin rejects it). Add withdrawal if wanted.
10. **Events already soft-deleted with paid tickets (history).** 0218 changes none of them. The pre-check below lists them. An admin can restore one (`admin_restore_deleted_event`) and then cancel it.

## Runbook (for an authorized operator; not run)
**Prerequisites:** 0208 (`ticket_fee_buyer_charge_kobo`) and `refund_ticket` for 0218; 0218 for 0219. 0218 is independent of 0211–0217.

**Order:**
1. Apply 0218.
2. Apply 0219 in the same window, before anyone processes refunds.
3. Deploy the frontend that contains the 0219 changes: refund API, runner and admin screen.

The 0218 frontend is already live (see *Status*). Until 0218 is applied in production:
- **Organizers aren't protected.** The deletion defect still exists server-side: `soft_delete_event`, or a direct UPDATE of `events.deleted_at`, still deletes an event with paid tickets. The app only hides the Delete button for events with sold tickets, so the gap is reachable outside the app.
- **Manage Events** shows *Cancel Event*. Before the fix in this branch, submitting it showed the raw PostgREST error. With this branch it says cancellation isn't available yet and to contact VENTS support.
- **My Tickets** and the ticket refund view behave as before (tested). The admin *Cancellations* view shows an error.

Applying 0218 promptly closes the server-side gap; that is the owner's call.

**Before applying (read-only):**
```sql
-- Events already deleted while holding paid tickets (handled by hand; 0218 changes none)
SELECT e.id, e.title, e.deleted_at, count(t.*) AS paid_tickets
  FROM public.events e JOIN public.tickets t ON t.event_id = e.id
 WHERE e.deleted_at IS NOT NULL AND t.payment_status IN ('paid', 'refund_pending')
 GROUP BY 1, 2, 3 ORDER BY e.deleted_at DESC;
-- Tickets stuck refund_pending without a Paystack refund id (existing; check in Paystack)
SELECT id, event_id, created_at FROM public.tickets WHERE payment_status = 'refund_pending' AND refund_id IS NULL;
```

**Apply** in one transaction with a lock timeout. Never use `supabase db push`.
```sh
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -c "SET lock_timeout = '5s';" -f supabase/migrations/0218_event_cancellation_workflow.sql
```

**After applying (read-only):**
```sql
SELECT to_regclass('public.event_cancellation_requests') IS NOT NULL,
       (SELECT count(*) FROM pg_trigger WHERE tgname IN ('events_cancellation_guard', 'event_cancellation_ticket_sync')),
       (SELECT count(*) FROM public.event_cancellation_requests);   -- expect true / 2 / 0
```

**Apply 0219** the same way, with `supabase/migrations/0219_event_cancellation_safety_fixes.sql`. It moves no money and changes no row.

**Rollback:** `supabase/rollback/undo_0219.sql` (`SET vents.rollback_confirm = 'undo-0219';`) restores 0218's exact bodies; undo 0219 before 0218. `supabase/rollback/undo_0218.sql`, with `SET vents.rollback_confirm = 'undo-0218';` in one transaction. It refuses once any cancellation request exists, so their history is kept. It changes no ticket, wallet, ledger or event row.

## Tests
- **`scripts/local-pg-test/run-event-cancellation-verification.sh`:** 85 checks on the full local money stack (0201 → 0217 plus the production refund functions), with Paystack mocked as accept, reject or timeout and the webhook as processed or failed. It covers:
  - the deletion guard (RPC, direct UPDATE, admin, pending purchase), empty-event delete and hiding;
  - the request rules; who can decide; rejection with no refunds; concurrent approvals;
  - closed sales; no un-cancel;
  - refund rows by method (the earlier individual refund is excluded);
  - one notice per holder; concurrent claims;
  - wallet, free and Paystack refunds, each for the server amount;
  - no duplicate Paystack call while pending; webhook idempotency;
  - failure → attention → retry; timeout handling;
  - totals equal to the charges; attendee and organizer visibility; completion;
  - a late payment being queued; undo refused once used.
- **`scripts/local-pg-test/run-event-cancellation-review-verification.sh`:** 48 checks (0218 + 0219). It covers:
  - refund accounting per price;
  - earnings release and recovery while refunds are outstanding;
  - the check-in guard; Super Admin-only processing; re-queue; attempts used by rejections and rate limits;
  - checked-in tickets marked blocked; transferred wallet tickets;
  - a payment confirmed while the approval commits (two sessions);
  - purchases in flight and duplicate callbacks;
  - 0219 idempotency and undo.

  `WITH_0219=1 run-event-cancellation-verification.sh` re-runs the 85 original checks with 0219 applied.
- **`api/_lib/refundUncertainOutcome.security.test.ts`:** uncertain Paystack outcomes are never released; only a definitive rejection is; the refund id must be recorded.
- **`qa-harness/event-cancellation.e2e.mjs`:** the organizer flow in a real browser against the real `App.tsx` (fixture backend).
- **Unit tests:**
  - `src/lib/eventCancellation.test.ts`: the refund runner sends only `ticket_id` and the reason, and reports failures only;
  - `src/lib/eventCancellation.security.test.ts`: static guard;
  - `AdminCancellationsScreen.test.tsx`, `ManageEventsScreen.cancellation.test.tsx` and `TicketRefundScreen.feeModel.test.tsx`.
