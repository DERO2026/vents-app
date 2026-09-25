import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// ticketToken.ts's background-refresh path calls supabase.rpc — stub the
// real module so importing this file never touches a real network client.
// vi.mock factories are hoisted above imports, so the mock fn itself must
// be created via vi.hoisted rather than a plain top-level const.
const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn(() => Promise.resolve({ data: null, error: null })) }));
vi.mock('./supabase', () => ({ supabase: { rpc: rpcMock } }));

import {
  cacheTicketToken,
  getCachedTicketToken,
  decodeTokenPayload,
  needsRefresh,
  ensureTicketToken,
  prefetchTicketTokens,
} from './ticketToken';

// Builds a syntactically-real v2 token (base64url payload + a throwaway
// signature) so decodeTokenPayload/needsRefresh can be exercised without a
// live signing secret — these two functions never verify the signature
// (they can't, the secret never reaches the client), only decode the
// payload for a client-side freshness decision.
function fakeToken(payload: Record<string, unknown>): string {
  const json = JSON.stringify(payload);
  const b64 = Buffer.from(json, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64}.deadbeef`;
}

describe('ticket token cache (offline-first)', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips a server-generated token synchronously', () => {
    cacheTicketToken('ticket-1', 'signed.token.value');
    expect(getCachedTicketToken('ticket-1')).toBe('signed.token.value');
  });

  it('persists to localStorage so the pass survives reloads / works offline', () => {
    cacheTicketToken('ticket-2', 'tok-2');
    const raw = localStorage.getItem('vents_ticket_token_cache_v2');
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw as string)['ticket-2']).toBe('tok-2');
  });

  it('returns null for an unknown ticket (no crash)', () => {
    expect(getCachedTicketToken('nope')).toBeNull();
    expect(getCachedTicketToken(null)).toBeNull();
    expect(getCachedTicketToken(undefined)).toBeNull();
  });

  it('ignores empty seeds — never caches a blank token', () => {
    cacheTicketToken('ticket-3', '');
    cacheTicketToken(null, 'x');
    expect(getCachedTicketToken('ticket-3')).toBeNull();
  });

  it('keeps multiple tickets independently (group purchase)', () => {
    cacheTicketToken('a', 'ta');
    cacheTicketToken('b', 'tb');
    expect(getCachedTicketToken('a')).toBe('ta');
    expect(getCachedTicketToken('b')).toBe('tb');
  });
});

describe('decodeTokenPayload', () => {
  it('decodes a real v2 token payload without needing the signing secret', () => {
    const token = fakeToken({ ticketId: 't-1', expiresAt: '2099-01-01T00:00:00Z', nonce: 'abc' });
    const payload = decodeTokenPayload(token);
    expect(payload).toEqual({ ticketId: 't-1', expiresAt: '2099-01-01T00:00:00Z', nonce: 'abc' });
  });

  it('returns null for null/undefined/empty input', () => {
    expect(decodeTokenPayload(null)).toBeNull();
    expect(decodeTokenPayload(undefined)).toBeNull();
    expect(decodeTokenPayload('')).toBeNull();
  });

  it('returns null for a garbage/legacy (bare-UUID) token instead of throwing', () => {
    expect(decodeTokenPayload('not-a-real-token')).toBeNull();
    expect(decodeTokenPayload('c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832')).toBeNull();
  });
});

describe('needsRefresh — the root-cause fix for the multiple-QR-flash bug', () => {
  it('is true for a missing token (nothing cached yet, must mint)', () => {
    expect(needsRefresh(null)).toBe(true);
    expect(needsRefresh(undefined)).toBe(true);
  });

  it('is true for an unparseable token (corrupt cache entry)', () => {
    expect(needsRefresh('garbage')).toBe(true);
  });

  it('is false for a token comfortably far from expiry — must NOT be re-minted', () => {
    const token = fakeToken({ ticketId: 't-1', expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString() });
    expect(needsRefresh(token)).toBe(false);
  });

  it('is true for a token within the refresh window of expiring', () => {
    const token = fakeToken({ ticketId: 't-1', expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() });
    expect(needsRefresh(token)).toBe(true);
  });

  it('is true for an already-expired token', () => {
    const token = fakeToken({ ticketId: 't-1', expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(needsRefresh(token)).toBe(true);
  });

  it('respects a custom minValidityMs window', () => {
    const token = fakeToken({ ticketId: 't-1', expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString() });
    expect(needsRefresh(token, 60 * 60 * 1000)).toBe(false); // 2h left, only need 1h
    expect(needsRefresh(token, 3 * 60 * 60 * 1000)).toBe(true); // 2h left, need 3h
  });
});

describe('ensureTicketToken', () => {
  beforeEach(() => { localStorage.clear(); rpcMock.mockClear(); });

  it('returns the cached token without minting when one already exists', async () => {
    cacheTicketToken('t-1', 'cached-token');
    const result = await ensureTicketToken('t-1');
    expect(result).toBe('cached-token');
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('mints and caches a token when none exists yet', async () => {
    rpcMock.mockResolvedValueOnce({ data: 'minted-token', error: null });
    const result = await ensureTicketToken('t-2');
    expect(result).toBe('minted-token');
    expect(getCachedTicketToken('t-2')).toBe('minted-token');
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });
});

describe('prefetchTicketTokens — a stale simultaneous mint must never replace a fresh cached token', () => {
  beforeEach(() => { localStorage.clear(); rpcMock.mockClear(); });
  afterEach(() => vi.useRealTimers());

  it('skips minting for a ticket whose cached token is comfortably valid', () => {
    const fresh = fakeToken({ ticketId: 't-1', expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString() });
    cacheTicketToken('t-1', fresh);
    prefetchTicketTokens(['t-1']);
    expect(rpcMock).not.toHaveBeenCalled();
    // The exact same value must still be the one displayed -- this is the
    // "one ticket -> one authoritative credential -> one displayed QR"
    // guarantee: a redundant background mint call never gets a chance to
    // silently swap it out.
    expect(getCachedTicketToken('t-1')).toBe(fresh);
  });

  it('mints for a ticket with no cached token at all', () => {
    prefetchTicketTokens(['t-2']);
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });

  it('mints for a ticket whose cached token is close to expiring', () => {
    const stale = fakeToken({ ticketId: 't-3', expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() });
    cacheTicketToken('t-3', stale);
    prefetchTicketTokens(['t-3']);
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });

  it('de-dupes repeated ids in one call', () => {
    prefetchTicketTokens(['t-4', 't-4', 't-4']);
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });
});
