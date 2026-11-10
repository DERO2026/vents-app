# Wallet transfers (0215): production rollout and end-to-end test plan

Nothing here has been run against production. Every step marked **[owner]** needs the owner's explicit go-ahead.

## Current state (2026-11-10)

| Item | State |
|---|---|
| Frontend | getvents.com = `dpl_34rMQ4ydQiu4k8n72vC6xDKLkiCC`, commit `0677d97` (PR #102 + #103). The unified wallet is live. |
| 0213 (VENTS Admin payout authority) | Applied 2026-11-10, per the rollout record. |
| 0214 (payouts list) | Not applied. The screen falls back to 0213. |
| 0215 (transfers) | Not applied. The live wallet shows only Deposit; Send and Receive are hidden, because `get_my_wallet_transfer_status` does not exist yet. |

## 1. Pre-flight (read-only)

These are read-only checks, but they still run SQL against production. They need the owner's go-ahead, because the standing rule forbids even read-only production SQL without approval.

1. Backups:
   - confirm a fresh `pg_dump`/PITR point exists;
   - record `SELECT now()`.
2. Drift checks that 0215's own guard also enforces:
   - `pg_get_constraintdef` of `user_wallet_transactions_type_check` lists exactly `deposit, spend, refund, vc_conversion`;
   - these functions exist: `withdrawal_pin_check(uuid,text)`, `withdrawal_naira(bigint)`, `check_rate_limit(text,int,int)`, `is_root()`, `is_email_verified()`, `actor_role()`;
   - `users` has `status`, `banned_until`, `deleted_at`, `created_at`, `is_verified`, `username`.
3. Baseline numbers, to compare after:
   - `SELECT count(*), sum(balance_kobo) FROM user_wallets;`
   - `SELECT type, count(*), sum(amount_kobo) FROM user_wallet_transactions GROUP BY 1;`
   - a ledger-equals-balance check: the number of wallets whose balance does not equal the signed sum of their ledger rows (expected: the same count as today; record it).
4. Duplicate-case usernames (these become "ambiguous" and can't receive money):
   `SELECT lower(username), count(*) FROM users GROUP BY 1 HAVING count(*) > 1;`

## 2. Apply 0215 **[owner]**

Use the same verified process as 0211–0213:
1. Fetch the file from `main` at a pinned commit and compare its md5 with the reviewed file.
2. Apply it in **one transaction**. It is idempotent, and its guards abort with nothing changed.

The migration also builds an index, `users_lower_username_idx`. A plain `CREATE INDEX` briefly locks writes to `users`. The table is small, but apply off-peak.

**After applying (read-only):**
- `wallet_transfers_disabled()` = `true`.
- Clients have no privileges on `wallet_transfers`, `user_wallets` or the ledger (the migration's post-check enforces this).
- Baseline numbers are unchanged: 0215 moves no money.
- In the app, the wallet still shows only Deposit, and System → Wallet Transfers shows **Off**.

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
