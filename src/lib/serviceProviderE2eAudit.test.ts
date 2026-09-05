import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression tests from the focused end-to-end Services audit (post-0044/
// 0045). Static-analysis style, matching every other *.test.ts in this repo
// -- no live app/DB harness available.
//
// Bug found and fixed in this pass: ServiceProviderVerificationScreen's
// loadLatest() checked `row.status === 'approved'` INSIDE a branch already
// guarded by `row?.status === 'pending' || row?.status === 'rejected'` --
// dead code that could never run. An approved applicant who landed back on
// this screen (e.g. before App.tsx's is_service_provider poll caught up)
// fell through to `setStatus('form')` and saw the KYC submission form again
// instead of being routed to Service Provider setup. Fixed by checking
// 'approved' first and handing off via onApprovedSetup (now actually wired
// at the App.tsx call site, which it previously was not).

let verifyScreenSrc: string;
let appSrc: string;
let profileScreenSrc: string;

beforeAll(() => {
  const componentsDir = join(__dirname, '..', 'app', 'components');
  verifyScreenSrc = readFileSync(join(componentsDir, 'ServiceProviderVerificationScreen.tsx'), 'utf8');
  appSrc = readFileSync(join(__dirname, '..', 'app', 'App.tsx'), 'utf8');
  profileScreenSrc = readFileSync(join(componentsDir, 'ProfileScreen.tsx'), 'utf8');
});

describe('ServiceProviderVerificationScreen: an approved applicant never sees the submission form again', () => {
  it('checks status === "approved" before the pending/rejected branch, not inside it', () => {
    const approvedCheckIdx = verifyScreenSrc.indexOf("row?.status === 'approved'");
    const pendingRejectedCheckIdx = verifyScreenSrc.indexOf("row?.status === 'pending' || row?.status === 'rejected'");
    expect(approvedCheckIdx).toBeGreaterThan(-1);
    expect(pendingRejectedCheckIdx).toBeGreaterThan(-1);
    expect(approvedCheckIdx).toBeLessThan(pendingRejectedCheckIdx);
  });

  it('the approved branch returns before ever reaching setStatus(\'form\')', () => {
    const block = verifyScreenSrc.match(/if \(row\?\.status === 'approved'\) \{[\s\S]*?\n\s{6}\}/)?.[0] ?? '';
    expect(block).toMatch(/onApprovedSetup\(\);/);
    expect(block).toMatch(/return;/);
    expect(block).not.toMatch(/setStatus\('form'\)/);
  });

  it('App.tsx actually wires onApprovedSetup (previously omitted, making the handoff a no-op)', () => {
    const callSite = appSrc.match(/<ServiceProviderVerificationScreen[\s\S]*?\/>/)?.[0] ?? '';
    expect(callSite).toMatch(/onApprovedSetup=\{\(\) => navigateTo\('service-provider-setup'\)\}/);
  });

  it('has a non-form fallback approved state for when no handoff is wired', () => {
    expect(verifyScreenSrc).toMatch(/status === 'approved'/);
    expect(verifyScreenSrc).toMatch(/You're approved/);
  });
});

describe('Admin/Sub-Admin Services access: bypasses capability gate, RLS-protected server-side', () => {
  it('ProfileScreen computes canAccessProviderSetup from role OR capability, not capability alone', () => {
    expect(profileScreenSrc).toMatch(/const canAccessProviderSetup = currentUser\?\.is_service_provider === true \|\| isAdminOrSubAdminForServices;/);
  });

  it('both the setup button and the own-listing fetch gate on canAccessProviderSetup', () => {
    expect(profileScreenSrc).toMatch(/if \(!currentUser\?\.id \|\| !canAccessProviderSetup\)/);
    expect(profileScreenSrc).toMatch(/\{canAccessProviderSetup \? \(/);
  });
});
