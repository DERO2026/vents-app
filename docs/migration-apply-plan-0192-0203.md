# Migrations 0192, 0201, 0202, 0203: reconciliation and apply plan

Batch B, read-only investigation, 2026-10-30/31 (PR #82). **Nothing in this
plan has been applied.** Every production fact below comes from read-only
queries on Supabase project `slrtjxtzhowhwhebjprv`. Every ordering claim is
proven by `scripts/local-pg-test/run-migration-order-verification.sh` (27
checks, all passing), which applies the migrations in each candidate order
to a production-shaped local database.

Applying any of this to production needs the owner's explicit approval.

**Batch C update (2026-10-31, code only):**
- 0192 is retired to `supabase/migrations/_superseded/` (byte-identical);
- 0202 now has the md5 drift guard recommended in §5.2;
- 0202's `admin_release_payout_claim` keeps production's `DEFAULT NULL` (it would otherwise have failed in production);
- a verified rollback snapshot of 17 of the 19 functions is in `supabase/rollback/`.

The step-by-step deploy and rollback is `docs/deploy-runbook-0201-0203.md`.

## 1. Recommendation

1. **Do not apply 0192.** Retire it: keep the file for history, but mark it superseded so no one applies it by filename order (section 4).
2. **Apply 0201 → 0202 → 0203, in that order**, each on its own and in its own transaction. Not 0202 → 0201, which the tracker previously stated.
3. **0203 and the PR #82 frontend go live together**, in one short window with purchases and payouts paused (section 6).
4. **Never use `supabase db push` on this project** (section 5.1).

## 2. What each migration does

| Migration | Purpose | Touches money paths | State in prod |
|---|---|---|---|
| 0192 | Per-ticket platform-fee allocation (`tickets.platform_fee_kobo`), the 30-day commission `qualifying_status` columns, `platform_fee_reversals`, `payment_disputes`, a reconciliation view, and a unique index on credit references. Full `CREATE OR REPLACE` of `confirm_ticket_payment` and `credit_organizer_wallet` | Yes | Not applied |
| 0201 | Representative rewards (₦50,000 model), attribution backfill, profit pool, dual-control executors; patches `approve_admin_action` / `request_admin_action` by anchor | Yes (rewards) | Not applied |
| 0202 | Payout engine safety: no double payout, reversal returns money, a fixed transfer reference per request, reconciliation report. Full rewrite of 5 payout functions plus 3 new ones | Yes (payouts) | Not applied |
| 0203 | 4% + 5% fees, 48-hour settlement holds, refund recovery, booking disputes, two-admin withdrawal authorization; patches 14 functions, each pinned by md5 | Yes (all) | Not applied |

## 3. Overlap and proven hazards

Functions touched by more than one migration (by name):

| Pair | Shared functions |
|---|---|
| 0192 ∩ 0203 | `confirm_ticket_payment`, `credit_organizer_wallet` |
| 0201 ∩ 0203 | `approve_admin_action`, `request_admin_action`, `earn_event_eligibility`, `earn_ticket_refund_adjust_profit`, `earn_ticket_nominal_fee_kobo` |
| 0202 ∩ 0203 | `admin_claim_payout_for_processing`, `complete_organizer_payout` |
| 0192 ∩ 0201, 0192 ∩ 0202, 0201 ∩ 0202 | none |

Shared table objects:

- `organizer_transactions_type_check` is dropped and recreated by 0201, 0202 and 0203. Each version is a superset of the one before only in the order 0201 → 0202 → 0203.
- `service_bookings.completed_at` is added by 0192 (plain `ADD COLUMN`) and by 0203 (`IF NOT EXISTS`).

Proven by execution (run-migration-order-verification.sh):

| Scenario | Result |
|---|---|
| 0201 → 0202 → 0203 | All apply; 0203 patches `confirm_ticket_payment` and `credit_organizer_wallet`; 0203 re-run is a no-op. **Safe.** |
| 0202 → 0201 | 0201 recreates the ledger type check **without `payout_reversal`**. 0202's reversal path then fails until 0203 restores it. If a `payout_reversal` row already exists, 0201 fails outright (rolled back). **Unsafe.** |
| 0192 first, then 0201 → 0202 → 0203 | 0203 refuses: 0192 rewrote `confirm_ticket_payment`, so the md5 pin no longer matches. It fails closed and rolls back, but **0203 can never apply**. |
| 0201 → 0202 → 0203, then 0192 | 0192 fails on `completed_at` and rolls back, leaving 0203 intact. |
| Same, with the "obvious fix" (`ADD COLUMN IF NOT EXISTS`) | 0192 applies **and silently replaces 0203's `confirm_ticket_payment` and `credit_organizer_wallet`**. The 4% + 5% fee model and the 48-hour hold vanish with no error. **This is the most dangerous outcome in the whole set.** |

## 4. Reconciling 0192

What 0192 still offers, against what superseded it:

| 0192 piece | Status | Why |
|---|---|---|
| `qualifying_status` on tickets and bookings (30-day commission hold) | **Superseded** by 0201 | The 10% commission model was retired; 0201 computes reward eligibility per event. Nothing reads these columns. |
| `payment_disputes` table | **Superseded** by 0203 | 0203's `place_payment_dispute_hold` records disputes as earnings holds plus audit rows. |
| `platform_fee_reversals` | **Unused** | 0203 records refunds and recoveries in `organizer_transactions` / `earnings_recoveries`. |
| `tickets.platform_fee_kobo` allocation | **Outdated** | It allocates only `buyer_fee_kobo`. Under 0203's `v2_4_5` model, VENTS revenue is the 4% buyer fee **plus** the 5% organizer commission, so this column would understate revenue. It is also never set for wallet-paid tickets. |
| Unique index on `credit` + `paystack_reference` | **Compatible**, worth keeping | Production has 0 duplicates. 0203's release path writes no new `credit` rows. |

No app or API code reads any 0192 object (checked by the order script).

**Recommendation:** retire 0192. Rename it to
`supabase/migrations/_superseded/0192_platform_fee_accounting_foundation.sql`,
or add a first statement that raises "superseded by 0201/0203". Either way,
a person applying by filename cannot pick it up.

If per-ticket revenue accounting is wanted later (reporting, tax), write it
as a new **0204 after 0203**:
- add the columns with `IF NOT EXISTS`;
- patch the post-0203 bodies by anchor with md5 pins, like 0203 does, instead of replacing them;
- allocate both fee parts;
- keep the credit-reference unique index.

This is an owner decision, not a launch blocker.

## 5. Preflight checks (run read-only immediately before applying)

### 5.1 Tooling

- Production migration history records versions as apply timestamps (`20261030014037 0200_…`), not repo filenames. `supabase db push` would therefore see about 190 repo files as unapplied and try to re-run them. **Never use it here.** Apply each file by itself (Supabase SQL editor, `apply_migration`, or `psql -1 -v ON_ERROR_STOP=1 -f`). Each file must run in **one transaction**; none of the four uses `CONCURRENTLY`, and none has its own `BEGIN`/`COMMIT`.
- Use a maintenance session with `SET lock_timeout = '5s'`, so a blocked `ALTER TABLE` fails instead of queueing webhooks behind it.

### 5.2 No drift since this plan (2026-10-30 values)

| Check | Expected | Found |
|---|---|---|
| 0203's 11 pins on functions that exist today (`create_pending_purchase`, `confirm_ticket_payment`, `confirm_ticket_payment_via_wallet`, `refund_ticket`, `finalize_ticket_refund`, `cancel_service_booking`, `finalize_service_booking_refund`, `get_event_analytics`, `credit_organizer_wallet`, `credit_provider_wallet_for_booking`, `request_organizer_payout`) | all match | **11/11 match** |
| 0203's 3 remaining pins (`earn_event_eligibility`, `earn_ticket_refund_adjust_profit`, `complete_organizer_payout`) | match only after 0201/0202 | absent / pre-0202 (expected) |
| 0202 replaces these from the 2026-10-30 live bodies (its drift guard, added in Batch C, enforces these md5s): `admin_claim_payout_for_processing` `89675182b62750b8631eb2de1d71211e`, `admin_mark_payout_processing` `bf84ac786144b3ea3796fbc09f4bbec6`, `admin_release_payout_claim` `33dd4783b1bb7c4333b70bf32c671e02`, `admin_cancel_processing_payout` `cea18083231d281ba2fee58e7610a774`, `complete_organizer_payout` `563304a9394f6fb5148b2d458ce945f6` | unchanged | recorded 2026-10-30 |
| 0201's anchors in `approve_admin_action` (md5 `24d77efd072158b729009014f5c808e3`) and `request_admin_action` (`a07cbf3e5d1cd62741765a325c5813ae`) | unchanged | recorded 2026-10-30 |
| Migrations 0192/0201/0202/0203 | absent | `get_my_representative_rewards`, `admin_earnings_reconciliation`, `earnings_release_delay`, `tickets.qualifying_status` all absent |

If any function changed since: stop, re-read it, and regenerate the
affected migration (`scripts/local-pg-test/generators/gen0203.py` for 0203).
0202 now carries this md5 guard (Batch C); it refuses on any other body.

### 5.3 Data that new constraints and indexes must accept

| Constraint / index (migration) | Check | Found |
|---|---|---|
| ledger type check (0201/0202/0203) | existing `organizer_transactions.type` values ⊆ new list | `credit` 36, `payout` 7: OK |
| withdrawal status check (0202) | existing statuses ⊆ new list | pending 5, completed 5, cancelled 4, failed 2, rejected 2: OK |
| `organizer_transactions_payout_once` (0202) | no request with two `payout` rows | 0 duplicates |
| `organizer_withdrawal_requests_reference_once` (0202) | no duplicate `paystack_reference` | 0 duplicates |
| attribution backfill (0201) | accepted organizer partnerships; self-referrals; organizers with two representatives | 2; 0; 0 |
| `organizer_wallets_on_hold_nonneg` and similar (0203) | no negative balance or pending | 5 wallets, 0 negative |
| (0192, if ever) credit-reference unique index | no duplicate credit references | 0 duplicates |

## 6. Data and behaviour impact

**Existing rows are not rewritten.** Additive columns take constant
defaults. Existing tickets and pending purchases get
`fee_model = 'legacy_5'`. Existing balances stay withdrawable. The only
one-off writes are:
- 0201's attribution backfill (2 rows);
- 0201's legacy-commission audit snapshot;
- audit-log rows.

What changes the moment 0203 is live:

| Area | Impact | Mitigation |
|---|---|---|
| Checkout | New purchases are charged face + 4%, and organizers get face − 5%. The **current production frontend (`main`) displays "Service fee (5%)"**, so it would show more than it charges. The PR #82 frontend displays 4%; deployed **before** 0203 it would show 4% while the server still charges 5%, which is worse | Pause purchases (`disable_purchases`), apply 0203, promote PR #82, verify, then resume. Keep the window to minutes |
| Open checkouts | 21 `pending_purchases` keep `legacy_5` and the amount already quoted | None needed; tested in the earnings suite |
| Withdrawals | 5 pending requests (₦49,100, oldest 2026-09-02) can no longer be claimed until two admins authorize them. `main`'s admin screen has **no authorize step**; PR #82 has one | Decide these 5 in Batch C first, or authorize them in PR #82's Admin → Payouts after the deploy |
| New earnings | Ticket and booking earnings land in `on_hold_kobo` and become withdrawable 48 hours after the event ends or the booking completes (daily cron, plus release on request) | Explained in Terms/Help (PR #82) |
| Bookings | All 7 production bookings have no scheduled date, so only admins can mark them complete. 1 is `confirmed` | Admin completes it, or the provider adds a date |
| Representative rewards | Stay off: `payouts_enabled = false` and `legacy_commission_reconciled = false`; both are dual-control | No change until two admins enable them |
| Ledger gaps | 2 of 5 wallets disagree with their ledgers (₦32,150 and ₦1,000). `admin_earnings_reconciliation()` (0202) will report them | Batch C: audited adjustments, never silent updates |

Lock impact: every `ALTER TABLE` targets small tables (`tickets` 108,
`organizer_transactions` 43, `organizer_withdrawal_requests` 18,
`service_bookings` 7, `organizer_wallets` 5 rows). Each lock is held well
under a second, inside the migration's transaction.

## 7. Apply runbook (for the owner to approve; not executed)

1. Announce a 15-minute window. In Admin → System, set `disable_purchases` and `disable_payouts` (both audited kill switches).
2. Take a backup: a Supabase dashboard backup or PITR restore point, plus `pg_dump --schema-only`, plus a snapshot of the 19 functions in section 8.
3. Run the section 5 preflight queries. Stop on any mismatch.
4. Apply **0201**. Verify: `get_my_representative_rewards()` exists; 2 attributions; `payouts_enabled = false`.
5. Apply **0202**. Verify: `admin_earnings_reconciliation()` runs and lists the 2 known gaps; the type check includes `payout_reversal`.
6. Apply **0203**. Verify: every patched function contains `[0203]`; `earnings_release_delay() = 48 hours`; new tickets default to `v2_4_5`.
7. Promote the PR #82 production deployment (merge per review). Verify one ₦100 test purchase charges ₦104 and the organizer is credited ₦95 on hold (PAY-3, PAY-4).
8. Clear both kill switches. Watch Sentry and the webhook logs for 30 minutes.

## 8. Rollback and recovery

**A failure during apply** rolls back that file automatically: each file is one transaction, and the order script proves this for 0201, 0192 and 0203. Stop there. Migrations already applied before it stay in place, and the order above keeps every intermediate state consistent:
- after 0201 only: nothing user-facing changes;
- after 0202: payouts are safer and the old frontend still works.

**After a successful apply,** prefer rolling forward: a new migration that fixes the specific defect. If a rollback is unavoidable:

| Layer | How | Notes |
|---|---|---|
| Functions | Re-run the pre-apply snapshot of the 19 replaced functions (taken in step 2) | `admin_cancel_processing_payout`, `admin_claim_payout_for_processing`, `admin_mark_payout_processing`, `admin_release_payout_claim`, `approve_admin_action`, `cancel_service_booking`, `complete_organizer_payout`, `confirm_ticket_payment`, `confirm_ticket_payment_via_wallet`, `create_pending_purchase`, `credit_organizer_wallet`, `credit_provider_wallet_for_booking`, `finalize_service_booking_refund`, `finalize_ticket_refund`, `get_event_analytics`, `invite_recruiter_partnership`, `refund_ticket`, `request_admin_action`, `request_organizer_payout` |
| Held money | **Before** restoring the pre-0203 `credit_organizer_wallet`, release or move every `on_hold_kobo` back to `balance_kobo`, with a ledger and audit row per hold | Otherwise held earnings strand in a column the old code never reads |
| New tables and columns | Leave them (additive, unused by old code). Never drop a table holding financial rows (`earnings_holds`, `earnings_recoveries`, `earn_profit_ledger`, `earn_audit_log`) | Append-only audit stays the record of what happened |
| Constraints | Leave the widened checks; they only allow more values | — |
| Frontend | Vercel instant rollback to production deployment `dpl_8L1sqPf1u2FSggsC7DYYUzUqjAwa` (`5612ee0`) | **Only together with** the function rollback: `main`'s frontend shows 5% and has no authorize step |
| Last resort | Point-in-time restore to step 2 | Loses every purchase, payout and booking since. Reconcile them with Paystack's dashboard before reopening |

## 9. Open owner decisions

1. Retire 0192 (recommended), or rewrite it as a post-0203 0204.
2. Approve the window and the kill switches in section 7.
3. The 5 pending withdrawals: settle them before the window (Batch C) or authorize them after.
4. Add an md5 guard to 0202 before applying (recommended; small change).
