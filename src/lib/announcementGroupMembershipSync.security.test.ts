import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression/structure tests for
// 0190_announcement_group_membership_sync.sql -- the Broadcast Center's
// automatic announcement-group membership sync (Phase 2, on top of 0189's
// schema). Source + tests only, per this task's scope: 0190 has not been
// applied to any database. Does not modify 0189, protect_capability_
// columns(), or either broadcast RPC.
//
// Static-text assertions against the migration file itself (same
// convention as every other *.security.test.ts in this repo for an
// unapplied migration).

let m0190: string;
let m0189: string;

beforeAll(() => {
  const dir = join(__dirname, '..', '..', 'supabase', 'migrations');
  m0190 = readFileSync(join(dir, '0190_announcement_group_membership_sync.sql'), 'utf8');
  m0189 = readFileSync(join(dir, '0189_announcement_groups_schema_foundation.sql'), 'utf8');
});

function fnBody(src: string, name: string): string {
  return src.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\(\\)[\\s\\S]*?\\$function\\$;`))?.[0] ?? '';
}

describe('0190: does not modify 0189, protect_capability_columns(), or either broadcast RPC', () => {
  it('0189\'s own file is untouched by this task (sanity check against the real file on disk)', () => {
    expect(m0189).toMatch(/CREATE TABLE public\.announcement_groups \(/);
    expect(m0189).toMatch(/CREATE TABLE public\.announcement_group_members \(/);
    expect(m0189).toMatch(/CREATE TABLE public\.announcement_mutes \(/);
  });

  it('0190 does not define, replace, or alter protect_capability_columns()', () => {
    expect(m0190).not.toMatch(/CREATE (OR REPLACE )?FUNCTION public\.protect_capability_columns/);
    expect(m0190).not.toMatch(/ALTER FUNCTION public\.protect_capability_columns/);
    expect(m0190).not.toMatch(/DROP (FUNCTION|TRIGGER).*protect_capability_columns/);
  });

  it('0190 does not define, replace, or alter admin_send_broadcast or admin_broadcast', () => {
    expect(m0190).not.toMatch(/CREATE (OR REPLACE )?FUNCTION public\.admin_(send_)?broadcast/);
    expect(m0190).not.toMatch(/ALTER FUNCTION public\.admin_(send_)?broadcast/);
  });

  it('0190 does not CREATE/ALTER/DROP any announcement_* table, policy, or grant -- schema stays exactly as 0189 left it', () => {
    expect(m0190).not.toMatch(/CREATE TABLE/);
    expect(m0190).not.toMatch(/ALTER TABLE/);
    expect(m0190).not.toMatch(/CREATE POLICY/);
    expect(m0190).not.toMatch(/DROP POLICY/);
    expect(m0190).not.toMatch(/\bGRANT\b/);
    expect(m0190).not.toMatch(/\bREVOKE\b.*announcement_group_members\b/);
  });
});

describe('0190: never grants clients direct write access to announcement_group_members', () => {
  it('defines exactly one new function, as a trigger function (RETURNS trigger), not a callable RPC', () => {
    const fn = fnBody(m0190, 'sync_announcement_group_membership');
    expect(fn).not.toBe('');
    expect(fn).toMatch(/RETURNS trigger/);
    expect(m0190.match(/CREATE (OR REPLACE )?FUNCTION/g)).toHaveLength(1);
  });

  it('is SECURITY DEFINER with an empty search_path -- the only way it can legitimately write to a table with no client grant', () => {
    const fn = fnBody(m0190, 'sync_announcement_group_membership');
    expect(fn).toMatch(/SECURITY DEFINER\s*\n\s*SET search_path TO ''/);
  });

  it('explicitly revokes EXECUTE from every client-reachable role, foreclosing any future attempt to call it as an RPC', () => {
    expect(m0190).toMatch(/REVOKE ALL ON FUNCTION public\.sync_announcement_group_membership\(\) FROM PUBLIC, anon, authenticated, project_admin;/);
  });

  it('writes only to public.announcement_group_members, and reads only public.announcement_groups -- touches no other table', () => {
    const fn = fnBody(m0190, 'sync_announcement_group_membership');
    const writeTargets = [...fn.matchAll(/(?:INSERT INTO|DELETE FROM|UPDATE)\s+public\.(\w+)/g)].map((m) => m[1]);
    expect(new Set(writeTargets)).toEqual(new Set(['announcement_group_members']));
    const readTargets = [...fn.matchAll(/(?<!DELETE )FROM\s+public\.(\w+)/g)].map((m) => m[1]);
    expect(new Set(readTargets)).toEqual(new Set(['announcement_groups']));
  });
});

describe('0190: grant transitions -- is_organizer', () => {
  it('on is_organizer flipping to true, inserts into announcement_group_members for the organizers group, idempotently', () => {
    const fn = fnBody(m0190, 'sync_announcement_group_membership');
    expect(fn).toMatch(/IF OLD\.is_organizer IS DISTINCT FROM NEW\.is_organizer THEN\s*\n\s*IF NEW\.is_organizer THEN\s*\n\s*INSERT INTO public\.announcement_group_members \(group_id, user_id\)\s*\n\s*SELECT g\.id, NEW\.id\s*\n\s*FROM public\.announcement_groups g\s*\n\s*WHERE g\.key = 'organizers'\s*\n\s*ON CONFLICT \(group_id, user_id\) DO NOTHING;/);
  });

  it('on is_organizer flipping to false, deletes the organizers-group membership row', () => {
    const fn = fnBody(m0190, 'sync_announcement_group_membership');
    expect(fn).toMatch(/ELSE\s*\n\s*DELETE FROM public\.announcement_group_members\s*\n\s*WHERE user_id = NEW\.id\s*\n\s*AND group_id IN \(SELECT id FROM public\.announcement_groups WHERE key = 'organizers'\);/);
  });
});

describe('0190: grant/revoke transitions -- is_service_provider', () => {
  it('on is_service_provider flipping to true, inserts into announcement_group_members for the service_providers group, idempotently', () => {
    const fn = fnBody(m0190, 'sync_announcement_group_membership');
    expect(fn).toMatch(/IF OLD\.is_service_provider IS DISTINCT FROM NEW\.is_service_provider THEN\s*\n\s*IF NEW\.is_service_provider THEN\s*\n\s*INSERT INTO public\.announcement_group_members \(group_id, user_id\)\s*\n\s*SELECT g\.id, NEW\.id\s*\n\s*FROM public\.announcement_groups g\s*\n\s*WHERE g\.key = 'service_providers'\s*\n\s*ON CONFLICT \(group_id, user_id\) DO NOTHING;/);
  });

  it('on is_service_provider flipping to false, deletes the service_providers-group membership row', () => {
    const fn = fnBody(m0190, 'sync_announcement_group_membership');
    expect(fn).toMatch(/ELSE\s*\n\s*DELETE FROM public\.announcement_group_members\s*\n\s*WHERE user_id = NEW\.id\s*\n\s*AND group_id IN \(SELECT id FROM public\.announcement_groups WHERE key = 'service_providers'\);/);
  });
});

describe('0190: simultaneous changes -- both flags in one UPDATE', () => {
  it('the function body evaluates both IS DISTINCT FROM checks independently in the same invocation, not an if/elseif that would skip one', () => {
    const fn = fnBody(m0190, 'sync_announcement_group_membership');
    const organizerIdx = fn.indexOf("OLD.is_organizer IS DISTINCT FROM NEW.is_organizer");
    const providerIdx = fn.indexOf("OLD.is_service_provider IS DISTINCT FROM NEW.is_service_provider");
    expect(organizerIdx).toBeGreaterThan(-1);
    expect(providerIdx).toBeGreaterThan(organizerIdx);
    // Two separate top-level IF blocks, not one IF ... ELSIF ... chain that
    // would only ever run one branch.
    expect(fn).not.toMatch(/ELSIF/i);
    expect(fn.match(/^\s*IF OLD\.is_(organizer|service_provider) IS DISTINCT FROM/gm)).toHaveLength(2);
  });

  it('the trigger fires on UPDATE OF both columns and its WHEN clause checks both independently (OR, not XOR/AND)', () => {
    expect(m0190).toMatch(/AFTER UPDATE OF is_organizer, is_service_provider ON public\.users/);
    expect(m0190).toMatch(/WHEN \(OLD\.is_organizer IS DISTINCT FROM NEW\.is_organizer OR OLD\.is_service_provider IS DISTINCT FROM NEW\.is_service_provider\)/);
  });
});

describe('0190: duplicate prevention / idempotency', () => {
  it('every INSERT uses ON CONFLICT (group_id, user_id) DO NOTHING, matching 0189\'s unique constraint exactly', () => {
    const fn = fnBody(m0190, 'sync_announcement_group_membership');
    const inserts = fn.match(/INSERT INTO public\.announcement_group_members/g) ?? [];
    const onConflicts = fn.match(/ON CONFLICT \(group_id, user_id\) DO NOTHING;/g) ?? [];
    expect(inserts.length).toBeGreaterThan(0);
    expect(onConflicts).toHaveLength(inserts.length);
    expect(m0189).toMatch(/CONSTRAINT announcement_group_members_unique UNIQUE \(group_id, user_id\)/);
  });

  it('no INSERT in this function omits ON CONFLICT (no bare INSERT that could raise a duplicate-key error on re-fire)', () => {
    const fn = fnBody(m0190, 'sync_announcement_group_membership');
    const bareInsertBlocks = fn.match(/INSERT INTO public\.announcement_group_members[\s\S]*?;/g) ?? [];
    for (const block of bareInsertBlocks) {
      expect(block).toMatch(/ON CONFLICT/);
    }
  });
});

describe('0190: safe when a group is missing', () => {
  it('every INSERT sources the group id via a SELECT ... WHERE key = ..., which yields zero rows (safe no-op) if that group row does not exist -- no RAISE/error path for a missing group', () => {
    const fn = fnBody(m0190, 'sync_announcement_group_membership');
    expect(fn).not.toMatch(/RAISE EXCEPTION/);
    expect(fn).toMatch(/FROM public\.announcement_groups g\s*\n\s*WHERE g\.key = 'organizers'/);
    expect(fn).toMatch(/FROM public\.announcement_groups g\s*\n\s*WHERE g\.key = 'service_providers'/);
  });

  it('every DELETE\'s group_id subquery likewise yields zero matching ids (deletes nothing) if that group row does not exist', () => {
    const fn = fnBody(m0190, 'sync_announcement_group_membership');
    expect(fn).toMatch(/group_id IN \(SELECT id FROM public\.announcement_groups WHERE key = 'organizers'\)/);
    expect(fn).toMatch(/group_id IN \(SELECT id FROM public\.announcement_groups WHERE key = 'service_providers'\)/);
  });
});

describe('0190: trigger security -- preserves protect_capability_columns() and cannot be reached by direct client action', () => {
  it('is a NEW, separate AFTER trigger -- does not CREATE/DROP/replace the existing BEFORE guard trigger (a comment mentioning it for context is fine)', () => {
    expect(m0190).not.toMatch(/CREATE TRIGGER trg_protect_capability_columns/);
    expect(m0190).not.toMatch(/DROP TRIGGER.*trg_protect_capability_columns/);
    expect(m0190).toMatch(/CREATE TRIGGER trg_sync_announcement_group_membership/);
    expect(m0190).toMatch(/AFTER UPDATE OF is_organizer, is_service_provider ON public\.users/);
  });

  it('fires AFTER, so the pre-existing BEFORE UPDATE guard (protect_capability_columns) still runs first and can still block the write entirely for the authenticated role', () => {
    // Confirms this migration's own trigger is declared AFTER, not BEFORE
    // or INSTEAD OF -- Postgres always runs BEFORE triggers on the same
    // event before AFTER triggers, so an unchanged BEFORE guard trigger
    // elsewhere in the schema is unaffected by this one's existence.
    expect(m0190).toMatch(/CREATE TRIGGER trg_sync_announcement_group_membership\s*\n\s*AFTER UPDATE OF/);
    expect(m0190).not.toMatch(/CREATE TRIGGER trg_sync_announcement_group_membership\s*\n\s*BEFORE/);
    expect(m0190).not.toMatch(/INSTEAD OF/);
  });

  it('the trigger is FOR EACH ROW (not FOR EACH STATEMENT), so OLD/NEW are available and correct per affected row', () => {
    expect(m0190).toMatch(/FOR EACH ROW/);
  });

  it('every write happens inside the SECURITY DEFINER trigger function body -- a client role is never the effective writer of announcement_group_members, only the trigger mechanism is', () => {
    const fn = fnBody(m0190, 'sync_announcement_group_membership');
    expect(fn).toMatch(/SECURITY DEFINER/);
    // Every INSERT/DELETE in the file lives inside this one function's body.
    const allWrites = [...m0190.matchAll(/(?:INSERT INTO|DELETE FROM) public\.announcement_group_members/g)];
    const fnStart = m0190.indexOf(fn);
    const fnEnd = fnStart + fn.length;
    for (const w of allWrites) {
      expect(w.index).toBeGreaterThanOrEqual(fnStart);
      expect(w.index).toBeLessThan(fnEnd);
    }
  });
});
