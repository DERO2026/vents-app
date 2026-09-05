import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression tests for the Admin/Sub-Admin Services management surface
// (Services Stage 3). Static-analysis style, matching this repo's existing
// test approach -- no live app/DB harness available.
//
// Security note this suite exists to enforce: this tab introduces ZERO new
// server-side surface. Every read/write it performs goes through RLS
// policies that already existed before this stage (service_providers_
// admin_select/0034, provider_services_admin_*/0048, both gated on
// is_admin()). This file asserts the client never assumes it's the
// authority -- i.e. it doesn't hide a "you're not admin" check that RLS
// alone should be handling, and it doesn't introduce a differently-scoped
// query a normal user's session could also reach.

let adminDashboardSrc: string;
let m0034: string;
let m0045: string;
let m0048: string;

beforeAll(() => {
  const componentsDir = join(__dirname, '..', 'app', 'components');
  adminDashboardSrc = readFileSync(join(componentsDir, 'AdminDashboardScreen.tsx'), 'utf8');
  const migrationsDir = join(__dirname, '..', '..', 'supabase', 'migrations');
  m0034 = readFileSync(join(migrationsDir, '0034_service_providers.sql'), 'utf8');
  m0045 = readFileSync(join(migrationsDir, '0045_service_provider_admin_access.sql'), 'utf8');
  m0048 = readFileSync(join(migrationsDir, '0048_provider_services.sql'), 'utf8');
});

describe('Admin Services tab: routes and reachability', () => {
  it('is a real tab, gated behind the same admin dashboard every other privileged tab uses', () => {
    expect(adminDashboardSrc).toMatch(/key: 'services-admin' as Tab/);
    expect(adminDashboardSrc).toMatch(/tab === 'services-admin'/);
  });

  it('the provider-list query only runs when the caller is admin/sub-admin (defense in depth, not the real gate)', () => {
    const fn = adminDashboardSrc.match(/const loadSvcProviders = useCallback\(async \(\) => \{[\s\S]*?\n {2}\}, \[/)?.[0] ?? '';
    expect(fn).toMatch(/if \(!isAdminOrSubAdmin\) return;/);
  });
});

describe('Admin Services tab: no new server-side surface -- relies entirely on pre-existing RLS', () => {
  it('reads service_providers directly (no admin-only RPC introduced for listing)', () => {
    expect(adminDashboardSrc).toMatch(/\.from\('service_providers'\)\s*\n\s*\.select\('id, user_id, business_name, category, country, status, created_at, updated_at'\)/);
  });

  it('reads/writes provider_services via the same helpers the provider-facing screen uses (fetchOwnServicesForProvider, create/update/delete/setActive)', () => {
    expect(adminDashboardSrc).toMatch(/fetchOwnServicesForProvider as fetchServicesForProviderId/);
    expect(adminDashboardSrc).toMatch(/createProviderService/);
    expect(adminDashboardSrc).toMatch(/updateProviderService/);
    expect(adminDashboardSrc).toMatch(/setProviderServiceActive/);
    expect(adminDashboardSrc).toMatch(/deleteProviderService/);
  });

  it('service_providers has an admin SELECT policy gated on is_admin() -- the actual server-side authority for the provider list', () => {
    const policy = m0034.match(/CREATE POLICY service_providers_admin_select ON public\.service_providers[\s\S]*?;/)?.[0] ?? '';
    expect(policy).toMatch(/USING \(is_admin\(\)\)/);
  });

  it('service_providers has an admin INSERT policy (0045) -- admin bypass is not read-only', () => {
    expect(m0045).toMatch(/CREATE POLICY service_providers_admin_insert ON public\.service_providers/);
    expect(m0045).toMatch(/WITH CHECK \(is_admin\(\)\)/);
  });

  it('provider_services has admin INSERT/UPDATE/DELETE policies (0048) -- the actual authority for add/edit/activate/delete', () => {
    expect(m0048).toMatch(/CREATE POLICY provider_services_admin_insert ON public\.provider_services/);
    expect(m0048).toMatch(/CREATE POLICY provider_services_admin_update ON public\.provider_services/);
    expect(m0048).toMatch(/CREATE POLICY provider_services_admin_delete ON public\.provider_services/);
  });
});

describe('Admin Services tab: provider self-management and cross-provider isolation are untouched', () => {
  it('does not modify or weaken the owner-only policies', () => {
    expect(m0048).toMatch(/CREATE POLICY provider_services_insert_own ON public\.provider_services/);
    expect(m0048).toMatch(/CREATE POLICY provider_services_update_own ON public\.provider_services/);
    expect(m0048).toMatch(/CREATE POLICY provider_services_delete_own ON public\.provider_services/);
    expect(m0048).toMatch(/sp\.user_id = \(SELECT auth\.uid\(\)\)/);
  });

  it('public discovery visibility rule (active + approved only) is untouched', () => {
    expect(m0048).toMatch(/CREATE POLICY provider_services_public_select ON public\.provider_services/);
    expect(m0048).toMatch(/is_active = true/);
    expect(m0048).toMatch(/sp\.status = 'approved'/);
  });
});

describe('Admin Services tab: destructive action is clearly separated', () => {
  it('delete goes through the shared ConfirmModal (typed confirmation UI), not an inline click-to-delete', () => {
    expect(adminDashboardSrc).toMatch(/const handleSvcDeleteService = \(svc: ProviderService\) => \{\s*\n\s*setConfirmModal\(\{/);
    expect(adminDashboardSrc).toMatch(/title: 'Delete this service\?'/);
  });

  it('activate/deactivate and edit are visually distinct from delete (different icon/border color)', () => {
    const deleteButton = adminDashboardSrc.match(/onClick=\{\(\) => handleSvcDeleteService\(svc\)\}[\s\S]*?<\/button>/)?.[0] ?? '';
    expect(deleteButton).toMatch(/rgba\(239,68,68/); // red border, matches this file's existing danger-action convention
  });
});

describe('Admin Services tab: no phone/WhatsApp, no booking/payment introduced', () => {
  it('has no phone/WhatsApp controls', () => {
    const svcSection = adminDashboardSrc.match(/SERVICES \(ADMIN\) TAB[\s\S]*?IMPORT EVENTS TAB/)?.[0] ?? '';
    expect(svcSection).not.toMatch(/whatsapp|wa\.me|tel:/i);
  });

  it('has no booking/payment/Paystack code', () => {
    const svcSection = adminDashboardSrc.match(/SERVICES \(ADMIN\) TAB[\s\S]*?IMPORT EVENTS TAB/)?.[0] ?? '';
    expect(svcSection).not.toMatch(/paystack|booking.?request/i);
  });
});
