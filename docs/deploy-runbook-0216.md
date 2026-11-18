# Runbook: migration 0216 (representative rewards: free events never qualify)

`supabase/migrations/0216_representative_rewards_free_events_never_qualify.sql`. **Not applied.** It needs owner approval and an authorized operator. Nothing in this document has been run against production.

## What it changes
Four functions are patched in place, each anchored on its expected text and marked `[0216]`, and one constraint is replaced. No row is inserted, updated or deleted, and no money moves.

| Object | Change |
| --- | --- |
| `earn_event_eligibility` | An event is free unless at least one ticket is genuinely paid for and still paid: `payment_status = 'paid'` and `amount × (1 − discount_percentage/100) > 0`. This catches free events with RSVPs (stored as `paid` at ₦0), 100%-promo events and fully refunded events. It adds `valid_paid_tickets` to the output. |
| `earn_execute_admin_action` | Refuses a `free_event_verified` flag other than `false`. Refuses a free event at approval (fails closed). Records `free_event_verified = false`. |
| `claim_representative_reward` | Before reserving or crediting, refuses a free-event claim, or one whose event is gone, not live, deleted, hidden or now free. |
| `representative_qualifying_count` | Free-event claims no longer count toward the 9+ rate review. |
| Constraint | `representative_reward_claims_free_never_qualifies` (`NOT VALID`) replaces `representative_reward_claims_free_needs_verification`. |

## Prerequisites and order
- 0201, 0203 and 0209 must be applied. 0216 refuses to run without 0209's `[0209]` eligibility patch, and refuses if any anchor doesn't match exactly once (a sign of drift).
- 0216 doesn't depend on 0211–0215 and applies whether or not 0214 or 0215 are applied.
- Deploy the frontend before or after 0216; either order is safe. The current admin screen sends no `free_event_verified`, and paid-event approvals behave the same on both versions.

## Before applying (read-only)
Run these in the SQL editor or with `psql`, as read-only queries. Record the results.

```sql
-- 1. Prerequisites and drift: expect true/true/false
SELECT position('[0209]' IN pg_get_functiondef('public.earn_event_eligibility(uuid)'::regprocedure)) > 0,
       position('free_event_verified must be true or false' IN pg_get_functiondef('public.earn_execute_admin_action(uuid)'::regprocedure)) > 0,
       EXISTS (SELECT 1 FROM pg_proc WHERE prosrc LIKE '%[0216]%');

-- 2. Programme gates (context only; 0216 does not change them)
SELECT legacy_commission_reconciled, payouts_enabled, settlement_hold_days FROM public.earn_settings;

-- 3. Claims already recorded as free events
SELECT status, count(*) FROM public.representative_reward_claims
 WHERE is_free_event OR free_event_verified GROUP BY 1;

-- 4. Claims whose event has no genuinely paid ticket (0216's rule). After
--    0216: approved/funded ones are held; credited ones need an owner decision;
--    pending ones can no longer be approved.
SELECT c.id, c.status, c.representative_id, c.event_id, c.amount_kobo
  FROM public.representative_reward_claims c
 WHERE c.status NOT IN ('rejected', 'reversed')
   AND NOT EXISTS (SELECT 1 FROM public.tickets t
                    WHERE t.event_id = c.event_id AND t.payment_status = 'paid'
                      AND COALESCE(t.amount, 0) * (1 - COALESCE(t.discount_percentage, 0) / 100) > 0);

-- 5. Approved higher monthly rates and the count they were based on.
--    Re-check any rate whose basis included free-event claims.
SELECT r.representative_id, r.month, r.reward_kobo, r.basis_month_count,
       (SELECT count(*) FROM public.representative_reward_claims c
         WHERE c.representative_id = r.representative_id
           AND c.reward_month = (r.month - interval '1 month')::date
           AND c.status IN ('approved', 'funded', 'credited')
           AND NOT c.is_free_event AND NOT c.free_event_verified) AS count_under_0216
  FROM public.representative_monthly_rates r ORDER BY r.month DESC;
```

If query 1 isn't `true/true/false`, stop: the live text differs from the repository.

## Apply
Apply as one transaction with a lock timeout. Never use `supabase db push`.

```sh
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
  -c "SET lock_timeout = '5s';" \
  -f supabase/migrations/0216_representative_rewards_free_events_never_qualify.sql
```

The migration prints a `WARNING` with the counts from queries 3 and 4 when either is above zero. On any error, nothing is applied; investigate before retrying. Re-running after success is a no-op.

## After applying (read-only)
```sql
-- Four patched functions; the old override text gone: expect 4/0
SELECT count(*) FILTER (WHERE prosrc LIKE '%[0216]%'),
       count(*) FILTER (WHERE prosrc LIKE '%must be explicitly verified as genuine%')
  FROM pg_proc WHERE pronamespace = 'public'::regnamespace;
-- The new constraint, not validated; the old one gone: expect one row, false
SELECT conname, convalidated FROM pg_constraint WHERE conname LIKE 'representative_reward_claims_free%';
-- No row changed: compare with the "before" counts
SELECT status, count(*) FROM public.representative_reward_claims GROUP BY 1;
SELECT count(*) FROM public.organizer_transactions WHERE type IN ('representative_reward', 'representative_reward_reversal');
```

Then act on any claims from query 4 through the existing two-admin flow in the admin app: rejection for approved claims, reversal for funded or credited ones. 0216 changes none of them itself.

## Rollback
Run `supabase/rollback/undo_0216.sql` in one transaction, **before** `undo_0209` if that is ever needed:

```sh
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
  -c "SET lock_timeout = '5s'; SET vents.rollback_confirm = 'undo-0216';" \
  -f supabase/rollback/undo_0216.sql
```

It restores the four functions' exact pre-0216 text, removes the new constraint, and re-adds the old one as validated, matching how 0201 created it. It changes no row. Verify with `SELECT count(*) FROM pg_proc WHERE prosrc LIKE '%[0216]%';` (= 0) and `convalidated = true` for `representative_reward_claims_free_needs_verification`. After the undo, 0209's narrower free-event test applies again: free events with attendees, 100%-promo events and fully refunded events would qualify again.

## Known limitations
- **Held claims still count toward 9+.** An approved claim whose event was cancelled, deleted, hidden or fully refunded after approval stays `approved` (held) and still counts toward the 9+ rate review until admins reject or reverse it. Excluding held claims automatically would add a new rule; it's left to the owner.
- **Existing monthly rates aren't revisited.** A rate approved earlier on a basis that included free-event claims stays in place. Query 5 lists them for review.
- **Draft events.** An organizer who moves an ended event to draft after approval puts the reward on hold until it's live again. Events only have `live` and `draft` statuses.
- **Fraud screening is manual.** One genuinely paid ticket, even a cheap one bought by a friend, makes an event qualify. Admins confirm the event took place.
- **UI wording.** The app shows the `free_event` reason as "Free events do not qualify", including for a fully refunded event.
- **Testing.** Verified locally only: `scripts/local-pg-test/run-representative-reward-integrity-verification.sh` and `qa-harness/earnings-navigation.e2e.mjs`. CI doesn't run either.
