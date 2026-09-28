import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Static-analysis test for 0115_nearby_service_providers_country_scope.sql.
//
// Bug: get_nearby_service_providers() (the "Providers Near You" GPS path
// used by ServicesHomeScreen/HomeScreen) had no country parameter at all,
// so a user who explicitly selected a discovery country still saw another
// country's providers whenever GPS location was granted -- reproduced live
// via the Afghanistan-selected/Naira-priced-results screenshot. This
// migration adds an optional p_country filter so the frontend fix (passing
// the active discovery country through on every call) actually does
// something server-side.

let sql: string;

beforeAll(() => {
  sql = readFileSync(
    join(__dirname, '../../supabase/migrations/0115_nearby_service_providers_country_scope.sql'),
    'utf8'
  );
});

describe('0115_nearby_service_providers_country_scope.sql', () => {
  it('adds p_country as a new parameter, defaulting to NULL (backward compatible)', () => {
    expect(sql).toMatch(/p_country\s+text\s+DEFAULT\s+NULL/i);
  });

  it('filters rows by country only when p_country is provided', () => {
    expect(sql).toMatch(/p_country IS NULL OR sp\.country = p_country/);
  });

  it('preserves the existing status/coordinate/category filters (does not weaken discovery scope)', () => {
    expect(sql).toMatch(/sp\.status = 'approved'/);
    expect(sql).toMatch(/sp\.latitude IS NOT NULL/);
    expect(sql).toMatch(/sp\.longitude IS NOT NULL/);
    expect(sql).toMatch(/p_category IS NULL OR EXISTS/);
  });

  it('preserves distance ordering and the not-SECURITY-DEFINER, RLS-respecting execution model', () => {
    expect(sql).toMatch(/ORDER BY distance_km ASC/);
    expect(sql).not.toMatch(/SECURITY DEFINER/i);
  });

  it('drops the old 4-arg overload so PostgREST has exactly one unambiguous signature', () => {
    expect(sql).toMatch(
      /DROP FUNCTION IF EXISTS public\.get_nearby_service_providers\(double precision, double precision, text, integer\)/
    );
  });

  it('re-grants execute on the new 5-arg signature to anon, authenticated, and project_admin only', () => {
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.get_nearby_service_providers\(double precision, double precision, text, integer, text\) TO anon, authenticated, project_admin/
    );
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.get_nearby_service_providers\(double precision, double precision, text, integer, text\) FROM PUBLIC/
    );
  });
});
