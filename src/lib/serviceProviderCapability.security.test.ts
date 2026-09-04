import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// This repo has no live Postgres/RLS test harness (no pgTAP, no local
// Supabase instance wired into `npm test`) -- the only existing test file,
// ticketToken.test.ts, is a pure unit test and can't reach a real database
// either. So these are static-analysis tests: they assert the security
// boundary is actually *encoded* in the migration SQL that ships to
// production, rather than exercising it against a live database. That
// still catches the failure modes that matter here: someone deleting the
// protection trigger, widening a GRANT, or dropping the is_super_admin()
// check would fail one of these.

let sp033: string;
let orgTriggers0009: string;
let orgFunctions0004: string;

beforeAll(() => {
  const migrationsDir = join(__dirname, '..', '..', 'supabase', 'migrations');
  sp033 = readFileSync(join(migrationsDir, '0033_service_provider_capability.sql'), 'utf8');
  orgTriggers0009 = readFileSync(join(migrationsDir, '0009_triggers.sql'), 'utf8');
  orgFunctions0004 = readFileSync(join(migrationsDir, '0004_functions.sql'), 'utf8');
});

describe('service provider capability: security boundary (0033)', () => {
  it('a normal authenticated user cannot directly set is_service_provider = true', () => {
    // The protection trigger must exist, be BEFORE UPDATE on users, and
    // must raise for `authenticated` when is_service_provider changes --
    // this is what blocks a plain client-side `.update({ is_service_provider: true })`
    // even though update_own_user (auth.uid() = id) would otherwise allow it.
    expect(sp033).toMatch(/CREATE OR REPLACE FUNCTION public\.protect_capability_columns/);
    expect(sp033).toMatch(/IF current_user <> 'authenticated' THEN RETURN NEW; END IF;/);
    expect(sp033).toMatch(/IF OLD\.is_service_provider IS DISTINCT FROM NEW\.is_service_provider THEN\s*\n\s*RAISE EXCEPTION/);
    expect(sp033).toMatch(/CREATE TRIGGER trg_protect_capability_columns BEFORE UPDATE ON public\.users FOR EACH ROW EXECUTE FUNCTION public\.protect_capability_columns\(\);/);

    // The trigger function must actually be able to fire for `authenticated`
    // updates -- a missing EXECUTE grant would silently disable it.
    expect(sp033).toMatch(/GRANT EXECUTE ON FUNCTION public\.protect_capability_columns\(\) TO anon, authenticated, project_admin;/);
  });

  it('the approved admin RPC path can grant the capability', () => {
    // admin_set_service_provider_capability must exist, be SECURITY DEFINER
    // (so it can bypass the trigger's `authenticated` check by running as
    // its owner), gate on is_super_admin(), and perform the UPDATE + audit
    // log -- this is the only sanctioned write path.
    expect(sp033).toMatch(/CREATE OR REPLACE FUNCTION public\.admin_set_service_provider_capability\(p_user_id uuid, p_enabled boolean\)/);
    expect(sp033).toMatch(/SECURITY DEFINER/);
    expect(sp033).toMatch(/IF NOT public\.is_super_admin\(\) THEN\s*\n\s*RAISE EXCEPTION/);
    expect(sp033).toMatch(/UPDATE public\.users SET is_service_provider = p_enabled WHERE id = p_user_id;/);
    expect(sp033).toMatch(/INSERT INTO public\.admin_logs/);

    // Only `authenticated` (gated internally by is_super_admin()) and
    // project_admin get EXECUTE -- anon must never be able to call this.
    const grantLine = sp033.match(/GRANT EXECUTE ON FUNCTION public\.admin_set_service_provider_capability[^;]*;/)?.[0] ?? '';
    expect(grantLine).toContain('authenticated');
    expect(grantLine).toContain('project_admin');
    expect(grantLine).not.toContain('anon');
  });

  it('is_service_provider is additive and independent of the role column', () => {
    // Guards against a future edit accidentally folding this into `role`
    // or removing the safe default for existing rows.
    expect(sp033).toMatch(/ALTER TABLE public\.users ADD COLUMN IF NOT EXISTS is_service_provider boolean NOT NULL DEFAULT false;/);
    expect(sp033).not.toMatch(/ALTER TABLE public\.users[^;]*DROP COLUMN[^;]*role/);
    expect(sp033).not.toMatch(/service_provider'::text.*role|role.*=.*'service_provider'/);
  });
});

describe('existing organizer role protection still works (0004 / 0009, untouched by 0033)', () => {
  it('check_user_role_update() still blocks a plain authenticated role change', () => {
    expect(orgFunctions0004).toMatch(/CREATE OR REPLACE FUNCTION public\.check_user_role_update/);
    expect(orgFunctions0004).toMatch(/RAISE EXCEPTION/);
  });

  it('the organizer role-protection trigger is still wired up on users', () => {
    expect(orgTriggers0009).toMatch(/CREATE TRIGGER trg_check_user_role_update BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION check_user_role_update\(\);/);
  });

  it('0033 does not modify check_user_role_update or its trigger', () => {
    expect(sp033).not.toMatch(/CREATE OR REPLACE FUNCTION public\.check_user_role_update/);
    expect(sp033).not.toMatch(/DROP TRIGGER[^;]*trg_check_user_role_update/);
    expect(sp033).not.toMatch(/DROP FUNCTION[^;]*check_user_role_update/);
  });
});
