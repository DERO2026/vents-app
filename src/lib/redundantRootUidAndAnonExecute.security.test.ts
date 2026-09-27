import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Static-analysis tests (same approach as every other *.security.test.ts in
// this repo) for 0104_remove_redundant_root_uid_and_anon_execute.sql.
//
// Scope note: this is a pure hardening migration -- no application code
// changes, since these are all server-side authorization checks inside
// existing SECURITY DEFINER functions. The actual behavioral proof was run
// live, in isolated rolled-back transactions with zero residue, against
// project slrtjxtzhowhwhebjprv:
//   - The root/admin account (role='admin') can still manual-check-in a
//     ticket for an event it does not organize, purely via is_admin() --
//     confirmed both before and after this migration (is_admin() already
//     covers the root UID through is_root(), so removing the redundant
//     literal changes nothing about who can do what).
//   - anon no longer has EXECUTE on verify_entry_pass, manual_check_in, or
//     refund_ticket (has_function_privilege confirmed false for all three
//     post-migration; authenticated's own EXECUTE is untouched).
//
// These tests assert the deployed migration's SQL shape: the hardcoded
// UUID literal is gone from all three function bodies, is_admin() is still
// present everywhere it was, and the anon REVOKEs target exactly the
// intended three functions with no unrelated grant/revoke.

const ROOT_UID_LITERAL = "c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832";

let migration: string;

beforeAll(() => {
  const dir = join(__dirname, '..', '..', 'supabase', 'migrations');
  migration = readFileSync(join(dir, '0104_remove_redundant_root_uid_and_anon_execute.sql'), 'utf8');
});

function sqlOnly(): string {
  return migration.replace(/--[^\n]*/g, ''); // strip line comments (which intentionally still mention the UUID for context)
}

describe('Removes the redundant hardcoded root-UID bypass from function bodies', () => {
  it('the hardcoded root UUID literal no longer appears in any function body (SQL, not comments)', () => {
    expect(sqlOnly()).not.toContain(ROOT_UID_LITERAL);
  });

  it('redefines verify_entry_pass, refund_ticket, and is_event_door_manager (not new functions)', () => {
    expect(migration).toMatch(/CREATE OR REPLACE FUNCTION public\.verify_entry_pass\(/);
    expect(migration).toMatch(/CREATE OR REPLACE FUNCTION public\.refund_ticket\(/);
    expect(migration).toMatch(/CREATE OR REPLACE FUNCTION public\.is_event_door_manager\(/);
  });

  it('is_admin() is still the authorization check in all three redefined functions', () => {
    const verifySection = migration.match(/CREATE OR REPLACE FUNCTION public\.verify_entry_pass[\s\S]*?\$function\$;/)?.[0] ?? '';
    const refundSection = migration.match(/CREATE OR REPLACE FUNCTION public\.refund_ticket[\s\S]*?\$function\$;/)?.[0] ?? '';
    const doorManagerSection = migration.match(/CREATE OR REPLACE FUNCTION public\.is_event_door_manager[\s\S]*?\$function\$;/)?.[0] ?? '';
    expect(verifySection).toMatch(/NOT public\.is_admin\(\)/);
    expect(refundSection).toMatch(/NOT public\.is_admin\(\)/);
    expect(doorManagerSection).toMatch(/OR public\.is_admin\(\)/);
  });

  it('every other check inside verify_entry_pass is untouched (signature, expiry, payload match, checked-in, status)', () => {
    const verifySection = migration.match(/CREATE OR REPLACE FUNCTION public\.verify_entry_pass[\s\S]*?\$function\$;/)?.[0] ?? '';
    expect(verifySection).toMatch(/invalid_signature/);
    expect(verifySection).toMatch(/'expired'/);
    expect(verifySection).toMatch(/payload_mismatch/);
    expect(verifySection).toMatch(/already_scanned/);
    expect(verifySection).toMatch(/not_active/);
    expect(verifySection).toMatch(/WHERE id = v_ticket\.id AND checked_in = false/);
  });

  it('every other check inside refund_ticket is untouched (checked-in guard, payment-status gating)', () => {
    const refundSection = migration.match(/CREATE OR REPLACE FUNCTION public\.refund_ticket[\s\S]*?\$function\$;/)?.[0] ?? '';
    expect(refundSection).toMatch(/A checked-in ticket cannot be refunded/);
    expect(refundSection).toMatch(/Only paid tickets can be refunded/);
    expect(refundSection).toMatch(/already_refunded/);
  });
});

describe('Revokes unnecessary anon EXECUTE on authentication-required functions', () => {
  it('revokes EXECUTE from anon on exactly verify_entry_pass, manual_check_in, and refund_ticket', () => {
    expect(migration).toMatch(/REVOKE EXECUTE ON FUNCTION public\.verify_entry_pass\(text, uuid, text, text\) FROM anon;/);
    expect(migration).toMatch(/REVOKE EXECUTE ON FUNCTION public\.manual_check_in\(uuid, uuid, text, text\) FROM anon;/);
    expect(migration).toMatch(/REVOKE EXECUTE ON FUNCTION public\.refund_ticket\(uuid, text\) FROM anon;/);
  });

  it('does not revoke or grant anything for the authenticated or project_admin roles', () => {
    const sql = sqlOnly();
    expect(sql).not.toMatch(/FROM authenticated/);
    expect(sql).not.toMatch(/FROM project_admin/);
    expect(sql).not.toMatch(/\bGRANT\b/);
  });

  it('does not touch manual_check_in\'s own function body (only its anon grant)', () => {
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION public\.manual_check_in\(/);
  });
});
