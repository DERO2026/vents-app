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
| `NSCameraUsageDescription` | "VENTS needs camera access to scan ticket QR codes at the door." | QR check-in scanner |
| `NSMicrophoneUsageDescription` | "VENTS needs microphone access to record voice messages in chat." | Voice notes in Messages |
| `NSLocationWhenInUseUsageDescription` | "VENTS needs your location to share it in chat and show nearby events." | Location share |
| `NSPhotoLibraryUsageDescription` | "VENTS needs photo library access to upload event flyers and your profile picture." | Flyer/avatar picker |

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
  listener — inert until this is added and the AASA file below is hosted)

## 5. Push notifications (Firebase/APNs) — the biggest remaining setup step

The app currently sends push via **FCM** (`api/push/send.ts`). On iOS,
`@capacitor/push-notifications` registers with **APNs** directly — FCM
cannot deliver to a raw APNs token unless Firebase bridges the two. Without
this, iOS push notifications will silently never arrive.

1. In the [Firebase Console](https://console.firebase.google.com), add an
   iOS app to the existing VENTS project with bundle ID `com.getvents.app`.
2. Download `GoogleService-Info.plist` and drag it into `ios/App/App/` in
   Xcode (check "Copy items if needed").
3. In [Apple Developer](https://developer.apple.com/account) → Certificates,
   Identifiers & Profiles → Keys, create an **APNs Auth Key** (.p8), and
   upload it to Firebase Console → Project Settings → Cloud Messaging →
   Apple app configuration.
4. Install `@capacitor-firebase/messaging` (or the Firebase iOS SDK) so the
   token `pushNotifications.ts` receives is an FCM token, not a raw APNs
   token — this needs a small code change in `src/lib/pushNotifications.ts`
   once the Firebase plugin is in place. Flag this back if you want help
   wiring it once the Mac-side Firebase setup is done.

## 6. Universal Links (deep links) — required for the getvents.com links to open the app

1. Host a file at `https://getvents.com/.well-known/apple-app-site-association`
   (no file extension, served as `application/json`) containing your Team
   ID + `com.getvents.app`. Format:
   ```json
   {
     "applinks": {
       "apps": [],
       "details": [
         { "appID": "TEAMID.com.getvents.app", "paths": ["*"] }
       ]
     }
   }
   ```
2. This must be reachable over HTTPS with no redirects before Xcode's
   Associated Domains capability (step 4) will actually work.
3. Until this is live, `vents://` custom-scheme links still work (Android
   already has this; iOS gets it from the `CFBundleURLTypes` entry above).

## 7. Google Maps / Places API key — iOS referrer restriction

**Your Android key working does not mean iOS will work.** VENTS loads Maps
via the JavaScript API (`src/lib/googleMaps.ts`), not a native SDK — so it's
restricted by **HTTP referrer**, not by app bundle ID. Inside a Capacitor
WKWebView, the referrer Google sees is `capacitor://localhost`, not
`getvents.com`.

**Fix (in Google Cloud Console → APIs & Services → Credentials → your Maps
key → Application restrictions → HTTP referrers):** add these two referrer
patterns alongside your existing `https://getvents.com/*`:

```
capacitor://localhost/*
https://localhost/*
```

Do this **before** testing location search on the physical device — it
will silently fail to `googleMaps.ts`'s "falls back to manual address
entry" path otherwise, with no obvious error.

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
route through an in-app browser, `100vh` → `100dvh` fixes, Capacitor
toolchain aligned to 8.5.0 with `cap sync` verified clean, dead dependency
removed, app name set to "VENTS" everywhere. None of that needs to be
redone — this checklist is the native-only remainder.
