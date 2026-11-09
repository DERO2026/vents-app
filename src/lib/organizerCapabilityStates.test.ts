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

// The state machine now lives in workRoles.organizerRole (shared by the
// VENTS Work hub and the Profile card chips) and the application form in
// work/OrganizerRequestSheet.tsx; both are tested here by behavior.
import { organizerRole, providerRole, type OrganizerInputs } from './workRoles';

let sheetSrc: string;
let hubSrc: string;
let profileScreenSrc: string;

beforeAll(() => {
  const components = join(__dirname, '..', 'app', 'components');
  sheetSrc = readFileSync(join(components, 'work', 'OrganizerRequestSheet.tsx'), 'utf8');
  hubSrc = readFileSync(join(components, 'work', 'VentsWorkScreen.tsx'), 'utf8');
  profileScreenSrc = readFileSync(join(components, 'ProfileScreen.tsx'), 'utf8');
});

const user = (o: Partial<OrganizerInputs> = {}): OrganizerInputs =>
  ({ isOrganizer: false, isStaff: false, isVerified: false, request: 'none', ...o });

describe('Become an Organizer: capability state machine', () => {
  it('a normal user (idle, no request) sees "Become an Organizer"', () => {
    const r = organizerRole(user());
    expect(r.subtitle).toBe('Become an Organizer');
    expect(r.action).toBe('organizer-apply');
  });

  it('a pending applicant sees an accessible (clickable, non-dead-end) "Application submitted" state', () => {
    const r = organizerRole(user({ request: 'pending' }));
    expect(r.subtitle).toBe('Application submitted');
    expect(r.pill.label).toBe('In review');
    // Still opens the sheet, whose pending view shows the submitted application.
    expect(r.action).toBe('organizer-apply');
    expect(hubSrc).toMatch(/case 'organizer-apply': setShowOrgSheet\(true\); break;/);
    expect(sheetSrc).toMatch(/orgRequestStatus === 'pending' \? \(/);
    expect(sheetSrc).toMatch(/Your organizer request is under review/);
  });

  it('a rejected applicant can review the admin note and resubmit', () => {
    expect(organizerRole(user({ request: 'rejected' })).action).toBe('organizer-apply');
    expect(sheetSrc).toMatch(/orgRequestStatus === 'rejected' && adminNote/);
    expect(sheetSrc).toMatch(/wasn&apos;t approved/);
    expect(sheetSrc).toMatch(/onClick=\{submitOrgRequest\}/);
  });

  it('an approved request is trusted immediately, before the role-sync poll flips isOrganizer', () => {
    const r = organizerRole(user({ request: 'approved', isOrganizer: false }));
    expect(r.pill.tone).toBe('on');
    expect(r.action).not.toBe('organizer-apply');
    // Wallet stays a single universal Profile menu entry.
    expect(profileScreenSrc).toMatch(/screen: 'customer-wallet',/);
  });

  it('being a Service Provider does not change the organizer state (independent capabilities)', () => {
    // organizerRole takes no provider input at all.
    expect(organizerRole(user())).toEqual(organizerRole({ ...user(), ...({ is_service_provider: true } as object) }));
  });

  it('being an Organizer does not change the Service Provider state (independent capabilities)', () => {
    expect(providerRole({ isProvider: false, isStaff: false, request: 'none', profileStatus: null }).action).toBe('provider-verify');
  });

  it('admin/sub-admin/root never see the Become-an-Organizer application CTA', () => {
    for (const request of ['none', 'pending', 'rejected'] as const) {
      expect(organizerRole(user({ isStaff: true, request })).action).not.toBe('organizer-apply');
    }
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
    expect(sheetSrc).toMatch(/if \(err\?\.code === '23505'\) \{/);
  });
});
