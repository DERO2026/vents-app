import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Static-analysis tests (same approach as every other *.security.test.ts in
// this repo) for 0102_checkins_insert_validates_ticket_event.sql.
//
// Scope note: this is a pure RLS policy tightening on the `checkins` table
// -- no application code anywhere directly inserts into `checkins` (the
// only writers are the SECURITY DEFINER verify_entry_pass/manual_check_in
// functions, which run as the table owner and therefore bypass RLS
// entirely, confirmed live via pg_class.relowner = table owner and
// relforcerowsecurity = false). So there is no client-side code path to
// exercise here; the actual behavioral proof for the 5 required scenarios
// was run live, in isolated transactions rolled back with no residue,
// against project slrtjxtzhowhwhebjprv both BEFORE this migration (to
// reproduce the cross-event injection bug) and AFTER (to confirm the fix
// and that nothing else regressed):
//   1. valid ticket + matching event succeeds -- confirmed live.
//   2. ticket A + event B (organizer's own event, someone else's ticket)
//      is rejected -- confirmed live; reproduced as a real bug pre-fix.
//   3. an organizer who does not own the named event is rejected --
//      confirmed live, unchanged from before this migration.
//   4. a nonexistent ticket_id is rejected -- confirmed live (via this
//      policy's own ticket_id/event_id subquery; previously would have
//      been caught downstream by the checkins_ticket_id_fkey constraint
//      instead, so behavior is preserved either way).
//   5. the legitimate scanner flow (manual_check_in, SECURITY DEFINER)
//      still succeeds and writes a real checkins row -- confirmed live,
//      unaffected by this RLS change since it runs as the table owner.
// These tests instead assert the deployed migration's SQL shape so a
// future edit can't silently narrow/widen/remove the fix without a test
// failing.

let migration: string;

beforeAll(() => {
  const dir = join(__dirname, '..', '..', 'supabase', 'migrations');
  migration = readFileSync(join(dir, '0102_checkins_insert_validates_ticket_event.sql'), 'utf8');
});

function policyBody(): string {
  return migration.match(/CREATE POLICY organizer_insert_checkins[\s\S]*?;/)?.[0] ?? '';
}

describe('checkins.organizer_insert_checkins now validates ticket_id belongs to event_id', () => {
  it('redefines the same policy name on the same table/command rather than adding a new one', () => {
    expect(migration).toMatch(/DROP POLICY IF EXISTS organizer_insert_checkins ON public\.checkins/);
    expect(migration).toMatch(/CREATE POLICY organizer_insert_checkins\s*\n\s*ON public\.checkins\s*\n\s*FOR INSERT/);
  });

  it('keeps the existing organizer/event ownership check unchanged', () => {
    const body = policyBody();
    expect(body).toMatch(/event_id IN \(SELECT id FROM public\.events WHERE organizer_id = \(SELECT auth\.uid\(\)\)\)/);
  });

  it('adds the ticket_id -> event_id linkage check that closes the cross-event injection gap', () => {
    const body = policyBody();
    expect(body).toMatch(/AND ticket_id IN \(SELECT id FROM public\.tickets WHERE event_id = checkins\.event_id\)/);
  });

  it('does not touch the other checkins policies (no CREATE/DROP POLICY for them)', () => {
    expect(migration).not.toMatch(/(CREATE|DROP) POLICY[^\n]*organizer_select_checkins/);
    expect(migration).not.toMatch(/(CREATE|DROP) POLICY[^\n]*owner_select_checkins/);
  });

  it('does not introduce any new RPC -- this is RLS-only', () => {
    expect(migration).not.toMatch(/CREATE (OR REPLACE )?FUNCTION/);
  });
});
