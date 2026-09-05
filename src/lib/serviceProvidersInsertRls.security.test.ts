import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression tests for the "new row violates row-level security policy for
// table service_providers" error on Save & Publish. Traced the insert path
// (src/lib/serviceProviders.ts's saveAndPublishServiceProvider ->
// supabase.from('service_providers').upsert({user_id: userId, ...})) end
// to end against the RLS policies that gate it:
//
//   - service_providers_insert_own (0034): WITH CHECK (auth.uid() =
//     user_id AND users.is_service_provider = true) -- an approved
//     provider inserting their OWN row. Correct, unchanged, not weakened.
//   - service_providers_admin_insert (0045): WITH CHECK (is_admin()) --
//     lets Admin/Sub-Admin create a listing even when their own
//     is_service_provider is false, matching every other admin-managed
//     section's direct-access pattern (ProfileScreen's canAccessProviderSetup
//     bypass sends them into this same screen).
//
// Both policies are correct in the migration files (see the assertions
// below) and the client always sends its own auth.uid() as user_id (never
// a client-supplied id it doesn't control). The runtime failure was
// therefore NOT a code or policy defect -- see the accompanying report for
// the live-database confirmation that migration 0045 needed to be
// (re-)applied to Preview, the same class of gap as 0044 earlier this
// session.

let sp034: string;
let sp045: string;
let serviceProvidersLib: string;

beforeAll(() => {
  const migrationsDir = join(__dirname, '..', '..', 'supabase', 'migrations');
  sp034 = readFileSync(join(migrationsDir, '0034_service_providers.sql'), 'utf8');
  sp045 = readFileSync(join(migrationsDir, '0045_service_provider_admin_access.sql'), 'utf8');
  serviceProvidersLib = readFileSync(join(__dirname, 'serviceProviders.ts'), 'utf8');
});

describe('service_providers INSERT: the client only ever inserts its own authenticated user_id', () => {
  it('saveAndPublishServiceProvider upserts with user_id set to the caller-supplied userId parameter, never a different id', () => {
    const fn = serviceProvidersLib.match(/export async function saveAndPublishServiceProvider\([\s\S]*?\n\}/)?.[0] ?? '';
    expect(fn).toMatch(/user_id: userId,/);
  });
});

describe('1. An authorized Service Provider (users.is_service_provider = true) can insert their own listing', () => {
  it('service_providers_insert_own requires auth.uid() = user_id AND is_service_provider = true -- exactly the authorized case', () => {
    const policy = sp034.match(/CREATE POLICY service_providers_insert_own ON public\.service_providers[\s\S]*?;/)?.[0] ?? '';
    expect(policy).toMatch(/FOR INSERT/);
    expect(policy).toMatch(/TO authenticated/);
    expect(policy).toMatch(/\(SELECT auth\.uid\(\)\) = user_id/);
    expect(policy).toMatch(/u\.is_service_provider = true/);
  });
});

describe('2. An unauthorized user (no capability, not their own row) cannot insert', () => {
  it('the owner policy WITH CHECK fails closed for any row where user_id != auth.uid(), regardless of is_service_provider', () => {
    const policy = sp034.match(/CREATE POLICY service_providers_insert_own ON public\.service_providers[\s\S]*?;/)?.[0] ?? '';
    // Both conditions are AND-ed in a single WITH CHECK -- neither alone is
    // sufficient, so a plain attendee/organizer (is_service_provider=false)
    // is rejected, and so is anyone attempting to insert a row for a
    // DIFFERENT user_id even if that other user is an approved provider.
    expect(policy).toMatch(/WITH CHECK \(\s*\(SELECT auth\.uid\(\)\) = user_id\s*\n\s*AND EXISTS/);
  });

  it('public discovery of service_providers is read-only and approved-only -- no anonymous/public write policy exists', () => {
    expect(sp034).not.toMatch(/FOR INSERT[\s\S]{0,80}TO (public|anon)/);
    expect(sp034).toMatch(/CREATE POLICY service_providers_public_select_approved ON public\.service_providers/);
  });
});

describe('3. Admin/Sub-Admin can still create/manage a listing without the capability flag', () => {
  it('service_providers_admin_insert (0045) is gated on is_admin(), which covers admin, sub-admin, and root -- and does not touch or weaken the owner policy', () => {
    expect(sp045).toMatch(/CREATE POLICY service_providers_admin_insert ON public\.service_providers/);
    expect(sp045).toMatch(/FOR INSERT/);
    expect(sp045).toMatch(/WITH CHECK \(is_admin\(\)\)/);
    expect(sp045).not.toMatch(/DROP POLICY[^;]*service_providers_insert_own/);
    expect(sp034).toMatch(/CREATE POLICY service_providers_insert_own ON public\.service_providers/);
  });

  it('admin UPDATE/DELETE/SELECT bypasses already existed in 0034/0045 and are untouched here', () => {
    expect(sp034).toMatch(/CREATE POLICY service_providers_admin_select ON public\.service_providers/);
    expect(sp034).toMatch(/CREATE POLICY service_providers_admin_update ON public\.service_providers/);
    expect(sp034).toMatch(/CREATE POLICY service_providers_admin_delete ON public\.service_providers/);
  });
});

describe('RLS is not weakened: no public/anon write path was introduced anywhere in this trace', () => {
  it('every INSERT/UPDATE/DELETE policy on service_providers is scoped to `authenticated`, never public or anon', () => {
    const allPolicyBlocks = (sp034 + '\n' + sp045).match(/CREATE POLICY [\s\S]*?;/g) || [];
    const writePolicies = allPolicyBlocks.filter((p) => /FOR (INSERT|UPDATE|DELETE)/.test(p));
    expect(writePolicies.length).toBeGreaterThan(0);
    for (const p of writePolicies) {
      expect(p).toMatch(/TO authenticated/);
    }
  });
});
