import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Authentication end-to-end reconciliation audit: 0134_fix_account_
// deletion_capability_and_email_release.sql. Static-analysis test matching
// the house pattern. Both findings were proven live against project
// slrtjxtzhowhwhebjprv (rolled back where a real account was used, no
// residue):
//
// FINDING 1: neither deletion path cleared is_organizer/is_service_provider
// -- a still-valid session for a just-deleted account retained full
// organizer/provider capability. PRE-FIX: a real organizer account, after
// delete_own_account() ran, could still INSERT a live event with the same
// session (events RLS only checks is_organizer(), not deletion status). A
// genuinely stale deleted production account (deleted via a path that
// predates this fix) was independently found with is_organizer still true
// and its email unmasked -- real evidence, not a hypothetical. POST-FIX:
// the identical event insert on the same now-deleted session fails with
// "new row violates row-level security policy for table events".
//
// FINDING 2: admin_soft_delete_user never released the email at either the
// public.users or auth.users layer the way delete_own_account does, so an
// admin-deleted user's email could not be reused for a genuinely new
// signup. POST-FIX: both rows show the masked
// "deleted_<uid>@deleted.vents" address after admin_soft_delete_user runs,
// verified live.

let m0134: string;
let deleteOwnFn: string;
let adminDeleteFn: string;

beforeAll(() => {
  m0134 = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0134_fix_account_deletion_capability_and_email_release.sql'), 'utf8');
  deleteOwnFn = m0134.match(/CREATE OR REPLACE FUNCTION public\.delete_own_account\(\)[\s\S]*?\$function\$;/)?.[0] ?? '';
  adminDeleteFn = m0134.match(/CREATE OR REPLACE FUNCTION public\.admin_soft_delete_user\([\s\S]*?\$function\$;/)?.[0] ?? '';
});

describe('(1) both deletion paths clear organizer/service-provider capability', () => {
  it('delete_own_account sets is_organizer = false and is_service_provider = false', () => {
    expect(deleteOwnFn).toMatch(/is_organizer\s*=\s*false/);
    expect(deleteOwnFn).toMatch(/is_service_provider\s*=\s*false/);
  });

  it('admin_soft_delete_user sets is_organizer = false and is_service_provider = false', () => {
    expect(adminDeleteFn).toMatch(/is_organizer\s*=\s*false/);
    expect(adminDeleteFn).toMatch(/is_service_provider\s*=\s*false/);
  });

  it('the capability clear happens in the same UPDATE that marks the account deleted, not a separate step that could be skipped', () => {
    const deleteOwnUpdate = deleteOwnFn.match(/UPDATE public\.users SET[\s\S]*?WHERE id = v_uid;/)?.[0] ?? '';
    expect(deleteOwnUpdate).toMatch(/status\s*=\s*'deleted'/);
    expect(deleteOwnUpdate).toMatch(/is_organizer\s*=\s*false/);

    const adminUpdate = adminDeleteFn.match(/UPDATE public\.users SET[\s\S]*?WHERE id = p_user_id;/)?.[0] ?? '';
    expect(adminUpdate).toMatch(/status\s*=\s*'deleted'/);
    expect(adminUpdate).toMatch(/is_organizer\s*=\s*false/);
  });
});

describe('(2) admin-initiated deletion releases the email at both layers, matching self-deletion', () => {
  it('admin_soft_delete_user masks public.users.email with the same deleted_<uid>@deleted.vents pattern', () => {
    expect(adminDeleteFn).toMatch(/email\s*=\s*'deleted_' \|\| p_user_id \|\| '@deleted\.vents'/);
  });

  it('admin_soft_delete_user also masks auth.users.email -- this is the actual unique-constraint layer Supabase Auth enforces', () => {
    expect(adminDeleteFn).toMatch(/UPDATE auth\.users\s*\n\s*SET email = 'deleted_' \|\| p_user_id \|\| '@deleted\.vents', updated_at = now\(\)\s*\n\s*WHERE id = p_user_id;/);
  });

  it('the original email is preserved for admin/fraud-review purposes before being overwritten, same as self-deletion', () => {
    expect(adminDeleteFn).toMatch(/original_email\s*=\s*email/);
    expect(adminDeleteFn).toMatch(/INSERT INTO public\.deleted_emails \(email\) VALUES \(lower\(trim\(v_user\.email\)\)\) ON CONFLICT DO NOTHING;/);
  });
});

describe('(3) admin_soft_delete_user now matches the codebase convention of a locked-down search_path', () => {
  it('has SET search_path TO (defense-in-depth, not previously present)', () => {
    expect(adminDeleteFn).toMatch(/SET search_path TO ''/);
  });
});

describe('(4) existing safety checks are untouched by this fix', () => {
  it('admin_soft_delete_user still blocks self-targeting, Root targeting, and re-deleting an already-deleted account', () => {
    expect(adminDeleteFn).toMatch(/IF p_user_id = auth\.uid\(\) THEN RAISE EXCEPTION/);
    expect(adminDeleteFn).toMatch(/Root account cannot be deleted/);
    expect(adminDeleteFn).toMatch(/IF v_user\.status = 'deleted' THEN RAISE EXCEPTION 'Account already deleted';/);
  });

  it('delete_own_account still blocks re-deleting an already-deleted account and preserves wallet-balance audit logging', () => {
    expect(deleteOwnFn).toMatch(/IF v_user\.status = 'deleted' THEN RAISE EXCEPTION 'Account already deleted';/);
    expect(deleteOwnFn).toMatch(/wallet_at_deletion/);
  });
});
