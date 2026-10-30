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

   A free event qualifies only if the approving admin explicitly verifies it as genuine.
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
6. **Credit.** A funded reward is credited once (unique reference `rep_reward:<claim>`) to the **VENTS Wallet**, and only while `earn_settings.payouts_enabled` is true. It ships **false**.
7. **Monthly count** is by calendar month (Africa/Lagos) of the qualifying event's end. At 9 or more, a dual-control request may set a higher rate (above ₦50,000) for the following month only. Nothing rises automatically.
8. **Expenses** (transport/support) are submitted by the representative and approved or rejected through dual control. They are tracked separately and never touch rewards, the pool or a wallet.
9. **Audit trail.** `earn_audit_log` and `earn_profit_ledger` are append-only. They record attribution, duplicate/self-referral blocks, eligibility snapshots, reviews, recognitions, reservations, credits, reversals, expenses, rate changes and settings changes.
10. **Legacy 10% model.** Audit at migration time:
    - There is no commission ledger.
    - Nothing was ever accrued or paid.
    - There are 2 recruiters, and 1 accepted partnership at 10000 bps.

    The 10% copy is removed from the UI. Approvals and claims stay **blocked** until management records the reconciliation (`earn_update_settings: legacy_commission_reconciled`) through dual control.

Earning states shown to people: Pending (organizer / review) → Approved → Funded → In VENTS Wallet; Rejected; Reversed.

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

1. **VENTS Wallet vs. "withdrawable/paid".** The brief says to credit the reward "through the VENTS Wallet", and also lists withdrawable and paid as states. The VENTS Wallet is spendable and **not withdrawable**, so a credited reward cannot be withdrawn or "paid" today. Two ways to resolve it:
   - (a) add a withdrawal path for reward credits, or
   - (b) credit the earnings wallet instead.

   Until then the last reachable state is "In VENTS Wallet", and payouts stay off.
2. **Settlement hold** defaults to 7 days. Refunds can still be issued after an event, and no hold period was specified. The hold can be changed through dual control (0–120 days).
3. **Processor fees and VC reward costs** must be entered by admins at recognition. Applying 0192 and recording Paystack fees would let this be computed.
4. **Policy choices made conservatively. Please confirm:**
   - attribution is first-accepted and permanent;
   - the event must be created after attribution;
   - the month is counted by the event's end date;
   - the rate is set per representative.
5. **Expense reimbursement** is approval and tracking only. No payout path exists.
6. **VENTS Unlock / Split / Circle:** definitions needed before anything can be built.
7. **Profile layout.** Mockup A's surrounding profile (compact header, three-row menu) is a sketch. Only the VENTS Work card was changed; the existing profile header, stats and menu were kept.

## Deploying (not done; needs approval)

1. Apply `supabase/migrations/0201_vents_earn_representative_rewards.sql`. It patches `approve_admin_action` and `request_admin_action` in place from their live definitions, and refuses to run if the anchors don't match exactly once.
2. Verify with read-only queries.
3. Deploy the frontend.

Before step 3, the hub and Earnings degrade safely: representatives show "Not paid yet" if the RPC is missing.

## Tests

- **`scripts/local-pg-test/run-representative-rewards-verification.sh`:** 117 real-execution checks against local Postgres 16, with verbatim live maker-checker functions.
- **`src/lib/representativeRewards.security.test.ts`:** static invariants.
- **`src/lib/workRoles.test.ts`:** role state machine.
- **`src/app/components/work/ventsWork.render.test.tsx`:** the screens.
