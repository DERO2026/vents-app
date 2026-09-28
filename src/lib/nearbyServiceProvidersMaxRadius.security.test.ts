import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Static-analysis test for 0117_nearby_service_providers_max_radius.sql.
//
// Bug found during the GPS/Near You real-device verification pass:
// get_nearby_service_providers() sorted every geocoded, in-country provider
// by distance and returned the nearest N regardless of how far away the
// nearest one actually was -- with few providers geocoded near a given
// user, this could return someone hundreds of km away under a "Near You"
// heading, and ServiceProviderCard never renders distance_km, so nothing
// in the UI would reveal that it wasn't actually nearby. This migration
// adds an actual radius cutoff.

let sql: string;

beforeAll(() => {
  sql = readFileSync(
    join(__dirname, '../../supabase/migrations/0117_nearby_service_providers_max_radius.sql'),
    'utf8'
  );
});

describe('0117_nearby_service_providers_max_radius.sql', () => {
  it('adds p_max_distance_km as a new parameter, defaulting to 100km', () => {
    expect(sql).toMatch(/p_max_distance_km\s+double precision\s+DEFAULT\s+100/i);
  });

  it('filters the scored rows by the radius before applying LIMIT', () => {
    expect(sql).toMatch(/WHERE p_max_distance_km IS NULL OR scored\.distance_km <= p_max_distance_km/);
    // The radius filter must come from a subquery over the already-scored
    // distance, not be applied before distance_km is computed.
    expect(sql.indexOf('AS distance_km')).toBeLessThan(sql.indexOf('p_max_distance_km IS NULL OR'));
  });

  it('preserves the existing status/coordinate/category/country filters', () => {
    expect(sql).toMatch(/sp\.status = 'approved'/);
    expect(sql).toMatch(/sp\.latitude IS NOT NULL/);
    expect(sql).toMatch(/sp\.longitude IS NOT NULL/);
    expect(sql).toMatch(/p_category IS NULL OR EXISTS/);
    expect(sql).toMatch(/p_country IS NULL OR sp\.country = p_country/);
  });

  it('preserves distance ordering and the not-SECURITY-DEFINER execution model', () => {
    expect(sql).toMatch(/ORDER BY scored\.distance_km ASC/);
    expect(sql).not.toMatch(/SECURITY DEFINER/i);
  });

  it('drops the old 5-arg overload so PostgREST has exactly one unambiguous signature', () => {
    expect(sql).toMatch(
      /DROP FUNCTION IF EXISTS public\.get_nearby_service_providers\(double precision, double precision, text, integer, text\)/
    );
  });

  it('re-grants execute on the new 6-arg signature to anon, authenticated, and project_admin only', () => {
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.get_nearby_service_providers\(double precision, double precision, text, integer, text, double precision\) TO anon, authenticated, project_admin/
    );
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.get_nearby_service_providers\(double precision, double precision, text, integer, text, double precision\) FROM PUBLIC/
    );
  });
});
