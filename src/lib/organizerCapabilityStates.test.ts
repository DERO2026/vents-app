import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression tests for the Become-an-Organizer capability state machine.
//
// Root cause traced: ProfileScreen's organizer request status collapsed
// 'pending' and 'approved' into one 'already'/'sent' bucket (mirroring the
// exact same bug already fixed for Service Provider in
// profileCapabilityStates.test.ts), AND relied solely on
// currentUser.role -- refreshed only by App.tsx's separate 15s syncRole
// poll -- to decide whether to hide the CTA. Right after admin approval
// (role flip pending, or organizer_requests row already says 'approved'
// while currentUser.role hasn't synced yet), or for a user whose earlier
// pending/rejected state wasn't cleanly distinguished, the CTA could show
// the wrong thing. Fixed by tracking the real DB status and trusting an
// 'approved' request row immediately via isOrganizerEffective, independent
// of the is_service_provider capability entirely.

let profileScreenSrc: string;

beforeAll(() => {
  profileScreenSrc = readFileSync(join(__dirname, '..', 'app', 'components', 'ProfileScreen.tsx'), 'utf8');
});

describe('Become an Organizer: capability state machine', () => {
  it('a normal user (idle, no request) sees "Become an Organizer"', () => {
    expect(profileScreenSrc).toMatch(/\{!isAdmin && !isSubAdmin && \(\s*\n\s*isOrganizerEffective \? \(/);
    expect(profileScreenSrc).toMatch(/'Application Submitted' : orgRequestStatus === 'rejected' \? 'Apply Again' : 'Become an Organizer'/);
  });

  it('a pending applicant sees an accessible (clickable, non-dead-end) "Application Submitted" state', () => {
    const block = profileScreenSrc.match(/\{!isAdmin && !isSubAdmin && \(\s*\n\s*isOrganizerEffective \? \([\s\S]*?\{\/\* Become Organizer modal/)?.[0] ?? '';
    expect(block).toMatch(/onClick=\{\(\) => setShowOrgRequestModal\(true\)\}/);
    // The old dead-click bug pattern (same class as the SP one).
    expect(block).not.toMatch(/if \(orgRequestStatus === 'already' \|\| orgRequestStatus === 'sent'\) return;/);
    expect(profileScreenSrc).toMatch(/orgRequestStatus === 'pending' \? \(/);
    expect(profileScreenSrc).toMatch(/Your organizer request is under review/);
  });

  it('a rejected applicant can review the admin note and resubmit', () => {
    expect(profileScreenSrc).toMatch(/orgRequestStatus === 'rejected' && orgRequestAdminNote/);
    expect(profileScreenSrc).toMatch(/wasn't approved/);
    expect(profileScreenSrc).toMatch(/onClick=\{submitOrgRequest\}/);
  });

  it('an approved organizer sees organizer access (Wallet), not the application CTA -- trusted immediately via isOrganizerEffective, not only the role-sync poll', () => {
    expect(profileScreenSrc).toMatch(/const isOrganizerEffective = isOrganizer \|\| orgRequestStatus === 'approved';/);
    expect(profileScreenSrc).toMatch(/\{\(isOrganizerEffective \|\| isAdmin \|\| isSubAdmin\) && \(/);
  });

  it('being a Service Provider does not block or hide the Become-an-Organizer capability (independent capabilities)', () => {
    const gate = profileScreenSrc.match(/const isOrganizerEffective = [^\n]+;/)?.[0] ?? '';
    expect(gate).not.toMatch(/is_service_provider/);
    const ctaGate = profileScreenSrc.match(/\{!isAdmin && !isSubAdmin && \(\s*\n\s*isOrganizerEffective \? \(/)?.[0] ?? '';
    expect(ctaGate).not.toMatch(/is_service_provider/);
  });

  it('being an Organizer does not block or hide the Become-a-Service-Provider capability (independent capabilities)', () => {
    const spGate = profileScreenSrc.match(/const canAccessProviderSetup = [^\n]+;/)?.[0] ?? '';
    expect(spGate).not.toMatch(/isOrganizer/);
  });

  it('admin/sub-admin/root never see the Become-an-Organizer application CTA', () => {
    const ctaGate = profileScreenSrc.match(/\{!isAdmin && !isSubAdmin && \(\s*\n\s*isOrganizerEffective \? \(/)?.[0] ?? '';
    expect(ctaGate).toMatch(/!isAdmin && !isSubAdmin/);
  });
});

describe('No duplicate organizer applications', () => {
  it('a partial unique index enforces at most one pending organizer_requests row per user, server-side', () => {
    const migration = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0052_organizer_requests_no_duplicate_pending.sql'), 'utf8');
    expect(migration).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS organizer_requests_one_pending_per_user/);
    expect(migration).toMatch(/ON public\.organizer_requests \(user_id\)/);
    expect(migration).toMatch(/WHERE status = 'pending';/);
  });

  it('the client treats a duplicate-submit race (23505) as "already pending", not a generic error', () => {
    expect(profileScreenSrc).toMatch(/if \(err\?\.code === '23505'\) \{/);
  });
});
