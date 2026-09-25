import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Static-analysis tests (same approach as every other *.security.test.ts in
// this repo) for 0078_payment_request_viewer_role.sql.
//
// Scope note: this migration only redefines get_payment_request_details to
// tell the requester and the payer apart (and surface the requester's
// payer info/timestamps) -- it deliberately does NOT add a "send reminder"
// action, since no notification-sending path for payment request reminders
// exists anywhere in this schema and building one is out of scope here.

let m0078: string;

beforeAll(() => {
  const dir = join(__dirname, '..', '..', 'supabase', 'migrations');
  m0078 = readFileSync(join(dir, '0078_payment_request_viewer_role.sql'), 'utf8');
});

function detailsFn(): string {
  return m0078.match(/CREATE OR REPLACE FUNCTION public\.get_payment_request_details\(p_payment_ref text\)[\s\S]*?\$function\$;/)?.[0] ?? '';
}

describe('Redefines the real, existing get_payment_request_details RPC', () => {
  it('redefines the same function name/signature rather than introducing a new one', () => {
    expect(m0078).toMatch(/CREATE OR REPLACE FUNCTION public\.get_payment_request_details\(p_payment_ref text\)/);
    expect(m0078).not.toMatch(/CREATE OR REPLACE FUNCTION public\.get_payment_request_details_v2/);
  });

  it('keeps the same access-scoping WHERE clause -- only the caller who is the payer or the requester can ever see a row', () => {
    const fn = detailsFn();
    expect(fn).toMatch(/pp\.payer_id = \(SELECT auth\.uid\(\)\) OR pp\.user_id = \(SELECT auth\.uid\(\)\)/);
  });

  it('keeps SECURITY DEFINER + empty search_path (same hardening as the function it replaces)', () => {
    const fn = detailsFn();
    expect(fn).toMatch(/SECURITY DEFINER/);
    expect(fn).toMatch(/SET search_path TO ''/);
  });

  it('re-grants EXECUTE only to authenticated/project_admin, still revoked from anon/PUBLIC', () => {
    expect(m0078).toMatch(/REVOKE ALL ON FUNCTION public\.get_payment_request_details\(text\) FROM PUBLIC, anon, project_admin;/);
    expect(m0078).toMatch(/GRANT EXECUTE ON FUNCTION public\.get_payment_request_details\(text\) TO authenticated, project_admin;/);
  });

  it('computes viewer_is_requester server-side from auth.uid(), never trusting a client-supplied role', () => {
    const fn = detailsFn();
    expect(fn).toMatch(/pp\.user_id = \(SELECT auth\.uid\(\)\)\)/);
  });

  it('masks the payer\'s phone number rather than returning it raw', () => {
    const fn = detailsFn();
    expect(fn).toMatch(/payer_masked_phone/);
    expect(fn).toMatch(/'••••'/);
  });

  it('does not add any reminder-sending function or touch notifications -- out of scope for this fix', () => {
    expect(m0078).not.toMatch(/send_reminder/i);
    expect(m0078).not.toMatch(/INSERT INTO public\.notifications/);
  });

  it('does not touch cancel_payment_request or any other function in this file', () => {
    expect(m0078).not.toMatch(/CREATE OR REPLACE FUNCTION public\.cancel_payment_request/);
  });

  it('drops the old signature before redefining it (Postgres rejects a changed RETURNS TABLE column set otherwise) -- only for get_payment_request_details itself', () => {
    expect(m0078).toMatch(/DROP FUNCTION IF EXISTS public\.get_payment_request_details\(text\);/);
    expect(m0078).not.toMatch(/DROP FUNCTION IF EXISTS public\.cancel_payment_request/);
  });
});
