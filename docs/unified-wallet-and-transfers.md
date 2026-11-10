# Unified wallet and VENTS-to-VENTS transfers

**Status:** code, migration 0215 and tests are in this branch. **0215 is not applied to production.**

Applying 0215 enables nothing: transfers stay **off** until the VENTS Admin turns them on in Admin Console → System → Wallet Transfers.

## 1. Audit: what exists, and what is really separate

| System | Table / functions | Money | Withdrawable | Spendable in app | Changed here |
|---|---|---|---|---|---|
| VENTS Wallet (Wallet Balance) | `user_wallets`, `user_wallet_transactions` (0065) | NGN: deposits (Paystack), refunds, VC conversions | **Never.** No function debits it towards a bank. | Tickets, services; **transfers (new)** | Two ledger types and the transfer function, added |
| Earnings | `organizer_wallets`, `organizer_transactions`, `earnings_holds` (0203) | NGN: organizer ticket sales, provider bookings, representative rewards | Yes, after the settlement hold, with the PIN, via withdrawal requests (0211/0213) | No | **Unchanged** (rendered in the Earnings tab) |
| VENTS Cents | `vents_wallets`, `vc_transactions` | Points, not NGN | No (VC-to-bank retired) | Ticket redemption; Gold+ can convert to Wallet Balance (0146) | **Unchanged** |
| Withdrawal PIN | `withdrawal_pins`, `withdrawal_pin_check` (0211) | n/a | n/a | n/a | **Reused** for transfers |

### Duplication and confusion found

- **Two separate screens.** `CustomerWalletScreen` (Wallet Balance) and `WalletScreen` (Earnings) shared no layout. The "Earnings" button in the first was not a tab: it navigated to the second screen.
- **Ticket buyers sent to the earnings screen.** After paying for a ticket, buyers were shown "Your ticket is in Wallet" and taken to the organizer **earnings** screen (`'wallet'`).
- **VC conversions displayed as money out.** VC-to-wallet conversions were shown as a red **−₦** debit (`isWalletCredit` ignored `vc_conversion`).
- **False withdrawal claim.** The VENTS Cents screens told users to "withdraw from your Wallet". The VENTS Wallet is never withdrawable.
- **Push taps.** Push and notification taps had no route for `customer-wallet`.
- **Small touch target.** "Add Bank" in Earnings was an 18px touch target.

### What must stay untouched, and is

The following are not modified, and no balance or historical row is reclassified or moved:

- Paystack deposits (`initiate_wallet_deposit`, `confirm_wallet_deposit`).
- Wallet checkout for tickets and services.
- Ticket and booking refunds.
- Organizer and provider earnings and the settlement hold.
- Representative rewards.
- Withdrawals and the admin approval flow (0211/0213).
- Fees.
- VENTS Cents.

## 2. Unified wallet screen

`src/app/components/wallet/UnifiedWalletScreen.tsx` is one screen with two real tabs (`role="tablist"`):

- **Wallet Balance:**
  - spendable balance and its explanation;
  - Deposit, plus Send and Receive (only when the server reports transfers enabled);
  - a separate VENTS Cents card;
  - the full ledger with filters (All, Money in, Money out, Transfers), "Load older", and a receipt sheet for every row.
- **Earnings:**
  - an explainer;
  - the existing `WalletScreen` (`embedded`, no header): earnings, settlement, withdraw with PIN, withdrawal history, bank accounts and PIN management. Its logic is unchanged.

**Tab behavior:**
- Both panels stay mounted, so switching never reloads, resets or navigates.
- Each panel scrolls on its own.
- The header and tabs stay fixed.
- Keyboard: arrow keys switch tabs.

**Entry points:**
- `customer-wallet` opens Wallet Balance.
- `wallet` opens Earnings for organizers, providers and admins, and Wallet Balance for everyone else. That covers organizer dashboards, payout notifications, and the post-payment redirect.
- `?pay=<username>` (the Receive QR code and link) opens Send Money with that user looked up.

`CustomerWalletScreen.tsx` is removed.

## 3. Transfers: design (migration 0215)

`transfer_wallet_funds(recipient, amount_kobo, note, pin, idempotency_key)` is a `SECURITY DEFINER` function, the only path. In order:

1. **Replay.** If `(sender, key)` already exists, return it (`replayed`). The same key with a different recipient or amount is refused.
2. **Kill switch.** `app_config.disable_wallet_transfers` defaults to `true`.
3. **Attempt rate limit.** 30 attempts per hour.
4. **Input checks:**
   - amount from ₦100 to ₦200,000;
   - note up to 140 characters, control characters stripped;
   - not to self;
   - sender and recipient active, not banned, not deleted;
   - verified email;
   - sender account at least 24 hours old.
5. **PIN.** Uses `withdrawal_pin_check`: wrong attempts are counted and committed (the function returns, never raises), with a lock after 5 attempts and reset-required after 3 locks. Transfers are paused for 24 hours after a PIN reset.
6. **Locking.** Both `user_wallets` rows are locked with `ORDER BY user_id FOR UPDATE`. The fixed order means opposite transfers cannot deadlock.
7. **Re-checks under the lock.** Re-check the key; daily limits (₦500,000 and 20 transfers per rolling 24 hours); balance.
8. **One transaction:**
   - insert the `wallet_transfers` row (immutable; reference `VT…`);
   - debit the sender and credit the recipient;
   - write `transfer_out` and `transfer_in` ledger rows with the same `reference_id` and counterparty metadata;
   - insert two notifications.

   Either everything commits or nothing does. Notifications exist only if the transfer committed.

**Other functions:**
- `find_wallet_transfer_recipient(username)` finds an exact, case-insensitive username. More than one match is refused as **ambiguous**. It returns only `id`, `username`, `name`, `avatar_url` and `is_verified`: never a balance, email or phone. It is limited to 60 lookups per hour.
- `get_my_wallet_transfer_status()` returns the switch state, limits, today's usage and PIN state.
- `get_my_wallet_transfer(reference)` returns the receipt, to the two parties only.

**Not offered: search by phone.** `users` has no verified-phone field, so a phone match could not be verified. Username search only, per "never an unverified recipient".

### Financial invariants (tested)

- **No new money.** Total Wallet Balance across all users is unchanged by any transfer.
- **Ledger equals balance.** For every wallet, `balance` = Σ(deposit, refund, vc_conversion, transfer_in) − Σ(spend, transfer_out).
- **Matched pairs.** Every transfer has exactly one `transfer_out` and one `transfer_in` row with the same reference, and one immutable `wallet_transfers` row.
- **No overdrafts.** A balance never goes negative (also a CHECK constraint).
- **No double sends.** A retry, double click or parallel retry never sends twice.
- **Separation.** Earnings and VENTS Cents are never read or written by 0215.
- **No direct client access.** Clients cannot read `wallet_transfers`, write the ledger or change a balance directly.
- **Deleting an account.** Hard-deleting a party nulls the link (`ON DELETE SET NULL`). The other party's record, the original ids and the username snapshots are kept.

### Rollback (`supabase/rollback/undo_0215.sql`)

- **Always:** drops every transfer function, so no new transfers are possible.
- **If no transfer was ever made:** also drops the table, ledger types, indexes and the column. This is an exact return to pre-0215 (verified by a schema hash).
- **If transfers exist:** keeps their records, ledger rows, types and the switch (set off). Balances are not reversed.

## 4. Risks and decisions for the owner

- **Limits are proposals.** ₦100–₦200,000 per transfer, ₦500,000 and 20 per day, 24-hour account age. They are in `wallet_transfer_policy()`; change them before enabling if needed.
- **Chargeback exposure.** A card deposit can be sent to someone else before a Paystack chargeback arrives. The Wallet Balance is never withdrawable, which limits this to in-app spending, but the risk is real.
  - Options before enabling: a hold on newly deposited money, or lower limits for new accounts.
- **Irreversible.** Transfers cannot be reversed; the UI says so before the PIN. Disputes need a manual, audited process (none exists yet).
- **No in-app QR scanner.** The QR code encodes `https://getvents.com/?pay=<username>`. A phone camera opens it; there is no in-app scanner.
- **One PIN for both.** The PIN is the existing withdrawal PIN, now described as protecting withdrawals and transfers. Users without one create it inside Send Money.

## 5. Verification

- **`scripts/local-pg-test/run-wallet-transfer-verification.sh`:** 102 checks, local Postgres only. Covers the switch, lookups, the transfer path, idempotency, every rule, the PIN, daily and rate limits, concurrency, and spending received money:
  - concurrency: 4 parallel overspends, 5 parallel same-key retries, 12 opposite transfers;
  - spending: a real wallet ticket checkout and refund through the existing functions;
  - plus immutability, account deletion, and rollback with and without transfers.
- **Unit and component tests:**
  - `src/lib/walletTransfers.test.ts`: parsing, policy mirror, links, keys, display direction.
  - `src/app/components/wallet/UnifiedWalletScreen.test.tsx`: tabs, separation, history, receipts, Send, PIN creation, `?pay=`, Receive.
  - `src/lib/unifiedWalletWiring.security.test.ts`: entry points, migration boundaries.
- **Browser (Chromium, mocked backend):** checked at 360, 390, 820 and 1280px across the balance tab, earnings tab, Send review, Receive and the receipt. No horizontal overflow, clipped controls or buttons under 36px. The previously too-small "Add Bank" button was fixed.
