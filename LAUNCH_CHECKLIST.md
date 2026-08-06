# VENTS — Launch Checklist

Single source of truth for everything left before public launch. Items are
grouped by where the work happens. Checked items were verified directly
against this codebase/production database, not assumed — see the note under
each section for how.

For the full iOS-specific walkthrough (Xcode, Info.plist, signing,
capabilities), see **[IOS_LAUNCH_CHECKLIST.md](IOS_LAUNCH_CHECKLIST.md)** —
this file only summarizes iOS status, that one has the step-by-step.

---

## 1. Signing & Build Config

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
- [ ] Bump `versionCode`/`versionName` in `android/app/build.gradle` before each Play Store upload (currently at Gradle-template defaults `1`/`"1.0"`) — Play Console requires a strictly increasing `versionCode` per upload
- [ ] iOS: Xcode signing (Apple Developer team, bundle ID confirmation, automatic signing) — see IOS_LAUNCH_CHECKLIST.md §3
- [x] Keystore, `google-services.json`, `keystore.properties` all correctly gitignored and confirmed untracked in git

## 2. Google Play Console

- [ ] Create the app listing (`com.getvents.app`)
- [ ] Store listing: screenshots (phone + tablet if supporting), feature graphic, short/full description
- [ ] Content rating questionnaire — account for 18+ event content gating already built in (nightlife/comedy events can be flagged `is_18_plus`)
- [ ] **Permissions declaration**: review whether `RECORD_AUDIO` (`AndroidManifest.xml`) should ship — it's currently declared but the voice-notes feature it's for is disabled behind a feature flag (`migrations/20260710185537_media-feature-toggles.sql`). Google's automated review sometimes flags declared-but-unused permissions; either explain the upcoming feature in the declaration form or strip the permission until voice notes ship.
- [ ] Data Safety form — VENTS collects: account info (email, name, phone), location (optional, chat feature), photos (uploads); payment info is handled entirely by Paystack, never collected/stored directly
- [ ] **App access / reviewer credentials** (Play Console → App content → App access) — provide the reviewer test account's email/password (see §7 below)
- [ ] Set up a Closed Testing or Internal Testing track first, confirm the app installs and opens cleanly, before Production release
- [ ] Privacy Policy URL: `https://getvents.com/privacy` — confirm it returns real content in production, not a blank/dev page

## 3. Apple Developer / App Store Connect

- [ ] Paid Apple Developer account active (required for Push Notifications + device testing + submission)
- [ ] Generate the iOS project — does not exist in this repo yet (`npx cap add ios`), see IOS_LAUNCH_CHECKLIST.md §1
- [ ] Info.plist usage-description strings (camera, microphone, location, photo library) — see IOS_LAUNCH_CHECKLIST.md §2
- [ ] Xcode capabilities: Push Notifications, Background Modes → Remote notifications, Associated Domains → `applinks:getvents.com`
- [ ] App Store Connect listing + screenshots + description
- [ ] App Privacy (data collection) disclosure — same data categories as the Play Store Data Safety form above
- [ ] Age rating — same 18+ content consideration as Android
- [ ] Archive → Distribute App → App Store Connect upload, verify TestFlight processing completes before submitting for review

## 4. Firebase / Push Notifications

*Verified this session: FCM is fully wired end-to-end and confirmed delivering.*

- [x] `google-services.json` present, gitignored, untracked; `com.google.gms.google-services` Gradle plugin applied conditionally
- [x] `POST_NOTIFICATIONS` permission present (merged automatically from `@capacitor-firebase/messaging`'s own manifest)
- [x] `src/lib/pushNotifications.ts` — real permission request flow, no dev shortcuts, token registration/deregistration both implemented
- [x] `FCM_SERVICE_ACCOUNT_JSON` set in Vercel — **verified live** by running the actual cron delivery worker (`api/cron/run.ts`) against production; no auth errors, notification sweep completed successfully
- [x] Backend delivery system built and verified this session: ticket confirmations, new-sale notifications, new-message notifications, 24h/1h event reminders, event-update notifications — all wired to real FCM delivery, not just the in-app bell list
- [ ] iOS: add an iOS app to the Firebase project, download `GoogleService-Info.plist`, generate an APNs Auth Key (.p8) in Apple Developer and upload it to Firebase Console — see IOS_LAUNCH_CHECKLIST.md §5
- [ ] On-device test: confirm a tapped push notification opens the correct screen (deep-link routing for `chat`/`sales-analytics`/`event-details`/`user-profile` was added this session but not yet click-tested on a physical device)

## 5. Google Maps / Places

- [x] API key sourced from env (`VITE_GOOGLE_PLACES_API_KEY`), never hardcoded in source
- [x] Android WebView origin fix in place (`capacitor.config.ts` `androidScheme: 'https'`, `hostname: 'localhost'`) — this was the root cause of a real production `gm_authFailure` incident, fixed and confirmed working by the user
- [ ] **Verify the Places API key has proper HTTP-referrer restrictions** in Google Cloud Console — it's committed in plaintext in `vercel.json` (normal for a client-embedded key, but confirm it's locked to `getvents.com` + the Capacitor origins so it can't be abused if scraped)
- [ ] iOS: add `capacitor://localhost/*` and `https://localhost/*` referrer patterns (iOS WebView sends a different referrer than Android) — see IOS_LAUNCH_CHECKLIST.md §7

## 6. Backend / Infrastructure

*Verified this session via direct production database checks and a real Vercel deployment.*

- [x] Payment webhook (`api/webhook/paystack.ts`) confirmed working end-to-end — found and fixed two real production bugs this session: a missing `INSFORGE_API_KEY` causing every real payment to silently fail to confirm since July 31, and an overly-strict amount-equality check rejecting legitimate payments once Paystack's own transaction fee was added on top. Both fixed and verified live with a real test purchase.
- [x] `INSFORGE_API_KEY`, `PAYSTACK_SECRET_KEY`, `CRON_SECRET` all confirmed set in Vercel production
- [x] Two stuck real-money tickets from before the fix were manually recovered and independently verified against Paystack's own transaction records (not just trusted blindly)
- [x] Bank account management (add/remove/set-default, max 3 accounts) — fixed a real FK-violation bug this session (hard-delete → soft-delete), verified against the live database with a reproduced failure scenario
- [ ] **Vercel plan**: currently on Hobby — push/reminder crons run once daily (not near-real-time) and serverless functions are capped at 12 (already consolidated to exactly 12). Upgrade to Pro if faster notification delivery or more functions are needed post-launch.
- [ ] Confirm `PAYSTACK_SECRET_KEY` is production/live mode, not test mode, before public launch (opposite of §7's testing guidance — production traffic needs the live key)
- [ ] Set up basic uptime/error monitoring alerting (Sentry is integrated — confirm alert rules are actually configured, not just SDK-installed)

## 7. Reviewer Test Account & Seed Data

*Scripts written this session — not yet executed. Run manually, see each file's own header comment.*

- [ ] `scripts/01-cleanup-junk-events.sql` — removes placeholder/test events from the feed. **Read the file's Step 1 output before running Steps 2-3** — it distinguishes junk events with zero ticket history (safe to delete) from junk-titled events that turned out to have real paid tickets attached (soft-hidden instead, never deleted)
- [ ] Sign up a real account through the app with a dedicated reviewer email (suggested: `playstore-reviewer@getvents.com`)
- [ ] `scripts/03-reviewer-test-account.sql` — promotes that account to a verified organizer with a funded wallet, one demo event (including a **free ticket tier** so checkout can be tested end-to-end with zero payment friction), one paid demo ticket, and a starter notification
- [ ] `scripts/02-seed-showcase-events.sql` — seeds 8 realistic events across categories (attached to the reviewer account as organizer) so the public feed looks vibrant on first open. **Spot-check the Unsplash image URLs still resolve before relying on this for submission**, and plan to replace them with real event photography before actual public launch
- [ ] Provide the reviewer account's email/password in Play Console → App content → App access
- [ ] **Do not implement a payment-gateway bypass for this account** — see the note at the bottom of `scripts/03-reviewer-test-account.sql` for why, and use either the free ticket tier or Paystack test-mode instead

## 8. Legal / Privacy

- [ ] Privacy Policy live and accurate at `/privacy` — confirm it actually describes current data collection (account info, optional location for chat, photo uploads, Paystack-handled payments)
- [ ] Terms of Service live at `/terms`
- [ ] Refund policy live at `/refunds` (referenced in IOS_LAUNCH_CHECKLIST.md's App Store Connect section)
- [ ] Confirm account-deletion flow works end to end (a real bug — `delete_own_account()` referencing an already-dropped `follows` table — was found and fixed this session; re-verify deletion still works after that fix)

## 9. On-Device Testing (do this on a real device, not just emulator — camera/push/Paystack popups are unreliable in emulators)

- [ ] Fresh install, no cached session — full onboarding/signup flow
- [ ] Login persists across app kill/reopen
- [ ] Camera permission prompt appears correctly; QR scanner works
- [ ] Photo library / gallery-save permission prompts appear correctly; the new native "Save Ticket" (silent save to Photos/Gallery, added this session) and "Share Ticket" (native share sheet) both work — **not yet click-tested on a physical device**, only verified to compile in real debug+release Gradle builds
- [ ] A full Paystack purchase completes and a ticket appears with the correct `payment_status`
- [ ] Push notification arrives in foreground, background, and terminated states; tapping it opens the correct screen
- [ ] Legal links, WhatsApp support, social links open in the in-app browser, not a broken blank screen
- [ ] Splash screen boots straight into the dark background with no white flash (fixed this session — verified via real Gradle builds, not yet seen live on a device with the actual `values-v31` resource qualifier)
- [ ] Android hardware back button and edge-swipe-back both navigate correctly through the app's screen stack
- [ ] Account deletion flow works end to end

---

**Legend**: ✅ items marked `[x]` were verified this session via a real build,
a real database query, or a real production API call — not assumed correct.
Everything marked `[ ]` needs a human with the relevant developer account
(Google Play Console, Apple Developer, Google Cloud Console, Firebase
Console) or a physical device to complete.
