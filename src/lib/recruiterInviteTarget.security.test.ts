import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Static checks for 0196_recruiter_invite_target_uses_organizer_capability.sql
// (same convention as ventsEarnFoundation.security.test.ts). Real execution
// against Postgres -- the dero regression, the negative cases and the
// preserved 0193 rules -- lives in
// scripts/local-pg-test/run-recruiter-invite-target-verification.sh.

let migration: string;
let migration0193: string;

beforeAll(() => {
  const dir = join(__dirname, '..', '..', 'supabase', 'migrations');
  migration = readFileSync(join(dir, '0196_recruiter_invite_target_uses_organizer_capability.sql'), 'utf8');
  migration0193 = readFileSync(join(dir, '0193_vents_earn_foundation.sql'), 'utf8');
});

function fn(source: string, name: string): string {
  return source.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\$function\\$\\s*;`))?.[0] ?? '';
}

describe('0196: organizer eligibility predicate', () => {
  it('honours the Admin-granted is_organizer capability for live accounts, and keeps the events-based rule', () => {
    const helper = fn(migration, 'recruiter_target_is_organizer');
    expect(helper).toMatch(/SECURITY DEFINER/);
    expect(helper).toMatch(/u\.is_organizer = true/);
    expect(helper).toMatch(/u\.deleted_at IS NULL/);
    expect(helper).toMatch(/FROM public\.events e WHERE e\.organizer_id = p_user_id/);
    // Admin-implicit organizer status is not an invitable organizer.
    expect(helper).not.toMatch(/role\s*=\s*'admin'/);
  });

  it('the internal helper is not directly callable by clients', () => {
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.recruiter_target_is_organizer\(uuid\) FROM PUBLIC, anon, authenticated;/);
  });
});

describe('0196: get_recruiter_invite_target', () => {
  it('requires authentication, uses the shared predicate, and only exposes an approved provider row', () => {
    const resolver = fn(migration, 'get_recruiter_invite_target');
    expect(resolver).toMatch(/SECURITY DEFINER/);
    expect(resolver).toMatch(/IF auth\.uid\(\) IS NULL THEN\s+RAISE EXCEPTION 'Not authenticated'/);
    expect(resolver).toMatch(/public\.recruiter_target_is_organizer\(p_user_id\)/);
    expect(resolver).toMatch(/sp\.user_id = p_user_id AND sp\.status = 'approved'/);
  });

  it('is executable by authenticated only', () => {
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.get_recruiter_invite_target\(uuid\) FROM PUBLIC, anon;/);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.get_recruiter_invite_target\(uuid\) TO authenticated;/);
  });
});

describe('0196: invite_recruiter_partnership', () => {
  it('differs from 0193 only in the organizer check, which now uses the shared predicate', () => {
    const next = fn(migration, 'invite_recruiter_partnership');
    const prev = fn(migration0193, 'invite_recruiter_partnership');
    expect(next).toMatch(/IF p_organizer_id IS NOT NULL AND NOT public\.recruiter_target_is_organizer\(p_organizer_id\) THEN\s+RAISE EXCEPTION 'Target organizer not found'/);
    const oldCheck = /IF p_organizer_id IS NOT NULL AND NOT EXISTS \(\s*SELECT 1 FROM public\.events e WHERE e\.organizer_id = p_organizer_id\s*\) THEN/;
    expect(prev).toMatch(oldCheck);
    expect(next.replace(/IF p_organizer_id IS NOT NULL AND NOT public\.recruiter_target_is_organizer\(p_organizer_id\) THEN/, 'CHECK'))
      .toBe(prev.replace(oldCheck, 'CHECK'));
  });

  it('keeps 0193 grants', () => {
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.invite_recruiter_partnership\(uuid, uuid, integer\) FROM PUBLIC, anon;/);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.invite_recruiter_partnership\(uuid, uuid, integer\) TO authenticated;/);
  });
});
