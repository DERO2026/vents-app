# Admin Payouts screen: newest first, every allowed action (0214)

**Status:** code and migration in this branch. **0214 is not applied to production.** It needs explicit approval and goes through the usual verified-apply process: fetch, md5, one transaction.

## Root causes

### 1. Oldest first (server)

0213's `admin_list_withdrawals` ordered open requests `created_at ASC`. In `all` it also put every open request above every closed one, so a new withdrawal landed at the bottom of the list.

0214 orders every scope `created_at DESC, id DESC`.

### 2. No pagination (server and screen)

There was a single `LIMIT`, and the screen asked for 200 rows. Anything past that limit could not be reached.

0214 adds a keyset cursor, `p_before_created_at` + `p_before_id`, which is the last row of the previous page. Ties on `created_at` are broken by `id`, so pages never skip or repeat a row.

The screen loads 50 rows at a time and shows **Load 50 older requests** until the end. A refresh reloads as many rows as are already shown.

### 3. The screen guessed at actions the server never described

| Gap | What happened |
|---|---|
| Processing cards | No buttons at all. |
| Bank change (0207) | Hidden from sub-admins. 0207 lets any admin request a move; a super admin approves it. |
| Review modal | Offered **Forward** on accounts that `admin_review_withdrawal` refuses to forward. |
| Sub-admin note | Told sub-admins to "Reject". Sub-admins cannot reject. |

0214 returns the missing flags. Each one mirrors the function that performs the action:

| Flag | True when | Function |
|---|---|---|
| `can_forward` | pending, unapproved, not the VENTS Admin, not own, bank active and verified | `admin_review_withdrawal(..., 'forward')` |
| `can_reconcile` | processing, full admin or VENTS Admin | reconcile-payouts / `admin_list_processing_payouts` |
| `can_cancel` | processing, full admin, payouts not paused, **no transfer code and no reference** | `admin_cancel_processing_payout` (0202) |
| `can_request_bank_change` | pending, unapproved, never sent, not own | `admin_request_withdrawal_bank_reassignment` (0207) |
| `bank_problem` | `missing`, `inactive`, `unverified`, `changed_since_approval` | (why a transfer is blocked) |

The acting functions are **unchanged** and still decide.

### 4. Stale list after Reconcile

The screen-wide Reconcile reloaded only the wallets, so a request Paystack had already paid still showed as Processing.

Reconcile is also no longer shown to sub-admins. `admin_list_processing_payouts` refuses them.

### 5. Mobile

The admin bottom nav was `height: 60` with border-box sizing and `env(safe-area-inset-bottom)` padding. On iPhones with a home indicator, that shrank the tabs. The content's 76px bottom padding didn't account for the inset.

Now the nav height is `60px + inset`, and the content padding is `84px + inset`. Card actions sit together in a footer, are at least 44px tall, and wrap two per row on a 360px screen.

### 6. Dead code

The 0211 two-admin helpers in `src/lib/withdrawals.ts` were removed. They called functions 0213 closed, and nothing imported them.

The Admin Actions `authorize_withdrawal` label stays. It only describes historic requests, which 0213 closed, and the request trigger refuses new ones.

## What changes in each card

Every card shows:
- stage, amount and user;
- bank account and its verification, with ✓ or the reason it fails;
- request date and reference (with **Copy reference**);
- wallet available and pending balance;
- next step and review history (the latest 2, expandable).

Every action this admin may take sits at the bottom of the card, in this order:

> Review · Approve for Payment · Authorize & Pay · Check with Paystack · Move to another bank account · Cancel (never sent) · Reject

Closed requests say they are final and why there is nothing to do. When the kill switch is on, the money buttons stay visible but disabled, with the reason shown. Check with Paystack still works.

## Compatibility and deploy order

The two halves can be deployed in either order:

| Combination | Behavior |
|---|---|
| New screen on 0213 | The first page has no cursor. Because 0213 is oldest-first and cannot page, the screen reads up to 0213's maximum (500) and sorts the rows itself. **Load more** is not offered, and the list says older pages need 0214. Bank-change visibility falls back to 0213's rule. |
| Old screen on 0214 | `{ p_scope, p_limit }` calls still resolve, through the defaults. The rows are newest first, and the extra columns are ignored. |

**Rollback:**
- `SET vents.rollback_confirm = 'undo-0214';` then `supabase/rollback/undo_0214.sql`. This restores 0213's function byte-for-byte and drops the index.
- `undo_0213` now refuses while 0214 is applied.

**Drift guard:** 0214 refuses to run unless `md5(prosrc)` of the live `admin_list_withdrawals(text, integer)` is `1f7936a662d93b405a6be30eb903bf79`. That is 0213's body as the 0213 file creates it.

This was **not checked against production**: no production SQL was run. A mismatch only makes 0214 stop, with nothing changed.

## Verification

### Database: `scripts/local-pg-test/run-payout-list-verification.sh`

104 checks, all passing, against local Postgres only. They cover:
- **Ordering:** every scope, for every role, is `created_at DESC, id DESC`, and a new withdrawal is row 1.
- **Pagination:** keyset walks with page sizes 1, 2 and 3 return every row exactly once, including equal timestamps.
- **Action flags:**
  - 216 combinations of role (VENTS Admin, admin, sub-admin), status (pending review, forwarded, rejection recommended, approved, processing with and without a reference, paid, failed, rejected, cancelled) and action are executed against the real functions, each in a rolled-back transaction.
  - Every flag equals the server's decision.
  - The VENTS Admin's own withdrawal and the kill switch are covered.
- **Bank problems:** missing, inactive, unverified and changed since approval, each with the server refusing forward, approve or pay.
- **Rollback:** 0214 is idempotent and refuses a drifted body. `undo_0214` restores the exact 0213 state, and 0214 re-applies to the same state.

`run-payout-authorization-verification.sh` (0213) still passes 141/141.

### Unit tests

| File | Covers |
|---|---|
| `PayoutRequestsPanel.test.tsx` | order and ties; Load more cursor, dedupe and end; refresh keeps loaded rows and puts new ones on top; 30 s refresh paused while a dialog is open; scopes; the 0213 fallback; a role × status button matrix; bank problems; forward blocked; Check with Paystack and its failures; Cancel with a double click; Authorize & Pay on a 502 (key kept, replay safe) and on a lock (new key); kill switch; touch sizes |
| `AdminPayoutsScreen.reconcile.test.tsx` | Reconcile hidden from sub-admins; the list is re-read afterwards |
| `api/_lib/reconcileSingleRequest.security.test.ts` | one-request reconcile narrows the list only; a non-processing, unknown or malformed id touches neither Paystack nor the money functions |

### Browser

A real AdminConsoleShell and Payouts screen ran in Chromium with a mocked backend at 360×740, iPhone 13 (390×844) and 820×1180, with 10 cards in every state. For all 14 action buttons:
- no sideways scroll;
- nothing clipped, overlapping or obscured;
- each at least 44px tall;
- the end of the list sits above the bottom nav.

Chromium reports `env(safe-area-inset-bottom)` as 0. The notch fix follows from the CSS but needs a check on a real iPhone.

## Not done here

- 0214 is not applied to production, and nothing is deployed.
- Nothing ran against production data or Paystack. No real transfer was made.
- Login, PIN entry and Paystack were not exercised end to end against the live backend. That needs the VENTS Admin's account.
