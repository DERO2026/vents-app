import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression/structure tests for
// 0189_announcement_groups_schema_foundation.sql -- the Broadcast Center's
// schema foundation (announcement_groups, announcement_group_members,
// announcement_mutes). Schema only, per this task's scope: no membership
// trigger, no new broadcast RPC, no UI, and migration 0188/the existing
// broadcast RPCs are untouched.
//
// Static-text assertions against the migration file itself (same
// convention as every other *.security.test.ts in this repo for an
// unapplied migration), since 0189 has not been applied to any database.

let m0189: string;

beforeAll(() => {
  m0189 = readFileSync(
    join(__dirname, '..', '..', 'supabase', 'migrations', '0189_announcement_groups_schema_foundation.sql'),
    'utf8'
  );
});

describe('0189: does not touch migration 0188 or the existing broadcast RPCs', () => {
  it('does not define, replace, or alter admin_send_broadcast or admin_broadcast (a comment mentioning them for context is fine)', () => {
    expect(m0189).not.toMatch(/CREATE (OR REPLACE )?FUNCTION public\.admin_(send_)?broadcast/);
    expect(m0189).not.toMatch(/ALTER FUNCTION public\.admin_(send_)?broadcast/);
    expect(m0189).not.toMatch(/DROP FUNCTION public\.admin_(send_)?broadcast/);
  });

  it('defines no function at all -- schema (tables/RLS/grants/seed/backfill) only', () => {
    expect(m0189).not.toMatch(/CREATE (OR REPLACE )?FUNCTION/);
  });
});

describe('0189: announcement_groups -- fixed catalog, Everyone is not a row', () => {
  it('creates the table with a key column constrained to exactly organizers/service_providers', () => {
    expect(m0189).toMatch(/CREATE TABLE public\.announcement_groups \(/);
    expect(m0189).toMatch(/CONSTRAINT announcement_groups_key_check CHECK \(key IN \('organizers', 'service_providers'\)\)/);
  });

  it('does not add an "everyone" row or key -- Everyone stays notification-only, not a group', () => {
    expect(m0189).not.toMatch(/'everyone'/);
  });

  it('key has a UNIQUE constraint, making the idempotent seed possible', () => {
    expect(m0189).toMatch(/CONSTRAINT announcement_groups_key_unique UNIQUE \(key\)/);
  });

  it('seeds both fixed groups idempotently via ON CONFLICT (key) DO NOTHING', () => {
    expect(m0189).toMatch(/INSERT INTO public\.announcement_groups \(key, label\) VALUES\s*\n\s*\('organizers', 'Organizers'\),\s*\n\s*\('service_providers', 'Service Providers'\)\s*\n\s*ON CONFLICT \(key\) DO NOTHING;/);
  });

  it('RLS: any authenticated user may SELECT (non-sensitive catalog); only is_admin() may write', () => {
    expect(m0189).toMatch(/CREATE POLICY select_announcement_groups ON public\.announcement_groups\s*\n\s*FOR SELECT TO authenticated\s*\n\s*USING \(true\);/);
    expect(m0189).toMatch(/CREATE POLICY admin_write_announcement_groups ON public\.announcement_groups\s*\n\s*FOR ALL TO authenticated\s*\n\s*USING \(public\.is_admin\(\)\)\s*\n\s*WITH CHECK \(public\.is_admin\(\)\);/);
  });

  it('RLS is enabled on the table', () => {
    expect(m0189).toMatch(/ALTER TABLE public\.announcement_groups ENABLE ROW LEVEL SECURITY;/);
  });
});

describe('0189: announcement_group_members -- no client write permissions at all', () => {
  it('creates the table referencing announcement_groups and users, with a unique (group_id, user_id) pair', () => {
    expect(m0189).toMatch(/CREATE TABLE public\.announcement_group_members \(/);
    expect(m0189).toMatch(/group_id uuid NOT NULL REFERENCES public\.announcement_groups\(id\) ON DELETE CASCADE/);
    expect(m0189).toMatch(/user_id uuid NOT NULL REFERENCES public\.users\(id\) ON DELETE CASCADE/);
    expect(m0189).toMatch(/CONSTRAINT announcement_group_members_unique UNIQUE \(group_id, user_id\)/);
  });

  it('RLS is enabled, and the only policy defined is SELECT (own row or admin) -- no INSERT/UPDATE/DELETE policy exists at all', () => {
    expect(m0189).toMatch(/ALTER TABLE public\.announcement_group_members ENABLE ROW LEVEL SECURITY;/);
    const section = m0189.slice(
      m0189.indexOf('CREATE TABLE public.announcement_group_members'),
      m0189.indexOf('-- ── announcement_mutes')
    );
    const policyMatches = section.match(/CREATE POLICY \w+ ON public\.announcement_group_members/g) ?? [];
    expect(policyMatches).toHaveLength(1);
    expect(section).toMatch(/CREATE POLICY select_announcement_group_members ON public\.announcement_group_members\s*\n\s*FOR SELECT TO authenticated\s*\n\s*USING \(user_id = \(SELECT auth\.uid\(\)\) OR public\.is_admin\(\)\);/);
    expect(section).not.toMatch(/FOR INSERT/);
    expect(section).not.toMatch(/FOR UPDATE/);
    expect(section).not.toMatch(/FOR DELETE/);
    expect(section).not.toMatch(/FOR ALL/);
  });

  it('REVOKEs the platform default grant, then grants `authenticated` SELECT only -- no INSERT/UPDATE/DELETE grant to authenticated or anon', () => {
    const section = m0189.slice(
      m0189.indexOf('CREATE TABLE public.announcement_group_members'),
      m0189.indexOf('-- ── announcement_mutes')
    );
    expect(section).toMatch(/REVOKE ALL ON public\.announcement_group_members FROM PUBLIC, anon, authenticated;/);
    expect(section).toMatch(/GRANT SELECT ON public\.announcement_group_members TO authenticated;/);
    // The only other GRANT in this section must be to project_admin, and it
    // must come after the REVOKE ALL (so it is additive on top of a clean
    // slate, not a grant that a later REVOKE narrows).
    const revokeIdx = section.indexOf('REVOKE ALL ON public.announcement_group_members');
    const grantMatches = [...section.matchAll(/GRANT [A-Z, ]+ ON public\.announcement_group_members TO (\w+);/g)];
    expect(grantMatches.length).toBeGreaterThan(0);
    for (const m of grantMatches) {
      expect(section.indexOf(m[0])).toBeGreaterThan(revokeIdx);
      expect(['authenticated', 'project_admin']).toContain(m[1]);
    }
    expect(section).not.toMatch(/GRANT [A-Z, ]*INSERT[A-Z, ]* ON public\.announcement_group_members TO authenticated;/);
    expect(section).not.toMatch(/GRANT [A-Z, ]*UPDATE[A-Z, ]* ON public\.announcement_group_members TO authenticated;/);
    expect(section).not.toMatch(/GRANT [A-Z, ]*DELETE[A-Z, ]* ON public\.announcement_group_members TO authenticated;/);
    expect(section).not.toMatch(/TO anon;/);
  });

  it('backfills membership from users.is_organizer and users.is_service_provider, idempotently, without writing to the users table', () => {
    expect(m0189).toMatch(/JOIN public\.announcement_groups g ON g\.key = 'organizers'\s*\n\s*WHERE u\.is_organizer = true\s*\n\s*ON CONFLICT \(group_id, user_id\) DO NOTHING;/);
    expect(m0189).toMatch(/JOIN public\.announcement_groups g ON g\.key = 'service_providers'\s*\n\s*WHERE u\.is_service_provider = true\s*\n\s*ON CONFLICT \(group_id, user_id\) DO NOTHING;/);
    expect(m0189).not.toMatch(/UPDATE public\.users/);
  });

  it('has indexes on both foreign-key columns', () => {
    expect(m0189).toMatch(/CREATE INDEX idx_announcement_group_members_user_id ON public\.announcement_group_members\(user_id\);/);
    expect(m0189).toMatch(/CREATE INDEX idx_announcement_group_members_group_id ON public\.announcement_group_members\(group_id\);/);
  });
});

describe('0189: announcement_mutes -- independent per-user, per-group mute preferences', () => {
  it('creates the table with a unique (user_id, group_id) pair, referencing users and announcement_groups', () => {
    expect(m0189).toMatch(/CREATE TABLE public\.announcement_mutes \(/);
    expect(m0189).toMatch(/CONSTRAINT announcement_mutes_unique UNIQUE \(user_id, group_id\)/);
  });

  it('RLS: a user manages only their own mute rows (SELECT/INSERT/DELETE), admins get read-only visibility, nobody gets UPDATE', () => {
    expect(m0189).toMatch(/CREATE POLICY select_announcement_mutes ON public\.announcement_mutes\s*\n\s*FOR SELECT TO authenticated\s*\n\s*USING \(user_id = \(SELECT auth\.uid\(\)\) OR public\.is_admin\(\)\);/);
    expect(m0189).toMatch(/CREATE POLICY insert_announcement_mutes ON public\.announcement_mutes\s*\n\s*FOR INSERT TO authenticated\s*\n\s*WITH CHECK \(user_id = \(SELECT auth\.uid\(\)\)\);/);
    expect(m0189).toMatch(/CREATE POLICY delete_announcement_mutes ON public\.announcement_mutes\s*\n\s*FOR DELETE TO authenticated\s*\n\s*USING \(user_id = \(SELECT auth\.uid\(\)\)\);/);
    const section = m0189.slice(m0189.indexOf('CREATE TABLE public.announcement_mutes'));
    expect(section).not.toMatch(/FOR UPDATE/);
  });

  it('REVOKEs the platform default grant, then grants authenticated SELECT/INSERT/DELETE only -- no UPDATE grant to authenticated', () => {
    const section = m0189.slice(m0189.indexOf('CREATE TABLE public.announcement_mutes'));
    expect(section).toMatch(/REVOKE ALL ON public\.announcement_mutes FROM PUBLIC, anon, authenticated;/);
    expect(section).toMatch(/GRANT SELECT, INSERT, DELETE ON public\.announcement_mutes TO authenticated;/);
    expect(section).not.toMatch(/GRANT [A-Z, ]*UPDATE[A-Z, ]* ON public\.announcement_mutes TO authenticated;/);
  });

  it('is a structurally separate table from announcement_group_members (not a shared column or JSON blob) -- muting one group cannot affect another', () => {
    // Two independent tables with their own PK/unique constraints, not a
    // `muted boolean` column bolted onto announcement_group_members.
    expect(m0189.match(/CREATE TABLE public\.announcement_mutes/g)).toHaveLength(1);
    expect(m0189).not.toMatch(/ALTER TABLE public\.announcement_group_members ADD COLUMN/);
  });

  it('has indexes on both foreign-key columns', () => {
    expect(m0189).toMatch(/CREATE INDEX idx_announcement_mutes_user_id ON public\.announcement_mutes\(user_id\);/);
    expect(m0189).toMatch(/CREATE INDEX idx_announcement_mutes_group_id ON public\.announcement_mutes\(group_id\);/);
  });
});

describe('0189: every new table explicitly revokes the platform default grant before granting anything back', () => {
  it('REVOKE ALL ... FROM PUBLIC, anon, authenticated appears exactly once per table, before any GRANT on that table', () => {
    for (const table of ['announcement_groups', 'announcement_group_members', 'announcement_mutes']) {
      const revokePattern = new RegExp(`REVOKE ALL ON public\\.${table} FROM PUBLIC, anon, authenticated;`, 'g');
      const matches = m0189.match(revokePattern) ?? [];
      expect(matches).toHaveLength(1);
    }
  });

  it('no table grants anything to anon', () => {
    expect(m0189).not.toMatch(/GRANT [A-Z, ]+ ON public\.announcement_\w+ TO anon;/);
  });
});
