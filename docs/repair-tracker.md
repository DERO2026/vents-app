# VENTS repair tracker (A–Z audit, 2026-11-26)

Source: the A–Z audit of `main` at `815ec94` (31 findings), plus the open items from the earlier lifecycle audit (OEL) and checkout audit (CF).

## Status columns

The four status columns are separate on purpose. A finding is only **Resolved** when all four are ✅ and nothing in "Remaining risk" is open.

| Column | Meaning |
|---|---|
| **Code** | The fix exists on a branch, with regression tests, and the tests pass. |
| **Main** | The PR is merged into `main`, with owner approval. |
| **Prod** | The frontend is deployed to production, or the migration is applied to production. The owner does both. |
| **Verified** | The behaviour has been checked in production after deployment. |

**Symbols:** ✅ done · 🔶 in progress · ⏸ waiting on an owner decision · ⬜ not started · — not applicable.

## Decision register

Approved decisions are binding for every batch. A decision being approved does not mean any production operation has run.

| ID | Decision (owner-approved) | Date | Implications | Affected work | Status |
|---|---|---|---|---|---|
| D1 | **All approved organizers may sell paid tickets.** No extra identity-verification requirement for paid-ticket sales. | 2026-11-26 | Verification stays a trust badge (and representative-reward eligibility), not a condition for selling. Paid-ticket checkout doesn't change. | M5, OEL-10 | ✅ Decided. **Follow-up D1a is open** (below). |
| D2 | **Organizers may change ticket prices after sales begin.** Every existing ticket and transaction keeps its original price and amount paid. Completed purchases and financial records are never changed retroactively. | 2026-11-26 | Price edits stay allowed. B5 adds a test that a price change leaves every existing `tickets.amount`, pending purchase and ledger row unchanged. Deleting a tier that has sales, or cutting its quantity below the number sold, is still refused: that isn't a price change, and it orphans existing tickets. | M4 | ✅ Decided. **Follow-up D2a is open** (below). |
| D3 | **Leave existing promotions untouched.** Don't investigate, expire, delete or modify them. | 2026-11-26 | No production query for promotions organizers may have given themselves, and no cleanup. 0225 is compatible as written: it only stops new writes from the app (it drops the write policies and revokes the grants) and doesn't touch existing rows. | H3 | ✅ Decided. No further work. |
| D4 | **Every refund of a payment charged without a ticket needs two separate authorized admin approvals. No automatic refunds.** | 2026-11-26 | The refund is built as a two-admin action (`request_admin_action` → `approve_admin_action`): one admin requests it, a different admin approves it, and an admin can't approve their own request. It runs through the existing refund engine only after the second approval. Nothing refunds automatically. | H1 (#124, new batch B3c) | ✅ Decided. #124 needs an adjustment (below). |
| D5 | **Cancel all existing confirmed unpaid tickets after 0220 is applied**, and only after a separate production review (gate G-D5) is approved. Exclude successful payments, pending payment attempts, charged-but-unreconciled payments and ambiguous records. **Nothing is cancelled yet.** | 2026-11-26 | Two steps, each needing its own approval. Step 1 is a read-only production review listing the exact qualifying tickets, counts, capacity impact per event, and every excluded record with the reason. Step 2 is the cancellation itself, as a reviewed, single-transaction, reversible operation covering only the records approved in step 1. | C1 follow-up | ✅ Decided. Blocked on gate G-D5. |
| D6 | H6 needs a schema-only `pg_dump` of production so the repo can rebuild the database from a baseline. It's read-only, but it is a production operation: will you run it, or approve me running it? | — | — | H6, M10 | ⏸ **Still open** |
| D7 | **Revoke the old username lookups immediately, through 0228.** Older installed iOS and Android versions may lose username login and may need email login or an app update. Release and support notes are prepared. | 2026-11-26 | "Immediately" means as soon as it's safe: apply 0227 → merge #125 and deploy the web app → apply 0228 straight after. Applying 0228 before the web deploy would also break username login on the website. ⚠️ See the compatibility risk below. | H2, L4 (#125) | ✅ Decided |

### Follow-up decisions

| ID | Decision (owner-approved) | Date | Implications | Affected work | Status |
|---|---|---|---|---|---|
| D1a | **Choosing the Organizer role is enough.** A user who selects it is approved to operate as an organizer. No separate admin approval before publishing events or selling paid tickets. | 2026-11-26 | Sign-up already worked this way (`set_signup_role`). After sign-up, "Become an Organizer" (VENTS Work) filed an application and waited "1–3 business days" for admin review, which is a separate approval. #126 makes it the same one-step choice as sign-up, with no database or permission change. Legacy pending or rejected applications no longer block anyone. Admins can still read old requests. Unchanged: event creation still needs the organizer capability; payouts still need a verified bank account, the PIN and two-admin approval; `promote_to_organizer` stays revoked; staff are never offered the option. | M5, OEL-04, OEL-10 | ✅ Decided; implemented in #126 |
| D2a | **Organizers may rename a ticket tier after sales begin.** Existing tickets keep their purchase-time name; transactions, payments, receipts, refunds and reports are never rewritten; ownership, door scanning and check-in keep working; the event shows the new name. | 2026-11-26 | Tickets store the tier **name**, and capacity, availability and analytics matched by the current name. Without a fix, a rename oversold the tier, broke orders already in checkout (charged, no ticket) and split reports. Migration 0229 (additive) gives each tier a stable key and server-kept previous names, and makes purchase, capacity and reporting count every name the tier has had. No ticket or financial row is written. | M4 (renaming), #127 | ✅ Decided; implemented in #127 |

### ⚠️ D7 compatibility risk

Once 0228 is applied, **installed iOS and Android builds from before #125** can no longer log in with a **username**. For those builds:
- the screen shows "We couldn't verify your login right now. Please check your connection and try again.";
- **logging in with email and password still works** in every build;
- updating the app brings username login back.

The website is unaffected once #125 is deployed. Old builds can't be given a better message, because they show that same text for any lookup failure. Support guidance and a release-note line are in `docs/support-username-login-0228.md`.

## Approval gates

Each gate needs its own explicit approval, recorded here, before anything behind it runs.

| Gate | What must be approved | Status |
|---|---|---|
| G-0224, G-0225, G-0223, G-0220 | Applying each migration to production, in the apply order below | ⬜ Waiting |
| G-0226 | Applying 0226, **before** merging #124 | ⬜ Waiting |
| G-0227 / G-0228 | 0227 before merging #125; 0228 straight after the web deploy (D7) | ⬜ Waiting |
| G-0229 | Applying 0229, before merging #127 | ⬜ Waiting |
| **G-D5** (mandatory, separate) | A **read-only production review** before any unpaid ticket is cancelled. It must show: (1) the exact qualifying ticket ids, each with its event, tier, owner and creation date; (2) counts per event and in total; (3) the capacity impact per event (sold, unpaid and remaining, before and after); (4) every **excluded** record and why: successful payments, payment attempts still open (`pending_purchases` or payment attempts), payments charged but not reconciled (an open `payment_exceptions` row, or a Paystack charge with no confirmed ticket), and anything ambiguous. Approving the review does **not** approve the cancellation: that needs a second approval of the exact list. | ⬜ Not started (needs 0220 applied first) |
| G-D4 | Each refund of a payment exception: two separate admin approvals in the app (built in B3c) | ⬜ Not built |
| G-D6 | The production schema dump for H6 | ⏸ Waiting on decision D6 |

## PRs and migrations affected by these decisions

| Item | Change needed | Why |
|---|---|---|
| #124 (H1, 0226) | Change the Payment exceptions panel and its docs. They must no longer tell an admin to refund in the Paystack dashboard and then record it. "Record resolution" must no longer let a single admin close out a refund. One admin can still record a **non-refund** outcome (for example, the ticket was issued another way), or that could also move to two approvals. The two-admin refund itself is B3c. 0226's tables and the server-side recording are unaffected. | D4: one admin refunding outside the app is a single-approval refund |
| New batch B3c | A two-admin refund action for payment exceptions, using `request_admin_action` / `approve_admin_action` and run through the existing refund engine. It comes with a local Postgres test suite proving: an admin can't approve their own request, a payment can't be refunded twice, and the refund equals the amount charged. | D4 |
| #127 (D2a, 0229) | New. Apply 0229 before merging #127. | D2a |
| #126 (D1a) | New. No database change. | D1a |
| #125 (H2, 0227/0228) | Update the PR description: 0228 is now approved to apply immediately after the web deploy (D7). Link the support notes. No code change: 0227 and 0228 already match D7. | D7 |
| 0220 / #122 | No change. The D5 cancellation is a separate, later operation behind gate G-D5, not part of 0220. | D5 |
| 0225 | No change. It doesn't touch existing promotion rows. | D3 |
| B5 (M4) | Keep price edits allowed. Refuse deleting a tier with sales or shrinking it below the number sold, counting sales under the tier's previous names (0229). Add the test that a price change never touches existing tickets or ledger rows. Renaming is allowed (D2a, #127). | D2, D2a |
| M5 (organizer capability) | Done in #126 (D1a): "Become an Organizer" after sign-up is now the same one-step self-selection as sign-up. | D1, D1a |

## Findings

| ID | Sev | Finding | Root cause | Batch | Fix | Tests | PR | Code | Main | Prod | Verified | Remaining risk |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| C1 | Critical | Unpaid tickets can be used for entry; inventory lock-up (OEL-01) | `purchase_ticket` (anon/auth) issues paid-tier tickets as `pending`+`active`; signing and check-in never read `payment_status` | B1 | 0220: `purchase_ticket` free tiers only; sign only `paid`; `verify_entry_pass` and `manual_check_in` refuse `not_paid`. Plus `undo_0220`. | 141-check local suite; mutation test (without 0220, exactly 18 checks fail); verbatim check; vitest guard (11) | #122 | ✅ | ⬜ | ⬜ (apply 0220) | ⬜ | Existing unpaid tickets: cancel per D5, only after gate G-D5. The production pre-apply body check is in the 0220 runbook. |
| H1 | High | Captured payment with no ticket, refund or record (OEL-02) | Finalize failure only logged; verify/webhook return "not found" | B3 | 0226 `payment_exceptions` + record/close (server only, idempotent) + admin list/resolve; both payment paths record (provable ticket refs only); truthful buyer message; Admin → Payouts → Payment exceptions | 0226 local suite 59/59 + 3 mutations caught; webhook/verify behaviour tests 12; panel tests 7 | #124 | 🔶 (D4 adjustment) | ⬜ | ⬜ (apply 0226 **before** merging) | ⬜ | Two-admin refund (D4) not built: B3c. #124 panel wording needs the D4 change. |
| H2 | High | Username → email lookup open to anyone | `resolve_username_to_email` is anon `SECURITY DEFINER` and returns the email | B4 | 0227 `resolve_login_email(username, password)` (email only with the right password, rate limited); client switched; 0228 revokes the old lookup | 0227+0228 local suite 57/57 + 3 mutations caught; static guard 10 | #125 | ✅ | ⬜ | ⬜ (0227 → deploy → 0228 immediately, D7) | ⬜ | ⚠️ D7: installed native builds from before #125 lose username login (email login still works). Support notes prepared. |
| H3 | High | Organizers can self-promote for free | 0008 write policies on `event_promotions` | — | 0225 (merged in #119/#120) | `promotionEligibility.security.test.ts`; local suite | #119, #120 | ✅ | ✅ | ⬜ (apply 0225) | ⬜ | Existing rows left untouched by decision (D3). |
| H4 | High | "Publish as Coming Soon" fails in production | UI shipped (#119) before 0224 was applied | — | 0224 (merged in #119) | Coming Soon local suite | #119 | ✅ | ✅ | ⬜ (apply 0224) | ⬜ | Applying 0224 also turns on pg_cron |
| H5 | High | No tests run before merging | No PR workflow | B2 | `.github/workflows/pr-checks.yml` (typecheck + vitest) + guard test | Clean-checkout replay; first GitHub run green on #123 | #123 | ✅ | ⬜ | — | ⬜ | Branch protection is your setting (docs/release-safeguards.md) |
| H6 | High | Database can't be rebuilt from the repo | Tables created outside migrations; unrecorded history; production-only seeds | B9 | planned | planned | — | ⬜ | ⬜ | ⬜ | ⬜ | D6 |
| M1 | Medium | 1-hour reminders almost never sent | Reminder sweep only runs in the daily 08:00 UTC Vercel cron | B6 | planned: pg_cron schedule (after 0224) | planned | — | ⬜ | ⬜ | ⬜ | ⬜ | Depends on H4 (pg_cron) |
| M2 | Medium | Ticket email depends on the buyer's browser (CF-07) | Email only sent from the client after verify | B3 | planned | planned | — | ⬜ | ⬜ | ⬜ | ⬜ | |
| M3 | Medium | Draft and admin-hidden events readable by anyone (OEL-06) | `select_events` only filters `deleted_at` | B5 | planned | planned | — | ⬜ | ⬜ | ⬜ | ⬜ | |
| M4 | Medium | Tier with sales can be removed or shrunk (OEL-08) | No database check for sold tiers | B5 | planned: refuse deleting a tier with sales or shrinking it below the number sold (counting sales under previous names); price changes allowed (D2); renaming allowed and made safe by 0229 (D2a, #127) | rename part: 0229 local suite 42/42; static guard 11 | #127 (rename part) | 🔶 rename ✅, delete/shrink guard ⬜ | ⬜ | ⬜ | ⬜ | Delete/shrink guard still B5 |
| M5 | Medium | Anyone can self-grant organizer (OEL-04) | `set_signup_role` | — | Accepted by policy (D1, D1a): choosing Organizer is the approval. #126 removes the post-sign-up admin review so both paths match | workRoles, VENTS Work render, organizerCapabilityStates, promoteToOrganizerSelfEscalation (restated to D1a) | #126 | ✅ | ⬜ | ⬜ (frontend only) | ⬜ | None (policy accepted) |
| M6 | Medium | Purchase intent lost at sign-in (CF-01) | `handleAuthSuccess` clears the stack and goes Home | B7 | planned | planned | — | ⬜ | ⬜ | ⬜ | ⬜ | |
| M7 | Medium | "Popular" ordering counts only the viewer's own saves | `saved_events` RLS is own-row only | B5 | planned: count RPC | planned | — | ⬜ | ⬜ | ⬜ | ⬜ | |
| M8 | Medium | Anyone can wipe another person's unconfirmed sign-up | `reclaim_unverified_signup` anon, no ownership proof | B4 | 0227: reclaim only after 1 hour (email-code lifetime) + rate limit | in 0227 suite | #125 | ✅ | ⬜ | ⬜ | ⬜ | |
| M9 | Medium | Desktop layout clipped (OEL-03) | `.phone-frame` capped at 560px | B8 | planned | planned | — | ⬜ | ⬜ | ⬜ | ⬜ | |
| M10 | Medium | Seeded production IDs and drift in migrations (part of H6) | See H6 | B9 | with H6 | — | — | ⬜ | ⬜ | ⬜ | ⬜ | D6 |
| M11 | Medium | Payment link loses intent; payer needs an account (CF-04) | As M6 | B7 | planned (intent resume; account requirement unchanged unless you decide) | planned | — | ⬜ | ⬜ | ⬜ | ⬜ | |
| M12 | Medium | Push, email and SMS configuration in production unverified | Env vars not readable from here | B10 | planned: health check in `prod-smoke`; you confirm in the Vercel dashboard | planned | — | ⬜ | ⬜ | ⬜ | ⬜ | Needs you |
| L1 | Low | Representative Rewards screen unreachable | No navigation path | B8 | planned | planned | — | ⬜ | ⬜ | ⬜ | ⬜ | |
| L2 | Low | Dead screen types `search`, `ticket-detail` | Leftover | B8 | planned | planned | — | ⬜ | ⬜ | ⬜ | ⬜ | |
| L3 | Low | `boost_event_vc` charges VC for nothing | Feature never wired up | B5 | planned: revoke | planned | — | ⬜ | ⬜ | ⬜ | ⬜ | |
| L4 | Low | Anonymous account-status and existence lookups | Anon grants on helper RPCs | B4 | 0227: owner-only `get_login_account_status`; `email_exists` revoked; `check_user_exists` rate limited; 0228 revokes `get_account_status` | in 0227 suite | #125 | ✅ | ⬜ | ⬜ | ⬜ | Rate limit per IP may affect shared mobile IPs (60/5 min) |
| L5 | Low | `users.email` editable, drifts from login email | No column guard | B4 | 0227 trigger: client roles can't change `email`/`original_email` | in 0227 suite | #125 | ✅ | ⬜ | ⬜ | ⬜ | |
| L6 | Low | Leftover glows and gradients | Older styles | B8 | planned | planned | — | ⬜ | ⬜ | ⬜ | ⬜ | |
| L7 | Low | InsForge leftovers; 33 root screenshot scripts | Not cleaned up | B8 | planned | — | — | ⬜ | ⬜ | ⬜ | ⬜ | |
| L8 | Low | Placeholder features (AI tabs, booking, Work, non-NGN) | Not built | B8 | planned: mark clearly unavailable; no new features | planned | — | ⬜ | ⬜ | ⬜ | ⬜ | |
| L9 | Low | Phone not pre-filled at checkout (CF-05) | Not wired | B7 | planned | planned | — | ⬜ | ⬜ | ⬜ | ⬜ | |
| L10 | Low | Extra attendees need email and phone (CF-06) | Validation | B7 | planned | planned | — | ⬜ | ⬜ | ⬜ | ⬜ | Check door/transfer use of those fields first |
| L11 | Low | Public QR images never cleaned up (CF-14) | Stored publicly | B3 | planned | planned | — | ⬜ | ⬜ | ⬜ | ⬜ | |
| L12 | Low | Anyone can review an organizer without attending | Insert policy only checks `reviewer_id` | B5 | planned | planned | — | ⬜ | ⬜ | ⬜ | ⬜ | |

## Found during repairs (not in the original 31)

| ID | Sev | Finding | Root cause | Status | Remaining risk |
|---|---|---|---|---|---|
| N1 | High | A price change while a buyer is mid-checkout breaks the purchase. A **raise** makes the payment look short, so the buyer is charged with no ticket (H1 records it). A **cut** means the buyer overpays and the difference isn't refunded. Conflicts with D2 ("preserve the original price"). | `finalize_pending_purchase` re-reads the tier's current price when issuing the ticket, and `confirm_ticket_payment` checks the charge against that price, not against the amount the buyer agreed to (`pending_purchases.amount_kobo`). | Reported only; not fixed (outside the D1a/D2a scope). Needs your go-ahead. | Present on `main` today whenever a price is changed during an open checkout. |

## Earlier audits: status of every open item

| ID | Item | Status on `main` (2026-11-26) | Now tracked as |
|---|---|---|---|
| OEL-01 | Unpaid tickets usable for entry | Open (0220 never merged) | C1 |
| OEL-02 | Orphan payments | Open | H1 |
| OEL-03 | Desktop clipping | Open | M9 |
| OEL-04 | Self-grant organizer | Accepted by policy (D1, D1a); app made consistent in #126 | M5 |
| OEL-05 | Anyone can read any event's sales counts | Fixed in code by 0221: pending, cancelled, refunded counts and revenue are organizer/admin only. Production: applied but unrecorded (Stage A) | H6 (record history) |
| OEL-06 | Drafts and hidden events readable | Open | M3 |
| OEL-07 | Revenue stat counts gross `amount × 100` | Re-check in B5 | B5 |
| OEL-08 | Capacity and tier quantity checks client-side only | Open | M4 |
| OEL-09 | No delegated door-staff role | Open: a product feature, not a defect. Recorded as intentionally unavailable. | L8 group |
| OEL-10 | No pre-publication review | Policy: not required by D1 | D1 |
| OEL-11 | Dead `'published'` status in HomeScreen | Re-check in B8 (0225 treats `published` as on sale) | B8 |
| OEL-12 | Desktop rules scattered | With M9 | M9 |
| CF-01 | Purchase intent lost after auth | Open | M6 |
| CF-02 | ~10 sign-up fields before first purchase | Product decision (sign-up redesign); not a defect | Recorded |
| CF-03 | Mandatory 8-digit code before buying | Product decision; not a defect | Recorded |
| CF-04 | Payment link needs an account; intent lost | Open | M11 |
| CF-05 | Phone retyped | Open | L9 |
| CF-06 | Extra attendees need email and phone | Open | L10 |
| CF-07 | Ticket email depends on the browser | Open | M2 |
| CF-08 | Free RSVP needs a full account | Product decision | Recorded |
| CF-09 | No box office or comp tickets | Product feature | Recorded |
| CF-10 | Web verify link tries `vents://` first | Needs a device test; re-check in B7 | B7 |
| CF-11 | Capacity checked after payment | Same root cause as H1 | H1 |
| CF-12 | Typed promo must be applied by hand | Re-check in B7 | B7 |
| CF-13 | Default login mode | Re-check in B7 | B7 |
| CF-14 | Public QR images | Open | L11 |

## Batches and dependencies

| Batch | Scope | Depends on |
|---|---|---|
| B1 | C1: 0220 onto `main` | — |
| B2 | H5: PR checks | — (lands early so every later batch is checked) |
| B3 | H1: payment exceptions (#124; needs the D4 adjustment) | 0226 applied before merge |
| B3b | M2, L11: server-side ticket email, private QR hosting | — |
| B3c | D4: two-admin refund of payment exceptions | #124 merged; 0226 applied |
| B4 | H2, M8, L4, L5: auth and personal-data RPCs | Done without a new API route (sign-in stays on the device) |
| B5 | M3, M4, M7, L3, L12, OEL-07: database correctness | New migrations numbered after 0229; D2/D2a decided; M4's guard must count previous names (0229) |
| D1a | M5: organizer self-selection (#126) | — |
| D2a | M4 rename part: migration 0229 (#127) | Apply 0229 before merging #127 |
| B6 | M1: reminder schedule | 0224 applied in production (H4) |
| B7 | M6, M11, L9, L10, CF re-checks: checkout and sign-in flow | — |
| B8 | M9, L1, L2, L6, L7, L8, OEL-11: UI, navigation, cleanup | — |
| B9 | H6, M10: reproducible database, migration history | D6 |
| B10 | M12 and release safeguards | You (dashboard) |

**Production migration apply order** (each one needs your approval; you or an approved session runs it):
0224 → 0225 → 0223 → 0220 → 0226 (before merging #124) → 0227 (before merging #125) → 0228 (immediately after #125 is deployed, D7) → 0229 (before merging #127) → backfill migration history.
After 0220: gate G-D5 (read-only review), then a separately approved cancellation.
0224 goes before 0225 because 0225's eligibility rule treats `coming_soon` as not on sale; it is safe either way.
