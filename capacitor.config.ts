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
};

export default config;
