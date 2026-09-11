import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Locks in the "Share Payment Link" fix: the link previously built from
// window.location.origin + window.location.pathname, which resolves to a
// Vercel Preview branch URL on every deploy except Production web, and to
// capacitor://localhost / https://localhost inside the native app -- none
// of which a payer opening the link on a different device could ever
// reach. Fixed to the same fixed-domain pattern EventDetailsScreen.tsx's
// own Share Event link already uses (https://getvents.com/...).

let appSrc: string;

beforeAll(() => {
  appSrc = readFileSync(join(__dirname, '..', 'app', 'App.tsx'), 'utf8');
});

describe('Share Payment Link: always a real public getvents.com URL', () => {
  it('never builds the payment-request share link from window.location.origin/pathname', () => {
    expect(appSrc).not.toMatch(/window\.location\.origin\}\$\{window\.location\.pathname\}\?payment_request=/);
  });

  it('builds it from the fixed production domain instead', () => {
    expect(appSrc).toMatch(/const link = `https:\/\/getvents\.com\/\?payment_request=\$\{encodeURIComponent\(paymentRequestSentInfo\.paymentRef\)\}`;/);
  });
});
