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

## Owner decisions needed

Nothing that depends on one of these decisions is implemented until it's answered.

| ID | Question | Blocks |
|---|---|---|
| D1 | Must an organizer be verified (or approved) before selling **paid** tickets? Today any signed-in user can become an organizer and sell. | M5 |
| D2 | May ticket prices change after sales start? (Buyers already keep the price they paid.) May a tier with sales be renamed? | M4 (price part only; removing or shrinking a tier below the number sold is refused regardless) |
| D3 | Promotion rows created without payment before 0225 (if any exist in production): leave them, expire them now, or review them one by one? Finding them needs a read-only production query, which needs your approval. | H3 follow-up |
| D4 | Payments captured without a ticket (H1): refund automatically for clear cases (sold out, event cancelled or ended, Coming Soon not open), or always have an admin approve? If an admin approves, is one admin enough, or two (like withdrawals)? | H1 refund step (recording and admin visibility go ahead regardless) |
| D5 | Unpaid tickets that may already exist in production from the C1 hole still count toward capacity. Cancel them after 0220 is applied (a production data change), or leave them? | C1 follow-up |
| D7 | When to apply 0228 (revoke the old username→email lookup): right after the new web app is live, accepting that installed native builds from before #125 lose username login (email login works), or after the next app release with a forced update. | H2 fully closed |
| D6 | H6 needs a schema-only `pg_dump` of production to build a baseline the repo can rebuild from. This is read-only, but it is a production operation: will you run it, or approve me running it? | H6 |

## Findings

| ID | Sev | Finding | Root cause | Batch | Fix | Tests | PR | Code | Main | Prod | Verified | Remaining risk |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| C1 | Critical | Unpaid tickets can be used for entry; inventory lock-up (OEL-01) | `purchase_ticket` (anon/auth) issues paid-tier tickets as `pending`+`active`; signing and check-in never read `payment_status` | B1 | 0220: `purchase_ticket` free tiers only; sign only `paid`; `verify_entry_pass` and `manual_check_in` refuse `not_paid`. Plus `undo_0220`. | 141-check local suite; mutation test (without 0220, exactly 18 checks fail); verbatim check; vitest guard (11) | #122 | ✅ | ⬜ | ⬜ (apply 0220) | ⬜ | D5 (existing unpaid rows). The production pre-apply body check is in the 0220 runbook. |
| H1 | High | Captured payment with no ticket, refund or record (OEL-02) | Finalize failure only logged; verify/webhook return "not found" | B3 | 0226 `payment_exceptions` + record/close (server only, idempotent) + admin list/resolve; both payment paths record (provable ticket refs only); truthful buyer message; Admin → Payouts → Payment exceptions | 0226 local suite 59/59 + 3 mutations caught; webhook/verify behaviour tests 12; panel tests 7 | #124 | ✅ | ⬜ | ⬜ (apply 0226 **before** merging) | ⬜ | D4 (refund step not built) |
| H2 | High | Username → email lookup open to anyone | `resolve_username_to_email` is anon `SECURITY DEFINER` and returns the email | B4 | 0227 `resolve_login_email(username, password)` (email only with the right password, rate limited); client switched; 0228 revokes the old lookup | 0227+0228 local suite 57/57 + 3 mutations caught; static guard 10 | #125 | ✅ | ⬜ | ⬜ (0227, then 0228 per D7) | ⬜ | D7 (when to apply 0228; old native builds lose username login) |
| H3 | High | Organizers can self-promote for free | 0008 write policies on `event_promotions` | — | 0225 (merged in #119/#120) | `promotionEligibility.security.test.ts`; local suite | #119, #120 | ✅ | ✅ | ⬜ (apply 0225) | ⬜ | D3 |
| H4 | High | "Publish as Coming Soon" fails in production | UI shipped (#119) before 0224 was applied | — | 0224 (merged in #119) | Coming Soon local suite | #119 | ✅ | ✅ | ⬜ (apply 0224) | ⬜ | Applying 0224 also turns on pg_cron |
| H5 | High | No tests run before merging | No PR workflow | B2 | `.github/workflows/pr-checks.yml` (typecheck + vitest) + guard test | Clean-checkout replay; first GitHub run green on #123 | #123 | ✅ | ⬜ | — | ⬜ | Branch protection is your setting (docs/release-safeguards.md) |
| H6 | High | Database can't be rebuilt from the repo | Tables created outside migrations; unrecorded history; production-only seeds | B9 | planned | planned | — | ⬜ | ⬜ | ⬜ | ⬜ | D6 |
| M1 | Medium | 1-hour reminders almost never sent | Reminder sweep only runs in the daily 08:00 UTC Vercel cron | B6 | planned: pg_cron schedule (after 0224) | planned | — | ⬜ | ⬜ | ⬜ | ⬜ | Depends on H4 (pg_cron) |
| M2 | Medium | Ticket email depends on the buyer's browser (CF-07) | Email only sent from the client after verify | B3 | planned | planned | — | ⬜ | ⬜ | ⬜ | ⬜ | |
| M3 | Medium | Draft and admin-hidden events readable by anyone (OEL-06) | `select_events` only filters `deleted_at` | B5 | planned | planned | — | ⬜ | ⬜ | ⬜ | ⬜ | |
| M4 | Medium | Tier with sales can be removed or shrunk (OEL-08) | No database check for sold tiers | B5 | planned (refuse removal and shrink below sold); price per D2 | planned | — | ⬜ | ⬜ | ⬜ | ⬜ | D2 |
| M5 | Medium | Anyone can self-grant organizer (OEL-04) | `set_signup_role` | — | ⏸ D1 | — | — | ⏸ | ⬜ | ⬜ | ⬜ | D1 |
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

## Earlier audits: status of every open item

| ID | Item | Status on `main` (2026-11-26) | Now tracked as |
|---|---|---|---|
| OEL-01 | Unpaid tickets usable for entry | Open (0220 never merged) | C1 |
| OEL-02 | Orphan payments | Open | H1 |
| OEL-03 | Desktop clipping | Open | M9 |
| OEL-04 | Self-grant organizer | Open (policy) | M5 / D1 |
| OEL-05 | Anyone can read any event's sales counts | Fixed in code by 0221: pending, cancelled, refunded counts and revenue are organizer/admin only. Production: applied but unrecorded (Stage A) | H6 (record history) |
| OEL-06 | Drafts and hidden events readable | Open | M3 |
| OEL-07 | Revenue stat counts gross `amount × 100` | Re-check in B5 | B5 |
| OEL-08 | Capacity and tier quantity checks client-side only | Open | M4 |
| OEL-09 | No delegated door-staff role | Open: a product feature, not a defect. Recorded as intentionally unavailable. | L8 group |
| OEL-10 | No pre-publication review | Policy (with D1) | D1 |
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
| B3 | H1, M2, L11: payment exceptions and server-side ticket delivery | D4 for the refund step only |
| B4 | H2, M8, L4, L5: auth and personal-data RPCs | Done without a new API route (sign-in stays on the device) |
| B5 | M3, M4, M7, L3, L12, OEL-07: database correctness | 0220 numbering (new migrations start at 0226); D2 for price |
| B6 | M1: reminder schedule | 0224 applied in production (H4) |
| B7 | M6, M11, L9, L10, CF re-checks: checkout and sign-in flow | — |
| B8 | M9, L1, L2, L6, L7, L8, OEL-11: UI, navigation, cleanup | — |
| B9 | H6, M10: reproducible database, migration history | D6 |
| B10 | M12 and release safeguards | You (dashboard) |

**Production migration apply order** (each one needs your approval; you or an approved session runs it):
0224 → 0225 → 0223 → 0220 → 0226 (before merging #124) → 0227 (before merging #125) → 0228 (per D7) → backfill migration history.
0224 goes before 0225 because 0225's eligibility rule treats `coming_soon` as not on sale; it is safe either way.
