import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Static-analysis tests (same approach as every other *.security.test.ts in
// this repo) for the VENTS AI service/provider search migration
// (0081_ai_service_search.sql).

let migration: string;

beforeAll(() => {
  const dir = join(__dirname, '..', '..', 'supabase', 'migrations');
  migration = readFileSync(join(dir, '0081_ai_service_search.sql'), 'utf8');
});

describe('search_services_fuzzy: same visibility floor as the existing Services screens', () => {
  it('is SECURITY DEFINER with search_path locked down', () => {
    const fn = migration.match(/CREATE OR REPLACE FUNCTION public\.search_services_fuzzy[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(fn).toMatch(/SECURITY DEFINER/);
    expect(fn).toMatch(/SET search_path TO ''/);
  });

  it('only ever returns an approved provider listing', () => {
    const fn = migration.match(/CREATE OR REPLACE FUNCTION public\.search_services_fuzzy[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(fn).toMatch(/sp\.status = 'approved'/);
  });

  it('only ever returns an active service', () => {
    const fn = migration.match(/CREATE OR REPLACE FUNCTION public\.search_services_fuzzy[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(fn).toMatch(/ps\.is_active = true/);
  });

  it('caps the result count regardless of what the caller asks for', () => {
    const fn = migration.match(/CREATE OR REPLACE FUNCTION public\.search_services_fuzzy[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(fn).toMatch(/LEAST\(GREATEST\(coalesce\(p_limit, 20\), 1\), 50\)/);
  });

  it('grants EXECUTE to anon and authenticated, matching 0011_grants.sql\'s pattern', () => {
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.search_services_fuzzy\(text, text, int\) FROM PUBLIC, project_admin;\nGRANT EXECUTE ON FUNCTION public\.search_services_fuzzy\(text, text, int\) TO anon, authenticated, project_admin;/
    );
  });
});
