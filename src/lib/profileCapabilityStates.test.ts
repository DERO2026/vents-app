import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression tests for the Profile capability-state-machine audit
// (Service Provider application, Become-an-Organizer, admin/subadmin
// exclusion). See the accompanying report for the full root-cause writeup.
//
// Issue 3 root cause: spRequestStatus collapsed BOTH 'pending' and
// 'approved' DB statuses into a single 'already' bucket, and the CTA's
// onClick did nothing at all (`if (spRequestStatus === 'already') return;`)
// for either -- so an approved applicant saw the exact same dead, greyed
// button as someone still pending review, with no way to open the
// application or continue, until currentUser.is_service_provider happened
// to catch up via App.tsx's separate 15s poll (or a full reload).
//
// Issues 4/5 audit finding: ProfileScreen's Become-an-Organizer and
// Become-a-Service-Provider gating was already correct for every capability
// state (normal user sees them; admin/sub-admin/root see neither and get
// direct privileged access instead) -- no code defect found. Tests below
// lock that correct behavior in against regression.

// The Become-an-Organizer / Become-a-Service-Provider entry points moved
// from Profile into the VENTS Work hub; their state machine is
// workRoles.organizerRole / providerRole, tested here by behavior.
import { organizerRole, providerRole, type ProviderInputs } from './workRoles';

let profileScreenSrc: string;
let hubSrc: string;

beforeAll(() => {
  const components = join(__dirname, '..', 'app', 'components');
  profileScreenSrc = readFileSync(join(components, 'ProfileScreen.tsx'), 'utf8');
  hubSrc = readFileSync(join(components, 'work', 'VentsWorkScreen.tsx'), 'utf8');
});

const sp = (o: Partial<ProviderInputs> = {}): ProviderInputs =>
  ({ isProvider: false, isStaff: false, request: 'none', profileStatus: null, ...o });

describe('Issue 3: approved Service Provider application is never a dead end', () => {
  it('tracks the real DB status (pending vs approved) instead of collapsing both into one bucket', () => {
    expect(providerRole(sp({ request: 'pending' })).action).toBe('provider-verify');
    expect(providerRole(sp({ request: 'approved' })).action).toBe('provider-setup');
  });

  it('an approved request opens setup directly, not only once the possibly-stale is_service_provider poll catches up', () => {
    expect(providerRole(sp({ request: 'approved', isProvider: false })).action).toBe('provider-setup');
  });

  it('the pending-application row is always clickable (opens the application/status view) -- never a no-op click', () => {
    const r = providerRole(sp({ request: 'pending' }));
    expect(r.pill.label).toBe('In review');
    expect(hubSrc).toMatch(/case 'provider-verify': onNavigate\('service-provider-verify'\); break;/);
  });

  it('an approved application routes straight to provider setup, not back into the application-status screen', () => {
    expect(hubSrc).toMatch(/case 'provider-setup': onNavigate\('service-provider-setup'\); break;/);
  });
});

describe('Issues 4 & 5: Become an Organizer / Become a Service Provider capability gating', () => {
  it('a normal user (not organizer/admin/sub-admin) sees "Become an Organizer"', () => {
    expect(organizerRole({ isOrganizer: false, isStaff: false, isVerified: false, request: 'none' }).subtitle).toBe('Become an Organizer');
  });

  it('admin and sub-admin are explicitly excluded from the Become-an-Organizer application CTA', () => {
    expect(organizerRole({ isOrganizer: false, isStaff: true, isVerified: false, request: 'none' }).action).toBe('organizer-studio');
    expect(hubSrc).toMatch(/const isStaff = currentUser\.role === 'admin' \|\| currentUser\.role === 'sub-admin' \|\| currentUser\.id === ROOT_UID;/);
  });

  it('admin/sub-admin/root get direct Service Provider setup access, never the application CTA', () => {
    expect(providerRole(sp({ isStaff: true })).action).toBe('provider-setup');
  });

  it('admin/sub-admin retain direct Admin Dashboard access', () => {
    expect(profileScreenSrc).toMatch(/\{\(isAdmin \|\| isSubAdmin\) && \(/);
    expect(profileScreenSrc).toMatch(/Admin Dashboard/);
  });
});

describe('Issue 7: no duplicate Service Provider application can be created', () => {
  it('admin_decide_service_provider_request / the submit RPC path is guarded server-side against a second pending request', () => {
    const kyc = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0044_service_provider_kyc.sql'), 'utf8');
    expect(kyc).toMatch(/You already have a pending request/);
  });
});
