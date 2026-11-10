import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 0213: creating / changing / resetting the VENTS Admin Payout PIN goes
// through save-bank's password re-confirmation and rate limit, then calls
// admin_set_payout_pin with the FRESH session that password produced. The
// database refuses anyone but the VENTS Admin and any password older than
// 5 minutes. The PIN is never echoed back.

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

describe('save-bank: set_admin_payout_pin', () => {
  const ok = { action: 'set_admin_payout_pin', password: 'pw', pin: '4826193057', pin_confirm: '4826193057' };

  it('a wrong password is refused before anything reaches the database', async () => {
    mockConfirmPassword.mockResolvedValue(null);
    const res = makeRes();
    await handler(req({ ...ok, password: 'wrong' }), res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the rate limit applies before the password is checked', async () => {
    mockRateLimit.mockResolvedValue(false);
    const res = makeRes();
    await handler(req(ok), res);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(mockConfirmPassword).not.toHaveBeenCalled();
  });

  it('anything but exactly 10 digits is refused without a database call', async () => {
    for (const pin of ['482619305', '48261930571', '48261930a7', '']) {
      const res = makeRes();
      await handler(req({ ...ok, pin, pin_confirm: pin }), res);
      expect(res.status).toHaveBeenCalledWith(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('calls admin_set_payout_pin with the fresh password session and never echoes the PIN', async () => {
    fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ has_pin: true, locked: false }) }));
    vi.stubGlobal('fetch', fetchMock);
    const res = makeRes();
    await handler(req(ok), res);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://db.example.test/rest/v1/rpc/admin_set_payout_pin');
    expect(init.headers.Authorization).toBe('Bearer fresh-password-tok');
    expect(JSON.parse(init.body)).toEqual({ p_pin: '4826193057', p_pin_confirm: '4826193057' });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(JSON.stringify(res.json.mock.calls[0][0])).not.toContain('4826193057');
  });

  it('a refusal from the database (not the VENTS Admin) is passed on', async () => {
    fetchMock = vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ message: 'VENTS Admin access required' }) }));
    vi.stubGlobal('fetch', fetchMock);
    const res = makeRes();
    await handler(req(ok), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error).toMatch(/VENTS Admin access required/);
  });
});
