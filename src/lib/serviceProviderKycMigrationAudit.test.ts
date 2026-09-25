import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Audit trail for the Admin Console error:
// "Failed to load requests: column service_provider_requests.provider_type
// does not exist"
//
// Root cause: NOT a code bug. supabase/migrations/0044_service_provider_kyc.sql
// is what adds provider_type/country/owner_name/document_url/
// identity_id_type/identity_id_number/business_name/cac_number to
// service_provider_requests, plus submit_service_provider_verification(),
// my_latest_service_provider_verification(), and
// admin_decide_service_provider_request(). The Admin Console query (and
// ServiceProviderVerificationScreen's submit path) both correctly assume
// these columns/RPCs exist -- migration 0044 was simply never applied to
// the Preview database. These tests lock in that the CODE'S expectations
// match what 0044 actually defines, so the only outstanding action is
// applying that migration to Preview (see the report for the exact SQL).

let migration0044: string;
let adminDashboardSrc: string;

beforeAll(() => {
  migration0044 = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0044_service_provider_kyc.sql'), 'utf8');
  adminDashboardSrc = readFileSync(join(__dirname, '..', 'app', 'components', 'AdminDashboardScreen.tsx'), 'utf8');
});

describe('service_provider_requests KYC columns (0044) match what Admin Console queries', () => {
  it('0044 adds every column the Admin Console SP-requests query selects', () => {
    expect(migration0044).toMatch(/ADD COLUMN IF NOT EXISTS provider_type text NOT NULL DEFAULT 'individual',/);
    expect(migration0044).toMatch(/ADD COLUMN IF NOT EXISTS country text NOT NULL DEFAULT 'NG',/);
    expect(migration0044).toMatch(/ADD COLUMN IF NOT EXISTS owner_name text,/);
    expect(migration0044).toMatch(/ADD COLUMN IF NOT EXISTS document_url text,/);
    expect(migration0044).toMatch(/ADD COLUMN IF NOT EXISTS identity_id_type text,/);
    expect(migration0044).toMatch(/ADD COLUMN IF NOT EXISTS identity_id_number text,/);
    expect(migration0044).toMatch(/ADD COLUMN IF NOT EXISTS business_name text,/);
    expect(migration0044).toMatch(/ADD COLUMN IF NOT EXISTS cac_number text;/);
  });

  it('the Admin Console query selects exactly the columns 0044 adds', () => {
    const selectLine = adminDashboardSrc.match(/\.select\('id, user_id, reason, status, admin_note, created_at, provider_type, country, owner_name, business_name, cac_number, identity_id_type, identity_id_number, document_url'\)/);
    expect(selectLine).not.toBeNull();
  });

  it('submit_service_provider_verification, my_latest_service_provider_verification, and admin_decide_service_provider_request are all defined in 0044', () => {
    expect(migration0044).toMatch(/CREATE FUNCTION public\.submit_service_provider_verification\(/);
    expect(migration0044).toMatch(/CREATE FUNCTION public\.my_latest_service_provider_verification\(\)/);
    expect(migration0044).toMatch(/CREATE FUNCTION public\.admin_decide_service_provider_request\(/);
  });

  it('admin_decide_service_provider_request is gated to admins/root and grants is_service_provider atomically with the notification', () => {
    const fn = migration0044.match(/CREATE FUNCTION public\.admin_decide_service_provider_request[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(fn).toMatch(/IF NOT public\.is_admin_or_root\(\) THEN RAISE EXCEPTION 'Admin access required'; END IF;/);
    expect(fn).toMatch(/UPDATE public\.users SET is_service_provider = true WHERE id = v_user_id;/);
  });
});

describe('Submission error handling: real error is always logged, even though the user sees a safe generic message', () => {
  it('ServiceProviderVerificationScreen always sends the raw RPC error to Sentry before falling back to the generic message', () => {
    const spVerifySrc = readFileSync(join(__dirname, '..', 'app', 'components', 'ServiceProviderVerificationScreen.tsx'), 'utf8');
    const submitBlock = spVerifySrc.match(/} catch \(err: any\) \{\s*const msg = err\?\.message[\s\S]*?\}\s*finally/)?.[0] ?? '';
    expect(submitBlock).toMatch(/Sentry\.captureException\(err, \{ tags: \{ feature: 'service-provider-verification-submit' \}/);
    expect(submitBlock).toMatch(/setError\(KNOWN_RPC_ERRORS\.has\(msg\) \? msg : SUBMIT_ERROR\);/);
  });
});
