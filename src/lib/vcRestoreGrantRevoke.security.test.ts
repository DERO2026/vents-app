import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// 0129_lock_down_vc_restore_direct_rpc.sql -- financial/security
// reconciliation audit, static-analysis test matching the house pattern
// (broadWriteGrantsRevoke.security.test.ts). Behavior was additionally
// proven live against project slrtjxtzhowhwhebjprv:
//   - PRE-FIX: `GRANT EXECUTE ... TO anon, authenticated` was live on
//     public._vc_restore(uuid, integer, text).
//   - POST-FIX: `SET LOCAL ROLE authenticated; SELECT public._vc_restore(...)`
//     fails with "permission denied for function _vc_restore" (42501).
//   - POST-FIX: the legitimate nested call from
//     admin_cancel_processing_vc_payout / admin_reject_vc_payout (which runs
//     as the owning function's owner, postgres) is unaffected --
//     has_function_privilege(proowner, '_vc_restore'::regproc, 'EXECUTE')
//     is true.

let m0129: string;

beforeAll(() => {
  m0129 = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0129_lock_down_vc_restore_direct_rpc.sql'), 'utf8');
});

describe('_vc_restore is no longer directly callable by anon/authenticated', () => {
  it('revokes EXECUTE from PUBLIC, anon, and authenticated', () => {
    expect(m0129).toMatch(/REVOKE ALL ON FUNCTION public\._vc_restore\(uuid, integer, text\) FROM PUBLIC, anon, authenticated;/);
  });

  it('grants EXECUTE only to postgres and project_admin, matching the already-correct _vc_deduct shape', () => {
    expect(m0129).toMatch(/GRANT EXECUTE ON FUNCTION public\._vc_restore\(uuid, integer, text\) TO postgres, project_admin;/);
  });

  it('the revoke runs before the grant, so there is no window where the old broad grant and the new narrow one coexist', () => {
    const revokeIdx = m0129.indexOf('REVOKE ALL ON FUNCTION public._vc_restore');
    const grantIdx = m0129.indexOf('GRANT EXECUTE ON FUNCTION public._vc_restore');
    expect(revokeIdx).toBeGreaterThan(-1);
    expect(grantIdx).toBeGreaterThan(revokeIdx);
  });

  it('does not alter the function body or signature -- this is a grant-only fix', () => {
    expect(m0129).not.toMatch(/CREATE OR REPLACE FUNCTION public\._vc_restore/);
  });
});
