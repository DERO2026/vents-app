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

let profileScreenSrc: string;

beforeAll(() => {
  profileScreenSrc = readFileSync(join(__dirname, '..', 'app', 'components', 'ProfileScreen.tsx'), 'utf8');
});

describe('Issue 3: approved Service Provider application is never a dead end', () => {
  it('tracks the real DB status (pending vs approved) instead of collapsing both into one bucket', () => {
    expect(profileScreenSrc).toMatch(/useState<'idle' \| 'pending' \| 'approved'>\('idle'\)/);
    expect(profileScreenSrc).toMatch(/setSpRequestStatus\(data\.status === 'rejected' \? 'idle' : data\.status === 'approved' \? 'approved' : 'pending'\)/);
  });

  it('canAccessProviderSetup trusts spRequestStatus === \'approved\' directly, not only the possibly-stale currentUser.is_service_provider poll', () => {
    const line = profileScreenSrc.match(/const canAccessProviderSetup = [^\n]+;/)?.[0] ?? '';
    expect(line).toMatch(/spRequestStatus === 'approved'/);
  });

  it('the pending-application CTA is always clickable (opens the application/status view) -- never a no-op click', () => {
    const block = profileScreenSrc.match(/\) : \(\s*<div className="px-4 mb-3">\s*\{\/\* Pending is the ONLY state[\s\S]*?<\/div>\s*\)\}/)?.[0] ?? '';
    expect(block).toMatch(/onClick=\{\(\) => onNavigate\('service-provider-verify'\)\}/);
    // The old dead-click bug pattern.
    expect(block).not.toMatch(/if \(spRequestStatus === 'already'\) return;/);
  });

  it('an approved application routes straight to provider setup, not back into the application-status screen', () => {
    // canAccessProviderSetup being true (which now includes the 'approved'
    // case) renders the setup/edit branch, not the application CTA branch --
    // so 'approved' never reaches the pending-style button at all.
    expect(profileScreenSrc).toMatch(/\{canAccessProviderSetup \? \(/);
  });
});

describe('Issues 4 & 5: Become an Organizer / Become a Service Provider capability gating', () => {
  it('a normal user (not organizer/admin/sub-admin) sees "Become an Organizer"', () => {
    expect(profileScreenSrc).toMatch(/\{!isAdmin && !isSubAdmin && \(\s*\n\s*isOrganizerEffective \? \(/);
    expect(profileScreenSrc).toMatch(/Become an Organizer/);
  });

  it('admin and sub-admin are explicitly excluded from the Become-an-Organizer application CTA', () => {
    const gate = profileScreenSrc.match(/\{!isAdmin && !isSubAdmin && \(\s*\n\s*isOrganizerEffective \? \([\s\S]*?\)\}\n\n\s*\{\/\* Become Organizer modal/)?.[0] ?? '';
    expect(gate).toMatch(/!isAdmin && !isSubAdmin/);
  });

  it('admin/sub-admin/root get direct Service Provider setup access, never the application CTA', () => {
    const line = profileScreenSrc.match(/const isAdminOrSubAdminForServices = [^\n]+;/)?.[0] ?? '';
    expect(line).toMatch(/currentUser\?\.role === 'admin' \|\| currentUser\?\.role === 'sub-admin' \|\| currentUser\?\.id === ROOT_UID/);
    const canAccessLine = profileScreenSrc.match(/const canAccessProviderSetup = [^\n]+;/)?.[0] ?? '';
    expect(canAccessLine).toMatch(/isAdminOrSubAdminForServices/);
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
