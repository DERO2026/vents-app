# Event attendance visibility (migration 0221)

**Status:** implemented and verified **locally only**. Not applied to production. Not deployed. Not committed.

Organizers can choose whether the public sees how many people are attending their event. The setting is **Show attendance count publicly**, under *Create Event / Edit Event → Settings*. Hiding the count does not hide the event. Sales, tickets, QR passes, check-in, refunds, promotion and the organizer's own analytics are unaffected.

## Before
Every attendance count was public. Three RPCs granted to `anon` (0011) returned counts for any event:

| RPC | What anyone could read |
|---|---|
| `get_event_ticket_stats` | `sold_count` and `sold_quantity`, plus the **pending, cancelled and refunded** counts |
| `get_event_ticket_type_availability` | Per-tier counts, which sum to the total and include pending tickets |
| `get_event_trending_scores` | `recent_sold` and `total_sold` (pending tickets included), and a score derived from them |

Hiding the number in the app alone would have left all three readable.

## Database enforcement (`0221_event_attendance_visibility.sql`)
**The setting.** `events.show_attendance_count boolean NOT NULL DEFAULT true`. Adding the column with that default sets every existing event to `true`, so no current event changes. New events also default to `true`, both in the database and in the app (`DEFAULT_SHOW_ATTENDANCE_COUNT`).

**Who can change it.** The existing `update_events` RLS policy (0008: the event's organizer, or `is_admin()`) applies. No policy or grant was added.
- Other organizers, ticket holders and anon update 0 rows.
- Anon holds UPDATE on `events` (0012), as in production; RLS matches no row for anon.

**`get_event_ticket_stats`.**
- **Hidden event:** returns **no row** to anyone but its organizer and admins (`is_admin()`, which includes sub-admins).
- **Every event:** `pending_count`, `cancelled_count`, `refunded_count` and revenue are organizer/admin-only. No public screen used them.

**`get_event_ticket_type_availability`.**
- Returns one row per tier, with a new `sold_out` column. It applies the same capacity rule as checkout: active tickets reaching the tier's quantity or the event's `ticket_goal`.
- For a hidden event the public gets `sold_count = NULL`. Buyers still see which tiers are sold out.
- Its result type changed, so the function is dropped and re-created. Its owner and EXECUTE grants are captured first and restored exactly.

**`get_event_trending_scores`.**
- Raw `recent_sold` and `total_sold` go only to the organizer and admins.
- A hidden event is scored on saves alone, for everyone, so the score can't be turned back into a sales figure.

**Function attributes.** SECURITY DEFINER, `search_path ''`, owner, volatility and grants are preserved. The harness compares all of them before and after.

**Drift guard.** Each function must be the repository version, pinned by `md5(prosrc)`, or already carry `[0221]`. Anything else makes the migration refuse before any change.

## Application
- **Create/Edit Event** (`AttendanceVisibilityToggle`, `CreateEventScreen`):
  - It's an accessible switch (`role="switch"`, `aria-checked`, a label and a description), with the same look as the other Settings toggles.
  - Edit loads the saved value and always sends it back, so saving other edits never resets it.
  - The Review step shows the choice.
- **Event Details:**
  - For the public, a hidden count removes the header "N attending", the fill %, the progress bar and the "N attending" line. Only "N total capacity" remains.
  - The organizer and admins still see the count, labelled "· hidden from the public".
  - The screen reads `show_attendance_count` itself, so a search or feed row that lacks the column can't mislead it.
- **Home feed card:** no "Selling Fast!" badge for a hidden count.
- **Ticket picker:** for a hidden count it shows "Available" instead of "N available", and sold-out tiers still show "Sold Out".
- **Feed, search and saved lists:** these already got no count from the server. `mapDbEventToFrontend` carries the flag.
- **AI assistant tool** (`api/_lib/aiTools.ts`): calls `get_event_ticket_stats` with the caller's own session, so it gets `null` for a hidden event.

### Surfaces audited
| Surface | Handled by |
|---|---|
| `get_event_ticket_stats`: Event Details, Home, search, App event list, My Tickets embedded event, AI tool | 0221 + UI |
| `get_event_ticket_type_availability`: ticket picker | 0221 + UI |
| `get_event_trending_scores`: Home trending, App ranking | 0221 |
| `get_event_analytics`, `get_portfolio_analytics`, `get_event_attendees`, `get_door_stats`, `get_recent_checkins`, `get_scan_log` | Already organizer/door-manager/admin-gated |
| Direct `tickets` / `checkins` reads | RLS: own tickets or own events only. Anon has no grant. |
| Profile "ATTENDEES" figure | A direct tickets count limited by RLS to the viewer's own tickets. It can't reveal a hidden count. It was already inaccurate for visitors; not changed. |
| Payment-request `attendee_count` | The size of one buyer's own order, not event attendance |
| Client caches | No persistent event or count cache exists. A toggle takes effect on the next fetch. |

## Deploy order
1. **Apply 0221 first** (one transaction), with owner approval.
2. **Then deploy the app.**

If the app is deployed first:
- event create/edit still works with the setting ON; the app retries without the column;
- an attempt to hide the count is refused with a clear message, never silently dropped;
- Event Details and the ticket picker behave exactly as before.

## Rollback
`supabase/rollback/undo_0221.sql`:
- needs `SET vents.rollback_confirm = 'undo-0221'`;
- if any organizer has hidden their count, also needs `SET vents.rollback_reexpose_hidden_counts = 'yes'`, because undoing makes those counts public again;
- restores the exact pre-0221 bodies (verified by md5) with their owner and grants, then drops the column.

## Verification
```bash
sudo pg_ctlcluster 16 main start
scripts/local-pg-test/run-attendance-visibility-verification.sh   # 72 checks
npx vitest run src/lib/attendanceVisibility.security.test.ts src/app/components/CreateEventScreen.attendanceVisibility.test.tsx \
  src/app/components/EventDetailsScreen.attendanceVisibility.test.tsx src/app/components/attendanceVisibility.surfaces.test.tsx
```

## Known limits and decisions for the owner
1. **Capacity is still public.** `ticket_goal` and tier quantities are readable on the event, and checkout enforces them. A signed-in user can still infer how many seats remain, and therefore sales, by attempting purchases. The capacity error names the remaining number. Closing this means changing checkout's messages and rate limits, or hiding capacity. It's out of scope here and needs a decision.
2. **Sold-out state stays public** while counts are hidden. Buyers need it.
3. **Ranking.** A hidden event loses its sales-based boost in Trending and the popularity sort, and gets no "Selling Fast!" badge. Without that, its sales could be inferred from its rank.
4. **Older app builds** (native app 1.3.0) don't know the setting:
   - for a hidden event they show "0 attending" (no leak, but misleading);
   - their ticket picker doesn't know which tiers are sold out;
   - checkout still refuses the purchase, at finalize.
5. **Capacity is checked after payment.** `create_pending_purchase` doesn't check capacity; `finalize_pending_purchase` does, after Paystack has charged. This is existing behaviour (OEL-02) and unchanged. The new `sold_out` flag reduces how often new app builds reach it.
6. **The TIG – Paintball & Play event** (organizer Jaiye District) exists only in production. It isn't in the repository, and production wasn't accessed. After 0221 is applied and the app deployed, its organizer can turn the count off under *Edit Event → Settings*. An admin's existing database UPDATE rights also allow it; there is no admin-console control for it.
