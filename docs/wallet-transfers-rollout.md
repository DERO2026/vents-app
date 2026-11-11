# Wallet transfers (0215): production rollout and end-to-end test plan

Nothing here has been run against production. Every step marked **[owner]** needs the owner's explicit go-ahead.

## Current state (2026-11-11)

| Item | State |
|---|---|
| Frontend | getvents.com = `dpl_34rMQ4ydQiu4k8n72vC6xDKLkiCC`, commit `0677d97` (PR #102 + #103). The unified wallet is live. |
| 0213 (VENTS Admin payout authority) | Applied 2026-11-10, per the rollout record. |
| 0214 (payouts list) | Not applied. The screen falls back to 0213. |
| 0215 (transfers) | Not applied. The live wallet shows only Deposit; Send and Receive are hidden, because `get_my_wallet_transfer_status` does not exist yet. |

## 1. Pre-flight (read-only) **[owner approval: production read]**

Two things come first:
- **A fresh backup encrypted with the independent passphrase.** Its manifest must show `key_source=passphrase-secret`, and its `key_fingerprint` must match your own copy (see `docs/db-backup.md`). Runs #20 and #22 used the URL-derived key and don't count.
- **The 0215 file on `main` is unchanged:** md5 `5cb9a53d20269292b59dc67fc935167a`.

Then run **`supabase/preflight/0215_preflight.sql`** (md5 `3c62ebb714fc4408cfe83cfea2390e8d`) once, as the role that will apply 0215 (Supabase MCP `execute_sql`, or the SQL editor). It's one `SELECT` inside `BEGIN TRANSACTION READ ONLY … ROLLBACK`, and it returns one JSON document:

- `read_only` must be `"on"`. That proves PostgreSQL would have refused any write.
- `blockers` must be `[]`. **Anything listed is a STOP.** So is any error from the script.
- `baseline`: write the values down. After applying, they must be identical.
- `timing`: decides when to apply (see below).

It reads only catalogs, counts and sums. It calls no user-defined function, writes nothing, and prints no names, usernames, emails, IDs or query text.

| Check | What it guards | Expected | STOP if |
|---|---|---|---|
| Q1 `read_only` | The run itself | `on` | anything else |
| Q2 ledger CHECK | 0215 replaces this constraint; its own guard accepts one set | deposit, refund, spend, vc_conversion | any other set |
| Q3 ledger types in use | Re-adding the CHECK | Subset of those four | any other type |
| Q4 functions | `withdrawal_pin_check` (jsonb), `withdrawal_naira`, `check_rate_limit`, `is_root` (bool), `is_email_verified` (bool), `actor_role` (text), `auth.uid()`, `gen_random_uuid()` | All present, return types as listed | missing or different. PL/pgSQL only notices at call time, after 0215 is in. |
| Q5 tables, columns, uniques | Every column the function bodies use; `user_wallets(user_id)` unique (`ON CONFLICT (user_id)`); `users(id)` unique (foreign keys) | Nothing missing | anything missing. Transfers would fail at runtime even though the migration "succeeds". |
| Q6 notifications | Both notifications are inserted with type `'sale'` | Allowed, or no type CHECK | not allowed: every transfer would roll back |
| Q7 0215 names | The table, 6 indexes, trigger, column, and **all 10 function names with any signature** | None exist | any exists. `CREATE OR REPLACE` would silently replace it, and `undo_0215` would later drop it. |
| Q8 `app_config` rows | The kill switch reads `LIMIT 1`; the toggle updates every row | 1 | not 1 |
| Q9 baseline | Money totals: user wallets, ledger by type, wallets ≠ ledger, organizer wallets | Record them | doesn't block; must be unchanged after applying |
| Q10 case-twin usernames | Those users can't receive transfers ("ambiguous") | Ideally 0 | doesn't block: fix those accounts before going live |
| Q11 timing | Table sizes; other transactions open over 30s; locks on the four tables | Small; 0; 0 | doesn't block: pick another time |
| Q12 client write privileges | `authenticated`/`anon` can't write `user_wallets` or the ledger | false | true. A live security issue, and 0215's post-check would abort. |
| Q13 ownership | The applying role can `ALTER` users, ledger and `app_config` | none listed | any listed |

## 2. Apply 0215 **[owner approval: separate]**

**What 0215 locks, all held until COMMIT:**

| Object | Statement | Lock | Effect while it runs |
|---|---|---|---|
| `user_wallet_transactions` | Drop and re-add the type CHECK (full scan); 2 unique partial indexes | ACCESS EXCLUSIVE | Ledger reads **and** writes wait: deposits, wallet payments, refunds, history |
| `users` | `CREATE INDEX` on `lower(username)`; foreign keys from `wallet_transfers` | SHARE + SHARE ROW EXCLUSIVE | Writes to `users` wait (sign-ups, profile edits); reads continue |
| `app_config` | `ADD COLUMN … DEFAULT true` (metadata only) | ACCESS EXCLUSIVE | Anything reading `app_config` waits |

No data is rewritten, and the tables are small, so the expected hold is well under a second. The risk is **queueing**: if another transaction holds one of these tables, 0215 waits, and every new request on that table waits behind 0215. Hence:

**Apply exactly this, as one transaction:** the header `supabase/preflight/0215_apply_header.sql` followed by `supabase/migrations/0215_wallet_transfers.sql`, both verbatim, nothing else.
- With the Supabase MCP `apply_migration`, the query is that concatenation, with no `BEGIN`/`COMMIT` of your own. The tool supplies the transaction, and the header's guard proves it did.
- In the SQL editor or psql, wrap it: `BEGIN;` header + file `COMMIT;` (psql: `psql -1 -v ON_ERROR_STOP=1`).
- For `apply_migration`, the md5 of that concatenation is **`d8472de58666fcba90c175fbd046d063`**. Compare it with the history row's `statements` afterwards. Name: `0215_wallet_transfers`.
- The header sets `lock_timeout = '5s'` and `statement_timeout = '60s'` with **`SET LOCAL`**, so only this transaction is affected. No role, database or session default changes. Its guard aborts before any DDL if `SET LOCAL` didn't take effect, which happens when the statements aren't running in one transaction.
- If it hits the lock timeout, nothing has been applied. Run the preflight's Q11 again and retry off-peak. Never raise the timeout to "push it through".
- Never `supabase db push`.

All of this was rehearsed locally (`scripts/local-pg-test/run-wallet-transfer-verification.sh`, 116 checks):
- outside a transaction, the guard stops before any DDL;
- with a session holding `app_config`, 0215 fails after 5s and changes nothing;
- after COMMIT, a new session has the default timeouts;
- the preflight passes before 0215, blocks re-apply after it, and passes again after `undo_0215`.

**After applying (read-only, separate approval):**
- `wallet_transfers_disabled()` = `true`. Transfers stay off.
- Baseline numbers unchanged. 0215 moves no money.
- Running the preflight again now reports exactly one blocker (Q7: the objects exist). That proves it applied.
- In the app, the wallet still shows only Deposit, and System → Wallet Transfers shows **Off**.

**Rollback safety:**
- `undo_0215` is only exact if Q7 was clean. It drops every 0215 function name, and it drops `users_lower_username_idx` when no transfer exists.
- While transfers are off and unused, it restores the pre-0215 schema exactly.
- After any transfer, it keeps the records and only switches transfers off.
- It takes the same locks as 0215, so use the same `lock_timeout` approach.

## 3. Internal test with transfers on **[owner]**

1. The VENTS Admin turns transfers **on** in System. This is logged in `admin_logs` as `set_wallet_transfers_enabled`.
2. Run the end-to-end plan in section 5 with two real, staff-owned accounts and small amounts (₦100–₦1,000), funded by real deposits.
3. Turn transfers **off** again if anything is unexpected. That is immediate and moves no money.

## 4. General availability **[owner]**

- **Limits.** Confirm or change the limits in `wallet_transfer_policy()` (₦100–₦200,000 per transfer; ₦500,000 and 20 transfers per day; account at least 24 hours old). Changing them is a one-function migration.
- **Chargebacks.** Decide on chargeback exposure. The options are a hold on newly deposited money, lower limits for new accounts, or accepting the risk. Spendable money is never withdrawable, which limits loss to in-app spending.
- **Support.** Write the support note: transfers are irreversible, and there is no dispute flow yet.
- **Rollout.** Enable, then watch the first 24 hours: wallet totals, the ledger check and Sentry.

## Rollback

| Situation | What to do |
|---|---|
| Anything unexpected | **Turn transfers off.** Immediate; no data changes. |
| Never used | `undo_0215` (with `SET vents.rollback_confirm = 'undo-0215'`) restores the exact pre-0215 schema. |
| Used | `undo_0215` drops every transfer function and keeps the records, ledger rows and types. No balances are reversed: transfers are history. |

## 5. End-to-end test plan (two staff accounts, A and B; transfers on)

| # | Step | Expected |
|---|---|---|
| 1 | A deposits ₦1,000 by card (Wallet → Deposit) | Wallet Balance +₦1,000; "Deposit · Added via Paystack" row; receipt shows the Paystack reference |
| 2 | A: Send → `@B` → ₦500, note "test" → Review → PIN | Review shows B's name and username, ₦500, "Free", "cannot be reversed". Success shows a `VT…` reference |
| 3 | A's history | "Money sent · To @B · −₦500"; receipt: Completed, reference, note |
| 4 | B's history and notifications | "Money received · From @A · +₦500"; a "Money received" notification; same reference |
| 5 | B pays for a ₦500-or-less ticket with the wallet | Checkout succeeds; "Ticket purchase · Wallet payment" row |
| 6 | Organizer refunds that ticket | B's wallet is credited; "Refund" row |
| 7 | A sends more than the balance | Blocked before the PIN ("More than your VENTS Wallet balance"). Forced through the API, the server returns `insufficient_funds`; nothing moves |
| 8 | A double-taps Send, then retries after a network drop | Exactly one transfer; the retry says it already went through |
| 9 | Wrong PIN 5 times | Attempts left shown; then locked; nothing moves; withdrawals are locked too (same PIN) |
| 10 | Send to own username / unknown username / suspended account | "That is your own username" / "No VENTS user has that username" (twice) |
| 11 | Turn transfers off; reopen the wallet | Send and Receive hidden; an API call returns `transfers_disabled` |
| 12 | B: Receive → QR code scanned with A's phone camera | Opens getvents.com, then Send Money to `@B` (after login) |
| 13 | Earnings tab for an organizer | Earnings, settlement, Withdraw and PIN all unchanged; the withdrawal flow is unaffected |
| 14 | After all tests | Sum of all wallet balances changed only by the deposits and the refunded ticket; ledger check unchanged; `wallet_transfers` rows = transfers made |

These steps are also covered locally by `scripts/local-pg-test/run-wallet-transfer-verification.sh` (104 checks) and the wallet component tests. Section 5 is the production confirmation.

## Withdrawals and approval: current model (for testers)

Since 0213, withdrawals do **not** use two approving admins:
1. The user requests a withdrawal with their 4-digit PIN (0211).
2. Admins and sub-admins may review it: forward, or recommend rejection. This is advisory.
3. **Only the VENTS Admin** approves the payment, then Authorize & Pays with the 10-digit Admin Payout PIN.
4. The Paystack webhook (or Reconcile) marks it paid or failed.

Admins can reject; sub-admins cannot. All of this is enforced in the database, and verified locally:
- `run-withdrawal-pin-approval-verification.sh`: 149/149;
- `run-payout-authorization-verification.sh`: 141/141;
- `run-payout-list-verification.sh`: 104/104.

A real transfer succeeded in production on 2026-11-10 at 21:59 UTC: the `transfer.success` webhook marked it completed.
