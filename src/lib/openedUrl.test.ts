import { describe, it, expect, vi } from 'vitest';
vi.mock('./supabase', () => ({ supabase: { rpc: vi.fn() } }));
import { routeOpenedUrl } from './openedUrl';
import { payLinkFor } from './walletTransfers';

// Every URL that opens the native app (iOS Universal Link, Android App Link,
// vents://) is routed by routeOpenedUrl(). Cold start and already-open both
// deliver the same URL through appUrlOpen, so one routing function covers both.

const EVENT = '3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c';
const USER = '0000000b-0000-0000-0000-00000000000b';
const PROVIDER = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

describe('payment links (?pay=)', () => {
  it('the exact link the Receive sheet shares opens Send Money for that username', () => {
    expect(payLinkFor('ada.obi')).toBe('https://getvents.com/?pay=ada.obi');
    expect(routeOpenedUrl(payLinkFor('ada.obi'))).toEqual({ kind: 'pay', username: 'ada.obi' });
  });
  it.each([
    ['https://getvents.com/?pay=%40ada_obi', 'ada_obi'],          // @ encoded
    ['https://getvents.com/?pay=@ada_obi', 'ada_obi'],
    ['https://www.getvents.com/?pay=Ada', 'Ada'],                  // www host
    ['https://GETVENTS.com/?pay=ada', 'ada'],                      // host case
    ['https://getvents.com/?pay=%20ada%20', 'ada'],                // whitespace
  ])('%s -> %s', (url, username) => {
    expect(routeOpenedUrl(url)).toEqual({ kind: 'pay', username });
  });
  it.each([
    'https://getvents.com/?pay=',
    'https://getvents.com/?pay',
    'https://getvents.com/?pay=a',                                 // too short
    'https://getvents.com/?pay=' + 'a'.repeat(41),                 // too long
    'https://getvents.com/?pay=ada%3Cscript%3E',
    'https://getvents.com/?pay=ada%20obi',
    'https://getvents.com/?pay=..%2F..%2Fadmin',
  ])('invalid or incomplete: %s fails safely (no recipient, says so)', (url) => {
    expect(routeOpenedUrl(url)).toEqual({ kind: 'invalid_pay' });
  });
  it('multiple query parameters: extra tracking params are ignored, pay still wins', () => {
    expect(routeOpenedUrl('https://getvents.com/?utm_source=whatsapp&pay=ada&ref=qr')).toEqual({ kind: 'pay', username: 'ada' });
    expect(routeOpenedUrl(`https://getvents.com/?pay=ada&event=${EVENT}`)).toEqual({ kind: 'pay', username: 'ada' });
  });
  it('only the username is taken from the link: amount or note parameters are never routed', () => {
    const r = routeOpenedUrl('https://getvents.com/?pay=ada&amount=500000&note=hi');
    expect(r).toEqual({ kind: 'pay', username: 'ada' });
    expect(Object.keys(r)).toEqual(['kind', 'username']);
  });
});

describe('payment request links (?payment_request=)', () => {
  const REF = 'VNT-' + '0123456789abcdef'.repeat(2);
  it('a valid ref opens the payment request', () => {
    expect(routeOpenedUrl(`https://getvents.com/?payment_request=${REF}`)).toEqual({ kind: 'payment_request', paymentRef: REF });
    expect(routeOpenedUrl(`https://getvents.com/?utm_source=sms&payment_request=${REF}`)).toEqual({ kind: 'payment_request', paymentRef: REF });
  });
  it.each(['VNT-123', 'abc', `${REF}x`, "VNT-0123456789abcdef0123456789abcde'"])('a malformed ref (%s) goes nowhere', (ref) => {
    expect(routeOpenedUrl(`https://getvents.com/?payment_request=${encodeURIComponent(ref)}`)).toEqual({ kind: 'none' });
  });
});

describe('referral links stay web-only', () => {
  it('?ref= and ?rep= are not routed natively', () => {
    expect(routeOpenedUrl('https://getvents.com/?ref=ABCD1234')).toEqual({ kind: 'none' });
    expect(routeOpenedUrl('https://getvents.com/?rep=ABCD2345')).toEqual({ kind: 'none' });
  });
});

describe('existing links keep working', () => {
  it('event links (with and without screen)', () => {
    expect(routeOpenedUrl(`https://getvents.com/?event=${EVENT}`)).toEqual({ kind: 'event', eventId: EVENT, screen: undefined });
    expect(routeOpenedUrl(`https://getvents.com/?event=${EVENT}&screen=sales-analytics`)).toEqual({ kind: 'event', eventId: EVENT, screen: 'sales-analytics' });
    expect(routeOpenedUrl(`vents://open?event=${EVENT}`)).toEqual({ kind: 'event', eventId: EVENT, screen: undefined });
  });
  it('user profile links', () => {
    expect(routeOpenedUrl(`https://getvents.com/?user=${USER}`)).toEqual({ kind: 'user', userId: USER, screen: undefined });
    expect(routeOpenedUrl(`https://getvents.com/?utm_campaign=x&user=${USER}`)).toEqual({ kind: 'user', userId: USER, screen: undefined });
  });
  it('provider links (previously claimed by the AASA but not routed natively)', () => {
    expect(routeOpenedUrl(`https://getvents.com/?provider=${PROVIDER}`)).toEqual({ kind: 'provider', providerId: PROVIDER });
  });
  it('screen-only links', () => {
    expect(routeOpenedUrl('vents://open?screen=notifications')).toEqual({ kind: 'screen', screen: 'notifications' });
  });
  it('vents:// email and payment round trips', () => {
    expect(routeOpenedUrl('vents://verify?email=a%40example.test')).toEqual({ kind: 'verify_email', email: 'a@example.test' });
    expect(routeOpenedUrl('vents://reset?email=a%40example.test')).toEqual({ kind: 'reset_password', email: 'a@example.test' });
    expect(routeOpenedUrl('vents://payment?ref=VNT-123')).toEqual({ kind: 'payment_return', ref: 'VNT-123' });
    expect(routeOpenedUrl('vents://verify')).toEqual({ kind: 'none' });
  });
  it('precedence with several known params: event, then user, then provider', () => {
    expect(routeOpenedUrl(`https://getvents.com/?user=${USER}&event=${EVENT}`).kind).toBe('event');
    expect(routeOpenedUrl(`https://getvents.com/?provider=${PROVIDER}&user=${USER}`).kind).toBe('user');
  });
});

describe('fails safely', () => {
  it.each([
    null, undefined, '', 'not a url', 'javascript:alert(1)',
    `https://evil.example/?pay=ada`,
    `https://getvents.com.evil.example/?event=${EVENT}`,
    `http://getvents.com/?pay=ada`,                                // not https
    `https://getvents.com/?event=not-a-uuid`,
    `https://getvents.com/?user=1%20OR%201%3D1`,
    `https://getvents.com/?provider=../../etc`,
    'https://getvents.com/',
    'https://getvents.com/?unknown=1',
  ])('%s -> none', (url) => {
    expect(routeOpenedUrl(url as any)).toEqual({ kind: 'none' });
  });
});
