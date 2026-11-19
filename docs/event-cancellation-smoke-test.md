# Event cancellation: production smoke test (after 0218 + 0219)

Applied to VENTS production on 2026-11-19 (`docs/event-cancellation.md` → *Status*). The database objects were verified then, but **the app has not yet been exercised against them**. This checklist does that.

**Ground rules:**
- **Use test accounts only:** a test organizer, a Super Admin, a sub-admin and a test attendee. Use a test event created for this purpose.
- **Never use a real organizer's event, a real attendee's ticket or real money.**
- **Section A is safe:** it only reads, or is refused before anything is written.
- **Section B creates production records.** Run B only with owner approval for each step. Some of it is **permanent**.

**Where things are:**
- **Manage Events:** *You* → VENTS Work card → *Events*. Each event card has an **Event options** (⋯) button.
- **Admin Console:** → *Cancellations*.
- **Attendee tickets:** *Tix* (My Tickets).

## A. Safe checks (read-only, or refused before any write)
Record pass/fail and a screenshot for each.

| # | Area | As | Steps | Expected |
|---|---|---|---|---|
| A1 | Manage Events | Test organizer | Open Manage Events. | Events load. No error banner. No event shows a cancellation status line, because there are none yet. |
| A2 | Cancel Event interface | Test organizer | Event options on a **live test event** → *Cancel Event*. Read the dialog, then **close it without submitting**. | The dialog explains: sales stay open until VENTS approves; each sold ticket is refunded the way it was paid; it can't be undone. A reason box is shown. It does **not** say "Event cancellation isn't available in the app yet" (that would mean the app can't reach 0218). |
| A3 | Reason validation | Test organizer | In the same dialog, submit with an empty or short reason. | "at least 10 characters" is shown and nothing is sent. Close the dialog afterwards. |
| A4 | Deletion protection (app) | Test organizer | Event options on a test event **with at least one ticket** → *Delete Event*. | "…has N ticket(s) sold, so it can't be deleted. Request a cancellation instead…". There is no Delete button, only *Request cancellation*. **Don't press it.** |
| A5 | Empty-event delete unchanged | Test organizer | Event options on a test event with **no tickets** → *Delete Event* → read the dialog → **Cancel**. | "…will be removed from your dashboard…" and a Delete button. Deleting stays allowed for empty events. Pressing Delete deletes it, which is acceptable only for a throwaway test event. |
| A6 | Admin Cancellations | Super Admin | Admin Console → *Cancellations*. | The list loads with filters and shows "No cancellation requests here." No error. |
| A7 | Sub-admin access | Sub-admin | Admin Console → *Cancellations*. | The list loads (read access is allowed). Decision and refund controls appear only inside a request, and none exists yet; B4 covers that. |
| A8 | Attendee My Tickets | Test attendee | Open *Tix*. Open a ticket. | Tickets load normally. No "Event cancelled" label on any ticket (no event is cancelled). The QR code shows for an active ticket. |
| A9 | Refund status interface | Test attendee | Open the refund view of a test ticket, if one is offered. | It loads without error. |

**If A2 or A6 show "isn't available yet" or an error:** stop. The deployed app is not reaching the 0218 functions. Check the browser console, then confirm the app points at project `slrtjxtzhowhwhebjprv`.

## B. Checks that create production records (owner approval needed for each)
| # | Area | Creates | Permanence | Steps | Expected |
|---|---|---|---|---|---|
| B1 | Cancellation request | One `event_cancellation_requests` row, notifications to the organizer and every admin, an audit row | **Permanent history.** From this point `undo_0218` refuses to run, so 0218 can no longer be rolled back. | Test organizer: *Cancel Event* on a test event with a test ticket → reason → submit. | The card shows "Cancellation requested · under review". Admins get a review notice. Sales stay open. |
| B2 | Duplicate request refused | Nothing | None | Submit *Cancel Event* again on the same event. | "A cancellation request for this event is already open". |
| B3 | Reject (non-destructive decision) | The request becomes `rejected`, plus an organizer notice and an audit row | Permanent history; the event stays on sale | Super Admin: open the request → note → *Reject* → confirm. | The organizer sees "Cancellation not approved: …". Nothing is refunded. A new request can be made later. |
| B4 | Sub-admin restrictions | Nothing | None | Sub-admin: open the B1 request **before it is decided**. | "Only a Super Admin can approve or reject a cancellation." No approve or reject buttons. |
| B5 | Approve → cancelled event | The event is cancelled (off sale **forever**), refund rows are queued, every holder is notified | **Irreversible.** The event can never go back on sale or be deleted. | Only on a dedicated **free (₦0)** test event whose only tickets belong to test accounts. Super Admin: approve → confirm. | The event is off sale. Holders get "Event cancelled". Their tickets show "Event cancelled · Refund pending" and open the refund view instead of the QR code. |
| B6 | Super Admin refund controls | Refund attempts; free tickets are only marked refunded | Free tickets move no money, but card or wallet tickets **would refund real money**. Use free tickets only. | Super Admin: B5 request → *Process refunds*. | Free tickets become Refunded and the request completes. The sub-admin view shows "Only a Super Admin can process refunds." and no button. |
| B7 | Cancelled-event check-in protection | A rejected scan attempt (the scan log may record it) | None to the ticket | Door scanner, or manual check-in, on a ticket of the B5 event, **before B6 refunds it**. | The check-in is refused ("This event was cancelled; its tickets cannot be checked in"). The ticket stays not checked in. |
| B8 | Re-queue | An audit row | Permanent history | Only if a refund shows **failed** while its ticket is still paid: Super Admin → *Re-queue refund* → note. | The row returns to queued; an audit entry is written. The button is absent for tickets with a refund in flight. |

**Never during smoke testing:**
- approving a cancellation of a real event;
- processing refunds for paid (card or wallet) tickets;
- checking in or changing a real attendee's ticket;
- reverting a stuck refund;
- running any rollback script.

**Already verified locally (no production records needed):**
- **Check-in guard, Super Admin processing, re-queue and blocked check-ins:** `scripts/local-pg-test/run-event-cancellation-review-verification.sh` (48 checks).
- **The full 0218 workflow:** `run-event-cancellation-verification.sh` (85 checks).

The production function bodies are byte-identical to the ones those harnesses run.
