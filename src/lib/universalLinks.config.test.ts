import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('./supabase', () => ({ supabase: { rpc: vi.fn() } }));
import { PAY_PARAM, payLinkFor } from './walletTransfers';

// The platform side of VENTS links. iOS opens https://getvents.com/?… in the
// app only when the hosted apple-app-site-association (AASA) lists a component
// matching the URL, for the app ID in the signed Associated Domains
// entitlement. Android App Links need the autoVerify intent filter and a
// matching assetlinks.json. These checks keep those files consistent with
// each other and with every link the app itself generates.

const root = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const aasaText = read('public/.well-known/apple-app-site-association');
const aasa = JSON.parse(aasaText);
const detail = aasa.applinks.details[0];
const queryKeys = (detail.components as any[]).map((c) => Object.keys(c['?'] ?? {})).flat();

describe('iOS: apple-app-site-association', () => {
  it('is valid JSON with exactly one app and no unsupported top-level keys', () => {
    expect(Object.keys(aasa)).toEqual(['applinks']);
    expect(aasa.applinks.details).toHaveLength(1);
    expect(detail.appIDs).toEqual(['V7774S7GHB.com.getvents.app']);
  });

  it('the app ID is the Xcode project\'s team + bundle ID, and the entitlement names getvents.com', () => {
    const pbx = read('ios/App/App.xcodeproj/project.pbxproj');
    const teams = new Set([...pbx.matchAll(/DEVELOPMENT_TEAM = (\w+);/g)].map((m) => m[1]));
    const bundles = new Set([...pbx.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = ([\w.]+);/g)].map((m) => m[1]));
    expect([...teams]).toEqual(['V7774S7GHB']);
    expect([...bundles]).toEqual(['com.getvents.app']);
    expect(read('capacitor.config.ts')).toMatch(/appId: 'com\.getvents\.app'/);
    const ent = read('ios/App/App/App.entitlements');
    expect(ent).toMatch(/<key>com\.apple\.developer\.associated-domains<\/key>\s*<array>\s*<string>applinks:getvents\.com<\/string>/);
  });

  it('covers the payment links (?pay=, ?payment_request=) and keeps event, user and provider', () => {
    expect(queryKeys.sort()).toEqual(['event', 'pay', 'payment_request', 'provider', 'user']);
    expect(PAY_PARAM).toBe('pay');
    for (const c of detail.components) {
      expect(c['/']).toBe('/');                                   // root path only, as the links are built
      expect(Object.values(c['?'])).toEqual(['*']);               // any value: validated in the app
    }
  });

  it('every getvents.com query link the app builds has a matching component', () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(join(root, d), { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.(ts|tsx)$/.test(e.name)) files.push(p);
      }
    };
    walk('src');
    const generated = new Set<string>();
    for (const f of files) for (const m of read(f).matchAll(/https:\/\/getvents\.com\/\?(\w+)=/g)) generated.add(m[1]);
    generated.add(new URL(payLinkFor('ada')).searchParams.keys().next().value!);   // built from PAY_LINK_BASE + PAY_PARAM
    // Referral links (?ref= VENTS Cents, ?rep= Representative) stay web-only on purpose: they
    // attribute sign-ups and are meant for people without the app (see src/lib/openedUrl.ts).
    const WEB_ONLY = ['ref', 'rep'];
    expect([...generated].sort()).toEqual(['event', 'pay', 'payment_request', 'provider', 'ref', 'rep', 'user']);
    for (const key of generated) {
      if (WEB_ONLY.includes(key)) expect(queryKeys, key).not.toContain(key);
      else expect(queryKeys, key).toContain(key);
    }
  });

  it('is served as application/json (vercel.json), not octet-stream', () => {
    const vercel = JSON.parse(read('vercel.json'));
    const h = (src: string) => vercel.headers.find((x: any) => x.source === src)?.headers.find((y: any) => y.key === 'Content-Type')?.value;
    expect(h('/.well-known/apple-app-site-association')).toBe('application/json');
    expect(h('/.well-known/assetlinks.json')).toBe('application/json');
  });
});

describe('Android: App Links unaffected', () => {
  const manifest = read('android/app/src/main/AndroidManifest.xml');
  it('the getvents.com intent filter is autoVerify, https, whole host (so ?pay= is covered with no change)', () => {
    const filter = manifest.match(/<intent-filter android:autoVerify="true">[\s\S]*?<\/intent-filter>/)?.[0] ?? '';
    expect(filter).toMatch(/<action android:name="android\.intent\.action\.VIEW" \/>/);
    expect(filter).toMatch(/android\.intent\.category\.BROWSABLE/);
    expect(filter).toMatch(/<data android:scheme="https" android:host="getvents\.com" \/>/);
    expect(filter).not.toMatch(/pathPrefix|pathPattern|android:path=/);
  });
  it('the vents:// scheme filter is still there', () => {
    expect(manifest).toMatch(/<data android:scheme="vents" \/>/);
  });
  it('assetlinks.json is valid and names the app\'s package', () => {
    const links = JSON.parse(read('public/.well-known/assetlinks.json'));
    expect(links[0].relation).toEqual(['delegate_permission/common.handle_all_urls']);
    expect(links[0].target.package_name).toBe('com.getvents.app');
    expect(read('android/app/build.gradle')).toMatch(/applicationId "com\.getvents\.app"/);
    expect(links[0].target.sha256_cert_fingerprints[0]).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  });
});

describe('App.tsx routes opened URLs through routeOpenedUrl (cold start and already open)', () => {
  const app = read('src/app/App.tsx');
  const handler = app.slice(app.indexOf("addListener('appUrlOpen'"), app.indexOf("addListener('backButton'"));
  it('the native appUrlOpen handler uses the shared parser and handles pay, invalid pay and provider', () => {
    expect(handler).toMatch(/const route = routeOpenedUrl\(url\);/);
    expect(handler).toMatch(/case 'pay':\s*openPayLinkRef\.current\(route\.username\);/);
    expect(handler).toMatch(/case 'invalid_pay':\s*setAppToastError\(/);
    expect(handler).toMatch(/case 'provider':\s*openProviderLinkRef\.current\(route\.providerId\);/);
    expect(handler).toMatch(/case 'payment_request':\s*pushActionRef\.current\(\{ paymentRef: route\.paymentRef \}\);/);
    expect(handler).not.toMatch(/new URL\(url\)/);                     // no second, divergent parser
  });
  it('a payment link only opens the wallet: no transfer call, no amount', () => {
    const opener = app.slice(app.indexOf('openPayLinkRef.current = (username: string) => {'), app.indexOf('openProviderLinkRef.current = (providerId'));
    expect(opener).toMatch(/sessionStorage\.setItem\(PAY_TO_STORAGE_KEY, username\)/);
    expect(opener).toMatch(/setScreen\('customer-wallet'\)/);
    expect(opener).not.toMatch(/transfer_wallet_funds|sendMoney|rpc\(/);
  });
  it('the web page-load ?pay= path is unchanged (validated username into sessionStorage, then the wallet)', () => {
    expect(app).toMatch(/const payTo = usernameFromPayParam\(params\.get\(PAY_PARAM\)\);/);
    expect(app).toMatch(/if \(payTo\) \{\s*try \{ sessionStorage\.setItem\(PAY_TO_STORAGE_KEY, payTo\); \}/);
  });
  it('a wallet link opened while the wallet is already on screen remounts it (re-keyed by a nonce)', () => {
    expect(app).toMatch(/key=\{`\$\{screen\}:\$\{walletLinkNonce\}`\}/);
    const opener = app.slice(app.indexOf('openPayLinkRef.current = (username: string) => {'), app.indexOf('openProviderLinkRef.current = (providerId'));
    expect(opener).toMatch(/setWalletLinkNonce\(\(n\) => n \+ 1\)/);
    expect(app).toMatch(/sessionStorage\.setItem\(WALLET_RECEIPT_STORAGE_KEY, data\.reference\); \} catch \{[^}]*\}\s*setWalletLinkNonce\(\(n\) => n \+ 1\);/);
  });
});
