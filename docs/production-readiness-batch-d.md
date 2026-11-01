# Batch D: production readiness and approval preparation

2026-10-31, PR #82. **Prepared only. Nothing in production was changed:**
- no SQL writes;
- no migrations;
- no money moved;
- no withdrawals approved, rejected or cancelled;
- no Paystack transfers or reversals;
- no authorizations, pauses or settings.

**Disclosure.** In the continuation (section 9), **read-only `SELECT`
queries** were run against production through the Supabase connector. They
covered G1–G3 and lookups of the related withdrawal, ledger, ticket,
admin-log and migration-history rows. Nothing was written. The owner
separately verified the four transfers in the Paystack LIVE dashboard.

Production facts below are labelled with their capture time. Queries marked
**(owner, read-only)** are prepared for the owner.

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

## 2. Wallet reconciliation gaps

Evidence: per-wallet reconciliation captured 2026-10-30 11:42 UTC (all 5 earnings wallets).

| Wallet (user id prefix) | balance + pending | Ledger credits − debits | Gap | Earned counter vs ledger credits | Other signals |
|---|---|---|---|---|---|
| `91b0afb4` | ₦300,800 + ₦44,100 = **₦344,900** | ₦313,550 − ₦800 = **₦312,750** | wallet holds **₦32,150 more** than the ledger explains | earned ₦350,000 vs ledger credits ₦313,550 (₦36,450 credited with no ledger row) | 2 payout rows not linked to a request (₦200); 1 credit with no source |
| `dfca505f` | ₦35,800 + ₦0 = **₦35,800** | ₦37,400 − ₦600 = **₦36,800** | ledger shows **₦1,000 more** than the wallet holds | earned ₦36,400 vs ledger credits ₦37,400 (one ₦1,000 ledger credit never reached the wallet) | 1 credit with no source |
| `7af13434`, `c9eb5eb6`, `d7899317` | — | — | reconcile | — | `d7899317` has 2 credits with no source but reconciles |

### `91b0afb4`: the ₦32,150, decomposed exactly

wallet − ledger = (earned − withdrawn − X) − (credits − debits), where X is
balance that left the wallet without moving the earned/withdrawn counters:

| Component | Amount | Meaning |
|---|---|---|
| Earned but never written to the ledger | **+₦36,450** | earned ₦350,000 − ledger credits ₦313,550 |
| Ledger payouts with no withdrawn-counter effect | **+₦200** | ledger debits ₦800 − withdrawn ₦600: the two "orphaned pre-payout-engine" ₦100 requests (`4ee9fb31`, `a27e3434`, now `failed`) have payout rows but no request link |
| Balance that left without a counter | **−₦4,500** | (earned − withdrawn) ₦349,400 − (balance + pending) ₦344,900. Of this, ₦200 is the two pre-July-9 debits above; **₦4,300 is unexplained** (section 9.7) |
| **Gap** | **₦32,150** | 36,450 + 200 − 4,500 |

What this does and does not say:
- **Most of it is unledgered earnings.** It is likely credits made before every wallet credit wrote a ledger row, or credits written directly to the wallet. The evidence shows the totals, not the rows.
- **₦4,500 left the balance without any counter or ledger row.** Candidates are direct wallet edits or a refund path that skipped the ledger. It is unexplained until the rows are read.
- **The 4 cancelled ₦100 payouts** (`3aa0f8ff`, `f9fda363`, `6ad1272d`, `56b084bb`) **were paid by Paystack** (owner, Paystack LIVE, 2026-10-31). The cancel that hit them was status-only and returned nothing to the balance (section 9). They are **a separate item, not an explanation of this gap** (section 9.4).
- **This wallet owns 4 of the 5 pending withdrawals** (section 4).

**Key bound (weakened, see section 10.9):** the 4 pending requests total ₦44,100, well inside the ₦312,750 the ledger *does* explain. But ₦310,000 of that is one ₦300,000 booking credit (service not completed) and a ₦10,000 test credit. Paying them cannot pay out unexplained money. The risk sits in the last ₦32,150 of balance, which no pending request touches.

### `dfca505f`: the ₦1,000

A single entry explains it: one ₦1,000 ledger credit whose wallet credit never happened. It matches the one "credit with no source".

Before 2026-09-27, a policy (`org_txns_admin_write`) let admins insert ledger rows directly. Its write grant was revoked by `revoke_broad_write_grants_wallet_and_audit_tables`, applied 2026-09-27. So the most likely origin is an admin or test insert before that date.

The decision is whether the organizer is owed ₦1,000:
- **owed** → credit the wallet;
- **spurious** → write an explicit reversing ledger entry.

Either way it must be an audited, two-person entry.

### Prepared queries (owner, read-only; not run)

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
| 3 | `1abe8e53` | `91b0afb4` | ₦20,000 | 2026-09-24 02:34:48 | none | **identical pair with #4, 10 s apart** | **D4 decided: intended (₦40,000 total), keep.** Bank account inactive: D4a (section 10.1) |
| 4 | `a0e389c9` | `91b0afb4` | ₦20,000 | 2026-09-24 02:34:58 | none | **identical pair with #3** | **D4 decided: intended, keep; do not reject.** Bank account inactive: D4a |
| 5 | `e7ca4751` | `c9eb5eb6` (**root admin's own**) | ₦5,000 | 2026-10-23 17:34:48 (claimed and released 17:35:15 and 17:35:27: "balance is not enough" at Paystack) | none | claimed for processing, then released (no transfer was created) | **D5 decided: reject later through an authorized process.** Case A confirmed: see D5a (section 10.2) |

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
| D1 | Apply 0201 → 0202 → 0203 and merge PR #82 in one window (runbook A1–A3) | the window | **Open** — approve / defer |
| D2 | Correct the two wallet gaps (section 10.9) | paying wallet `91b0afb4`; closing PAY-5 | **Open.** `dfca505f` ₦1,000 and `91b0afb4` ₦200: sources exact, ledger-only corrections ready to file once D3 is built. `91b0afb4` ₦36,450 and ₦4,500: still unattributed |
| D3 | Build the dual-control `earnings_adjustment` action | any correction in D2, D10 | **Design final (section 10.4); build needs owner approval** |
| D4 | The two ₦20,000 requests | — | **Decided 2026-11-01 (owner): both intended, ₦40,000 total, keep both; normal verification and two-admin approval.** New blocker found: their bank account is deactivated (section 10.1, D4a) |
| D4a | How the four `91b0afb4` requests reach an active bank account (all four point at deactivated accounts) | paying any of them | **Open** — see section 10.1 |
| D5 | Root's own ₦5,000 (`e7ca4751`) | — | **Decided 2026-11-01 (owner): to be cancelled/rejected later through an authorized process; not now; no bypass of two-admin approval.** How (D5a): section 10.2 |
| D5a | Who performs that rejection: today only root can (single super admin), which is a self-action | executing D5 | **Open** — a second super admin, or a written owner exception (section 10.2) |
| D6 | Requester and approver for each withdrawal | after the window | **Requirements complete (section 10.3).** Owner names the people; one role change is advisable (second super admin), not made |
| D7 | Supabase GitHub integration cannot apply migrations on merge | merging PR #82 | **Open, blocker.** Branching is enabled on the production project; whether "Deploy to production" is on cannot be read from here (section 10.5) |
| D8 | Backup and restore | the window | **Open, blocker.** The organization is on the **Free plan: no daily backups, no PITR** (section 10.6) |
| D9 | ~~The 4 cancelled ₦100 transfers: paid or not~~ | — | **Answered 2026-10-31: all four paid** |
| D10 | Recording the four paid-but-cancelled transfers | closing PAY-6 | **Process designed (section 10.7)**; option choice and an independent approver still owner's |
| D11 | Paystack LIVE webhook | W9 | **Delivery evidenced (section 10.8)**; the exact URL still needs one dashboard look |
| D12 | Where the ₦400 left `pending_kobo` | D10 (c), D2 | **Investigated; not attributable from available records** (section 10.9) |
| D13 | Is `91b0afb4` an internal QA/test account? | D2, D10 | **Strong evidence yes (section 10.10)**, but it holds a ₦300,000 real-payment credit and third-party bank accounts: owner confirmation required |

## 8. What changed in the repository (Batch D)

- `supabase/rollback/sources/complete_organizer_payout.prod-2026-10-30.sql`: production's captured definition.
- `scripts/local-pg-test/generators/gen_rollback_snapshot.py`: all 19 functions with sources; `supabase/rollback/pre_0201_0203_functions.sql` regenerated.
- `scripts/local-pg-test/run-rollback-snapshot-verification.sh`: checks 19.
- `scripts/ops/verify-backup-restore.sh` (new): the restore drill.
- `scripts/local-pg-test/run-backup-restore-selftest.sh` (new): its 4-check self-test.
- `scripts/local-pg-test/run-earnings-policy-verification.sh`: the duplicate-pair fixture now carries the real dates (2026-09-24).
- This document; the runbook and the master tracker updated.

Continuation (section 9): see 9.8.

## 9. Continuation (2026-10-31): the four paid-but-cancelled transfers, and the gaps

**Status: Batch D is NOT complete.** Two financial discrepancies remain
unexplained in part (9.7), and decisions D2–D8 and D10–D13 are open.

### 9.1 Confirmed facts

| Request | Paystack reference | Initiated (UTC, from the reference's ms timestamp) | VENTS status | Paystack LIVE | Ledger rows |
|---|---|---|---|---|---|
| `3aa0f8ff-d652-48cb-a06f-82a99d434dbe` | `payout_3aa0f8ff-…_1783681361539` | 2026-07-10 11:02:41 | `cancelled` | success, ₦100, fee ₦10 | 0 |
| `f9fda363-8e24-45af-8d2a-74dd7edb61aa` | `payout_f9fda363-…_1783681476919` | 2026-07-10 11:04:36 | `cancelled` | success, ₦100, fee ₦10 | 0 |
| `6ad1272d-14b8-41d9-8267-7ce8c0b3b4e8` | `payout_6ad1272d-…_1783681779407` | 2026-07-10 11:09:39 | `cancelled` | success, ₦100, fee ₦10 | 0 |
| `56b084bb-21df-4f23-9c90-02a5087f9642` | `payout_56b084bb-…_1783683296950` | 2026-07-10 11:34:56 | `cancelled` | success, ₦100, fee ₦10 | 0 |

All four were paid to the same recipient, an OPay account held by "D.U.E." (initials only: this repository is public). Organizer wallet `91b0afb4` (username `testerboy`).

### 9.2 Root cause, traced through the code (not inferred)

1. **Creation (2026-07-09 engine).** `request_organizer_payout` moves the amount from `balance_kobo` to `pending_kobo` and inserts a `pending` request. It writes no ledger row; the payout row is written at completion.
2. **Approval and initiation** (`api/wallet/admin-payout-action.ts` as on `main` today):
   - `admin_claim_payout_for_processing` flips `pending` → `processing`;
   - `POST /transfer` with reference `payout_<id>_<Date.now()>`;
   - `admin_mark_payout_processing` stores the reference and `transfer_code`.

   For all four this step succeeded: each has a code and reference, and was `processing`.
3. **Completion never ran.**
   - The only completion paths are the `transfer.success` webhook (`api/webhook/paystack.ts` → `complete_organizer_payout`) and the reconcile fallback (`api/wallet/reconcile-payouts.ts`, added 2026-07-10 15:13 in a7ca54e because the Paystack webhook URL was likely not configured).
   - Neither completed these four. Had a webhook been processed on 07-10/11, the request would be `completed` with a payout row; neither exists.
4. **The cancel (2026-07-12 23:41 UTC).** Migration `20260713100000_admin-stats-and-payout-cleanup.sql` (commit 8b9783e) ran:

   ```sql
   UPDATE organizer_withdrawal_requests SET status = 'cancelled' …
   WHERE username = 'testerboy' AND status IN ('pending', 'processing')
   ```

   It has no Paystack check, no wallet change, no ledger row and no admin log. Its comment says it "mirrors admin_cancel_processing_payout". It does not: that function returns the money to the balance, while this one returned nothing. The ₦400 stayed in `pending_kobo`.
5. **Why it stayed wrong.**
   - Production's `complete_organizer_payout` (md5 `563304a9…`) runs `UPDATE … WHERE status IN ('pending','processing')`. For a cancelled request that matches 0 rows and returns `already_completed`, so a late `transfer.success` is silently swallowed: no ledger row, no withdrawn counter, no alert.
   - Reconcile only lists `processing` requests, so it never looked at them again.
6. **Later.** The ₦400 left `pending_kobo` through a write the records do not show. Today pending is ₦44,100, exactly requests #1–#4 of section 4. Direct wallet writes were possible until 0110 (2026-09-27) via `organizer_wallets_admin_write` + `GRANT UPDATE`.

**The checks the investigation asked for:**

| Question | Finding |
|---|---|
| Timeout or retry treated a success as failed? | **Not in these four:** each reached `processing` with its code recorded. **The risk is real on production code today, though.** On a non-OK or unreadable `/transfer` response, `main` releases the claim to `pending`, and a retry builds a **new** reference (`Date.now()`), so a transfer Paystack actually accepted can be sent twice. 0202 fixes it: one fixed reference per request, and on an ambiguous response a lookup by reference before releasing |
| Cancelled after Paystack accepted? | **Yes**: 2 days later, by the sweep (step 4) |
| Webhook missed, ignored or mis-processed? | **Missed** on 07-10..12 (no completion exists). **Any delivery after the sweep would have been ignored** (step 5). Vercel logs from July are past retention, so which of the two cannot be shown |
| Duplicate transfers? | **None evidenced.** One reference per request, one Paystack success per reference. Owner check: list Paystack LIVE transfers to this recipient for 2026-07-09..13; expect exactly these four |
| Non-atomic or non-idempotent writes? | `complete_organizer_payout` / `fail_organizer_payout` are each atomic and idempotent on their own. The faults are around them: a raw status `UPDATE` bypassed them, and `main` ignores a failed `admin_mark_payout_processing` (a transfer could leave no code in VENTS) |
| Can funds return to the available wallet after Paystack paid? | **Yes, on production today.** Live `admin_cancel_processing_payout` cancels a `processing` request **even with a transfer code** and adds the amount back to `balance_kobo`, so the same money can be withdrawn twice. It did not happen to these four (the sweep returned nothing). 0202 refuses that cancel, and its new table trigger refuses any such status change |

### 9.3 The fix (0202, frontend, API)

| Requirement | How | Where |
|---|---|---|
| A paid transfer never stays silently `cancelled` | A late success on a cancelled request is resolved by evidence. If a `cancelled_payout_refund` row exists, the returned money is taken back from the balance (existing 0202 takeback). If the money is still in pending and not owed to another open request, it completes from pending. **Otherwise it moves no money**: it returns `needs_review`, writes a `payout_exceptions` row (`paid_after_cancel_unresolved`) and an admin log | `complete_organizer_payout` (0202) |
| Same money not withdrawable twice | Cancel/reject refused once a transfer code exists (0202 functions). **New `BEFORE UPDATE` trigger** `organizer_withdrawal_transfer_guard`: a request with a `transfer_code` cannot be set to `cancelled`/`rejected`/`pending`, and an existing `transfer_code` or `paystack_reference` cannot be changed or cleared, by **any** writer (it would have refused the 2026-07-12 sweep) | `organizer_withdrawal_transfer_guard()` (0202) |
| Idempotent webhook and API handling | `UNIQUE (request_id, kind)` on exceptions; completion is row-locked and status-gated; `ON CONFLICT DO NOTHING`; fixed reference per request | 0202 |
| Failed, pending, reversed and success handled distinctly | `fail_organizer_payout`, `reverse_organizer_payout` (reversed is final), `complete_organizer_payout`; a success on `failed`/`rejected` now also records `paid_after_final_state` | 0202 |
| Linked ledger rows, no duplicates | Payout rows carry `withdrawal_request_id`; at most one per request | 0202 (existing) |
| Audit history kept | Requests are never rewritten by the reconciliation; exceptions keep the lookup key, detection time and resolution fields | `payout_exceptions` |
| Late webhooks, and finding the four without one | `admin_list_payout_exceptions()` (admin-only, read-only) lists recorded exceptions **and** every cancelled/failed/rejected request with a transfer code but no payout row | 0202 |
| Ask Paystack, change nothing | `POST /api/wallet/reconcile-payouts` with `{mode:'exceptions'}` looks up each transfer code on Paystack. It reports `paid_not_recorded` / `not_paid_consistent` / `still_pending_on_paystack` / `paystack_lookup_failed` / `no_transfer_code`, and calls no money function | `api/wallet/reconcile-payouts.ts` |
| Admin can see it | Admin → Payouts → **Check payout exceptions** (report only; resolution needs two admins) | `src/app/components/admin/AdminPayoutsScreen.tsx` |

**Design flaw caught in 0202 while doing this.** The committed 0202 assumed every cancelled request had its money returned to the balance. It would have "taken back" ₦100 from the balance for each of the four, debiting money the cancel never returned. The new branch decides from the `cancelled_payout_refund` evidence instead.

### 9.4 The ₦400 + ₦40 item (separate from the ₦32,150)

| Item | Amount | Book |
|---|---|---|
| Four transfers paid to the organizer's OPay account, recorded in VENTS as cancelled, no ledger rows, `total_withdrawn_kobo` not increased | ₦400 | organizer wallet `91b0afb4` |
| Paystack transfer fees (₦10 × 4), charged to VENTS's Paystack balance; never recorded in VENTS | ₦40 | VENTS (platform expense) |
| **Total that left VENTS's Paystack balance** | **₦440** | |

This item does not explain the ₦32,150. The ₦400 left `pending_kobo` (step 6), but whether it was deleted or moved to `balance_kobo` is unknown (D12):
- **if deleted**, it is ₦400 of the ₦4,500 in 9.7, row 3;
- **if moved**, the balance holds ₦400 the organizer has already received.

### 9.5 Reconciliation plan for the four records (prepared; not executed)

Rules:
- the four production rows are **not edited** by hand or by a migration;
- no ledger row is back-dated or fabricated;
- every step is two-person.

1. **Evidence (owner, before the window).** For each transfer, export from Paystack LIVE: transfer code, reference, amount, fee, recipient, status and timestamps. Store it outside the repository with the backup (B6).
2. **After the window,** an admin runs Admin → Payouts → **Check payout exceptions**. Expect exactly four rows, kind `transfer_code_on_cancelled_request`, finding `paid_not_recorded`. Their codes must match step 1. Anything else: stop.
3. **Do not resend the webhooks** from the Paystack dashboard. After 0202 they would only return `needs_review` and add exception rows (safe, verified in the replay below), but they decide nothing.
4. **Decide D10 and D12.** Recording them needs a mechanism that **does not exist yet** and is not built here (it moves money). It would be a dual-control `resolve_payout_exception` action through `request_admin_action` → `approve_admin_action`: a different super admin approves, and neither admin owns the wallet. It would:
   - attach the step 1 evidence to the exception;
   - for D10 (a) or (c), write **one** payout row linked to the request, **dated at resolution** with `metadata.paid_at` = Paystack's date and `metadata.recorded_late = true`;
   - raise `total_withdrawn_kobo` by ₦400;
   - change the balance only for (c);
   - set `resolved_at`/`resolved_by`/`resolution`.

   The request stays `cancelled` (history preserved); the exception row carries the truth.
5. **Verify:**
   - `admin_list_payout_exceptions()` shows the four resolved;
   - `admin_earnings_reconciliation()` for `91b0afb4` moves by exactly the recorded amount;
   - VENTS's books carry the ₦40 fee expense.

### 9.6 Webhook delivery (D11)

The incident started because no completion signal arrived. Before W9, the owner confirms in the Paystack LIVE dashboard → Settings → API Keys & Webhooks that the webhook URL is the production `/api/webhook/paystack`. Then, after W9, one live transfer must reach `completed` through the webhook alone (no Reconcile).

### 9.7 The two wallet gaps (G1–G3 read, read-only)

> **Corrected in section 10.9.** The ₦200 pre-July-9 money was returned to the balance, so there is no −₦200 offset. The unexplained outflow is ₦4,500, not ₦4,300.

**Fee rule applied.** Before 0203, production's `confirm_ticket_payment` (md5 `56d67141…`) credits the organizer `v_credit_kobo` = the tickets' face value; the buyer fee is charged on top (`buyer_fee_kobo` in the ledger metadata). For these historical sales, face value **is** the organizer's earning. That is the live rule, not an assumption. 0203's 4%/5% split applies only to sales after it.

**`dfca505f` (₦1,000): source exact.**
- Ledger credit `64e7e2e8` (₦1,000, 2026-07-12) names a ticket that never existed. No wallet credit matches it.
- The legitimate credits total ₦36,400. That equals the paid-ticket face value (₦36,400, G2) and the earned counter.
- So the wallet is right and the ledger has one spurious ₦1,000 row, most likely an admin/test insert while `org_txns_admin_write` allowed it (before 2026-09-27).
- Decision D2: confirm spurious, then write a reversing, two-person ledger entry (needs D3).

**`91b0afb4` (₦32,150): decomposed; two parts unexplained.**

| Component | Amount | Status |
|---|---|---|
| Earned counter above ledger credits: no sale, booking, admin log or ledger row behind it | +₦36,450 | **Unexplained.** Consistent only with a direct wallet write. Possible: InsForge era, copied unchanged at the 2026-08-14/15 cutover, or a Supabase admin write before 2026-09-27 |
| Pre-July-9 payout rows (`4ee9fb31`, `a27e3434`), not linked to requests, with no withdrawn-counter effect | +₦200 | Explained (pre-July-9 engine wrote the payout row and debited the balance at request time) |
| Money that left balance + pending with no counter or ledger row: ₦4,500 in all | −₦200 | Explained: the same two pre-July-9 debits |
| (rest of the ₦4,500) | −₦4,300 | **Unexplained.** Up to ₦400 of it may be the 9.4 pending removal (D12) |
| **Gap** | **₦32,150** | 36,450 + 200 − 200 − 4,300 |

**Evidence still needed (no explanation is invented):**
1. the InsForge-era wallet history or backup from before the 2026-08-14 cutover;
2. any Supabase backup from before 2026-09-27, to diff `organizer_wallets` against;
3. the people with admin or SQL access to this wallet in July–September.

Without these, the ₦36,450 and ₦4,300 cannot be attributed. The section 2 bound still holds: the four pending requests (₦44,100) are inside the ledger-explained ₦312,750.

### 9.8 What changed in the repository (continuation)

| File | Change |
|---|---|
| `supabase/migrations/0202_payout_engine_safety.sql` | `complete_organizer_payout` evidence-based cancelled branch and exception recording. New: `payout_exceptions` table (RLS on, no client access), `organizer_withdrawal_transfer_guard()` + trigger, `admin_list_payout_exceptions()`. Drift-guard md5 of its own `complete_organizer_payout` → `f6ca5add…` |
| `supabase/migrations/0203_earnings_policies.sql` | pin for the new `complete_organizer_payout` md5 |
| `api/wallet/reconcile-payouts.ts` | `mode: 'exceptions'` (report-only) |
| `src/app/components/admin/AdminPayoutsScreen.tsx` | "Check payout exceptions" button and report |
| `scripts/local-pg-test/run-payout-incident-replay.sh` (new) | the incident on production's exact `complete_organizer_payout`, then after 0201–0203 (16 checks) |
| `scripts/local-pg-test/run-payout-engine-verification.sh` | incident section: guard refusals, pending-path completion, duplicate webhook, needs_review, permissions (72 checks) |
| `scripts/local-pg-test/run-earnings-policy-verification.sh` | legacy cancel writes its refund row; reconciliation scope (164 checks) |
| `scripts/local-pg-test/run-rollback-snapshot-verification.sh` | the restore keeps the exception table and guard (12 checks) |
| `api/_lib/reconcilePayoutExceptions.security.test.ts` (new) | 6 tests, including the four real ids/references |
| `src/app/components/admin/AdminPayoutsScreen.exceptions.test.tsx` (new) | render test |
| `src/app/components/admin/AdminPayoutsScreen.doubleSubmit.test.tsx` | mock fix (3 unhandled rejections in the full run) |

**Tests run:**
- 16/16 local Postgres suites pass;
- vitest: 320 files, 2,962 tests (the 7 new included), 0 failures, 0 unhandled errors;
- `tsc --noEmit`: clean;
- production `vite build`: OK.

Production was not touched.

## 10. Continuation (2026-11-01): owner decisions D4/D5, and D3, D6–D8, D10–D13

**Status: Batch D is still NOT complete.** Production was not changed.

**Evidence.** Production evidence in this section comes from read-only `SELECT`s (Supabase connector, 2026-11-01) and read-only project, branch and organization metadata calls. There were no writes, role changes, approvals or transfers.

**Privacy.** This repository is **public**. People are named here by role or initials only. The account numbers, emails and full names seen in the evidence are deliberately not reproduced. Commit `9eb3fa3` contained one recipient's full name in this file; this commit removes it. **It remains in git history (owner action O9).**

### 10.1 D4: both ₦20,000 requests intended (decided), plus a new blocker (D4a)

**Owner decision (2026-11-01, recorded verbatim in substance):**
- both ₦20,000 requests (`1abe8e53`, `a0e389c9`) were intentional, ₦40,000 in total;
- keep both; do not reject either as a duplicate;
- payment remains subject to normal verification and two-admin approval.

**Verification finding: none of `91b0afb4`'s four pending requests can be paid as they stand.**

| Request | Amount | Bank account on the request | Account state |
|---|---|---|---|
| `42fda9ea` | ₦100 | OPay, holder "D.U.E." (`dd3f9bc4`, created 2026-07-03) | **inactive** since 2026-09-24 02:33:57 |
| `6348714b` | ₦4,000 | same `dd3f9bc4` | **inactive** |
| `1abe8e53` | ₦20,000 | OPay, holder "C.J.N." (`dc040c7a`) | **inactive**; created 02:34:33, **15 s before** this request; deactivated 02:35:15, 17 s after the second |
| `a0e389c9` | ₦20,000 | same `dc040c7a` | **inactive** |

Why that blocks payment, in the code:
- **0203 `admin_claim_payout_for_processing`** pays only to an **active** account whose recipient equals the authorized one. Otherwise it raises "bank account changed … authorize it again".
- **Before this commit,** `execute_withdrawal_authorization` did not check `is_active`. Two admins could authorize such a request, and the claim would then refuse it forever.
- **Fixed in 0203 (this commit):** authorization now refuses an inactive account up front. A new test was added (earnings policy 166/166).
- **There is no function that changes the bank account on a pending request.** An organizer cannot cancel their own request either.

**D4a, owner decision needed** (the D4 intent is unchanged by every option):
1. **Organizer re-activates the same account.** Only if the product supports it; today the app soft-deletes and creates new rows. Then authorize with two admins.
2. **Build a dual-control "re-point withdrawal to a verified active account" action.** It changes the request's `bank_account_id` (new recipient verified), and needs requester + super-admin approver. Small, but new money-path code; design on request.
3. **Reject and re-request.** Contradicts "do not reject" as stated; only if the owner revises D4.

**Verification the owner must also do** (normal verification under D4):
- confirm with the organizer that "C.J.N." is the intended recipient of ₦40,000. It is a third-party name: not the user's display name, and not the other holder on this wallet;
- the account was created and deactivated within one minute around the two requests.

### 10.2 D5: root's ₦5,000 to be rejected later (decided), and how (D5a)

**Owner decision (2026-11-01):**
- `e7ca4751` (₦5,000, the root admin's own withdrawal) is to be cancelled/rejected later through an authorized process;
- it is not to be executed now;
- two-admin approval must not be bypassed.

**What the code allows** (production bodies, read 2026-11-01):
- `admin_reject_organizer_payout` is single-admin and requires `is_admin_or_root()` = `is_super_admin()` (root or `role = 'admin'`). It has no self-check, and 0202/0203 leave it unchanged.
- The only super admin is root (section 10.3), so today **only root can reject it**: root acting alone on its own request.
- There is **no dual-control reject**. Even if one were built, its approver must be a super admin who does not own the request, and none exists.

**D5a, owner decision needed:**
1. **(Recommended)** Appoint a second super admin (see section 10.3), who rejects `e7ca4751`. One admin, no money leaves VENTS: ₦5,000 returns to root's available balance. Optionally a sub-admin files the reason first, through `request_admin_action`, for the record.
2. A written owner exception allowing root's single-admin reject of its own request. No money leaves, but it is the self-action the rule exists to prevent.

**History, for the record.** Root has already paid itself once on pre-0203 code: `645682f5`, ₦100, 2026-10-17, claimed and approved by root. 0203 makes that impossible.

### 10.3 D6: requester and approver requirements (complete), and the role changes needed (not made)

**Staff today** (read-only 2026-11-01):

| Account | Role | Super admin? | Also owns a wallet with money? |
|---|---|---|---|
| root `c9eb5eb6` | `admin` (and root) | **yes, the only one** | yes: pending `e7ca4751` |
| sub-admin `a4402494` | `sub-admin` | no | not among the earnings wallets |
| sub-admin `dfca505f` (`ventsofficial`) | `sub-admin` | no | yes: the ₦1,000-gap wallet |

**This is case A of section 3.** After 0203:

| Withdrawal | Requester (any admin, not the owner) | Approver (super admin, not requester, not owner) | Claim and pay (any admin, not owner) | Possible today? |
|---|---|---|---|---|
| `91b0afb4` × 4 | `a4402494` or `dfca505f` | root | either sub-admin | **Yes, but blocked by D4a** (inactive accounts) |
| root `e7ca4751` | — | — | — | Rejection only (D5); see D5a |
| future `dfca505f` withdrawals | `a4402494` | root | `a4402494` | yes |
| future root withdrawals | a sub-admin | **nobody** | — | **No**, until a second super admin exists |

**Role change needed (owner decides who; not made here).**
- One person, other than the root account holder, given `role = 'admin'` (super admin).
- Without it:
  - root is the single approver of every withdrawal and adjustment;
  - D5 cannot be done two-person;
  - root's own future withdrawals can never be paid.
- No other change is required for the four `91b0afb4` requests.

**Separation-of-duties concern (owner to confirm; no conclusion drawn).** Two-admin control only works if the admins are different people acting independently. The evidence shows three overlaps:
- the payout bank accounts on the root, `a4402494` and `91b0afb4` records share one family name;
- the four incident transfers went to the same holder initials ("D.U.E.") as root's own payout account;
- if root approves `91b0afb4`'s withdrawals and `91b0afb4`'s money goes to an account of the root account holder, the approver is the beneficiary.

Owner confirmation: who operates each staff account and the `91b0afb4` account.

**Exact steps once the owner has named people:**
1. Each named admin signs in, with email verified.
2. The requester files Admin → Payouts → Authorize with the exact amount.
3. Root (or the new super admin) approves.
4. A different admin claims and pays.

### 10.4 D3: `earnings_adjustment`, final design (not built; needs owner approval)

**Purpose.** It is the only sanctioned way to correct a wallet or ledger. It replaces the direct writes that caused most of the gaps.

| Element | Design |
|---|---|
| Entry point | `request_admin_action('earnings_adjustment', target = organizer_id, payload)`, executed only by `approve_admin_action` (existing maker-checker; self-approval already blocked) |
| Payload (all required) | `kind` ∈ {`ledger_only`, `wallet_credit`, `wallet_debit`, `late_recorded_payout`}; `amount_kobo` > 0; `reason` (≥ 20 chars); `evidence_ref` (e.g. "Paystack TRF_…", "G1 row 64e7e2e8"); `expected_balance_kobo` and `expected_ledger_gap_kobo` as the requester saw them; for `late_recorded_payout` also `request_id`, `transfer_code`, `paid_at` |
| Who | Requester: any admin. Approver: a super admin. Neither may be the wallet owner, and they must differ. Same rule as `authorize_withdrawal` |
| Executor `execute_earnings_adjustment(admin_request_id)` | `SECURITY DEFINER`, not client-callable. Locks the wallet `FOR UPDATE`. **Refuses if the balance or ledger gap differs from the payload** (stale approval). Refuses a debit below 0 (no negative balances) and amounts above a cap (₦50,000 by default; larger needs an owner flag in `app_config`). Idempotent: unique on `admin_request_id` |
| Effects by kind | `ledger_only`: one ledger row (new types `adjustment_credit` / `adjustment_debit`) and **no wallet change**; this explains or corrects history. `wallet_credit` / `wallet_debit`: ledger row + equal balance change. `late_recorded_payout`: one `payout` row linked to `request_id` (metadata `recorded_late`, `paid_at`, `transfer_code`), `total_withdrawn_kobo += amount`, balance unchanged; marks the `payout_exceptions` row resolved; the request keeps its status |
| Audit | Every ledger row carries `metadata.admin_request_id`, `requested_by`, `approved_by`, `reason`, `evidence_ref`. Plus an `admin_logs` row |
| Reconciliation | `admin_earnings_reconciliation()` counts the new types. Each adjustment must move the wallet's `ledger_gap_kobo` by exactly its amount (checked by tests) |
| Not allowed | Editing or deleting existing ledger rows or withdrawal requests; any back-dated `created_at` |
| Delivery | A new migration (0205) after the window. Local tests: maker ≠ checker; owner excluded; stale-expectation refusal; idempotency; cap; each kind's effect on reconciliation; the three real cases below replayed |

**Real cases it would handle once approved** (none executed):

| Case | Kind | Amount | Effect |
|---|---|---|---|
| `dfca505f`: ledger credit `64e7e2e8` for a ticket that never existed | `ledger_only` debit | ₦1,000 | gap ₦1,000 → 0 |
| `91b0afb4`: payout rows `56bd6ede` / `328cb300` whose money was returned to the balance (section 10.9) | `ledger_only` credit | ₦200 | gap falls by ₦200 |
| The four paid-but-cancelled transfers (D10) | `late_recorded_payout` × 4 | ₦100 each | see 10.7 |

### 10.5 D7: Supabase GitHub integration (inspected; owner must confirm one setting)

| Evidence (2026-11-01) | Reading |
|---|---|
| `list_branches` on the production project returns a default branch `main` (created 2026-09-13 20:48 UTC, status `FUNCTIONS_DEPLOYED`, never updated since) | **Supabase Branching is enabled on the production project.** Branching works through the GitHub integration |
| No preview branches exist, although PRs #82/#83 touch `supabase/migrations`; PR #82's only check runs are Vercel and CodeRabbit; no Supabase comment | Automatic preview branching is off, or the repository is not connected |
| Production migration history: 0001–0013 under repository numbers, then apply-time timestamps (manual applies). Not one entry for repository files 0014–0200, though many merges to `main` happened after 2026-09-13 | No automatic deployment has applied repository migrations so far. A deploy that ran would have tried to apply 0014+ |
| Repository: no `.github/workflows`, no `supabase/config.toml` | Nothing in the repository applies migrations |
| Supabase docs: with **Deploy to production** enabled, a push or merge to the production branch applies new migrations from `supabase/migrations` | If that toggle is on and starts working, merging PR #82 could try to apply 0014–0203. Most of these are already in production under other version names, so the run would re-run old migrations, an unsafe outcome |

**Conclusion:** no evidence of automatic migration so far, but it **cannot be ruled out from here**. Branching being on makes it a real possibility. **Blocker until the owner confirms** (owner action O3).

### 10.6 D8: backups (inspected; blocker)

| Evidence | Reading |
|---|---|
| `get_organization`: plan **`free`** | Per Supabase docs, daily backups are for Pro, Team and Enterprise projects, and PITR is a paid add-on (it needs at least Small compute) |
| Vercel project on Hobby (runtime logs retained 1 hour) | No log history for incidents |

Consequences:
- **There is no managed backup or restore point today.**
- Runbook W2 ("take the backup / restore point") and R4 ("point-in-time restore to W2") **cannot be done on this plan** as written.
- The only backup is a **manual logical dump**.
- `scripts/ops/verify-backup-restore.sh` exists and its self-test passes (4/4). It has never been run on a real dump.
- Storage objects (images, verification documents) are not in database backups.

The runbook now requires one of the two O4 options (owner action O4).

### 10.7 D10: authorized reconciliation process for the four paid ₦100 transfers (designed)

Preconditions:
- 0201–0203 applied;
- D3 built and approved;
- the exceptions check (Admin → Payouts) lists exactly the four as `paid_not_recorded`, with transfer codes matching the owner's Paystack export.

| Step | Who | What |
|---|---|---|
| 1 | Owner | Export the four Paystack LIVE transfer records: code, reference, amount, fee, recipient, status, time. Store them outside the repository |
| 2 | Requester (sub-admin) | For each request, files `earnings_adjustment` `late_recorded_payout`, ₦100, with `request_id`, `transfer_code`, `paid_at`, and `evidence_ref` = the export |
| 3 | Approver | A super admin who is **not the recipient's account holder**. Today the only super admin is root, whose own payout account shares the holder initials, so this needs the second super admin (10.3) or a written owner exception |
| 4 | System | Per request: one linked `payout` row dated at resolution, `total_withdrawn_kobo += ₦100`, balance unchanged, exception resolved. The request stays `cancelled` |
| 5 | Both admins | `admin_earnings_reconciliation()`: `91b0afb4`'s ledger net falls by ₦400 |
| 6 | Owner | D12 outcome: if the ₦400 is shown to have been moved into `balance_kobo`, a separate `wallet_debit` ₦400 (two admins), because the organizer already received it. If it was deleted, nothing more. Unknown: leave it, and record why |
| 7 | Owner / accountant | Record **₦440** (₦400 + ₦40 fees) leaving VENTS's Paystack balance in VENTS's own books. VENTS has no platform-expense ledger in the database |

Option choice (D10 a/b/c in section 7) remains the owner's.

### 10.8 D11: Paystack webhook (delivery evidenced)

| Payout | Transfer initiated | Completed | Gap | By |
|---|---|---|---|---|
| `645682f5` (₦100) | 2026-10-17 09:32:11.10 | 09:32:12.53 | 1.4 s | `system:project_admin`, lookup = transfer code |
| `5065d5f1` (₦100) | 2026-10-27 17:56:32.48 | 17:56:34.00 | 1.5 s | same |

Reconcile is a manual admin action that polls Paystack. No admin clicked within 1.5 s of initiating, so these completions came from **signed `transfer.success` webhooks reaching production**. Delivery works as of 2026-10-27.

Not verified:
- the exact URL;
- whether `transfer.failed` / `transfer.reversed` are delivered (none have occurred);
- the test-mode URL.

No log evidence exists, because Vercel Hobby keeps 1 hour. Owner action O5.

### 10.9 Wallet gaps: corrected decomposition, D12, and what is still unexplained

**Correction to section 9.7.**
- The two "pre-July-9" requests `4ee9fb31` / `a27e3434` carry this admin note (2026-07-09 08:56:59): "funds were deducted from balance but never entered pending tracking … Amount returned to available balance".
- So their ₦200 went **back to the balance**. Their ₦200 of `payout` ledger rows (`56bd6ede`, `328cb300`) were never reversed, and no admin log exists for the write.
- So the +₦200 is **exactly explained** (a ledger-only correction, 10.4), and there is **no** matching −₦200.

The corrected decomposition:

| `91b0afb4` component | Amount | Status |
|---|---|---|
| Earned counter above ledger credits | +₦36,450 | **Unexplained** |
| Payout ledger rows for money that was returned | +₦200 | **Explained exactly** (direct write, 2026-07-09) |
| Balance + pending that left with no counter or ledger row | −₦4,500 | **Unexplained**; up to ₦400 of it may be D12 |
| **Gap** | **₦32,150** | 36,450 + 200 − 4,500 |

**What the ledger shows** (all credits, read-only):

| Credit | Amount | Note |
|---|---|---|
| "Admin test credit" (2026-06-22) | ₦10,000 | not a sale |
| 4 ticket-sale credits (2026-07-03..08-06; "Payment test", "Standard (demo)") | ₦3,550 | 25 paid tickets, ₦3,500 face; **21 of the 25 bought by the account itself** |
| "Service booking payment" (2026-09-25) | ₦300,000 | Booking `3d3af0ad`: ₦315,000 paid by Paystack (₦15,000 fee), customer username `dero`, status **`confirmed`, not completed**. Credited at payment under the pre-0203 rule |

Because of this, the section 2 "key bound" (pending ₦44,100 is inside the ledger-explained ₦312,750) is **weaker than it reads**:
- the explained funds are almost entirely one ₦300,000 booking and a ₦10,000 test credit;
- the booking was paid by a user named like the repository owner, and the service is not completed;
- under 0203 rules that money would not yet be withdrawable.

Owner check: is booking `3d3af0ad` (Paystack reference beginning `BKG-65aefaef`) a real charge, and a real service?

**₦36,450.**
- No sale, booking, admin log or ledger row is behind it.
- `credit_organizer_wallet` has written a ledger row in every version since 2026-06-22.
- So this is consistent only with a direct write to `organizer_wallets.total_earned_kobo` / `balance_kobo`. That was possible through the `organizer_wallets_admin_write` policy until 2026-09-27, or in the InsForge era, whose values were copied unchanged at the 2026-08-14/15 cutover.
- Its time and author **cannot be determined from available records**.

**₦4,500 and D12 (the ₦400).**
- After the 2026-07-12 23:41 sweep, the four cancelled requests' ₦400 sat in `pending_kobo`. Today pending (₦44,100) equals the open requests exactly.
- Every function in the repository's history that lowers `pending_kobo` either moves the amount to the balance or completes a request with a ledger row. The `GREATEST(0, …)` clamp can only absorb money, never remove it.
- No admin log touches this wallet's balances after 2026-07-12.
- **Whether the ₦400 was deleted or moved to the balance cannot be told from current totals.** Both are consistent.
- The only documented pattern is the same kind of direct write as 2026-07-09.

**Evidence that would settle it (owner):**
1. the InsForge export used for the 2026-08-14 cutover (wallet row for `91b0afb4`: `balance_kobo`, `pending_kobo`, `total_earned_kobo`, `total_withdrawn_kobo`). That shows whether the ₦400 and ₦36,450 predate the cutover;
2. any InsForge-era backups between 2026-06-22 and 2026-08-14;
3. the people who ran SQL against production wallets before 2026-09-27.

There is no Supabase backup to consult (Free plan, 10.6).

**`dfca505f` ₦1,000:** unchanged. The source is exact (ledger credit `64e7e2e8`, ticket never existed). Ready for a `ledger_only` correction once D3 exists.

### 10.10 D13: is `91b0afb4` (`testerboy`) an internal QA/test account?

Evidence that it is:
- display name "TB";
- 14 events, including "Test Payout" ×3, "Promote Flow Verification Event", "VENTS Reviewer Demo Event" and "Test for Apple";
- root credited it Vents Cents as a "Live test credit" (2026-06-17);
- ledger: "Admin test credit", "Payment test" and "(demo)" sales;
- 21 of its 25 paid tickets were bought by itself;
- migration `20260713100000` (commit 8b9783e) calls it "the 'testerboy' test organizer account … pre-launch testing";
- one of its bank accounts is in the company's own name ("VENTS LTD").

Against treating it as purely internal:
- it holds a ₦300,000 credit from a ₦315,000 Paystack-paid booking (10.9);
- its bank accounts include two third-party holders ("B.N.C.", "C.J.N.");
- the ₦40,000 pair is directed to "C.J.N.".

**Conclusion: strong evidence of an internal QA/test account operated by VENTS staff, but with real money and third-party payees attached. Owner must confirm** (O7):
- who operates it;
- whether the ₦315,000 booking was a real charge;
- who "B.N.C." and "C.J.N." are, and why test withdrawals go to them.

Until then, treat its withdrawals as real payouts needing full verification.

### 10.11 Review: 0202 payout fixes, 0203 checksum dependencies, rollback, tests

| Item | Result |
|---|---|
| 0202 payout fixes (late success after cancel, `payout_exceptions`, transfer guard, exceptions list) | Re-read against production's `complete_organizer_payout` (`563304a9…`); incident replay 16/16; payout engine 72/72 |
| 0203 pins | `complete_organizer_payout` pinned to 0202's own body `f6ca5add…`; the order and drift-guard suite passes 37/37. This commit changes only `execute_withdrawal_authorization`, a function 0203 itself creates, so no pin moves. `gen0203.py` regenerates the file identically |
| New fix | `execute_withdrawal_authorization` refuses an inactive bank account (10.1); +2 checks, earnings policy 166/166 |
| Rollback | `pre_0201_0203_functions.sql` restores the 19 replaced functions (12/12). It leaves 0202's exception table and trigger, and 0203's new functions, in place, which is safe. The trigger is compatible with the existing production trigger `trg_block_delete_live_organizer_withdrawal` (different event) |
| Existing production triggers on the payout tables | `trg_block_delete_live_organizer_withdrawal`, `trg_realtime_admin_stats_payout`, `trg_realtime_admin_stats_transaction`. None conflicts with 0202's `BEFORE UPDATE` guard |

### 10.12 PR #83: dependency, merge order, outstanding items

**Dependency.**
- PR #83 (`claude/bold-allen-bpxsd6`, Draft) is stacked on PR #82: its base is `claude/vents-work-earn` at `efdca0f`.
- It changes 34 files: UX, the representative search and migration **0204**. **None of them overlaps the files changed by `9eb3fa3` or this commit.**
- A local test merge onto `9eb3fa3` was **clean**; `tsc` passed.

**Outstanding on PR #83:**
1. **Merged vitest: 3036/3037, one failure, caused by #83.** `src/app/components/LocationPicker.maps.test.tsx:139` stubs the key with a fake value that begins with Google's 4-character API-key prefix, and `googleMapsKeyNeverCommitted.security.test.ts` rejects any tracked string with that prefix. It is not a real key. **Fix in #83:** use a fake value without that prefix (e.g. `'test-places-key'`).
2. Its "3 unhandled rejections in `AdminPayoutsScreen.doubleSubmit.test.tsx`" note is out of date: `9eb3fa3` fixed them on #82.
3. **0204** depends only on objects already in production (`recruiters`, `check_rate_limit`, `recruiter_target_is_organizer` from 0196, `service_providers`). It is **not** in this window's runbook and must be applied separately, after the window.
4. If `search_recruiter_invite_targets` is meant to work on the read-only Preview, it must be added to the Preview RPC allowlist.
5. No review threads; no CodeRabbit review (Draft).
6. Its own local suite (`run-recruiter-search-verification.sh`, 23/23 claimed) could not be re-run here: the sandbox's `postgres` user cannot read a scratch worktree.

**PR #82:**
- all 10 review threads resolved;
- the CodeRabbit overview on the PR still lists 4 findings from `51d5b55`; their threads are resolved.

**Correct merge order:**
1. PR #82 → `main`, in the approved window, together with 0201 → 0202 → 0203. The window does not include #83.
2. Then retarget PR #83 to `main` (GitHub does this automatically if `claude/vents-work-earn` is deleted on merge; otherwise change its base by hand), fix item 1, and re-run CI.
3. Merge #83.
4. Apply 0204 in its own transaction.

**Do not merge #83 into #82's branch first.** That would put 0204 and unrelated UX changes into the money-critical window.

### 10.13 Owner actions (physical steps; none was done by Claude)

| # | Where | Exact action | Closes |
|---|---|---|---|
| O1 | Admin console / user records | Decide who becomes the second super admin (`role = 'admin'`): a person other than the root account holder. Then make the change through the normal audited role-change flow | D5a, D6, D10 step 3 |
| O2 | Organizer of `91b0afb4` | Confirm "C.J.N." is the intended recipient of the ₦40,000, and the "D.U.E." account for the ₦4,100. Choose a D4a path | D4a |
| O3 | Supabase dashboard → project VENTS → Project Settings → **Integrations** → GitHub Integration | Record: connected repository, production branch, "Deploy to production", "Automatic branching", working directory. **Set "Deploy to production" off and "Automatic branching" off** (or disconnect) before any merge to `main`. Then Branches: confirm only `main`. Then GitHub → `DERO2026/vents-app` → Settings → GitHub Apps: record whether "Supabase" is installed and its permissions | D7 |
| O4 | Supabase dashboard → Organization → Billing | Either (a) upgrade to **Pro** before the window, wait for the first daily backup (Database → Backups), optionally add PITR (needs Small compute); or (b) stay on Free and, in W2, take `supabase db dump` (schema + data) or `pg_dump -Fc` from the Session pooler URL, run `scripts/ops/verify-backup-restore.sh <dump>` locally (must print 19/19), and store the dump encrypted outside the repository. Also export the Storage buckets you cannot lose | D8 |
| O5 | Paystack dashboard (LIVE) → Settings → API Keys & Webhooks | Record the Live Webhook URL. Expect `https://<production domain>/api/webhook/paystack`. Paste it into the runbook D11 row | D11 |
| O6 | Paystack dashboard (LIVE) → Transfers | Export the four 2026-07-10 transfers. List all transfers to the D.U.E. OPay recipient for 2026-07-09..13 (expect exactly four). Look up the transaction with reference starting `BKG-65aefaef` (₦315,000, 2026-09-25) and confirm it was a real charge | D10, D13, 10.9 |
| O7 | Owner knowledge | State who operates `testerboy`, `ventsofficial`, the second sub-admin and root, and who "B.N.C." and "C.J.N." are | D13, separation of duties |
| O8 | InsForge archive | Find the cutover export (2026-08-14) and any older backups. Read the `organizer_wallets` row for `91b0afb4` | ₦36,450, ₦4,500, D12 |
| O9 | GitHub | Commit `9eb3fa3` contains a payee's full name in this public repository. Decide whether to accept it, or rewrite history (needs care: open PRs) and ask GitHub support to purge cached views | privacy |
| O10 | Owner | Approve or reject building D3 (and the D4a "re-point" action if chosen) | D3, D2, D10 |

### 10.14 What changed in the repository (this continuation)

| File | Change |
|---|---|
| `supabase/migrations/0203_earnings_policies.sql`, `scripts/local-pg-test/generators/0203_template.sql` | `execute_withdrawal_authorization` refuses an inactive bank account |
| `scripts/local-pg-test/run-earnings-policy-verification.sh` | +2 checks (166) |
| This document, `docs/deploy-runbook-0201-0203.md`, `docs/LAUNCH_READINESS_MASTER.md` | D4/D5 recorded; D3/D6/D7/D8/D10–D13 findings; owner actions; the recipient's full name removed |

**Tests (2026-11-01):**
- 16/16 local Postgres suites pass (earnings policy 166, payout engine 72, incident replay 16, rollback snapshot 12, migration order 37, payout gate 27, backup-restore 4, 9 others);
- vitest: 2,962/2,962;
- `tsc --noEmit`: clean;
- production `vite build`: OK (12 API functions).
- Test merge with PR #83: clean, `tsc` passes, vitest 3,036/3,037. The one failure is #83's key-shaped test value (10.12).

An earlier full run here failed one test because this document quoted that key-shaped string. The text was reworded, and the test then passed.
