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

  it('D1a: a legacy pending or rejected request is not a review state -- the same one-step "Become an Organizer"', () => {
    for (const request of ['pending', 'rejected'] as const) {
      const r = organizerRole(user({ request }));
      expect(r.subtitle).toBe('Become an Organizer');
      expect(r.action).toBe('organizer-apply');
    }
    expect(hubSrc).toMatch(/case 'organizer-apply': setShowOrgSheet\(true\); break;/);
    expect(sheetSrc).not.toMatch(/under review|1–3 business days|wasn&apos;t approved/);
    expect(sheetSrc).toMatch(/onClick=\{becomeOrganizer\}/);
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

describe('D1a: becoming an organizer is self-selection, nothing else', () => {
  it('the sheet only calls set_signup_role(organizer), the same call sign-up makes, and writes no table', () => {
    expect(sheetSrc).toMatch(/supabase\.rpc\('set_signup_role' as any, \{ p_role: 'organizer' \}\)/);
    const code = sheetSrc.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(code).not.toMatch(/organizer_requests|promote_to_organizer|\.insert\(|\.update\(/);
  });
  it('set_signup_role (0121) only sets the caller\'s own is_organizer flag and refuses admins', () => {
    const m = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0121_organizer_capability_independent_of_role.sql'), 'utf8');
    const fn = m.slice(m.indexOf('CREATE OR REPLACE FUNCTION public.set_signup_role'), m.indexOf('$function$;', m.indexOf('CREATE OR REPLACE FUNCTION public.set_signup_role')));
    expect(fn).toContain('UPDATE public.users SET is_organizer = true WHERE id = v_id;');
    expect(fn).toContain("RAISE EXCEPTION 'Admin role cannot be changed';");
    expect(fn).not.toMatch(/SET role|is_verified/);
  });
});
