# VENTS — Launch Checklist

Single source of truth for everything left before public launch. Items are
grouped by where the work happens. Checked items were verified directly
against this codebase/production database, not assumed — see the note under
each section for how.

For the full iOS-specific walkthrough (Xcode, Info.plist, signing,
capabilities), see **[IOS_LAUNCH_CHECKLIST.md](IOS_LAUNCH_CHECKLIST.md)** —
this file only summarizes iOS status, that one has the step-by-step.

**Top-level status and priorities (2026-10-30):** see
**[docs/LAUNCH_READINESS_MASTER.md](docs/LAUNCH_READINESS_MASTER.md)**. It
reconciles this file with the iOS checklist, `MASTER_AUDIT.md`, the design
checklists, the money-flow audit and open PRs. It also separates launch
blockers from future work and gives the execution order. This file keeps
the store, build, infrastructure and on-device detail.

---

## 1. Google Play Store Policy & Compliance

*The five most common rejection triggers for an event app, checked directly
against this codebase.*

- [ ] **In-app account deletion** — exists: Settings → Delete Account, wired to `delete_own_account()`. **Verified working**: a real bug (`delete_own_account()` referencing an already-dropped `follows` table) was found and fixed this session; re-confirm deletion still works end to end after that fix.
- [x] **Public web account-deletion page/URL** — built and verified this session: `https://getvents.com/delete-account` (`src/app/components/DeleteAccountScreen.tsx`, routed in `src/main.tsx` alongside the other legal pages, no login/app-install required). Covers the in-app deletion steps, a manual email-request path for users without the app, what gets deleted vs. retained (and why), and is irreversible messaging. **Enter this exact URL in Play Console's account-deletion field.**
- [x] **Privacy Policy accessibility** — live at `https://getvents.com/privacy`, served via the public route list above (no auth required to view). Confirm the URL entered in Play Console matches exactly (including `https://`, no trailing differences).
- [x] **UGC moderation controls** — verified directly in code: `ReportModal.tsx` exists and is wired into both `EventDetailsScreen.tsx` and `UserProfileScreen.tsx` (Report/Flag reachable from both events and profiles); `blocked_users`/`block_user()` is wired into `InboxScreen.tsx` and `App.tsx`, not just present as an unused RPC. Both are real, reachable UI controls, not just schema-level scaffolding.
- [ ] **Permission audit** — checked `AndroidManifest.xml` directly:
  - [x] No background location permission requested anywhere (confirmed: no `ACCESS_BACKGROUND_LOCATION`, no `navigator.geolocation` usage in `src/` at all — the app doesn't request device location at all, only Google Places text search)
  - [x] No `ACCESS_FINE_LOCATION`/`ACCESS_COARSE_LOCATION` requested either — nothing to justify in Play Console on this front
  - [ ] `RECORD_AUDIO` is declared but the voice-notes feature it's for is currently disabled behind a feature flag (`migrations/20260710185537_media-feature-toggles.sql`). Google's automated review sometimes flags declared-but-unused permissions — either justify the upcoming feature in the Play Console permissions declaration, or strip the permission until voice notes ship.

## 2. Reviewer Test Credentials & Data Safety

*Completed this session — account promoted and seed data live in production, verified via direct database queries.*

- [x] **Reviewer account exists and is promoted**: username `testerboy` (pre-existing account, confirmed with the account owner before modifying), promoted to `role='organizer'`, `is_verified=true`, funded wallet (₦45,500 balance / ₦50,000 total earned), `email_verified` confirmed true.
- [x] **Play Console App Access password confirmed**: `Testerboy123` (capital T) meets this app's password policy (uppercase, lowercase, number, 10+ chars) — no mismatch, matches what's already submitted in Play Console.
- [x] **Seed events verified live in production** — queried directly: 9 events now attached to the `testerboy` organizer account (8 realistic showcase events across categories + 1 dedicated demo event), all `status='live'`, real future dates, real Nigerian venues, proper ticket tiers.
- [x] **Sandbox/demo checkout path verified** — the reviewer's demo event includes a **free ("Reviewer Access") ticket tier**. Checkout for a ₦0 ticket never touches Paystack at all (confirmed by reading `CheckoutScreen.tsx`/`paystack.ts`), so a reviewer can complete a full purchase end-to-end with zero payment friction and no card needed.
- [ ] **Deliberately not implemented**: a payment-gateway bypass hardcoded to this account. `confirm_ticket_payment` was hardened earlier this session against exactly this class of hole (was reachable by any client with a self-chosen reference/amount before being locked to the Paystack webhook only) — special-casing one user id back open re-creates the same fraud vector for anyone who leaks that account's credentials. The free ticket tier above is the safe equivalent; Paystack test-mode (swap the public key on a non-production deploy) is the other standard option if a *paid* flow specifically needs testing.
- [ ] Spot-check the seeded Unsplash image URLs still resolve, and plan to replace them with real event photography before public (non-review) launch — hotlinking a third party's CDN indefinitely for core app content isn't something to leave in place long-term.
- [ ] Run `scripts/01-cleanup-junk-events.sql` — removes placeholder/test events from the public feed. **Read the file's Step 1 SELECT output before running Steps 2-3**: two of the four junk-titled events found in production turned out to have real, Paystack-verified paid tickets attached — those get soft-hidden, never deleted, so financial history isn't destroyed.
- [ ] Enter `testerboy` / `Testerboy123` in Play Console → App content → App access, plus a note that email-based login also works if needed (the account's real email is on file, not published here).

## 3. Production Build & App Signing

- [x] Android release build config (minify, shrinkResources, ProGuard rules) — production-appropriate
- [x] `applicationId` (`com.getvents.app`) — real, not a placeholder
- [x] `android/app/build.gradle` has a `signingConfigs.release` block, loading path/alias/passwords from a gitignored `android/keystore.properties` — added this session
- [ ] **Create `android/keystore.properties` locally** with your real keystore path/passwords (never commit it):
  ```
  storeFile=vents_keystore.jks
  storePassword=<your password>
  keyAlias=<your alias>
  keyPassword=<your key password>
  ```
- [ ] Generate the production **App Bundle** (`.aab`, not just an APK) — Play Store requires an AAB for new app submissions: `./gradlew bundleRelease` (needs the keystore.properties above set up first)
- [ ] Bump `versionCode`/`versionName` in `android/app/build.gradle` before each Play Store upload (currently at Gradle-template defaults `1`/`"1.0"`) — Play Console requires a strictly increasing `versionCode` per upload
- [x] Keystore, `google-services.json`, `keystore.properties` all correctly gitignored and confirmed untracked in git
- [x] **App icon** — set (`android/app/src/main/res/mipmap-*/ic_launcher*`), generated via `@capacitor/assets`
- [x] **Splash screen — white-flash bug fixed and verified this session**: root cause was `android:background` (not a real window-theming attribute) on the launch theme, plus a missing Android 12+ `windowSplashScreenBackground` override. Fixed in both `values/styles.xml` and a new `values-v31/styles.xml`. Verified via real debug + release Gradle builds — **not yet confirmed visually on a physical device**, only that it compiles correctly.
- [ ] iOS: Xcode signing (Apple Developer team, bundle ID confirmation, automatic signing) — see IOS_LAUNCH_CHECKLIST.md §3

## 4. Store Listing Assets

- [x] **App title / short description / full description — drafted below.** Paste directly into Play Console → Store presence → Main store listing. Not yet entered in Console (that's a manual paste step), but the copy itself is final unless you want changes.

  **App title** (30 char max): `VENTS — Events & Tickets`

  **Short description** (80 char max, shown under the title in search results):
  > Discover events, buy tickets, and get paid out — all in one app.
  (66 chars)

  **Full description** (4000 char max):
  > **VENTS is the easiest way to discover events and sell tickets in Nigeria.**
  >
  > Whether you're looking for your next night out or running the show, VENTS puts everything in one place — no more juggling WhatsApp groups, screenshots of bank details, or handwritten guest lists.
  >
  > **For event-goers:**
  > 🎟️ Browse concerts, comedy shows, tech meetups, food festivals, and more — all around you
  > 💳 Buy tickets securely in seconds with card or bank transfer (powered by Paystack)
  > 📱 Your ticket lives in the app as a scannable QR code — no printing, no lost emails
  > 💬 Message organizers directly with questions before you buy
  > 🔔 Get reminders before the event so you never miss it
  >
  > **For organizers:**
  > 📅 Create and publish an event in minutes — set your price, ticket types, and capacity
  > 💰 Track sales in real time and get paid straight to your bank account
  > 🚪 Scan tickets at the door with the built-in QR check-in tool — no extra hardware
  > 📊 See exactly who bought what, and message your attendees directly
  > ✅ Get verified as a trusted organizer to build attendee confidence
  >
  > Whether it's a 50-person comedy night or a 2,000-person festival, VENTS handles ticketing so you can focus on putting on a great event.
  >
  > Download VENTS and find what's happening near you — or start selling tickets to your own event today.

  *(Copy above is a first draft, not yet reviewed for trademark/wording risk. Read it over before it goes live — swap "Nigeria"/city references if you want it framed more generally, and confirm "Paystack" mention is fine to publish.)*

- [ ] **Screenshots — not yet produced.** Nothing in this repo qualifies (the `screenshot-*.cjs` files at the repo root are dev/debug capture scripts from earlier feature work, not store-ready assets — captured at arbitrary viewport sizes, showing test data, no device frame). Play Store requires real captures from an actual build:
  - [ ] Minimum 2, ideally 4-6, phone screenshots (portrait, 16:9 or 9:16, JPEG/24-bit PNG, no alpha) — Google's recommended size is 1080×1920 or larger
  - [ ] Suggested shot list: (1) event discovery/feed, (2) event details page, (3) checkout/ticket purchase, (4) QR ticket view, (5) organizer dashboard/sales, (6) door check-in scanner
  - [ ] Capture from a real device or emulator running the actual release build with the seeded showcase events (§2) so they look populated, not empty-state
  - [ ] Tablet screenshots only if explicitly supporting tablets (skip if phone-only for launch)
- [ ] Feature graphic — 1024×500, required for the Play Store listing header. Not yet designed.
- [ ] App icon — 512×512 high-res version for the store listing itself (the in-app launcher icon exists at `android/app/src/main/res/mipmap-*/ic_launcher*` — confirm a matching 512×512 master exists, or export one from the same source art)
- [ ] Content rating questionnaire — account for the 18+ event content gating already built in (`is_18_plus` flag on events)
- [ ] Data Safety form — VENTS collects: account info (email, name, phone), photos (uploads); payment info is handled entirely by Paystack, never collected/stored directly. **No location data is collected at all** (confirmed — see §1's permission audit)

## 5. Release Track: Production / Direct Submission

- [x] **12-tester / 14-day Closed Testing requirement does not apply** — that requirement is specific to *personal* Play Console developer accounts created after November 2023. This project's Play Console account is an **Organization account**, which is exempt. Confirmed by the account owner directly (Organization accounts don't carry the new-personal-account testing gate).
- [ ] Submit directly to a **Production** release track — no Closed/Internal Testing track is required first for this account type
- [ ] Still worth doing even though it's not mandatory: a quick Internal Testing release (a handful of teammates, no 12-tester/14-day requirements attached) before Production, purely to catch install/crash issues on real devices before the public sees them
- [ ] Complete the standard pre-Production requirements that DO still apply regardless of account type: content rating questionnaire, Data Safety form, App Access reviewer credentials (§2), Store Listing assets (§4) — none of these are testing-track-specific

## 6. Apple Developer / App Store Connect

- [ ] Paid Apple Developer account active (required for Push Notifications + device testing + submission)
- [ ] Generate the iOS project — does not exist in this repo yet (`npx cap add ios`), see IOS_LAUNCH_CHECKLIST.md §1
- [ ] Info.plist usage-description strings (camera, microphone, location, photo library) — see IOS_LAUNCH_CHECKLIST.md §2
- [ ] Xcode capabilities: Push Notifications, Background Modes → Remote notifications, Associated Domains → `applinks:getvents.com`
- [ ] App Store Connect listing + screenshots + description
- [ ] App Privacy (data collection) disclosure — same data categories as the Play Store Data Safety form above
- [ ] Age rating — same 18+ content consideration as Android
- [ ] Archive → Distribute App → App Store Connect upload, verify TestFlight processing completes before submitting for review

## 7. Firebase / Push Notifications

*Verified this session: FCM is fully wired end-to-end and confirmed delivering.*

- [x] `google-services.json` present, gitignored, untracked; `com.google.gms.google-services` Gradle plugin applied conditionally
- [x] `POST_NOTIFICATIONS` permission present (merged automatically from `@capacitor-firebase/messaging`'s own manifest)
- [x] `src/lib/pushNotifications.ts` — real permission request flow, no dev shortcuts, token registration/deregistration both implemented
- [x] `FCM_SERVICE_ACCOUNT_JSON` set in Vercel — **verified live** by running the actual cron delivery worker (`api/cron/run.ts`) against production; no auth errors, notification sweep completed successfully
- [x] Backend delivery system built and verified this session: ticket confirmations, new-sale notifications, new-message notifications, 24h/1h event reminders, event-update notifications — all wired to real FCM delivery, not just the in-app bell list
- [ ] iOS: add an iOS app to the Firebase project, download `GoogleService-Info.plist`, generate an APNs Auth Key (.p8) in Apple Developer and upload it to Firebase Console — see IOS_LAUNCH_CHECKLIST.md §5
- [ ] On-device test: confirm a tapped push notification opens the correct screen (deep-link routing for `chat`/`sales-analytics`/`event-details`/`user-profile` was added this session but not yet click-tested on a physical device)

## 8. Google Maps / Places

- [x] API key sourced from env (`VITE_GOOGLE_PLACES_API_KEY`), never hardcoded in source
- [x] Android WebView origin fix in place (`capacitor.config.ts` `androidScheme: 'https'`, `hostname: 'localhost'`) — this was the root cause of a real production `gm_authFailure` incident, fixed and confirmed working by the user
- [x] Corrected stale claim: as of this check, `vercel.json` contains no API key value at all (only CSP domain allowlisting for `maps.googleapis.com`/`maps.gstatic.com`/`places.googleapis.com`) — confirmed via a full repo grep for the `AIza` key prefix, which matches nothing in any tracked source file. The key reaches the client build only via `VITE_GOOGLE_PLACES_API_KEY` (Vercel's own Production environment variable for web; a locally-exported shell/CI variable for native builds), never a committed file. `.env.production`'s own copy of this key was previously committed in plaintext and was cleared (commit `b70696e`); the old value remains permanently recoverable from git history, which is a separate, still-outstanding concern from "is a key currently committed" (it is not).
- [ ] **Verify the Places API key has proper HTTP-referrer restrictions** in Google Cloud Console — a client-embedded Maps JS/Places key being *visible* in the shipped bundle is normal and by design (the security boundary is the referrer/app restriction, not secrecy of the string). **Corrected:** the previous line here (and in IOS_LAUNCH_CHECKLIST.md §7) said to add `capacitor://localhost/*` — that's wrong and contradicts the shipped code: iOS deliberately avoids relying on that unreliable custom-scheme referrer and instead renders Maps through an HTTPS iframe to `getvents.com` (`src/lib/mapEmbed.ts`), so it rides on the `getvents.com` entry. The correct, complete allowlist is exactly `https://getvents.com/*` (web + iOS, via the iframe) and `https://localhost/*` (Android's Capacitor WebView origin) — nothing else. Also set **API restrictions** on the key to exactly Maps JavaScript API, Places API (New), and Geocoding API (the three `src/lib/googleMaps.ts` actually loads) — see IOS_LAUNCH_CHECKLIST.md §7 for the full detail.
- [ ] **Rotate the key in Google Cloud Console.** Because the pre-`b70696e` value is permanently recoverable from git history, the only way to fully close that historical exposure is to generate a new key value there (and update it in Vercel's dashboard + any local/CI native-build secrets) rather than rely on the old value's restrictions alone. Sequence: create the replacement key with the same restrictions as above → update `VITE_GOOGLE_PLACES_API_KEY` in Vercel's dashboard and redeploy → verify Maps/location search still works on the live site → export the new key for a native build and verify on iOS/Android → only once verified, go back and retire the old key in Cloud Console (never revoke it first). Requires Google Cloud Console access this repo/session does not have — cannot be performed or verified here.

## 9. Backend / Infrastructure

*Rewritten 2026-10-30 (PR #82, Batch A). It replaces the earlier version,
which said the Supabase variables were missing from Production and PR #3
was unmerged. Both statements were out of date: production has served the
Supabase app from `main` for weeks.*

**How each line was checked:**

- **Code:** read from the repository (`main` at `5612ee0`, PR #82 at its head).
- **Prod:** read-only queries on Supabase project `slrtjxtzhowhwhebjprv`, or a read of the Vercel deployment list, on 2026-10-30. Nothing was written.
- **Owner:** cannot be checked from a development session. Only the owner's dashboards can show it, so it stays unchecked until the owner confirms.

No secret value was read or recorded. Listing Vercel environment
variables, even by name, is refused (403) for the development account. So
variables are shown as working only where production behaviour proves it.

### 9.1 Code status (repository)

- [x] **Backend is Supabase only.** The app uses `@supabase/supabase-js` (`src/lib/supabase.ts`); server functions use `PROJECT_ADMIN_DATABASE_URL` through `api/_lib/projectAdminDb.ts`. No InsForge code remains (`AGENTS.md`).
- [x] **Exactly 12 serverless functions** (`api/**/*.ts` outside `api/_lib`), the Vercel Hobby cap. One more breaks every deploy. Tests live in `api/_lib`.
- [x] **One cron:** `vercel.json` runs `/api/cron/run` daily at 08:00 UTC. The endpoint refuses any call without `Authorization: Bearer $CRON_SECRET` (`api/cron/run.ts`).
- [x] **Server environment variables the code reads** (names only):
  - `PROJECT_ADMIN_DATABASE_URL`, `PAYSTACK_SECRET_KEY`, `CRON_SECRET`, `FCM_SERVICE_ACCOUNT_JSON`, `PUSH_WEBHOOK_SECRET`;
  - `RESEND_API_KEY`, `SENDCHAMP_API_KEY`, `SENDCHAMP_BASE_URL`, `ANTHROPIC_API_KEY`, `AI_CONFIRMATION_SECRET`;
  - `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VERCEL_ENV`.
  - `SUPABASE_JWT_SECRET` is **not read anywhere** in `api/` or `src/`.
- [x] **Client build variables:** `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_PAYSTACK_PUBLIC_KEY`, `VITE_API_BASE`, `VITE_GOOGLE_PLACES_API_KEY`, `VITE_POSTHOG_KEY`, `VITE_POSTHOG_HOST`, `VITE_POSTHOG_UI_HOST`.
- [x] **Paystack webhook signature** is checked against the raw request bytes (body parser off, F17), with a timing-safe compare.
  - Tests: `api/_lib/paystack.rawBodySignature.security.test.ts`, `src/lib/aiSubscriptionPaystackVerify.test.ts` (forged, altered, re-serialised, appended, wrong-secret, missing-signature and malformed-JSON cases).
- [x] **Preview deployments are read-only** against production data (`docs/preview-read-only.md`, PR #82). Cron, webhook, payouts and writes refuse in Preview.
- [x] **Sentry** is wired in `src/lib/sentry.ts` (the DSN is a public client key by design).
- [x] **Test baseline (PR #82, Batch A):** `vitest` 0 failures; `tsc --noEmit` 0 errors; production build passes; local Postgres suites pass.

### 9.2 Production status (checked read-only, 2026-10-30)

- [x] **Production runs `main`.** The current production deployment is `5612ee0` (merge of PR #80). PR #82 is not in production.
- [x] **Supabase client works in production:** 57 users, 108 active tickets, data served live. The build-time variables `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` must be present, or the app could not load.
- [x] **Server-side payment path works in production.**
  - 102 `VNT-` Paystack-referenced tickets, 19 of them in the last 30 days (latest 2026-10-25), and 5 completed withdrawals (latest 2026-10-27).
  - Both paths need `PAYSTACK_SECRET_KEY` and `PROJECT_ADMIN_DATABASE_URL`, so both are set in Production.
- [x] **Daily cron runs in production.** Events were archived on 2026-10-30 at 08:21 UTC, minutes after the 08:00 schedule. That needs `CRON_SECRET` and the project-admin connection.
- [x] **`project_admin` role exists.** It is the role behind `PROJECT_ADMIN_DATABASE_URL`.
- [x] **Kill switches (`app_config`):**
  - `disable_signups = true` (sign-up is closed; see AUTH-1);
  - purchases, payouts, bookings, deposits, scanning and AI are enabled;
  - `maintenance_mode = false`; `min_client_version = 1.1.0`.
- [x] **Migrations:** 0198–0200 are applied. **0192, 0201, 0202 and 0203 are not:**
  - no `tickets.qualifying_status`;
  - no `get_my_representative_rewards`, `admin_earnings_reconciliation` or `earnings_release_delay`.
- [x] **Extensions:** `pg_net`, `pg_trgm`, `pgcrypto`, `supabase_vault`, `dblink`, `unaccent`, `uuid-ossp`, `pg_stat_statements`. **No `pg_cron`**, so all scheduled work depends on the single daily Vercel cron.
- [ ] **RLS: 86 of 88 public tables have row-level security on.** The two without it, `_ddl_probe_tmp` (empty) and `vc_lifetime_final_reconciliation_log`:
  - have no SELECT/INSERT/UPDATE/DELETE grant to `anon` or `authenticated`, so they are not reachable through the API;
  - should still have RLS turned on, or be dropped (the probe table). → SEC-3.
- [ ] **Residual default grants.** `anon` and `authenticated` hold `TRUNCATE`, `TRIGGER` and `REFERENCES` on 37 public tables.
  - The REST API exposes none of these, so this is defence in depth, not an open hole.
  - Revoke them in a reviewed migration. → SEC-3.
- [ ] **Payout backlog:**
  - 5 withdrawal requests pending since 2026-09-02;
  - 4 cancelled;
  - 2 failed;
  - 2 rejected. → PAY-2 / PAY-6.

### 9.3 Owner to confirm (cannot be verified from a development session)

- [ ] **Paystack key mode.** Production uses **live** keys, and Preview/Development use **test** keys. The Paystack dashboard live webhook URL is `https://getvents.com/api/webhook/paystack`. → PAY-4
- [ ] **Vercel variable inventory.** Every name in 9.1 is set in Production. `SUPABASE_JWT_SECRET` can be removed if set, since nothing reads it. Sensitive values stay write-only.
- [ ] **`FCM_SERVICE_ACCOUNT_JSON` is valid:** one real push arrives on a device (`§7`, `§10`).
- [ ] **Sentry alert rules** route webhook failures, payout errors and 5xx responses to a person. Send a test alert. → OPS-1
- [ ] **Vercel plan decision:** stay on Hobby (12 functions, daily cron) or move to Pro. → INF-2
- [ ] **Bank-account setup** (add, remove, set default) checked with a real account on the Supabase backend; a repeated save creates no duplicate Paystack recipient. → PAY-10
- [ ] **Email DNS on `getvents.com`.** It could not be checked from this session: public DNS resolvers are blocked by its network policy.
  - The last recorded check found **no SPF and no DMARC**. Re-check, then add:
    - SPF (TXT at `@`): `v=spf1 include:amazonses.com include:_spf.google.com ~all` (Resend via Amazon SES, plus Google Workspace MX);
    - DMARC (TXT at `_dmarc`), monitor-only first: `v=DMARC1; p=none; rua=mailto:support@getvents.com; fo=1`. Tighten to `p=quarantine`, then `p=reject`, after clean reports.
  - BIMI only after DMARC enforces. → OPS-2

## 10. On-Device Testing (do this on a real device, not just emulator — camera/push/Paystack popups are unreliable in emulators)

- [ ] Fresh install, no cached session — full onboarding/signup flow
- [ ] Login persists across app kill/reopen
- [ ] Camera permission prompt appears correctly; QR scanner works
- [ ] Photo library / gallery-save permission prompts appear correctly; the new native "Save Ticket" (silent save to Photos/Gallery, added this session) and "Share Ticket" (native share sheet) both work — **not yet click-tested on a physical device**, only verified to compile in real debug+release Gradle builds
- [ ] A full Paystack purchase completes and a ticket appears with the correct `payment_status`
- [ ] The reviewer account's free ticket tier completes checkout with no Paystack popup at all
- [ ] Push notification arrives in foreground, background, and terminated states; tapping it opens the correct screen
- [ ] Legal links, WhatsApp support, social links open in the in-app browser, not a broken blank screen
- [ ] Splash screen boots straight into the dark background with no white flash (fixed this session, verified via Gradle build only — see §3)
- [ ] Android hardware back button and edge-swipe-back both navigate correctly through the app's screen stack
- [ ] Account deletion flow works end to end (in-app)
- [ ] Report/Flag and Block User controls are reachable and functional (see §1)

## 11. VENTS Work / VENTS Earn

*Built on branch `claude/vents-work-earn`. Verified locally only: real Postgres execution, the vitest suite, and screenshots against the approved mockups. Full detail: [docs/vents-work-earn.md](docs/vents-work-earn.md).*

- [x] VENTS Work hub in Profile (one card replaces the VENTS Cents card, the duplicate VENTS Cents row and both "Become…" buttons). Each role row shows its live onboarding status. Work Opportunities show "Coming soon".
- [x] VENTS Earn screen with separately labelled balances. Service providers now reach the earnings wallet.
- [x] Retired 10% commission copy replaced with the ₦50,000 qualifying-organizer reward.
- [x] Representative dashboard header (mockup D), Rewards screen (claims, eligible events, expenses), and Admin Console → VENTS Earn (all decisions dual-control).
- [x] Migration 0201 (attribution, claims, realized-profit pool with locked reservations, idempotent credit to the withdrawable earnings wallet through the existing ledger and payout flow, expenses, monthly rate review, append-only audit), verified by 203 local checks.
- [ ] **Apply 0201 to production** (needs approval).
- [x] Payout engine safety fixes (no double payouts, reversals returned, fixed transfer reference, reconciliation report) in migration 0202 and the payout API, verified by 49 local checks and 15 mocked API tests. See `docs/money-flow-audit.md`.
- [ ] **Apply 0202 to production** (needs approval; before enabling reward credit).
- [x] **Reward credits go to the withdrawable earnings wallet** (decided 2026-10-30, implemented in 0201).
- [x] Retired 10% commission wiring removed (0201): invitations no longer promise commission sharing or store a split; legacy values, the snapshot and the reconciliation gate are kept.
- [ ] Management records the legacy 10% reconciliation through dual control. Reward approvals stay blocked until then.
- [x] **7-day settlement hold and the policy choices confirmed** (2026-10-30): first-accepted permanent attribution, event created after attribution, month counted by the event's end date, rate set per representative. Already how 0201 behaves; no code change.
- [ ] Turn on reward credit to the earnings wallet (`earn_settings.payouts_enabled`) through dual control, only after the items above. Withdrawals themselves already run on the existing payout switch.
- [ ] Define VENTS Unlock, VENTS Split and VENTS Circle. No definition exists anywhere in the repo, design source or approved mockups, so nothing was built.

---

**Legend**: ✅ items marked `[x]` were verified this session via a real build,
a real database query, or a real production API call — not assumed correct.
Everything marked `[ ]` needs a human with the relevant developer account
(Google Play Console, Apple Developer, Google Cloud Console, Firebase
Console) or a physical device to complete — except the confirmed-missing web
account-deletion page (§1) and UGC moderation UI check (§1), which are code
gaps I can help close if you want them built.
