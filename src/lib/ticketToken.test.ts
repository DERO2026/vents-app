import { describe, it, expect, beforeEach, vi } from 'vitest';

// insforge is only touched by the network refresh path, which these tests don't
// exercise — stub it so importing the module never hits the real client.
vi.mock('./insforge', () => ({ insforge: { database: { rpc: vi.fn(() => Promise.resolve({ data: null, error: null })) } } }));

import { cacheTicketToken, getCachedTicketToken } from './ticketToken';

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
