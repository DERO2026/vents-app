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
| D1 | Apply 0201 → 0202 → 0203 → 0205 → 0206 → 0207 and merge PR #82 in one window (runbook A1–A3); 0204 with PR #83 afterwards (W10) | the window | **Open** — approve / defer |
| D2 | Correct the two wallet gaps (section 10.9) | paying wallet `91b0afb4`; closing PAY-5 | **Open.** `dfca505f` ₦1,000 and `91b0afb4` ₦200: sources exact, ledger-only corrections ready to file once D3 is built. `91b0afb4` ₦36,450 and ₦4,500: still unattributed |
| D3 | Build the dual-control `earnings_adjustment` action | any correction in D2, D10 | **Built as 0206 (T2, 2026-11-02, at the owner's instruction); not applied** (§13) |
| D4 | The two ₦20,000 requests | — | **Decided 2026-11-01 (owner): both intended, ₦40,000 total, keep both; normal verification and two-admin approval.** New blocker found: their bank account is deactivated (section 10.1, D4a) |
| D4a | How the four `91b0afb4` requests reach an active bank account (all four point at deactivated accounts) | paying any of them | **Mechanism built as 0207 (T3; not applied, §14).** Open: the organizer adds and verifies an account; owner confirms payees (O2) |
| D5 | Root's own ₦5,000 (`e7ca4751`) | — | **Decided 2026-11-01 (owner): to be cancelled/rejected later through an authorized process; not now; no bypass of two-admin approval.** How (D5a): section 10.2 |
| D5a | Who performs that rejection: today only root can (single super admin), which is a self-action | executing D5 | **Open** — a second super admin, or a written owner exception (section 10.2) |
| D6 | Requester and approver for each withdrawal | after the window | **Requirements complete (section 10.3).** Owner names the people; one role change is advisable (second super admin), not made |
| D7 | Supabase GitHub integration cannot apply migrations on merge (exact steps: runbook §0a O3) | merging PR #82 | **Open, blocker.** Branching is enabled on the production project; whether "Deploy to production" is on cannot be read from here (section 10.5) |
| D8 | Backup and restore (exact steps: runbook §0a O4) | the window | **Open, blocker.** The organization is on the **Free plan: no daily backups, no PITR** (section 10.6) |
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
| Delivery | A new migration (**0206**; 0204 is PR #83 and 0205 is PR #84) after the window. Local tests: maker ≠ checker; owner excluded; stale-expectation refusal; idempotency; cap; each kind's effect on reconciliation; the three real cases below replayed |

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
| O10 | Owner | ~~Approve or reject building D3 (and the D4a "re-point" action)~~ **Done:** both built at the owner's instruction (0206, 0207; not applied) | D3, D2, D10 |

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

## 11. Consolidation (2026-11-02): PR #84 audit, migration order 0201–0205, one checklist

**No production access of any kind was used for this section,** not even read-only SQL. Everything below comes from the repository, the three PRs, and local PostgreSQL 16 runs.

### 11.1 PR #84 audit (`claude/payout-incident-batch-d`, head `ca55288`, Draft)

**What #84 is.**
- Another session wrote a second, independent fix for the same cancelled-transfer incident.
- It branches from `efdca0f`, the commit **before** this PR's own incident fix (`9eb3fa3`). So its diff against #82's head looks as if it deletes that fix (the exceptions table, guard trigger, exceptions report, replay test and UI).
- Measured against its real merge base it only adds things. It does not touch 0202 or 0203.

**Its claims, verified locally on its own branch:**
- incident reproduction 47/47;
- payout engine 50/50;
- earnings policy 163/163;
- migration order 37/37;
- rollback snapshot 11/11.

These are the pre-`9eb3fa3` counts.

| Area | Finding | Severity |
|---|---|---|
| **Applies on #82's head?** | **No.** 0205's guard requires `complete_organizer_payout` md5 `dbcccdb9…` (0203 on top of the *old* 0202). Applied locally after #82's current 0201→0202→0203 it **refuses**: "differs from 0203's body (md5 741fc578…)". Its patch anchor (`SELECT w.balance_kobo INTO v_balance …`) also no longer exists in the current 0202. It fails closed, but runbook step W6a as #84 wrote it would stop the window | **Blocker for #84 as-is** |
| "0202 can charge the organizer twice on a replayed success" | **True of the old 0202 (`efdca0f`). Already fixed on #82** by `9eb3fa3`: the cancelled branch takes money back only with a `cancelled_payout_refund` row; otherwise it completes from pending only when pending is not owed to other open requests, or returns `needs_review` and moves nothing. Proven by `run-payout-incident-replay.sh` (16/16), including production's exact state. **#84's D11 ("0202 without 0205 is unsafe") does not hold for #82's head** | Superseded |
| SQL correctness: late-success patch | Correct on its own base. Logged once (de-duplicated by an admin log lookup); no receivable; no money moved. Evidence test: refund row **or** a 0202 `cancel_processing_payout` log. The log branch is practically unreachable: 0202 refuses a cancel once a reference or code exists | OK (redundant with #82) |
| Security: state-machine trigger | **Stricter than #82's guard; worth keeping:** final states stay final; owner, amount, reference and code are immutable. No conflict found with 0202/0203 transitions (pending→processing, release without code, processing→completed/failed, completed→reversed, cancelled→completed). Not `SECURITY DEFINER`; client `EXECUTE` revoked | **Keep (port)** |
| No-delete trigger | Blocks deleting any request with a reference, code or non-pending/rejected/cancelled status. Account deletion is a soft delete (0134), so in-app deletion is unaffected. A **hard** delete of a paid organizer's auth user (which cascades) now fails with a clear error, which is the right call for financial records. Document it in the admin runbook | OK; document |
| `admin_payout_integrity_report()` | Read-only, `STABLE SECURITY DEFINER`, `is_admin()` in the `WHERE` (a non-admin gets no rows rather than an error). Wider than #82's `admin_list_payout_exceptions()`: also flags completed without a payout row, processing over a day, and payout rows linked to no request | **Keep (merge with #82's list)** |
| Webhook (`api/webhook/paystack.ts`) | HMAC check unchanged and still first. On `not_found` by transfer code it retries **once** by reference, bounded and idempotent (both RPCs are status-gated). `needs_review` is logged as an error, answered 200 and never emailed. Compatible with #82's 0202 (`complete_organizer_payout` matches id, code or reference). Fixes a real gap: "mark sent" failed → outcome lost | **Keep (port)** |
| Rollback | Its documented undo (drop its 2 triggers and restore the function) works. After a full R3 restore the triggers would remain; they only refuse unsafe transitions, as with #82's guard | OK |
| Tests | 3 new webhook tests (`payoutCancelledTransferIncident.security.test.ts`); doc claims 2968/2968 (re-run in 11.5) | — |
| Personal data | None found in #84's changes | OK |
| Git conflicts with #82 head | `docs/production-readiness-batch-d.md` (both rewrote §2) and `AdminPayoutsScreen.doubleSubmit.test.tsx` (the **same** one-line mock fix in both) | Trivial / docs |
| Numbering | #84's D10–D13 mean something different from this document's (its D11 = "apply 0205", D12 = "the ₦300,000 booking", D13 = "₦40 fees"). The consolidated list (11.4) is authoritative | Fixed here |
| Reconciliation | #84's **₦32,350** "held with no source" and this document's **₦32,150** wallet−ledger gap agree once both are on the same basis. 32,150 + ₦200 (ledger-only correction for the returned pre-July-9 money) = **₦32,350 = +₦36,450 unsourced earned − ₦4,100 unexplained outflow** (the ₦4,500 of 10.9 minus the ₦400 that Paystack really paid). Recording the ₦400 (D10) and correcting the ₦200 (D2) is what turns the ₦32,150 view into the ₦32,350 one | Aligned |

**Recommendation.** Do not merge #84 as it stands. **Consolidate it into #82:**
1. Port the webhook reference fallback, the `needs_review` logging, and its 3 tests.
2. Port the state-machine and no-delete triggers and the integrity report into a **re-based 0205**:
   - drop its `complete_organizer_payout` patch (#82's 0202 already does this);
   - re-pin its guard to #82's 0203 body, or remove the md5 dependency;
   - fold #82's `organizer_withdrawal_transfer_guard` into the one state-machine trigger, so there is one source of truth.
3. Re-run every suite; then close #84 with a pointer.

### 11.2 Migration order 0201–0205 and unsafe orders

| Migration | PR | Depends on | Order |
|---|---|---|---|
| 0201 representative rewards | #82 | 0193/0196/0197 (in production) | 1st |
| 0202 payout engine safety (+ incident fix) | #82 | 0201 (0202 → 0201 drops `payout_reversal`, proven by `run-migration-order-verification.sh`) | 2nd |
| 0203 earnings policies | #82 | 0202's exact bodies (md5 pins, including `complete_organizer_payout` `f6ca5add…`) | 3rd |
| 0204 recruiter search | #83 | only production objects (0196's `recruiter_target_is_organizer`, `recruiters`, `check_rate_limit`, `service_providers`) | after the window, own transaction |
| 0205 cancelled-transfer safety | #84 → rebuilt in #82 (§12) | 0202/0203 objects only (no md5) | 4th, in the window (W6a) |
| 0206 earnings adjustment | #82 (§13) | 0203 + 0205 objects | 5th, in the window (W6b) |
| 0207 withdrawal bank reassignment | #82 (§14) | 0203 + 0205 objects | 6th, in the window (W6c) |

**Unsafe orders and merges:**
- **0202 before 0201** drops the `payout_reversal` ledger type. 0203 before 0202, or out of order generally, is refused by the drift guards, which fail closed.
- **#84's 0205 in step W6a as #84 wrote it:** refused, so the window stops after 0203. Applying 0201–0203 without 0205 is safe on #82's head, but don't plan the window around a step that is guaranteed to fail.
- **"Fixing" that refusal by reverting 0202 to `efdca0f`** to match 0205's md5 would remove the transfer guard, the exceptions table and the evidence-based branch. Do not do this.
- **Merging #83 or #84 into `claude/vents-work-earn` before the window** puts 0204/0205 and unrelated UX changes inside the money-critical window. Merge #82 alone.
- **Merging #82 to `main` while Supabase "Deploy to production" may be on (D7)** could make Supabase try to apply `supabase/migrations` (0014–0205 are not recorded under those versions in production). This is a blocker.
- **`supabase db push`** must never be used (production's history uses apply-time versions).
- **Migration number collision:** 0204 (#83) and 0205 (#84) are taken; the D3 adjustment migration becomes **0206**.

### 11.3 PR status (2026-11-02)

| PR | Branch / head | Base | State | Mergeable | Exact remaining blockers |
|---|---|---|---|---|---|
| #82 | `claude/vents-work-earn` `6369cde` | `main` | Draft, open | GitHub: no failing check; Vercel Preview Ready | Owner: A1–A7; D1, D2, D3, D4a, D5a, D6 names, D7, D8, D10. Technical: consolidate #84 (11.1); D3 action not built; D4a has no re-point path |
| #83 | `claude/bold-allen-bpxsd6` `101dcea` | `claude/vents-work-earn` at `efdca0f` | Draft, open | clean test merge with `6369cde` | One failing test in #83 (key-shaped fake value); its doc's "3 unhandled rejections" note is stale (fixed on #82); retarget to `main` after #82; apply 0204 separately; add the RPC to the Preview allowlist if wanted |
| #84 | `claude/payout-incident-batch-d` `ca55288` | `claude/vents-work-earn` (merge base `efdca0f`) | Draft, open | **conflicts** with `6369cde` (2 files); 0205 refuses on #82's 0203 | Consolidate into #82 and close (11.1) |
| #81 | `codex/monetization-master-checklist` | `main` | Draft, open | — | Outside Batch D |

### 11.4 The consolidated Batch D checklist (authoritative; replaces the D-tables above and #84's)

**Completed**

| # | Item | Evidence |
|---|---|---|
| C1 | Root cause of the 4 paid-but-cancelled ₦100 transfers | §9.2; status-only sweep `20260713100000` + live `complete_organizer_payout` swallowing late success |
| C2 | 0202 incident fix (evidence-based late success, `payout_exceptions`, transfer guard, exceptions list, report-only Paystack check) | `9eb3fa3`; replay 16/16, payout engine 72/72 |
| C3 | 0203: refuse authorizing a withdrawal to an inactive bank account | `6369cde`; earnings policy 166/166 |
| C4 | Rollback snapshot of all 19 replaced functions | 12/12 |
| C5 | Backup restore drill script | self-test 4/4 |
| C6 | Owner decisions D4 (both ₦20,000 intended) and D5 (reject root's ₦5,000 later, authorized) recorded | §10.1–10.2 |
| C7 | D6 requirements (case A: one super admin) | §10.3 |
| C8 | D3 `earnings_adjustment` design (migration 0206) | §10.4 |
| C9 | D10 reconciliation process design | §10.7 |
| C10 | D11 webhook delivery evidenced | §10.8 |
| C11 | D12 investigated (not attributable); D13 evidence gathered | §10.9–10.10 |
| C12 | Gap figures aligned with #84 (₦32,350 unsourced = +₦36,450 − ₦4,100); `dfca505f` ₦1,000 source exact | 11.1 |
| C13 | PR #84 audited; migration order verified; PR #83 test-merged | 11.1–11.3 |
| C14 | Personal data removed from the current docs | §10, 11.6 |

**Outstanding technical work (Claude can do it; no production access needed)**

| # | Item | Blocks |
|---|---|---|
| T1 | ~~Consolidate #84 into #82~~ **Done 2026-11-02 (§12)**; #84 to be closed | — |
| T2 | ~~Build D3 `earnings_adjustment` as migration 0206~~ **Built 2026-11-02 (§13); not applied** | — |
| T3 | ~~Dual-control "re-point withdrawal to an active account"~~ **Built 2026-11-02 (§14, migration 0207); not applied** | — |
| T4 | ~~#83: replace the key-shaped fake value; update its stale note~~ **Done 2026-11-02 (§15, `cc00756` on #83)**. Retargeting to `main` waits for #82 to merge | merging #83 |

**Blocked (waiting on evidence or a decision)**

| # | Item | Waiting on |
|---|---|---|
| B1 | D2 corrections (`dfca505f` −₦1,000 ledger-only; `91b0afb4` +₦200 ledger-only; the ₦32,350) | T2, plus O8 evidence for the ₦36,450 / ₦4,100 |
| B2 | D10 recording of the 4 transfers | T2, O6, a second super admin (O1) |
| B3 | Paying `91b0afb4`'s 4 pending requests | D4a, O2, O6 (the ₦300,000 booking must be real money, or ₦44,100 of pending is unbacked) |
| B4 | Rejecting root's ₦5,000 (D5) | D5a / O1 |

**Owner-only actions (exact steps in §10.13)**
- **O1:** second super admin.
- **O2:** confirm payees and choose a D4a path.
- **O3:** Supabase GitHub integration: turn "Deploy to production" and "Automatic branching" **off**.
- **O4:** backups: Pro, or a verified manual dump.
- **O5:** record the Paystack webhook URL.
- **O6:** Paystack exports: the 4 transfers, and booking `BKG-65aefaef…`.
- **O7:** who operates which account.
- **O8:** InsForge cutover export.
- **O9:** a payee's full name in commit `9eb3fa3`'s history.
- **O10:** approve building D3 (and T3).

Plus: D1 (approve the window), D10 option (a/b/c), the ₦40 fees in VENTS's books, and approvals A1–A7.

**Deployment-only actions (inside the approved window; runbook §3–§5)**
1. Preconditions: O3, O4.
2. P1–P4 preflight.
3. W1: pause purchases and payouts.
4. W2: a verified dump.
5. W4–W6: 0201 → 0202 → 0203.
6. W6a: 0205 (rebuilt; T1 done); W6b: 0206 (built; T2 done; no adjustment filed in the window); W6c: 0207 (built; T3 done; no reassignment filed in the window).
7. W7: merge #82.
8. W8: ₦100 purchase test.
9. W9: confirm the webhook URL, then reopen payouts.
10. After the window: 0204 with #83; 0206 when built.

### 11.5 Verification (2026-11-02)

| Check | #82 head `6369cde` | #84 head `ca55288` |
|---|---|---|
| Local PostgreSQL suites | **16/16 pass**: earnings policy 166, payout engine 72, incident replay 16, rollback snapshot 12, migration order 37, payout gate 27, backup-restore 4, 9 others | its 5 relevant suites pass (47 / 50 / 163 / 37 / 11) |
| 0205 applied after #82's 0201→0203 | **refused** by its md5 guard (shown locally) | applies (on its own base) |
| vitest | **2962/2962**, 0 unhandled errors, exit 0 | 2968/2968, exit 0 |
| `tsc --noEmit` | clean | clean |
| Production `vite build` (dummy env values) | passes | not re-run (no build-affecting change beyond the webhook) |
| Test merge #83 onto #82 (2026-11-01) | clean; 3036/3037, the 1 failure is #83's own | — |
| Merge #84 into #82 | — | conflicts: 2 files (11.1) |

### 11.6 Privacy

The repository is public. This section and §10 name people by role or initials only.
- #84's changes contain no personal data.
- Commit `9eb3fa3` still carries one payee's full name in git history (O9).

### 11.7 Next exact action, and the next Claude prompt

**Next exact action (owner, about 10 minutes, no risk):** do **O3** and **O4**, because they gate everything else:
- **O3:** in Supabase → Project Settings → Integrations → GitHub, set "Deploy to production" and "Automatic branching" off and record the settings.
- **O4:** choose Pro, or a manual dump in W2.

Then answer **O10** (build D3: yes or no).

**Next Claude prompt (can run in parallel; repository only):**

> Continue VENTS Batch D from `docs/production-readiness-batch-d.md` §11. Consolidate PR #84 into PR #82 (branch `claude/vents-work-earn`) as §11.1 recommends:
> 1. Port #84's webhook reference fallback, its `needs_review` logging and its 3 webhook tests.
> 2. Write a re-based `supabase/migrations/0205_payout_cancelled_transfer_safety.sql` with **no** `complete_organizer_payout` patch:
>    - one state-machine trigger that merges #84's rules with 0202's `organizer_withdrawal_transfer_guard` (remove the duplicate);
>    - the no-delete trigger;
>    - `admin_payout_integrity_report()` merged with `admin_list_payout_exceptions()`;
>    - a guard on #82's 0203 body, or no md5 dependency.
> 3. Add local suite checks: the July sweep is refused; final states are final; owner, amount and reference are immutable; no hard-delete with history; no conflict with 0202/0203 transitions; rollback leaves it safe.
> 4. Rewrite runbook W6a; re-run all local Postgres suites, vitest, tsc and the production build.
> 5. Commit and push to `claude/vents-work-earn`; comment on #84 pointing to the commit and recommend closing it.
>
> Do not merge any PR, apply migrations, run any SQL against production (including read-only), change roles, touch withdrawals or balances, or enable sign-ups. Keep personal data out of the repo.

## 12. T1 done (2026-11-02): PR #84 consolidated into this PR

**No production access of any kind.** Repository and local PostgreSQL 16 only.

### 12.1 What was ported, and what was not

| From #84 | Here | Notes |
|---|---|---|
| Webhook: on `not_found` by transfer code, retry once by the fixed reference (success and failure) | `api/webhook/paystack.ts` | Applied from #84's own diff. HMAC check unchanged and first |
| Webhook: `needs_review` → loud error log, 200, no email | same | — |
| Webhook tests (13) | `api/_lib/payoutCancelledTransferIncident.security.test.ts` | **3 fail against the previous handler**, all 13 pass now. Its migration-text tests are rewritten for the rebuilt 0205 |
| State-machine trigger | `0205_payout_cancelled_transfer_safety.sql` → `organizer_withdrawal_requests_guard` | **Merged with 0202's guard**: one `BEFORE UPDATE` trigger. 0202's `organizer_withdrawal_transfer_guard` trigger and function are dropped by 0205 (no duplicate guards). Its error messages are kept, so existing checks still match |
| Immutable owner, amount, reference, transfer code | same trigger | — |
| No-delete trigger | `organizer_withdrawal_requests_no_delete` | Soft account deletion unaffected; a hard delete of a paid organizer now fails |
| `admin_payout_integrity_report()` | same | Merged: #84's issues + unresolved `payout_exceptions` rows + payout ledger rows linked to no request. Raises "Admin access required" for non-admins (#84 returned an empty set). `admin_list_payout_exceptions()` (0202) stays for the API's report-only Paystack check |
| `payout_cancel_returned_funds()` | same | Evidence helper for the report; not client-callable |
| **Not ported:** #84's `complete_organizer_payout` patch | — | This branch's 0202 already resolves a late success from evidence (replay 16/16) |
| **Not ported:** the md5 pin on 0203's body | — | Replaced by an object-existence prerequisite check (0202 and 0203 objects) |
| New: undo for 0205 alone | `supabase/rollback/undo_0205.sql` | Needs `vents.rollback_confirm = 'undo-0205'`; restores 0202's guard verbatim |

### 12.2 Tests

New suite `scripts/local-pg-test/run-payout-state-machine-verification.sh`, **51/51**. It runs the July sweep statement **extracted verbatim** from `migrations/20260713100000_admin-stats-and-payout-cleanup.sql`.

**Order and application:**
- 0205 refuses before 0202/0203.
- The sweep reproduces the incident on production's code.
- 0201 → 0202 → 0203 → 0205 apply; applying 0205 changes no request, wallet or ledger row; 0205 is idempotent.
- Exactly two triggers remain (guard + no-delete); 0202's guard is gone.
- `complete_organizer_payout` is untouched.

**Integrity report:** lists the four incident requests; refuses non-admins and anon; the helpers are not client-callable.

**July sweep:** the verbatim sweep is now refused, atomically.
- processing with only a reference: cannot be cancelled or rejected;
- with a transfer code: cannot return to pending;
- release before a code is allowed;
- pending without a transfer can still be rejected.

**Final states:**
- failed, rejected and reversed cannot change; completed cannot become failed; cancelled cannot become pending;
- pending → reversed is refused;
- completed → reversed and cancelled → completed are allowed.

**Immutable:**
- amount, owner, transfer code and reference cannot change (including on an incident row);
- the bank-account link can still be nulled (FK `SET NULL`);
- notes and timestamps can change.

**Deletion:** requests with a code, a reference, or completed/failed status cannot be deleted; a never-sent rejected request can be.

**Late success after 0205:** `needs_review`, no money moved, the exception appears in the report, and a duplicate webhook adds nothing.

**Undo:** refused without confirmation. With it, 0202's guard is restored, the sweep is still refused, no money moves, and 0205 re-applies.

**Existing 0202/0203 transitions under 0205:** `run-payout-engine-verification.sh` and `run-earnings-policy-verification.sh` now apply 0205 after 0203, so every engine and two-admin path runs under the new trigger.
- Payout engine **74/74**. One expectation now meets the state machine before the status CHECK; the CHECK is tested separately.
- Earnings policy **167/167**.
- Rollback snapshot **12/12**: the R3 restore keeps 0205's two triggers.

**Full run:** 17/17 local suites; vitest, tsc and build in 12.3.

### 12.3 Verification on this commit

| Check | Result |
|---|---|
| Local PostgreSQL suites | **17/17 pass**: state machine **51** (new), payout engine **74**, earnings policy **167**, incident replay 16, rollback snapshot 12, migration order 37, payout gate 27, backup-restore 4, 9 others |
| vitest | **2975/2975**, 321 files, 0 unhandled errors, exit 0 (+13 ported webhook/migration tests) |
| `tsc --noEmit` | clean |
| Production `vite build` (dummy env values) | passes |

### 12.4 Remaining checklist after T1

- **Technical (Claude):**
  - ~~T2: build 0206~~ done (§13);
  - T3: re-point action, if chosen for D4a;
  - T4: #83's key-shaped test value.
- **Blocked:** B1–B4 (§11.4).
- **Owner:** O1–O10, D1, D10 option, ₦40 fees, A1–A7.
  - **O3 (Supabase "Deploy to production" off) and O4 (backups) remain the gating actions.**
- **PRs:**
  - #84 is to be closed (superseded by this commit);
  - #83 is unchanged (retarget after #82);
  - #82 stays Draft.

## 13. T2 built (2026-11-02): migration 0206, the audited two-admin earnings adjustment

**Not applied.** No production access of any kind. Nothing is executed by this commit. Every correction (D2, D10) still needs the owner's decision and then two admins.

### 13.1 Design, checked against the existing architecture

| Requirement | How 0206 meets it | Matches |
|---|---|---|
| Built on the existing maker-checker | `request_admin_action('earnings_adjustment', 'user', <organizer>, …)`, then `approve_admin_action` (super admin, not the requester), then `execute_earnings_adjustment` (not client-callable). Wired by anchored, idempotent patches | 0203's `authorize_withdrawal` / `execute_withdrawal_authorization` |
| Kinds | `ledger_only` (credit or debit; ledger row, **no wallet change**). `wallet_credit` (+balance, +earned). `wallet_debit` (−balance, −earned, available balance only). `late_recorded_payout` (one `payout` row linked to the request, +withdrawn, balance unchanged, request status unchanged, its `payout_exceptions` resolved) | §10.4 design |
| Two distinct admins, neither the payee | Executor: super-admin approver ≠ requester; neither = the wallet owner; the requester must **still** be an admin at approval. Also a table `CHECK` on `earnings_adjustments` | 0203 `organizer_withdrawal_requests_two_admins` |
| Wallet snapshot; refuse if it changed | `admin_request_earnings_adjustment` snapshots balance, pending, on hold and ledger net **server-side** (never client-supplied). The executor locks the wallet `FOR UPDATE` and refuses on any difference ("The wallet changed since…"). The request stays pending and nothing moves | — |
| Append-only, never back-dated | `earnings_adjustments` rejects `UPDATE`/`DELETE`. A trigger on `organizer_transactions` lets only the executor insert `adjustment_credit`/`adjustment_debit` rows and forbids changing or deleting any row an adjustment wrote (including the late `payout` row). `created_at` is always `now()`; the Paystack date goes in `metadata.paid_at` | 0202/0205 history protections |
| Idempotent | `UNIQUE (admin_request_id)`; the approval consumes the request ("Request already approved"); one `payout` row per request (0202's unique index); a late payout already recorded is refused | — |
| Authorization | Only `admin_request_earnings_adjustment` is client-callable (admins, checked inside). The executor, validator and ledger helper are revoked from clients; the table has RLS and no grants | — |
| No bypass of wallet constraints | A debit never exceeds the **available** balance, never touches pending or held money, never makes earned negative; `balance_kobo >= 0` is still enforced by the table CHECK. Per-adjustment cap ₦50,000; requests expire after 7 days | — |
| Late payout guards | Request must belong to the organizer, be cancelled/failed/rejected, carry a transfer code equal to the payload's, have no payout recorded, and the amount must equal the request. Refused if the cancel returned the money (then it is a `wallet_debit`) | — |
| Audit | `admin_logs` `earnings_adjustment_applied` (both admins, before/after, reason, evidence). Full details on the ledger row's metadata and on the adjustment record (balance and ledger net before and after) | — |
| Reconciliation | `admin_earnings_reconciliation()` counts the new types (anchored patch). Verified: a `ledger_only` debit moves the ledger gap by exactly its amount; wallet kinds move ledger and wallet together | 0203 |
| Rollback | `supabase/rollback/undo_0206.sql`: confirmed. **Refused once anything was executed** or while a request is pending. Restores the 0203 ledger types and unwiring | 0205's undo |
| App | `src/lib/earningsAdjustment.ts` (validation mirrors the server; calls only the helper RPC). Admin → Payouts → "Request earnings adjustment" form. Admin → Actions shows the approver the kind, effect, amount, reason, evidence and reviewed balance | — |

**Not built (by design):**
- no automatic or bulk corrections;
- no adjustment above ₦50,000 (that needs a migration);
- no editing of existing rows.

### 13.2 Tests

New `scripts/local-pg-test/run-earnings-adjustment-verification.sh`, **71/71**, on 0201 → 0202 → 0203 → 0205 → 0206 with the July sweep replayed:

- **Install:**
  - refused before 0203/0205; applying it changes nothing; idempotent;
  - wired into the maker-checker and the reconciliation.
- **Undo before execution:**
  - refused without confirmation;
  - with it, everything is unwired, 0203's withdrawal wiring stays intact, no money moves, and 0206 re-applies.
- **Authorization:**
  - a plain user, anon, a direct executor call and direct table access are all refused;
  - an admin cannot file for their own wallet (helper, or a raw request at approval);
  - the approver cannot be the wallet owner;
  - the requester cannot self-approve, and a sub-admin cannot approve.
- **Validation:** short reason, missing evidence, zero, over-cap, unknown kind, contradicting direction; a raw fractional amount or missing snapshot is refused at execution.
- **ledger_only:**
  - the wallet is unchanged; one linked row is created now;
  - the gap moves by exactly the amount;
  - the record holds both admins and the before/after snapshot; it is audited;
  - a second approval is refused and adds nothing.
- **Stale approvals:** a sale after the request makes approval fail; the request stays pending and nothing moves.
- **Credit / debit:**
  - exact balance and earned effects;
  - a debit above the available balance is refused even when pending is large;
  - ledger and wallet move together.
- **late_recorded_payout on an incident row:**
  - wrong transfer code, wrong amount and missing `paid_at` are refused;
  - recording creates one linked payout row (`recorded_late`, `paid_at`); withdrawn rises; balance and pending are unchanged; the request stays cancelled;
  - the exception is resolved and the integrity report clears it;
  - the same payout cannot be recorded twice;
  - returned-money and in-flight requests are refused.
- **Append-only:**
  - adjustment records and adjustment ledger rows cannot be updated or deleted;
  - the late payout row cannot be back-dated;
  - a forged adjustment row is refused;
  - ordinary ledger writes still work; `balance_kobo >= 0` still holds.
- **Expiry and demotion:** a request over 7 days old is refused; so is one from a requester since demoted.
- **Undo after execution:** refused, and nothing changes.

**Existing flows under 0206:**
- the payout engine (**75**) and earnings policy (**168**) suites now apply 0206 after 0205;
- rollback snapshot **12/12** with 0206 present.

**App tests:**
- `src/lib/earningsAdjustment.security.test.ts`: validation, RPC-only filing, the approver's label, a source scan that no `src/`/`api/` code calls the executor or writes adjustment rows, and the migration text;
- `src/app/components/admin/EarningsAdjustmentForm.test.tsx`: 4 render tests.

### 13.3 Verification on this commit

| Check | Result |
|---|---|
| Local PostgreSQL suites | **18/18 pass**: earnings adjustment **71** (new), payout engine 75, earnings policy 168, state machine 51, incident replay 16, rollback snapshot 12, migration order 37, payout gate 27, backup-restore 4, 9 others |
| vitest | **2998/2998**, 323 files, 0 unhandled errors, exit 0 |
| `tsc --noEmit` | clean |
| Production `vite build` | passes |

### 13.4 Remaining after T2

- **Owner decisions** that 0206 now makes executable (each is two admins after the window):
  - **D2 `dfca505f`:** `ledger_only` debit ₦1,000 (ledger credit `64e7e2e8`);
  - **D2 `91b0afb4`:** `ledger_only` credit ₦200 (the returned pre-July-9 money). For the ₦32,350: keep it (explanatory `ledger_only` entries) or `wallet_debit` (after O6/O8 evidence);
  - **D10:** four `late_recorded_payout` entries (₦100 each). Option (c) adds a ₦400 `wallet_debit` only if D12 shows the ₦400 went back to the balance.
- **Approver independence (D5a/O1):** today root is the only super admin, and root's payout account shares the incident payee's initials. So D10 needs a second super admin or a written owner exception.
- **Gating owner actions:** O3 (Supabase "Deploy to production" off) and O4 (backups), then D1/A1–A7.
- **Remaining technical work:** none in code. T3 built (§14), T4 done (§15); #83's retarget waits for #82.

## 14. T3 built (2026-11-02): migration 0207, the audited two-admin withdrawal bank-account reassignment (D4a)

**Not applied.** No production access of any kind. Nothing is reassigned by this commit.

### 14.1 Design, checked against the existing architecture

| Requirement | How 0207 meets it |
|---|---|
| Request/approve with two distinct admins | `admin_request_withdrawal_bank_reassignment` files `request_admin_action('reassign_withdrawal_bank_account', 'withdrawal', <request>)`. Then `approve_admin_action` (super admin ≠ requester), then `execute_withdrawal_bank_reassignment` (not client-callable). The same pattern as 0203 `authorize_withdrawal` and 0206 `earnings_adjustment`; wired by anchored patches beside them |
| Neither admin is the payee | Executor: the withdrawal's organizer is neither requester nor approver; the requester must still be an admin. Also a table CHECK on `withdrawal_bank_reassignments` |
| The replacement account is the payee's, active and verified | Same `organizer_id` as the withdrawal; `is_active`; a Paystack `recipient_code` present; different from the current account |
| Never alters amount, reference, wallet or ledger | Only `bank_account_id` and the request's bank snapshot columns (`bank_name`, `bank_code`, `account_number`, `account_name`) change. No wallet or ledger write exists in the file (also tested as text) |
| Only a safe withdrawal can move | `pending`, **not yet authorized** (`approved_by IS NULL`), and no Paystack reference or transfer code. A processing or attempted request is refused |
| Stale requests refused | The server snapshots the withdrawal (`bank_account_id`, `updated_at`) and the new account (`updated_at`, an md5 fingerprint of the recipient code) at request time. The executor locks both rows and refuses any difference, status change or deactivation |
| Audit without exposing bank details | `withdrawal_bank_reassignments` (append-only) and `admin_logs` `withdrawal_bank_reassigned` hold account **IDs** and **masked** numbers (`Bank ****1234`) only. The request payload holds masked numbers and a fingerprint, never the full number or recipient code (tested) |
| Cannot bypass 0202/0203/0205 | Afterwards the request still needs the normal two-admin `authorize_withdrawal`, which binds the **new** recipient; then the claim (active-account and recipient checks, fixed reference, 0205 state machine). A moved request that is authorized can no longer be moved |
| No silent destination swaps | New trigger `organizer_withdrawal_destination_guard`: `bank_account_id` (except → NULL via the FK) and the snapshot columns change only inside the executor |
| Idempotent, expiring | `UNIQUE (admin_request_id)`; the approval consumes the request; requests expire after 7 days |
| Rollback | `supabase/rollback/undo_0207.sql`: confirmed. Refused once anything was reassigned or a request is pending. Unwires only 0207 |
| App | `src/lib/withdrawalReassignment.ts`. Admin → Payouts → a pending, unauthorized withdrawal → "Move to another bank account": lists only the organizer's active, verified accounts, masked. Admin → Actions shows the approver the masked old → new accounts, the amount and the reason |

### 14.2 Tests

New `scripts/local-pg-test/run-withdrawal-reassignment-verification.sh`, **61/61**, on 0201 → 0207, reproducing D4a (pending requests on a deactivated account):

- **Install:**
  - refused before 0203/0205; applying changes nothing; idempotent;
  - wired beside 0203 and 0206.
- **Undo before use:**
  - refused without confirmation;
  - unwires 0207 only, changes nothing, and 0207 re-applies.
- **Destination guard:**
  - a raw `bank_account_id` change is refused, and so is a change to the snapshot columns;
  - the FK `SET NULL` path still works.
- **The D4a deadlock:** before reassignment, authorizing a request on a deactivated account is refused (0203).
- **Authorization:**
  - a plain user, anon, a direct executor call and direct table access are refused;
  - an admin cannot file for their own withdrawal; the approver cannot be the organizer;
  - no self-approval; a sub-admin cannot approve.
- **Validation:** a short reason; another organizer's, inactive, unverified, the same or a missing account; a processing request; a request with a reference.
- **Reassignment:**
  - the destination and snapshot are updated;
  - amount, status, reference and code are unchanged; wallet and ledger are unchanged;
  - the record holds both admins and masked old/new accounts;
  - **no full number or recipient code** appears in the request, the record or the audit log;
  - audited once; a second approval is refused.
- **Safeguards afterwards:**
  - still unclaimable without two-admin authorization;
  - authorization binds the new recipient;
  - once authorized it cannot be moved;
  - the claim pays the new recipient under the fixed reference;
  - a processing request cannot be moved.
- **Stale requests:** a changed withdrawal, a new account whose recipient changed, a new account deactivated after the request, and a withdrawal no longer pending are all refused.
- **Expiry and demotion:** a request over 7 days old, and one from a demoted requester, are refused.
- **Append-only; undo after use:** both refused.

**Existing flows under 0207:**
- the payout engine (**76**) and earnings policy (**169**) suites now apply 0207;
- rollback snapshot 12/12; earnings adjustment 71/71.

**App tests:**
- `src/lib/withdrawalReassignment.security.test.ts`: masking, eligibility, RPC-only filing, the approver's label, a source scan (no client/API code updates a withdrawal's destination or calls the executor), and the migration text;
- `src/app/components/admin/WithdrawalReassignForm.test.tsx`: 3 render tests (only eligible accounts, masked; RPC only; empty state; validation).

### 14.3 D4a: what it now takes (owner and organizer, after the window)

1. **The organizer must add and verify a new bank account.** In production (read-only 2026-11-01) **every** bank account of `91b0afb4` is inactive, so today there is nothing eligible to move to.
2. **O2:** confirm with the organizer the intended payee of each request. The ₦40,000 pair was created against an account in a third party's name (§10.1).
3. A sub-admin files "Move to another bank account" for each of the four requests; a different super admin approves.
4. Then the normal two-admin authorization for each, then payment.
5. **Separation of duties (O1):** root is the only super admin, and root's own payout account shares a holder name with this organizer's accounts (§10.3). The owner should confirm the approver is independent of the payee.

### 14.4 Verification on this commit

| Check | Result |
|---|---|
| Local PostgreSQL suites | **19/19 pass**: withdrawal reassignment **61** (new), earnings adjustment 71, payout engine 76, earnings policy 169, state machine 51, incident replay 16, rollback snapshot 12, migration order 37, payout gate 27, backup-restore 4, 9 others |
| vitest | **3014/3014**, 325 files, 0 unhandled errors, exit 0 |
| `tsc --noEmit` | clean |
| Production `vite build` | passes |

## 15. T4 done (2026-11-02): PR #83's failing test

**Commit `cc00756`** on `claude/bold-allen-bpxsd6` (PR #83). No production access.

| Item | Result |
|---|---|
| The failing test | `LocationPicker.maps.test.tsx` stubbed the Maps key with a fake value carrying Google's 4-character API-key prefix. `googleMapsKeyNeverCommitted.security.test.ts` correctly flagged it as a committed key-shaped string. Nothing in `googleMaps.ts` checks the prefix at runtime, so the stub is now `'test-places-key-for-unit-tests'`. **The security test is unchanged** and still scans every tracked file |
| #83's stale note | Its "3 unhandled rejections in `AdminPayoutsScreen.doubleSubmit.test.tsx`" came from the old mock, fixed on #82 in `9eb3fa3`. The byte-identical one-line fix is now on #83 too, so #83's own run exits 0, and the identical line merges cleanly with #82 |
| #83 alone | vitest **3030/3030**, exit 0, 0 unhandled; `tsc` clean; production build passes; `run-recruiter-search-verification.sh` **23/23** (re-run here; the earlier sandbox permission problem is gone) |
| #83 merged onto #82's head `a2ac0da` (local test merge only) | **clean merge**; vitest **3089/3089**, 0 unhandled; `tsc` clean. On the merged tree: recruiter search 23/23, withdrawal reassignment 61/61, earnings adjustment 71/71, state machine 51/51, migration order 37/37 |
| 0204 stays separate | `0204_search_recruiter_invite_targets.sql` references none of the payout or earnings objects: no `approve_admin_action`, `request_admin_action`, withdrawals, wallets or ledger (checked). It is **not** part of the Batch D window (W4–W6c). Apply it on its own, after the window, in its own transaction |

**Retarget, after #82 merges (not done now):**
1. If GitHub deletes `claude/vents-work-earn` on merge, it retargets #83 to `main` automatically. Otherwise: PR #83 → Edit → base `main`.
2. Confirm #83's diff then shows only its own 34 files.
3. Wait for CI and Vercel to go green.
4. Merge #83 (owner).
5. Apply 0204 separately (SQL editor / `psql -1`, never `supabase db push`). Verify `search_recruiter_invite_targets` with `pg_get_functiondef`.
6. If the Find search should work on the read-only Preview, add the RPC to the Preview allowlist (`docs/preview-read-only.md`) in a follow-up.

Retargeting now, before #82 merges, would make #83's diff include all of #82 and invite merging it out of order. **Do not.**

## 16. Verification and audit (2026-11-04)

**No production access of any kind** (no SQL, not even read-only); no migration applied; nothing merged or deployed.

### 16.1 Branch and PR heads

| PR | Branch | Head | Base | State | Merge order |
|---|---|---|---|---|---|
| #82 | `claude/vents-work-earn` | this commit (on top of `99348e0`) | `main` @ `5612ee0` (unchanged since 2026-10-30) | Draft, unmerged | **1st**, in the window with 0201 → 0202 → 0203 → 0205 → 0206 → 0207 |
| #83 | `claude/bold-allen-bpxsd6` | `cc00756` | `claude/vents-work-earn` @ `efdca0f` | Draft, unmerged | **2nd**, after the window: retarget to `main`, CI green, merge, then 0204 alone (W10). Do not retarget before #82 merges |
| #84 | `claude/payout-incident-batch-d` | `ca55288` | `claude/vents-work-earn` | Draft, **still open** | Do not merge: superseded by `12ba4c9` (§12). Owner to close |
| #81 | `codex/monetization-master-checklist` | `e37db8a` | `main` | Draft | Outside Batch D |

### 16.2 Migration 0205 audited and rebuilt

**Gap found.** Since 0207 locked a withdrawal's *destination* against raw UPDATEs, the same class of bypass remained on its *authorization*. 0205 did not protect 0203's `approval_*` columns:
- a raw UPDATE could have recorded a fake two-admin approval, cleared a real one, or swapped `approved_recipient_code`;
- a raw UPDATE could have moved a pending request to `processing` without authorization.

Only `execute_withdrawal_authorization` (0203) ever writes those columns.

**Rebuilt** (`organizer_withdrawal_requests_guard`, same trigger, same file):
- the authorization can be recorded only from NULL. It must be recorded by the current session's super admin (`auth.uid()` = `approved_by`), for a **pending** `authorize_withdrawal` request on this same withdrawal, whose requester is `approval_requested_by` and is not the approver. That is exactly what happens inside `approve_admin_action`;
- once recorded it never changes or clears;
- pending → processing requires it.

**Undo order fixed.** 0206's late-payout validation calls `payout_cancel_returned_funds()`, which 0205 creates. `undo_0205.sql` now **refuses while 0206 is installed**. Undo order is R1c → R1b → R1a (runbook "R1-order" row).

New checks:
- state machine suite +8 (**59/59**): raw forge refused (no session; requester = approver; no matching request); unauthorized pending → processing refused; the legitimate approving session succeeds; once set it cannot be cleared or re-pointed; an authorized request can be claimed;
- earnings adjustment suite +2 (**73/73**): `undo_0205` refused under 0206, nothing changed;
- vitest +2 (migration text).

The real two-admin path still works under the rebuilt guard. The earnings policy (169), payout engine (76) and withdrawal reassignment (61) suites all apply 0205 before their authorization and claim tests.

### 16.3 Rollback files ↔ runbook rows (verified)

| Undo | Confirmation setting | Runbook row | Refuses when |
|---|---|---|---|
| `supabase/rollback/undo_0205.sql` | `vents.rollback_confirm = 'undo-0205'` | **R1a** | no confirmation; **0206 still installed** (new) |
| `supabase/rollback/undo_0206.sql` | `'undo-0206'` | **R1b** | no confirmation; any adjustment executed; a request pending |
| `supabase/rollback/undo_0207.sql` | `'undo-0207'` | **R1c** | no confirmation; any reassignment executed; a request pending |
| `supabase/rollback/pre_0201_0203_functions.sql` | `'restore-pre-0201-0203'` | **R3** | no confirmation; earnings on hold |

Each is exercised by its suite: state machine (R1a), earnings adjustment (R1b, plus the R1a ordering), withdrawal reassignment (R1c), rollback snapshot (R3 with 0205–0207 present).

### 16.4 Register corrections made today

| Item | Was | Now |
|---|---|---|
| A1 | "Apply 0201, 0202 and 0203" | 0201 → 0202 → 0203 → 0205 → 0206 → 0207; 0204 excluded |
| A2 | "immediately after 0203" | immediately after W6c (0207) |
| A5 | open | partly decided (D4, D5); open: D4a payees, D5a |
| D3 / O10 | build approval pending | built as 0206 at the owner's instruction; each correction still needs D2/D10 |
| D4a | choose a mechanism | built as 0207; organizer + O2 pending |
| R1a | — | must follow R1b |

### 16.5 Verified results (this commit)

| Check | Result |
|---|---|
| Local PostgreSQL suites | **19/19 pass**: state machine **59**, earnings adjustment **73**, withdrawal reassignment 61, payout engine 76, earnings policy 169, incident replay 16, rollback snapshot 12, migration order 37, payout gate 27, backup-restore 4, 9 others |
| vitest | **3016/3016**, 325 files, 0 unhandled errors, exit 0 |
| `tsc --noEmit` | clean |
| Production `vite build` (dummy env values) | passes |
| PR #83 (`cc00756`) | unchanged since §15: 3030/3030 alone; clean test merge onto #82 |

### 16.6 Exactly what remains

**Approvals (owner), runbook §0:**

| # | Approval | Status |
|---|---|---|
| A1 | Apply 0201 → 0207 (excluding 0204) | open |
| A2 | Merge #82 after W6c | open |
| A3 | Pause purchases and payouts for the window | open |
| A4 | Name the requesting and approving admins | open (D6; a second super admin advised, O1) |
| A5 | The 5 pending withdrawals | partly decided (D4, D5); D4a payees and D5a open |
| A6 | Supabase "Deploy to production" / "Automatic branching" **off** | open, **blocker** (O3) |
| A7 | Backup method | open, **blocker** (O4: Pro, or a verified manual dump in W2) |

**Owner decisions:**
- **D1:** approve the window.
- **D2:** the ₦1,000 / ₦200 / ₦32,350 corrections.
- **D4a:** payees (O2), after the organizer adds a verified account.
- **D5a:** who rejects root's ₦5,000.
- **D6:** names.
- **D10:** option a/b/c.
- **D13:** confirm the account's nature.
- Plus the ₦40 fees in VENTS's books.

**Operational prerequisites:**
- **O1:** second super admin.
- **O2:** confirm payees.
- **O3:** Supabase integration off.
- **O4:** backups.
- **O5:** record the Paystack webhook URL.
- **O6:** Paystack exports (the 4 transfers; booking `BKG-65aefaef…`).
- **O7:** who operates which account.
- **O8:** InsForge cutover export.
- **O9:** a payee name in the history of `9eb3fa3`.
- **Close PR #84.**

**Technical work:** none outstanding in code.

## 17. Status review (2026-11-04, later)

**No production access of any kind**; no migration applied; nothing merged, deployed, approved or moved.

### 17.1 PR #84 can be closed without merging

Verified file by file against #82's head (`1ed74fc`):

| #84 file | In #82 |
|---|---|
| `api/webhook/paystack.ts` | **byte-identical** (reference fallback, `needs_review` logging) |
| `api/_lib/payoutCancelledTransferIncident.security.test.ts` | ported; its migration-text tests rewritten for the rebuilt 0205 (15 tests) |
| `api/_lib/payoutEngine.security.test.ts` | ported (same assertion change) |
| `supabase/migrations/0205_payout_cancelled_transfer_safety.sql` | **superseded** by #82's rebuilt 0205. #84's version refuses to apply on #82 (md5 pin) and patches `complete_organizer_payout`, which #82's 0202 already handles |
| `scripts/local-pg-test/run-payout-cancelled-transfer-verification.sh` (47 checks) | covered by `run-payout-incident-replay.sh`, `run-payout-state-machine-verification.sh` (the sweep verbatim), and the payout engine / earnings policy legacy-cancel and 0203 path checks, all under 0205 |
| `AdminPayoutsScreen.doubleSubmit.test.tsx` | equivalent line (#82 also has a comment) |
| `docs/money-flow-audit.md` (P0-1 note, P0-1b row) | **brought over today**, updated to the final design (P0-1, P0-4, P1-6) |
| `docs/production-readiness-batch-d.md`, `docs/deploy-runbook-0201-0203.md` | superseded by §11–§17 and runbook W6a–W6c |

**Nothing of #84 remains unported.** Closing it loses nothing; merging it would conflict and its 0205 would refuse. **Owner action: close #84.**

### 17.2 Heads (unchanged by today's review except this docs commit)

| Ref | Head | Note |
|---|---|---|
| `main` | `5612ee0` | unchanged since 2026-10-30 |
| PR #82 `claude/vents-work-earn` | this commit, on `1ed74fc` | Draft; merges 1st |
| PR #83 `claude/bold-allen-bpxsd6` | `cc00756` | Draft; base `claude/vents-work-earn`; merges 2nd, after retargeting to `main` |
| PR #84 `claude/payout-incident-batch-d` | `ca55288` | Draft, open; close without merging |

### 17.3 Execution and rollback order (verified)

**Apply (window):**
1. P1–P4 preflight.
2. W1: pause.
3. W2: verified backup.
4. W4 0201 → W5 0202 → W6 0203 → W6a 0205 → W6b 0206 → W6c 0207, each in its own transaction.
5. W7: merge #82.
6. W8 / W9: checks, reopen.

**After the window:** W10 (retarget #83, merge, 0204 alone).

Each later migration refuses without its predecessors, and each suite tests this:
- 0205 needs 0202/0203;
- 0206 needs 0203/0205;
- 0207 needs 0203/0205.

**Undo:** R1c (0207) → R1b (0206) → R1a (0205); R3 for the 19 pre-0201 functions.
- R1a refuses while 0206 exists;
- R1b and R1c refuse once used, or while a request is pending.

**Checked today, ad hoc** (a scratch run of the reassignment suite; nothing committed): undoing **0206 with 0207 still installed** works. It unwires 0206 only; 0203's and 0207's wiring and the destination guard stay. R1a then succeeds and restores 0202's guard beside 0207's.

### 17.4 Gaps found today (no production change)

| # | Gap | Severity | Done |
|---|---|---|---|
| G1 | **Admin-only checks in the runbook could not work as written.** In the SQL editor `auth.uid()` is NULL: `admin_earnings_reconciliation()` returns **no rows** (it filters with `WHERE is_admin()`), and `admin_payout_integrity_report()` raises. W5's "lists only the 2 known gaps" would have read as a false all-clear | High (false verification) | Runbook §3a added: run them in a `BEGIN READ ONLY` transaction with `request.jwt.claims.sub` set to a super admin; W5, W6a, W8, §5 and §6 point to it. **The pattern itself is standard Supabase behaviour but not yet verified against production: check it in P1** |
| G2 | **Two-admin control does not bind database owners.** Anyone with SQL access can set those claims and act as any admin | Inherent | Recorded in §3a; owner keeps dashboard and SQL access limited (part of D6/O1) |
| G3 | `admin_payout_integrity_report()` and `admin_earnings_reconciliation()` have **no app screen**; only §3a reaches them | Low | Not built (optional **T5**: a read-only Admin → Payouts "Integrity" view). Not a deployment blocker |
| G4 | `docs/money-flow-audit.md` was stale (P0-1 described the old take-back; no 0205–0207) | Docs | Updated |

No other code or test gap found: every new money function has a local suite, its undo is tested, and the app tests scan for bypasses.

### 17.5 The complete Batch D checklist

**Done**

- ~~Root cause of the 4 paid-but-cancelled transfers~~ (§9)
- ~~0202 incident fix~~ (`9eb3fa3`)
- ~~0203: refuse authorizing an inactive account~~ (`6369cde`)
- ~~T1: #84 consolidated; 0205 rebuilt~~ (`12ba4c9`)
- ~~T2: 0206 earnings adjustment~~ (`cc61d26`)
- ~~T3: 0207 withdrawal reassignment~~ (`a2ac0da`)
- ~~T4: #83 test fix~~ (`cc00756`)
- ~~0205 authorization guard; undo order~~ (`1ed74fc`)
- ~~Rollback snapshot (19 functions); backup-restore drill script~~
- ~~D4 (both ₦20,000 kept) and D5 (root's ₦5,000 to be rejected through an authorized process) recorded~~
- ~~D3 / O10 (build 0206/0207)~~
- ~~D6 requirements; D11 webhook delivery evidenced; D12 and D13 investigated~~
- ~~PR #84 audited and fully ported~~ (§17.1)
- ~~Runbook admin-check method~~ (§3a, G1)

**Pending: owner approvals** (runbook §0)

- [ ] **A6:** Supabase "Deploy to production" and "Automatic branching" **off** (O3; exact steps in runbook §0a). **BLOCKER**
- [ ] **A7:** backups: Pro, or a verified manual dump in W2 (O4; exact steps in runbook §0a, PostgreSQL 17 tools; drill must print 19/19). **BLOCKER**
- [ ] **A1:** apply 0201 → 0202 → 0203 → 0205 → 0206 → 0207 (not 0204)
- [ ] **A2:** merge #82 right after W6c
- [ ] **A3:** pause purchases and payouts for the window
- [ ] **A4:** name the requesting and approving admins (D6)
- [ ] **A5:** pending withdrawals. Partly decided; D4a payees and D5a open

**Pending: owner decisions**

- [ ] **D1:** approve and schedule the window
- [ ] **D2:** corrections for `dfca505f` −₦1,000 (ledger), `91b0afb4` +₦200 (ledger) and the ₦32,350 (keep with entries, or debit)
- [ ] **D4a:** confirm the payee of each `91b0afb4` request (O2), after the organizer adds a verified account
- [ ] **D5a:** who rejects root's ₦5,000 (a second super admin, or a written exception)
- [ ] **D10:** option a/b/c for the 4 paid transfers
- [ ] **D13:** confirm whether `91b0afb4` is an internal test account
- [ ] Record the ₦40 Paystack fees in VENTS's books

**Pending: operational prerequisites**

- [ ] **O1:** a second super admin (not the root account holder)
- [ ] **O2:** organizer confirmations (payees, including "C.J.N." for ₦40,000)
- [ ] **O3:** see A6
- [ ] **O4:** see A7
- [ ] **O5:** record the Paystack LIVE webhook URL
- [ ] **O6:** Paystack exports (the 4 transfers; booking `BKG-65aefaef…`)
- [ ] **O7:** who operates each staff account and `91b0afb4`
- [ ] **O8:** InsForge cutover export (the ₦36,450 / ₦4,100)
- [ ] **O9:** a payee's full name in the history of `9eb3fa3`: accept or purge
- ~~Close PR #84~~ **closed without merging 2026-11-04**
- [ ] Limit production SQL/dashboard access (G2)
- [ ] Verify the §3a admin-check pattern in P1 (G1)

**Pending: deployment (in the window, after the above)**

- [ ] P1–P4, W1–W3
- [ ] W4–W6c (0201 → 0207 excluding 0204)
- [ ] W7: merge #82
- [ ] W8–W9: checks, reopen

**Pending: after the window**

- [ ] W10: retarget #83 to `main`, merge it, apply 0204 alone
- [ ] D4a: organizer adds an account → reassign (two admins) → authorize (two admins) → pay
- [ ] D5: reject root's ₦5,000 per D5a
- [ ] D2 / D10: corrections through 0206 (two admins)

**Optional technical**

- [ ] T5: read-only Admin "Integrity" view for the two reports (G3)

## 18. Owner approval register and window checklist (2026-11-04, final)

**No production access of any kind.** Heads:
- `main` is at `5612ee0`;
- PR #82 is at this commit, on top of `0c592d9` (Draft);
- PR #83 is at `cc00756` (Draft);
- PR #84 is **closed without merging**.

### 18.1 Register

Status: **Done**, **Decided**, **Open**. Who acts: **Owner-dash** (Supabase/GitHub/Paystack dashboard), **Owner** (a decision or knowledge), **Admins** (two named admins in the app), **Claude** (repository only).

| # | Item | Status | Who acts | Blocks |
|---|---|---|---|---|
| A1 | Apply 0201 → 0202 → 0203 → 0205 → 0206 → 0207 (not 0204) | Open | Owner | the window |
| A2 | Merge #82 right after W6c | Open | Owner | the window |
| A3 | Pause purchases and payouts for the window | Open | Owner (Admin → System, in W1) | the window |
| A4 | Name the requester and the approver admins | Open | Owner | payouts after the window |
| A5 | The 5 pending withdrawals | Decided in part (D4, D5); D4a payees and D5a open | Owner | payouts after the window |
| A6 | Supabase GitHub integration cannot apply migrations (§0a O3) | **Open: BLOCKER** | **Owner-dash** | scheduling |
| A7 | Backup method and a rehearsed restore drill (§0a O4) | **Open: BLOCKER** | **Owner-dash** (+ own macOS with Homebrew `postgresql@17`, or Linux/WSL, with PostgreSQL 17) | scheduling |
| D1 | Approve and schedule the window | Open | Owner | the window |
| D2 | Wallet corrections: `dfca505f` −₦1,000 (ledger); `91b0afb4` +₦200 (ledger); the ₦32,350 (keep with entries / debit) | Open | Owner, then Admins via 0206 | after the window |
| D3 | Build the adjustment action | **Done** (0206, not applied) | — | — |
| D4 | The ₦20,000 pair | **Decided** (keep both) | — | — |
| D4a | Move the 4 `91b0afb4` requests to an active account | Mechanism **done** (0207); payees open | Organizer + Owner (O2), then Admins | after the window |
| D5 | Root's ₦5,000 | **Decided** (reject later, authorized) | — | — |
| D5a | Who rejects it | Open | Owner (O1 or a written exception) | after the window |
| D6 | Requester/approver rules | Requirements **done**; names = A4 | Owner | after the window |
| D7 | = A6 | **Open: BLOCKER** | Owner-dash | scheduling |
| D8 | = A7 | **Open: BLOCKER** | Owner-dash | scheduling |
| D9 | Were the 4 transfers paid | **Done** (all paid) | — | — |
| D10 | Record the 4 paid transfers (option a/b/c) | Open | Owner, then Admins via 0206 (approver independent of payee) | after the window |
| D11 | Paystack webhook delivery | Evidenced; URL to record (O5) | **Owner-dash (Paystack)** | W9 |
| D12 | Where the ₦400 went | Investigated; needs O8 | Owner | D10 (c), D2 |
| D13 | Is `91b0afb4` an internal test account | Open | Owner (O7) | D2, D10 |
| O1 | Second super admin (not the root account holder) | Open | Owner, via the app's audited role change | D5a, A4, D10 |
| O2 | Organizer confirms payees (incl. "C.J.N." for ₦40,000) | Open | Owner + organizer | D4a |
| O3 | = A6 | **Open: BLOCKER** | **Owner-dash** | scheduling |
| O4 | = A7 | **Open: BLOCKER** | **Owner-dash** | scheduling |
| O5 | Record the Paystack LIVE webhook URL | Open | **Owner-dash (Paystack)** | W9 |
| O6 | Paystack exports (4 transfers; booking `BKG-65aefaef…`) | Open | **Owner-dash (Paystack)** | D10, D2 |
| O7 | Who operates each staff account and `91b0afb4` | Open | Owner | D13 |
| O8 | InsForge cutover export | Open | Owner | D12, D2 |
| O9 | A payee's full name in the history of `9eb3fa3` | Open | Owner (GitHub) | privacy |
| O10 | Build 0206/0207 | **Done** | — | — |
| — | Close PR #84 | **Done** (closed, not merged) | — | — |
| — | Limit production SQL/dashboard access; MFA | Open | **Owner-dash** (Organization → Team) | G2 |
| — | Record the ₦40 Paystack fees in VENTS's books | Open | Owner/accountant | D10 |

**Claude can prepare (repository only, no production):**
- nothing is required before scheduling;
- optional: T5 (a read-only admin Integrity view);
- after O6/O8: draft the exact D2/D10 adjustment requests (amounts, reasons, evidence references) for two admins to file;
- after the window: retarget notes and #83's merge follow-up.

### 18.2 Blockers to scheduling the window

Exactly two, both in the dashboard:
1. **A6/O3:** Supabase GitHub integration: "Deploy to production" and "Automatic branching" off (or disconnected). Verify that no "Supabase" check runs on #82.
2. **A7/O4:** a backup path. Pro, or the manual dump: PostgreSQL 17 `pg_dump` via the Session pooler, rehearsed once, with the restore drill printing `Functions matching: 19/19`.

**Then:** D1, A1–A3, plus A4 names if payouts should restart the same day.

### 18.3 Window execution checklist (runbook §2–§5)

1. **T−1:**
   - #82 CI green and Draft lifted by the owner (not merged);
   - A6/A7 recorded;
   - **no pending withdrawal paid or rejected**;
   - window announced (60–90 min).
2. **W1, pause:** Admin → System sets `disable_purchases` and `disable_payouts`. Verify true/true.
3. **W2, backup:**
   - run **P2** and save its output;
   - run `pg_dump -Fc` (PostgreSQL 17, Session pooler) and record the row counts;
   - run `scripts/ops/verify-backup-restore.sh <dump>`. It must print **19/19**, with matching counts;
   - store the dump encrypted, outside the repository.
4. **W3, preflight:**
   - **P1**: all 8 checks true (no 0192 and no 0201–0207 objects);
   - **P3**: all 19 md5s match (18 production-captured, plus `invite_recruiter_partnership` = `32fbfa3f…` by provenance);
   - **P4**: all 0, including `in_flight_payouts`.

   Any mismatch: stop.
5. **W4, apply 0201** (`SET lock_timeout = '5s'`, one transaction, never `supabase db push`). Verify.
6. **W5, 0202.** Verify, with §3a for the reconciliation; 4 paid-but-cancelled requests; the 0202 guard present.
7. **W6, 0203.** Verify (≥14 `[0203]` markers; 48 h delay; `v2_4_5`).
8. **W6a, 0205.** Verify: 2 triggers; 0202's guard gone; integrity report = 4 via §3a.
9. **W6b, 0206.** Verify: table, wiring, ledger types; 0 adjustments.
10. **W6c, 0207.** Verify: table, destination guard, wiring; 0 reassignments.
11. **W7, merge PR #82** (A2). Wait for the Vercel production deployment to be **Ready**. Checkout shows "Service fee (4%)".
12. **W8, reopen purchases only.** One ₦100 live purchase is charged ₦104 and puts ₦95 on hold with a 48 h release (§3a).
13. **W9, confirm the webhook URL (O5), then reopen payouts.** Watch 30 min. The first payout must complete by webhook.
14. **Go / no-go (§5):**
    - the reconciliation shows nothing new;
    - "Check payout exceptions" shows exactly the 4 known requests;
    - no Sentry errors.

On any failure: R1 (a migration fails: it rolls back by itself, so stop). Undo order: **R1c → R1b → R1a**, then R3 only if unavoidable. R2: frontend fails, keep everything paused. R4: data damage, restore the W2 dump.

### 18.4 Order verified against the files

- `supabase/migrations/` on #82 holds 0201, 0202, 0203, 0205, 0206 and 0207. 0204 exists only on #83.
- Each migration refuses without its predecessors:
  - 0202's drift guard requires the 2026-10-30 production bodies or its own;
  - 0203 pins 0202's bodies;
  - 0205 refuses without 0202 + 0203;
  - 0206 and 0207 each refuse without 0203 + 0205.
- Undo files: `undo_0207` (R1c), `undo_0206` (R1b), `undo_0205` (R1a; refuses while 0206 exists), `pre_0201_0203_functions.sql` (R3).
- All are exercised by the local suites (19/19 at `1ed74fc`; no SQL changed since).

### 18.5 After the window

1. **W10:** retarget #83 to `main` (do not do this before #82 merges). CI green, owner merges, then apply **0204** alone and verify `search_recruiter_invite_targets(text)`.
2. **D4a:**
   1. the organizer adds and verifies a bank account;
   2. O2 confirms each payee;
   3. Admins: "Move to another bank account" (0207, two admins) for each of the 4 requests;
   4. then `authorize_withdrawal` (two admins);
   5. then pay.
3. **D5:** reject root's ₦5,000 per D5a, after O1, by a super admin other than root.
4. **D2 / D10:** after O6/O7/O8 and the owner's choices, two admins file the corrections through 0206:
   - a `ledger_only` debit of ₦1,000 on `dfca505f`;
   - a `ledger_only` credit of ₦200 on `91b0afb4`;
   - four `late_recorded_payout` entries of ₦100;
   - the ₦32,350 as decided.

   The approver must not be the payee's account holder.
5. **Reconcile:** after each correction, `admin_earnings_reconciliation()` (§3a) moves by exactly the amount. Record the ₦40 fees in VENTS's books.
6. **Optional:** T5 (read-only Integrity view); O9 (history purge decision).
