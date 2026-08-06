# VENTS — Launch Checklist

Single source of truth for everything left before public launch. Items are
grouped by where the work happens. Checked items were verified directly
against this codebase/production database, not assumed — see the note under
each section for how.

For the full iOS-specific walkthrough (Xcode, Info.plist, signing,
capabilities), see **[IOS_LAUNCH_CHECKLIST.md](IOS_LAUNCH_CHECKLIST.md)** —
this file only summarizes iOS status, that one has the step-by-step.

---

## 1. Google Play Store Policy & Compliance

*The five most common rejection triggers for an event app, checked directly
against this codebase.*

- [ ] **In-app account deletion** — exists: Settings → Delete Account, wired to `delete_own_account()`. **Verified working**: a real bug (`delete_own_account()` referencing an already-dropped `follows` table) was found and fixed this session; re-confirm deletion still works end to end after that fix.
- [ ] **Public web account-deletion page/URL** — **confirmed MISSING**. Checked `src/main.tsx`'s public route list directly: only `/privacy`, `/terms`, `/refunds`, `/help` are served as standalone web pages outside the app shell. Google requires a deletion path reachable *without installing the app or logging in* (a web form, or at minimum a page explaining how). This needs a new public route + page, or a documented manual-request process (e.g. "email privacy@getvents.com") entered into the Data Safety form. **Ask me to build this if you want a real self-service page instead of a manual-request fallback.**
- [x] **Privacy Policy accessibility** — live at `https://getvents.com/privacy`, served via the public route list above (no auth required to view). Confirm the URL entered in Play Console matches exactly (including `https://`, no trailing differences).
- [x] **UGC moderation controls** — verified directly in code: `ReportModal.tsx` exists and is wired into both `EventDetailsScreen.tsx` and `UserProfileScreen.tsx` (Report/Flag reachable from both events and profiles); `blocked_users`/`block_user()` is wired into `InboxScreen.tsx` and `App.tsx`, not just present as an unused RPC. Both are real, reachable UI controls, not just schema-level scaffolding.
- [ ] **Permission audit** — checked `AndroidManifest.xml` directly:
  - [x] No background location permission requested anywhere (confirmed: no `ACCESS_BACKGROUND_LOCATION`, no `navigator.geolocation` usage in `src/` at all — the app doesn't request device location at all, only Google Places text search)
  - [x] No `ACCESS_FINE_LOCATION`/`ACCESS_COARSE_LOCATION` requested either — nothing to justify in Play Console on this front
  - [ ] `RECORD_AUDIO` is declared but the voice-notes feature it's for is currently disabled behind a feature flag (`migrations/20260710185537_media-feature-toggles.sql`). Google's automated review sometimes flags declared-but-unused permissions — either justify the upcoming feature in the Play Console permissions declaration, or strip the permission until voice notes ship.

## 2. Reviewer Test Credentials & Data Safety

*Completed this session — account promoted and seed data live in production, verified via direct database queries.*

- [x] **Reviewer account exists and is promoted**: username `testerboy` (pre-existing account, confirmed with the account owner before modifying), promoted to `role='organizer'`, `is_verified=true`, funded wallet (₦45,500 balance / ₦50,000 total earned), `email_verified` confirmed true.
- [ ] **Play Console App Access password mismatch**: the password originally submitted (`testerboy123`) failed this app's own password policy (needs an uppercase letter). Created the account with `testerboy123A` instead — **update the Play Console App Access form to match before submitting for review**, or the reviewer's login will fail.
- [x] **Seed events verified live in production** — queried directly: 9 events now attached to the `testerboy` organizer account (8 realistic showcase events across categories + 1 dedicated demo event), all `status='live'`, real future dates, real Nigerian venues, proper ticket tiers.
- [x] **Sandbox/demo checkout path verified** — the reviewer's demo event includes a **free ("Reviewer Access") ticket tier**. Checkout for a ₦0 ticket never touches Paystack at all (confirmed by reading `CheckoutScreen.tsx`/`paystack.ts`), so a reviewer can complete a full purchase end-to-end with zero payment friction and no card needed.
- [ ] **Deliberately not implemented**: a payment-gateway bypass hardcoded to this account. `confirm_ticket_payment` was hardened earlier this session against exactly this class of hole (was reachable by any client with a self-chosen reference/amount before being locked to the Paystack webhook only) — special-casing one user id back open re-creates the same fraud vector for anyone who leaks that account's credentials. The free ticket tier above is the safe equivalent; Paystack test-mode (swap the public key on a non-production deploy) is the other standard option if a *paid* flow specifically needs testing.
- [ ] Spot-check the seeded Unsplash image URLs still resolve, and plan to replace them with real event photography before public (non-review) launch — hotlinking a third party's CDN indefinitely for core app content isn't something to leave in place long-term.
- [ ] Run `scripts/01-cleanup-junk-events.sql` — removes placeholder/test events from the public feed. **Read the file's Step 1 SELECT output before running Steps 2-3**: two of the four junk-titled events found in production turned out to have real, Paystack-verified paid tickets attached — those get soft-hidden, never deleted, so financial history isn't destroyed.
- [ ] Enter `testerboy` / `testerboy123A` in Play Console → App content → App access, plus a note that email-based login also works if needed (the account's real email is on file, not published here).

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

- [ ] App title, short description (80 chars), full description finalized
- [ ] High-res phone screenshots (minimum 2, Play Store requires at least 2 per supported form factor)
- [ ] Tablet screenshots, only if explicitly supporting tablets
- [ ] Feature graphic — 1024×500, required for the Play Store listing header
- [ ] App icon — 512×512 high-res version for the store listing itself (separate from the in-app launcher icon sizes)
- [ ] Content rating questionnaire — account for the 18+ event content gating already built in (`is_18_plus` flag on events)
- [ ] Data Safety form — VENTS collects: account info (email, name, phone), photos (uploads); payment info is handled entirely by Paystack, never collected/stored directly. **No location data is collected at all** (confirmed — see §1's permission audit)

## 5. Closed Testing Track

- [ ] **Confirm whether this applies to your Play Console account**: mandatory for personal accounts created after November 2023 — requires a Closed Testing phase with **at least 12 opted-in testers for 14 consecutive days** before Production access is granted. Check your account creation date in Play Console → Account details.
- [ ] If required: create a Closed Testing track, generate the opt-in link, and recruit 12+ testers (the `testerboy` reviewer account counts as one, but 11+ more real testers are needed)
- [ ] Send the opt-in link to testers and confirm they actually install + open the app (an opted-in tester who never installs doesn't count toward the 14-day window in some interpretations — confirm current Play Console requirements, these have changed before)
- [ ] Monitor the 14-day window — track start date, don't request Production access before it elapses

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
- [ ] **Verify the Places API key has proper HTTP-referrer restrictions** in Google Cloud Console — it's committed in plaintext in `vercel.json` (normal for a client-embedded key, but confirm it's locked to `getvents.com` + the Capacitor origins so it can't be abused if scraped)
- [ ] iOS: add `capacitor://localhost/*` and `https://localhost/*` referrer patterns (iOS WebView sends a different referrer than Android) — see IOS_LAUNCH_CHECKLIST.md §7

## 9. Backend / Infrastructure

*Verified this session via direct production database checks and a real Vercel deployment.*

- [x] Payment webhook (`api/webhook/paystack.ts`) confirmed working end-to-end — found and fixed two real production bugs this session: a missing `INSFORGE_API_KEY` causing every real payment to silently fail to confirm since July 31, and an overly-strict amount-equality check rejecting legitimate payments once Paystack's own transaction fee was added on top. Both fixed and verified live with a real test purchase.
- [x] `INSFORGE_API_KEY`, `PAYSTACK_SECRET_KEY`, `CRON_SECRET` all confirmed set in Vercel production
- [x] Two stuck real-money tickets from before the fix were manually recovered and independently verified against Paystack's own transaction records (not just trusted blindly)
- [x] Bank account management (add/remove/set-default, max 3 accounts) — fixed a real FK-violation bug this session (hard-delete → soft-delete), verified against the live database with a reproduced failure scenario
- [ ] **Vercel plan**: currently on Hobby — push/reminder crons run once daily (not near-real-time) and serverless functions are capped at 12 (already consolidated to exactly 12). Upgrade to Pro if faster notification delivery or more functions are needed post-launch.
- [ ] Confirm `PAYSTACK_SECRET_KEY` is production/live mode, not test mode, before public launch
- [ ] Set up basic uptime/error monitoring alerting (Sentry is integrated — confirm alert rules are actually configured, not just SDK-installed)

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

---

**Legend**: ✅ items marked `[x]` were verified this session via a real build,
a real database query, or a real production API call — not assumed correct.
Everything marked `[ ]` needs a human with the relevant developer account
(Google Play Console, Apple Developer, Google Cloud Console, Firebase
Console) or a physical device to complete — except the confirmed-missing web
account-deletion page (§1) and UGC moderation UI check (§1), which are code
gaps I can help close if you want them built.
