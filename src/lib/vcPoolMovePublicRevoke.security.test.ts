import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Corrective follow-up to 0173 (src/lib/vcPoolMoveAnonRevoke.security.test.ts),
// which was applied to production but did NOT close the vulnerability --
// live has_function_privilege('anon', ...) remained true afterward because
// _vc_pool_move's EXECUTE privilege was granted to PUBLIC (Postgres's
// default), not to anon directly; REVOKE ... FROM anon is a no-op against
// a privilege inherited through PUBLIC. 0173 is left unedited (already
// applied to production); this is a NEW migration (0174), not an edit of
// an already-applied file.
//
// This suite is static-analysis only (same approach as every other
// *.security.test.ts in this repo) -- it verifies the drafted SQL text,
// not live database behavior. Migration 0174 is NOT YET APPLIED.

let sql174: string;
let sql173: string;

beforeAll(() => {
  const dir = join(__dirname, '../../supabase/migrations');
  sql174 = readFileSync(join(dir, '0174_revoke_public_vc_pool_move.sql'), 'utf8');
  sql173 = readFileSync(join(dir, '0173_revoke_anon_vc_pool_move.sql'), 'utf8');
});

describe('0174: revokes EXECUTE on _vc_pool_move from PUBLIC (the real access path)', () => {
  it('revokes from PUBLIC, not just anon', () => {
    expect(sql174).toMatch(
      /REVOKE EXECUTE ON FUNCTION public\._vc_pool_move\(text, numeric, uuid, uuid, text, uuid\) FROM PUBLIC;/
    );
  });

  it('does NOT re-grant to authenticated or project_admin -- no evidence either needs direct access', () => {
    expect(sql174).not.toMatch(/GRANT EXECUTE/);
    expect(sql174).not.toMatch(/TO authenticated/);
    expect(sql174).not.toMatch(/TO project_admin/);
  });

  it('is a single statement -- no function body change, no other grant, no data write', () => {
    const statements = sql174
      .split('\n')
      .filter((l) => !l.trim().startsWith('--') && l.trim().length > 0);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/^REVOKE EXECUTE/);
  });

  it('0173 is left unedited -- this is a new migration, not a correction of an already-applied file', () => {
    expect(sql173).toMatch(
      /REVOKE EXECUTE ON FUNCTION public\._vc_pool_move\(text, numeric, uuid, uuid, text, uuid\) FROM anon;/
    );
  });
});

describe('_vc_pool_move: no application code calls it directly (confirms no role needs a direct grant)', () => {
  it('zero supabase.rpc("_vc_pool_move", ...) call sites anywhere in src/ or api/', () => {
    // Mirrors the grep this migration's own comment cites as evidence.
    // Re-asserted here as a living check: if a future PR ever adds a
    // direct client call to this function, this test fails and forces an
    // explicit decision about re-granting access, rather than letting the
    // app silently break against a function nothing is supposed to call
    // directly.
    const { execSync } = require('node:child_process') as typeof import('node:child_process');
    const root = join(__dirname, '../..');
    let matches = '';
    try {
      matches = execSync(
        `grep -rln "rpc('_vc_pool_move'" "${join(root, 'src')}" "${join(root, 'api')}" | grep -v 'vcPoolMovePublicRevoke.security.test.ts' || true`,
        { encoding: 'utf8' }
      );
    } catch {
      matches = '';
    }
    expect(matches.trim()).toBe('');
  });
});
