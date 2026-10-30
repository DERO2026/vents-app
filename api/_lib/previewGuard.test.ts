import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';

// Postgres must never be reached from a blocked Preview: constructing a
// Pool is itself a failure.
const poolCtor = vi.fn();
vi.mock('pg', () => ({
  Pool: vi.fn().mockImplementation((...args: unknown[]) => {
    poolCtor(...args);
    return { query: vi.fn().mockResolvedValue({ rows: [{ result: null }] }) };
  }),
}));

import {
  previewBlockReason,
  supabaseRefFromUrl,
  supabaseRefFromDbUrl,
  assertPreviewSafe,
  PreviewBlockedError,
  PREVIEW_BLOCKED_MESSAGE,
  PRODUCTION_SUPABASE_REF,
} from './previewGuard';

const PROD_URL = `https://${PRODUCTION_SUPABASE_REF}.supabase.co`;
const OTHER_REF = 'abcdefghijklmnopqrst';
const OTHER_URL = `https://${OTHER_REF}.supabase.co`;
const SECRET_DB_PASSWORD = 'pw-must-never-leak';
const PROD_DB = `postgresql://project_admin.${PRODUCTION_SUPABASE_REF}:${SECRET_DB_PASSWORD}@aws-0-eu-central-1.pooler.supabase.com:5432/postgres`;
const OTHER_DB = `postgresql://project_admin.${OTHER_REF}:${SECRET_DB_PASSWORD}@aws-0-eu-central-1.pooler.supabase.com:5432/postgres`;

describe('previewBlockReason', () => {
  it('never blocks production, native or local builds', () => {
    for (const VERCEL_ENV of ['production', 'development', undefined]) {
      expect(previewBlockReason({ VERCEL_ENV, VITE_SUPABASE_URL: PROD_URL, PROJECT_ADMIN_DATABASE_URL: PROD_DB, PAYSTACK_SECRET_KEY: 'sk_live_x' })).toBeNull();
    }
  });

  it('blocks a Preview that uses the production project, or cannot show it does not (fail closed)', () => {
    const cases: [Record<string, string | undefined>, RegExp][] = [
      [{ VITE_SUPABASE_URL: PROD_URL }, /VITE_SUPABASE_URL is the production/],
      [{ VITE_SUPABASE_URL: '' }, /VITE_SUPABASE_URL is missing/],
      [{ VITE_SUPABASE_URL: 'https://example.com' }, /not a recognisable/],
      [{ VITE_SUPABASE_URL: OTHER_URL, PROJECT_ADMIN_DATABASE_URL: PROD_DB }, /PROJECT_ADMIN_DATABASE_URL is the production/],
      [{ VITE_SUPABASE_URL: OTHER_URL, PROJECT_ADMIN_DATABASE_URL: 'postgresql://u:p@localhost/db' }, /does not name a recognisable/],
      [{ VITE_SUPABASE_URL: OTHER_URL, PROJECT_ADMIN_DATABASE_URL: `postgresql://postgres:p@db.${'z'.repeat(20)}.supabase.co:5432/postgres` }, /different projects/],
      [{ VITE_SUPABASE_URL: OTHER_URL, PROJECT_ADMIN_DATABASE_URL: OTHER_DB, PAYSTACK_SECRET_KEY: 'sk_live_abc' }, /live key/],
    ];
    for (const [env, reason] of cases) {
      expect(previewBlockReason({ VERCEL_ENV: 'preview', ...env })).toMatch(reason);
    }
  });

  it('allows a Preview positively configured with another project and test keys', () => {
    expect(previewBlockReason({ VERCEL_ENV: 'preview', VITE_SUPABASE_URL: OTHER_URL, PROJECT_ADMIN_DATABASE_URL: OTHER_DB, PAYSTACK_SECRET_KEY: 'sk_test_abc' })).toBeNull();
  });

  it('reads the project ref from pooler and direct connection strings', () => {
    expect(supabaseRefFromUrl(PROD_URL)).toBe(PRODUCTION_SUPABASE_REF);
    expect(supabaseRefFromDbUrl(PROD_DB)).toBe(PRODUCTION_SUPABASE_REF);
    expect(supabaseRefFromDbUrl(`postgres://postgres:p@db.${OTHER_REF}.supabase.co:5432/postgres`)).toBe(OTHER_REF);
  });

  it('never puts a variable value in the error', () => {
    const err = (() => { try { assertPreviewSafe('x', { VERCEL_ENV: 'preview', VITE_SUPABASE_URL: OTHER_URL, PROJECT_ADMIN_DATABASE_URL: PROD_DB }); } catch (e) { return e as Error; } })()!;
    expect(err).toBeInstanceOf(PreviewBlockedError);
    expect(err.message).not.toContain(SECRET_DB_PASSWORD);
    expect(err.message).not.toContain(PROD_DB);
  });
});

// ---------------------------------------------------------------------------
// Every guarded entry point, on a Preview pointed at production.
// ---------------------------------------------------------------------------
const fetchSpy = vi.fn(async () => new Response('{}', { status: 401 }));
const savedEnv = { ...process.env };

function previewEnv(extra: Record<string, string> = {}) {
  Object.assign(process.env, {
    VERCEL_ENV: 'preview',
    VITE_SUPABASE_URL: PROD_URL,
    VITE_SUPABASE_ANON_KEY: 'anon-key',
    PROJECT_ADMIN_DATABASE_URL: PROD_DB,
    PAYSTACK_SECRET_KEY: 'sk_live_must_not_be_used',
    RESEND_API_KEY: 're_test',
    SENDCHAMP_API_KEY: 'sc_test',
    FCM_SERVICE_ACCOUNT_JSON: '{"project_id":"p","client_email":"e","private_key":"k"}',
    CRON_SECRET: 'cron',
    PUSH_WEBHOOK_SECRET: 'push',
    ANTHROPIC_API_KEY: 'sk-ant-test',
    ...extra,
  });
}

function mockReq(method: string, query: Record<string, string> = {}, body: unknown = {}) {
  const raw = Buffer.from(JSON.stringify(body));
  const req: any = Readable.from([raw]);
  Object.assign(req, {
    method, query, body,
    headers: { origin: 'https://getvents.com', authorization: 'Bearer cron', 'x-push-webhook-secret': 'push', 'x-paystack-signature': 'sig' },
  });
  return req;
}

function mockRes() {
  const res: any = { statusCode: 0, body: undefined, headers: {} as Record<string, string> };
  res.setHeader = (k: string, v: string) => { res.headers[k] = v; return res; };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  res.send = (b: unknown) => { res.body = b; return res; };
  res.end = () => res;
  return res;
}

const ENTRY_POINTS: [string, () => Promise<{ default: Function }>, string, Record<string, string>, unknown][] = [
  ['payment verification (tickets)', () => import('../webhook/paystack'), 'POST', { action: 'verify' }, { reference: 'r' }],
  ['wallet deposit verification', () => import('../webhook/paystack'), 'POST', { action: 'verify-deposit' }, { reference: 'r' }],
  ['Paystack webhook', () => import('../webhook/paystack'), 'POST', {}, { event: 'charge.success', data: { reference: 'r' } }],
  ['promotion activation', () => import('../promotions/activate'), 'POST', {}, { reference: 'r' }],
  ['payout action (transfers)', () => import('../wallet/admin-payout-action'), 'POST', {}, { requestId: 'x', action: 'approve' }],
  ['payout reconciliation', () => import('../wallet/reconcile-payouts'), 'POST', {}, {}],
  ['ticket refund', () => import('../wallet/refund-ticket'), 'POST', {}, { ticketId: 't' }],
  ['bank account save', () => import('../wallet/save-bank'), 'POST', {}, { account_number: '0000000000', bank_code: '058' }],
  ['bank account lookup', () => import('../wallet/resolve-account'), 'POST', {}, { account_number: '0000000000', bank_code: '058' }],
  ['push send', () => import('../push/send'), 'POST', {}, { userId: 'u' }],
  ['email/SMS notification', () => import('../notify/status-email'), 'POST', {}, { type: 'x' }],
  ['AI assistant and extraction', () => import('../extract-events'), 'POST', {}, { mode: 'ai_assistant', messages: [] }],
  ['cron run', () => import('../cron/run'), 'GET', {}, {}],
];

describe('every dangerous entry point refuses on a production-backed Preview', () => {
  beforeEach(() => {
    fetchSpy.mockClear();
    poolCtor.mockClear();
    vi.stubGlobal('fetch', fetchSpy);
    previewEnv();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...savedEnv };
  });

  for (const [name, load, method, query, body] of ENTRY_POINTS) {
    it(`${name}: 503, no external call, no database connection`, async () => {
      const res = mockRes();
      await (await load()).default(mockReq(method, query, body), res);
      expect(res.statusCode).toBe(503);
      expect(res.body).toEqual({ error: PREVIEW_BLOCKED_MESSAGE, preview_read_only: true });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(poolCtor).not.toHaveBeenCalled();
      expect(JSON.stringify(res.body)).not.toContain(SECRET_DB_PASSWORD);
    });
  }

  it('the privileged database helper refuses before opening a connection', async () => {
    const { callProjectAdminRpc, callProjectAdminTableRpc } = await import('./projectAdminDb');
    await expect(callProjectAdminRpc('confirm_wallet_deposit', ['r'])).rejects.toBeInstanceOf(PreviewBlockedError);
    await expect(callProjectAdminTableRpc('complete_organizer_payout', ['r'])).rejects.toBeInstanceOf(PreviewBlockedError);
    expect(poolCtor).not.toHaveBeenCalled();
  });

  it('email and push helpers send nothing', async () => {
    const { sendVerifyAccountEmail } = await import('./mailer');
    expect(await sendVerifyAccountEmail('someone@example.com', 'https://x')).toBe(false);
    const { deliverPendingPushesForUser } = await import('./pushDelivery');
    expect(await deliverPendingPushesForUser('u')).toEqual({ sent: 0, total: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(poolCtor).not.toHaveBeenCalled();
  });
});

describe('production behaviour is unchanged', () => {
  beforeEach(() => {
    fetchSpy.mockClear();
    vi.stubGlobal('fetch', fetchSpy);
    previewEnv({ VERCEL_ENV: 'production' });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...savedEnv };
  });

  it('a production request goes past the guard to the handler\'s own logic', async () => {
    // resolve-account's next step is checking the session with Supabase Auth
    // (mocked as 401 here), so reaching that call proves the guard let it through.
    const res = mockRes();
    await (await import('../wallet/resolve-account')).default(mockReq('POST', {}, { account_number: '0000000000', bank_code: '058' }), res);
    expect(res.statusCode).not.toBe(503);
    expect(fetchSpy).toHaveBeenCalled();
  });
});
