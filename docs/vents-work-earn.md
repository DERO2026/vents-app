# VENTS Work / VENTS Earn

Status as of 2026-10-30. Branch `claude/vents-work-earn`. **Nothing here is
applied to production or deployed.** Migration `0201` exists in the repo only.

## What VENTS Work is

One account, many earning roles. VENTS Work is the hub (Profile → VENTS Work
card). It shows earnings first, then each role's onboarding and approval
status, then opportunities. VENTS Earn is the earnings screen. A person keeps
every role they hold; becoming a Representative never replaces Organizer or
Service Provider, and referral history is never deleted.

| Role | Onboarding (existing flow) | States shown |
|---|---|---|
| Organizer | `organizer_requests` sheet → CAC verification → Creator Studio | Start, In review, Retry, Active, Verified |
| Service Provider | `service-provider-verify` → `service-provider-setup` | Start, In review, Retry, Active (set up / manage), Paused |
| Representative | `register_as_recruiter` → Representatives dashboard → Rewards | Join, Active, Paused |
| Vendor | Not a separate role in this codebase: "Food vendor" is a Service Provider subcategory. It onboards through Service Provider. | — |

Admins, sub-admins and root never see the application CTA for any role. The
same rule applied on Profile before this change.

Balances stay separate and are never added together:

- **Withdrawable earnings:** the earnings wallet (`organizer_wallets`), for organizers and service providers. The service-provider gap in `customer-wallet`'s Earnings tab is fixed.
- **VENTS Wallet:** `user_wallets`. Spendable, not withdrawable.
- **VENTS Cents:** VC balance plus lifetime total.
- **Representative rewards:** a separate tile.

Work Opportunities show "Coming soon" with no listings.

## Named concepts audited

| Name | Source definition found | Status |
|---|---|---|
| VENTS Earn | 0193–0197 (recruiter partnerships) + the 2026-10-30 brief (₦50,000 reward) | Implemented (below) |
| **VENTS Unlock** | **None.** Not in code, migrations, docs, design-source, the approved VENTS Work mockups, or the account's artifacts. | **Undefined. Nothing built.** |
| **VENTS Split** | **None.** (`recruiter_partnerships.commission_split_bps` is a 0193 column meaning "share of the recruiter's commission given to the organizer"; it belongs to the retired 10% model, and nothing calls it "VENTS Split".) | **Undefined. Nothing built.** |
| **VENTS Circle** | **None.** | **Undefined. Nothing built.** |

## Representative reward (migration 0201)

The rules come from the product owner's brief. Each one is enforced in SQL,
not in the UI.

1. **Attribution.** When an organizer accepts a representative's partnership, the organizer is attributed to that representative.
   - The first accepted partnership wins; one representative per organizer.
   - A later partnership with another representative is blocked and audited.
   - Self-referral is blocked by a `CHECK` constraint.
   - Attribution survives a revoked partnership.
   - Existing accepted partnerships are backfilled.
   - `organizer_had_events_before` is recorded for admin review.
2. **Qualifying event.** The event belongs to the organizer and was created after attribution. It must also be:
   - live, not deleted, and not hidden by an admin;
   - over (`end_date`, else `event_date`) plus a settlement hold;
   - free of `pending` payments, pending `pending_purchases`, and `refund_pending` tickets.

   **Free events never qualify** (owner correction 2026-11-09). 0201 shipped an "admin-verified free event" override; 0209 removed
   free events from eligibility (reason `free_event`) and 0216 removed the override itself: an approval request carrying
   `free_event_verified` is refused, the approval branch refuses a free event whatever the request says, and crediting
   refuses a claim recorded as a free event (one approved before 0209/0216 stays on hold for admin rejection or reversal).

   **What "free" means (0216).** An event is free unless at least one ticket is genuinely paid for and still paid: `payment_status = 'paid'`
   with an effective price above zero (`amount × (1 − discount_percentage/100)`, the basis every charge and refund is priced on).
   0209's test (no `paid` ticket and no recorded fee) missed the common case: `purchase_ticket` stores a ₦0 RSVP and a 100%-promo
   ticket as `paid`, so a free event with attendees counted as paid, and so did an event whose every ticket was refunded.
   Refunds are whole tickets, one row per attendee, so a partially refunded event still qualifies while any paid ticket remains.
3. **Flow.** The claim moves through these steps:
   - The representative submits.
   - The organizer confirms (or declines).
   - Admin A requests approval.
   - Admin B approves through `approve_admin_action`.

   Neither admin may be the representative or the organizer.
4. **One reward per organizer, ever.** A rejected claim can be resubmitted; a reversed one cannot.
5. **Funding.** The representative's "Claim reward" reserves the reward from the realized-profit pool.
   - The single pool row is locked, so concurrent claims can never spend the same profit.
   - A per-claim idempotency key stops retries from double-reserving.
   - If the pool is short, the claim stays Approved ("waiting for VENTS profit").
6. **Credit (confirmed decision, 2026-10-30): the withdrawable earnings wallet.** A funded reward is credited once to the representative's `organizer_wallets` row, the same wallet organizers and service providers withdraw from. It only happens while `earn_settings.payouts_enabled` is true, which ships **false**. See "Earnings wallet integration" below.
   Since 0216, funding and credit first re-check the claim: a claim recorded as a free event, or whose event is no longer found, live, undeleted and unhidden (or is now free), is refused with "on hold for admin review". Nothing is reserved or credited; admins reject or reverse it through dual control.
   Events have only `live` and `draft` statuses (`events_status_check`), so "cancelled" means taken off live, deleted or hidden, the same reasons eligibility already uses. An organizer who moves an ended event back to draft also puts an approved reward on hold until the event is live again.
7. **Fixed reward, no monthly uplift (confirmed policy; 0217).** Every qualifying organizer earns exactly **₦50,000**. There is no monthly rate, 9+ uplift or bonus.
   - 0201 shipped a dual-control "higher next-month rate" at 9+ qualifying organizers. 0217 removes it:
     - every amount comes from the ₦50,000 base;
     - `earn_set_monthly_rate` is refused at request and at approval;
     - `representative_monthly_rates` is frozen as history;
     - a claim recorded at any other amount is held at credit, never rewritten;
     - an approved, funded or credited claim must be ₦50,000 (table CHECK).
   - The **monthly qualifying count** (by the calendar month, Africa/Lagos, of the qualifying event's end; free-event claims excluded since 0216) is still shown on the dashboards for reporting only. An approved claim held because its event was later cancelled, deleted, hidden or fully refunded still appears in it until admins reject or reverse it.
8. **Expenses** (transport/support) are submitted by the representative and approved or rejected through dual control. They are tracked separately and never touch rewards, the pool or a wallet.
9. **Audit trail.** `earn_audit_log` and `earn_profit_ledger` are append-only. They record attribution, duplicate/self-referral blocks, eligibility snapshots, reviews, recognitions, reservations, credits, reversals, expenses, rate changes and settings changes.
10. **Legacy 10% model.** Audit at migration time:
    - There is no commission ledger.
    - Nothing was ever accrued or paid.
    - There are 2 recruiters, and 1 accepted partnership at 10000 bps.

    The 10% copy is removed from the UI. Approvals and claims stay **blocked** until management records the reconciliation (`earn_update_settings: legacy_commission_reconciled`) through dual control.

    **Retired wiring (0201).** Nothing can calculate, accrue or pay a 10% commission:
    - `invite_recruiter_partnership` is redefined. The organizer's notification now reads "A VENTS representative wants to partner with you. VENTS rewards representatives directly; nothing is shared from or deducted from your earnings." The old "share part of their commission" text and the `commissionSplitBps` push field are gone.
    - The function still accepts `p_commission_split_bps`, so installed apps that send it keep working, but ignores it. New invitations store `commission_split_bps` as NULL; the app no longer sends it.
    - **Kept as evidence:** the `commission_split_bps` column (now nullable, with its historical values), notifications already sent, the reconciliation snapshot (which now also records the split values that existed before 0201), and the dual-admin reconciliation gate.
    - **Needs a later migration, not done here:** dropping the column, or the ignored parameter. Dropping the parameter would break app versions still in use. Both wait until the reconciliation is formally settled.
    - `tickets` / `service_bookings.qualifying_status` (0192, not applied) were planned for commission eligibility. Nothing writes or reads them for money.

Earning states shown to people: Pending (organizer / review) → Approved → Funded → Withdrawable (in the earnings wallet); Rejected; Reversed. Once credited, the money is part of the earnings wallet's available balance. Pending and withdrawn amounts are shown by the existing wallet, because a withdrawal draws on the whole balance, not on one reward.

### Earnings wallet integration

Rewards reuse the existing earnings system. There is no new wallet or balance.

| Existing piece | Role for rewards |
|---|---|
| `organizer_wallets` (one row per user) | `balance_kobo` = available/withdrawable, `pending_kobo` = requested and not yet paid, `total_withdrawn_kobo` = paid out, `total_earned_kobo` = lifetime earned. The reward credit adds to `balance_kobo` and `total_earned_kobo`. |
| `organizer_transactions` (ledger) | One `representative_reward` row per claim on credit, and one `representative_reward_reversal` row on reversal. Both carry `metadata.representative_reward_claim_id`. |
| `request_organizer_payout` → `admin_claim_payout_for_processing` → `admin_mark_payout_processing` → `complete_organizer_payout` / `fail_organizer_payout` / `admin_reject_organizer_payout` / `admin_cancel_processing_payout` | Unchanged. Representatives withdraw rewards exactly as organizers withdraw ticket revenue: available → pending → withdrawn, or back to available on failure, rejection or cancellation. |
| `payouts_disabled()` (`app_config.disable_payouts`) | Unchanged global switch for withdrawals. It is currently **off** (withdrawals are live), so `earn_settings.payouts_enabled` (dual control, ships false) is what keeps rewards from reaching the withdrawable balance until approved. |

Schema changes, all in 0201:
- `organizer_transactions_type_check` gains `representative_reward` and `representative_reward_reversal`. Rewards are deliberately **not** typed `credit`, which the wallet screen, analytics and the fee candidate read as ticket or booking revenue.
- Unique indexes `organizer_transactions_rep_reward_once` and `organizer_transactions_rep_reward_reversal_once` on `metadata->>'representative_reward_claim_id'`, plus a check that every reward row names its claim. A retry can never credit or reverse twice; the ledger row is written first and the balance moves only if it was inserted.
- `representative_reward_claims.earnings_transaction_id` links the claim to its ledger row.

**Reversal.** This takes the reward back out of the **available** balance only. If part of it is pending withdrawal or already withdrawn, the reversal is refused and must be recovered manually. Money in flight or already paid is never silently clawed back. A successful reversal also lowers `total_earned_kobo` and returns the amount to the profit pool.

**Kept separate.** 0201 does not write to the VENTS Wallet (`user_wallets`, `user_wallet_transactions`) or VENTS Cents. The local test checks the VENTS Wallet balance is unchanged.

**App.** The earnings wallet screen labels the new rows ("Representative Reward" and "Representative Reward Reversed"). It also shows its withdrawal and bank-account sections to anyone with an earnings balance or history, not only organizers and providers. `request_organizer_payout` has no capability gate.

### Realized profit: why it is admin-recognized, not computed

Production cannot compute ticket profit safely today:

- Per-ticket fee accounting (0192) is **not applied**.
- Payment-processor costs are not recorded.
- VENTS Cents reward costs are not recorded.

So 0201 never treats sales as profit. For a finished, settled event it
computes a **fee candidate**:

> recorded `buyer_fee_kobo` on the event's orders
> − the nominal 5% fee of every refunded or refund-pending ticket
> − any recorded organizer-wallet refund shortfall

An admin must state the costs to deduct. A second admin approves, and only
then does `candidate − costs` enter the pool, once per event. A refund on a
recognized event later takes that ticket's fee back out of the pool.

## Blocked or needing a decision

1. ~~VENTS Wallet vs. withdrawable.~~ **Resolved 2026-10-30:** rewards go to the withdrawable earnings wallet (see "Earnings wallet integration"). Reward credit stays off until it is enabled through dual control.
2. ~~Settlement hold.~~ **Confirmed 2026-10-30:** 7 days (the shipped default). Refunds can still be issued after an event, which is why there is a hold. It can still be changed later through dual control (0–120 days).
3. **Processor fees and VC reward costs** must be entered by admins at recognition. Applying 0192 and recording Paystack fees would let this be computed.
4. ~~Policy choices.~~ **Confirmed 2026-10-30**, as implemented:
   - attribution is first-accepted and permanent;
   - the event must be created after attribution;
   - the month is counted by the event's end date;
   - the rate is set per representative.
5. **Expense reimbursement** is approval and tracking only. No payout path exists.
6. **VENTS Unlock / Split / Circle:** definitions needed before anything can be built.
7. **Profile layout.** Mockup A's surrounding profile (compact header, three-row menu) is a sketch. Only the VENTS Work card was changed; the existing profile header, stats and menu were kept.
8. ~~**Higher monthly rate vs. "fixed ₦50,000".**~~ **Resolved: fixed ₦50,000, no uplift (0217).** Previously: Rule 7 of "Representative reward (migration 0201)" above (a dual-control higher rate for the next month at 9+ qualifying organizers) is recorded as approved in `MONETIZATION_IMPLEMENTATION_MASTER_CHECKLIST.md` §10, while later briefs state the reward as a fixed ₦50,000 with no alternative amount or bonus. The mechanism is unchanged (0216 does not touch it, and nothing raises a rate automatically). The owner should confirm whether it stays.
9. **Fraud and duplicate-event screening** is the approving admins' judgement (`event_verified`). The database stops a second reward for the same organizer or event, and free events are refused, but nothing detects a cloned event, and one cheap paid ticket makes an event "paid". Any automated rule (minimum sales, distinct buyers) is a business-policy decision; none was added.
10. **Held claims in the monthly count** (reporting only after 0217). An approved claim that 0216 holds at credit time (event cancelled, deleted, hidden or fully refunded after approval) still counts toward the rate review until admins reject or reverse it. Excluding it automatically would add a rule; none was added.

## Deploying (not done; needs approval)

1. Apply `supabase/migrations/0201_vents_earn_representative_rewards.sql`. It patches `approve_admin_action` and `request_admin_action` in place from their live definitions, and refuses to run if the anchors don't match exactly once.
2. Verify with read-only queries.
3. Deploy the frontend.

Before step 3, the hub and Earnings degrade safely: representatives show "Not paid yet" if the RPC is missing.

## Tests

- **`scripts/local-pg-test/run-representative-rewards-verification.sh`:** 244 real-execution checks (including the paged-history and funnel checks) against local Postgres 16. They include rejection of malformed yes/no values (`"t"`, `"yes"`, `"true"`, numbers, null, arrays, or a missing expense decision) in all four dual-control settings, and of any `settlement_hold_days` that is not a JSON whole number from 0 to 120 (text such as `"7"`, decimals, booleans, null, out of range), with 0 and 120 accepted. They also prove invitations no longer promise commission sharing, the old split value is ignored, and the legacy evidence is kept. Uses verbatim live maker-checker functions and the live `request_organizer_payout` / `complete_organizer_payout`.
- **`scripts/local-pg-test/run-payout-gate-audit.sh`:** the 27-check security audit of the reward payout gate (2026-10-30). It covers:
  - `payouts_enabled` is enforced inside the credit function, with no bypass by direct table write, internal function or admin action;
  - two distinct admins, with the approver a super admin, and neither the representative nor the organizer able to request or approve their own reward;
  - six concurrent retries crediting exactly once;
  - `app_config.disable_payouts` and reward credit working independently;
  - ordinary organizer withdrawals unchanged.

  It refuses to run, before connecting, if any database URL or `PG*` connection variable is set, or if any environment value names a hosted database host. It connects only over the local Unix socket, then confirms the server is local and not Supabase-managed (no server address, no `supabase_admin` role). It creates and always drops its own `vents_local_pg_payout_gate_audit` database.
- **`scripts/local-pg-test/run-representative-reward-integrity-verification.sh`:** 0216 on the full 0201 → 0210 stack (158 checks, 0216 + 0217). Beyond the list below, it reproduces the pre-0216 bugs (free event with an RSVP, 100%-promo and fully refunded events eligible) and checks:
  - partial refunds still qualify;
  - a refund after approval holds the reward;
  - legacy free claims add nothing to the monthly qualifying count;
  - a funded legacy free claim is reversed with its reservation released;
  - two admins approving the same claim at once give one approval;
  - 0217: a ₦75,000 claim approved and funded through 0201's real path is held at credit, never rewritten, and reversed with its whole reservation released;
  - 0217: every new reward is exactly ₦50,000, even for a month with a historical rate row and with a higher amount in the approval request;
  - 0217: monthly-rate requests are refused at request and approval; the rate table is frozen; the base and the fixed-amount CHECK hold;
  - 0217: the dashboards report ₦50,000; order guard, idempotency and an exact undo with no row changed;
  - applying and undoing 0216 change no claim, ledger or wallet row, and the undo restores the constraint's validated state.

  It covers:
  - referral attribution through the real link;
  - a paid event's full path: claim, organizer confirmation, two distinct admins, realized-profit funding, and credit of exactly ₦50,000 to the earnings wallet with the VENTS Wallet untouched;
  - free events refused at submit, at approval (with or without the old `free_event_verified` flag, and even if eligibility misreported), by the table CHECK, and at credit for a pre-0216 approval;
  - events taken off live, deleted or hidden, refused at submit and at credit after approval;
  - duplicate claims, self-approval, double approval, sub-admin, user and representative approvers;
  - same-key, new-key and four-way concurrent credit retries (one ledger row);
  - 0216's order guard, idempotency and exact undo.

  Same local-only safety guards as the referral harness.
- **`src/lib/representativeRewards.security.test.ts`:** static invariants of 0201 (its free-event override checks pin 0201's original text; 0216 replaces that behaviour).
- **`src/lib/representativeRewardsFreeEvents.security.test.ts`:** static invariants of 0216.
- **`qa-harness/earnings-navigation.e2e.mjs`:** in a real browser against the real `App.tsx` (fixture backend, `qa-harness/full-app/`). A representative who is not an organizer reaches the Earnings tab from VENTS Earn's "Withdraw earnings", the VENTS Work "Earnings wallet" shortcut and the Representative dashboard. Profile → Wallet still opens Wallet Balance, and an organizer's Manage Events → Earnings still opens Earnings. Run with `node qa-harness/earnings-navigation.e2e.mjs`.
- **`src/app/components/admin/AdminEarnScreen.test.tsx`:** no approval for a free-event claim, and approval requests never carry `free_event_verified`.
- **`src/lib/workRoles.test.ts`:** role state machine.
- **`src/app/components/work/ventsWork.render.test.tsx`:** the screens.


## Representative dashboard (Batch E)

`RepresentativeDashboardScreen` (route `representative-dashboard`), opened from the VENTS Work hub (Representative row and shortcut) and from the Representatives screen.

| Tab | Shows | Source | Actions |
|---|---|---|---|
| Overview | earnings wallet (withdrawable, withdrawal pending, on hold); this month's qualifying organizers against the rate-review threshold; partnership invitations as plain counts (sent, awaiting a reply, **accepted all time**, **active now**, ended, declined, withdrawn); referred organizers as plain counts (referred, created an event since, reward approved, reward paid); reward lifecycle with counts and amounts | `get_my_representative_performance()` (0201, read-only); before 0201, invitation counts from `recruiter_partnerships` | Withdraw (earnings wallet), Invite |
| Monthly | last six months: qualifying count, submitted, paid (no rate since 0217: the reward is fixed at ₦50,000) | same | — |
| Rewards | claims a page at a time, filtered by stage **on the server**: Pending → Awaiting approval → Approved → Available → Paid → Reversed (Rejected separately); referred organizers, also paged. Stage counts are the server's totals | `get_my_representative_history('claims' / 'attributions')` + performance totals; summary from `get_my_representative_rewards()` | Submit for review, Claim / Add to earnings wallet (one idempotency key per attempt), Open earnings wallet, Show more |
| Team | active partnerships, invitations awaiting a reply, history | `recruiter_partnerships` (RLS) | Find and invite, Withdraw invitation, End partnership (confirmed first) |
| Expenses | totals by status (server), filter (server), decision reasons, submission | `get_my_representative_history('expenses')` + performance totals | Send for approval (two admins decide), Show more |

**No conversion percentages.** The funnel steps are not strict subsets of each other: invitations include service providers, and "accepted" includes partnerships that later ended. A percentage between two rows would mislead, so each row is a plain count with a one-line definition.

**Paging.** `get_my_representative_history(kind, status, before_at, before_id, limit)` returns `{items, next}`, newest first. It uses a keyset cursor on (time, id), so a row added between pages never repeats or shifts a page. The limit is clamped to 1–50 (the app reads 20). It is read-only (STABLE), returns only the caller's own rows, and refuses an unknown kind, a status from another list, or half a cursor. A referred organizer carries `claimed` (a reward that is not rejected exists) and its ten most recent events since attribution. `get_my_representative_rewards()` no longer returns unbounded lists.

**Rules shown are the server's rules** (checked against "Representative reward (migration 0201)" above):
- one reward per organizer, ever;
- the event was created after the organizer accepted the partnership, has ended, and finished the settlement hold (the admin-set `settlement_hold_days`; the app never hardcodes it);
- free events never qualify (0209 eligibility; 0216 approval and credit);
- the organizer is verified and confirms the referral, then two admins review;
- an approved reward waits to be funded from VENTS profit; once funded and payouts are on, the representative adds it to the earnings wallet;
- the reward is a fixed ₦50,000 per qualifying organizer, with no monthly rate or bonus (0217); a month's qualifying count is by the qualifying event's end month (Lagos), so it can still rise after the month ends, and it affects no amount;
- approving an expense records it; nothing in the app pays it out.

**When the 0201 functions are missing or refused:** a missing function, or the read-only Preview refusing one, shows "Representative rewards are not switched on yet". No reward figures are shown in that state; the history function is not called; invitation counts and the team still work. If only the dashboard function is missing, the lists still work but show no totals (chips carry no number, expense totals show "—"). A real error (for example, a timeout or not authenticated) is shown as an error. A failed team read shows the error and a retry, never an empty team. A failed earnings read shows "—", never ₦0.
