import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// cancel_my_ai_subscription() (0177_ai_subscription_self_cancellation.sql)
// -- static-analysis coverage, same limitation/pattern as
// aiSubscriptionFoundation.security.test.ts (no live Postgres harness
// here). Live-DB verification for this function was done directly against
// the production project in rolled-back transactions during development
// (never left residual data) -- this test instead locks in the specific
// properties a future edit could silently break: no anon access, scoped
// to auth.uid() only (never a client-supplied user id), idempotent, and
// never touches has_ai_chat_access()/check_and_reserve_ai_usage() (the two
// live gating functions this migration's own comment explains must not be
// widened to invent a new status).

let sql: string;

beforeAll(() => {
  sql = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0177_ai_subscription_self_cancellation.sql'), 'utf8');
});

function fnBody(): string {
  const marker = 'CREATE OR REPLACE FUNCTION public.cancel_my_ai_subscription()';
  const start = sql.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const end = sql.indexOf('\n$function$;', start);
  return sql.slice(start, end);
}

describe('cancel_my_ai_subscription: self-scoped, never client-arguable', () => {
  it('takes no arguments at all -- there is no parameter a client could use to act on someone else\'s row', () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.cancel_my_ai_subscription\(\)/);
  });

  it('reads/writes only auth.uid()\'s own row, never a client-supplied id', () => {
    const fn = fnBody();
    expect(fn).toMatch(/WHERE user_id = auth\.uid\(\)/);
    expect(fn).not.toMatch(/p_user_id/);
  });

  it('is granted to authenticated but never anon or PUBLIC', () => {
    const revoke = sql.match(/REVOKE ALL ON FUNCTION public\.cancel_my_ai_subscription\(\)[^;]*;/)?.[0] ?? '';
    const grant = sql.match(/GRANT EXECUTE ON FUNCTION public\.cancel_my_ai_subscription\(\)[^;]*;/)?.[0] ?? '';
    expect(revoke).toMatch(/PUBLIC/);
    expect(revoke).toMatch(/anon/);
    expect(grant).toMatch(/authenticated/);
  });

  it('is idempotent -- a repeat call returns already_canceled rather than erroring or re-logging', () => {
    const fn = fnBody();
    expect(fn).toMatch(/already_canceled/);
    expect(fn).toMatch(/IN \('canceled', 'inactive', 'expired'\)/);
  });

  it('locks the row before reading it (FOR UPDATE), consistent with every other entitlement writer in this schema', () => {
    const fn = fnBody();
    expect(fn).toMatch(/FOR UPDATE/);
  });

  it('logs the cancellation to admin_logs for the same audit trail every other entitlement write uses', () => {
    const fn = fnBody();
    expect(fn).toMatch(/INSERT INTO public\.admin_logs/);
    expect(fn).toMatch(/ai_subscription_self_cancelled/);
  });

  it('does not modify has_ai_chat_access or check_and_reserve_ai_usage -- cancellation never widens the live gating functions', () => {
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION public\.has_ai_chat_access/);
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION public\.check_and_reserve_ai_usage/);
  });
});
