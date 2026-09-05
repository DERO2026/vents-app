import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Same static-analysis approach as serviceProviderCapability.security.test.ts
// and ticketTransferFee.security.test.ts -- no live Postgres harness, so
// these assert the security/atomicity properties are actually encoded in
// the migration SQL that ships to production.

let sp044: string;
let sp033: string;

beforeAll(() => {
  const migrationsDir = join(__dirname, '..', '..', 'supabase', 'migrations');
  sp044 = readFileSync(join(migrationsDir, '0044_service_provider_kyc.sql'), 'utf8');
  sp033 = readFileSync(join(migrationsDir, '0033_service_provider_capability.sql'), 'utf8');
});

describe('service provider KYC (0044): submission requires auth + validates identity fields', () => {
  it('submit_service_provider_verification requires an authenticated caller', () => {
    expect(sp044).toMatch(/CREATE FUNCTION public\.submit_service_provider_verification/);
    expect(sp044).toMatch(/SECURITY DEFINER/);
    expect(sp044).toMatch(/IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;/);
  });

  it('a Nigerian individual submission enforces an 11-digit NIN format', () => {
    expect(sp044).toMatch(/IF trim\(p_identity_id_number\) !~ '\^\[0-9\]\{11\}\$' THEN RAISE EXCEPTION 'NIN must be 11 digits'; END IF;/);
  });

  it('a Nigerian business submission requires a CAC number', () => {
    expect(sp044).toMatch(/IF v_country = 'NG' THEN\s*\n\s*IF trim\(coalesce\(p_cac_number, ''\)\) = '' THEN RAISE EXCEPTION 'CAC number is required'; END IF;/);
  });

  it('anon cannot call the submit RPC directly', () => {
    const grantLine = sp044.match(/GRANT EXECUTE ON FUNCTION public\.submit_service_provider_verification[^;]*;/)?.[0] ?? '';
    expect(grantLine).toContain('authenticated');
    expect(grantLine).not.toContain('anon');
  });
});

describe('service provider KYC (0044): approval is atomic (request + capability + notification)', () => {
  it('admin_decide_service_provider_request gates on admin access', () => {
    expect(sp044).toMatch(/CREATE FUNCTION public\.admin_decide_service_provider_request/);
    expect(sp044).toMatch(/IF NOT public\.is_admin_or_root\(\) THEN RAISE EXCEPTION/);
  });

  it('approval grants is_service_provider AND inserts a notification in the same function', () => {
    const fnBody = sp044.match(/CREATE FUNCTION public\.admin_decide_service_provider_request[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(fnBody).toMatch(/UPDATE public\.users SET is_service_provider = true WHERE id = v_user_id;/);
    expect(fnBody).toMatch(/INSERT INTO public\.notifications/);
    expect(fnBody).toMatch(/INSERT INTO public\.admin_logs/);
  });

  it('anon cannot call the admin decision RPC directly', () => {
    const grantLine = sp044.match(/GRANT EXECUTE ON FUNCTION public\.admin_decide_service_provider_request[^;]*;/)?.[0] ?? '';
    expect(grantLine).toContain('authenticated');
    expect(grantLine).not.toContain('anon');
  });
});

describe('0044 does not touch the existing capability-protection trigger (0033)', () => {
  it('protect_capability_columns and its trigger are untouched by 0044', () => {
    expect(sp044).not.toMatch(/CREATE OR REPLACE FUNCTION public\.protect_capability_columns/);
    expect(sp044).not.toMatch(/DROP TRIGGER[^;]*trg_protect_capability_columns/);
    expect(sp033).toMatch(/CREATE TRIGGER trg_protect_capability_columns BEFORE UPDATE ON public\.users FOR EACH ROW EXECUTE FUNCTION public\.protect_capability_columns\(\);/);
  });
});
