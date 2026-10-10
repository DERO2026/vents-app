# VENTS — iOS Launch Checklist

Everything code-side is done. This is what's left, and it all has to happen
on a Mac with Xcode. Follow in order.

## 1. Generate the iOS project

```bash
npm install
npm run build
npm run ios:add       # npx cap add ios
npm run ios:assets    # generates all required icon/splash sizes from resources/
npm run ios:sync      # npm run build && npx cap sync ios
npm run ios:open      # opens ios/App/App.xcworkspace in Xcode
```

Always open **`App.xcworkspace`**, never `App.xcodeproj` — CocoaPods
dependencies (the Capacitor plugins) only resolve through the workspace.

## 2. Info.plist — add these keys (required, app will crash/reject without them)

Open `ios/App/App/Info.plist` in Xcode (or as source code) and add:

| Key | Value | Why |
|---|---|---|
| `NSCameraUsageDescription` | "VENTS needs camera access to scan ticket QR codes at the door, and to take photos for your profile picture, event cover, and chat." | QR check-in scanner **and** `pickImage.ts`'s `Camera.getPhoto()` (profile/event/chat photo capture) — the string must cover every real camera use, not just the first one added |
| `NSMicrophoneUsageDescription` | "VENTS needs microphone access to record voice messages in chat." | Voice notes in Messages |
| `NSLocationWhenInUseUsageDescription` | "VENTS needs your location to share it in chat and show nearby events." | Location share |
| `NSPhotoLibraryUsageDescription` | "VENTS needs photo library access to upload event flyers and your profile picture." | Flyer/avatar picker |
| `ITSAppUsesNonExemptEncryption` | `Boolean` → **NO** | Export compliance — skips the encryption question on every App Store Connect upload. Verified: the app only uses exempt encryption — standard TLS/HTTPS (fetch, Supabase client, Firebase SDK), OS-provided Keychain storage (`@aparajita/capacitor-secure-storage`, `@capgo/capacitor-native-biometric`), and HMAC-SHA256 for ticket QR signing, which is authentication/integrity only, not confidentiality (exempt under Category 5, Part 2 of the EAR). No custom/proprietary encryption anywhere in the dependency tree. Add this as a Boolean key set to NO directly in Xcode's Info.plist editor (or as `<key>ITSAppUsesNonExemptEncryption</key><false/>` in source view) — it is a plain Info.plist entry, so it is untouched by `npx cap sync` (sync only copies web assets and updates native plugin manifests, never rewrites Info.plist) and persists across every future build without re-answering Apple's encryption prompt. |

Also add a `CFBundleURLTypes` entry for the custom scheme (mirrors the
Android intent-filter already in `AndroidManifest.xml`):

```xml
<key>CFBundleURLTypes</key>
<array>
  <dict>
    <key>CFBundleURLSchemes</key>
    <array><string>vents</string></array>
  </dict>
</array>
```

## 3. Xcode signing

1. Select the **App** target → **Signing & Capabilities** tab.
2. Team: select your Apple Developer team (paid account required for
   Push Notifications + device testing).
3. Bundle Identifier: confirm it's exactly `com.getvents.app` (already set
   in `capacitor.config.ts` — must match what you register in App Store
   Connect).
4. Enable **Automatically manage signing** unless you already have
   provisioning profiles set up manually.

## 4. Xcode capabilities to add

In **Signing & Capabilities**, click **+ Capability** and add:

- **Push Notifications**
- **Background Modes** → check **Remote notifications**
- **Associated Domains** → add `applinks:getvents.com` (for the deep-link
  Universal Links support already wired in `App.tsx`'s `appUrlOpen`
  listener — inert until this is added and the AASA file below is hosted).
  Since `ios/` is regenerated locally and untracked (see its own `.gitignore`
  comment), this capability must be re-added by hand every time the iOS
  project is regenerated — it does not persist in git. A reference
  implementation (an `ios/App/App/App.entitlements` file with
  `com.apple.developer.associated-domains: [applinks:getvents.com]`, wired
  into the target via `CODE_SIGN_ENTITLEMENTS` in Xcode's build settings)
  was verified to work correctly in one working iOS checkout — redo the same
  two steps (add the capability in Xcode, or manually add the entitlements
  file + build setting) on whichever machine builds for release.

## 5. Push notifications (Firebase/APNs) — code done, Firebase console setup remains

**Code-side, this is done.** `src/lib/pushNotifications.ts` now uses
`@capacitor-firebase/messaging` instead of `@capacitor/push-notifications` —
that plugin wraps the Firebase iOS SDK, which still registers with APNs
internally (required by Apple) but bridges it to a real FCM token via
Firebase's own servers, so `getToken()` returns an FCM token on both iOS and
Android and the existing FCM-only send path (`api/push/send.ts`) works
unchanged. What's left is entirely Firebase Console / Xcode setup — no more
code changes needed for this:

1. In the [Firebase Console](https://console.firebase.google.com), add an
   iOS app to the existing VENTS project with bundle ID `com.getvents.app`.
2. Download `GoogleService-Info.plist` and drag it into `ios/App/App/` in
   Xcode (check "Copy items if needed").
3. In [Apple Developer](https://developer.apple.com/account) → Certificates,
   Identifiers & Profiles → Keys, create an **APNs Auth Key** (.p8), and
   upload it to Firebase Console → Project Settings → Cloud Messaging →
   Apple app configuration.
4. Android needs the equivalent `google-services.json` from the same
   Firebase project's Android app entry, placed at `android/app/`
   (`android/app/build.gradle` already conditionally applies the
   google-services Gradle plugin once that file exists — no Gradle changes
   needed).
5. Run `npm run ios:sync` (or `npx cap sync ios`) after adding the plist so
   CocoaPods picks up the Firebase native dependency.

## 6. Universal Links (deep links) — required for the getvents.com links to open the app

1. The AASA file is committed at
   `public/.well-known/apple-app-site-association` (no file extension —
   already the case, matching the same pattern `public/.well-known/
   assetlinks.json` uses for Android App Links; Vercel serves it as a static
   file, no separate hosting step needed). It supports the existing
   `?event=<id>` and `?user=<id>` deep-link paths, with the real Apple
   Developer Team ID already in place:
   ```json
   {
     "applinks": {
       "details": [
         {
           "appIDs": ["V7774S7GHB.com.getvents.app"],
           "components": [
             { "/": "/", "?": { "event": "*" } },
             { "/": "/", "?": { "user": "*" } }
           ]
         }
       ]
     }
   }
   ```
2. This file must be reachable over HTTPS with no redirects at
   `https://getvents.com/.well-known/apple-app-site-association` before
   Xcode's Associated Domains capability (step 4) will actually work —
   verify with a plain `curl` after deploying.
3. `vents://` custom-scheme links still work regardless (Android already has
   this; iOS gets it from the `CFBundleURLTypes` entry above) — a
   `getvents.com` link falls back to opening in the browser if Universal
   Links verification hasn't completed yet, so this is a safe, non-blocking
   fallback either way.

## 7. Google Maps / Places API key — referrer restriction (corrected)

**Stale guidance corrected.** This section previously said to add
`capacitor://localhost/*` as an HTTP referrer pattern for iOS. That is
**wrong** and contradicts what the codebase actually does — do not add it.

VENTS loads Maps via the JavaScript API (`src/lib/googleMaps.ts`), not a
native SDK, restricted by **HTTP referrer**, not app bundle ID — but the
app does NOT rely on a custom-scheme referrer for iOS at all:

- **Web (browser) and Android** call `loadGoogleMaps()` directly. Android's
  Capacitor WebView origin is `https://localhost` (`capacitor.config.ts`'s
  `androidScheme: 'https'`, `hostname: 'localhost'`) — a real HTTPS
  referrer, reliably matchable.
- **iOS** cannot do this: a Capacitor WKWebView's origin is permanently
  `capacitor://localhost` (confirmed against `@capacitor/ios`'s source —
  there is no config flag to change it), and Google's own documentation
  describes custom-scheme referrer matching as unreliable. Instead, VENTS
  deliberately renders the map inside a real
  `<iframe src="https://getvents.com/embed/map.html">`
  (`src/lib/mapEmbed.ts`, `shouldUseMapEmbed()`) — a genuine HTTPS
  navigation, so the Maps JS API script it loads carries a real
  `Referer: https://getvents.com/...` header, covered by the same
  restriction entry the ordinary web app already needs. iOS therefore
  needs **no separate referrer entry** — it rides on the `getvents.com`
  one.

**The correct, complete HTTP referrer allowlist (Application restrictions,
Google Cloud Console → APIs & Services → Credentials → your Maps key) is
exactly these two entries — nothing else:**

```
https://getvents.com/*
https://localhost/*
```

Do **not** add `capacitor://localhost/*` — it is unnecessary (iOS never
presents that origin to Google; it goes through the iframe above instead)
and Google's own docs call custom-scheme referrer matching unreliable, so
adding it buys nothing and only widens the allowlist without reason.

Also set **API restrictions** on the key (same Credentials page) to
exactly the three APIs this app actually calls (`src/lib/googleMaps.ts`):
**Maps JavaScript API**, **Places API (New)**, and **Geocoding API** — no
others. This is a separate, additional restriction from the referrer
allowlist above (defense in depth: even a referrer-allowed caller can't
use the key for an unrelated Google API).

Do this **before** testing location search on the physical device — a
missing/incomplete referrer entry fails silently to `googleMaps.ts`'s
"falls back to manual address entry" path, with no obvious error; the
`gm_authFailure` handler reports this to Sentry when it happens, which is
the fastest way to confirm it live.

## 8. On-device verification (do these on the physical iPhone, not the simulator, where possible — camera/push/Paystack popups don't work reliably in the simulator)

- [ ] Fresh install, no cached session — full onboarding/signup flow
- [ ] Login persists across app kill/reopen
- [ ] Camera permission prompt appears correctly; QR scanner works
- [ ] Photo library permission prompt appears; flyer/avatar upload works
- [ ] Location permission prompt appears; location share in chat works
- [ ] A full Paystack test-mode purchase completes and a ticket appears
- [ ] Push notification arrives and tapping it opens the correct screen
      (only after step 5 is done — will not work before)
- [ ] Legal links (Privacy/Terms/Refunds), WhatsApp support, social links
      open in the in-app Safari view, not a broken blank screen
- [ ] Account deletion flow works end to end
- [ ] Safe area / notch: nothing sits under the status bar or home
      indicator on any screen
- [ ] Keyboard doesn't cover the active text field on any form
- [ ] Rotate/backgrounding the app doesn't lose checkout/upload progress

## 9. App Store Connect

1. Create the app listing with bundle ID `com.getvents.app`.
2. Privacy Policy URL: `https://getvents.com/privacy` (already live, hosted
   in-app route — confirm it returns real content, not a blank page, before
   submitting).
3. Fill in App Privacy (data collection) — VENTS collects: account info
   (email, name, phone), location (optional, chat feature), photos
   (uploads), and payment info is handled entirely by Paystack (not
   collected directly).
4. Age rating: account for the app's 18+ event content gating already
   built in.
5. Build number / version: bump in Xcode before each TestFlight upload
   (`General` tab, or `agvtool` from the command line).
6. Archive (`Product → Archive`) → **Distribute App** → App Store Connect
   → Upload. First build typically takes 15–60 min to finish processing
   before it's selectable in TestFlight.

---

**What's already done in code** (this session): absolute API paths for
Capacitor, Paystack/PostHog keys present in the build, all external links
route through an in-app browser (`@capacitor/browser`), every `100vh`
replaced with `100dvh`, push notifications switched to
`@capacitor-firebase/messaging` so `getToken()` returns a real FCM token on
iOS (was raw APNs — see §5), Capacitor toolchain aligned to 8.5.0 with
`cap sync` verified clean, dead dependencies removed, app display name set
to "VENTS APP" everywhere (capacitor.config.ts's `appName`, which both
platforms' native display name derives from at `cap add`/`cap sync` time —
updated for the store release; previously "VENTS"). None of that needs to be redone — this checklist is the
native-config-only remainder (Firebase console, Info.plist, Xcode
signing/capabilities, Google Maps referrer restriction).
