import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Static-analysis test for the MEDIUM #1 fix in api/webhook/paystack.ts.
//
// Master security audit (MEDIUM #1): the two client-triggered Paystack
// verify endpoints (?action=verify and ?action=verify-deposit) each call
// out to Paystack's own verify API and one or more admin-privileged RPCs
// on every request, gated only by authentication -- no rate limit. An
// authenticated caller could hammer either endpoint in a loop.
//
// Fix: both handlers now call enforceRateLimit (the same helper
// api/_lib/aiAssistantHandler.ts already uses to gate a paid/privileged
// endpoint), keyed per-user, 30/hour, immediately after authentication and
// before any Paystack call or RPC runs, returning 429 when exceeded.

let source: string;

beforeAll(() => {
  source = readFileSync(join(__dirname, '..', '..', 'api', 'webhook', 'paystack.ts'), 'utf8');
});

function handlerBody(name: string): string {
  const start = source.indexOf(`async function ${name}(`);
  const nextFn = source.indexOf('\nasync function ', start + 1);
  return source.slice(start, nextFn === -1 ? undefined : nextFn);
}

describe('Rate-limits the Paystack client-verify endpoints', () => {
  it('imports enforceRateLimit', () => {
    expect(source).toMatch(/import \{ verifyInsforgeSession, enforceRateLimit \} from '\.\.\/_lib\/verifyAuth\.js';/);
  });

  it('handleClientVerify checks the rate limit after auth, before the Paystack call', () => {
    const fn = handlerBody('handleClientVerify');
    const authIdx = fn.indexOf("if (!session) return res.status(401)");
    const rlIdx = fn.indexOf('enforceRateLimit(String(req.headers.authorization)');
    const fetchIdx = fn.indexOf("fetch(`https://api.paystack.co/transaction/verify/");
    expect(authIdx).toBeGreaterThan(-1);
    expect(rlIdx).toBeGreaterThan(authIdx);
    expect(fetchIdx).toBeGreaterThan(rlIdx);
    expect(fn).toMatch(/if \(!rateOk\) return res\.status\(429\)/);
  });

  it('handleClientVerifyDeposit checks the rate limit after auth, before the Paystack call', () => {
    const fn = handlerBody('handleClientVerifyDeposit');
    const authIdx = fn.indexOf("if (!session) return res.status(401)");
    const rlIdx = fn.indexOf('enforceRateLimit(String(req.headers.authorization)');
    const fetchIdx = fn.indexOf("fetch(`https://api.paystack.co/transaction/verify/");
    expect(authIdx).toBeGreaterThan(-1);
    expect(rlIdx).toBeGreaterThan(authIdx);
    expect(fetchIdx).toBeGreaterThan(rlIdx);
    expect(fn).toMatch(/if \(!rateOk\) return res\.status\(429\)/);
  });

  it('keys the two endpoints separately and per-user, not a single shared key', () => {
    expect(source).toMatch(/`paystack_verify:\$\{session\.userId\}`/);
    expect(source).toMatch(/`paystack_verify_deposit:\$\{session\.userId\}`/);
  });
});
