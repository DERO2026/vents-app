import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Static-analysis test for 0119_fix_organizer_wallets_admin_self_write.sql.
//
// Admin Console security audit found organizer_wallets_admin_write was
// `FOR ALL ... USING (is_admin()) WITH CHECK (is_admin())`, scoped to
// {public}, with no exclusion for the admin's own row -- letting an admin
// directly UPDATE their own organizer_wallets row via the table API,
// bypassing admin_credit_vents_cents/admin_debit_vents_cents's self-credit
// guard (0095), the double-credit fix (0096), and the admin_logs audit
// trail those RPCs write.
//
// Live verification note (not re-testable from vitest): reproduced in a
// rolled-back transaction against project slrtjxtzhowhwhebjprv with
// synthetic accounts -- after this fix, an admin's UPDATE to their own row
// left balance_kobo unchanged (blocked), while the same admin's UPDATE to
// a DIFFERENT organizer's row succeeded (legitimate admin management
// preserved). Separately confirmed that `authenticated` currently has no
// UPDATE/INSERT grant on this table at all (SELECT only), which
// independently blocks any direct write today regardless of RLS content --
// this fix is still correct defense-in-depth so the RLS policy itself
// matches the intended security model if that grant is ever added.

let sql: string;

beforeAll(() => {
  sql = readFileSync(
    join(__dirname, '../../supabase/migrations/0119_fix_organizer_wallets_admin_self_write.sql'),
    'utf8'
  );
});

describe('0119_fix_organizer_wallets_admin_self_write.sql', () => {
  it('drops and recreates organizer_wallets_admin_write rather than leaving the old permissive policy in place', () => {
    expect(sql).toMatch(/DROP POLICY IF EXISTS organizer_wallets_admin_write ON public\.organizer_wallets/);
    expect(sql).toMatch(/CREATE POLICY organizer_wallets_admin_write ON public\.organizer_wallets/);
  });

  it('excludes the admin\'s own row from both USING and WITH CHECK', () => {
    expect(sql).toMatch(/USING \(public\.is_admin\(\) AND organizer_id <> auth\.uid\(\)\)/);
    expect(sql).toMatch(/WITH CHECK \(public\.is_admin\(\) AND organizer_id <> auth\.uid\(\)\)/);
  });

  it('scopes the policy to authenticated, not the overly broad public role the old policy used', () => {
    expect(sql).toMatch(/FOR ALL TO authenticated/);
  });

  it('still requires is_admin() -- this is a self-exclusion fix, not a removal of admin capability', () => {
    expect(sql).toMatch(/is_admin\(\)/);
  });
});
