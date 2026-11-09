import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 0211: changing / resetting the withdrawal PIN goes through save-bank's
// existing password re-confirmation and rate limit, then calls
// reset_my_withdrawal_pin with the FRESH session that password produced
// (the database also refuses unless the password was entered seconds ago).
// The PIN is never echoed back.

const { mockVerify, mockConfirmPassword, mockRateLimit } = vi.hoisted(() => ({
  mockVerify: vi.fn(),
  mockConfirmPassword: vi.fn(),
  mockRateLimit: vi.fn(),
}));
vi.mock('./verifyAuth.js', () => ({
  verifyInsforgeSession: mockVerify,
  confirmPassword: mockConfirmPassword,
  enforceWalletRateLimit: mockRateLimit,
}));
vi.mock('./cors.js', () => ({ applyCors: vi.fn() }));
vi.mock('./previewGuard.js', () => ({ refuseInPreview: () => false }));

import handler from '../wallet/save-bank';

function makeRes() {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.end = vi.fn(() => res);
  res.setHeader = vi.fn();
  return res;
}
const req = (body: any) => ({ method: 'POST', headers: { authorization: 'Bearer session-tok' }, body } as any);

let fetchMock: any;
beforeEach(() => {
  process.env.VITE_SUPABASE_URL = 'https://db.example.test';
  process.env.VITE_SUPABASE_ANON_KEY = 'anon';
  mockVerify.mockResolvedValue({ userId: 'u1', email: 'u1@example.test' });
  mockRateLimit.mockResolvedValue(true);
  mockConfirmPassword.mockResolvedValue('fresh-password-tok');
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ has_pin: true, locked: false, withdrawals_paused_until: '2026-11-10T12:00:00Z' }) }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('save-bank: reset_withdrawal_pin', () => {
  it('a wrong password is refused before anything reaches the database', async () => {
    mockConfirmPassword.mockResolvedValue(null);
    const res = makeRes();
    await handler(req({ action: 'reset_withdrawal_pin', password: 'wrong', pin: '5820', pin_confirm: '5820' }), res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the rate limit applies before the password is even checked', async () => {
    mockRateLimit.mockResolvedValue(false);
    const res = makeRes();
    await handler(req({ action: 'reset_withdrawal_pin', password: 'pw', pin: '5820', pin_confirm: '5820' }), res);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(mockConfirmPassword).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a malformed PIN is refused without a database call', async () => {
    const res = makeRes();
    await handler(req({ action: 'reset_withdrawal_pin', password: 'pw', pin: '58a0', pin_confirm: '58a0' }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('calls reset_my_withdrawal_pin with the fresh password session, never the caller\'s token', async () => {
    const res = makeRes();
    await handler(req({ action: 'reset_withdrawal_pin', password: 'pw', pin: '5820', pin_confirm: '5820' }), res);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://db.example.test/rest/v1/rpc/reset_my_withdrawal_pin');
    expect(init.headers.Authorization).toBe('Bearer fresh-password-tok');
    expect(JSON.parse(init.body)).toEqual({ p_pin: '5820', p_pin_confirm: '5820' });
    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(JSON.stringify(body)).not.toContain('5820');
    expect(body.pin_status.withdrawals_paused_until).toBe('2026-11-10T12:00:00Z');
  });

  it('a database refusal (weak PIN, stale password) comes back as an error, not success', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ message: 'That PIN is too easy to guess (like 1111, 1234 or 1212). Choose another' }) });
    const res = makeRes();
    await handler(req({ action: 'reset_withdrawal_pin', password: 'pw', pin: '1234', pin_confirm: '1234' }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error).toMatch(/too easy to guess/);
  });
});
