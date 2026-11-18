# Runbook: migrations 0216 and 0217 (representative rewards)

- **0216** (`supabase/migrations/0216_representative_rewards_free_events_never_qualify.sql`): free events never qualify. It requires a genuinely paid ticket, checked at submission, approval and before credit.
- **0217** (`supabase/migrations/0217_representative_reward_fixed_50000.sql`): the reward is **fixed at ₦50,000** per qualifying organizer. The 0201 higher monthly rate (9+ organizers) is discontinued.

**Neither is applied.** Both need owner approval and an authorized operator. Nothing in this document has been run against production. Apply 0216, then 0217, each in its own transaction. Roll back in the reverse order.

## 0216: what it changes
Four functions are patched in place, each anchored on its expected text and marked `[0216]`, and one constraint is replaced. No row is inserted, updated or deleted, and no money moves.

| Object | Change |
| --- | --- |
| `earn_event_eligibility` | An event is free unless at least one ticket is genuinely paid for and still paid: `payment_status = 'paid'` and `amount × (1 − discount_percentage/100) > 0`. This catches free events with RSVPs (stored as `paid` at ₦0), 100%-promo events and fully refunded events. It adds `valid_paid_tickets` to the output. |
| `earn_execute_admin_action` | Refuses a `free_event_verified` flag other than `false`. Refuses a free event at approval (fails closed). Records `free_event_verified = false`. |
| `claim_representative_reward` | Before reserving or crediting, refuses a free-event claim, or one whose event is gone, not live, deleted, hidden or now free. |
| `representative_qualifying_count` | Free-event claims no longer count as qualifying organizers (the dashboards' monthly counts; after 0217 no amount depends on them). |
| Constraint | `representative_reward_claims_free_never_qualifies` (`NOT VALID`) replaces `representative_reward_claims_free_needs_verification`. |

## 0216: prerequisites and order
- 0201, 0203 and 0209 must be applied. 0216 refuses to run without 0209's `[0209]` eligibility patch, and refuses if any anchor doesn't match exactly once (a sign of drift).
- 0216 doesn't depend on 0211–0215 and applies whether or not 0214 or 0215 are applied.
- Deploy the frontend before or after 0216; either order is safe. The current admin screen sends no `free_event_verified`, and paid-event approvals behave the same on both versions.

## 0216: before applying (read-only)
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

-- 5. Higher monthly rates approved under 0201 (discontinued by 0217; kept as
--    history), and the count they were based on, recalculated under 0216.
SELECT r.representative_id, r.month, r.reward_kobo, r.basis_month_count,
       (SELECT count(*) FROM public.representative_reward_claims c
         WHERE c.representative_id = r.representative_id
           AND c.reward_month = (r.month - interval '1 month')::date
           AND c.status IN ('approved', 'funded', 'credited')
           AND NOT c.is_free_event AND NOT c.free_event_verified) AS count_under_0216
  FROM public.representative_monthly_rates r ORDER BY r.month DESC;
```

If query 1 isn't `true/true/false`, stop: the live text differs from the repository.

## 0216: apply
Apply as one transaction with a lock timeout. Never use `supabase db push`.

```sh
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
  -c "SET lock_timeout = '5s';" \
  -f supabase/migrations/0216_representative_rewards_free_events_never_qualify.sql
```

The migration prints a `WARNING` with the counts from queries 3 and 4 when either is above zero. On any error, nothing is applied; investigate before retrying. Re-running after success is a no-op.

## 0216: after applying (read-only)
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

## 0216: rollback
Run `supabase/rollback/undo_0216.sql` in one transaction, **after** `undo_0217` (if 0217 is applied) and **before** `undo_0209` if that is ever needed:

```sh
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
  -c "SET lock_timeout = '5s'; SET vents.rollback_confirm = 'undo-0216';" \
  -f supabase/rollback/undo_0216.sql
```

It restores the four functions' exact pre-0216 text, removes the new constraint, and re-adds the old one as validated, matching how 0201 created it. It changes no row. Verify with `SELECT count(*) FROM pg_proc WHERE prosrc LIKE '%[0216]%';` (= 0) and `convalidated = true` for `representative_reward_claims_free_needs_verification`. After the undo, 0209's narrower free-event test applies again: free events with attendees, 100%-promo events and fully refunded events would qualify again.

## 0217: fixed ₦50,000, no monthly uplift

### What it changes
No row is inserted, updated or deleted. No money moves.

| Object | Change |
| --- | --- |
| `representative_reward_rate_kobo` | Returns the ₦50,000 base only (`earn_settings.base_reward_kobo`, CHECK = 5,000,000). Submission and approval take every amount from it; monthly rate rows are no longer read. |
| `earn_execute_admin_action` | `earn_set_monthly_rate` is refused, including requests filed before 0217. |
| `request_admin_action` | `earn_set_monthly_rate` is no longer accepted. |
| `claim_representative_reward` | A claim whose recorded amount isn't ₦50,000 is held: never reserved, credited or rewritten. |
| `representative_monthly_rates` | Frozen by triggers (no insert, update, delete or truncate). Existing rows stay as history. |
| Constraint | `representative_reward_claims_fixed_amount` (`NOT VALID`): an approved, funded or credited claim is exactly ₦50,000. Rejecting or reversing an older claim is still allowed. |

`earn_settings.rate_review_threshold` and the dashboard functions' rate fields (`current_rate_kobo`, `rate_review_threshold`, per-month `rate_kobo`) stay so installed app versions keep working. After 0217 they report ₦50,000 and drive no amount, and the current app no longer shows them.

### Prerequisites
0216 must be applied (0217 checks for its `[0216]` claim check), and `base_reward_kobo` must be 5,000,000.

### Before applying (read-only)
```sql
-- A. Monthly rates ever approved (kept as history; none applies after 0217)
SELECT representative_id, month, reward_kobo, basis_month_count, created_at FROM public.representative_monthly_rates ORDER BY month;
-- B. Claims above N50,000, by status. Approved/funded ones are held by 0217;
--    credited ones are paid history (an owner decision if any exist).
SELECT status, count(*), sum(amount_kobo) FROM public.representative_reward_claims
 WHERE amount_kobo <> 5000000 GROUP BY 1;
-- C. Monthly-rate requests still pending (can no longer be approved)
SELECT id, target_id, payload, created_at FROM public.admin_action_requests
 WHERE action_type = 'earn_set_monthly_rate' AND status = 'pending';
```

### Apply
```sh
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
  -c "SET lock_timeout = '5s';" \
  -f supabase/migrations/0217_representative_reward_fixed_50000.sql
```
It prints one `WARNING` with the counts from A, B and C when any is above zero.

### After applying (read-only)
```sql
-- Expect: 5000000 / t / 3
SELECT (SELECT public.representative_reward_rate_kobo(id, now()::date) FROM public.recruiters LIMIT 1),
       position('earn_set_monthly_rate' IN pg_get_functiondef('public.request_admin_action(text,text,uuid,text,jsonb,jsonb,jsonb,text)'::regprocedure)) = 0,
       (SELECT count(*) FROM pg_proc WHERE prosrc LIKE '%[0217]%');
-- Expect: the two freeze triggers and the new constraint
SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.representative_monthly_rates'::regclass AND NOT tgisinternal;
SELECT conname, convalidated FROM pg_constraint WHERE conname = 'representative_reward_claims_fixed_amount';
-- Expect: query A and B results unchanged
```

### Handling the history it reports
- **Monthly rate rows (A):** kept, frozen and read by nothing. No action needed.
- **Approved claims above ₦50,000 (B):** held at credit. Reject through dual control; the representative can then resubmit the organizer and gets ₦50,000 (a rejected claim can be resubmitted).
- **Funded claims above ₦50,000 (B):** held at credit, with their full amount reserved in the profit pool. Reversing through dual control releases the whole reservation, so nothing is stranded. A reversed organizer can't be claimed again under the current one-reward-per-organizer rule, so reversal costs that representative the reward. Rejection isn't available for funded claims. Decide case by case before acting.
- **Credited claims above ₦50,000 (B):** paid history, left as is. Reversing one takes the full amount back out of the representative's available earnings (existing reversal rule). That's an owner decision.
- **Pending requests (C):** they can't be approved. Reject them in Admin Actions to clear the queue.

### Rollback
Roll back 0217 before 0216, and only on an owner decision: rolling back re-enables the discontinued higher rate.
```sh
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
  -c "SET lock_timeout = '5s'; SET vents.rollback_confirm = 'undo-0217';" \
  -f supabase/rollback/undo_0217.sql
```
It restores the four functions' exact pre-0217 text, re-lists the action type, and drops the freeze triggers and the fixed-amount constraint. It changes no row.

## Known limitations
- **Held claims in the monthly count.** An approved claim whose event was cancelled, deleted, hidden or fully refunded after approval stays `approved` (held) and still shows in the dashboards' monthly qualifying count until admins reject or reverse it. After 0217 the count affects no amount.
- **Funded claims above ₦50,000.** If query B finds any, see "Handling the history it reports" under 0217.
- **Draft events.** An organizer who moves an ended event to draft after approval puts the reward on hold until it's live again. Events only have `live` and `draft` statuses.
- **Fraud screening is manual.** One genuinely paid ticket, even a cheap one bought by a friend, makes an event qualify. Admins confirm the event took place.
- **UI wording.** The app shows the `free_event` reason as "Free events do not qualify", including for a fully refunded event.
- **Testing.** Verified locally only: `scripts/local-pg-test/run-representative-reward-integrity-verification.sh` and `qa-harness/earnings-navigation.e2e.mjs`. CI doesn't run either.
