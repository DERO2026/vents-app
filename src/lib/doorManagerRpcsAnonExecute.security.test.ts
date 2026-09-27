import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Static-analysis test (same approach as every other *.security.test.ts in
// this repo) for 0105_revoke_anon_execute_door_manager_rpcs.sql.
//
// Follow-up to 0104: a regression audit after that migration flagged that
// get_recent_checkins was still anon-executable, same pattern class as
// verify_entry_pass/manual_check_in/refund_ticket. Its three sibling Door
// Manager RPCs (get_door_stats, get_event_attendees, get_scan_log) have
// the exact same shape -- SECURITY DEFINER, gated on
// is_event_door_manager(p_event_id), which already rejects an anon caller
// (auth.uid() IS NULL) via its own business logic -- so revoking anon
// EXECUTE closes the same class of unnecessary attack surface on all four
// at once.
//
// Behavioral proof was run live, in an isolated rolled-back transaction:
// an organizer's own get_door_stats call still succeeds after the revoke,
// and has_function_privilege confirms anon=false / authenticated=true on
// all four functions post-migration.

let migration: string;

beforeAll(() => {
  const dir = join(__dirname, '..', '..', 'supabase', 'migrations');
  migration = readFileSync(join(dir, '0105_revoke_anon_execute_door_manager_rpcs.sql'), 'utf8');
});

describe('Revokes anon EXECUTE on the remaining Door Manager RPCs', () => {
  it('revokes EXECUTE from anon on exactly the four Door Manager read RPCs', () => {
    expect(migration).toMatch(/REVOKE EXECUTE ON FUNCTION public\.get_recent_checkins\(uuid, integer\) FROM anon;/);
    expect(migration).toMatch(/REVOKE EXECUTE ON FUNCTION public\.get_door_stats\(uuid\) FROM anon;/);
    expect(migration).toMatch(/REVOKE EXECUTE ON FUNCTION public\.get_event_attendees\(uuid, text, text, integer, integer\) FROM anon;/);
    expect(migration).toMatch(/REVOKE EXECUTE ON FUNCTION public\.get_scan_log\(uuid, text, integer, integer\) FROM anon;/);
  });

  it('does not touch the authenticated or project_admin roles, and defines no function/policy', () => {
    const sql = migration.replace(/--[^\n]*/g, '');
    expect(sql).not.toMatch(/FROM authenticated/);
    expect(sql).not.toMatch(/FROM project_admin/);
    expect(sql).not.toMatch(/\bGRANT\b/);
    expect(sql).not.toMatch(/CREATE (OR REPLACE )?(FUNCTION|POLICY)/);
  });
});
