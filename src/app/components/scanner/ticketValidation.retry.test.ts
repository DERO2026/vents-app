import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Regression tests for the scanner-timeout auto-retry LOW-severity fix:
// a transient timeout/network failure at a busy gate used to surface
// "OFFLINE — RETRY" / "CONNECTION SLOW" on the very first hiccup, requiring
// a manual rescan. One automatic retry (after a short backoff) now covers
// that case before asking a human to intervene -- but must NEVER retry a
// real server response (a denial, an already-scanned duplicate, a
// business-rule exception), since those aren't transient failures at all.

const rpcMock = vi.fn();
vi.mock('../../../lib/supabase', () => ({
  supabase: { rpc: (...args: any[]) => rpcMock(...args) },
}));
vi.mock('../../../lib/ticketCode', () => ({
  parseTicketDisplayCode: (code: string) => (code === 'VALID-CODE' ? 'ticket-uuid-1' : null),
}));

let validateTicket: typeof import('./ticketValidation').validateTicket;
let validateManualCode: typeof import('./ticketValidation').validateManualCode;

beforeEach(async () => {
  vi.resetModules();
  rpcMock.mockReset();
  vi.useFakeTimers();
  const mod = await import('./ticketValidation');
  validateTicket = mod.validateTicket;
  validateManualCode = mod.validateManualCode;
});

afterEach(() => {
  vi.useRealTimers();
});

function neverResolves() {
  return new Promise(() => {});
}

describe('validateTicket: transient-failure auto-retry', () => {
  it('a clean success on the first attempt never retries', async () => {
    rpcMock.mockResolvedValueOnce({ data: { ok: true, holder_name: 'Jane Doe' }, error: null });

    const promise = validateTicket('valid.token', 'actor-1');
    const result = await promise;

    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('valid');
  });

  it('a timeout on the first attempt retries once and succeeds', async () => {
    rpcMock.mockReturnValueOnce(neverResolves()); // first call hangs forever
    rpcMock.mockResolvedValueOnce({ data: { ok: true, holder_name: 'Jane Doe' }, error: null });

    const promise = validateTicket('valid.token', 'actor-1');
    await vi.advanceTimersByTimeAsync(9000);  // clear VERIFY_TIMEOUT_MS on attempt 1
    await vi.advanceTimersByTimeAsync(400);   // clear the retry backoff
    const result = await promise;

    expect(rpcMock).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('valid');
  });

  it('a network-layer failure on the first attempt retries once and succeeds', async () => {
    const networkErr = new TypeError('Failed to fetch');
    rpcMock.mockRejectedValueOnce(networkErr);
    rpcMock.mockResolvedValueOnce({ data: { ok: true, holder_name: 'Jane Doe' }, error: null });

    const promise = validateTicket('valid.token', 'actor-1');
    await vi.advanceTimersByTimeAsync(400); // clear the retry backoff
    const result = await promise;

    expect(rpcMock).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('valid');
  });

  it('a real denial from the server on the first attempt is NEVER retried', async () => {
    rpcMock.mockResolvedValueOnce({ data: { ok: false, reason: 'expired', message: 'This pass has expired.' }, error: null });

    const result = await validateTicket('valid.token', 'actor-1');

    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('denied');
    expect(result.headline).toBe('EXPIRED TICKET');
  });

  it('an already-scanned duplicate on the first attempt is NEVER retried', async () => {
    rpcMock.mockResolvedValueOnce({ data: { ok: false, reason: 'already_scanned', checked_in_at: '2026-01-01T10:00:00Z' }, error: null });

    const result = await validateTicket('valid.token', 'actor-1');

    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('already_scanned');
  });

  it('both the first attempt and the single retry timing out surfaces exactly one "offline" outcome, not an infinite retry loop', async () => {
    rpcMock.mockReturnValueOnce(neverResolves());
    rpcMock.mockReturnValueOnce(neverResolves());

    const promise = validateTicket('valid.token', 'actor-1');
    await vi.advanceTimersByTimeAsync(9000); // attempt 1 times out
    await vi.advanceTimersByTimeAsync(400);  // retry backoff
    await vi.advanceTimersByTimeAsync(9000); // attempt 2 (the retry) also times out
    const result = await promise;

    expect(rpcMock).toHaveBeenCalledTimes(2); // exactly one retry, never more
    expect(result.status).toBe('offline');
    expect(result.headline).toBe('CONNECTION SLOW');
  });
});

describe('validateManualCode: transient-failure auto-retry', () => {
  it('a timeout on the first attempt retries once and succeeds', async () => {
    rpcMock.mockReturnValueOnce(neverResolves());
    rpcMock.mockResolvedValueOnce({ data: { ok: true, holder_name: 'Jane Doe' }, error: null });

    const promise = validateManualCode('VALID-CODE', 'actor-1');
    await vi.advanceTimersByTimeAsync(9000);
    await vi.advanceTimersByTimeAsync(400);
    const result = await promise;

    expect(rpcMock).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('valid');
  });

  it('a real denial is never retried', async () => {
    rpcMock.mockResolvedValueOnce({ data: { ok: false, reason: 'not_active', message: 'This ticket is cancelled.' }, error: null });

    const result = await validateManualCode('VALID-CODE', 'actor-1');

    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('denied');
  });
});
