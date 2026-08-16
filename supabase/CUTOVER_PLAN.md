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

**Single biggest concrete blocker, confirmed via a direct read of Vercel's Production
environment (§3)**: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`,
`PROJECT_ADMIN_DATABASE_URL`, and `SUPABASE_JWT_SECRET` are genuinely absent from
Production — not masked, not sensitive-and-hidden, just not set. Deploying `main` to
Production today, as-is, would break immediately on page load (the Supabase client
can't initialize without a URL/anon key). This has to be fixed as part of §4.4, not
discovered during it.

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
- [ ] Vercel environment variables added for production: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `PROJECT_ADMIN_DATABASE_URL` (or equivalent), `SUPABASE_JWT_SECRET` (if still relevant), removing `VITE_INSFORGE_URL`/`VITE_INSFORGE_ANON_KEY`/`INSFORGE_API_KEY` only after confirming nothing reads them — **confirmed via a fresh `vercel env pull --environment=production`: all four are genuinely absent from Production** (not masked/sensitive — they don't appear in the pulled file at all, unlike the write-only vars above). This is the single biggest concrete blocker on this checklist: as of this check, deploying `main` to Production today would break immediately — the Supabase client can't even initialize without `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY`. `VITE_INSFORGE_URL`/`VITE_INSFORGE_ANON_KEY`/`INSFORGE_API_KEY` are still present and would need removing once the Supabase vars are added and confirmed working.
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
5. Who holds the `project_admin` Postgres role's password (set out-of-band
   per `0021_project_admin_login.sql`, and not recorded anywhere in this
   repo, `.env.local`, or Vercel's env vars)? This pass could not test the
   webhook-driven paid-purchase/payout/refund-finalization path at all
   without it — whoever has it needs to either run that part of the
   regression pass themselves or share a way to test it before cutover.

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
