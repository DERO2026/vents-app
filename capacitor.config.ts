import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.getvents.app',
  appName: 'VENTS',
  webDir: 'dist',
  // Explicit instead of relying on Capacitor's implicit default (which is
  // already 'https'/'localhost', not the file:// scheme a plain WebView or
  // an older Cordova app would use) — makes the WebView's actual origin
  // unambiguous: https://localhost, matching the "https://localhost/*"
  // entry already in the Google Maps API key's referrer allowlist.
  server: {
    androidScheme: 'https',
    hostname: 'localhost',
  },
  plugins: {
    SplashScreen: {
      // launchAutoHide:false (the previous setting) made the native launch
      // screen depend entirely on a JS-side SplashScreen.hide() call to ever
      // disappear — if that call was ever missed, delayed, or silently
      // failed (plugin not synced into the native project, an error before
      // the call ran, etc.) the launch screen hung indefinitely with no
      // fallback. The app no longer shows a branded JS splash at all, so
      // there is nothing to hand off to: let the OS auto-hide the native
      // launch screen itself, immediately, with zero dependency on JS.
      // (main.tsx still calls hideNativeSplash() as a best-effort early
      // hide, but correctness no longer relies on it.)
      launchAutoHide: true,
      launchShowDuration: 0,
      backgroundColor: '#020005',
      androidSplashResourceName: 'splash',
      androidScaleType: 'CENTER_CROP',
      splashFullScreen: true,
      splashImmersive: true,
    },
    StatusBar: {
      // Overlay so the status bar sits on top of the app's own dark
      // background instead of pushing content down / leaving a mismatched
      // bar of a different color above it — set explicitly at runtime
      // (main.tsx) since Style/color also needs to react to light/dark
      // theme toggling, not just a fixed startup value.
      overlaysWebView: false,
    },
    Keyboard: {
      // 'native' lets the WebView's own viewport resize handle keyboard
      // avoidance (inputs already scroll into view via each screen's normal
      // scroll container) instead of Capacitor resizing the whole webview
      // body, which fought with this app's fixed-viewport phone-frame shell.
      resize: 'native',
    },
  },
};

export default config;
