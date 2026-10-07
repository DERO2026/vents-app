import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Phase 2 cost-hardening: get_nearby_service_providers and
// search_services_fuzzy are pure Postgres RPCs with no TypeScript wrapper
// to unit-test the way the AI/upload paths can be -- this repo has no live
// Postgres harness (same limitation documented in
// pushDeliveryDbTrigger.test.ts). These are static-analysis tests proving
// the SQL that was actually applied to production (confirmed live via
// Supabase execute_sql in this session: both functions' rate-limit PERFORM
// calls and the five new indexes all exist) matches what's committed here,
// so "100 repeated calls get rate-limited" and "the search scan has a
// supporting index" are asserted at the source level, not simulated.
//
// This does NOT prove runtime behavior under real concurrent load --
// that would need a live Postgres integration harness this repo doesn't
// have. What it proves: the rate-limit call and the indexes are present
// in the exact migration that was applied, so a future edit that
// accidentally removes either is caught here.

let round1: string;
let round2: string;

beforeAll(() => {
  round1 = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0163_emergency_cost_hardening.sql'), 'utf8');
  round2 = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0164_cost_hardening_round2.sql'), 'utf8');
});

describe('get_nearby_service_providers: rate limit + supporting index', () => {
  it('calls check_rate_limit with a real, finite global ceiling before doing any work', () => {
    const start = round1.indexOf('CREATE OR REPLACE FUNCTION public.get_nearby_service_providers');
    const end = round1.indexOf('CREATE OR REPLACE FUNCTION public.search_services_fuzzy');
    const fn = round1.slice(start, end);
    expect(fn).toMatch(/PERFORM public\.check_rate_limit\('nearby_providers_global',\s*1000,\s*60\)/);
    // The rate-limit call must come before the RETURN QUERY that does the
    // actual (expensive, Haversine) work.
    expect(fn.indexOf('check_rate_limit')).toBeLessThan(fn.indexOf('RETURN QUERY'));
  });

  it('preserves the 100km default radius cap and the real lat/lng parameters -- no behavior change', () => {
    const start = round1.indexOf('CREATE OR REPLACE FUNCTION public.get_nearby_service_providers');
    const end = round1.indexOf('CREATE OR REPLACE FUNCTION public.search_services_fuzzy');
    const fn = round1.slice(start, end);
    expect(fn).toMatch(/p_max_distance_km double precision DEFAULT 100/);
    expect(fn).toMatch(/p_lat double precision/);
    expect(fn).toMatch(/p_lng double precision/);
  });

  it('round 2 adds a supporting partial index for the approved+geocoded filter, without touching the function itself', () => {
    expect(round2).toMatch(/CREATE INDEX IF NOT EXISTS idx_service_providers_approved_geocoded\s*\n\s*ON public\.service_providers \(country\)\s*\n\s*WHERE status = 'approved' AND latitude IS NOT NULL AND longitude IS NOT NULL;/);
    // Round 2 must not redefine the function -- confirms this was a
    // pure index addition, not a schema rewrite.
    expect(round2).not.toMatch(/CREATE OR REPLACE FUNCTION public\.get_nearby_service_providers/);
  });
});

describe('search_services_fuzzy: rate limit + supporting trigram indexes', () => {
  it('calls check_rate_limit with a real, finite global ceiling before doing any work', () => {
    const start = round1.indexOf('CREATE OR REPLACE FUNCTION public.search_services_fuzzy');
    const fn = round1.slice(start);
    expect(fn).toMatch(/PERFORM public\.check_rate_limit\('search_services_fuzzy_global',\s*1000,\s*60\)/);
    expect(fn.indexOf('check_rate_limit')).toBeLessThan(fn.indexOf('RETURN QUERY'));
  });

  it('round 2 adds GIN trigram indexes on every column the function actually scans, without touching the function itself', () => {
    expect(round2).toMatch(/CREATE INDEX IF NOT EXISTS idx_provider_services_name_trgm ON public\.provider_services USING gin \(name gin_trgm_ops\);/);
    expect(round2).toMatch(/CREATE INDEX IF NOT EXISTS idx_provider_services_description_trgm ON public\.provider_services USING gin \(description gin_trgm_ops\);/);
    expect(round2).toMatch(/CREATE INDEX IF NOT EXISTS idx_service_providers_business_name_trgm ON public\.service_providers USING gin \(business_name gin_trgm_ops\);/);
    expect(round2).toMatch(/CREATE INDEX IF NOT EXISTS idx_service_providers_description_trgm ON public\.service_providers USING gin \(description gin_trgm_ops\);/);
    expect(round2).not.toMatch(/CREATE OR REPLACE FUNCTION public\.search_services_fuzzy/);
  });

  it('the result-count clamp (max 50) is unchanged', () => {
    expect(round1).toMatch(/LIMIT LEAST\(GREATEST\(coalesce\(p_limit, 20\), 1\), 50\)/);
  });
});
