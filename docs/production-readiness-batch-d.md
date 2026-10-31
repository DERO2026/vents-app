# Batch D: production readiness and approval preparation

2026-10-31, PR #82. **Prepared only.** No production access was used:
- no SQL, read-only or otherwise;
- no migrations;
- no money moved;
- no authorizations or pauses.

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
| Balance that left without a counter | **−₦4,500** | (earned − withdrawn) ₦349,400 − (balance + pending) ₦344,900 |
| **Gap** | **₦32,150** | 36,450 + 200 − 4,500 |

What this does and does not say:
- **Most of it is unledgered earnings.** It is likely credits made before every wallet credit wrote a ledger row, or credits written directly to the wallet. The evidence shows the totals, not the rows.
- **₦4,500 left the balance without any counter or ledger row.** Candidates are direct wallet edits or a refund path that skipped the ledger. It is unexplained until the rows are read.
- **The 4 cancelled ₦100 test payouts** (`3aa0f8ff`, `f9fda363`, `6ad1272d`, `56b084bb`, 2026-07-09/10) had Paystack transfer codes when cancelled, and cancelling returned their money to the wallet. **If Paystack actually paid any of them, the wallet is over by up to ₦400** (PAY-6, Paystack dashboard).
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
| D2 | `91b0afb4` ₦32,150 and `dfca505f` ₦1,000: run G1–G3, then decide (explanatory entries / reduce / increase) | paying wallet `91b0afb4` beyond ₦312,750; closing PAY-5 | per gap |
| D3 | Build the dual-control `earnings_adjustment` action (section 2) | any correction in D2 | approve the design / another mechanism |
| D4 | The identical ₦20,000 pair: one intended or both | the window (a rejection can happen before it) | reject #4 / keep both |
| D5 | Root's own ₦5,000 (`e7ca4751`) in case A | paying it | appoint a second super admin / root rejects its own request (no money leaves) / leave pending |
| D6 | Name the requester and approver for each withdrawal (section 3) | after the window | — |
| D7 | Supabase GitHub integration settings (section 5) | merging PR #82 | confirm off |
| D8 | Backup plan and drill (section 6) | the window | — |
| D9 | The 4 cancelled ₦100 test transfers: check each in the Paystack dashboard (PAY-6) | closing the `91b0afb4` gap | paid / not paid |

## 8. What changed in the repository (Batch D)

- `supabase/rollback/sources/complete_organizer_payout.prod-2026-10-30.sql`: production's captured definition.
- `scripts/local-pg-test/generators/gen_rollback_snapshot.py`: all 19 functions with sources; `supabase/rollback/pre_0201_0203_functions.sql` regenerated.
- `scripts/local-pg-test/run-rollback-snapshot-verification.sh`: checks 19.
- `scripts/ops/verify-backup-restore.sh` (new): the restore drill.
- `scripts/local-pg-test/run-backup-restore-selftest.sh` (new): its 4-check self-test.
- `scripts/local-pg-test/run-earnings-policy-verification.sh`: the duplicate-pair fixture now carries the real dates (2026-09-24).
- This document; the runbook and the master tracker updated.
