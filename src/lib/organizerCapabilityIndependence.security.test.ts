import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression tests for the Multi-Role Account Architecture fix
// (0121_organizer_capability_independent_of_role.sql): users.role used to
// conflate the Organizer capability with staff tier (user/sub-admin/admin),
// so admin_set_user_role could silently discard Organizer status, and an
// Organizer could never also be a Sub-Admin. Organizer is now an
// independent boolean (is_organizer), mirroring how is_service_provider
// (0033) already worked -- role now represents staff tier only.
//
// Same static-analysis approach as the repo's other *.security.test.ts
// files: no live Postgres harness here (that verification was already done
// live via Supabase MCP against the real project before/after applying
// this migration -- see the deployment report). This asserts the fix is
// actually encoded in the source that ships.

let migration0121: string;

beforeAll(() => {
  const dir = join(__dirname, '..', '..', 'supabase', 'migrations');
  migration0121 = readFileSync(join(dir, '0121_organizer_capability_independent_of_role.sql'), 'utf8');
});

describe('is_organizer is an independent capability column, not a role value', () => {
  it('adds is_organizer as its own NOT NULL boolean column, mirroring is_service_provider', () => {
    expect(migration0121).toMatch(/ALTER TABLE public\.users ADD COLUMN IF NOT EXISTS is_organizer boolean NOT NULL DEFAULT false;/);
  });

  it('backfills is_organizer from the old conflated role value before clearing it -- no data loss', () => {
    expect(migration0121).toMatch(/UPDATE public\.users SET is_organizer = true WHERE role IN \('organizer', 'organiser'\);/);
    expect(migration0121).toMatch(/UPDATE public\.users SET role = 'user' WHERE role IN \('organizer', 'organiser'\);/);
  });

  it('protects the new column the same way is_service_provider is protected -- direct authenticated writes are blocked', () => {
    expect(migration0121).toMatch(/OLD\.is_organizer IS DISTINCT FROM NEW\.is_organizer THEN/);
    expect(migration0121).toMatch(/RAISE EXCEPTION 'is_organizer can only be changed via admin_set_organizer_capability\(\) or promote_to_organizer\(\)';/);
  });
});

describe('admin_set_organizer_capability: the sanctioned grant/revoke path', () => {
  it('is Super-Admin gated and never touches role', () => {
    const fn = migration0121.match(/CREATE OR REPLACE FUNCTION public\.admin_set_organizer_capability[\s\S]*?\$function\$;/)?.[0] ?? '';
    expect(fn).not.toBe('');
    expect(fn).toMatch(/IF NOT public\.is_super_admin\(\) THEN/);
    expect(fn).toMatch(/UPDATE public\.users SET is_organizer = p_enabled WHERE id = p_user_id;/);
    expect(fn).not.toMatch(/UPDATE public\.users SET role/);
  });

  it('is SECURITY DEFINER with an empty search_path (defense-in-depth against search_path hijacking)', () => {
    const fn = migration0121.match(/CREATE OR REPLACE FUNCTION public\.admin_set_organizer_capability[\s\S]*?\$function\$;/)?.[0] ?? '';
    expect(fn).toMatch(/SECURITY DEFINER/);
    expect(fn).toMatch(/SET search_path TO ''/);
  });
});

describe('admin_set_user_role: can no longer grant or revoke Organizer at all', () => {
  it('rejects "organizer" as a role value outright', () => {
    const fn = migration0121.match(/CREATE OR REPLACE FUNCTION public\.admin_set_user_role[\s\S]*?\$function\$;/)?.[0] ?? '';
    expect(fn).not.toBe('');
    expect(fn).toMatch(/ELSIF p_new_role <> 'user' THEN/);
    expect(fn).toMatch(/RAISE EXCEPTION 'Invalid role: %/);
  });

  it('only ever writes to role, never is_organizer -- a staff-tier change cannot touch the capability', () => {
    const fn = migration0121.match(/CREATE OR REPLACE FUNCTION public\.admin_set_user_role[\s\S]*?\$function\$;/)?.[0] ?? '';
    expect(fn).toMatch(/UPDATE public\.users SET role = p_new_role WHERE id = p_user_id;/);
    expect(fn).not.toMatch(/is_organizer/);
  });
});

describe('promote_to_organizer: item 11 -- a Sub-Admin cannot self-escalate via this endpoint', () => {
  it('blocks BOTH admin and sub-admin (the old body only blocked admin)', () => {
    const fn = migration0121.match(/CREATE OR REPLACE FUNCTION public\.promote_to_organizer\(\)[\s\S]*?\$function\$;/)?.[0] ?? '';
    expect(fn).not.toBe('');
    expect(fn).toMatch(/IF v_role IN \('admin', 'sub-admin'\) THEN/);
    expect(fn).toMatch(/RAISE EXCEPTION 'Staff accounts cannot self-promote via this endpoint';/);
  });

  it('sets is_organizer, never role, when it does grant the capability', () => {
    const fn = migration0121.match(/CREATE OR REPLACE FUNCTION public\.promote_to_organizer\(\)[\s\S]*?\$function\$;/)?.[0] ?? '';
    expect(fn).toMatch(/UPDATE public\.users SET is_organizer = true WHERE id = v_id;/);
  });
});

describe('is_organizer() helper reads the real capability column', () => {
  it('no longer reads the conflated role value', () => {
    const fn = migration0121.match(/CREATE OR REPLACE FUNCTION public\.is_organizer\(\)[\s\S]*?\$function\$;/)?.[0] ?? '';
    expect(fn).not.toBe('');
    expect(fn).toMatch(/is_organizer = true OR role = 'admin'/);
  });
});

describe('admin_decide_organizer_request: approval grants the capability unconditionally', () => {
  it('grants is_organizer regardless of the applicant\'s current staff tier', () => {
    const fn = migration0121.match(/CREATE OR REPLACE FUNCTION public\.admin_decide_organizer_request[\s\S]*?\$function\$;/)?.[0] ?? '';
    expect(fn).not.toBe('');
    expect(fn).toMatch(/UPDATE public\.users SET is_organizer = true WHERE id = v_user_id;/);
  });
});

describe('handle_new_user: signup-time organizer signal never violates NOT NULL', () => {
  it('COALESCEs the metadata check so a NULL raw_app_meta_data never produces a NULL is_organizer', () => {
    const fn = migration0121.match(/CREATE OR REPLACE FUNCTION public\.handle_new_user\(\)[\s\S]*?\$function\$;/)?.[0] ?? '';
    expect(fn).not.toBe('');
    expect(fn).toMatch(/v_is_organizer := COALESCE\(NEW\.raw_app_meta_data->>'role' = 'organizer', false\);/);
  });
});

describe('Frontend: Organizer status is read from the DB capability, never localStorage', () => {
  let appSrc: string;
  let profileScreenSrc: string;

  beforeAll(() => {
    appSrc = readFileSync(join(__dirname, '..', 'app', 'App.tsx'), 'utf8');
    profileScreenSrc = readFileSync(join(__dirname, '..', 'app', 'components', 'ProfileScreen.tsx'), 'utf8');
  });

  it('App.tsx no longer reads/writes the vents_was_organizer_ localStorage key', () => {
    expect(appSrc).not.toMatch(/vents_was_organizer_/);
  });

  it('ProfileScreen derives Organizer/Service Provider from the real DB fields, and "User" replaces "Member" for a plain account', () => {
    expect(profileScreenSrc).toMatch(/const isOrganizer = !!currentUser\?\.isOrganizer \|\| currentUser\?\.role === 'admin';/);
    expect(profileScreenSrc).toMatch(/const isServiceProvider = currentUser\?\.is_service_provider === true;/);
    expect(profileScreenSrc).not.toMatch(/'Member'/);
  });

  it('the role sync effect re-selects is_organizer alongside role/is_service_provider', () => {
    expect(appSrc).toMatch(/select\('role, is_service_provider, is_organizer'\)/);
  });
});
