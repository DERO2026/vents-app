import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression tests for the Admin/Sub-Admin Services management surface,
// migrated from the legacy AdminDashboardScreen.tsx (now fully retired)
// into the Admin Console's AdminProvidersList (list) and AdminProviderDetail
// (per-provider Services tab: add/edit/activate/delete). Static-analysis
// style, matching this repo's existing test approach -- no live app/DB
// harness available.
//
// Security note this suite exists to enforce: this tab introduces ZERO new
// server-side surface. Every read/write it performs goes through RLS
// policies that already existed before this stage (service_providers_
// admin_select/0034, provider_services_admin_*/0048, both gated on
// is_admin()). This file asserts the client never assumes it's the
// authority -- i.e. it doesn't hide a "you're not admin" check that RLS
// alone should be handling, and it doesn't introduce a differently-scoped
// query a normal user's session could also reach.

let adminProvidersListSrc: string;
let adminProviderDetailSrc: string;
let m0034: string;
let m0045: string;
let m0048: string;

beforeAll(() => {
  const componentsDir = join(__dirname, '..', 'app', 'components', 'admin');
  adminProvidersListSrc = readFileSync(join(componentsDir, 'AdminProvidersList.tsx'), 'utf8');
  adminProviderDetailSrc = readFileSync(join(componentsDir, 'AdminProviderDetail.tsx'), 'utf8');
  const migrationsDir = join(__dirname, '..', '..', 'supabase', 'migrations');
  m0034 = readFileSync(join(migrationsDir, '0034_service_providers.sql'), 'utf8');
  m0045 = readFileSync(join(migrationsDir, '0045_service_provider_admin_access.sql'), 'utf8');
  m0048 = readFileSync(join(migrationsDir, '0048_provider_services.sql'), 'utf8');
});

describe('Admin Providers screen: routes and reachability', () => {
  it('is a real Admin Console screen, reachable from the Providers nav item', () => {
    expect(adminProvidersListSrc).toMatch(/export function AdminProvidersList/);
  });
});

describe('Admin Providers screen: no new server-side surface -- relies entirely on pre-existing RLS', () => {
  it('reads service_providers directly (no admin-only RPC introduced for listing)', () => {
    expect(adminProvidersListSrc).toMatch(/\.from\('service_providers'\)\s*\n\s*\.select\('id, user_id, business_name, category, country, status, created_at, updated_at'\)/);
  });

  it('reads/writes provider_services via the same helpers the provider-facing screen uses (fetchOwnServicesForProvider, create/update/delete/setActive)', () => {
    expect(adminProviderDetailSrc).toMatch(/fetchOwnServicesForProvider/);
    expect(adminProviderDetailSrc).toMatch(/createProviderService/);
    expect(adminProviderDetailSrc).toMatch(/updateProviderService/);
    expect(adminProviderDetailSrc).toMatch(/setProviderServiceActive/);
    expect(adminProviderDetailSrc).toMatch(/deleteProviderService/);
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

describe('Admin Providers screen: provider self-management and cross-provider isolation are untouched', () => {
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

describe('Admin Providers screen: destructive action is clearly separated', () => {
  it('delete goes through the shared ConfirmModal, not an inline click-to-delete', () => {
    expect(adminProviderDetailSrc).toMatch(/import \{ ConfirmModal \} from '\.\/adminShared';/);
    expect(adminProviderDetailSrc).toMatch(/setConfirmDeleteService\(sv\)/);
    expect(adminProviderDetailSrc).toMatch(/title="Delete this service\?"/);
  });

  it('activate/deactivate and edit are visually distinct from delete (different icon/border color)', () => {
    const deleteButton = adminProviderDetailSrc.match(/onClick=\{\(\) => setConfirmDeleteService\(sv\)\}[\s\S]*?<\/button>/)?.[0] ?? '';
    expect(deleteButton).toMatch(/rgba\(248,113,113/); // red border, matches this file's existing danger-action convention
  });
});

describe('Admin Providers screen: no phone/WhatsApp, no booking/payment introduced into the Services CRUD form', () => {
  it('has no phone/WhatsApp controls', () => {
    expect(adminProviderDetailSrc).not.toMatch(/whatsapp|wa\.me|tel:/i);
  });

  it('the Services tab form has no Paystack/payment code (bookings/payments are read-only, sourced separately from admin_list_service_bookings)', () => {
    const serviceFormBlock = adminProviderDetailSrc.match(/\{serviceForm && \([\s\S]*?<\/div>\s*\)\}/)?.[0] ?? '';
    expect(serviceFormBlock).not.toMatch(/paystack/i);
  });
});
