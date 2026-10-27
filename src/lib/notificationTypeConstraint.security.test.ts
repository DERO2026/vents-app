import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Guard for notifications_type_check vs. the type literals SQL functions
// insert. Static: replays supabase/migrations/*.sql in filename order,
// keeps the LAST definition of each public function (honouring DROP
// FUNCTION), and asserts every literal written into notifications.type is
// in the LAST notifications_type_check allow-list. Background: 0191
// (admin_send_announcement -> 'announcement') and 0193
// (invite_recruiter_partnership -> 'recruiter_invitation',
// respond_to_recruiter_invitation -> 'recruiter_invitation_response') all
// shipped inserting types the constraint rejected; the recruiter invite
// failed in production on its first real call. Fixed by 0197. There is no
// known-exception list on purpose: a new function inserting a new type must
// extend the constraint (or use an existing type) in the same change.
//
// Like the other *.security.test.ts files this checks migration text, not
// the live database -- a hand-applied production change can still drift.

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'supabase', 'migrations');

function stripLineComments(sql: string): string {
  return sql.replace(/(^|\s)--[^\n]*/g, '$1');
}

// Split on top-level commas, respecting parentheses and '...' literals.
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") {
      let j = i + 1;
      while (j < s.length) {
        if (s[j] === "'" && s[j + 1] === "'") { j += 2; continue; }
        if (s[j] === "'") break;
        j++;
      }
      cur += s.slice(i, j + 1);
      i = j;
      continue;
    }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

// Index of the ')' matching the '(' at s[open], skipping '...' literals.
function matchParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === "'") {
      i++;
      while (i < s.length && !(s[i] === "'" && s[i + 1] !== "'")) i += s[i] === "'" ? 2 : 1;
      continue;
    }
    if (c === '(') depth++;
    if (c === ')' && --depth === 0) return i;
  }
  return -1;
}

// The type expressions of every INSERT INTO notifications in a function body.
function insertedTypeExprs(body: string): string[] {
  const exprs: string[] = [];
  const re = /INSERT\s+INTO\s+(?:public\.)?notifications\s*\(([^)]*)\)\s*(VALUES|SELECT)\s*/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const cols = m[1].split(',').map((c) => c.trim().toLowerCase());
    const typeIdx = cols.indexOf('type');
    if (typeIdx === -1) continue;
    let rest = body.slice(re.lastIndex);
    if (m[2].toUpperCase() === 'VALUES') {
      // One or more (...) tuples separated by commas.
      let pos = 0;
      for (;;) {
        const open = rest.indexOf('(', pos);
        if (open === -1 || rest.slice(pos, open).trim().replace(/^,/, '').trim() !== '') break;
        const close = matchParen(rest, open);
        exprs.push(splitTopLevel(rest.slice(open + 1, close))[typeIdx]);
        pos = close + 1;
      }
    } else {
      rest = rest.replace(/^DISTINCT\s+/i, '');
      // Select list ends at the first top-level FROM (or statement end).
      let depth = 0;
      let end = rest.length;
      for (let i = 0; i < rest.length; i++) {
        const c = rest[i];
        if (c === "'") {
          i++;
          while (i < rest.length && !(rest[i] === "'" && rest[i + 1] !== "'")) i += rest[i] === "'" ? 2 : 1;
          continue;
        }
        if (c === '(') depth++;
        if (c === ')') depth--;
        if (depth === 0 && (c === ';' || /^\bFROM\b/i.test(rest.slice(i)) && /\s/.test(rest[i - 1] ?? ' '))) { end = i; break; }
      }
      exprs.push(splitTopLevel(rest.slice(0, end))[typeIdx]);
    }
  }
  return exprs;
}

// Literal types an expression can produce: a bare literal, or the THEN/ELSE
// literals of a CASE. Anything else (a parameter, e.g. notify_user's p_type)
// is not statically checkable and yields nothing.
function literalTypes(expr: string): string[] {
  const bare = expr.match(/^'([^']*)'(?:::text)?$/);
  if (bare) return [bare[1]];
  if (/^CASE\b/i.test(expr)) {
    return [...expr.matchAll(/\b(?:THEN|ELSE)\s+'([^']*)'/gi)].map((x) => x[1]);
  }
  return [];
}

let allowed: string[];
let fnInserts: Map<string, string[]>; // "name(args)" -> literal types inserted
let liveFnNames: Set<string>;

beforeAll(() => {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const fns = new Map<string, { name: string; body: string }>();
  let lastConstraint = '';
  for (const f of files) {
    const sql = stripLineComments(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
    const events: { at: number; apply: () => void }[] = [];
    for (const m of sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.(\w+)\s*\(([\s\S]*?)\)\s*RETURNS[\s\S]*?\bAS\s+(\$\w*\$)([\s\S]*?)\3/gi)) {
      const key = `${m[1]}(${m[2].replace(/\s+/g, ' ').trim()})`;
      events.push({ at: m.index!, apply: () => fns.set(key, { name: m[1], body: m[4] }) });
    }
    for (const m of sql.matchAll(/DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?public\.(\w+)\s*\(/gi)) {
      events.push({ at: m.index!, apply: () => { for (const [k, v] of fns) if (v.name === m[1]) fns.delete(k); } });
    }
    events.sort((a, b) => a.at - b.at).forEach((e) => e.apply());
    for (const m of sql.matchAll(/ADD\s+CONSTRAINT\s+notifications_type_check\s+CHECK\s*\(([\s\S]*?)\);/gi)) lastConstraint = m[1];
  }
  allowed = [...lastConstraint.matchAll(/'([^']+)'::text/g)].map((x) => x[1]);
  fnInserts = new Map();
  liveFnNames = new Set();
  for (const [key, { name, body }] of fns) {
    liveFnNames.add(name);
    const types = insertedTypeExprs(body).flatMap(literalTypes);
    if (types.length) fnInserts.set(key, types);
  }
});

describe('notifications_type_check covers every type literal a live function inserts', () => {
  it('finds the constraint and a non-trivial set of inserting functions (scanner sanity)', () => {
    expect(allowed).toContain('broadcast');
    expect(allowed).toContain('reminder');
    const byName = (n: string) => [...fnInserts].filter(([k]) => k.startsWith(`${n}(`)).flatMap(([, v]) => v);
    // Known inserts across both VALUES and INSERT ... SELECT shapes, so a
    // regex regression that silently matches nothing fails here.
    expect(byName('run_event_reminder_sweep')).toContain('reminder');
    expect(byName('admin_send_announcement')).toEqual(expect.arrayContaining(['broadcast', 'announcement']));
    expect(byName('send_event_announcement')).toContain('event_update');
    expect(byName('invite_recruiter_partnership')).toContain('recruiter_invitation');
    expect(byName('respond_to_recruiter_invitation')).toContain('recruiter_invitation_response');
    expect(fnInserts.size).toBeGreaterThan(20);
  });

  it('no function inserts a type the constraint rejects', () => {
    const violations = [...fnInserts]
      .flatMap(([fn, types]) => types.filter((t) => !allowed.includes(t)).map((t) => `${fn}: '${t}'`));
    expect(violations).toEqual([]);
  });

  it('0197 extends the allow-list by exactly announcement + the two recruiter types, dropping nothing', () => {
    expect([...allowed].sort()).toEqual([
      'announcement', 'booking', 'broadcast', 'event_update', 'message', 'promo',
      'recruiter_invitation', 'recruiter_invitation_response', 'reminder', 'sale', 'social',
    ]);
  });

  it('0197 drops the dead send_event_reminders() (inserted the invalid \'event_reminder\')', () => {
    expect(liveFnNames.has('send_event_reminders')).toBe(false);
  });
});

describe('frontend Notification type union matches the constraint', () => {
  it('types.ts union and NotificationsScreen TYPE_COLORS list exactly the allowed types', () => {
    const root = join(__dirname, '..', 'app', 'components');
    const typesTs = readFileSync(join(root, 'types.ts'), 'utf8');
    const union = typesTs.match(/export interface Notification \{[\s\S]*?\n\s*type: ([^;]+);/)?.[1] ?? '';
    const unionTypes = [...union.matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
    expect(unionTypes).toEqual([...allowed].sort());

    const screen = readFileSync(join(root, 'NotificationsScreen.tsx'), 'utf8');
    const colors = screen.match(/const TYPE_COLORS: Record<string, string> = \{([\s\S]*?)\};/)?.[1] ?? '';
    const colorKeys = [...colors.matchAll(/^\s*(\w+):/gm)].map((x) => x[1]).sort();
    expect(colorKeys).toEqual([...allowed].sort());
  });
});
