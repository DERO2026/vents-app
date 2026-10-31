import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The daily cron releases matured earnings holds (0203) through the
// privileged DB helper, before and independently of the push steps. No
// network: the DB helper is mocked and FCM is left unconfigured.

const adminRpc = vi.fn(async (..._args: unknown[]) => null as unknown);
vi.mock('./projectAdminDb', () => ({
  callProjectAdminRpc: (...a: unknown[]) => adminRpc(...a),
  callProjectAdminTableRpc: vi.fn(async () => []),
}));

const savedEnv = { ...process.env };
function mockRes() {
  const res: any = { statusCode: 0, body: undefined };
  res.setHeader = () => res;
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  return res;
}
async function run(auth = 'Bearer cron-secret') {
  const res = mockRes();
  await (await import('../cron/run')).default({ method: 'GET', headers: { authorization: auth }, query: {} } as any, res);
  return res;
}

beforeEach(() => {
  adminRpc.mockReset();
  Object.assign(process.env, { VERCEL_ENV: 'production', CRON_SECRET: 'cron-secret' });
  delete process.env.FCM_SERVICE_ACCOUNT_JSON;
});
afterEach(() => { process.env = { ...savedEnv }; });

describe('cron: earnings settlement', () => {
  it('releases matured holds through the server-only RPC and reports it', async () => {
    adminRpc.mockImplementation(async (fn: unknown) =>
      fn === 'release_matured_earnings' ? { wallets: 2, released_kobo: 1900000, recovered_kobo: 950000 } : 0);
    const res = await run();
    expect(adminRpc).toHaveBeenCalledWith('release_matured_earnings', [500]);
    expect(res.body.settlement).toEqual({ wallets: 2, released_kobo: 1900000, recovered_kobo: 950000 });
  });

  it('a failed release is reported and does not stop the other steps', async () => {
    adminRpc.mockImplementation(async (fn: unknown) => {
      if (fn === 'release_matured_earnings') throw new Error('function does not exist');
      return 3;
    });
    const res = await run();
    expect(res.statusCode).toBe(200);
    expect(res.body.settlement.error).toMatch(/earnings release failed/);
    expect(res.body.archived).toBe(3);
  });

  it('nothing runs without the cron secret', async () => {
    const res = await run('Bearer wrong');
    expect(res.statusCode).toBe(401);
    expect(adminRpc).not.toHaveBeenCalled();
  });

  it('nothing runs in a Vercel Preview (shares the production database)', async () => {
    process.env.VERCEL_ENV = 'preview';
    const res = await run();
    expect(adminRpc).not.toHaveBeenCalled();
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});
