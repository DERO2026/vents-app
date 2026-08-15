# VENTS: InsForge → Supabase Cutover & Rollback Plan

**Status as of this draft: NOT ready to cut over.** ~20 frontend files and 7 backend
API functions still talk to InsForge directly. This document is the plan to follow
once that remaining work is done — it is deliberately honest about what's left
rather than assuming today's state is cutover-ready.

---

## 1. What's already migrated and verified

Everything below has been converted to Supabase and confirmed working with real
authenticated sessions against the live target project (not just typechecked):

- **Schema**: all 42 tables, 51+ FKs (3 real gaps found and closed), 71 indexes,
  84 RLS policies, 155 functions, 24 triggers, storage RLS for all 5 buckets.
- **Data**: full historical migration of every table (users, events, tickets,
  wallets, messages, notifications, admin logs, VC economy, storage files).
- **Auth**: session layer, sign-up/OTP, password-reset, login, change-password —
  all rewritten to Supabase Auth and browser-tested.
- **Realtime**: messaging (new_message/typing) and admin stats broadcast,
  rewired from InsForge's pub/sub to Supabase channels.
- **Features**: events CRUD + bulk import, messaging, admin/reports moderation,
  organizer verification (submission + review), wallets/payouts (full write
  path including both webhooks), push registration + cron worker, QR-scan HMAC
  ticket signing.
- **Payments**: full Paystack test-mode run-through — happy path, duplicate
  webhook, bad signature, amount mismatch, abandoned checkout — all verified
  against the real webhook handler code with real signed payloads.
- **Auth config**: custom SMTP (Resend) live, OTP-code email templates fixed,
  `site_url`/redirect allow list set to production values.
- **Infrastructure**: `project_admin` direct-Postgres-connection pattern
  established for the handful of RPCs that are deliberately not reachable via
  anon/authenticated/service_role (mirrors InsForge's own admin-key boundary).

## 2. What's NOT yet migrated (the actual blockers)

### Frontend (still calling `insforge.database`/`.storage`/`.realtime`)
| File | Why it matters |
|---|---|
| `src/app/App.tsx` | Deep-link event/user lookups, status-email token — partial, not full-file |
| `AdminDashboardScreen.tsx`, `AdminActionsTab.tsx` | VC economy tab, organizer-verification tab (explicitly deferred) |
| `AttendeeListScreen.tsx`, `EventDetailsScreen.tsx`, `ExploreScreen.tsx`, `HomeScreen.tsx`, `ProfileScreen.tsx`, `UserProfileScreen.tsx` | Not yet audited this pass |
| `CheckinScannerScreen.tsx`, `src/lib/useDoorManager.ts` | Door Manager subsystem — check-in ledger, door RPCs, `door:%` realtime channel |
| `ConversationScreen.tsx`, `InboxScreen.tsx` | `public_profiles` lookups only (deliberately left — different feature) |
| `InterestsScreen.tsx`, `PrivacySecurityScreen.tsx`, `SettingsScreen.tsx` | Not yet audited this pass |
| `OrganizerDashboard.tsx`, `src/lib/useOrganizerEvents.ts` | Organizer's own dashboard data |
| `ReferralScreen.tsx`, `src/lib/vcBalanceCache.ts` | VC/Vents-Cents economy — consistently scoped out as a separate feature all migration |
| `ReportModal.tsx` | Report submission |

### Backend (Vercel functions still using `VITE_INSFORGE_URL`/`INSFORGE_API_KEY`)
| File | Risk if not converted |
|---|---|
| `api/_lib/verifyAuth.ts` | **Foundational** — `verifyInsforgeSession`/`confirmPassword`/`enforceRateLimit` are shared helpers other functions depend on for identity verification. Must convert before anything depending on it works. |
| `api/wallet/save-bank.ts`, `resolve-account.ts` | Organizer bank-account management (add/verify) |
| `api/wallet/refund-ticket.ts` | Ticket refunds — explicitly out of scope every time it came up |
| `api/notify/status-email.ts` | Ticket/decision confirmation emails |
| `api/promotions/activate.ts` | Paid event promotions |
| `api/push/send.ts` | Manual admin push send (separate from the cron worker, already converted) |
| `api/webhook/paystack.ts` `refund.*` branch | `charge.success` and `transfer.*` are converted; refunds are not |

### Non-code
- **Live data drift**: InsForge has been taking real writes throughout this
  entire migration (new signups, push tokens, messages). Every table needs a
  **final delta sync** immediately before cutover, not just the original
  historical migration.
- **Native deep-link scheme**: the Capacitor app's redirect currently resolves
  to `https://localhost/` (added to the Supabase allow list as a stand-in).
  A real custom URL scheme is needed before app-store submission; email/OTP
  flows haven't been tested on iOS/Android yet.

---

## 3. Pre-cutover checklist

Do not schedule a cutover window until every box below is checked.

- [ ] All frontend files in §2 converted to `supabase`, typechecked, browser-verified
- [ ] `api/_lib/verifyAuth.ts` converted (blocks everything downstream of it)
- [ ] All 6 remaining Vercel functions in §2 converted
- [ ] `refund.*` webhook branch converted and tested (mirroring the `charge.success`/`transfer.*` test rigor)
- [ ] `src/lib/insforge.ts` usage reduced to zero across `src/` and `api/` (grep for `insforge\.` returns nothing outside the file itself)
- [ ] Native email/OTP flows tested on a real iOS and Android build
- [ ] Full regression pass on Supabase: sign up → verify → browse → purchase → check in → message → admin-moderate, on a fresh device/session
- [ ] `VITE_PAYSTACK_PUBLIC_KEY` / `PAYSTACK_SECRET_KEY` confirmed as **live** keys are what's set in Vercel's production environment (not the test keys used for migration verification)
- [ ] Vercel environment variables added for production: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `PROJECT_ADMIN_DATABASE_URL` (or equivalent), `SUPABASE_JWT_SECRET` (if still relevant), removing `VITE_INSFORGE_URL`/`VITE_INSFORGE_ANON_KEY`/`INSFORGE_API_KEY` only after confirming nothing reads them
- [ ] Rollback plan (§5) reviewed and understood by whoever is on call during the cutover window

---

## 4. Cutover sequence

**Timing**: choose a low-traffic window. Announce to the team in advance —
this has a hard freeze step (§4.2) that blocks new signups/purchases briefly.

### 4.1 T-minus: final code deploy (no traffic switch yet)
1. Merge the migration branch to `main` through the normal PR process — **only
   after every box in §3 is checked.**
2. Deploy to a preview/staging environment first (Vercel preview deployments),
   pointed at Supabase. Smoke-test the full regression pass from §3 there.
3. Do **not** deploy to production yet — production still points at InsForge.

### 4.2 Freeze window (short — minutes, not hours)
1. Put InsForge into read-only mode, or block writes at the application layer
   (feature-flag `disable_purchases`/`disable_signups`/`disable_payouts` via
   `app_config` — the admin dashboard toggles already exist and work on both
   backends).
2. Confirm no in-flight writes: check `pending_purchases` and
   `organizer_withdrawal_requests` for anything mid-flight; let those settle
   or explicitly resolve them before proceeding.

### 4.3 Final delta sync
1. Re-run the same read-only audit pattern used throughout this migration
   (row-count diff per table between InsForge and Supabase) to find every row
   InsForge has that Supabase doesn't.
2. Migrate just the delta using the same transactional/idempotent script
   pattern (`ON CONFLICT DO NOTHING`) already established in
   `supabase/auth-migration/` — these scripts are reusable, just re-run them.
3. Re-verify row counts match exactly across every table.

### 4.4 Switch traffic
1. Update Vercel production environment variables to point at Supabase.
2. Deploy `main` to production.
3. Lift the freeze from §4.2 (re-enable purchases/signups/payouts via
   `app_config`).
4. Update the Paystack webhook URL in the Paystack dashboard if it changed
   (it shouldn't have — same Vercel endpoint — but confirm).

### 4.5 Post-cutover verification (first 30 minutes)
1. Watch Vercel function logs and Supabase's own logs for error spikes.
2. Do one real, tiny end-to-end purchase yourself (with your own card, in
   **live** mode this time) to confirm the whole chain works for real.
3. Confirm a real signup + OTP email arrives and completes.
4. Confirm the cron worker's next scheduled run (`api/cron/run.ts`) completes
   without error — check Vercel's cron execution log.
5. Watch for the `admin:stats` realtime dashboard updating live as real
   transactions happen.

### 4.6 Decommission InsForge (only after a stable observation period)
- Recommend **at least 1–2 weeks** of stable Supabase operation before
  actually deleting/canceling the InsForge project — keep it as a read-only
  reference in case rollback is needed (§5) or an audit question comes up
  about pre-cutover data.

---

## 5. Rollback plan

Rollback is only safe **before** §4.6 (InsForge decommissioned). The later
into §4 you are, the more real post-cutover data exists only on Supabase —
rolling back means either losing it or migrating it backward, which is a much
bigger operation than the forward migration this whole project has been.

### 5.1 If something breaks during §4.4–4.5 (traffic just switched, <30 min in)
1. Revert the Vercel deployment to the last InsForge-pointed build (Vercel
   keeps previous deployments — this is a one-click revert, not a rebuild).
2. Re-enable writes on InsForge (undo §4.2's freeze).
3. **Data reconciliation**: any writes that happened on Supabase during the
   brief live window (new signups, ticket purchases, messages) need to be
   replayed onto InsForge before it resumes as the source of truth — same
   delta-sync pattern as §4.3, but in reverse. This is the single riskiest
   part of a rollback; the shorter the live-on-Supabase window before
   rollback, the smaller this reconciliation is.
4. Re-run the regression pass against InsForge to confirm it's genuinely
   healthy before calling the rollback complete.

### 5.2 If something breaks later (hours/days in, real data only on Supabase)
Full rollback to InsForge is likely **not the right call** at this point —
the reconciliation cost exceeds fixing forward. Options in order of
preference:
1. **Fix forward**: identify the specific broken RPC/endpoint/flow and patch
   it directly (this migration has already demonstrated the pattern
   repeatedly — e.g. the ambiguous-column and pgcrypto-schema bugs were found
   and fixed live in minutes each).
2. **Partial rollback**: disable just the broken feature via `app_config`
   kill switches while the rest of the app keeps running on Supabase.
3. **Full rollback**: only if the above two are genuinely not viable (e.g. a
   platform-wide outage, not a single bad function) — follow §5.1's
   reconciliation process, scaled to however much data has accumulated.

### 5.3 What makes rollback safe (why this migration was built this way)
- Every migration script is idempotent (`ON CONFLICT DO NOTHING`) — safe to
  re-run in either direction without duplicating data.
- InsForge itself was never modified — every operation against it throughout
  this entire migration was read-only. It remains a fully intact, working
  system to roll back to, right up until §4.6.
- The Supabase schema mirrors InsForge's exactly (same UUIDs, same column
  names, same business logic) — a delta-sync script in either direction is
  the same shape of script already proven throughout this migration, not new
  work invented during an incident.

---

## 6. Open questions to resolve before scheduling a cutover date

1. Who is on call during the cutover window, and what's the decision
   authority for triggering rollback vs. fixing forward?
2. Is there a maintenance-mode banner ready for the freeze window (§4.2), or
   does `app_config.maintenance_mode` need to be actually wired to a visible
   UI state first?
3. Confirm the native app's App Store/Play Store build doesn't need to change
   simultaneously — if the deep-link scheme work is still pending, does the
   native app's InsForge-format email links stay broken until that's done
   regardless of backend cutover?
4. Confirm whether email delivery volume on Resend's plan can handle real
   production signup/reset volume (was only tested with a handful of test
   sends).
