import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// 0131_events_dedup_unique_index.sql -- organizer end-to-end reconciliation
// audit, duplicate event-submission protection. Static-analysis test
// matching the house pattern. Behavior proven live against project
// slrtjxtzhowhwhebjprv (rolled back, no residue):
//   - PRE-FIX: two identical direct inserts (same organizer_id/title/
//     location/event_date) both succeeded -- the client's recentDupe
//     SELECT-then-insert check is a time-of-check/time-of-use race, closable
//     by two concurrent requests or any direct/stale-client caller that
//     skips the SELECT.
//   - POST-FIX: the identical second insert fails with "duplicate key value
//     violates unique constraint events_organizer_dedup_idx".
//   - POST-FIX: a different title (same organizer/location/date) still
//     succeeds; the same title/location with a different event_date (a
//     recurring event) still succeeds; recreating an event identical to one
//     that was soft-deleted still succeeds; a different organizer creating
//     the identical title/location/date still succeeds (isolation
//     preserved -- the index includes organizer_id).

let m0131: string;
let createEventSrc: string;

beforeAll(() => {
  m0131 = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0131_events_dedup_unique_index.sql'), 'utf8');
  createEventSrc = readFileSync(join(__dirname, '..', 'app', 'components', 'CreateEventScreen.tsx'), 'utf8');
});

describe('events table now has a server-side dedup constraint matching the client\'s own documented intent', () => {
  it('creates a unique index on (organizer_id, title, location, event_date), scoped to non-deleted rows', () => {
    expect(m0131).toMatch(/CREATE UNIQUE INDEX events_organizer_dedup_idx\s*\n\s*ON public\.events \(organizer_id, title, location, event_date\)\s*\n\s*WHERE \(deleted_at IS NULL\);/);
  });

  it('does not restrict by title alone -- different location or event_date remain unrestricted', () => {
    // The index key is a 4-column composite, not a single-column uniqueness
    // on title -- this is the structural guarantee that distinct events
    // (different venue/date) are never blocked.
    const idx = m0131.match(/CREATE UNIQUE INDEX events_organizer_dedup_idx[\s\S]*?;/)?.[0] ?? '';
    expect(idx).toContain('organizer_id, title, location, event_date');
  });
});

describe('CreateEventScreen handles the new constraint as a success, not a user-facing error', () => {
  it('detects the dedup unique-violation specifically by its constraint name', () => {
    expect(createEventSrc).toMatch(/error\?\.code === '23505' && error\.message\?\.includes\('events_organizer_dedup_idx'\)/);
  });

  it('on a caught duplicate, re-fetches the existing row by the same identifying fields the index uses, rather than failing the publish', () => {
    const block = createEventSrc.match(/if \(error\?\.code === '23505'[\s\S]*?\} else if \(error\) \{\s*\n\s*throw error;\s*\n\s*\}/)?.[0] ?? '';
    expect(block).toMatch(/\.eq\('organizer_id', currentUser\.id\)/);
    expect(block).toMatch(/\.eq\('title', sanitize\(title\)\)/);
    expect(block).toMatch(/\.eq\('location', locationString\)/);
    expect(block).toMatch(/\.eq\('event_date', eventTimestamp\)/);
    expect(block).toMatch(/\.is\('deleted_at', null\)/);
  });

  it('any other insert error still surfaces to the user unchanged', () => {
    expect(createEventSrc).toMatch(/\} else if \(error\) \{\s*\n\s*throw error;\s*\n\s*\}/);
  });

  it('the pre-existing client-side recentDupe check is untouched -- this is a backstop, not a replacement', () => {
    expect(createEventSrc).toMatch(/const \{ data: recentDupe \} = await supabase/);
  });
});
