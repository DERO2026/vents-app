# Event cancellation & refunds: pre-release review (0218, fixes in 0219)

Review of PR #112 (0218) for financial correctness, security, concurrency and open policy decisions.

- **Local only.** No production SQL, no migrations applied, no Paystack calls, no money moved.
- **At the time of the review, the production state was known only from repo and deploy metadata.** AGENTS.md warns that migration headers are unreliable, so whether 0218 was live was unverified.

> **Update, 2026-11-19 (post-migration).**
> - **Before applying:** a read-only production check found neither 0218 nor 0219 installed.
> - **Applied:** both were then applied to VENTS production with owner approval: 0218 at 00:46:10 UTC, 0219 at 00:48:58 UTC.
> - **Verified against the live database objects:** the deletion guard, the cancellation workflow and refund tracking, the cancelled-event check-in guard, Super Admin-only refund processing and manual re-queue are all active.
>
> Details are in `docs/event-cancellation.md` → *Status*. The sections below are kept as written at review time.

## 0. State found at the start of the review
- **PR #112 was already merged** (`efe1882`, 2026-11-18 23:41 UTC, by the repository owner) and **deployed to Vercel production** from that commit. The request to "keep PR #112 unmerged" could not be honoured.
- **`main` matches the reviewed PR head exactly**, so nothing changed after the original report.
- **Consequence at the time:** the frontend for 0218 was live, and the database half turned out not to be applied. That gap was closed on 2026-11-19 (see the update above).

## 1. Confirmed defects (fixed in this branch; nothing policy-dependent)
| # | Defect | Fix | Proof |
|---|---|---|---|
| D1 | **An organizer could block attendee refunds by checking tickets in.** Check-in (`manual_check_in` / `verify_entry_pass`) checks only the ticket's status, so tickets of an approved cancellation could still be checked in. `refund_ticket` refuses checked-in tickets. The organizer is the party debited for refunds, so this is a conflict of interest. | 0219: trigger `tickets_cancelled_event_checkin_guard` on `tickets.checked_in` refuses check-in at a cancelled event, on every path. | Review harness R3. It fails without 0219. |
| D2 | **Uncertain Paystack outcomes were treated as rejections.** The refund API reverted a ticket to `paid` on any non-success: a 5xx, a non-JSON body, or a 2xx without a refund id. Cancellation retries failed rows automatically, so a refund Paystack actually created could be issued a second time. On a multi-ticket payment, Paystack would accept that second partial refund. | `api/wallet/refund-ticket.ts`: only a definitive rejection (4xx with `status: false`) reverts. Everything else stays `refund_pending` with no refund id, flagged "check Paystack before reverting". An 8 s timeout was added, below the 10 s function limit. | `refundUncertainOutcome.security.test.ts`: 9 of 10 fail on the old code. |
| D3 | **A lost refund-id attach was silent.** The webhook matches a ticket only by refund id. If `attach_ticket_refund_id` failed, the API still returned success, and `refund.processed` was later dropped as `not_found`. | Retry once, then return 202 `refund_id_recorded:false` and log `REFUND ID NOT RECORDED` with the id. | Same test file. |
| D4 | **Sub-admin runs stranded refunds.** Sub-admins could run "Process refunds" (`is_admin()`), but the API's release path (`admin_revert_stuck_refund`) needs a Super Admin and runs with the caller's session. A Paystack rejection, or the global ceiling, on a sub-admin's run left the ticket stuck in `refund_pending` with no refund id, looking like a timeout. | 0219: claiming needs `is_super_admin()`, the same authority that decides the cancellation. The UI hides the button for sub-admins. | R4. |
| D5 | **The attempt budget burned with no recovery.** Every claim spends one of 5 attempts, including refusals before any provider call: `refund_ticket`'s 30/h limit and the 100/h Paystack ceiling. A large event processed by repeated clicks could leave tickets permanently unclaimable, recoverable only by SQL. | 0219: `admin_requeue_event_cancellation_refund` (Super Admin; failed rows whose ticket is still `paid` only; a note; audit log). The runner stops calling the API after a rate-limit refusal. | R4, runner unit tests. |
| D6 | **A ticket checked in by a scan that overlapped the approval was retried 5 times** as `failed`. | 0219: recorded as `blocked`, a manual decision. | R5. |
| D7 | **Organizers saw a raw PostgREST error** ("Could not find the function…") on *Cancel Event*. This was live from the #112 deploy until 0218 was applied on 2026-11-19, because the frontend shipped without 0218. | A plain message: cancellation isn't available yet; contact VENTS support. | Unit test. |

**Investigated and withdrawn:** a suspected race in which a payment confirmed during approval escapes the refund queue.
- It does not reproduce: confirming a payment inserts an earnings hold whose foreign key locks the event row, so the approval waits.
- It is kept as a two-session regression test (R7) rather than "fixed".

**Pre-existing, outside this batch (reported, not changed):**
- **Organizer refund rejections strand tickets.** For an organizer-initiated refund that Paystack rejects, the same revert fails silently (organizers aren't Super Admins), so the ticket stays `refund_pending`.
- **Some Paystack refund events are ignored.** The webhook ignores `refund.needs-attention` (a bank-transfer refund that needs the customer's account details) and `refund.pending`/`refund.processing`. Such a refund stays `refund_pending` with no alert.
- **Uncertain outcomes have no reconciliation path.** The webhook can't match a refund whose id was never attached. A fallback match by transaction plus amount, or the Paystack refund `reference` below, would be needed.

## 2. Refund accounting (exact, `v3_15_35`, one ticket, card/bank via Paystack)
Server functions: `ticket_fee_buyer_charge_kobo` (refund = charge) and `ticket_fee_organizer_deduction_kobo`. Verified by real execution in harness R1. P is Paystack's fee at the published Nigerian local-channel rate (1.5% + ₦100, ₦100 waived under ₦2,500, capped at ₦2,000). Card pricing may differ, and the rate was **not verified from the live pricing page**.

| Face | Attendee paid | Organizer credited at sale | Attendee refunded | Organizer debited | VENTS kept at sale (before P) | P (est.) | VENTS after refund |
|---|---|---|---|---|---|---|---|
| ₦1,000 | ₦1,015 | ₦965 | ₦1,015 | ₦965 | ₦50 | ₦15.23 | **−₦15.23** |
| ₦5,000 | ₦5,075 | ₦4,825 | ₦5,075 | ₦4,825 | ₦250 | ₦176.13 | **−₦176.13** |
| ₦20,000 | ₦20,300 | ₦19,300 | ₦20,300 | ₦19,300 | ₦1,000 | ₦404.50 | **−₦404.50** |
| ₦200,000 | ₦203,000 | ₦193,000 | ₦203,000 | ₦193,000 | ₦10,000 | ₦2,000 (cap) | **−₦2,000** |

- **The correction to the earlier report:** VENTS does not "absorb its 1.5% fee" as a loss. The whole sale unwinds: the organizer ends at ₦0, the attendee is made whole, and VENTS forgoes its 5% and **loses exactly Paystack's non-refundable processing fee**.
- **Wallet-paid tickets:** VENTS ends at ₦0. No Paystack fee was charged on the ticket itself.
- **Promo tickets:** the organizer is credited face − 3.5% regardless of the discount, and the refund debits the same amount, so it is symmetric.
- **Legacy `legacy_5` tickets:** refund 1.05 × face; the organizer is debited face.
- **Conflict with the Terms:** they say organizers who cancel bear all refund costs, including Paystack fees. The code does not do that.

## 3. Organizer earnings while refunds are outstanding
- **A cancellation does not block the release of held earnings.** `earnings_hold_state` blocks only on deleted or admin-hidden events, `refund_pending` on that order, admin holds, or *not yet* (event end + 48 h). R2 shows a cancelled, unrefunded sale's hold released by `settle_earnings` once the event date passed.
- **Withdrawing the money first leaves a receivable.** The balance never goes negative: `earnings_debit_for_refund` takes from the hold, then the balance, and records the rest in `earnings_recoveries`, collected from future earnings. If the organizer never earns again, VENTS carries the loss.
- **Successful, failed and partial refunds reconcile.** Each successful refund debits exactly that ticket's net credit. A failed one debits nothing. Each ticket of a multi-ticket payment is debited separately.
- **Smallest freeze (not implemented; needs approval):** in `earnings_hold_state`, add a blocker `event_cancelled_refunds_outstanding`. It applies when the hold's event has `cancelled_at` and any `event_cancellation_refunds` row for that order (`tickets.payment_ref = h.source_key`) is not `refunded` or `blocked`. It is one anchored patch of one function, plus a test. Decide also whether `blocked` (checked-in) rows should keep the hold frozen until an admin decides.

## 4. Two-Super-Admin approval: exact changes required (not implemented)
A dual-control framework already exists (`request_admin_action` → `approve_admin_action`: Super Admin, requester ≠ approver, row-locked, audited). It already gates admin `soft_delete_event` and payouts, so single-admin approval of a whole event's refunds is the inconsistent case. To require two:
1. `request_admin_action`: add `decide_event_cancellation` to the allowlist (anchored patch). Validate the payload `{request_id, approve, note}`, that the request is `requested`, and that the requester is not the organizer.
2. `approve_admin_action`: add the branch `WHEN 'decide_event_cancellation' THEN PERFORM public.admin_decide_event_cancellation((payload->>'request_id')::uuid, (payload->>'approve')::boolean, payload->>'note')`. The function's own checks still apply to the approver.
3. Revoke EXECUTE on `admin_decide_event_cancellation` from `authenticated`, so it can only run through approval. Or keep a direct single-admin *reject*, which moves no money.
4. UI: "Approve" submits a request; show "awaiting second approval"; add an `AdminActionsTab` label.
5. Tests: self-approval refused; organizer as requester or approver refused; concurrent approvals produce one decision; a direct call is refused.

## 5. Checked-in tickets
- **Before approval:** check-in is recorded on `tickets.checked_in`. Such tickets are queued as `blocked` and never refunded automatically (`refund_ticket` refuses them).
- **After approval:** check-in is now impossible (D1). A check-in that overlapped the approval becomes `blocked` (D6).
- **Still missing:** an admin action to refund a blocked ticket deliberately. It needs a business rule (attended, so no refund? partial?), a Super Admin with a reason, and an audit row. There is no entitlement in the current code, so none was invented.

## 6. Transferred tickets
- **Transfer changes the holder, not the payment.** `accept_ticket_transfer` changes `user_id` and the holder fields; `payment_ref`, `payment_method` and `fee_model` are kept. Wallet purchases require buyer = holder, so the original payer of a wallet ticket is identifiable from `user_wallet_transactions` (the debit row for that `payment_ref`).
- **Paystack tickets:** the refund goes to the paying card or account. This is correct, but the payer is not notified; only the current holder is.
- **Wallet tickets:** `refund_ticket` credits the **current holder** (R6: the payer receives ₦0, the recipient ₦4,060). The money therefore goes to someone who did not pay, unless the transfer was a sale between them.
- **Options:**
  - **(A) Keep as is.**
  - **(B)** Refund the wallet that was debited: change the wallet branch of `refund_ticket` to credit the debit row's `user_id`. This changes all wallet refunds, not just cancellations.
  - **(C)** Use (B) only for cancellations, and notify both people.
- **Transfer fees** paid by the recipient are not refunded today: also a decision.

## 7. Paystack refund behaviour
Found through web searches of paystack.com and support.paystack.com. **Direct page fetches were blocked by this session's network**, so treat these as needing confirmation against the live docs.
- **Partial refunds:** `POST /refund` takes `transaction` and an optional `amount` (full refund if omitted). Multiple partial refunds per transaction appear supported (the Dashboard's "Process another refund"; no more refunds once fully refunded). The behaviour of **several API partial refunds on one transaction is not confirmed for every channel. Unverified; test in Paystack test mode.**
- **Channels:** bank-transfer refunds are documented for NG/GH/ZA businesses and can need customer account details (*needs attention*). **Card, USSD and other channels: not confirmed.**
- **Fees:** transaction fees are not refunded.
- **Idempotency:** the current docs describe a merchant `reference` on Create Refund. It is used once; a repeat returns **409**, and you then fetch it with `GET /refund?reference=`. An older docs version doesn't list it. **Not used by our integration.** Sending a deterministic per-ticket reference would make a retry after a timeout safe by construction; verify it in test mode first.
- **Webhooks:** `refund.pending`, `refund.processing`, `refund.needs-attention`, `refund.processed`, `refund.failed`. On failure the merchant balance is re-credited. The integration handles only processed and failed (see §1).
- **Refund window:** card and bank-transfer refunds within 1 year of the transaction, from 15 Oct 2026.

Sources:
- [Refund API](https://paystack.com/docs/api/refund/)
- [Refunds guide](https://paystack.com/docs/payments/refunds/)
- [Webhooks](https://paystack.com/docs/payments/webhooks/)
- [Initiating and completing a refund](https://support.paystack.com/en/articles/2127106)
- [Transactions pricing](https://support.paystack.com/en/articles/2130306)
- [Multiple refunds (blog)](https://paystack.com/blog/product/improvements-to-the-process-of-issuing-multiple-refunds)

## 8. Payments in flight at cancellation (R7, R8)
| Situation | What happens now |
|---|---|
| Payment succeeds after approval, ticket already created (`pending`) | Confirmed `paid`, then the sync trigger queues the refund. Tested, including two overlapping sessions. |
| Payment fails after approval | The ticket stays unpaid; nothing to refund. |
| Payment succeeds after approval, **no ticket yet** (`pending_purchases`) | `finalize_pending_purchase` refuses the non-live event and `confirm_ticket_payment` returns `not_found`. **The money is held by VENTS with no ticket, no refund and no alert**, and the request can read *completed*. Pre-existing for hidden events. Needs a decision: auto-refund through Paystack, or an admin reconciliation queue. |
| Duplicate success callback | No change (idempotent). |
| Abandoned checkout (pending purchase never paid) | Blocks deleting an event with no tickets, with the message "0 ticket holder(s)…". Conservative, but confusing. Decide whether expired pending purchases should count. |

## 9. Historical deleted events
- **0218 changes no historical row.** The runbook's read-only pre-check lists events deleted while holding `paid` or `refund_pending` tickets.
- **Not yet investigated in production; it needs your approval.** Proposed read-only queries:
  - those events with ticket counts and amounts by method;
  - open `earnings_holds` on them (`event_deleted` already blocks their release);
  - `earnings_recoveries` linked to them;
  - `pending_purchases` still `pending` on them.

## 10. Migration and deployment
- **Order:** 0218 then 0219.
  - 0218 requires 0208 and `refund_ticket`. 0219 requires 0218.
  - Both are idempotent (tested by re-running them).
  - Neither changes an existing row or moves money (static tests).
  - RLS: the new tables are read-only to clients; helpers are revoked. 0219's new function is granted to `authenticated`, but internally Super Admin only, and is revoked from `anon`.
- **Undo:**
  - `undo_0218` refuses once any request exists, so the first real cancellation request makes rolling back 0218 unavailable. No rollback is authorized or planned (`docs/event-cancellation.md` → *Rollback*).
  - `undo_0219` restores 0218's exact function bodies (tested by hash).
- **Compatibility:** the existing refund functions are untouched. The API change is limited to the outcome handling of the Paystack call and the attach step.
- **Risk:** at review time, the frontend was live without 0218 (see §0); resolved on 2026-11-19, when both migrations were applied and verified. The new API behaviour means more refunds can end up *unconfirmed* and need a manual check in Paystack. That is the intended trade-off: a stuck refund is recoverable, a double refund is not.
