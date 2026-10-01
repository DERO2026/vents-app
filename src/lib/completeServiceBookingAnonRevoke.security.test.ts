import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Services end-to-end reconciliation audit: 0132_revoke_anon_complete_
// service_booking.sql. complete_service_booking carried an anon EXECUTE
// grant, inconsistent with every sibling privileged function in this
// codebase. The function's own internal `auth.uid() IS NULL` check already
// made this unreachable in practice (anon has no session), so this is a
// grant-hygiene/defense-in-depth fix, not a closed live exploit -- recorded
// here the same way broadWriteGrantsRevoke.security.test.ts documents the
// other grant-cleanup migrations in this repo.

let m0132: string;

beforeAll(() => {
  m0132 = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0132_revoke_anon_complete_service_booking.sql'), 'utf8');
});

describe('complete_service_booking no longer carries an anon EXECUTE grant', () => {
  it('revokes EXECUTE from anon', () => {
    expect(m0132).toMatch(/REVOKE EXECUTE ON FUNCTION public\.complete_service_booking\(uuid\) FROM anon;/);
  });

  it('does not touch the authenticated grant or the function body/signature', () => {
    expect(m0132).not.toMatch(/REVOKE[^;]*authenticated/);
    expect(m0132).not.toMatch(/GRANT[^;]*authenticated/);
    expect(m0132).not.toMatch(/CREATE OR REPLACE FUNCTION/);
  });
});
