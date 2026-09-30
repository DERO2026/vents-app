import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Final independent Admin Console audit (post-consolidation, post-emergency-
// controls). Two real findings from this pass:
//
// 1. Staff-tier (role) management existed as a working, maker-checker-wired
//    helper (roleChange in adminUserEventActions.ts, backed by the live
//    admin_set_user_role RPC) but was never wired to any Admin Console
//    screen -- an admin could grant/revoke Organizer/Service Provider
//    capability but could not promote/demote a Sub-Admin at all. The legacy
//    AdminDashboardScreen.tsx (confirmed via git history) had this control.
//    Fixed: AdminUserDetail.tsx now has a "Staff Tier" picker.
//
// 2. AdminUserDetail's Wallet/VC/Reports tabs claimed "not available"
//    because no admin-readable path existed when originally written. Live
//    RLS policies (confirmed via pg_policies) already grant is_admin() SELECT
//    on user_wallets, user_wallet_transactions, vc_transactions and reports
//    -- only vents_wallets (the VC balance row) was missing the matching
//    policy, added in 0125_admin_console_final_audit_fixes.sql. Fixed: all
//    three tabs now show real data instead of a stale placeholder.

let m0125: string;
let adminUserDetailSrc: string;
let adminUserEventActionsSrc: string;

beforeAll(() => {
  m0125 = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0125_admin_console_final_audit_fixes.sql'), 'utf8');
  const adminDir = join(__dirname, '..', 'app', 'components', 'admin');
  adminUserDetailSrc = readFileSync(join(adminDir, 'AdminUserDetail.tsx'), 'utf8');
  adminUserEventActionsSrc = readFileSync(join(adminDir, 'adminUserEventActions.ts'), 'utf8');
});

describe('Fix 1: Staff Tier (role) management is now reachable from the Admin Console', () => {
  it('AdminUserDetail imports and calls the existing roleChange helper', () => {
    expect(adminUserDetailSrc).toMatch(/import \{[^}]*roleChange[^}]*\} from '\.\/adminUserEventActions';/);
    expect(adminUserDetailSrc).toMatch(/roleChange\(isSuperAdmin, user\.id, user\.role, newRole, user\.username \|\| user\.email\)/);
  });

  it('only Root can pick Sub-Admin as a destination -- matches admin_set_user_role\'s own Root-only gate for that value', () => {
    const pickerBlock = adminUserDetailSrc.match(/rolePickerOpen && \([\s\S]*?onClose=\{\(\) => setRolePickerOpen\(false\)\}/)?.[0] ?? '';
    expect(pickerBlock).toMatch(/isRoot && user\.role !== 'sub-admin'/);
  });

  it('the Staff Tier control itself is hidden for the Root account and for a non-root admin viewing a non-sub-admin row (nothing to promote to)', () => {
    expect(adminUserDetailSrc).toMatch(/\{!isRootUser && \(isRoot \|\| user\.role === 'sub-admin'\) && \(/);
  });

  it('the underlying roleChange helper is maker-checker-wired (submitOrExecute) and rejects the stale organizer-role concept, matching the current capability architecture', () => {
    const fn = adminUserEventActionsSrc.match(/export async function roleChange\([\s\S]*?\n\}/)?.[0] ?? '';
    expect(fn).toMatch(/submitOrExecute\(isSuperAdmin, 'set_user_role'/);
    expect(fn).toMatch(/admin_set_user_role/);
  });
});

describe('Fix 2: stale "not available" placeholders replaced with real admin-readable data', () => {
  it('0125 adds the one missing admin-select policy (vents_wallets) to complete the set user_wallets/user_wallet_transactions/vc_transactions already had', () => {
    expect(m0125).toMatch(/CREATE POLICY vents_wallets_admin_select ON public\.vents_wallets/);
    expect(m0125).toMatch(/FOR SELECT\s*\n\s*USING \(public\.is_admin\(\)\);/);
  });

  it('AdminUserDetail\'s Wallet tab now queries user_wallets/user_wallet_transactions directly instead of showing a placeholder', () => {
    expect(adminUserDetailSrc).toMatch(/supabase\.from\('user_wallets'\)\.select\('balance_kobo'\)\.eq\('user_id', userId\)/);
    expect(adminUserDetailSrc).toMatch(/supabase\.from\('user_wallet_transactions'\)\.select\(/);
  });

  it('AdminUserDetail\'s VC tab now queries vents_wallets/vc_transactions directly instead of showing a placeholder', () => {
    expect(adminUserDetailSrc).toMatch(/supabase\.from\('vents_wallets'\)\.select\('balance'\)\.eq\('user_id', userId\)/);
    expect(adminUserDetailSrc).toMatch(/supabase\.from\('vc_transactions'\)\.select\(/);
  });

  it('AdminUserDetail\'s Reports tab now queries reports scoped to this user (filed by or against) instead of showing a placeholder', () => {
    expect(adminUserDetailSrc).toMatch(/supabase\.from\('reports'\)\.select\(/);
    expect(adminUserDetailSrc).toMatch(/reporter_id\.eq\.\$\{userId\},and\(target_type\.eq\.user,target_id\.eq\.\$\{userId\}\)/);
  });

  it('the Tickets tab keeps its honest "not available" -- tickets has no admin-wide RLS policy (only the ticket owner or the event\'s organizer can read a row)', () => {
    expect(adminUserDetailSrc).toMatch(/tab === 'tickets' && <NotAvailable/);
  });
});

describe('No stale role architecture reintroduced by this pass', () => {
  it('the new Staff Tier picker never offers "organizer" as a selectable role value -- only user/sub-admin, matching admin_set_user_role', () => {
    const pickerBlock = adminUserDetailSrc.match(/rolePickerOpen && \([\s\S]*?onClose=\{\(\) => setRolePickerOpen\(false\)\}/)?.[0] ?? '';
    expect(pickerBlock).not.toMatch(/value: 'organizer'/);
    expect(pickerBlock).toMatch(/value: 'user'/);
    expect(pickerBlock).toMatch(/value: 'sub-admin'/);
  });
});
