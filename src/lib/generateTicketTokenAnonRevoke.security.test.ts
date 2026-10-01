import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Tickets subsystem audit: 0133_revoke_anon_generate_ticket_token.sql.
// generate_ticket_token carried an anon EXECUTE grant, the same
// grant-hygiene gap as complete_service_booking (0132). The function's own
// internal auth.uid() ownership check already made this unreachable in
// practice -- grant-hygiene/defense-in-depth fix, not a closed live exploit.

let m0133: string;

beforeAll(() => {
  m0133 = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0133_revoke_anon_generate_ticket_token.sql'), 'utf8');
});

describe('generate_ticket_token no longer carries an anon EXECUTE grant', () => {
  it('revokes EXECUTE from anon', () => {
    expect(m0133).toMatch(/REVOKE EXECUTE ON FUNCTION public\.generate_ticket_token\(uuid\) FROM anon;/);
  });

  it('does not touch the authenticated grant or the function body/signature', () => {
    expect(m0133).not.toMatch(/REVOKE[^;]*authenticated/);
    expect(m0133).not.toMatch(/GRANT[^;]*authenticated/);
    expect(m0133).not.toMatch(/CREATE OR REPLACE FUNCTION/);
  });
});
