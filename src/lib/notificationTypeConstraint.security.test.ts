import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Regression for the production Send Invitation failure:
//   new row for relation "notifications" violates check constraint
//   "notifications_type_check"
// invite_recruiter_partnership / respond_to_recruiter_invitation (0193,
// carried into 0196) inserted type 'recruiter_invitation' /
// 'recruiter_invitation_response', which the constraint (0005) rejects.
// 0197 switches both to 'social'.
//
// Static: parses the migration SQL. It checks that the LATEST definition of
// every function (across all migrations, in order) only inserts literal
// notification types the constraint allows. Real execution against the
// constraint lives in scripts/local-pg-test/run-recruiter-invite-target-verification.sh
// and run-vents-earn-verification.sh (whose schema now carries the
// production constraint verbatim).

const dir = join(__dirname, '..', '..', 'supabase', 'migrations');
let allowed: Set<string>;
let latestBodies: Map<string, { file: string; body: string }>;

// Pre-existing violations, not introduced or fixed here; listed so any NEW
// violation fails this test.
//   - send_event_reminders (0004): 'event_reminder'. No caller (superseded by
//     run_event_reminder_sweep, which uses 'reminder'); project_admin only.
//   - admin_send_announcement (0191): 'announcement' for the organizers /
//     service_providers audiences -- live, and rejected by the constraint
//     exactly like the recruiter types were. Needs its own fix.
const KNOWN_PREEXISTING: Record<string, string[]> = {
  send_event_reminders: ['event_reminder'],
  admin_send_announcement: ['announcement'],
};

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

beforeAll(() => {
  const m0005 = readFileSync(join(dir, '0005_primary_unique_check_constraints.sql'), 'utf8');
  const check = m0005.match(/ADD CONSTRAINT notifications_type_check CHECK \(\(type = ANY \(ARRAY\[(.*?)\]\)\)\);/)?.[1] ?? '';
  allowed = new Set([...check.matchAll(/'([a-z_]+)'::text/g)].map((x) => x[1]));

  latestBodies = new Map();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(dir, file), 'utf8');
    for (const fm of sql.matchAll(/CREATE OR REPLACE FUNCTION (?:public\.)?(\w+)\([\s\S]*?\$(\w*)\$([\s\S]*?)\$\2\$/gi)) {
      latestBodies.set(fm[1], { file, body: fm[3] });
    }
  }
});

describe('notifications_type_check', () => {
  it('is the 8-value constraint production enforces', () => {
    expect([...allowed].sort()).toEqual(['booking', 'broadcast', 'event_update', 'message', 'promo', 'reminder', 'sale', 'social']);
  });

  it('no migration ever relaxes or drops it', () => {
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql'))) {
      const sql = readFileSync(join(dir, file), 'utf8');
      expect(sql, file).not.toMatch(/DROP CONSTRAINT (IF EXISTS )?notifications_type_check/i);
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

  it('VENTS Earn invite and response notifications now use \'social\' (latest definitions are 0197)', () => {
    for (const fn of ['invite_recruiter_partnership', 'respond_to_recruiter_invitation']) {
      const latest = latestBodies.get(fn)!;
      expect(latest.file).toBe('0197_vents_earn_notifications_use_valid_type.sql');
      expect(notificationTypeExpressions(latest.body)).toEqual(["'social'"]);
    }
  });

  it('all literal types across every function\'s latest definition are allowed (known pre-existing exceptions aside)', () => {
    const violations: string[] = [];
    let literalCount = 0;
    for (const [fn, { file, body }] of latestBodies) {
      for (const expr of notificationTypeExpressions(body)) {
        const lit = expr.match(/^'([a-z_]+)'$/)?.[1];
        if (!lit) continue; // a parameter or expression (e.g. notify_user's p_type) -- not statically checkable
        literalCount++;
        if (!allowed.has(lit) && !(KNOWN_PREEXISTING[fn] ?? []).includes(lit)) violations.push(`${fn} (${file}): '${lit}'`);
      }
    }
    expect(literalCount).toBeGreaterThan(30); // the parser actually found the inserts
    expect(violations).toEqual([]);
  });
});
