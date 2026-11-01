# Batch D: production readiness and approval preparation

2026-10-31, PR #82. Updated 2026-11-01 (payout incident, §2a), on the
branch `claude/payout-incident-batch-d`.

**Batch D is not complete.** The payout incident has a fix (0205), but it
is not applied. The wallet discrepancies in §2 need owner decisions.

What the 2026-11-01 update did and did not do:
- **Read-only SELECTs only** against production (2026-10-31, listed in §2a). No production write of any kind.
- **No migrations applied.**
- **No money moved, no ledger or balance changed.**
- **No payout approved, rejected, initiated or reversed; no authorizations or pauses.**

Production facts below come from evidence already captured read-only
during this work (2026-10-27 to 2026-10-30). Each is labelled with its
capture time. Queries marked **(owner, read-only)** are prepared for the
owner to run after approval; none was run.

Companion documents:
- `docs/deploy-runbook-0201-0203.md` (the window);
- `docs/migration-apply-plan-0192-0203.md` (why).

## 1. The two rollback functions previously missing: resolved

| Function | Previous status | Now | Evidence |
|---|---|---|---|
| `complete_organizer_payout(text)` | Production body in no repository file | **Verified.** Production's definition was captured read-only on 2026-10-30 while 0202 was written. Its body md5 is `563304a9394f6fb5148b2d458ce945f6`, the exact value production reported. Kept as `supabase/rollback/sources/complete_organizer_payout.prod-2026-10-30.sql` | md5 of the captured body |
| `invite_recruiter_partnership(uuid,uuid,integer)` | No production md5 recorded | **Verified by provenance.** Production's migration history (captured 2026-10-28) records 0197's applied SQL with md5 `c70b4763f640022084c5f5c509415a69` and length 7,068. That is the md5 and length of `supabase/migrations/0197_vents_earn_notifications_use_valid_type.sql` byte for byte; 0196 matches too. No later migration touches the function, so production's body is 0197's (`32fbfa3f…`). Only a manual edit outside migrations could differ; runbook step P2 compares the live body | applied-SQL md5 = file md5 |

The rollback snapshot `supabase/rollback/pre_0201_0203_functions.sql` now
covers **all 19** functions. `run-rollback-snapshot-verification.sh`
restores them over a database with 0201 + 0202 + 0203 applied: every body
has its expected md5, and grants are unchanged.

**Batch C risk 1 closed as well.** With production's `complete_organizer_payout` body in hand, 0202's rewrite was diffed against it. The differences are exactly 0202's documented fixes:
- a payout after a cancel takes the returned money back;
- `failed`/`rejected` requests are flagged `needs_review` instead of completed;
- `reversed` is final;
- `LEFT JOIN` on the bank account: a deleted account no longer hides a real transfer (the live `JOIN` returned `not_found`);
- the ledger debit is the amount actually recovered.

Nothing was removed unintentionally.

## 2a. Payout incident: four paid transfers recorded as cancelled

### Evidence

Owner-confirmed (Paystack dashboard, LIVE):
- the four transfers below were **paid**: ₦100 each, ₦400 in total, plus ₦40 in transfer fees;
- their Paystack references match the VENTS rows exactly.

Read-only from production (2026-10-31):

| Request | Created (UTC) | Transfer code | Reference (legacy, per attempt) |
|---|---|---|---|
| `3aa0f8ff` | 2026-07-09 08:31 | `TRF_5x4kfsos12pysbiz` | `payout_3aa0f8ff-…_1783681361539` |
| `f9fda363` | 2026-07-09 09:29 | `TRF_tg95h5eis3j3evvp` | `payout_f9fda363-…_1783681476919` |
| `6ad1272d` | 2026-07-09 12:26 | `TRF_wzotcvdwiv7ola7t` | `payout_6ad1272d-…_1783681779407` |
| `56b084bb` | 2026-07-10 11:33 | `TRF_fdjyi7dct57sf5j4` | `payout_56b084bb-…_1783683296950` |

All four rows share these facts:
- organizer `91b0afb4` (the `testerboy` test account);
- status `cancelled`;
- `updated_at` = **2026-07-12 23:41:28.542**, identical to the millisecond;
- `resolved_by` NULL;
- `admin_note` = "Test payout request cleared during platform launch sweep".

What is missing for all four:
- **no** `organizer_transactions` row (no `payout`, no `cancelled_payout_refund`);
- **no** `admin_logs` entry;
- they are **not** counted in `total_withdrawn_kobo` (₦600 = the ₦400 and ₦200 completed payouts).

Production-wide, these are the **only** `cancelled` withdrawal requests:
- 4 rows, all with a transfer code;
- none with a refund ledger row.

### Root cause (exact)

`migrations/20260713100000_admin-stats-and-payout-cleanup.sql`, section 3 (the "platform launch sweep", InsForge era):

```sql
UPDATE public.organizer_withdrawal_requests w
SET status = 'cancelled', admin_note = 'Test payout request cleared during platform launch sweep', updated_at = now()
FROM public.users u
WHERE w.organizer_id = u.id AND u.username = 'testerboy' AND w.status IN ('pending', 'processing');
```

1. **2026-07-09/10.** The July engine's request function moved ₦100 each from balance to pending (`20260709074912_paystack-manual-payout-engine.sql`). An admin sent each to Paystack, and the rows became `processing` with transfer codes. Paystack paid them.
2. **No completion was recorded.** Either the `transfer.success` webhooks never reached `complete_organizer_payout`, or they failed there. The July version would have written a ledger row, and none exists. So the rows stayed `processing`.
3. **2026-07-12 23:41.** The sweep re-labelled them `cancelled` with a raw UPDATE. It bypassed every payout function:
   - it did not ask Paystack;
   - it did not release pending;
   - it did not return money;
   - it wrote no ledger row and no audit log.

   Its own comment says it "mirrors what `admin_cancel_processing_payout` does", but that function also returned the money and wrote a `cancelled_payout_refund` row. Cancelling a `processing` transfer was the mistake. Only Paystack's outcome may end a request with a transfer.
4. **After the sweep, nothing could complete them.** `complete_organizer_payout` only completes `pending`/`processing` rows, and Reconcile only lists `processing` rows.
5. **Later, the ₦400 left `pending` through an unrecorded step.** Today pending = ₦44,100 = exactly the four September requests. There is no function, migration or admin log that explains it, and wallets have no change history. Two possibilities:
   - **(a)** pending was reduced by ₦400. The money left with the transfers, and only the books are wrong.
   - **(b)** the ₦400 was moved back to available balance. Then the account holds ₦400 it already received.

   **The evidence cannot tell (a) from (b).** §2 shows the effect either way.

### Why 0202/0203 alone would make it worse

0202's `complete_organizer_payout` was written for exactly these rows. It assumes a `cancelled` row's money "was returned to the balance" and takes it back on a late success; 0203 turns any shortfall into an `earnings_recoveries` receivable. For the swept rows nothing was returned. So a replayed `transfer.success` would charge the organizer ₦100 per request a second time, out of the balance that funds the four live pending withdrawals. A replay can come from the Paystack dashboard's "resend" or a delayed delivery. The local reproduction proves it: "DEFECT reproduced (0202 + 0203 alone)".

### Fix (repository only; not applied)

**`supabase/migrations/0205_payout_cancelled_transfer_safety.sql`**: apply right after 0203 in the same window (runbook W6a). Its drift guard pins 0203's exact `complete_organizer_payout` body (md5 `dbcccdb9…`).

1. **Late success on a cancelled request.**
   - Money is taken back only with positive evidence that the cancel returned it: a `cancelled_payout_refund` ledger row, or 0202's `cancel_processing_payout` log.
   - Otherwise it moves no money and creates no receivable. It leaves the request as it is, logs `payout_success_on_unrefunded_cancel` once per request, and returns `needs_review`.
   - `fail`/`reverse` already leave cancelled rows alone.
2. **The payout state machine, enforced by trigger on every UPDATE**, raw SQL included:
   - a request with a transfer (or `processing` with a reference) can never be cancelled, rejected or sent back to pending;
   - `failed`/`rejected`/`reversed` are final; `completed` can only become `reversed`; `cancelled` can only become `completed`;
   - the reference, transfer code, amount and owner cannot be rewritten;
   - a request with payout history cannot be deleted.

   **The July sweep statement now fails.**
3. **`admin_payout_integrity_report()`** (read-only, admins only). It lists:
   - cancelled/rejected requests with a transfer, and whether their money was returned;
   - completed requests without a ledger payout;
   - payouts stuck over a day;
   - late Paystack successes after a cancel;
   - ledger payouts linked to no request.

   On production after 0205 it will list the four requests above, and the two orphan ₦100 ledger debits (`56bd6ede`, `328cb300`).

**Webhook (`api/webhook/paystack.ts`).**
- A `needs_review` result is logged as `PAYOUT NEEDS REVIEW`, answered 200 (a retry cannot change it) and never emailed.
- A transfer event whose code matches no row is retried by its reference. Before, a request whose "mark sent" step failed after Paystack accepted the transfer lost its success or failure: the request stayed `processing` until someone ran Reconcile.

**Tests**
- `scripts/local-pg-test/run-payout-cancelled-transfer-verification.sh`: **47/47**. It reproduces the incident with the sweep's SQL verbatim, the real request ids, codes and references. It shows the 0202/0203 defect, then proves:
  - replays (by code, reference and id; repeated) move no money;
  - failed/reversed replays change nothing;
  - the live pending request is untouched;
  - the report, the guard rules and a genuine legacy cancel still settle;
  - every 0203 path still works: authorize, claim once, mark sent, complete once, reverse once, fail once, release, reject.
- `api/_lib/payoutCancelledTransferIncident.security.test.ts`: 13 tests. 3 of the webhook tests fail against the previous handler.
- **Effect on the existing earnings-policy suite** (163 checks), run with 0205 applied after 0203: exactly **one** check changes. Its legacy-cancel fixture fakes "money returned" with a raw balance edit and no refund evidence, and now gets `needs_review` instead of a take-back. That is the intended behaviour. The suite itself is unchanged and still passes 163/163 without 0205.

### What 0205 does not do

It does not correct the books. **Recording the four paid transfers is an owner decision (D10).** The truthful entry is:
- a ₦400 `payout` debit and ₦400 `total_withdrawn`, with no balance change if (a) above;
- or the same plus a ₦400 balance reduction if (b).

It needs the audited dual-control adjustment (D3), not a raw UPDATE, which is the very thing that caused this incident. The ₦40 in fees is a VENTS platform cost, recorded outside the organizer ledger.

## 2. Wallet reconciliation gaps

Evidence: per-wallet reconciliation captured 2026-10-30 11:42 UTC (all 5 earnings wallets).

| Wallet (user id prefix) | balance + pending | Ledger credits − debits | Gap | Earned counter vs ledger credits | Other signals |
|---|---|---|---|---|---|
| `91b0afb4` | ₦300,800 + ₦44,100 = **₦344,900** | ₦313,550 − ₦800 = **₦312,750** | wallet holds **₦32,150 more** than the ledger explains | earned ₦350,000 vs ledger credits ₦313,550 (₦36,450 credited with no ledger row) | 2 payout rows not linked to a request (₦200); 1 credit with no source |
| `dfca505f` | ₦35,800 + ₦0 = **₦35,800** | ₦37,400 − ₦600 = **₦36,800** | ledger shows **₦1,000 more** than the wallet holds | earned ₦36,400 vs ledger credits ₦37,400 (one ₦1,000 ledger credit never reached the wallet) | 1 credit with no source |
| `7af13434`, `c9eb5eb6`, `d7899317` | — | — | reconcile | — | `d7899317` has 2 credits with no source but reconciles |

### `91b0afb4`: the ₦32,150, decomposed exactly

> **Superseded 2026-11-01** by "rebuilt from source rows" below (₦32,350). This decomposition assumed the cancelled payouts had returned their money and the orphan debits had paid out; both assumptions were wrong.

wallet − ledger = (earned − withdrawn − X) − (credits − debits), where X is
balance that left the wallet without moving the earned/withdrawn counters:

| Component | Amount | Meaning |
|---|---|---|
| Earned but never written to the ledger | **+₦36,450** | earned ₦350,000 − ledger credits ₦313,550 |
| Ledger payouts with no withdrawn-counter effect | **+₦200** | ledger debits ₦800 − withdrawn ₦600: the two "orphaned pre-payout-engine" ₦100 requests (`4ee9fb31`, `a27e3434`, now `failed`) have payout rows but no request link |
| Balance that left without a counter | **−₦4,500** | (earned − withdrawn) ₦349,400 − (balance + pending) ₦344,900 |
| **Gap** | **₦32,150** | 36,450 + 200 − 4,500 |

What this does and does not say:
- **Most of it is unledgered earnings.** It is likely credits made before every wallet credit wrote a ledger row, or credits written directly to the wallet. The evidence shows the totals, not the rows.
- **₦4,500 left the balance without any counter or ledger row.** Candidates are direct wallet edits or a refund path that skipped the ledger. It is unexplained until the rows are read.
- **Corrected 2026-11-01:** this line previously said cancelling "returned their money to the wallet". It did not. The 4 cancelled ₦100 payouts were **paid** by Paystack, and the raw-UPDATE cancel returned nothing (§2a). See the source-row reconciliation below.
- **This wallet owns 4 of the 5 pending withdrawals** (section 4).

**Key bound:** the 4 pending requests total ₦44,100, well inside the ₦312,750 the ledger *does* explain. Paying them cannot pay out unexplained money. The risk sits in the last ₦32,150 of balance, which no pending request touches.

### `91b0afb4` rebuilt from source rows (2026-10-31, read-only)

Every ledger row of the wallet, matched to the sale, booking or transfer behind it:

| Source | Ledger | Real money | Notes |
|---|---|---|---|
| "Admin test credit" (`77769e0a`, 2026-06-22) | +₦10,000 | **none** | no sale; a test credit |
| 4 paid tickets (`68905e91`, `463bcf68`, `1ef3c6c5`, `05018f4c`) | +₦3,550 | ₦3,500 face | `05018f4c` is a ₦2,000 ticket credited ₦2,100 ("demo") |
| Service booking `3d3af0ad` (`BKG-65aefaef…`, paid 2026-09-25) | +₦300,000 | ₦300,000 subtotal | **verify it is a real LIVE payment** in Paystack |
| Pre-engine requests `4ee9fb31`, `a27e3434` (2026-07-03/09) | −₦200 | none paid | admin note says the amount was returned; no transfer code. The ledger debits stand without a matching return |
| Completed payouts `34e8a1cd` ₦400, `b0f222ba` ₦200 | −₦600 | ₦600 paid | linked, correct |
| **Swept payouts (§2a)** | **₦0** | **₦400 paid** | missing from the ledger and from `total_withdrawn` |

- **Paid out to banks in total: ₦1,000** (₦600 + ₦400).
- What the documented sources support holding: ₦313,550 − ₦1,000 = **₦312,550**.
- The wallet holds ₦300,800 + ₦44,100 = **₦344,900**.
- **Unexplained surplus: ₦32,350** (previously reported as ₦32,150, before the swept ₦400 and the returned ₦200 were known).

The counters agree with neither:
- `total_earned` ₦350,000 is ₦36,450 above every credit with a source;
- with the true ₦1,000 withdrawn, the counters imply ₦349,000 held, i.e. ₦4,100 more than the wallet.

The likely history is a direct balance + earned edit of about ₦36,450 with no ledger row, of which ₦4,100 later left the balance without a trace. That includes the swept ₦400 if it went back to available, case (b) in §2a. It cannot be proven without change history, which the database does not keep.

**What this means for the pending withdrawals.** The four live pending requests (₦44,100) are covered by the ₦312,550 the sources explain, so paying them does not pay out unexplained money. But they are only covered **if the ₦300,000 booking is real money**. If it is test money, the source-backed position is ₦12,550, and ₦44,100 of pending would be unbacked. **Check the booking's Paystack reference before authorizing any of the four.**

### `dfca505f`: the ₦1,000

**Resolved 2026-11-01 (read-only): the wallet is right; the ledger is wrong.**
- 20 paid tickets on this organizer's events, face value **₦36,400** = `total_earned` ₦36,400.
- Balance ₦35,800 = ₦36,400 − ₦600 withdrawn (two completed payouts with linked ledger rows), pending ₦0.
- The extra ₦1,000 is ledger credit `64e7e2e8`: 2026-07-12 12:13, "Ticket sale: Regular x1", no `ticket_sale_id`. **No ticket of any amount exists** between 11:00 and 13:30 that day, on any event.

So the "shortage" is a ledger over-statement. **No money is owed and the wallet should not change.** The correction is a single explanatory reversing ledger entry, made through D3. The rest of this subsection is the earlier analysis, kept for the record.

A single entry explains it: one ₦1,000 ledger credit whose wallet credit never happened. It matches the one "credit with no source".

Before 2026-09-27, a policy (`org_txns_admin_write`) let admins insert ledger rows directly. Its write grant was revoked by `revoke_broad_write_grants_wallet_and_audit_tables`, applied 2026-09-27. So the most likely origin is an admin or test insert before that date.

The decision is whether the organizer is owed ₦1,000:
- **owed** → credit the wallet;
- **spurious** → write an explicit reversing ledger entry.

Either way it must be an audited, two-person entry.

### Prepared queries (owner, read-only)

G1 and the equivalent of G2 were run read-only on 2026-10-31; their results are the source-row reconciliations above. G3 (both accounts) found no earnings-wallet adjustment; no admin action that adjusts an earnings wallet exists. Their entries are VENTS Cents, verification, featuring, payout completion and dual-control approvals. **`dfca505f` approved 17 dual-control actions (2026-07-23 to 2026-09-05), so it is a staff account.** Account for it in §3 when naming requesters and approvers.

```sql
-- G1: every ledger row of the two gap wallets, oldest first
SELECT id, type, amount_kobo, description, ticket_sale_id, withdrawal_request_id, metadata, created_at
FROM public.organizer_transactions
WHERE organizer_id IN ('91b0afb4-b5dc-4289-ae00-8e6e58c60f5f', 'dfca505f-b2f6-449f-aa86-f7e7ece7d1dc')
ORDER BY organizer_id, created_at;

-- G2: what the wallets should have earned from paid tickets (face, by fee model)
SELECT e.organizer_id, count(*) AS paid_tickets, sum(t.amount) AS face_naira
FROM public.tickets t JOIN public.events e ON e.id = t.event_id
WHERE e.organizer_id IN ('91b0afb4-b5dc-4289-ae00-8e6e58c60f5f', 'dfca505f-b2f6-449f-aa86-f7e7ece7d1dc')
  AND t.payment_status = 'paid'
GROUP BY 1;

-- G3: admin actions that touched these wallets
SELECT created_at, admin_id, action, details
FROM public.admin_logs
WHERE target_user_id IN ('91b0afb4-b5dc-4289-ae00-8e6e58c60f5f', 'dfca505f-b2f6-449f-aa86-f7e7ece7d1dc')
ORDER BY created_at;
```

**Decision path per gap:** read G1–G3 →
1. If every unledgered credit traces to a real sale or an approved credit, write **explanatory ledger entries only** (no wallet change).
2. If a credit has no legitimate source, **reduce the wallet**, with the organizer informed.
3. If money is owed, **increase the wallet**.

**Mechanism gap:** there is no audited wallet-adjustment function today. The correction needs a new dual-control action:
- an `earnings_adjustment` request by one admin, approved by a different super admin, neither of them the wallet owner;
- a new ledger type with a mandatory reason and evidence reference;
- verified by `admin_earnings_reconciliation()`.

That is a new money-moving capability. It is designed here only and needs owner approval before it is built (D3).

## 3. Two-admin eligibility and authorization checklist

Production rules (live code, md5-verified 2026-10-30, unchanged by 0201–0203):
- `is_admin()` = root (`c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832`) **or** `users.role` ∈ {`admin`, `sub-admin`};
- `is_super_admin()` = root **or** `users.role = 'admin'`.

After 0203, for each withdrawal:

| Role | Who qualifies | Must not be |
|---|---|---|
| Requester (`request_admin_action('authorize_withdrawal')`) | any admin (root, `admin`, `sub-admin`) | the withdrawal's owner |
| Approver (`approve_admin_action`) | a **super admin** (root or `admin`) | the requester; the withdrawal's owner |
| Claim and pay (`admin_claim_payout_for_processing`) | any admin | the withdrawal's owner |

Staff on record (2026-10-28 read-only): **1 active `admin`, 1 active `sub-admin`**, plus root. Whether root's own row is that `admin` is not recorded.

| Case | Super admins | Can `91b0afb4`'s 4 requests be paid? | Can root's own ₦5,000 (`e7ca4751`) be paid? |
|---|---|---|---|
| A: root **is** the one `admin` | root only | Yes: sub-admin requests, root approves (if `91b0afb4` is neither) | **No.** The only super admin is the owner of the request; a second super admin is needed |
| B: root is not the `admin`; a separate `admin` exists | root + that admin | Yes | Yes: the other admin approves; requester is the sub-admin or the other admin |
| Either, if `91b0afb4` **is** the sub-admin or the `admin` | — | Only with someone else as requester and a different super admin as approver; in case A, **impossible** | as above |

Checklist (owner):
1. **(owner, read-only)** Run `SELECT id, role, status FROM public.users WHERE role IN ('admin','sub-admin') OR id IN ('c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832', '91b0afb4-b5dc-4289-ae00-8e6e58c60f5f');`. Identify case A or B and whether `91b0afb4` is staff.
2. Name the requester and approver for each pending request, per the table.
3. Each named admin can sign in, has email verified, and sees Admin → Payouts → Authorize (PR #82 frontend, after the window).
4. If case A: decide D5 (a second super admin, or root rejects its own request).
5. Both admins know the reviewed amount must equal the request exactly, and that a bank-account change after approval means authorizing again.

## 4. Register of the five pending withdrawals

Evidence: per-request capture, 2026-10-30 11:41 UTC. Totals match the
recorded ₦49,100.

| # | Request | Owner | Amount | Created (UTC) | Transfer code / reference | History | Recommendation |
|---|---|---|---|---|---|---|---|
| 1 | `42fda9ea` | `91b0afb4` | ₦100 | 2026-09-02 21:27:10 | none | requested 2 min after a ₦400 payout (`34e8a1cd`) completed | Confirm with the organizer; probably a test. Reject (one admin, no money leaves) or authorize after the window |
| 2 | `6348714b` | `91b0afb4` | ₦4,000 | 2026-09-16 02:01:48 | none | — | Confirm the bank account (6 weeks old), then authorize after the window |
| 3 | `1abe8e53` | `91b0afb4` | ₦20,000 | 2026-09-24 02:34:48 | none | **identical pair with #4, 10 s apart** | Ask the organizer whether they meant ₦20,000 or ₦40,000 |
| 4 | `a0e389c9` | `91b0afb4` | ₦20,000 | 2026-09-24 02:34:58 | none | **identical pair with #3** | If a double-tap, **reject #4** before the window (one admin; ₦20,000 returns to their balance) |
| 5 | `e7ca4751` | `c9eb5eb6` (**root admin's own**) | ₦5,000 | 2026-10-23 17:35:28 | none | claimed for processing, then released (no transfer was created) | Needs a super admin other than root (section 3). Case A: decide D5 |

Notes:
- **The duplicate is not a double payment of the same money.** Each request moved ₦20,000 from balance to pending (₦44,100 pending = #1–#4), so paying both pays the organizer ₦40,000 of their own balance. The question is only intent.
- **#1–#4 come from the wallet with the ₦32,150 gap.** All four (₦44,100) are within the ledger-explained ₦312,750, so they can be paid without touching unexplained money (section 2).
- **Do not pay any request on today's engine.** 0202 fixes its double-payout risk; pay only after the window, with two-admin authorization.
- **(owner, read-only)** Before authorizing: `SELECT id, status, bank_account_id, (SELECT is_active FROM public.organizer_bank_accounts b WHERE b.id = r.bank_account_id) AS bank_active FROM public.organizer_withdrawal_requests r WHERE status = 'pending';`. Expect the 5 rows above, each with an active bank account.

## 5. Supabase GitHub integration: owner verification

Why it matters: merging PR #82 must not apply migrations by itself. Findings from the repository (no access to the dashboard):
- no CI workflows (`.github/workflows` absent);
- no `supabase/config.toml`;
- the Vercel build is `vite build`.

**Nothing in the repository applies migrations.** A dashboard-level integration could, and only the owner can see it.

Steps (owner, read-only):
1. **Supabase dashboard**, project `slrtjxtzhowhwhebjprv` → Project Settings → **Integrations** → GitHub.
   - Is a repository connected (expected: none, or `DERO2026/vents-app` with automatic deployment **off**)?
   - Record: connected repo, production branch, the "deploy to production" / automatic migration setting, the Supabase directory path.
2. **Branching** (same area, if shown): preview branches off, or confirm they cannot target the production database.
3. **GitHub**: `DERO2026` organization → Settings → **GitHub Apps** (installed apps). Is a Supabase app installed with access to `vents-app`? Record its permissions.
4. **Vercel** project `vents` → Integrations. A Supabase–Vercel integration syncs environment variables only; record whether one is installed.
5. If any automatic migration path is on: **turn it off before the window** (A6). Merging PR #82 would otherwise run migrations in filename order.
   - Its likely behaviour is to fail at once, because production's history uses apply timestamps the repository does not have. That is unverified; do not rely on it.

Record the answers in the runbook's A6 row before approving the window.

## 6. Backup and restore verification requirements

| # | Requirement | How it is verified | Who |
|---|---|---|---|
| B1 | Know the recovery options on the current Supabase plan: daily backups and retention; point-in-time recovery (PITR) available or not | Dashboard → Database → Backups: plan, last backup time (must be within 24 h), PITR on/off | Owner |
| B2 | A backup taken **in the window** (W2), after the pause and before 0201 | Dashboard backup entry or PITR timestamp recorded in the runbook; plus a logical dump (`supabase db dump` / `pg_dump -Fc`) of the public schema and data | Owner |
| B3 | The dump is **restorable** | `scripts/ops/verify-backup-restore.sh <dump>` on the owner's machine: restores into a throwaway **local** database only (refuses if a hosted URL is in the environment), prints money-table counts, and checks all 19 pre-apply functions (must be 19/19). Self-tested by `run-backup-restore-selftest.sh` | Owner |
| B4 | Counts match production at backup time | Compare B3's counts with P4 / a count query run in the window | Owner |
| B5 | The P2 function capture is stored outside the database, next to the dump | File listing | Owner |
| B6 | The dump holds personal data | Store encrypted, outside the repository, access limited to the owner; delete after the agreed retention | Owner |
| B7 | Recovery objectives agreed | RPO: last backup (daily) or seconds (PITR). RTO: the restore time shown by the B3 drill. Accepted by the owner before the window | Owner |
| B8 | Restoring is understood to lose everything after the backup | Runbook R4: reconcile every purchase, payout and booking after that point against the Paystack dashboard | Owner |

## 7. Outstanding decisions (owner)

| # | Decision | Needed before | Options |
|---|---|---|---|
| D1 | Apply 0201 → 0202 → 0203 and merge PR #82 in one window (runbook A1–A3) | the window | approve / defer |
| D2 | `91b0afb4`: ₦32,350 held with no source (§2, rebuilt from rows). `dfca505f`: the wallet is right and ledger credit `64e7e2e8` (₦1,000) has no ticket | paying wallet `91b0afb4` beyond ₦312,550; closing PAY-5 | `91b0afb4`: reduce the balance / keep it with explanatory entries (it is the owner's test account) / other. `dfca505f`: reversing ledger entry only (recommended by the evidence) |
| D3 | Build the dual-control `earnings_adjustment` action (section 2) | any correction in D2 | approve the design / another mechanism |
| D4 | The identical ₦20,000 pair: one intended or both | the window (a rejection can happen before it) | reject #4 / keep both |
| D5 | Root's own ₦5,000 (`e7ca4751`) in case A | paying it | appoint a second super admin / root rejects its own request (no money leaves) / leave pending |
| D6 | Name the requester and approver for each withdrawal (section 3) | after the window | — |
| D7 | Supabase GitHub integration settings (section 5) | merging PR #82 | confirm off |
| D8 | Backup plan and drill (section 6) | the window | — |
| D9 | ~~The 4 cancelled ₦100 test transfers: paid or not~~ | — | **Answered by the owner: all four paid** (₦400 + ₦40 fees). See §2a |
| D10 | Record the four paid transfers: a ₦400 `payout` debit and ₦400 `total_withdrawn` for `91b0afb4`. Also choose whether the balance drops by ₦400 (case (b) in §2a) | closing §2a; needs D3 | (a) books only / (b) books + balance |
| D11 | Apply 0205 in the same window as 0202 (runbook W6a) | the window. **Blocker:** 0202 without 0205 can charge the organizer again on a replayed success | approve (recommended) / defer 0202 too |
| D12 | Is the ₦300,000 service booking `3d3af0ad` (`BKG-65aefaefda314d09adc522065dcc3c09`) a real LIVE payment? | authorizing any of `91b0afb4`'s four pending requests (₦44,100) | real / test |
| D13 | The ₦40 Paystack fees of the swept transfers | closing §2a | record as a platform expense / other |

## 8. What changed in the repository (Batch D)

2026-11-01 update (branch `claude/payout-incident-batch-d`):
- `supabase/migrations/0205_payout_cancelled_transfer_safety.sql` (new, **not applied**).
- `api/webhook/paystack.ts`: `needs_review` handling; transfer events fall back from the transfer code to the reference.
- `scripts/local-pg-test/run-payout-cancelled-transfer-verification.sh` (new, 47 checks).
- `api/_lib/payoutCancelledTransferIncident.security.test.ts` (new, 13 tests); `api/_lib/payoutEngine.security.test.ts` (one assertion follows the new lookup).
- `src/app/components/admin/AdminPayoutsScreen.doubleSubmit.test.tsx`: the Supabase mock's `.in()` returns a chainable query. Its 3 unhandled rejections came from the 0203 disputes list calling `.in().order().limit()` on a mock whose `.in()` returned a bare Promise. That made every full `vitest run` exit 1. Test-only; the screen's code is unchanged.
- `docs/deploy-runbook-0201-0203.md`: step W6a.
- This document: §2a, the §2 rebuild from source rows, D2 and D9–D13.

Earlier Batch D changes:

- `supabase/rollback/sources/complete_organizer_payout.prod-2026-10-30.sql`: production's captured definition.
- `scripts/local-pg-test/generators/gen_rollback_snapshot.py`: all 19 functions with sources; `supabase/rollback/pre_0201_0203_functions.sql` regenerated.
- `scripts/local-pg-test/run-rollback-snapshot-verification.sh`: checks 19.
- `scripts/ops/verify-backup-restore.sh` (new): the restore drill.
- `scripts/local-pg-test/run-backup-restore-selftest.sh` (new): its 4-check self-test.
- `scripts/local-pg-test/run-earnings-policy-verification.sh`: the duplicate-pair fixture now carries the real dates (2026-09-24).
- This document; the runbook and the master tracker updated.
