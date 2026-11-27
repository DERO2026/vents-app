# Batch 1: financial integrity and access hardening (2026-11-27)

Code, tests and migrations are on `main`. **No migration below (0233–0238) has been applied to production.** Each one needs the owner's explicit approval, a fresh verified backup, and the read-only prechecks below. The web app deployed with this batch works with or without them (details per item).

Confirmed policies are unchanged:
- Withdrawals: the Super Admin alone approves, with the 10-digit PIN (0213).
- Fees: 1.5% attendee / 3.5% organizer (0208).
- Settlement: earnings release 48 hours after the event or service (0203). Representative rewards keep their 7-day hold (0201).
- Refund shortfalls: recovered from future earnings (0203).
- Payments without an issued ticket: refunded only with two admins (new, 0234).

## What changed

| ID | Finding | Root cause | Fix | Migration | Suite (local PostgreSQL) |
|---|---|---|---|---|---|
| AZ-09 | Payout rejection could credit a wallet twice | **Corrected: already fixed.** Production's `admin_reject_organizer_payout`, captured read-only on 2026-10-30, already claims the row atomically: `UPDATE … WHERE status = 'pending' RETURNING`. Its logic is the same as 0187's reject. No later migration redefines it. The audit read the older 0124 body. | None needed. Proven: 2 and 5 concurrent rejections, and Admin Actions racing a direct reject, credit exactly once. The old 0124 body fails the same test (double credit). **Never apply 0187:** its cancel function would overwrite 0202's. | — | `run-payout-reject-concurrency-verification.sh` (43) |
| AZ-08 | Transfer-fee payments lost on retry, duplicates unrecorded | One column (`ticket_transfers.fee_payment_ref`) held only the newest reference. Every retry overwrote it, and every lookup used it. | Every attempt is kept. Whichever payment lands first owns the transfer, even an older attempt. Duplicate, unknown and wrong-amount payments become payment exceptions for the two-admin refund. They are never auto-refunded and never move the ticket twice. | **0233** | `run-transfer-fee-attempts-verification.sh` (56) |
| AZ-10 | Refunds of payments without a ticket were one person's call | `admin_resolve_payment_exception` let one Super Admin close the record. The refund itself was done by hand in Paystack. | **Request:** any admin or sub-admin. **Approval:** a different Super Admin, in Admin Actions, bound to the same reference, amount (never more than Paystack captured) and reason. **Then:** a Super Admin sends it to Paystack. The payment is claimed exactly once, and the webhook closes it. | **0234** | `run-payment-exception-refund-verification.sh` (68) |
| AZ-32 | `boost_event_vc` callable by any signed-in user | Over-wide grant in 0011. The function charges 1,000 VENTS Cents for a boost nothing reads. | EXECUTE revoked from anon and authenticated. The server role keeps it. | **0235** | `run-access-hardening-verification.sh` (50) |
| AZ-16 | Drafts and admin-hidden events readable by anyone | 0008's `select_events` admitted every non-deleted row. | Non-owners see only events that aren't deleted, drafts or hidden. Organizers, admins and sub-admins see everything as before. Ticket holders keep access to their event. | **0236** | same |
| Policy (2026-11-27) | Transfer-fee refunds were automatic | 0064: when a paid transfer couldn't complete, the webhook refunded the fee through Paystack with no admin involved. | The same cases now record a payment exception for the exact reference and amount charged, and go through the 0234 two-admin flow. Nothing is refunded automatically. The webhook and the buyer's verify screen say "refund requested for review". Owed refunds that never started are backfilled into the queue. | **0238** | `run-transfer-fee-refund-two-admin-verification.sh` (47) |
| AZ-33 | Anyone could review any organizer | `organizer_reviews` checked only the reviewer id. (The app has no event-review screen; service reviews already need a completed booking, 0099.) | A review needs an active, paid, checked-in ticket for one of that organizer's events. No self-reviews. | **0237** | same |

App code changes:
- `api/wallet/refund-ticket.ts`: new `payment_exception_id` mode, with the same uncertain-outcome rule as ticket refunds.
- `api/webhook/paystack.ts`: payment-exception refunds are the last link of the refund webhook chain. Before 0234 they read as not found, so the webhook answers 200 and Paystack doesn't retry.
- Admin → Payouts → Payment exceptions panel: shows only the next step of the refund flow.
- Admin Actions: shows a label for refund requests.

## 1. Backups (must be working before any migration)

**Status on 2026-11-27:** every scheduled run since 10 Nov has failed (latest: run #43, 10:52 UTC) with `BACKUP_ENCRYPTION_PASSPHRASE is missing or empty` in the `o4-backup` environment. Nothing else in the pipeline is broken.
- The last good backup is run #22 (11 Nov). It expires 2026-12-11 and uses the legacy key; recover it on your own machine with `docs/db-backup.md`, section "Older artifacts (key derived from the database URL)".

Owner steps. Nothing is pasted into chat, a terminal or a file in the repository.
1. **Create a passphrase** of at least 32 characters, with no leading or trailing spaces.
   - Generate it in your password manager, or on your own computer (`openssl rand -base64 48`), and save it in the password manager first.
   - GitHub can never show it back, and without it the backups can't be decrypted.
2. **Add the secret.** In GitHub, go to **Settings → Environments → o4-backup → Environment secrets → Add secret**.
   - Name: `BACKUP_ENCRYPTION_PASSPHRASE`
   - Value: paste from the password manager.
   - Leave `DATABASE_URL` as it is (you confirmed the database password has not changed).
3. **Run it once.** In GitHub, go to **Actions → Database backup → Run workflow** on `main`, with `dump_scope = full` and `function_check = report`.
4. **A backup counts as valid only if the run is green and its summary or manifest shows all of these:**
   - `key_source=passphrase-secret`
   - a `key_fingerprint` that matches the one `scripts/ops/db-backup-key-fingerprint.sh` computes on your machine from the same passphrase
   - a `sha256=`
   - `restore_tables=N/N` and `restore_rows=N/N` (both numbers equal)
5. **Optional local drill:** download the artifact, then run `scripts/ops/db-backup-decrypt.sh` and `scripts/ops/verify-backup-restore.sh` on your machine (`docs/db-backup.md`).
   - The scheduled run already does this restore on a throwaway database.
6. **Before each migration window, start a fresh run** (step 3) and wait for it to be green. The migration window uses that backup.

## 2. Production migration state: read-only check

`scripts/ops/batch1-migration-state-check.sql`. **Not run against production. It needs your authorization.**

- **Read-only.** It runs in a `READ ONLY` transaction that is rolled back, with 30 s statement and 2 s lock timeouts. It reads only catalog metadata: functions, policies, constraints, privileges, and the migration-history names if that table exists. No table rows, no user data, no secrets. A write slipped into it is refused by PostgreSQL (tested).
- **Reports, in one table:**
  - per migration (0226, 0233–0238): APPLIED, MISSING or PARTIAL, with each marker;
  - each installed function's fingerprint against the repository: MATCHES, DIFFERS or absent, accepting a later Batch 1 migration's deliberate replacement;
  - READY or BLOCKED for every migration not yet applied;
  - the AZ-09 reject check;
  - the last 15 migration-history entries.
- **How to run:** Supabase dashboard → SQL editor → paste the file → Run. Or from your machine: `psql "<from your password manager>" -X -f scripts/ops/batch1-migration-state-check.sql`.
- **Tested:** `run-batch1-migration-state-check-verification.sh` (35 checks). It covers before Batch 1, after each migration, a partial apply, a hand-edited function, missing 0226, migration-history listing, read-only proof, and no connection details in the output.

**Stop rules:**
- Any **PARTIAL**, any **DIFFERS** on a migration you are about to build on, or AZ-09 not **OK**: apply nothing, and send me the output.
- A precheck **BLOCKED** for the next migration in the plan: stop at that migration.

## 3. Dependency report (re-verified 2026-11-27)

| Migration | Requires (it refuses otherwise) | Replaces | Replaced later by | Webhook / app compatibility |
|---|---|---|---|---|
| 0226 | core tables | — | 0234 (list, resolve) | The deployed webhook already calls `record_payment_exception`. Without 0226, a payment that can't become a ticket gets a 500, and Paystack retries. |
| 0233 | 0226; 0064; the 0043/0064 versions of initiate, owner and confirm (md5) | initiate, owner, confirm | 0238 (confirm) | Same signatures and same answers, plus `duplicate_payment`. The deployed webhook and verify path handle all of them. |
| 0234 | 0233; 0226's list and resolve (md5); maker-checker with the 0207 anchor exactly once | list, resolve; patches approve/request_admin_action | 0238 (finalize, fail) | The panel and refund route detect the refund columns. On a database without 0234 they keep the old record-only flow. |
| 0238 | 0233 and 0234 (md5 of confirm, finalize, fail) | confirm, finalize, fail | — | The deployed webhook understands `:refund_queued`. On a database without 0238, `:refund_claimed` keeps the old automatic refund. |
| 0235 | — | grants only | — | The app never calls `boost_event_vc`. |
| 0236 | 0008's `select_events`, and no other SELECT policy on events | `select_events` policy | — | Search, feeds, Featured and Trending already show only live events. Owners, admins and ticket holders keep access. |
| 0237 | 0008's review policies | review insert and update policies | — | No review screen in the app. |

**Unaffected by Batch 1:** withdrawals (0211–0213), fees (0208), settlement (0203), representative rewards (0201/0216/0217), and payout reject/cancel (0202). Never apply 0186 or 0187.

## 4. Exact production plan (needs your explicit approval)

Each window: a fresh green backup (§1) → run the state check (§2) and confirm READY → apply the migration file exactly as in the repository → run the state check again and confirm APPLIED and MATCHES → smoke test.

| Window | Apply | Why grouped | Smoke test after |
|---|---|---|---|
| W1 | **0226**, only if the state check says MISSING | The deployed webhook already needs it | Admin → Payouts → Payment exceptions opens without an error |
| W2 | **0233 → 0234 → 0238**, in one sitting, in this order | Between 0233 and 0238, failed transfers are still refunded automatically (the 0064 behaviour) | Payment-exception panel shows the refund flow. Admin Actions accepts a refund request. A test transfer you start and then cancel shows "refund requested for review" (no real money: stop at the Paystack page) |
| W3 | **0235, 0236, 0237** (any order) | Independent | Signed-out home feed and search work. An organizer sees their drafts. My Tickets opens for a ticket holder |

After W2:
- The backfill notice reports how many owed transfer-fee refunds moved to the two-admin queue.
- Those, plus any duplicates, are refunded only when two admins approve them in the panel. That is a money movement and needs your go-ahead per refund.

**Owner check (read-only, optional):** confirm the representative-reward hold is still 7 days, since it can be changed by a two-admin settings action:
```sql
SELECT settlement_hold_days FROM public.earn_settings;
```

## 5. Rollback limitations

Every undo:
- is gated by `SET vents.rollback_confirm = 'undo-NNNN';`;
- refuses unless its migration is applied;
- runs in **reverse order only**: undo_0234 refuses while 0238 is applied, and undo_0233 refuses while 0234 is.

| Undo | Refuses while | What it can't give back |
|---|---|---|
| undo_0238 | — (gate only) | It re-enables **automatic** transfer-fee refunds, against your 27 Nov decision. Queued exceptions stay and remain refundable. |
| undo_0234 | a refund is requested and waiting, approved, or in flight | Drops the per-row refund columns. Refunded rows keep their resolution note; `admin_logs` keeps the history. |
| undo_0233 | transfer-fee exceptions exist, or duplicate or wrong-amount attempts are recorded | Drops the attempts table, so attempt history is lost. That is why it refuses while money records exist. |
| undo_0235 / 0236 / 0237 | — | Re-opens what they closed (boost by users, public drafts, unrestricted reviews). |

Nothing in Batch 1 changes a balance, ticket, payout or ledger row. The only data written are new records: attempts, payment exceptions and their refund state, and the 0238 backfill of owed refunds into the queue.

## 6. Financial integrity verification (local, 2026-11-27)

| Property | Evidence |
|---|---|
| Payout rejection can't double-credit | `run-payout-reject-concurrency-verification.sh`: 2- and 5-way races credit once; the old body fails (mutation) |
| Transfer payment attempts traceable | `run-transfer-fee-attempts-verification.sh`: every reference kept; late, out-of-order and concurrent payments |
| Duplicate successful payments detected | same suite: recorded once, never re-applied |
| Two-admin refund approval | `run-payment-exception-refund-verification.sh` and `run-transfer-fee-refund-two-admin-verification.sh` |
| Withdrawal: Super Admin + 10-digit PIN | `run-payout-authorization-verification.sh` (unchanged by Batch 1) |
| Fees 1.5% + 3.5% | `run-fee-model-0208-verification.sh` |
| Settlement within 48 h | `run-earnings-policy-verification.sh` |
| Representative reward hold 7 days | `run-representative-rewards-verification.sh` (default 7, 0201); live value: owner query above |
| Refund shortfall recoverable | `run-earnings-policy-verification.sh` (recovery receivable, never negative) |
