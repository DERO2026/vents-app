import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Finding N2 (owner-authorized 2026-11-26): staff accounts (root, admin,
// sub-admin) must not gain organizer tools through ordinary-user role
// selection, enforced on the server. Migration 0232. Behaviour is proven on a
// real PostgreSQL by scripts/local-pg-test/run-signup-role-staff-guard-
// verification.sh (with mutation runs); these static guards keep it in CI.

const root = join(__dirname, '..', '..');
const migDir = join(root, 'supabase', 'migrations');
let m: string; let undo: string;

beforeAll(() => {
  m = readFileSync(join(migDir, '0232_signup_role_staff_guard.sql'), 'utf8');
  undo = readFileSync(join(root, 'supabase', 'rollback', 'undo_0232.sql'), 'utf8');
});

describe('0232: set_signup_role refuses every staff account on the server', () => {
  it('refuses root (is_admin includes is_root), admin and sub-admin when selecting Organizer', () => {
    expect(m).toContain("IF p_role = 'organizer' AND (public.is_admin() OR v_current_role IN ('admin', 'sub-admin')) THEN");
    expect(m).toContain('Staff accounts cannot turn on organizer tools here');
  });

  it('is_admin() really covers root and both staff roles (latest definition)', () => {
    let def = '';
    for (const f of readdirSync(migDir).filter((x) => x.endsWith('.sql') && x < '0232').sort()) {
      const t = readFileSync(join(migDir, f), 'utf8');
      const i = t.lastIndexOf('CREATE OR REPLACE FUNCTION public.is_admin()');
      if (i >= 0) def = t.slice(i, t.indexOf('$function$', t.indexOf('AS $function$', i) + 13));
    }
    expect(def).toContain('public.is_root()');
    expect(def).toContain("role IN ('admin', 'sub-admin')");
  });

  it('keeps D1a: ordinary users are not refused and no approval step is added', () => {
    expect(m).not.toMatch(/organizer_requests/);
    expect(m).not.toMatch(/UPDATE public\.users/);
    expect(m).not.toMatch(/GRANT|REVOKE/);
  });

  it('is an in-place patch that refuses drift and a second run, with an exact, gated undo', () => {
    expect(m).toContain('not the expected version');
    expect(m).toContain('already patched; refusing to run twice');
    expect(undo).toContain("'undo-0232'");
    expect(undo).toContain('does not carry 0232 patch');
  });

  it('the app never offers staff a client-side path that bypasses the server', () => {
    const sheet = readFileSync(join(root, 'src', 'app', 'components', 'work', 'OrganizerRequestSheet.tsx'), 'utf8');
    expect(sheet).not.toMatch(/rpc\(\s*'(promote_to_organizer|admin_set_organizer_capability)'/);
    expect(sheet).not.toMatch(/from\(\s*'users'\s*\)[\s\S]*update/);
    expect(sheet).toContain("supabase.rpc('set_signup_role' as any, { p_role: 'organizer' })");
  });

  it('has a database verification suite', () => {
    expect(existsSync(join(root, 'scripts', 'local-pg-test', 'run-signup-role-staff-guard-verification.sh'))).toBe(true);
  });
});
