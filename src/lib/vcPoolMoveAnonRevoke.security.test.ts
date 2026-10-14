import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// CRITICAL finding (surfaced during F15/F16/0170 review): _vc_pool_move has
// no internal authorization check at all, and anon has EXECUTE granted --
// confirmed live, a direct, unauthenticated financial-manipulation path
// into the VC system pool. NOT exercised against production -- this
// confirms the drafted migration's text only (static analysis), same
// approach as every other *.security.test.ts in this repo with no live
// Postgres connection. Migration 0173 is NOT YET APPLIED.

let sql: string;

beforeAll(() => {
  sql = readFileSync(
    join(__dirname, '../../supabase/migrations/0173_revoke_anon_vc_pool_move.sql'),
    'utf8'
  );
});

describe('0173: revokes anon EXECUTE on _vc_pool_move, the one ungated VC pool mutator', () => {
  it('revokes exactly the real live signature', () => {
    expect(sql).toMatch(
      /REVOKE EXECUTE ON FUNCTION public\._vc_pool_move\(text, numeric, uuid, uuid, text, uuid\) FROM anon;/
    );
  });

  it('does not touch authenticated or project_admin', () => {
    expect(sql).not.toMatch(/FROM (authenticated|project_admin)/);
  });

  it('contains no function body change, no other grant, no data statement -- revoke only', () => {
    const statements = sql
      .split('\n')
      .filter((l) => !l.trim().startsWith('--') && l.trim().length > 0);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/^REVOKE EXECUTE/);
  });
});
