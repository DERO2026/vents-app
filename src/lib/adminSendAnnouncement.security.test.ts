import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Regression/structure tests for 0191_admin_send_announcement.sql -- the
// Broadcast Center's audience-aware admin_send_announcement() RPC, built
// on migrations 0188-0190 (all confirmed live in production before this
// file was written). Source + tests only: 0191 has not been applied to
// any database, and this RPC is never invoked from any test here (no
// mutation, no real notification is ever sent by running this suite).
//
// Static-text assertions against the migration file itself (same
// convention as every other *.security.test.ts in this repo for an
// unapplied migration).

let m0191: string;
let m0189: string;

beforeAll(() => {
  const dir = join(__dirname, '..', '..', 'supabase', 'migrations');
  m0191 = readFileSync(join(dir, '0191_admin_send_announcement.sql'), 'utf8');
  m0189 = readFileSync(join(dir, '0189_announcement_groups_schema_foundation.sql'), 'utf8');
});

function fnBody(src: string): string {
  return src.match(/CREATE OR REPLACE FUNCTION public\.admin_send_announcement[\s\S]*?\$function\$;/)?.[0] ?? '';
}

describe('0191: does not modify 0188/0189/0190 or admin_send_broadcast/admin_broadcast', () => {
  it('does not define, replace, or alter admin_send_broadcast, admin_broadcast, protect_capability_columns, or sync_announcement_group_membership', () => {
    for (const name of ['admin_send_broadcast', 'admin_broadcast', 'protect_capability_columns', 'sync_announcement_group_membership']) {
      expect(m0191).not.toMatch(new RegExp(`CREATE (OR REPLACE )?FUNCTION public\\.${name}\\b`));
      expect(m0191).not.toMatch(new RegExp(`ALTER FUNCTION public\\.${name}\\b`));
      expect(m0191).not.toMatch(new RegExp(`DROP FUNCTION public\\.${name}\\b`));
    }
  });

  it('does not CREATE/ALTER/DROP any announcement_* table, policy, or existing grant -- 0189/0190 schema is untouched', () => {
    expect(m0191).not.toMatch(/CREATE TABLE/);
    expect(m0191).not.toMatch(/ALTER TABLE/);
    expect(m0191).not.toMatch(/CREATE POLICY/);
    expect(m0191).not.toMatch(/DROP POLICY/);
    expect(m0191).not.toMatch(/CREATE TRIGGER/);
  });

  it('defines exactly one new function', () => {
    expect(m0191.match(/CREATE (OR REPLACE )?FUNCTION/g)).toHaveLength(1);
  });
});

describe('0191: authorization -- is_admin_or_root() only, matching migration 0188\'s established tier', () => {
  it('gates on is_admin_or_root(), not the broader is_admin() (would include Sub-Admins)', () => {
    const fn = fnBody(m0191);
    expect(fn).toMatch(/IF NOT public\.is_admin_or_root\(\) THEN\s*\n\s*RAISE EXCEPTION 'Only admins can send announcements';\s*\n\s*END IF;/);
    expect(fn).not.toMatch(/public\.is_admin\(\)/);
  });

  it('the authorization check runs before any audience/input validation or any INSERT', () => {
    const fn = fnBody(m0191);
    const authIdx = fn.indexOf('is_admin_or_root()');
    const audienceCheckIdx = fn.indexOf("NOT IN ('everyone', 'organizers', 'service_providers')");
    const firstInsertIdx = fn.indexOf('INSERT INTO public.notifications');
    expect(authIdx).toBeGreaterThan(-1);
    expect(audienceCheckIdx).toBeGreaterThan(authIdx);
    expect(firstInsertIdx).toBeGreaterThan(audienceCheckIdx);
  });
});

describe('0191: strict audience allow-list, no dynamic SQL', () => {
  it('rejects any audience outside the exact three literals', () => {
    const fn = fnBody(m0191);
    expect(fn).toMatch(/IF p_audience NOT IN \('everyone', 'organizers', 'service_providers'\) THEN\s*\n\s*RAISE EXCEPTION 'Invalid audience: %', p_audience;\s*\n\s*END IF;/);
  });

  it('dispatches via a plain CASE over string literals, never EXECUTE/format() with interpolated SQL text', () => {
    expect(m0191).toMatch(/CASE p_audience/);
    expect(m0191).toMatch(/END CASE;/);
    expect(m0191).not.toMatch(/EXECUTE\s+(format|'|")/i);
    expect(m0191).not.toMatch(/\bformat\(/);
  });

  it('has exactly three CASE branches, one per allowed audience, and no ELSE fallback (the top-level allow-list check already rejects anything else)', () => {
    const fn = fnBody(m0191);
    expect(fn.match(/WHEN 'everyone' THEN/g)).toHaveLength(1);
    expect(fn.match(/WHEN 'organizers' THEN/g)).toHaveLength(1);
    expect(fn.match(/WHEN 'service_providers' THEN/g)).toHaveLength(1);
    expect(fn).not.toMatch(/ELSE/);
  });
});

describe('0191: input validation -- title/body required and length-capped, mirroring send_event_announcement', () => {
  it('trims and requires a non-empty title and body', () => {
    const fn = fnBody(m0191);
    expect(fn).toMatch(/v_title\s+text := trim\(COALESCE\(p_title, ''\)\);/);
    expect(fn).toMatch(/v_body\s+text := trim\(COALESCE\(p_body, ''\)\);/);
    expect(fn).toMatch(/IF v_title = '' THEN RAISE EXCEPTION 'Title is required'; END IF;/);
    expect(fn).toMatch(/IF v_body = '' THEN RAISE EXCEPTION 'Message is required'; END IF;/);
  });

  it('caps title at 80 chars and body at 500 chars', () => {
    const fn = fnBody(m0191);
    expect(fn).toMatch(/IF length\(v_title\) > 80 THEN RAISE EXCEPTION 'Title must be 80 characters or fewer'; END IF;/);
    expect(fn).toMatch(/IF length\(v_body\) > 500 THEN RAISE EXCEPTION 'Message must be 500 characters or fewer'; END IF;/);
  });
});

describe('0191: recipient selection -- everyone targets the existing population, role audiences go through announcement_group_members', () => {
  it('everyone targets the exact same population as admin_send_broadcast (public.users WHERE role <> \'admin\')', () => {
    const fn = fnBody(m0191);
    const everyoneBranch = fn.match(/WHEN 'everyone' THEN[\s\S]*?(?=WHEN 'organizers')/)?.[0] ?? '';
    expect(everyoneBranch).toMatch(/FROM public\.users u\s*\n\s*WHERE u\.role <> 'admin';/);
  });

  it('organizers audience selects from announcement_group_members joined to the organizers group, not from users.is_organizer directly', () => {
    const fn = fnBody(m0191);
    const branch = fn.match(/WHEN 'organizers' THEN[\s\S]*?(?=WHEN 'service_providers')/)?.[0] ?? '';
    expect(branch).toMatch(/FROM public\.announcement_group_members m\s*\n\s*JOIN public\.announcement_groups g ON g\.id = m\.group_id AND g\.key = 'organizers'/);
    expect(branch).not.toMatch(/is_organizer/);
  });

  it('service_providers audience selects from announcement_group_members joined to the service_providers group, not from users.is_service_provider directly', () => {
    const fn = fnBody(m0191);
    const branch = fn.match(/WHEN 'service_providers' THEN[\s\S]*?END CASE;/)?.[0] ?? '';
    expect(branch).toMatch(/FROM public\.announcement_group_members m\s*\n\s*JOIN public\.announcement_groups g ON g\.id = m\.group_id AND g\.key = 'service_providers'/);
    expect(branch).not.toMatch(/is_service_provider\b.*=/);
  });
});

describe('0191: mute exclusion -- role audiences respect announcement_mutes, scoped per group', () => {
  it('organizers branch anti-joins announcement_mutes on (user_id, group_id) for the matching member row', () => {
    const fn = fnBody(m0191);
    const branch = fn.match(/WHEN 'organizers' THEN[\s\S]*?(?=WHEN 'service_providers')/)?.[0] ?? '';
    expect(branch).toMatch(/WHERE NOT EXISTS \(\s*\n\s*SELECT 1 FROM public\.announcement_mutes mu\s*\n\s*WHERE mu\.user_id = m\.user_id AND mu\.group_id = m\.group_id\s*\n\s*\)/);
  });

  it('service_providers branch anti-joins announcement_mutes the same way, scoped to its own group_id only', () => {
    const fn = fnBody(m0191);
    const branch = fn.match(/WHEN 'service_providers' THEN[\s\S]*?END CASE;/)?.[0] ?? '';
    expect(branch).toMatch(/WHERE NOT EXISTS \(\s*\n\s*SELECT 1 FROM public\.announcement_mutes mu\s*\n\s*WHERE mu\.user_id = m\.user_id AND mu\.group_id = m\.group_id\s*\n\s*\)/);
  });

  it('each mute anti-join is scoped to m.group_id (the row\'s own matched group), so muting one group can never suppress the other', () => {
    const fn = fnBody(m0191);
    const organizersBranch = fn.match(/WHEN 'organizers' THEN[\s\S]*?(?=WHEN 'service_providers')/)?.[0] ?? '';
    const providersBranch = fn.match(/WHEN 'service_providers' THEN[\s\S]*?END CASE;/)?.[0] ?? '';
    // Neither branch's mute lookup hardcodes the OTHER audience's key --
    // it only ever compares against m.group_id, which JOIN already pinned
    // to this branch's own group.
    expect(organizersBranch).not.toMatch(/service_providers/);
    expect(providersBranch).not.toMatch(/'organizers'/);
  });

  it('Everyone mute behavior is defined EXPLICITLY: no announcement_mutes lookup at all for the everyone branch -- not an accidental omission', () => {
    const fn = fnBody(m0191);
    const everyoneBranch = fn.match(/WHEN 'everyone' THEN[\s\S]*?(?=WHEN 'organizers')/)?.[0] ?? '';
    expect(everyoneBranch).not.toMatch(/(?:FROM|JOIN)\s+public\.announcement_mutes/);
    expect(everyoneBranch).not.toMatch(/NOT EXISTS/);
    // The migration's own header comment must document this as a
    // deliberate design decision, not leave it unexplained.
    expect(m0191).toMatch(/For 'everyone', NO announcement_mutes lookup is performed at all/);
  });

  it('confirms the structural reason Everyone has no mute row to respect: announcement_groups has no \'everyone\' key, enforced by its own CHECK constraint (0189)', () => {
    expect(m0189).toMatch(/CONSTRAINT announcement_groups_key_check CHECK \(key IN \('organizers', 'service_providers'\)\)/);
    expect(m0189).not.toMatch(/'everyone'/);
  });
});

describe('0191: duplicate prevention -- a single INSERT ... SELECT per branch, no per-row loop that could double-insert', () => {
  it('each branch performs exactly one INSERT ... SELECT (set-based), not a loop or multiple INSERTs that could duplicate a recipient', () => {
    const fn = fnBody(m0191);
    expect(fn.match(/INSERT INTO public\.notifications/g)).toHaveLength(3);
    expect(fn).not.toMatch(/FOR \w+ IN/); // no PL/pgSQL per-row loop
    expect(fn).not.toMatch(/LOOP/);
  });

  it('announcement_group_members itself cannot contain a duplicate (group_id, user_id) pair for a branch to double-select, per 0189\'s own unique constraint', () => {
    expect(m0189).toMatch(/CONSTRAINT announcement_group_members_unique UNIQUE \(group_id, user_id\)/);
  });

  it('the everyone branch selects from public.users, whose primary key already guarantees one row per recipient', () => {
    const fn = fnBody(m0191);
    const everyoneBranch = fn.match(/WHEN 'everyone' THEN[\s\S]*?(?=WHEN 'organizers')/)?.[0] ?? '';
    expect(everyoneBranch).toMatch(/SELECT gen_random_uuid\(\), u\.id,/);
  });
});

describe('0191: audit logging and return shape', () => {
  it('logs exactly one admin_logs row per call, action announcement_sent, including audience/title/body/recipients', () => {
    const fn = fnBody(m0191);
    expect(fn.match(/INSERT INTO public\.admin_logs/g)).toHaveLength(1);
    expect(fn).toMatch(/'announcement_sent',/);
    expect(fn).toMatch(/jsonb_build_object\('audience', p_audience, 'title', v_title, 'body', v_body, 'recipients', v_count\)/);
  });

  it('the audit log insert happens after GET DIAGNOSTICS, so recipients reflects the actual INSERT row count, not a guess', () => {
    const fn = fnBody(m0191);
    const diagIdx = fn.indexOf('GET DIAGNOSTICS v_count = ROW_COUNT;');
    const logIdx = fn.indexOf('INSERT INTO public.admin_logs');
    expect(diagIdx).toBeGreaterThan(-1);
    expect(logIdx).toBeGreaterThan(diagIdx);
  });

  it('returns the same stable shape as admin_send_broadcast: {success: true, recipients: v_count}', () => {
    const fn = fnBody(m0191);
    expect(fn).toMatch(/RETURN jsonb_build_object\('success', true, 'recipients', v_count\);/);
  });
});

describe('0191: notification column shape matches admin_send_broadcast; type is decided deliberately per audience', () => {
  it('every branch inserts the same column set as admin_send_broadcast (id, user_id, type, title, body, read, icon, created_at)', () => {
    const fn = fnBody(m0191);
    const inserts = fn.match(/INSERT INTO public\.notifications \(id, user_id, type, title, body, read, icon, created_at\)/g) ?? [];
    expect(inserts).toHaveLength(3);
  });

  it('every branch uses read=false and icon=\'📢\', matching admin_send_broadcast\'s literals', () => {
    const fn = fnBody(m0191);
    expect(fn.match(/v_title, v_body, false, '📢', now\(\)/g)).toHaveLength(3);
  });

  it('everyone keeps type = \'broadcast\', byte-identical to admin_send_broadcast -- zero behavior change for the existing Everyone path', () => {
    const fn = fnBody(m0191);
    const everyoneBranch = fn.match(/WHEN 'everyone' THEN[\s\S]*?(?=WHEN 'organizers')/)?.[0] ?? '';
    expect(everyoneBranch).toMatch(/SELECT gen_random_uuid\(\), u\.id, 'broadcast', v_title, v_body, false, '📢', now\(\)/);
  });

  it('organizers and service_providers use a distinct type = \'announcement\', not \'broadcast\' -- a deliberate decision, not reused by accident', () => {
    const fn = fnBody(m0191);
    const organizersBranch = fn.match(/WHEN 'organizers' THEN[\s\S]*?(?=WHEN 'service_providers')/)?.[0] ?? '';
    const providersBranch = fn.match(/WHEN 'service_providers' THEN[\s\S]*?END CASE;/)?.[0] ?? '';
    expect(organizersBranch).toMatch(/SELECT gen_random_uuid\(\), m\.user_id, 'announcement', v_title, v_body, false, '📢', now\(\)/);
    expect(providersBranch).toMatch(/SELECT gen_random_uuid\(\), m\.user_id, 'announcement', v_title, v_body, false, '📢', now\(\)/);
    // Check the actual SQL (the SELECT list), not prose comments which may
    // legitimately mention 'broadcast' for contrast/explanation.
    expect(organizersBranch).not.toMatch(/SELECT gen_random_uuid\(\), m\.user_id, 'broadcast'/);
    expect(providersBranch).not.toMatch(/SELECT gen_random_uuid\(\), m\.user_id, 'broadcast'/);
  });

  it('exactly two distinct type literals are used in the three INSERT ... SELECT statements: \'broadcast\' once, \'announcement\' twice', () => {
    const fn = fnBody(m0191);
    const selectLines = fn.match(/SELECT gen_random_uuid\(\), [\w.]+, '(\w+)', v_title/g) ?? [];
    expect(selectLines).toHaveLength(3);
    const types = selectLines.map((l) => l.match(/'(\w+)', v_title/)?.[1]);
    expect(types.filter((t) => t === 'broadcast')).toHaveLength(1);
    expect(types.filter((t) => t === 'announcement')).toHaveLength(2);
  });

  it('the migration documents why the new type is safe for existing rendering and push delivery (TYPE_COLORS fallback, type-agnostic push cron)', () => {
    expect(m0191).toMatch(/TYPE_COLORS\['broadcast'\]/);
    expect(m0191).toMatch(/TYPE_COLORS\[notif\.type\]/);
    expect(m0191).toMatch(/ventsColors\.?\s*\n?--?\s*accent/);
    expect(m0191).toMatch(/push delivery is confirmed type-agnostic/);
  });
});

describe('0191: rate limiting -- bounded per admin, generous enough for legitimate use', () => {
  it('calls check_rate_limit once, keyed per admin caller (not per audience or content)', () => {
    const fn = fnBody(m0191);
    expect(fn.match(/public\.check_rate_limit\(/g)).toHaveLength(1);
    expect(fn).toMatch(/PERFORM public\.check_rate_limit\('admin_send_announcement:' \|\| v_admin_id::text, 10, 300\);/);
  });

  it('the rate-limit key does not vary by audience -- a single admin is limited across all three audiences combined, not separately per audience', () => {
    const fn = fnBody(m0191);
    const callLine = fn.match(/PERFORM public\.check_rate_limit\([^)]*\);/)?.[0] ?? '';
    expect(callLine).not.toMatch(/p_audience/);
  });

  it('the rate limit runs after authorization/validation and before any INSERT -- an unauthorized or invalid call never consumes a rate-limit slot', () => {
    const fn = fnBody(m0191);
    const authIdx = fn.indexOf('is_admin_or_root()');
    const validationIdx = fn.indexOf("length(v_body) > 500");
    const rateLimitIdx = fn.indexOf('check_rate_limit(');
    const firstInsertIdx = fn.indexOf('INSERT INTO public.notifications');
    expect(rateLimitIdx).toBeGreaterThan(authIdx);
    expect(rateLimitIdx).toBeGreaterThan(validationIdx);
    expect(firstInsertIdx).toBeGreaterThan(rateLimitIdx);
  });

  it('the limit (10 per 300s) is generous relative to send_event_announcement\'s own 1-per-900s, so a legitimate admin sending to all three audiences or re-sending a correction is never blocked', () => {
    expect(m0191).toMatch(/10 calls per 300-second window per admin/);
    // Sanity: 10 calls comfortably covers one send per audience (3) plus
    // room for corrections, well under the limit.
    const maxAudiences = 3;
    const comfortableRetries = 2;
    expect(10).toBeGreaterThanOrEqual(maxAudiences * (1 + comfortableRetries));
  });

  it('does not add a rate limit to admin_send_broadcast -- scope is limited to the new RPC only', () => {
    expect(m0191).not.toMatch(/CREATE (OR REPLACE )?FUNCTION public\.admin_send_broadcast/);
    expect(m0191).toMatch(/admin_send_broadcast\(\) itself has no rate limit at\s*\n-- all -- this migration does not add one there, only to the new RPC\./);
  });
});

describe('0191: Everyone audience includes every non-admin role (Sub-Admins, Organizers, Service Providers), excluding only role=\'admin\'', () => {
  it('the everyone filter is exactly role <> \'admin\' -- a plain negative check, not an allow-list that could accidentally omit a role', () => {
    const fn = fnBody(m0191);
    const everyoneBranch = fn.match(/WHEN 'everyone' THEN[\s\S]*?(?=WHEN 'organizers')/)?.[0] ?? '';
    expect(everyoneBranch).toMatch(/WHERE u\.role <> 'admin';/);
    // Not an IN(...) allow-list of specific roles, which could silently
    // drop a role this schema adds in the future.
    expect(everyoneBranch).not.toMatch(/role\s+IN\s*\(/);
  });

  it('is_organizer/is_service_provider flags never gate the everyone branch -- an organizer or service provider is still role=\'user\' underneath and is included', () => {
    const fn = fnBody(m0191);
    const everyoneBranch = fn.match(/WHEN 'everyone' THEN[\s\S]*?(?=WHEN 'organizers')/)?.[0] ?? '';
    expect(everyoneBranch).not.toMatch(/is_organizer/);
    expect(everyoneBranch).not.toMatch(/is_service_provider/);
  });

  it('sub-admin is an allowed users.role distinct from admin, and the everyone filter excludes only admin, so Sub-Admins are included', () => {
    // Derived from the migrations themselves (users_role_check and the
    // 0191 everyone branch), not from a hardcoded literal compared with
    // another literal.
    const dir = join(__dirname, '..', '..', 'supabase', 'migrations');
    const definitions = readdirSync(dir).filter((f) => f.endsWith('.sql'))
      .filter((f) => /ADD CONSTRAINT users_role_check/.test(readFileSync(join(dir, f), 'utf8')));
    // Defined once; nothing later redefines the allowed roles.
    expect(definitions).toEqual(['0005_primary_unique_check_constraints.sql']);
    const check = readFileSync(join(dir, definitions[0]), 'utf8').match(/users_role_check CHECK \(\(role = ANY \(ARRAY\[([^\]]+)\]/)?.[1] ?? '';
    const allowedRoles = [...check.matchAll(/'([^']+)'::text/g)].map((m) => m[1]);
    expect(allowedRoles).toContain('admin');
    expect(allowedRoles).toContain('sub-admin');

    const everyoneBranch = fnBody(m0191).match(/WHEN 'everyone' THEN[\s\S]*?(?=WHEN 'organizers')/)?.[0] ?? '';
    const excludedRoles = [...everyoneBranch.matchAll(/u\.role <> '([^']+)'/g)].map((m) => m[1]);
    expect(excludedRoles).toEqual(['admin']);
    const includedRoles = allowedRoles.filter((r) => !excludedRoles.includes(r));
    expect(includedRoles).toContain('sub-admin');
    expect(includedRoles).not.toContain('admin');
  });
});

describe('0191: grants -- EXECUTE revoked from PUBLIC/anon/ordinary client roles, granted only to the established admin-RPC set', () => {
  it('revokes ALL from PUBLIC, anon, and authenticated before granting anything back', () => {
    expect(m0191).toMatch(/REVOKE ALL ON FUNCTION public\.admin_send_announcement\(text, text, text\) FROM PUBLIC, anon, authenticated;/);
  });

  it('grants EXECUTE only to authenticated and project_admin -- the same shape admin_send_broadcast\\/admin_set_event_trending already use, not a wider or narrower set', () => {
    expect(m0191).toMatch(/GRANT EXECUTE ON FUNCTION public\.admin_send_announcement\(text, text, text\) TO authenticated, project_admin;/);
  });

  it('never grants EXECUTE to anon', () => {
    expect(m0191).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.admin_send_announcement.*TO[^;]*anon/);
  });

  it('is SECURITY DEFINER with an empty search_path, matching every other privileged function in this schema', () => {
    expect(m0191).toMatch(/SECURITY DEFINER\s*\n\s*SET search_path TO ''/);
  });
});
