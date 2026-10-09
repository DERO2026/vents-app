import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Audit finding F23 (MASTER_AUDIT.md), surfaced while reviewing F21's own
// drafted backfill: list_service_provider_capability_desync() (migration
// 0053) is LANGUAGE sql with no internal role check, confirmed live to be
// callable by any `authenticated` user, not just an admin
// (has_function_privilege('authenticated', ..., 'EXECUTE') = true). Its own
// sibling, backfill_service_provider_capability_desync(), already correctly
// checks is_admin() -- only the read-only list side was missing the
// equivalent guard.
//
// This drafted fix (0173_fix_list_service_provider_capability_desync_
// authorization.sql, NOT applied to production) converts the function to
// plpgsql with an explicit is_admin() check, matching its sibling exactly.
// No legitimate call site exists anywhere in src/ or api/ -- confirmed by
// grep -- so this cannot break any Admin Console workflow.

let m0173: string;

beforeAll(() => {
  const dir = join(__dirname, '..', '..', 'supabase', 'migrations');
  m0173 = readFileSync(join(dir, '0173_fix_list_service_provider_capability_desync_authorization.sql'), 'utf8');
});

describe('0173: list_service_provider_capability_desync is actually admin-gated, not just by its grant', () => {
  it('is LANGUAGE plpgsql with an explicit is_admin() check', () => {
    const fn = m0173.match(/CREATE OR REPLACE FUNCTION public\.list_service_provider_capability_desync[\s\S]*?\$function\$;/)?.[0] ?? '';
    expect(fn).toMatch(/LANGUAGE plpgsql/);
    expect(fn).toMatch(/STABLE SECURITY DEFINER/);
    expect(fn).toMatch(/IF NOT public\.is_admin\(\) THEN/);
    expect(fn).toMatch(/RAISE EXCEPTION 'Admin access required';/);
  });

  it('the underlying desync query is completely unchanged from the original 0053 definition', () => {
    expect(m0173).toMatch(
      /SELECT u\.id, r\.id, r\.status, u\.is_service_provider, r\.reviewed_at\s*\n\s*FROM public\.service_provider_requests r\s*\n\s*JOIN public\.users u ON u\.id = r\.user_id\s*\n\s*WHERE r\.status = 'approved' AND u\.is_service_provider = false;/
    );
  });

  it('matches the gate level of its own sibling apply function (is_admin, not is_super_admin/is_root)', () => {
    const fn = m0173.match(/CREATE OR REPLACE FUNCTION public\.list_service_provider_capability_desync[\s\S]*?\$function\$;/)?.[0] ?? '';
    expect(fn).not.toMatch(/is_super_admin|is_root/);
  });

  it('keeps the same return shape -- a pure authorization fix, not a data-shape change', () => {
    expect(m0173).toMatch(
      /RETURNS TABLE\(user_id uuid, request_id uuid, request_status text, is_service_provider boolean, approved_at timestamptz\)/
    );
  });
});
