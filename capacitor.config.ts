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
      // Keeps the native launch splash (drawable/splash.png, matching
      // SplashScreen.tsx's own #020005 background) visible through the gap
      // between "native activity drawn" and "JS bundle loaded and the
      // custom animated splash mounted" — without this, that gap shows as
      // a blank white/black flash before the JS splash ever appears.
      // main.tsx calls SplashScreen.hide() once the app has actually mounted.
      launchAutoHide: false,
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
