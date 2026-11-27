# Batch 1: financial integrity and access hardening (2026-11-27)

Code, tests and migrations are on `main`. **No migration below has been applied to production.** Each one needs the owner's explicit approval, a fresh verified backup, and the read-only prechecks below. The web app deployed with this batch works with or without them (details per item).

Confirmed policies are unchanged:
- Withdrawals: the Super Admin alone approves, with the 10-digit PIN (0213).
- Fees: 1.5% attendee / 3.5% organizer (0208).
- Settlement: earnings release 48 hours after the event or service (0203). Representative rewards keep their 7-day hold (0201).
- Refund shortfalls: recovered from future earnings (0203).
- Payments without an issued ticket: refunded only with two admins (new, 0234).

## What changed

| ID | Finding | Root cause | Fix | Migration | Suite (local PostgreSQL) |
|---|---|---|---|---|---|
| AZ-09 | Payout rejection could credit a wallet twice | **Corrected: already fixed.** Production's `admin_reject_organizer_payout`, captured read-only on 2026-10-30, already claims the row atomically: `UPDATE … WHERE status = 'pending' RETURNING`. Its logic is the same as 0187's reject. No later migration redefines it. The audit read the older 0124 body. | None needed. Proven: 2 and 5 concurrent rejections, and Admin Actions racing a direct reject, credit exactly once. The old 0124 body fails the same test (double credit). **Never apply 0187:** its cancel function would overwrite 0202's. | — | `run-payout-reject-concurrency-verification.sh` (43) |
| AZ-08 | Transfer-fee payments lost on retry, duplicates unrecorded | One column (`ticket_transfers.fee_payment_ref`) held only the newest reference. Every retry overwrote it, and every lookup used it. | Every attempt is kept. Whichever payment lands first owns the transfer, even an older attempt. Duplicate, unknown and wrong-amount payments become payment exceptions for the two-admin refund. They are never auto-refunded and never move the ticket twice. | **0233** | `run-transfer-fee-attempts-verification.sh` (56) |
| AZ-10 | Refunds of payments without a ticket were one person's call | `admin_resolve_payment_exception` let one Super Admin close the record. The refund itself was done by hand in Paystack. | **Request:** any admin or sub-admin. **Approval:** a different Super Admin, in Admin Actions, bound to the same reference, amount (never more than Paystack captured) and reason. **Then:** a Super Admin sends it to Paystack. The payment is claimed exactly once, and the webhook closes it. | **0234** | `run-payment-exception-refund-verification.sh` (68) |
| AZ-32 | `boost_event_vc` callable by any signed-in user | Over-wide grant in 0011. The function charges 1,000 VENTS Cents for a boost nothing reads. | EXECUTE revoked from anon and authenticated. The server role keeps it. | **0235** | `run-access-hardening-verification.sh` (50) |
| AZ-16 | Drafts and admin-hidden events readable by anyone | 0008's `select_events` admitted every non-deleted row. | Non-owners see only events that aren't deleted, drafts or hidden. Organizers, admins and sub-admins see everything as before. Ticket holders keep access to their event. | **0236** | same |
| AZ-33 | Anyone could review any organizer | `organizer_reviews` checked only the reviewer id. (The app has no event-review screen; service reviews already need a completed booking, 0099.) | A review needs an active, paid, checked-in ticket for one of that organizer's events. No self-reviews. | **0237** | same |

App code changes:
- `api/wallet/refund-ticket.ts`: new `payment_exception_id` mode, with the same uncertain-outcome rule as ticket refunds.
- `api/webhook/paystack.ts`: payment-exception refunds are the last link of the refund webhook chain. Before 0234 they read as not found, so the webhook answers 200 and Paystack doesn't retry.
- Admin → Payouts → Payment exceptions panel: shows only the next step of the refund flow.
- Admin Actions: shows a label for refund requests.

## Production: what each migration needs

Apply order: **0233 → 0234**, then 0235, 0236 and 0237 in any order. Every migration refuses to run twice and refuses on drift, with no partial apply.

| Migration | Hard prerequisites (it refuses without them) | Effect if not applied | Old store apps |
|---|---|---|---|
| 0233 | 0226 (`payment_exceptions`), 0064, and the repository versions of `initiate_transfer_fee_payment`, `get_transfer_fee_payment_owner` and `confirm_transfer_fee_payment` (md5-pinned) | Transfer-fee retries keep losing late payments (AZ-08 stays open) | Unaffected (same function signatures) |
| 0234 | 0233; 0226's `admin_list_payment_exceptions` / `admin_resolve_payment_exception` (pinned); maker-checker patched by 0203/0207 (anchored) | The panel shows the old record-only flow; refunds stay manual | Admin is web-only |
| 0235 | — | `boost_event_vc` stays callable | Unaffected (the app never calls it) |
| 0236 | 0008's `select_events` unchanged, and no other SELECT policy on events (it refuses otherwise) | Drafts and hidden events stay public | Unaffected: old builds read public events the same way |
| 0237 | 0008's review policies | Anyone can still write reviews by API | Unaffected (no review screen) |

**0226 (payment exceptions) has no production apply record.** If the owner-run review shows it missing, apply it before 0233. It is also what the deployed webhook already expects.

### Read-only prechecks (owner runs in the Supabase SQL editor; no writes)

```sql
-- Which of these already exist?
SELECT to_regclass('public.payment_exceptions')            AS has_0226,
       to_regclass('public.ticket_transfer_fee_attempts')  AS has_0233,
       EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                AND table_name = 'payment_exceptions' AND column_name = 'refund_status') AS has_0234,
       to_regprocedure('public.user_holds_ticket_for_event(uuid)')   AS has_0236,
       to_regprocedure('public.user_attended_organizer_event(uuid)') AS has_0237;

-- Fingerprints 0233/0234 are pinned to (must match exactly):
SELECT proname, md5(replace(prosrc, E'\r', '')) FROM pg_proc
 WHERE pronamespace = 'public'::regnamespace
   AND proname IN ('initiate_transfer_fee_payment', 'get_transfer_fee_payment_owner', 'confirm_transfer_fee_payment',
                   'admin_list_payment_exceptions', 'admin_resolve_payment_exception')
 ORDER BY 1;
-- expected: admin_list_payment_exceptions   9e7cb373db3327cd27443bba4b729987
--           admin_resolve_payment_exception 87be17ca4555c4a1a53792aa991b1af1
--           confirm_transfer_fee_payment    46f411874adac7e0f55192cc54539a2d
--           get_transfer_fee_payment_owner  2984c22524a9bb1a1b21a9960447491c
--           initiate_transfer_fee_payment   02f938d7ac659268b73ce822752ef400

-- AZ-09: the live reject is still the atomic one (expect true, true):
SELECT position('WHERE id = p_request_id AND status = ''pending''' IN prosrc) > 0,
       position('RETURNING organizer_id, amount_kobo INTO v_organizer_id, v_amount_kobo' IN prosrc) > 0
  FROM pg_proc WHERE oid = 'public.admin_reject_organizer_payout(uuid,text)'::regprocedure;

-- 0236: exactly one SELECT policy on events, and it is 0008's:
SELECT polname, polcmd, pg_get_expr(polqual, polrelid) FROM pg_policy WHERE polrelid = 'public.events'::regclass;

-- Data the migrations will touch (counts only):
SELECT count(*) FILTER (WHERE fee_payment_ref IS NOT NULL) AS transfer_refs_to_backfill FROM public.ticket_transfers;
SELECT count(*) AS open_payment_exceptions FROM public.payment_exceptions WHERE status = 'open';
```

### After each apply (read-only verification)

```sql
-- 0233: every existing reference was backfilled
SELECT (SELECT count(*) FROM public.ticket_transfers WHERE fee_payment_ref IS NOT NULL)
     = (SELECT count(*) FROM public.ticket_transfer_fee_attempts);
-- 0234: the maker-checker knows the new action
SELECT position('refund_payment_exception' IN pg_get_functiondef('public.approve_admin_action(uuid)'::regprocedure)) > 0;
-- 0235
SELECT has_function_privilege('authenticated', 'public.boost_event_vc(uuid)', 'EXECUTE');  -- false
-- 0236: an anonymous count of drafts must be 0
SET ROLE anon; SELECT count(*) FROM public.events WHERE status = 'draft'; RESET ROLE;
-- 0237
SELECT polname, pg_get_expr(polwithcheck, polrelid) FROM pg_policy WHERE polrelid = 'public.organizer_reviews'::regclass;
```

### Risks and how they are contained

- **0236 changes what non-owners can read.** Any screen that showed someone else's draft or hidden event to a non-admin will now show nothing. That is the intended behaviour. Code search found no such screen, because search, feeds, Featured and Trending already filter to live events.
  - Smoke test after applying: home feed and search signed out, My Tickets for a ticket holder, and an organizer's Manage Events.
- **0234 patches `approve_admin_action` in place.** It inserts one branch at an anchor. If the anchor is missing, the whole migration refuses and nothing changes. The undo removes exactly that branch.
- **0233 changes `confirm_transfer_fee_payment`.** The first payment wins; later payments are recorded, never applied. The existing automatic refund for a transfer that can no longer complete (0064) is unchanged.
  - Owner decision to note: that pre-existing automatic transfer-fee refund predates D4. D4 covers payments with no ticket, and 0233 sends duplicates to the two-admin flow instead. Say if the 0064 automatic refund should also move to two-admin approval.
- **Undo:**
  - Every undo is gated: `SET vents.rollback_confirm = 'undo-NNNN';` then the file in `supabase/rollback/`.
  - 0233 and 0234 refuse to undo while money is mid-refund or recorded as owed.

### Approval needed

> Apply to production, in this order, each in its own window after a verified backup and the prechecks above: **0226 (if missing) → 0233 → 0234 → 0235 → 0236 → 0237.**

Until then, the corresponding fixes are **not live**, even though the app code that uses them is deployed.
