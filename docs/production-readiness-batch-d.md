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

**Key bound:** the 4 pending requests total ₦44,100, well inside the ₦312,750 the ledger *does* explain. Paying them cannot pay out unexplained money. The risk sits in the last ₦32,150 of balance, which no pending request touches.

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
| D2 | `91b0afb4` ₦32,150 and `dfca505f` ₦1,000: G1–G3 have been read (section 9.7); decide per gap (explanatory entries / reduce / increase) | paying wallet `91b0afb4` beyond ₦312,750; closing PAY-5 | `dfca505f`: source exact, decide owed or spurious. `91b0afb4`: ₦36,450 and ₦4,300 still need evidence (section 9.7) |
| D3 | Build the dual-control `earnings_adjustment` action (section 2) | any correction in D2 | approve the design / another mechanism |
| D4 | The identical ₦20,000 pair: one intended or both | the window (a rejection can happen before it) | reject #4 / keep both |
| D5 | Root's own ₦5,000 (`e7ca4751`) in case A | paying it | appoint a second super admin / root rejects its own request (no money leaves) / leave pending |
| D6 | Name the requester and approver for each withdrawal (section 3) | after the window | — |
| D7 | Supabase GitHub integration settings (section 5) | merging PR #82 | confirm off |
| D8 | Backup plan and drill (section 6) | the window | — |
| D9 | ~~The 4 cancelled ₦100 transfers: paid or not~~ | — | **Answered 2026-10-31: all four paid** (owner, Paystack LIVE). Their resolution is D10 |
| D10 | How the four paid-but-cancelled ₦100 transfers are recorded (section 9.5) | closing PAY-6; after the window | (a) a new dual-control "late-recorded payout" action that writes a linked, clearly dated-today payout row and records the Paystack evidence; (b) evidence recorded on the exception only, no ledger row, ₦400 + ₦40 written off as a test expense; (c) as (a) plus recovering ₦400 from the organizer's balance, only if it is shown to still be there |
| D11 | Is the Paystack LIVE webhook URL set to `https://<production domain>/api/webhook/paystack`, with transfer events delivered? (section 9.6) | clearing `disable_payouts` (W9) | confirm / fix |
| D12 | Where the four requests' ₦400 went when it left `pending_kobo` (deleted, or moved to `balance_kobo`) | D10 option (c); closing D2 | backup or the person who made the write |
| D13 | Whether the account behind `91b0afb4` (recipient "Daniel Uwem Edemidiong", OPay) is an internal/test account | D2, D10 | owner confirms |

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

All four were paid to the same recipient: Daniel Uwem Edemidiong, OPay. Organizer wallet `91b0afb4` (username `testerboy`).

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
