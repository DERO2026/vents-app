import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Static-analysis tests (same approach as the other *.security.test.ts files
// in this repo -- no live Postgres/RLS harness available). Covers the
// Services stabilization pass: Admin/Sub-Admin RLS bypass on
// service_providers, and that no legacy/duplicate Service Provider request
// UI has crept back into the codebase.

let sp045: string;
let sp034: string;
let profileScreenSrc: string;
let appSrc: string;

beforeAll(() => {
  const migrationsDir = join(__dirname, '..', '..', 'supabase', 'migrations');
  sp045 = readFileSync(join(migrationsDir, '0045_service_provider_admin_access.sql'), 'utf8');
  sp034 = readFileSync(join(migrationsDir, '0034_service_providers.sql'), 'utf8');
  const componentsDir = join(__dirname, '..', 'app', 'components');
  profileScreenSrc = readFileSync(join(componentsDir, 'ProfileScreen.tsx'), 'utf8');
  appSrc = readFileSync(join(__dirname, '..', 'app', 'App.tsx'), 'utf8');
});

describe('service_providers admin access (0045)', () => {
  it('adds an admin INSERT bypass gated on is_admin(), scoped to authenticated only', () => {
    expect(sp045).toMatch(/CREATE POLICY service_providers_admin_insert ON public\.service_providers/);
    expect(sp045).toMatch(/FOR INSERT/);
    expect(sp045).toMatch(/TO authenticated/);
    expect(sp045).toMatch(/WITH CHECK \(is_admin\(\)\)/);
  });

  it('does not touch or weaken the existing owner-only insert policy (0034)', () => {
    expect(sp034).toMatch(/CREATE POLICY service_providers_insert_own ON public\.service_providers/);
    expect(sp034).toMatch(/u\.is_service_provider = true/);
    expect(sp045).not.toMatch(/DROP POLICY[^;]*service_providers_insert_own/);
  });

  it('public discovery still only ever exposes approved listings (0034 untouched)', () => {
    expect(sp034).toMatch(/CREATE POLICY service_providers_public_select_approved ON public\.service_providers/);
    expect(sp034).toMatch(/USING \(status = 'approved'\)/);
  });

  it('ownership is still enforced on UPDATE/DELETE -- one provider cannot touch another provider\'s row', () => {
    expect(sp034).toMatch(/CREATE POLICY service_providers_update_own[\s\S]*?\(SELECT auth\.uid\(\)\) = user_id/);
    expect(sp034).toMatch(/CREATE POLICY service_providers_delete_own[\s\S]*?\(SELECT auth\.uid\(\)\) = user_id/);
  });
});

describe('Profile screen: single, non-duplicated Service Provider entry point', () => {
  it('the old free-text request modal is gone (no stray copy re-added)', () => {
    expect(profileScreenSrc).not.toMatch(/Tell us briefly about the services/);
    expect(profileScreenSrc).not.toMatch(/showSpRequestModal/);
    expect(profileScreenSrc).not.toMatch(/submitSpRequest/);
  });

  it('"Become a Service Provider" navigates to the KYC screen, not a raw insert', () => {
    expect(profileScreenSrc).toMatch(/onNavigate\('service-provider-verify'\)/);
    expect(profileScreenSrc).not.toMatch(/\.from\('service_provider_requests'\)\s*\n\s*\.insert/);
  });

  it('Admin/Sub-Admin can reach provider setup without the capability flag', () => {
    expect(profileScreenSrc).toMatch(/canAccessProviderSetup/);
    expect(profileScreenSrc).toMatch(/currentUser\?\.role === 'admin' \|\| currentUser\?\.role === 'sub-admin'/);
  });
});

describe('App.tsx: is_service_provider is kept in sync without re-login', () => {
  it('the periodic user-state sync also re-selects is_service_provider', () => {
    const syncBlock = appSrc.match(/const syncRole = \(\) => \{[\s\S]*?\n {4}\};/)?.[0] ?? '';
    expect(syncBlock).toMatch(/select\('role, is_service_provider'\)/);
    expect(syncBlock).toMatch(/is_service_provider: data\.is_service_provider === true/);
  });

  it('the new KYC screen route is wired up', () => {
    expect(appSrc).toMatch(/screen === 'service-provider-verify'/);
    expect(appSrc).toMatch(/import \{ ServiceProviderVerificationScreen \} from '\.\/components\/ServiceProviderVerificationScreen';/);
  });
});
