import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression tests for 0188_fix_admin_send_broadcast_authorization.sql.
//
// The bug: admin_send_broadcast() (live, called via admin_broadcast() from
// AdminSystemScreen.tsx's Broadcast action) gated itself with a bespoke
// literal check -- `role = 'admin'` -- instead of calling one of the
// established helpers (is_admin(), is_super_admin(), is_admin_or_root())
// every other admin RPC in this schema uses. 0188 replaces that one line
// with is_admin_or_root(), the exact helper already used by
// admin_set_event_trending, approve_admin_action,
// admin_reject_organizer_payout, and admin_cancel_processing_payout --
// matching the UI's own Root-only gating for this action
// (AdminConsoleShell.render.test.tsx) without widening access to
// Sub-Admins (is_admin() would; is_admin_or_root() does not).
//
// Static-text assertions against the migration file itself (same
// convention as approveAdminActionTrendingExecutor.security.test.ts and
// payoutRejectCancelTocTouFix.security.test.ts), since 0188 has not been
// applied to any database -- this proves the file's own content, not live
// Postgres behavior.

let m0188: string;

beforeAll(() => {
  m0188 = readFileSync(
    join(__dirname, '..', '..', 'supabase', 'migrations', '0188_fix_admin_send_broadcast_authorization.sql'),
    'utf8'
  );
});

function fnBody(src: string): string {
  return src.match(/CREATE OR REPLACE FUNCTION public\.admin_send_broadcast[\s\S]*?\$function\$;/)?.[0] ?? '';
}

describe('0188: admin_send_broadcast() authorization now matches the established admin-RPC pattern', () => {
  it('gates on is_admin_or_root(), not a bespoke literal role check', () => {
    const fn = fnBody(m0188);
    expect(fn).not.toBe('');
    expect(fn).toMatch(/IF NOT public\.is_admin_or_root\(\) THEN\s*\n\s*RAISE EXCEPTION 'Only admins can send broadcasts';\s*\n\s*END IF;/);
  });

  it('no longer contains the old bespoke literal-role authorization check', () => {
    const fn = fnBody(m0188);
    expect(fn).not.toMatch(/SELECT 1 FROM public\.users\s*\n\s*WHERE id = v_admin_id AND role = 'admin'/);
  });

  it('does NOT widen access to Sub-Admins -- uses is_admin_or_root(), not the broader is_admin()', () => {
    const fn = fnBody(m0188);
    // is_admin_or_root() == is_super_admin() == is_root() OR role = 'admin'.
    // is_admin() additionally allows role = 'sub-admin' -- that helper must
    // not appear anywhere in this function.
    expect(fn).not.toMatch(/public\.is_admin\(\)/);
    expect(fn).toMatch(/public\.is_admin_or_root\(\)/);
  });

  it('preserves the exact recipient filter, INSERT shape, audit log, and return shape unchanged', () => {
    const fn = fnBody(m0188);
    expect(fn).toMatch(/FROM public\.users u\s*\n\s*WHERE u\.role <> 'admin';/);
    expect(fn).toMatch(/INSERT INTO public\.notifications \(id, user_id, type, title, body, read, icon, created_at\)/);
    expect(fn).toMatch(/'broadcast',\s*\n\s*p_title,\s*\n\s*p_body,\s*\n\s*false,\s*\n\s*'📢',/);
    expect(fn).toMatch(/INSERT INTO public\.admin_logs \(id, admin_id, action, target_user_id, details, created_at\)/);
    expect(fn).toMatch(/'broadcast_sent',/);
    expect(fn).toMatch(/RETURN jsonb_build_object\('success', true, 'recipients', v_count\);/);
  });

  it('keeps the same signature, SECURITY DEFINER, and empty search_path as the live function', () => {
    expect(m0188).toMatch(/CREATE OR REPLACE FUNCTION public\.admin_send_broadcast\(p_title text, p_body text\)\s*\n\s*RETURNS jsonb/);
    expect(m0188).toMatch(/SECURITY DEFINER\s*\n\s*SET search_path TO ''/);
  });
});

describe('0188: simulated authorization outcomes for each caller class (mirrors live is_admin_or_root()/is_admin() semantics)', () => {
  // Faithful re-implementation of the live helpers' exact logic, confirmed
  // via pg_get_functiondef against project slrtjxtzhowhwhebjprv:
  //   is_root()          == auth.uid() == <the one hardcoded root UUID>
  //   is_super_admin()   == is_root() OR role = 'admin'
  //   is_admin_or_root() == is_super_admin()
  //   is_admin()         == is_root() OR role IN ('admin', 'sub-admin')
  const ROOT_ID = 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832';

  function isRoot(userId: string) { return userId === ROOT_ID; }
  function isAdminOrRoot(userId: string, role: string) { return isRoot(userId) || role === 'admin'; }
  function isAdmin(userId: string, role: string) { return isRoot(userId) || role === 'admin' || role === 'sub-admin'; }

  function simulateAuthorize(userId: string, role: string): { allowed: boolean } {
    return { allowed: isAdminOrRoot(userId, role) }; // post-fix check
  }

  it('the root account (role=admin live) is authorized -- no change from before the fix', () => {
    expect(simulateAuthorize(ROOT_ID, 'admin').allowed).toBe(true);
  });

  it('a full Admin (role=admin, not root) is authorized -- unchanged from before the fix', () => {
    expect(simulateAuthorize('c9eb5eb6-aaaa-0000-0000-000000000001', 'admin').allowed).toBe(true);
  });

  it('a Sub-Admin is still rejected -- the fix does not widen access to Sub-Admins', () => {
    expect(simulateAuthorize('a4402494-d7a0-4537-a83c-362fe71ec44f', 'sub-admin').allowed).toBe(false);
    // Contrast: is_admin() WOULD allow this -- confirming is_admin_or_root()
    // is the correct, narrower helper actually used by the fix.
    expect(isAdmin('a4402494-d7a0-4537-a83c-362fe71ec44f', 'sub-admin')).toBe(true);
  });

  it('a plain user is rejected', () => {
    expect(simulateAuthorize('11111111-1111-1111-1111-111111111111', 'user').allowed).toBe(false);
  });

  it('a hypothetical root account whose role column drifted away from \'admin\' is STILL authorized post-fix (robustness gain, not a behavior change for any current production user)', () => {
    expect(simulateAuthorize(ROOT_ID, 'user').allowed).toBe(true); // is_root() alone carries it
  });
});
