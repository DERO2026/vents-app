import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
vi.mock('./supabase', () => ({ supabase: {} }));
import { classifySearchError, normalizeQuery } from './recruiterSearch';

// Migration 0204 (search_recruiter_invite_targets): static checks of the
// security properties. Real execution is covered by
// scripts/local-pg-test/run-recruiter-search-verification.sh.
let sql: string;
beforeAll(() => {
  sql = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0204_search_recruiter_invite_targets.sql'), 'utf8');
});

describe('0204 search_recruiter_invite_targets', () => {
  it('is authenticated-only', () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.search_recruiter_invite_targets\(text\) FROM PUBLIC, anon;/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.search_recruiter_invite_targets\(text\) TO authenticated;/);
    expect(sql).toMatch(/IF v_uid IS NULL THEN\s*\n\s*RAISE EXCEPTION 'Not authenticated';/);
  });

  it('is limited to active representatives', () => {
    expect(sql).toMatch(/public\.recruiters r WHERE r\.id = v_uid AND r\.status = 'active'/);
  });

  it('is SECURITY DEFINER with an empty search_path', () => {
    expect(sql).toMatch(/SECURITY DEFINER\s*\n\s*SET search_path TO ''/);
  });

  it('has its own rate-limit bucket, separate from checkout search', () => {
    expect(sql).toMatch(/check_rate_limit\('recruiter_search:' \|\| v_uid::text, 60, 60\)/);
  });

  it('escapes LIKE wildcards in user input', () => {
    expect(sql).toMatch(/replace\(replace\(replace\(v_query, '\\', '\\\\'\), '%', '\\%'\), '_', '\\_'\)/);
    expect(sql).toMatch(/ESCAPE '\\'/);
  });

  it('returns only invitable users, excluding the caller and deleted accounts', () => {
    expect(sql).toMatch(/WHERE c\.is_org OR c\.provider_id IS NOT NULL/);
    expect(sql).toMatch(/sp\.status = 'approved'/);
    expect(sql).toMatch(/u\.deleted_at IS NULL/);
    expect(sql).toMatch(/u\.id <> v_uid/);
  });

  it('never returns email or phone', () => {
    const returns = sql.match(/RETURNS TABLE\(([\s\S]*?)\)\s*\nLANGUAGE/)?.[1] ?? '';
    expect(returns).not.toMatch(/email|phone/);
  });

  it('does not modify search_users_for_request or any financial function', () => {
    expect(sql).not.toMatch(/FUNCTION public\.search_users_for_request/);
    const code = sql.replace(/--.*$/gm, '');
    expect(code).not.toMatch(/wallet|payout|payment|refund|ticket/i);
  });
});

describe('recruiterSearch client helpers', () => {
  it('normalizes a leading @ and whitespace', () => {
    expect(normalizeQuery('  @@ade ')).toBe('ade');
  });

  it('classifies errors so none is shown as an empty result', () => {
    expect(classifySearchError({ code: 'P0429', message: 'rate_limited' }).kind).toBe('rate_limited');
    expect(classifySearchError({ code: 'PREVIEW_READ_ONLY', message: 'x' }).kind).toBe('preview');
    expect(classifySearchError({ message: 'Only active representatives can search for partners' }).kind).toBe('not_representative');
    expect(classifySearchError(new TypeError('Failed to fetch')).kind).toBe('network');
    expect(classifySearchError({ message: 'boom' }).kind).toBe('unknown');
  });
});
