import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Static-analysis test (same approach as every other *.security.test.ts in
// this repo) for 0107_remove_direct_checkins_insert_path.sql.
//
// Master security audit (HIGH #2): the organizer_insert_checkins RLS policy
// let any authenticated organizer INSERT directly into public.checkins --
// the check-in audit trail -- for any ticket on one of their events, with no
// constraint at all on scanned_by, checked_in_at, device_id, gate_name,
// is_manual_override, or the ticket's own status/checked_in state. That let
// an organizer forge a checkin row (impersonate a scanner via scanned_by,
// backdate checked_in_at, or manufacture an audit entry for a
// cancelled/refunded ticket) without ever calling verify_entry_pass or
// manual_check_in -- both SECURITY DEFINER and both already the only
// legitimate producers of checkins rows.
//
// Fix: drop the policy (SECURITY DEFINER functions run as their owning role
// and bypass RLS entirely, so verify_entry_pass/manual_check_in are
// unaffected) and revoke INSERT on checkins from anon/authenticated as
// defense-in-depth at the grant layer.
//
// Behavioral proof was run live, in isolated rolled-back transactions with
// synthetic fixtures and zero residue, against project slrtjxtzhowhwhebjprv:
//   - PRE-FIX: an organizer's direct INSERT with an arbitrary scanned_by and
//     a backdated checked_in_at, against their own cancelled ticket,
//     succeeded (the vulnerability was real).
//   - POST-FIX: the identical direct INSERT now fails with
//     "permission denied for table checkins" (42501) -- covering the forged
//     scanned_by, the backdated checked_in_at, and the invalid ticket state
//     in a single denial, since the INSERT itself is blocked.
//   - POST-FIX: manual_check_in still creates the correct audit row
//     (scanned_by = actor, is_manual_override = true).
//   - POST-FIX: verify_entry_pass, called with a real HMAC-signed v2 token,
//     still creates the correct audit row (scanned_by = actor,
//     is_manual_override = false).
//   - POST-FIX: two sequential manual_check_in calls against the same
//     ticket result in exactly one checkins row (the pre-existing
//     UPDATE ... WHERE checked_in = false plus the unique_checkin
//     constraint's ON CONFLICT DO NOTHING already made this race-safe;
//     this fix does not change that).
//   - Post-migration grants: anon/authenticated have no INSERT privilege on
//     checkins; SELECT/UPDATE/DELETE and the two SELECT policies
//     (organizer_select_checkins, owner_select_checkins) are untouched.

let migration: string;

beforeAll(() => {
  const dir = join(__dirname, '..', '..', 'supabase', 'migrations');
  migration = readFileSync(join(dir, '0107_remove_direct_checkins_insert_path.sql'), 'utf8');
});

function sqlOnly(): string {
  return migration.replace(/--[^\n]*/g, '');
}

describe('Removes the direct client INSERT path to public.checkins', () => {
  it('drops the organizer_insert_checkins policy', () => {
    expect(migration).toMatch(/DROP POLICY IF EXISTS organizer_insert_checkins ON public\.checkins;/);
  });

  it('revokes INSERT on checkins from anon and authenticated', () => {
    expect(migration).toMatch(/REVOKE INSERT ON public\.checkins FROM anon, authenticated;/);
  });

  it('does not touch SELECT/UPDATE/DELETE grants, other policies, or any function', () => {
    const sql = sqlOnly();
    expect(sql).not.toMatch(/REVOKE (SELECT|UPDATE|DELETE)/);
    expect(sql).not.toMatch(/DROP POLICY IF EXISTS organizer_select_checkins/);
    expect(sql).not.toMatch(/DROP POLICY IF EXISTS owner_select_checkins/);
    expect(sql).not.toMatch(/CREATE (OR REPLACE )?(FUNCTION|POLICY)/);
    expect(sql).not.toMatch(/\bGRANT\b/);
  });
});
