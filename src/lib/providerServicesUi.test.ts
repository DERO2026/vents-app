import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// UI wiring regression tests for the provider service catalog (Services
// Stage 2) -- static-analysis, matching this repo's existing test style.

let appSrc: string;
let setupScreenSrc: string;
let manageScreenSrc: string;
let publicProfileSrc: string;
let providerServicesLibSrc: string;

beforeAll(() => {
  appSrc = readFileSync(join(__dirname, '..', 'app', 'App.tsx'), 'utf8');
  const componentsDir = join(__dirname, '..', 'app', 'components');
  setupScreenSrc = readFileSync(join(componentsDir, 'ServiceProviderSetupScreen.tsx'), 'utf8');
  manageScreenSrc = readFileSync(join(componentsDir, 'ManageProviderServicesScreen.tsx'), 'utf8');
  publicProfileSrc = readFileSync(join(componentsDir, 'ServiceProviderProfileScreen.tsx'), 'utf8');
  providerServicesLibSrc = readFileSync(join(__dirname, 'providerServices.ts'), 'utf8');
});

describe('routing: Manage Services is reachable and wired in App.tsx', () => {
  it('the screen is imported and routed', () => {
    expect(appSrc).toMatch(/import \{ ManageProviderServicesScreen \} from '\.\/components\/ManageProviderServicesScreen';/);
    expect(appSrc).toMatch(/screen === 'manage-provider-services'/);
  });

  it('ServiceProviderSetupScreen only offers the entry point once a listing exists', () => {
    expect(setupScreenSrc).toMatch(/\{existing && onManageServices && \(/);
  });

  it('the providerId passed through is the LISTING id, not a user id', () => {
    expect(appSrc).toMatch(/onManageServices=\{\(providerId\) => \{/);
    expect(setupScreenSrc).toMatch(/onClick=\{\(\) => onManageServices\(existing\.id\)\}/);
  });
});

describe('public provider profile: shows real priced services, not just tag chips', () => {
  it('fetches active services for the provider being viewed', () => {
    expect(publicProfileSrc).toMatch(/fetchActiveServicesForProvider\(providerId\)/);
  });

  it('renders each service with its own price and currency', () => {
    expect(publicProfileSrc).toMatch(/\{svc\.currency\} \{svc\.price\.toLocaleString\('en-US'\)\}/);
  });

  it('still uses VENTS Chat as the contact CTA -- no phone/WhatsApp primary action added', () => {
    expect(publicProfileSrc).toMatch(/Contact Provider/);
    expect(publicProfileSrc).not.toMatch(/whatsapp|wa\.me|tel:/i);
  });
});

describe('data layer: correct RLS-backed queries, no client-side bypass of ownership', () => {
  it('own-services fetch does not filter by is_active (so a paused service is still editable)', () => {
    const fn = providerServicesLibSrc.match(/export async function fetchOwnServicesForProvider[\s\S]*?\n\}/)?.[0] ?? '';
    expect(fn).not.toMatch(/is_active/);
  });

  it('public-services fetch filters to is_active=true, relying on RLS for the approved-listing check', () => {
    const fn = providerServicesLibSrc.match(/export async function fetchActiveServicesForProvider[\s\S]*?\n\}/)?.[0] ?? '';
    expect(fn).toMatch(/\.eq\('is_active', true\)/);
  });

  it('create/update never send provider ownership fields the RLS policy itself must derive', () => {
    const createFn = providerServicesLibSrc.match(/export async function createProviderService[\s\S]*?\n\}/)?.[0] ?? '';
    expect(createFn).not.toMatch(/user_id/);
  });
});

describe('Manage Services screen: no booking/payment UI introduced', () => {
  it('has no booking or payment-triggering controls', () => {
    expect(manageScreenSrc).not.toMatch(/paystack|openPaystackPopup|book(ing)?Request/i);
  });

  it('active/inactive is a simple toggle, not tied to any payment flow', () => {
    expect(manageScreenSrc).toMatch(/setProviderServiceActive/);
    expect(manageScreenSrc).toMatch(/Deactivate|Activate/);
  });
});
