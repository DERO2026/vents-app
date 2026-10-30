# VENTS launch readiness: master checklist

Created 2026-10-30 on PR #82 (`claude/vents-work-earn`). This is the
**top-level tracker**. It reconciles, and does not replace, the detailed
checklists listed below: each item points to where the detail lives.

## How to read this

**Status:**

| Status | Meaning |
|---|---|
| DONE | Built **and** shown working |
| PARTIAL | Some of it exists |
| BROKEN | Exists and is wrong |
| NOT STARTED | Nothing built |
| UNVERIFIED | Cannot be confirmed from this environment, or nobody has checked it |

**Code vs Prod:** every item says whether it is only in code (a branch or PR)
or actually live in production. Production facts come from read-only queries
on Supabase project `slrtjxtzhowhwhebjprv` on 2026-10-30. Nothing was
written.

**Priority:**

| Priority | Meaning |
|---|---|
| P0 | Launch blocker: money, security or data correctness |
| P1 | Must fix before a public launch |
| P2 | Should fix soon after |
| P3 | Later or future |

**Tests:** the tests needed to call an item DONE. Existing suites are named
where they exist.

### Existing checklists (kept; this file links to them)

| File | Owns | State on 2026-10-30 |
|---|---|---|
| `LAUNCH_CHECKLIST.md` | Store submission, build/signing, infrastructure, on-device tests, §11 VENTS Work | 62 open / 36 done. **§9 is partly stale**, see INF-1. |
| `IOS_LAUNCH_CHECKLIST.md` | Step-by-step iOS (Xcode, plist, signing, APNs, universal links) | 12 open / 0 done |
| `MASTER_AUDIT.md` | Security/financial audit history and findings (Aug–Oct) | Part 4 lists 9 deferred items (carried into SEC/OPS below) |
| `VENTS_DESIGN_IMPLEMENTATION_CHECKLIST.md`, `VENTS_REDESIGN_IMPLEMENTATION_CHECKPOINT.md` | Design / redesign implementation | Batches 1–5 done; redesign items 20–21 not started |
| `docs/money-flow-audit.md` | Earnings, withdrawals, refunds | P0 fixes in 0202 (code only); 3 decisions open |
| `docs/vents-work-earn.md` | VENTS Work / Earn / representative reward | 0201 code only |
| `docs/preview-read-only.md` | Preview safety | Code done |
| `docs/architecture-security-audit-2026-07-11.md` | July security audit | Historical |
| PR #81 `MONETIZATION_IMPLEMENTATION_MASTER_CHECKLIST.md` (draft, not merged) | 12-part monetization tracker | **Conflicts with PR #82 on one point**: it says rewards are withdrawable "through VENTS Wallet", but the confirmed decision is the withdrawable *earnings* wallet. It also records a fee-model mismatch (PAY-3). Reconcile before either merges. |

### Facts used below (production, read-only, 2026-10-30)

- **Activity:** 57 users, 74 events (38 live), 106 paid tickets, 7 service bookings, 2 providers, 2 recruiters.
- **`app_config`:** `disable_signups = true`. Purchases, payouts, bookings, deposits and AI are enabled.
- **Not applied:** migrations 0192, 0201 and 0202. 0198–0200 are applied.
- **Earnings wallets:**
  - 5 wallets, 2 of them out of line with their ledgers;
  - 5 withdrawal requests pending since 2026-09-02 (₦49,100);
  - 4 ₦100 test payouts cancelled with Paystack transfer codes.
- **Test suites (PR #82):**
  - `vitest`: 8 failing, all pre-existing on `main` (`aiSubscriptionPaystackVerify` 6, `paystackVerifyAbuse` 2);
  - `tsc`: 1 pre-existing error (`adminSendAnnouncement.security.test.ts:319`).

---

## Launch blockers (P0)

| ID | Item | Status | Code / Prod | Evidence | Acceptance criteria | Tests | Depends on |
|---|---|---|---|---|---|---|---|
| PAY-1 | Withdrawals cannot pay twice or lose a reversal | PARTIAL | Fixed in code (0202 + API, PR #82); **production still has the bugs** | `docs/money-flow-audit.md` P0-1..3 | 0202 applied; a cancel with a transfer refused; a reversal re-credits once; one fixed reference per request | `run-payout-engine-verification.sh` (50, on 0203), `payoutEngine.security.test.ts` | Review PR #82; apply 0202 |
| PAY-2 | Stuck withdrawals: 5 requests pending since Sept (₦49,100), incl. two identical ₦20,000 requests 10 s apart | BROKEN (operations) | Prod | Read-only query on `organizer_withdrawal_requests` | Each request approved, rejected or confirmed with the organizer; the duplicate ₦20,000 pair explained | Manual review in Admin → Payouts | Business owner |
| PAY-3 | Ticket fee model matches the agreed 4% attendee + 5% organizer | DONE in code (0203, PR #82); not in prod | Prod still charges 5% buyer fee / full-face credit | `fee_model` per ticket; legacy rows keep 5% | Applied with the matching frontend; one live purchase shows face×1.04 charged and face−5% credited | `run-earnings-policy-verification.sh` (156), `ticketFees.test.ts`, `walletMath.test.ts` | Apply 0203; reconcile unapplied 0192 first |
| PAY-4 | Paystack live/test key mode in Production | UNVERIFIED | Prod (Vercel, write-only secrets) | `LAUNCH_CHECKLIST.md` §9 | Owner confirms live keys in Production and test keys elsewhere; the Paystack dashboard live webhook URL is `getvents.com/api/webhook/paystack` | One real ₦100 live purchase + refund by the owner | Owner |
| PAY-5 | Earnings ledger matches balances | BROKEN (historical) | Prod: 2 of 5 wallets off (₦32,150 and ₦1,000) | `admin_earnings_reconciliation()` (0202) / audit query | Every gap explained by a person, then corrected through an audited adjustment (not a silent update) | Reconciliation report shows no issues | PAY-1 |
| PAY-6 | 4 cancelled ₦100 test payouts that had Paystack transfer codes | UNVERIFIED | Prod | `organizer_withdrawal_requests` (cancelled, transfer code set) | Paystack dashboard shows whether each was paid; ledger and balance corrected if so | — | Paystack dashboard access |
| AUTH-1 | Public sign-up | BROKEN for public launch (or deliberate) | Prod: `disable_signups = true` | `app_config` | Owner confirms intent; re-enable at launch; sign-up → email code → profile works on web, iOS and Android | E2E sign-up on each platform | Owner |
| SEC-1 | Preview cannot touch production money or messaging | DONE (code) | PR #82 only; production unaffected (byte-identical build) | `docs/preview-read-only.md` | — (already met) | `previewGuard.test.ts`, `previewReadOnly*.test.ts` | Merge PR #82 |
| INF-1 | `LAUNCH_CHECKLIST.md` §9 reflects the live backend | BROKEN (stale doc) | Doc | §9 says the Supabase variables are absent from Production and PR #3 is unmerged, but production serves the Supabase app with live data | §9 rewritten from current facts (variables present, `PROJECT_ADMIN_DATABASE_URL` set, cron, Sentry alerts) | — | Owner Vercel access |
| QA-1 | Pre-existing failing tests | BROKEN | Code (`main` and PR #82) | 8 vitest failures, 1 tsc error | 0 failures; or each documented as a known false-positive and quarantined **with an owner decision** (never silently skipped) | `npm test`, `tsc --noEmit` | — |

## Must fix before public launch (P1)

| ID | Item | Status | Code / Prod | Evidence | Acceptance criteria | Tests | Depends on |
|---|---|---|---|---|---|---|---|
| PAY-7 | Refund after a withdrawal: who carries the shortfall | DONE in code (0203); not in prod | Prod: VENTS absorbs it | Approved: recover from future earnings | Shortfall → `earnings_recoveries` receivable → `recovery_deduction` from later earnings; never negative | `run-earnings-policy-verification.sh` | Apply 0203 |
| PAY-8 | Settlement hold for organizer / provider earnings | DONE in code (0203); not in prod | Prod: withdrawable immediately | Approved: 48 h after event end / after booking completion (not before the scheduled time); representatives keep 7 days | Holds, blockers (refund per order, disputes, admin/report holds), cron + on-request release, audit basis | `run-earnings-policy-verification.sh` (156) | Apply 0203 |
| PAY-9 | Second-admin approval of payouts | DONE in code (0203); not in prod | Prod: single admin | `authorize_withdrawal` maker-checker | No self-approval; organizer can be neither admin; amount and active bank recipient bound | local-PG (156) + `payoutEngine.security.test.ts` | Apply 0203 |
| EARN-1 | VENTS Work / Earn and representative reward live | PARTIAL | Code (PR #82, 0201); not in prod | `docs/vents-work-earn.md` | 0201 + 0202 applied; legacy 10% reconciliation recorded (dual control); reward credit enabled (dual control); one reward end to end on production with real admins | `run-representative-rewards-verification.sh` (203), payout-gate audit (27) | PAY-1, decisions in PR #82 |
| EARN-2 | VENTS Work screens complete (funnel, monthly performance, reward states, team, provider/organizer entry points) | DONE in code (PR #82, Batch E); reward figures need 0201 in prod | Code | Representative dashboard: Overview (wallet, this month, funnel, lifecycle), Monthly, Rewards (lifecycle filter), Team (partnerships, withdraw/end), Expenses (totals, filters, reasons); hub shortcuts for each active role; earnings screen shows held/owed earnings | Each figure from `get_my_representative_performance` / `get_my_representative_rewards` / live tables; no button without a real action; honest state before 0201; no overflow at 360/390/430px | `representativeDashboard.render.test.tsx` (14), `ventsWork.render.test.tsx` (8), rewards suite dashboard checks (11), harness screenshots | Apply 0201 for live reward data |
| EARN-3 | Rule "verified / admin-approved event" | DONE in code (0201) | Code | Approving admins confirm `event_verified`; organizer must hold an approved, unrevoked verification (re-checked at claim) | — | `run-representative-rewards-verification.sh` (214) | Apply 0201 |
| PAY-10 | Bank-account setup verified on the Supabase backend | UNVERIFIED | Prod | `LAUNCH_CHECKLIST.md` §9 (not re-verified since migration); `MASTER_AUDIT.md` Part 4 #6 (recipient idempotency gap) | Add / remove / set-default works for a real account; a repeated save makes no duplicate recipient | API tests with mocked Paystack | — |
| PROMO-1 | Paid promotions: billing, fulfilment, expiry | PARTIAL | Code + prod (prices match the source) | PR #81 §2 | Featured 14/30-day tiers reconciled with the price list; a promotion activates only after verified payment and expires on time | Existing `activate.pricing.security.test.ts` + expiry test | Price decision |
| REF-1 | Refunds end to end (ticket, booking, transfer fee, upheld booking disputes) | PARTIAL | Code (PR #82) + prod | Refund functions, webhook; 0203 adds recovery and the upheld-dispute refund | Refund request → Paystack → webhook → ticket/booking, wallet and earnings correct; a failed refund recoverable | local-PG (156) + `disputeRefund.security.test.ts`; live ₦100 refund pending (PAY-4) | Apply 0203; PAY-4 |
| SEC-2 | Deferred audit items (`MASTER_AUDIT.md` Part 4) | PARTIAL | Prod | Part 4 #1 Maps key restrictions, #2 185,090 VC reconciliation gap, #9 100,000 VC test credit, #3 push Mode 1 ownership, #5 PostHog masking | Each closed or explicitly accepted by the owner | Per item | Owner decisions |
| OPS-1 | Monitoring and alerting | UNVERIFIED | Prod | Sentry integrated; alert rules unconfirmed (`LAUNCH_CHECKLIST.md` §9) | Alerts for webhook failures, payout errors and 5xx reach a person; a test alert received | — | Owner |
| OPS-2 | Email deliverability (SPF, DMARC) | NOT STARTED (per last check) | DNS | `LAUNCH_CHECKLIST.md` §9 | SPF and DMARC records live; Resend mail passes in Gmail | DNS check | Owner DNS |
| MOB-1 | Android store submission | PARTIAL | — | `LAUNCH_CHECKLIST.md` §1–5, 10 (31 open) | All §1–5 items checked; internal test track build passes the §10 on-device list | §10 on-device list | — |
| MOB-2 | iOS submission | NOT STARTED | — | `IOS_LAUNCH_CHECKLIST.md` (12 open, 0 done) | Every section done; TestFlight build passes §8 | §8 on-device list | Apple account |

## Everything else, by area

Areas not listed as blockers above. Each row is P2 unless marked otherwise.

| ID | Area | Item | Status | Code / Prod | Evidence | Acceptance criteria | Tests |
|---|---|---|---|---|---|---|---|
| AUTH-2 | Authentication | Email/password sign-in, email codes, password reset, persistence | PARTIAL | Prod (sign-in works; sign-up disabled) | `AuthScreen.tsx`; Preview sign-in allowed | Each flow works on web/iOS/Android; rate limit holds; no account enumeration | E2E per platform |
| PROF-1 | Profiles | Profile view/edit, avatar, privacy settings, account deletion | PARTIAL / UNVERIFIED on device | Prod | `LAUNCH_CHECKLIST.md` §10 deletion item open | Deletion anonymises and releases the email; avatar upload within limits | Existing deletion tests + device check |
| EVT-1 | Events | Create (6-step), edit, delete, hide, featured/trending | PARTIAL | Prod | Design checklist Batch 5; admin dual control for hide/delete | Organizer capability enforced; deleted/hidden events vanish from discovery | Existing security tests |
| TIX-1 | Ticket purchase | Paystack checkout, wallet and token purchase, pending-purchase recovery | PARTIAL | Prod (106 paid tickets) | `finalizePaystackPayment.ts`, webhook | Paid → exactly one ticket set; abandoned → no ticket; retry safe | Existing Paystack tests (fix QA-1) |
| QR-1 | QR tickets and check-in | Token generation, scanner, door manager, double-scan | PARTIAL / UNVERIFIED on device | Prod | Design Batch 4; `LAUNCH_CHECKLIST.md` §10 camera | A ticket scans once; a second scan is refused; offline behaviour defined | Device test |
| ORG-1 | Organizers | Request → CAC verification → Creator Studio, payout account | PARTIAL | Prod | `docs/vents-work-earn.md` table | Each state reachable from VENTS Work; staff never see the CTA | `workRoles.test.ts` |
| SP-1 | Providers / vendors | Verification, services, bookings, completion, payout | PARTIAL | Code (PR #82) + prod (2 providers, 7 bookings; 7 with no scheduled date) | 0203: completion not before the scheduled time; 48 h hold; customer dispute window; two-admin resolution; refund on upheld disputes | Booking → payment → completion → earnings; cancel/refund correct | `run-earnings-policy-verification.sh` booking sections |
| WAL-1 | VENTS Wallet (spend-only) | Deposits, spend, VC conversion | PARTIAL | Prod | `get_my_wallet` creates a row on read (`previewReadOnly.ts`) | Deposit verified by Paystack once; never withdrawable | Existing deposit tests |
| VC-1 | VENTS Cents | Earning, tiers, conversion, cash-out | PARTIAL | Prod | `MASTER_AUDIT.md` F2/F8; VC cash-out (`vc_withdrawal_requests`) not covered by the money-flow audit | Audit VC cash-out with the PAY-1 lens | local-PG VC payout tests |
| XFER-1 | Ticket transfers | Initiate / accept / decline, 7.5% fee (₦500–₦5,000) | PARTIAL / UNVERIFIED | Prod | PR #81 §1 | Fee computed and charged per the model; transfer atomic | Unit + local-PG |
| MSG-1 | Messaging | DMs, requests, media, reactions, private realtime | PARTIAL | Prod (0199/0200 applied) | `run-private-realtime-verification.sh` (44) | No cross-user read; media private | Existing suites |
| NOTIF-1 | Notifications / push | In-app, FCM push, cron sweep | PARTIAL / UNVERIFIED on device | Prod | `LAUNCH_CHECKLIST.md` §7, §10; Hobby cron is daily only | Push arrives in foreground/background/terminated states and opens the right screen | Device test |
| SRCH-1 | Search and maps | Fuzzy search, nearby providers, Maps embed | PARTIAL | Prod | `MASTER_AUDIT.md` Part 4 #1 (key restrictions) | Key restricted to app/web referrers; search returns hidden/deleted nothing | Existing search tests |
| ADM-1 | Admin console | Dual control, payouts, verification, reports, VC, system switches | PARTIAL | Prod | `MASTER_AUDIT.md` Part 5a; payouts single-admin (PAY-9) | Every privileged action audited; kill switches work | Existing admin tests |
| SEC-3 | Security / RLS | Table grants and policies, SECURITY DEFINER checks | PARTIAL | Prod | Money tables: no client write grants (verified 2026-10-30); advisor findings in `MASTER_AUDIT.md` | Supabase advisors clean or accepted; no client write grant on money tables | Advisors + security tests |
| ANL-1 | Analytics | PostHog events, masking | UNVERIFIED | Prod | `MASTER_AUDIT.md` Part 4 #5 | Masking confirmed; Preview sends nothing (done in PR #82) | — |
| A11Y-1 | Accessibility | Labels, contrast, focus, dynamic type, screen readers | NOT STARTED | — | No audit on record | WCAG 2.1 AA on core flows (sign-in, browse, buy, ticket) | axe + VoiceOver/TalkBack pass |
| PERF-1 | Performance | Bundle size, cold start, list rendering | NOT STARTED (no budget) | — | Vite warns about chunks > 500 kB | Budgets set (e.g. first load on 4G) and met | Lighthouse / build-size check |
| INF-2 | Infrastructure | Vercel Hobby: 12-function cap, daily cron | PARTIAL | Prod | `LAUNCH_CHECKLIST.md` §9 | Decide Pro vs Hobby; adding a function never breaks deploys | — |
| OPS-3 | Operations | Runbooks: payouts, refunds, Paystack outage, kill switches, migrations | NOT STARTED | — | None in repo | One-page runbook per incident type | — |
| P3-1 | Future | VENTS Unlock / Split / Circle | NOT STARTED (undefined) | — | `docs/vents-work-earn.md` | Definitions first | — |
| P3-2 | Future | Subscriptions, vendor marketplace, sponsored placements | NOT STARTED | — | PR #81 §3–9 | Per PR #81 | — |
| P3-3 | Future | Separate Preview database | NOT STARTED (declined for now) | — | `docs/preview-read-only.md` | — | — |

---

## Execution plan (small batches)

Each batch is one reviewable PR or commit with its own tests. Status as of
PR #82 head (2026-10-30): the money decisions of the first plan (fee model,
refund shortfall, settlement, payout maker-checker, event verification) are
**done in code** in 0201–0203; none is applied to production.

| # | Batch | Items | Size | Gate |
|---|---|---|---|---|
| A | **Fix or formally quarantine the baseline failures**: the 8 Paystack-verify / AI-subscription vitest failures and the tsc error. Then rewrite the stale §9 of `LAUNCH_CHECKLIST.md`. | QA-1, INF-1 | Small | Owner confirmation for §9 facts |
| B | **Reconcile migration 0192 with 0203** (0192 redefines `confirm_ticket_payment` / `credit_organizer_wallet`, so 0203's drift guard refuses to run after it). Then prepare the production apply plan for 0202 → 0201 → 0203. It needs read-only pre-checks, a rollback note and the frontend shipped together. | PAY-1, PAY-3, EARN-1 | Small | PR #82 review |
| C | **Payout operations clean-up** (no code): the 5 stale requests (₦49,100), the 4 test transfers, the 2 ledger gaps. Each gap is closed through an audited adjustment. | PAY-2, PAY-5, PAY-6 | Small | Paystack dashboard access |
| D | **Paystack verification**: confirm the dispute webhook payload and the live/test key mode (PAY-4) from the dashboard. Then one live ₦100 purchase + refund by the owner after the migrations are applied. | PAY-4, REF-1 | Small | Owner; network access to paystack.com |
| E | ~~**VENTS Work screens**~~ — done in code (Batch E, PR #82). | EARN-2 | — | — |
| F | **Bank-account setup and promotions**: recipient idempotency (PAY-10) and featured-tier reconciliation (PROMO-1). | PAY-10, PROMO-1 | Medium | Price decision |
| G | **Store readiness**: Android §1–5, then iOS | MOB-1, MOB-2 | Large | Accounts |
| H | **Operations**: alerts, SPF/DMARC, runbooks (payouts, refunds, disputes, Paystack outage) | OPS-1..3 | Small | Owner DNS/Sentry |
| I | **Accessibility and performance** audits on core flows | A11Y-1, PERF-1 | Medium | — |

**Keeping this current:** update the status and evidence of an item in the same
commit that changes it. Never mark an item DONE without naming the test or
production check that shows it.
