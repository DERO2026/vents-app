import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Static-analysis test for 0120_revoke_anon_on_maker_checker_rpcs.sql.
//
// Admin Console security audit found request_admin_action/approve_admin_
// action/reject_admin_action had unnecessary EXECUTE grants to anon.
// Each function's body already rejects an unauthenticated caller
// (is_admin()/auth.uid()-based checks), so this was not independently
// exploitable, but granting EXECUTE to anon on privileged RPCs is
// inconsistent with every other admin_*/privileged function in this schema
// (all scoped to authenticated only) and relies entirely on the internal
// check never regressing. Verified live via information_schema.role_
// routine_grants: anon no longer appears for any of the three functions,
// authenticated still does.

let sql: string;

beforeAll(() => {
  sql = readFileSync(
    join(__dirname, '../../supabase/migrations/0120_revoke_anon_on_maker_checker_rpcs.sql'),
    'utf8'
  );
});

describe('0120_revoke_anon_on_maker_checker_rpcs.sql', () => {
  it('revokes anon EXECUTE on all three maker-checker RPCs with the correct signatures', () => {
    expect(sql).toMatch(
      /REVOKE EXECUTE ON FUNCTION public\.request_admin_action\(text, text, uuid, text, jsonb, jsonb, jsonb, text\) FROM anon/
    );
    expect(sql).toMatch(/REVOKE EXECUTE ON FUNCTION public\.approve_admin_action\(uuid\) FROM anon/);
    expect(sql).toMatch(/REVOKE EXECUTE ON FUNCTION public\.reject_admin_action\(uuid, text\) FROM anon/);
  });

  it('does not touch the authenticated grant (the legitimate admin workflow must keep working)', () => {
    expect(sql).not.toMatch(/FROM authenticated/);
  });
});
