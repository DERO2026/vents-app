import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Regression for the production Send Invitation failure:
//   new row for relation "notifications" violates check constraint
//   "notifications_type_check"
// invite_recruiter_partnership / respond_to_recruiter_invitation (0193,
// carried into 0196) inserted type 'recruiter_invitation' /
// 'recruiter_invitation_response', which the constraint (0005) rejects.
// 0197 switches both to 'social'. The same failure in admin_send_announcement
// (0191, 'announcement') is fixed by 0198, which adds 'announcement' to the
// constraint and drops the dead send_event_reminders() ('event_reminder').
//
// Static: parses the migration SQL. It checks that the LATEST definition of
// every function still defined after all migrations (in order, honouring
// DROP FUNCTION) only inserts literal notification types the LATEST
// notifications_type_check allows. There is deliberately no exceptions list:
// a function inserting a new type must extend the constraint, or use an
// existing type, in the same change. Real execution against the constraint
// lives in scripts/local-pg-test/run-recruiter-invite-target-verification.sh,
// run-vents-earn-verification.sh and run-notification-type-verification.sh
// (whose schemas carry the production constraint verbatim).

const dir = join(__dirname, '..', '..', 'supabase', 'migrations');
// notifications_type_check as 0005 created it and production enforced it
// until 0198. Later definitions may add values but must keep all of these.
const ORIGINAL_TYPES = ['booking', 'broadcast', 'event_update', 'message', 'promo', 'reminder', 'sale', 'social'];
let allowed: Set<string>;
let constraintHistory: { file: string; types: string[] }[];
let latestBodies: Map<string, { file: string; body: string }>;

// Splits `s` on commas at parenthesis depth 0, ignoring commas inside
// single-quoted literals.
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") {
      if (quoted && s[i + 1] === "'") { cur += "''"; i++; continue; }
      quoted = !quoted;
    } else if (!quoted) {
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    }
    cur += c;
  }
  parts.push(cur);
  return parts.map((p) => p.trim());
}

// Returns the contents of each top-level (...) group in `s`, stopping at the
// first top-level ';'.
function topLevelGroups(s: string): string[] {
  const groups: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") { if (quoted && s[i + 1] === "'") { i++; continue; } quoted = !quoted; continue; }
    if (quoted) continue;
    if (c === ';' && depth === 0) break;
    if (c === '(') { if (depth === 0) start = i + 1; depth++; }
    else if (c === ')') { depth--; if (depth === 0) groups.push(s.slice(start, i)); }
  }
  return groups;
}

// The select list of `SELECT ...` in `s`: everything up to the first
// top-level FROM or ';'.
function selectList(s: string): string {
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") { if (quoted && s[i + 1] === "'") { i++; continue; } quoted = !quoted; continue; }
    if (quoted) continue;
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth === 0 && (c === ';' || /^FROM\b/i.test(s.slice(i)) && /\s/.test(s[i - 1] ?? ' '))) return s.slice(0, i);
  }
  return s;
}

// For every `INSERT INTO [public.]notifications (cols) VALUES (...), (...)`
// or `... (cols) SELECT ...` in `body`, the expression in the `type` column
// position of each row.
function notificationTypeExpressions(body: string): string[] {
  const out: string[] = [];
  const re = /INSERT INTO (?:public\.)?notifications\s*\(([^)]*)\)\s*(VALUES|SELECT)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const cols = m[1].split(',').map((c) => c.trim().toLowerCase());
    const typeIdx = cols.indexOf('type');
    if (typeIdx < 0) continue;
    const rest = body.slice(re.lastIndex);
    const rows = m[2].toUpperCase() === 'VALUES' ? topLevelGroups(rest) : [selectList(rest)];
    for (const row of rows) out.push(splitTopLevel(row)[typeIdx]);
  }
  return out;
}

const migrationFiles = () => readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

beforeAll(() => {
  constraintHistory = [];
  latestBodies = new Map();
  for (const file of migrationFiles()) {
    const sql = readFileSync(join(dir, file), 'utf8');
    for (const cm of sql.matchAll(/ADD CONSTRAINT notifications_type_check CHECK \(\(type = ANY \(ARRAY\[(.*?)\]\)\)\);/g)) {
      constraintHistory.push({ file, types: [...cm[1].matchAll(/'([a-z_]+)'::text/g)].map((x) => x[1]) });
    }
    // Replay CREATE OR REPLACE / DROP FUNCTION in file order, so a function
    // a later migration drops is no longer checked.
    const events: { at: number; apply: () => void }[] = [];
    for (const fm of sql.matchAll(/CREATE OR REPLACE FUNCTION (?:public\.)?(\w+)\([\s\S]*?\$(\w*)\$([\s\S]*?)\$\2\$/gi)) {
      events.push({ at: fm.index!, apply: () => latestBodies.set(fm[1], { file, body: fm[3] }) });
    }
    for (const dm of sql.matchAll(/^DROP FUNCTION (?:IF EXISTS )?(?:public\.)?(\w+)\(/gim)) {
      events.push({ at: dm.index!, apply: () => latestBodies.delete(dm[1]) });
    }
    events.sort((a, b) => a.at - b.at).forEach((e) => e.apply());
  }
  allowed = new Set(constraintHistory[constraintHistory.length - 1]?.types ?? []);
});

describe('notifications_type_check', () => {
  it('0005 created it with the original eight values', () => {
    expect(constraintHistory[0].file).toBe('0005_primary_unique_check_constraints.sql');
    expect([...constraintHistory[0].types].sort()).toEqual(ORIGINAL_TYPES);
  });

  it('the latest definition (0198) is the original eight plus \'announcement\', and nothing else', () => {
    expect(constraintHistory[constraintHistory.length - 1].file).toBe('0198_notifications_type_check_allow_announcement.sql');
    expect([...allowed].sort()).toEqual([...ORIGINAL_TYPES, 'announcement'].sort());
  });

  it('every redefinition keeps all original values (it is only ever extended)', () => {
    for (const { file, types } of constraintHistory) {
      for (const t of ORIGINAL_TYPES) expect(types, `${file} dropped '${t}'`).toContain(t);
    }
  });

  it('it is never dropped without being re-added later in the same migration', () => {
    for (const file of migrationFiles()) {
      const sql = readFileSync(join(dir, file), 'utf8');
      const drop = sql.search(/DROP CONSTRAINT (IF EXISTS )?notifications_type_check/i);
      if (drop === -1) continue;
      expect(sql.slice(drop), file).toMatch(/ADD CONSTRAINT notifications_type_check CHECK/);
    }
  });
});

describe('every function\'s latest definition inserts only allowed notification types', () => {
  it('reproduces the production failure: 0193/0196 recruiter functions used rejected types', () => {
    const m0193 = readFileSync(join(dir, '0193_vents_earn_foundation.sql'), 'utf8');
    const m0196 = readFileSync(join(dir, '0196_recruiter_invite_target_uses_organizer_capability.sql'), 'utf8');
    const inv0196 = m0196.match(/CREATE OR REPLACE FUNCTION public\.invite_recruiter_partnership\([\s\S]*?\$function\$\s*;/)![0];
    const resp0193 = m0193.match(/CREATE OR REPLACE FUNCTION public\.respond_to_recruiter_invitation\([\s\S]*?\$function\$\s*;/)![0];
    expect(notificationTypeExpressions(inv0196)).toEqual(["'recruiter_invitation'"]);
    expect(notificationTypeExpressions(resp0193)).toEqual(["'recruiter_invitation_response'"]);
    expect(allowed.has('recruiter_invitation')).toBe(false);
    expect(allowed.has('recruiter_invitation_response')).toBe(false);
  });

  it('VENTS Earn invite and response notifications now use \'social\' (latest definitions: 0201 for the invite, 0197 for the response)', () => {
    const latestFile: Record<string, string> = {
      // 0201 redefines the invite for the fixed reward model (no commission wording).
      invite_recruiter_partnership: '0201_vents_earn_representative_rewards.sql',
      respond_to_recruiter_invitation: '0197_vents_earn_notifications_use_valid_type.sql',
    };
    for (const [fn, file] of Object.entries(latestFile)) {
      const latest = latestBodies.get(fn)!;
      expect(latest.file).toBe(file);
      expect(notificationTypeExpressions(latest.body)).toEqual(["'social'"]);
    }
  });

  it('admin_send_announcement\'s role-scoped \'announcement\' inserts are now allowed (0191, fixed by 0198)', () => {
    const latest = latestBodies.get('admin_send_announcement')!;
    expect(latest.file).toBe('0191_admin_send_announcement.sql');
    expect(notificationTypeExpressions(latest.body).sort()).toEqual(["'announcement'", "'announcement'", "'broadcast'"]);
    expect(allowed.has('announcement')).toBe(true);
  });

  it('send_event_reminders() (inserted the rejected \'event_reminder\') is dropped by 0198', () => {
    expect(latestBodies.has('send_event_reminders')).toBe(false);
    expect(allowed.has('event_reminder')).toBe(false);
  });

  it('all literal types across every function\'s latest definition are allowed -- no exceptions', () => {
    const violations: string[] = [];
    let literalCount = 0;
    for (const [fn, { file, body }] of latestBodies) {
      for (const expr of notificationTypeExpressions(body)) {
        const lit = expr.match(/^'([a-z_]+)'$/)?.[1];
        if (!lit) continue; // a parameter or expression (e.g. notify_user's p_type) -- not statically checkable
        literalCount++;
        if (!allowed.has(lit)) violations.push(`${fn} (${file}): '${lit}'`);
      }
    }
    expect(literalCount).toBeGreaterThan(30); // the parser actually found the inserts
    expect(violations).toEqual([]);
  });
});

describe('frontend notification types match the constraint', () => {
  const components = join(__dirname, '..', 'app', 'components');

  it('the Notification.type union in types.ts lists exactly the allowed types', () => {
    const src = readFileSync(join(components, 'types.ts'), 'utf8');
    const union = src.match(/export interface Notification \{[\s\S]*?\n\s*type: ([^;]+);/)?.[1] ?? '';
    expect([...union.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort()).toEqual([...allowed].sort());
  });

  it('NotificationsScreen TYPE_COLORS has a colour for exactly the allowed types', () => {
    const src = readFileSync(join(components, 'NotificationsScreen.tsx'), 'utf8');
    const body = src.match(/const TYPE_COLORS: Record<string, string> = \{([\s\S]*?)\};/)?.[1] ?? '';
    expect([...body.matchAll(/^\s*(\w+):/gm)].map((x) => x[1]).sort()).toEqual([...allowed].sort());
  });
});
