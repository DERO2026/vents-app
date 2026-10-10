import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Release blocker: VENTS AI's recommend_providers tool (and
// ServicesHomeScreen/HomeScreen's "Providers Near You" GPS path -- same
// RPC) failed on every call with real coordinates, surfacing as "Couldn't
// load providers near you." Root cause confirmed live against production
// (slrtjxtzhowhwhebjprv): get_nearby_service_providers() is deliberately
// SECURITY INVOKER (0115's own test, nearbyServiceProvidersCountryScope
// .security.test.ts, locks this in), but 0163_emergency_cost_hardening.sql
// added a `PERFORM check_rate_limit(...)` call inside it under the (for
// this function, false) assumption it ran as SECURITY DEFINER --
// check_rate_limit itself is only grantable to postgres/project_admin, so
// every real anon/authenticated caller hit a permission-denied error on
// the nested call, every single time, regardless of coordinates/category/
// distance.
//
// Fix: a narrow, zero-parameter SECURITY DEFINER wrapper
// (check_nearby_providers_rate_limit) takes over the one hardcoded
// rate-limit check, granted to anon/authenticated/project_admin --
// get_nearby_service_providers itself stays SECURITY INVOKER/RLS-respecting,
// unchanged from 0115's design. No live Postgres integration harness exists
// in this suite (same limitation as every other *.security.test.ts here);
// this locks in the fix statically. Live confirmation this session: calling
// get_nearby_service_providers as both `anon` and `authenticated` (via
// SET ROLE against the production database) now succeeds and returns rows,
// where before the fix both roles got a permission-denied error.

let sql: string;

beforeAll(() => {
  sql = readFileSync(
    join(__dirname, '..', '..', 'supabase', 'migrations', '0179_fix_nearby_providers_rate_limit_grant.sql'),
    'utf8'
  );
});

describe('0179_fix_nearby_providers_rate_limit_grant.sql', () => {
  it('adds a zero-parameter SECURITY DEFINER wrapper around the hardcoded global rate-limit check', () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.check_nearby_providers_rate_limit\(\)/);
    expect(sql).toMatch(/SECURITY DEFINER/);
    expect(sql).toMatch(/PERFORM public\.check_rate_limit\('nearby_providers_global', 1000, 60\);/);
  });

  it('never grants EXECUTE on the raw check_rate_limit primitive to anon/authenticated (narrow wrapper only, not a broad grant)', () => {
    expect(sql).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.check_rate_limit[^;]*TO[^;]*\b(anon|authenticated)\b/);
  });

  it('grants the new wrapper to exactly anon, authenticated, and project_admin -- matching get_nearby_service_providers own existing reachability, no wider', () => {
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.check_nearby_providers_rate_limit\(\) TO anon, authenticated, project_admin;/
    );
  });

  it('get_nearby_service_providers calls the new wrapper instead of check_rate_limit directly', () => {
    const fnStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.get_nearby_service_providers(');
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = sql.slice(fnStart);
    expect(fnBody).toMatch(/PERFORM public\.check_nearby_providers_rate_limit\(\);/);
    expect(fnBody).not.toMatch(/PERFORM public\.check_rate_limit\(/);
  });

  it("get_nearby_service_providers stays SECURITY INVOKER (no SECURITY DEFINER anywhere in its own definition) -- preserves 0115's RLS-respecting design", () => {
    const fnStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.get_nearby_service_providers(');
    const fnEnd = sql.indexOf('$function$;', fnStart) + '$function$;'.length;
    const fnDef = sql.slice(fnStart, fnEnd);
    expect(fnDef).not.toMatch(/SECURITY DEFINER/);
  });

  it('preserves every existing filter: approved-only, coordinates required, category, country, and distance ordering', () => {
    expect(sql).toMatch(/sp\.status = 'approved'/);
    expect(sql).toMatch(/sp\.latitude IS NOT NULL/);
    expect(sql).toMatch(/sp\.longitude IS NOT NULL/);
    expect(sql).toMatch(/p_category IS NULL OR EXISTS/);
    expect(sql).toMatch(/p_country IS NULL OR sp\.country = p_country/);
    expect(sql).toMatch(/ORDER BY scored\.distance_km ASC/);
  });

  it('re-grants get_nearby_service_providers to exactly anon, authenticated, project_admin -- unchanged reachability', () => {
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.get_nearby_service_providers\([^)]*\) TO anon, authenticated, project_admin;/
    );
  });
});
