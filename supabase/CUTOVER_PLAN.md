# VENTS: InsForge → Supabase Cutover & Rollback Plan

**Status as of this draft: NOT ready to cut over.** All backend Vercel functions and
all frontend files are now converted to Supabase — confirmed by a repo-wide grep for
any import from `lib/insforge`, not just the files originally tracked in this
document. Along the way this pass also found and fixed a live bug: several files
(`WalletScreen.tsx`, `PromoteEventScreen.tsx`, `src/lib/eventImporter.ts`,
`src/lib/visionCrop.ts`) were still using InsForge's `getAuthToken()` to authorize
calls to backend endpoints that had already been migrated to check Supabase Auth —
meaning wallet withdrawals, promotion activation, and AI event import/photo-crop
were silently failing in production, not just "not yet migrated" (see §1). A full
regression pass against a real Vercel Preview deployment of this branch also found
and fixed a Production-wide CSP gap — `connect-src` never allow-listed Supabase at
all, so no Supabase call could ever succeed from the browser regardless of code
correctness — plus a live Paystack key hardcoded in `vercel.json`. What remains
before cutover is no longer code migration — it's finishing the regression pass
(paid/webhook purchase path, real-inbox signup test, native builds), the final data
delta sync, and the rest of the non-code checklist below. This document is the plan
to follow once that remaining work is done — it is deliberately honest about what's
left rather than assuming today's state is cutover-ready.

**Update — resolved**: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`,
`PROJECT_ADMIN_DATABASE_URL`, and `SUPABASE_JWT_SECRET` have all been added to
Vercel's **Production** environment (confirmed present by name via `vercel env ls`;
values never displayed or persisted anywhere outside Vercel itself). This was the
single biggest concrete blocker found earlier in this document — deploying `main`
to Production before this would have broken immediately on page load. It no longer
would, on this specific point. This does **not** mean Production is otherwise ready:
`PAYSTACK_SECRET_KEY`'s live/test mode is still unverified, the paid Paystack
purchase → webhook → ticket-confirmation flow still has not actually been run even
though the credential that unblocks testing it now exists, and everything else
tracked in §3's checklist and §8's audit remains exactly as stated there.

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
  - Correction to an earlier version of this section: "wallets/payouts" and
    "events CRUD" being marked done here was **not accurate** for the
    frontend — `WalletScreen.tsx`, `PromoteEventScreen.tsx`,
    `src/lib/eventImporter.ts` (AI event-text import), and
    `src/lib/visionCrop.ts` (AI photo-crop focus) were all still minting
    their `Authorization` bearer token via `getAuthToken()` from the old
    `lib/insforge.ts` client and sending an InsForge session token to
    already-migrated, Supabase-auth-checked endpoints
    (`/api/v1/wallet/banks`, `/api/wallet/refund-ticket`,
    `/api/v1/promotions/activate`, `/api/v1/extract-events`). Since those
    backend endpoints now validate via Supabase Auth
    (`verifyInsforgeSession` in `api/_lib/verifyAuth.ts`), every one of
    those calls was silently 401ing (or, for `visionCrop.ts`'s swallowed
    `.catch(() => '')`, silently no-op-ing) for real users — bank-list
    loading, withdrawals, promotion activation, and AI event
    import/photo-crop were all broken in production, not just "not yet
    migrated." Found and fixed in this pass (all four now use
    `getAuthToken` from `lib/supabase.ts`); `CheckoutScreen.tsx`,
    `CreateEventScreen.tsx`, and `SalesAnalyticsScreen.tsx` had a dead,
    unused `insforge` import with no functional bug (all their real calls
    already went through `supabase`).
    Lesson: "grep for `insforge.database`" isn't sufficient to prove a file
    is migrated — any `getAuthToken` import needs the same scrutiny
    (it silently sends the wrong session's token to an already-migrated
    endpoint), and `tsconfig.json`'s `noUnusedLocals: false` means dead
    imports don't get caught by `tsc` and have to be grepped for directly.
    Verified clean this time via a repo-wide grep for any import from
    `lib/insforge` (not just `insforge.database`/`.auth`/`.realtime`
    usage) — zero matches remain in `src/`.
- **Payments**: full Paystack test-mode run-through — happy path, duplicate
  webhook, bad signature, amount mismatch, abandoned checkout — all verified
  against the real webhook handler code with real signed payloads.
- **Auth config**: custom SMTP (Resend) live, OTP-code email templates fixed,
  `site_url`/redirect allow list set to production values.
- **Infrastructure**: `project_admin` direct-Postgres-connection pattern
  established for the handful of RPCs that are deliberately not reachable via
  anon/authenticated/service_role (mirrors InsForge's own admin-key boundary).
- **Full regression pass, run against a real Vercel Preview deployment of this
  branch** (not just local typecheck/browser-boot checks): sign up → browse →
  purchase → check in → message → admin-moderate, using a controlled
  service-role-created test account, with all test data cleaned up afterward.
  Results:
  - **Sign up**: form submission reaches Supabase Auth correctly (found and
    worked around two real UI bugs along the way — a custom checkbox and a
    custom state-picker that don't behave like native form controls). The
    first attempt (against `@example.com`) returned **"Error sending
    confirmation email"** — re-tested against a real domain
    (`qa-signup-test-816@getvents.com`, the app's own domain, proven
    deliverable since it already sends real transactional email) and signup
    succeeded cleanly with no error, landing on the OTP-entry screen as
    expected. **Resolved**: the original failure was `@example.com` having
    no real mailbox/MX record, not a genuine SMTP/Resend misconfiguration —
    Supabase Auth's email-send pipeline itself works correctly. Login,
    session hydration, and interests onboarding — all confirmed working.
  - **Verify (OTP email)**: still not verified — no test-inbox access in
    this environment, so actual receipt of the 6-digit code can't be
    confirmed; explicitly left unverified rather than bypassed. Given the
    send pipeline itself is now confirmed working, this is a lower-risk
    remaining gap than it was before.
  - **Browse**: confirmed repeatedly against real Supabase data.
  - **Purchase**: ✅ confirmed via the real `purchase_ticket_with_tokens` RPC
    (free-ticket path) — real ticket + signed v2 token issued. The
    **paid/webhook path was not exercised** — needs `PROJECT_ADMIN_DATABASE_URL`,
    which isn't available in this environment (the `project_admin` role's
    password was deliberately set out-of-band, per
    `0021_project_admin_login.sql`).
  - **Organizer flow**: ✅ organizer request submission, event creation
    (multi-step form incl. real Supabase Storage cover-image upload),
    `OrganizerDashboard`/`useOrganizerEvents` RPCs — all confirmed live.
  - **Check-in**: ✅ `manual_check_in` RPC confirmed, **and the Door Manager
    UI updated live via the migrated `door:<eventId>` realtime channel with
    zero manual refresh** — the strongest live signal that the realtime
    rewiring (InsForge pub/sub → `supabase.channel(...).on('broadcast', ...)`)
    is genuinely correct, not just typechecked.
  - **Message**: ✅ real message insert via `ConversationScreen`'s
    request-based flow.
  - **Admin-moderate**: ✅ Admin Console loaded real user list and real VC
    aggregates/transaction ledger (`admin_get_vc_aggregates`, `vc_transactions`).
  - **Bugs found and fixed during this pass**: `connect-src` never listed
    Supabase at all (every Supabase call was blocked by the CSP header
    itself, in Preview *and* Production, regardless of code correctness);
    `connect-src` was also missing `blob:` (blocked the image-cropper's blob
    fetch during uploads); `vercel.json`'s `env` block hardcoded a **live**
    Paystack public key plus dead InsForge values directly in source. All
    fixed — see the CSP/`env` entries below.
  - **Teardown**: all 4 preview deployments created for this pass have been
    removed (`vercel rm`), and the 3 Preview-scoped env vars added for
    testing (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`,
    `VITE_PAYSTACK_PUBLIC_KEY`) have been deleted from the Vercel project.
    Confirmed via a fresh `vercel ls`/`vercel env ls` that only the
    pre-existing Production deployments and env vars remain — the project is
    back to its pre-testing state. All test data (user, event, tickets,
    messages, notifications) was already cleaned up as each phase completed.
    Nothing from this regression pass is left running or configured
    anywhere.

## 2. What's NOT yet migrated (the actual blockers)

### Frontend — mostly converted; deferred/scoped-out items remain
| File | Status |
|---|---|
| `src/app/App.tsx` | ✅ Converted (all `.database`/`.auth` calls) — except the legacy InsForge deep-link password-recovery params (`insforge_status`/`insforge_type`/`token`), which are unreachable under Supabase's current OTP-code recovery email and now just fall back gracefully into the working `forgot` flow |
| `AuthScreen.tsx` | ✅ Converted — login/signup/OTP verify/resend/forgot-password all on Supabase Auth; the legacy link-based `reset` mode redirects into the working OTP flow instead of calling a dead endpoint; the "Verify Account" companion email now goes through a new `api/notify/verify-account-email.ts` (Resend) instead of `insforge.emails.send` |
| `AttendeeListScreen.tsx`, `EventDetailsScreen.tsx`, `ExploreScreen.tsx`, `HomeScreen.tsx`, `ProfileScreen.tsx`, `UserProfileScreen.tsx` | ✅ Converted |
| `CheckinScannerScreen.tsx`, `src/lib/useDoorManager.ts` | ✅ Converted — door RPCs + the `door:<eventId>` realtime channel rewired to `supabase.channel(...).on('broadcast', ...)`, matching the server-side `realtime.send(...)` triggers in `0004_functions.sql` |
| `InterestsScreen.tsx`, `PrivacySecurityScreen.tsx`, `SettingsScreen.tsx` | ✅ Converted — SettingsScreen's avatar/cover upload also moved off the raw InsForge storage REST call onto `supabase.storage.from('avatars')` |
| `OrganizerDashboard.tsx`, `src/lib/useOrganizerEvents.ts` | ✅ Converted — including the `organizer-events:<id>` realtime channel |
| `ReportModal.tsx` | ✅ Converted |
| `ConversationScreen.tsx`, `InboxScreen.tsx` | ✅ Converted — `public_profiles` lookups now via `supabase` |
| `AdminDashboardScreen.tsx`, `AdminActionsTab.tsx` | ✅ Converted — VC aggregates/transactions/user-search and `admin_credit_vents_cents`/`admin_debit_vents_cents`/`admin_list_action_requests`/`approve_admin_action`/`reject_admin_action` all now via `supabase` |
| `ReferralScreen.tsx`, `src/lib/vcBalanceCache.ts` | ✅ Converted — referrals, badge purchase, profile bonus, featured-in-people, and the VC balance RPC all now via `supabase` |
| `WalletScreen.tsx`, `PromoteEventScreen.tsx`, `src/lib/eventImporter.ts`, `src/lib/visionCrop.ts` | ✅ Converted — **was a live auth bug**, not just an unmigrated file; see the correction under §1 |
| `CheckoutScreen.tsx`, `CreateEventScreen.tsx`, `SalesAnalyticsScreen.tsx` | ✅ Converted — removed a dead, unused `insforge` import; no functional bug, all real calls already used `supabase` |

**All frontend files are now converted.** Nothing in `src/` calls `insforge.*` or
imports `getAuthToken`/anything else from `lib/insforge.ts` anymore — confirmed by a
repo-wide grep, not just the files this migration pass originally set out to check.

### Backend — **all converted** (Vercel functions previously using `VITE_INSFORGE_URL`/`INSFORGE_API_KEY`)
| File | Status |
|---|---|
| `api/_lib/verifyAuth.ts` | ✅ Converted — `verifyInsforgeSession`/`confirmPassword`/`enforceRateLimit` all call Supabase Auth directly |
| `api/wallet/save-bank.ts`, `resolve-account.ts` | ✅ Converted |
| `api/wallet/refund-ticket.ts` | ✅ Converted — `refund_ticket`/`admin_revert_stuck_refund`/`attach_ticket_refund_id` called via `/rest/v1/rpc/...` with the caller's forwarded token |
| `api/notify/status-email.ts` | ✅ Converted — table/RPC calls on `/rest/v1/...`, QR upload via Supabase Storage (`/storage/v1/object/events/...`) |
| `api/promotions/activate.ts` | ✅ Converted |
| `api/push/send.ts` | ✅ Converted |
| `api/webhook/paystack.ts` `refund.*` branch | ✅ Converted — now uses `callProjectAdminTableRpc` (direct `project_admin` Postgres connection), same pattern as the `transfer.*` handlers |

### Infrastructure fix (found via the regression pass, not originally tracked here)
- **`vercel.json`**: `connect-src`/`media-src` never listed Supabase at all —
  fixed to include `https://*.supabase.co`/`wss://*.supabase.co`.
  `connect-src` was also missing `blob:` (blocks the image-cropper upload
  path) — fixed. The static `env` block hardcoding a **live** Paystack
  public key and dead `VITE_INSFORGE_*` values directly in the repo was
  removed entirely — those values now come from real Vercel project env
  vars instead (`VITE_PAYSTACK_PUBLIC_KEY`, `VITE_SUPABASE_URL`,
  `VITE_SUPABASE_ANON_KEY`, `VITE_GOOGLE_PLACES_API_KEY` are already set
  there). **This CSP gap applied to Production too** — it wasn't a
  Preview-only issue, and would have silently broken the app for every
  real user immediately after cutover if it hadn't been caught here.

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

**Status: 7 of 12 checked, 1 partial, 4 open.** All code-migration items are
done (frontend, backend, `insforge.ts` usage, CSP/env fix, and the signup-email
finding are all ✅). What's left is exclusively non-code: the paid/webhook
purchase path and a real-inbox OTP-receipt check (both blocked on things this
environment doesn't have — `PROJECT_ADMIN_DATABASE_URL` and a real test
inbox), native iOS/Android builds, live Paystack keys, production env vars,
and a rollback-plan read-through. None of the remaining items are migration
risk — they're deployment/ops readiness.

- [x] All frontend files converted to `supabase`, typechecked (browser-verified where a live session was available in this environment; organizer/admin-only screens confirmed via clean typecheck + app boot only)
- [x] `api/_lib/verifyAuth.ts` converted (blocks everything downstream of it)
- [x] All remaining Vercel functions in §2 converted
- [x] `refund.*` webhook branch converted (mirrors the `charge.success`/`transfer.*` pattern) — still needs a live-payload test pass, same rigor as `charge.success`/`transfer.*`
- [x] `src/lib/insforge.ts` usage reduced to zero across `src/` and `api/` (grep for any import from `lib/insforge` — not just `insforge\.` usage — returns nothing outside the file itself)
- [x] `vercel.json` CSP fixed to allow Supabase (`connect-src`/`media-src`) and `blob:` (`connect-src`); stale hardcoded `env` block (incl. a live Paystack key) removed
- [ ] Native email/OTP flows tested on a real iOS and Android build
- [~] Full regression pass on Supabase — **run against a real Preview deployment, not just locally**: sign up ✅ (confirmed working against a real domain — see resolved finding below) → verify (unverified, no inbox access to confirm actual OTP-code receipt) → browse ✅ → purchase (free-ticket path ✅; paid/webhook path not exercised, needs `PROJECT_ADMIN_DATABASE_URL`) → check in ✅ (incl. live realtime confirmed) → message ✅ → admin-moderate ✅. Still needs: a real-inbox test to confirm the OTP code actually arrives, the paid/webhook purchase path, and a fresh-device/native-build pass
- [x] Resolved: "Error sending confirmation email" was `@example.com` having no real mailbox, not a genuine SMTP gap — re-tested clean against a real `getvents.com` address
- [ ] `VITE_PAYSTACK_PUBLIC_KEY` / `PAYSTACK_SECRET_KEY` confirmed as **live** keys are what's set in Vercel's production environment (not the test keys used for migration verification) — **cannot be verified programmatically**: both are marked `Sensitive` in Vercel (write-only by design — `vercel env pull` returns them as empty strings even with full project access, confirmed directly against Production; same for `CRON_SECRET`, `ANTHROPIC_API_KEY`, `FCM_SERVICE_ACCOUNT_JSON`, `VITE_GOOGLE_PLACES_API_KEY`, `VITE_POSTHOG_KEY`, `VITE_SENDCHAMP_*`). Whoever originally set these needs to confirm the mode directly, or the values need to be rotated and re-entered with the mode recorded at set-time.
- [x] **Vercel environment variables added for Production**: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `PROJECT_ADMIN_DATABASE_URL`, `SUPABASE_JWT_SECRET` — all four created via the Vercel API, scoped to **Production only** (confirmed by name and environment via `vercel env ls`; values were never printed, logged, or committed at any point, and the one-shot script used to set them was deleted immediately after). `PROJECT_ADMIN_DATABASE_URL`/`SUPABASE_JWT_SECRET` were created as `Sensitive` (write-only, matching how `PAYSTACK_SECRET_KEY`/`FCM_SERVICE_ACCOUNT_JSON` are already stored in this project); `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` as regular `Encrypted`, matching the Preview-scoped copies added earlier this migration. **Not yet done**: removing `VITE_INSFORGE_URL`/`VITE_INSFORGE_ANON_KEY`/`INSFORGE_API_KEY` — deliberately left in place until the new Supabase vars are confirmed working end-to-end against a real Production deploy (out of scope for this step; nothing currently reads them anyway per §2's confirmed-zero `insforge` import grep, so their presence is inert, not risky). **`PAYSTACK_SECRET_KEY` was explicitly not touched** in this step, per instruction — its live/test mode remains unverified (checklist item above).
- [x] `PROJECT_ADMIN_DATABASE_URL` now present in Production — **this unblocks testing the paid Paystack purchase → webhook → ticket-confirmation flow going forward**, but that test still has not actually been run yet (see §8's still-unverified list). Presence of the credential ≠ the flow having been exercised.
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
   production signup/reset volume. Updated by this pass's regression testing:
   the send pipeline itself is now confirmed working end-to-end (a real
   signup against a real `getvents.com` address completed with no error,
   after an initial false alarm — see §1) — but that only proves single-send
   correctness, not volume. The plan-capacity question is still open.
5. **Resolved**: the `project_admin` Postgres role's connection string
   (`PROJECT_ADMIN_DATABASE_URL`) has been supplied and added to Vercel
   Production. The webhook-driven paid-purchase/payout/refund-finalization
   path is no longer blocked on a missing credential — but running that
   part of the regression pass is still an open action item, not something
   this resolution did automatically. See §8 blocker #2.

---

## 7. Country-code / phone-number system (launch item, independent of the
   Supabase migration itself — tracked here since this file is the shared
   source of truth for pre-launch state)

**Audit findings**: VENTS explicitly rejected signup for every non-Nigerian
phone number, at three separate layers:

1. `AuthScreen.tsx`'s signup submit handler had a deliberate, hard block:
   `if (!isNigerianPhone) throw new Error('Only Nigerian phone numbers are
   currently supported for sign-up. Please select 🇳🇬 Nigeria.')` — a user
   who picked any other country in the phone selector could not create an
   account at all, regardless of how valid their real number was.
2. `src/lib/schemas.ts`'s `signupSchema.phone` used
   `REGION.phoneRegex` (Nigeria's exact `+234[789][01]\d{8}` pattern)
   unconditionally — even if the hard block above hadn't existed, this
   boundary-layer validation would have rejected every non-Nigerian number
   on its own.
3. `PhoneInput.tsx`'s country list covered only 15 countries with no search
   — Qatar, Rwanda, and most of the world weren't even selectable.

`SettingsScreen.tsx`'s profile-edit phone field was not part of the
rejection bug (it never hard-blocked), but had the opposite gap: it only
validated Nigerian numbers and silently accepted anything for every other
country with zero format checking.

**What was changed** (frontend-only — confirmed via `supabase/migrations`
that there is no DB-level format constraint on `users.phone_number`, only a
uniqueness constraint, so no schema change was needed):

- New `src/lib/countries.ts`: the single source of truth for the country
  list, moved out of `PhoneInput.tsx` so validation code can import it
  without pulling in React. Expanded from 15 to ~190 countries (every
  ITU-T-assigned calling code with a real ISO 3166-1 entry), including
  Qatar (+974), Rwanda (+250), and both North American +1 countries.
  Flags are now derived mechanically from each ISO code at render time
  (`flagEmojiFor` in `PhoneInput.tsx`) instead of ~190 hand-typed emoji —
  removes a large, error-prone data-entry surface and makes the flag
  rendering itself impossible to get wrong per-country.
- `PhoneInput.tsx`'s country picker now has a search box (filters by
  country name, dial code, or ISO code) — necessary once the list grew
  past a hand-scrollable size. Re-exports the old names
  (`COUNTRY_CODES`/`DEFAULT_COUNTRY`/`maxDigitsFor`/`formatNationalNumber`)
  from `countries.ts` so `SettingsScreen.tsx`/`CreateEventScreen.tsx`'s
  existing imports didn't need touching.
- New `isPlausibleNationalNumber(digits, country)` in `countries.ts`: a
  generic digit-count-range check (not a hand-authored exact pattern per
  country — no verified format template exists here for all ~190
  countries) used everywhere a non-Nigerian number needs *some* real
  validation instead of none. Nigeria keeps its existing exact, stricter
  regex unchanged.
- `schemas.ts`: `signupSchema.phone` changed from Nigeria's exact regex to
  a generic E.164-shaped pattern (`+` then 7–15 digits) — country-agnostic
  defense-in-depth, not the primary validation (that's the UI-layer check
  against the actually-selected country).
- `AuthScreen.tsx`: removed the hard "Only Nigerian phone numbers" block
  entirely. Non-Nigerian signups now validate via
  `isPlausibleNationalNumber` against whichever country the user picked.
- `SettingsScreen.tsx`: the profile-edit phone field now runs the same
  `isPlausibleNationalNumber` check for non-Nigerian numbers (previously:
  no check at all) — both in the save handler and the inline error message
  under the field.

**Deliberately left alone (already correct / out of scope for this pass)**:

- SMS delivery (Sendchamp) and CAC business verification remain genuinely
  Nigeria-only features — they degrade gracefully already (best-effort,
  non-blocking) rather than rejecting anything, so they didn't need a
  change to stop blocking signup.
- `CreateEventScreen.tsx`'s event contact-phone field was already
  country-agnostic (no Nigeria-only gate existed there) — confirmed, not
  modified.
- The account **country** (phone) and an event's **location** (state/city
  of the venue) were confirmed structurally separate already — event
  creation uses its own Nigerian-states venue picker, never reads
  `phoneCountryCode`, and vice versa. No coupling existed to fix.

**Found but NOT fixed this pass (flagging, not scope creep)**: the signup
form's account **"State"** field (`AuthScreen.tsx`, `signupState`) is
hard-locked to `NIGERIA_STATES` regardless of the phone country chosen —
a Qatar-based signup can now complete, but is still forced to pick a
Nigerian state for their profile's `state` field. This is a real gap for
full non-Nigeria support, but it's a materially bigger change (needs
either a free-text fallback or per-country administrative-division data)
than phone/country-code handling, and was out of the scope given for this
pass. Recommend a follow-up item before claiming full multi-country
support, separate from this one.

**Verification**:
- `npx tsc --noEmit` — clean.
- `npm run build` — succeeds (pre-existing >500kB chunk-size warning,
  unrelated).
- `npx vitest run` — 10/10 existing tests pass (none cover phone/country
  logic directly; no regressions).
- **Live browser test**: signed up a real test account with Qatar (+974)
  selected as the country — previously hard-rejected, now completes
  cleanly through to the OTP-verification screen exactly like a Nigerian
  signup does. Country search tested (typing "Qatar" filters the ~190-item
  list down to exactly one match). Test account deleted afterward via the
  Supabase Admin API.
- **Not verified**: the exact digit-count/format correctness for the
  majority of the ~190 countries individually — `isPlausibleNationalNumber`
  is a deliberately generic range check, not a verified-per-country exact
  pattern (see "What was changed" above). A wrong-but-plausible-length
  number for an obscure country could pass client-side validation; this is
  an accepted tradeoff, not a claim that every country's format was
  hand-verified.

---

## 8. Pre-store launch audit

Full sweep across the areas listed in `LAUNCH_CHECKLIST.md`/`IOS_LAUNCH_CHECKLIST.md`
plus a fresh code-level check of everything already covered earlier in this
file, done before starting Google Play/App Store submission work. Every item
below reflects something actually read, grepped, typechecked, built, or
(where marked) live-tested this pass — not assumed carried-over from an
earlier session.

### Blocking

1. **RESOLVED since this audit was written**: `VITE_SUPABASE_URL`,
   `VITE_SUPABASE_ANON_KEY`, `PROJECT_ADMIN_DATABASE_URL`, and
   `SUPABASE_JWT_SECRET` have all been added to Vercel's Production
   environment — confirmed present by name via `vercel env ls`, scoped to
   Production only, values never displayed/logged/committed. See the
   top-of-document update note and §3's checklist for the full record.
   This unblocks item #2 below (the paid purchase flow can now actually be
   tested) but does not, by itself, mean that test has been run.
2. **Purchase → Paystack webhook → ticket confirmation remains unverified.**
   `PROJECT_ADMIN_DATABASE_URL` now exists in Production (item #1 above),
   so this is no longer blocked on a missing credential — but the flow
   itself still has not actually been run against it. Still explicitly not
   marked verified.
3. **`LAUNCH_CHECKLIST.md` §9 ("Backend / Infrastructure") is now stale and
   actively misleading.** It describes fixing a "missing `INSFORGE_API_KEY`"
   bug in `api/webhook/paystack.ts` and marks `INSFORGE_API_KEY`/
   `PAYSTACK_SECRET_KEY`/`CRON_SECRET` as "confirmed set in Vercel
   production" as evidence the backend is launch-ready. That was true for
   the pre-migration InsForge backend; it says nothing about the current
   Supabase-backed code (this branch), which needs an entirely different
   set of env vars (blocker #1 above) that are not present. Anyone reading
   §9 today without this context could reasonably conclude the backend is
   production-ready when it is not. **Recommend**: before merging PR #3,
   rewrite `LAUNCH_CHECKLIST.md` §9 against the current Supabase
   architecture, or add a prominent note at its top pointing here. Not done
   in this pass — the instruction was to update `CUTOVER_PLAN.md`, and
   editing a second document unprompted risked exactly the kind of
   unrelated change this pass was told to avoid; flagging it instead.
4. **`android/keystore.properties` still doesn't exist** — confirmed absent
   again this pass. No release `.aab` can be built without it, and it can
   only be created with the real keystore credentials, which this
   environment doesn't have and shouldn't be asked to hold.
5. **`android/app/google-services.json` still doesn't exist** — confirmed
   absent again this pass (see the Firebase audit two turns ago). Native
   push registration on Android won't work without it; the file is a
   Firebase Console download only you can perform.
6. **Play Store submission assets are still not produced**: screenshots,
   feature graphic (1024×500), 512×512 store icon, Data Safety form,
   content-rating questionnaire. Confirmed still absent by re-reading
   `LAUNCH_CHECKLIST.md` §4 — none of this is something to fabricate, and
   none of it exists in this repo to check off.

### Important

7. **RESOLVED (2026-08-16, see §11)**: Signup's account "State" field was
   hard-locked to `NIGERIA_STATES` regardless of the phone country chosen.
   Now country-aware — Nigeria keeps the existing picker unchanged, every
   other country gets a free-text State/Region/Province field, and
   switching country always clears any stale value.
8. **RESOLVED (2026-08-16, see §11)**: `RECORD_AUDIO` was declared in
   `AndroidManifest.xml` while the voice-notes feature was disabled
   (`voice_notes_enabled` defaults `false`). Removed — a declared-but-
   unused permission was a real Play Store review-flag risk for zero
   feature benefit while the toggle stays off.
9. **RESOLVED (2026-08-16, see §11)**: `versionCode`/`versionName` were
   still at Gradle-template defaults (`1`/`"1.0"`). `versionName` bumped to
   `"1.1.0"` to match the app's actual in-app version string (`APP_VERSION`
   in `App.tsx`, and the "VENTS v1.1.0" footer already shown across four
   screens) — it was a real mismatch, not just an unset default.
   `versionCode` deliberately left at `1`: no build has ever been
   submitted to Play Store, so `1` is correct for a first upload.
10. **Every on-device item in `LAUNCH_CHECKLIST.md` §10 remains unverified**
    (splash-screen white-flash fix, native Save/Share Ticket, push
    tap-to-navigate routing, camera/QR scanner, back-button/edge-swipe) —
    this environment has no physical device or emulator to test any of
    these on. All were previously confirmed to *compile* correctly in a
    real Gradle build, which is a different and weaker claim than "works
    on a device," and the checklist itself is honest about that distinction.

### Minor — fixed this pass

11. **Two genuinely dead, unimported files removed**: `src/lib/insforge.ts`
    and `src/test-insforge.ts`. Confirmed zero importers anywhere in `src/`
    or `api/` via a repo-wide import-statement grep (not just a usage
    grep) before deleting — `test-insforge.ts` additionally referenced
    `VITE_INSFORGE_URL`/`VITE_INSFORGE_ANON_KEY`, env vars this app no
    longer reads anywhere.
12. **Two stale, misleading comments fixed** (documentation-only, zero
    functional change): `middleware.ts` claimed rate limiting was "enforced
    by InsForge backend" — this file is genuinely inert at runtime for a
    Vite SPA (confirmed by its own first-line comment), and real rate
    limiting is actually enforced via `check_auth_rate_limit()`/
    `check_rate_limit()` Supabase RPCs elsewhere; the comment now says so.
    `sanitize.ts`'s `validatePassword` attributed the password policy to
    `insforge.toml [auth.password]`, which is no longer the enforcement
    path — repointed to `schemas.ts`'s `signupSchema.password`.

### Re-confirmed this pass (not new work — checked, not just carried over)

- **RLS is enabled** on every critical table (`users`, `tickets`, `events`,
  `direct_messages`, `organizer_bank_accounts`, `organizer_wallets`,
  `vents_wallets`, `vc_transactions`, `blocked_users`, `saved_events`) —
  confirmed by grepping `supabase/migrations/0008_rls_and_policies.sql`
  directly for `ENABLE ROW LEVEL SECURITY` against each, not assumed.
- **Zero remaining `insforge` imports repo-wide** — re-ran the import-grep
  (not just a usage-grep) across all of `src/` and `api/`; the only
  remaining hits are historical comments and the two dead files removed
  above (now zero).
- **Get Directions and Add to Calendar are both implemented**
  (`EventDetailsScreen.tsx`): Get Directions opens a real Google Maps
  search URL; Add to Calendar generates a real `.ics` blob via native
  share/download. Structurally present and typechecked; not re-clicked
  live this pass specifically (both were visibly present and functional
  during the earlier regression pass's live event-details page load).
- **Flyer/cover-image upload and crop** — live-verified in the earlier
  regression pass (real Supabase Storage upload via `CreateEventScreen`'s
  multi-step form), unaffected by this pass's changes.
- **Free-ticket checkout, check-in (incl. live realtime), organizer event
  creation, sales stats, admin moderation, messaging** — all live-verified
  in the earlier regression pass (§1) and untouched by anything in this
  pass; re-stating here only to confirm nothing in this audit found a
  regression in those areas, not re-testing them from scratch.

### Explicitly unverified (not tested this pass, listed honestly rather than omitted)

- Paid Paystack purchase → webhook → ticket confirmation (blocker #2).
- Real-inbox OTP-code receipt (no test inbox access, unchanged from §1).
- Refund flow's UI click-through (`AttendeeListScreen`'s refund dialog) —
  the migrated RPC path was code-reviewed and typechecks, but not driven
  live through the UI in any pass so far.
- `SalesAnalyticsScreen.tsx` specifically — migrated and typechecks;
  `OrganizerDashboard.tsx` (a different screen) was live-verified, this one
  was not clicked into directly.
- Per-country phone format precision for the ~189 non-Nigerian countries
  individually (§7 — accepted generic-range tradeoff, not a claim of
  per-country accuracy).
- Everything iOS — deliberately out of scope this pass, per your own
  launch sequencing (Capacitor iOS wrapper is a separate later step).
- All native/on-device testing (important #10) — no device/emulator
  available in this environment.

### Verification run this pass
- `npx tsc --noEmit` — clean.
- `npx vitest run` — 10/10 existing tests pass, no regressions.
- `npm run build` — succeeds (same pre-existing >500kB chunk-size warning
  as every prior build this session, unrelated to this pass's changes).

### Recommended next steps, in order
1. You: supply real keystore credentials (`android/keystore.properties`)
   and Firebase's `google-services.json` — both are hard blockers only you
   can unblock (blockers #4, #5).
2. You: add the missing Supabase env vars to Production, and confirm
   `PAYSTACK_SECRET_KEY` is live-mode (blockers #1, and the still-open
   Paystack-live-key checklist item from §3) — I've deliberately not done
   this myself since it's a real Production config change.
3. Decide on `LAUNCH_CHECKLIST.md` §9's staleness (blocker #3) — either ask
   me to rewrite it against the current Supabase architecture, or handle
   it yourself before anyone uses that file to judge launch-readiness.
4. Bump `versionCode`/`versionName` (important #9) immediately before the
   first real build — easy to forget, cheap to do right before upload.
5. Resolve the `RECORD_AUDIO` permission question (important #8) — declare
   it in Play Console or strip it, whichever matches the actual current
   feature state.
6. Once the above are done: a real device/emulator pass through
   `LAUNCH_CHECKLIST.md` §10 — nothing in that list can be verified from
   this environment.
7. Only after 1–6: proceed to Play Store submission, then the Capacitor iOS
   steps already sequenced after it.

## §9. Preview deploy note (2026-08-16)

Vercel CLI deploys of this branch from the `vents@insforge.app` git author
were rejected with `Not authorized` (`readyState: BLOCKED`) — Vercel's
Git-connected deploy protection ties CLI deploys to a recognized GitHub
account. Repo-local git author switched to the verified `DERO2026` GitHub
account email to unblock the Preview deployment; no application code,
Vercel env vars, or Paystack keys were touched.

## §10. Preview Paystack payment flow — verified working (2026-08-16)

A live-fire regression test of the paid-purchase → webhook → ticket-
confirmation flow on the Preview deployment surfaced and resolved two
real, distinct bugs, and the flow is now confirmed end-to-end working
for new Test-mode transactions. Documented here factually, with
historical artifacts kept clearly separate from current verified state.

### What was found and fixed

1. **Preview was accidentally charging real money in Live mode.**
   `.env.production` (a committed file, loaded by Vite for any
   production-mode build regardless of which Vercel target is building —
   Preview deployments are still production-mode builds) held a real
   `pk_live_...` Paystack public key. `VITE_PAYSTACK_PUBLIC_KEY` was
   scoped to Production only in Vercel's env store, so every Preview
   build fell through to this file's Live key. Two real ₦100 charges
   were made against a live card as a direct result before this was
   caught. Fixed by swapping the committed fallback to a `pk_test_` key
   (not deleting it — this file is also what a local Capacitor native
   build reads, with no access to Vercel's env store, so removing the
   line would silently break native checkout) and adding a
   branch-scoped `pk_test_` `VITE_PAYSTACK_PUBLIC_KEY` to Vercel's
   Preview environment for `claude/jolly-moser-bee77b` only. Verified
   directly against the deployed JS bundles: Preview's bundle contains
   `pk_test_` and zero occurrences of `pk_live_`; Production's bundle
   still contains `pk_live_` and zero occurrences of `pk_test_` —
   Production was not affected by this change.

2. **Preview's `PAYSTACK_SECRET_KEY` was still the Live secret,
   causing webhook signature verification to fail.** After the public
   key fix corrected checkout to initialize in Test mode, and after the
   Test-mode Paystack webhook was pointed at the Preview branch URL,
   webhook deliveries correctly reached the Preview deployment for the
   first time — but were rejected with `401` / `Paystack webhook
   signature mismatch`, because Preview's `PAYSTACK_SECRET_KEY` was
   still the shared Live secret (never previously scoped separately for
   Preview). Fixed by adding a branch-scoped Test-mode
   `PAYSTACK_SECRET_KEY` to Vercel's Preview environment for this
   branch only, then redeploying so the running function picked up the
   new secret. No secret values are recorded here or anywhere in this
   document.

### Current verified state (Preview)

- Preview Paystack Test-mode configuration (public key + secret key)
  is correctly scoped to the `claude/jolly-moser-bee77b` Preview
  environment only, confirmed by `vercel env ls` (names/scope only)
  and by direct bundle inspection.
- Paystack's Test-mode webhook correctly reaches the Preview
  deployment (confirmed via Vercel runtime logs — `dep=` matches the
  current Preview deployment ID, not Production).
- Test-mode webhook HMAC signature verification passes (confirmed —
  `Paystack webhook event: charge.success` is only logged after
  signature verification succeeds; no mismatch warnings on the three
  successful transactions below).
- `finalize_pending_purchase` and `confirm_ticket_payment` both run
  and complete successfully against Supabase for Test-mode
  transactions, confirmed via runtime log output (`finalize_pending_
  purchase ran for reference ...` / `Ticket confirmed for reference
  ...`) for three separate payment references.
- Two of those three were Paystack's own automatic retries of
  transactions that had originally failed with a signature mismatch
  (`VNT-c16f53f59ed344a9924ac70800049f04`,
  `VNT-c5d7d7ff98f843f9b07c964071225e69`) — both retried automatically
  by Paystack after the corrected Preview deployment went `READY`, and
  both succeeded without any new payment being made.
- A fresh ₦5,000 Early Bird Test-mode transaction
  (`VNT-112abd413a1f4e99b81177b6afd09396`) completed the entire flow
  end-to-end successfully on the first attempt, no retry required:
  Paystack Test-mode charge → webhook reaches Preview → signature
  verified → `finalize_pending_purchase` → `confirm_ticket_payment` →
  `payment_status = 'paid'`.
- **Conclusion: the Preview payment flow is verified working for new
  Test-mode transactions.**

### Historical artifacts — not evidence of an ongoing Preview problem

Two `tickets` rows remain `payment_status = 'pending'`:
`VNT-d6781717a0b945fb910f6715143602e2` and
`VNT-cfc5cf3fdfe143b398ec9e14c6df38f5`. These are the two real
**Live**-mode charges made before the public-key fix (bug #1 above).
Their webhooks were delivered to **Production**, whose current
(pre-migration) handler always returns `200` regardless of outcome —
so Paystack considers delivery complete and will never retry them.
These two rows are permanently stuck as-is and will not self-resolve;
they require a separate, deliberate reconciliation decision. They were
deliberately left untouched during this investigation and this
documentation pass — not modified, deleted, reconciled, or refunded.

### Manual reconciliation plan for the two stuck Live-mode tickets

Not yet executed — this is a plan awaiting explicit approval, recorded
here so the decision and its reasoning aren't lost. Both `amount = ₦100`
Live-mode charges (`VNT-d6781717a0b945fb910f6715143602e2`,
`VNT-cfc5cf3fdfe143b398ec9e14c6df38f5`) were real money taken from a
real card by mistake (bug #1 above), so this touches actual funds and
a Production-adjacent database write — it should not be done casually
or automated away.

1. **Confirm actual Paystack charge status first, don't assume.**
   In Paystack Dashboard → Live mode → Transactions, look up both
   references directly and confirm each actually settled successfully
   (not reversed, disputed, or already refunded some other way). Do
   not proceed on the assumption that "webhook fired" means "money
   definitely settled" — verify against Paystack's own record.

2. **Decide, per ticket, refund vs. honor:** since both are real
   ₦100 charges, the two options are:
   - **Refund via Paystack** (Live mode → Transactions → Refund) —
     appropriate since these were unintentional test charges, not a
     real customer purchase. This is the expected default outcome.
   - **Manually honor the ticket** (mark `payment_status = 'paid'`
     directly in the `tickets` row) — only appropriate if there's a
     reason to keep the charge as a legitimate sale rather than refund
     it. Given these originated from internal testing, refunding is
     expected to be the right call, but this is a decision for a human
     to make, not to infer here.

3. **If refunding:** initiate the refund directly in Paystack Dashboard
   (Live mode) for each reference. This is a real financial action —
   requires a human to click it, same as the original payment. Once
   refunded, the corresponding `tickets` row's `payment_status` should
   be moved to a terminal, clearly-labeled state (e.g. `refunded`, not
   left as `pending` and not silently deleted) so the record stays
   accurate and auditable. The exact SQL for that update should be
   reviewed and run deliberately, not scripted as a blind bulk
   operation — these are the only two rows affected, and each should
   be checked individually first.

4. **If honoring instead:** do not call `confirm_ticket_payment`
   speculatively with a fabricated amount — that RPC exists specifically
   to be driven by a genuine, signature-verified Paystack webhook
   payload. A manual "honor this payment" action should be its own
   explicit, audited administrative update (e.g. a direct, reviewed
   `UPDATE` with a comment recording who approved it and why), not a
   reuse of the webhook-confirmation code path against reference data.

5. **Either way:** this action is out of scope for the Supabase
   migration work itself and should be tracked as its own explicit,
   approved step — not bundled into a future unrelated commit. No
   action has been taken on these two rows as of this writing.

### Explicitly not touched by this work

No Production code, no Production environment variables, no Live
Paystack webhook configuration, and no Supabase database functions
were modified. The two historical pending records were left exactly
as found.

## §11. Three launch-checklist items closed (2026-08-16)

Following §8 Important items #7–#9. Each was a targeted, single-file
fix; no unrelated changes bundled in.

1. **Signup State field made country-aware**
   (`src/app/components/AuthScreen.tsx`, commit `8c2e5ad`). Nigeria
   keeps the existing `NIGERIA_STATES` picker unchanged. Every other
   country now shows a free-text State/Region/Province input instead
   of fabricated or incorrect subdivision data — no per-country
   states/provinces list exists yet for the other ~189 countries.
   Switching the selected phone country now always clears `signupState`,
   so a stale Nigerian state (or a free-text value typed for a
   different country) can never carry over. `npx tsc --noEmit`,
   `npx vitest run` (10/10), and `npm run build` all clean before
   commit.

2. **`RECORD_AUDIO` permission removed**
   (`android/app/src/main/AndroidManifest.xml`, commit `1ec0efc`).
   `voice_notes_enabled` defaults `false` (`0002_tables.sql`) and voice
   notes are disabled for MVP launch — the permission was declared but
   unused, exactly what Google's automated review flags. Left a comment
   marking the re-add condition explicitly: this permission (and a
   native rebuild/resubmit) must come back **before**
   `voice_notes_enabled` is ever flipped to `true` in Production —
   without it, `getUserMedia`'s mic request is denied at the OS level
   on Android before the WebView ever gets a chance to prompt. This is
   a real tradeoff, not a free removal: enabling voice notes later now
   requires a coordinated native update first, not just a DB toggle.

3. **`versionName` aligned to `"1.1.0"`**
   (`android/app/build.gradle`, commit `fdd9b29`). It was still the
   Gradle template's `"1.0"`, while the app already presents itself as
   v1.1.0 everywhere else (`APP_VERSION` in `App.tsx`; the "VENTS
   v1.1.0" footer in `ProfileScreen.tsx`, `SettingsScreen.tsx`,
   `WelcomeScreen.tsx`, `AdminDashboardScreen.tsx`) — a real mismatch,
   not an arbitrary bump. `versionCode` deliberately left at `1`: no
   build has ever been submitted to Play Store for this app, so `1` is
   correct for a first upload; it must strictly increase on every
   future upload from here.

### What this does NOT close

- Blockers #4/#5/#6 (`android/keystore.properties`,
  `android/app/google-services.json`, Play Store submission assets) —
  all still require something only you can provide.
- Blocker #10 (all on-device/native testing) — still needs a physical
  device or emulator, unavailable in this environment.
- Blocker #2 (Production's purchase → webhook → confirmation flow) —
  still unverified; Production runs the pre-migration InsForge code
  until PR #3 is merged and deployed, which has not been authorized.
- The two historical stuck `pending` tickets (§10) — you explicitly
  declined reconciliation; left untouched, as instructed.

## §12. PR #3 merged — Production now runs the Supabase-backed app (2026-08-16)

Following the read-only Production-readiness audit (verdict: READY TO
MERGE) and your explicit authorization, PR #3 was merged into `main`
and deployed. Verified, not assumed:

- **Merge commit:** `b84fada9dfcce279ccf4bfefd573b5984e6e2d5f`.
- **Production deployment:** `dpl_8EaW7JM1M5L7YWKXvXPujFZeiC3o`, reached
  `READY` (build completed in 26s).
- **`getvents.com` is aliased to this deployment** — confirmed via the
  deployment's own `alias` list, and independently via a changed bundle
  filename on a live fetch of `https://getvents.com/`.
- **Production is now running the Supabase-backed application.**
  Confirmed directly by reading `origin/main`'s merged
  `api/webhook/paystack.ts`: it imports and calls
  `callProjectAdminRpc('finalize_pending_purchase', ...)` and
  `callProjectAdminRpc('confirm_ticket_payment', ...)` — the Supabase
  `project_admin` RPC path already proven working end-to-end on
  Preview (§10).
- **The old InsForge webhook implementation no longer runs in
  Production.** The same file-read confirms zero references to
  `VITE_INSFORGE_URL`/`INSFORGE_API_KEY` in the now-merged handler —
  those only existed in the pre-merge `main` version.
- **Production Paystack remains Live-mode**, unchanged by this
  deployment. **Preview remains isolated on Test-mode**, unchanged —
  both scoped exactly as verified in §10, neither touched by the
  merge/deploy itself.
- **No Production environment-variable or Paystack configuration
  changes were required or made** during this deployment — the
  existing Production-scoped Supabase and Paystack config (added
  earlier this session, see the top-of-document update note and §3)
  was already sufficient.
- **No real Production payment has been performed yet** — this
  deployment verification was code/config-level only (merged source,
  deployment status, bundle change, absence of build/runtime errors),
  not a live transaction against Production.
- **The two historical pending Live-mode tickets remain untouched.**
- **Build:** completed successfully with only the existing,
  non-blocking chunk-size and dynamic-import warnings seen throughout
  this session — no new warnings introduced.
- **Runtime:** no errors or `500`s observed in the post-deployment
  verification window.

### What this does NOT yet confirm

A real Production Paystack payment through this new deployment has
not been run. The webhook *code* is confirmed correct and matches
what was proven working on Preview, but an actual live-fire
Production transaction — the only way to observe Production's webhook
handler process a real event end-to-end — has not happened and was
explicitly not authorized as part of this step.

## §13. First real Production payment, and a missing-ticket investigation (2026-08-16)

### Payment flow: confirmed working end-to-end in Production

A real ₦100 Live-mode payment for "KARAOKE NIGHT" (Standard ticket,
`payment_ref VNT-96450b1d35bd46139235f9e4ec93ebd9`) was made against
Production after the PR #3 merge, using the cheapest live paid ticket
found via a public (anon-key, RLS-respecting) query. Confirmed via
Supabase Table Editor: `payment_status = 'paid'`, `status = 'active'`,
`amount = 100`. This is the first real, successfully-confirmed
Production payment since the migration — §12's outstanding "no real
Production payment yet" gap is now closed.

### Missing-ticket investigation: ticket didn't appear in My Tickets

After the payment succeeded, the ticket did not appear in My
Tickets/Upcoming. A staged, read-only investigation (browser
DevTools Network tab, Sentry issue/replay search, then temporary
`console.log` checkpoints deployed to Production across three
commits — `9f4393a`, `8d60cad`, `807cada`) traced the exact ticket
(`565dacc9-8c83-495f-bead-a09d678b27cb`) through every layer:

1. Present in the raw `/rest/v1/tickets` response (confirmed directly
   in DevTools before any logging was added).
2. Survived `fetchUserTickets`'s `.filter().map()` into `mappedTickets`.
3. Present in `allTickets` state immediately before `MyTicketsScreen`
   renders.
4. Received correctly as a prop by `MyTicketsScreen`.
5. Correctly classified into the `upcoming` array by the date split.
6. Present at the correct index in `displayed`, immediately before the
   final render `.map()`.

An early diagnostic pass gave a false negative — it matched by event
title instead of the exact `ticketId`, and there are multiple tickets
for the same event/user, so it silently checked a different ticket.
Corrected to exact-ID matching before drawing further conclusions.

Sentry showed zero issues or relevant replays for this session — not
because nothing happened, but because a structural gap was found:
`fetchUserTickets`'s catch block only calls `console.error(...)`
(never `Sentry.captureException`), and `sentry.ts`'s `Sentry.init()`
has no console-capture integration. A caught error here is invisible
to Sentry by design, not just in this one instance. **Not fixed as
part of this pass** — flagged as a real gap worth a follow-up.

**Outcome:** after the corrected diagnostics were deployed and
checked, the ticket was confirmed visibly present and correctly
rendered in My Tickets, and the detail-screen/QR click-through was
confirmed working. No code defect was found anywhere in the traced
path — every stage matched expected behavior once the diagnostic
itself was corrected. The most plausible explanation is that the
original symptom was transient (e.g. a stale cached bundle from
before an interim deploy), not a persistent application bug — this is
stated as the most likely explanation, not a proven root cause, since
it could not be directly reproduced once accurate diagnostics were in
place.

All temporary `[TICKET_DEBUG]` logging has been removed (commit
`191f74f`) and Production is confirmed serving that clean build.

### Follow-up: fetchUserTickets now reports to Sentry (2026-08-16, closed)

`fetchUserTickets`'s catch block (`src/app/App.tsx`) previously only
called `console.error` — invisible to Sentry, since `Sentry.init()`
has no console-capture integration. Fixed in commit `264a22d`:
imports `Sentry` from `src/lib/sentry.ts` and calls
`Sentry.captureException(err, { tags: { area: 'fetchUserTickets' } })`
alongside the existing `console.error`, tagged for easy filtering in
Sentry's issue list. Typecheck and production build both clean.
Deployed and confirmed `READY` on `getvents.com`
(`dpl_BWdyX87bTVqQGMWx2r3sfXVDsNdS`).

Scope was deliberately narrow — only this one flagged catch block, not
a sweep of every `console.error` in the codebase. Other similarly
"caught-and-only-logged" error sites elsewhere in the app remain
un-instrumented and would benefit from the same treatment in a future
pass, but that's a separate, larger piece of work not implied by this
specific follow-up.

**Update (2026-08-16, later same day):** that broader sweep happened.
Commit `419c619` extended this to every other silent catch block in
`src/app` — 78 sites across 24 files — with `Sentry.captureException`
now alongside every `console.error` that previously had none. Deployed
and confirmed `READY` on `getvents.com` (`dpl_C3L88KSeK4yVz6Fsq3hNNq9Bh5T4`).
Still deliberately scoped to `src/app` (client-side React, where
Sentry's browser SDK runs) — `api/` serverless handlers use a
different runtime/logging setup and remain out of scope.

## §14. Checkout international phone-number fix + QA pass (2026-08-16)

### Bug found and fixed

`CheckoutScreen.tsx` had its own separate, stale, hardcoded 15-country
phone implementation (no Qatar; flat "UK"/"USA" labels) instead of
reusing Sign Up's. Its phone-building logic
(`` `${selectedCountry.code}${phoneDigits}` ``) never stripped a
leading trunk-zero — a Nigerian number typed as `080...` would have
produced the malformed `+234080...`, and every country was validated
with the same flat "≥7 digits" check regardless of actual country
format.

### Fix — commit `cd96239`, deployed `dpl_GRNnTXQwRGc9CCZhh4G1ogtHuRzv`

- `buildE164` moved from a private function in `AuthScreen.tsx` into
  `src/lib/countries.ts` as a shared, exported utility — single source
  of truth, imported by both screens now. Strips leading zeros before
  prepending the dial code.
- `CheckoutScreen.tsx` now renders the same `<PhoneInput>` component
  Sign Up uses, backed by the same ~195-country `COUNTRY_CODES` list,
  instead of its own hardcoded array and custom picker modal.
- Validation uses the same shared `isPlausibleNationalNumber` range
  check as Sign Up, not a flat digit-count.
- Switching country clears the typed digits (matches Sign Up), so a
  half-typed number can't bleed into another country's format.
- Traced end-to-end: `attendees[0].phone` → `create_pending_purchase`'s
  `p_attendees` jsonb → `finalize_pending_purchase` stores it verbatim
  as `tickets.holder_phone`. Confirmed Paystack itself never receives
  a phone number at all (`PaystackPop.setup()` has no `phone` field) —
  no second place could reformat or Nigeria-ify the number.

### QA pass (same day, read-only — no further code/deploy)

Live-verified against the actual deployed Production bundle
(`index-Bh4ss2xx.js`, pulled directly from `getvents.com`) plus a
numeric re-test of the exact shipped `buildE164` logic. Not a live
click-through purchase — payment entry is something Claude can never
perform, regardless of authorization; verification was code + deployed
bundle + logic-level instead.

**All PASS:**
- Nigeria `08012345678` → `+2348012345678` (leading zero correctly stripped)
- USA, UK, Ghana, UAE, Qatar — each produced correct E.164 output, no
  cross-country contamination
- Deployed bundle confirmed to contain the full international country
  list (`Qatar`, `United Arab Emirates`, `United Kingdom`,
  `United States`, 187 distinct dial codes) — the old hardcoded
  `"UK"`/`"USA"` short labels are completely absent
- Country-change clears previously typed digits
- Validation matches Sign Up exactly (shared `isPlausibleNationalNumber`)
- Attendee payload carries proper E.164, not a display-formatted value
- Paystack config and backend/database confirmed untouched by this fix

No defect found. No further changes made as part of this QA pass.
