import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// 0130_fix_events_insert_missing_organizer_capability_check.sql --
// organizer end-to-end reconciliation audit, static-analysis test matching
// the house pattern. Behavior proven live against project
// slrtjxtzhowhwhebjprv (rolled back, no residue):
//   - PRE-FIX: a confirmed is_organizer=false, role='user' account could
//     `INSERT INTO events (organizer_id, ...) VALUES (<own uid>, ...)`
//     directly over PostgREST and the row was created -- the entire
//     Become-Organizer application/approval flow (organizer_requests ->
//     admin_decide_organizer_request) was enforced ONLY by which screen the
//     client happened to show, never by the database.
//   - POST-FIX: the identical insert now fails with "new row violates row-
//     level security policy for table events".
//   - POST-FIX: a real is_organizer=true account's insert still succeeds,
//     unchanged.
//   - POST-FIX: an organizer attempting to insert with organizer_id set to
//     a DIFFERENT user's id (impersonation) still fails, as it always did.

let m0130: string;

beforeAll(() => {
  m0130 = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0130_fix_events_insert_missing_organizer_capability_check.sql'), 'utf8');
});

describe('events INSERT now requires the is_organizer capability, not just row ownership', () => {
  it('drops the old ownership-only policy and replaces it with a capability-checked one', () => {
    expect(m0130).toMatch(/DROP POLICY IF EXISTS insert_events ON public\.events;/);
    expect(m0130).toMatch(/CREATE POLICY insert_events ON public\.events\s*\n\s*FOR INSERT\s*\n\s*WITH CHECK \(\(\(auth\.uid\(\) = organizer_id AND public\.is_organizer\(\)\) OR public\.is_admin\(\)\)\);/);
  });

  it('ownership (auth.uid() = organizer_id) is still required -- this fix adds a check, it does not relax one', () => {
    expect(m0130).toMatch(/auth\.uid\(\) = organizer_id AND public\.is_organizer\(\)/);
  });

  it('an admin can still create events without needing is_organizer set, same as before', () => {
    expect(m0130).toMatch(/OR public\.is_admin\(\)/);
  });
});
