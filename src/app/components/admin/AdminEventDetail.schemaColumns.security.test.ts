import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression test for the confirmed Oct 2026 audit finding: AdminEventDetail's
// loadEvent() selected `venue` from `events`, a column that has never existed
// in the schema (the real column is `location` -- see
// supabase/migrations/0002_tables.sql's `events` table definition; `venue` is
// a UI-only field CreateEventScreen.tsx folds into `location` at write time,
// never its own column). That bug shipped silently because the existing
// render test (AdminUsersEvents.render.test.tsx) mocks `select: () => q` --
// it discards the string argument entirely, so a nonexistent column name is
// structurally unreachable by that test no matter what it selects.
//
// This test does the opposite: it reads AdminEventDetail.tsx's own source,
// extracts the exact `.select('...')` string loadEvent() sends, and checks
// every plain column name in it against the real `events` table's column
// list (read from the migration that created it, plus every later
// `ADD COLUMN`/rename on that table -- not hand-copied here, so this test
// rots loudly instead of silently if a future migration changes the shape).
// It does not mock Supabase at all; there is nothing here for a mock to
// paper over.

const EVENTS_TABLE_FILE = join(__dirname, '..', '..', '..', '..', 'supabase', 'migrations', '0002_tables.sql');
const ADMIN_TRENDING_MIGRATION = join(__dirname, '..', '..', '..', '..', 'supabase', 'migrations', '0182_admin_manual_trending_control.sql');
const DETAIL_FILE = join(__dirname, 'AdminEventDetail.tsx');

function parseColumnNamesFromCreateTable(sql: string, tableName: string): Set<string> {
  const re = new RegExp(`CREATE TABLE IF NOT EXISTS ${tableName} \\(([\\s\\S]*?)\\);`);
  const body = sql.match(re)?.[1];
  if (!body) throw new Error(`Could not find CREATE TABLE for ${tableName} in migration fixture`);
  // Split on top-level commas (column definitions never contain parens in
  // this schema file beyond the table's own wrapping ones, so a plain split
  // on ", " at depth 0 is sufficient here).
  const cols = new Set<string>();
  let depth = 0;
  let current = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      cols.add(current.trim().split(/\s+/)[0]);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) cols.add(current.trim().split(/\s+/)[0]);
  return cols;
}

// Extracts the exact string literal passed to `.select(...)` inside
// loadEvent()'s `.from('events')` call -- not a loose regex over the whole
// file, so it can't accidentally match some other table's select.
function extractEventsSelectString(src: string): string {
  const fromIdx = src.indexOf(".from('events')");
  if (fromIdx === -1) throw new Error("Could not find .from('events') in AdminEventDetail.tsx");
  const selectMatch = src.slice(fromIdx).match(/\.select\('([^']*)'\)/);
  if (!selectMatch) throw new Error("Could not find a .select('...') call after .from('events')");
  return selectMatch[1];
}

// Splits a PostgREST select string into top-level items, respecting
// `relation(nested, cols)` grouping so `users!events_organizer_id_fkey(...)`
// is treated as one item, not shredded on its internal commas.
function splitSelectItems(select: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of select) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      items.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

let realEventsColumns: Set<string>;
let selectString: string;
let selectItems: string[];
let plainColumns: string[]; // excludes relationship items like `users!...(...)`

beforeAll(() => {
  const tablesSql = readFileSync(EVENTS_TABLE_FILE, 'utf8');
  realEventsColumns = parseColumnNamesFromCreateTable(tablesSql, 'events');
  // admin_trending was added later via ALTER TABLE, not in the original
  // CREATE TABLE -- confirmed present in 0182's own migration text.
  const trendingSql = readFileSync(ADMIN_TRENDING_MIGRATION, 'utf8');
  expect(trendingSql).toMatch(/ALTER TABLE public\.events ADD COLUMN IF NOT EXISTS admin_trending/);
  realEventsColumns.add('admin_trending');

  const detailSrc = readFileSync(DETAIL_FILE, 'utf8');
  selectString = extractEventsSelectString(detailSrc);
  selectItems = splitSelectItems(selectString);
  plainColumns = selectItems.filter((item) => !item.includes('('));
});

describe('AdminEventDetail loadEvent(): .select() column list matches the real events schema', () => {
  it('never selects the nonexistent "venue" column again (the exact Oct 2026 regression)', () => {
    expect(plainColumns).not.toContain('venue');
    expect(selectString).not.toMatch(/\bvenue\b/);
  });

  it('every plain selected column actually exists on public.events per the migration that created/altered it', () => {
    const unknown = plainColumns.filter((c) => !realEventsColumns.has(c));
    expect(unknown).toEqual([]);
  });

  it('selects location (the real column CreateEventScreen.tsx actually writes venue/city/address into)', () => {
    expect(plainColumns).toContain('location');
  });

  it('still selects every field the detail screen itself renders (status, featured/trending badges, organizer join)', () => {
    expect(plainColumns).toEqual(
      expect.arrayContaining([
        'id', 'title', 'organizer_id', 'hidden_by_admin', 'hidden_at',
        'created_at', 'event_date', 'deleted_at', 'is_featured',
        'featured_until', 'admin_trending',
      ]),
    );
    expect(selectItems.some((item) => item.startsWith('users!events_organizer_id_fkey('))).toBe(true);
  });
});
