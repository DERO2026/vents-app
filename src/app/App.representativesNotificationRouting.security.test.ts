import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Bug: VENTS Earn notifications (invite_recruiter_partnership's invitation
// and respond_to_recruiter_invitation's reply, 0197) carry push_data
// { partnershipId, recruiterId?, commissionSplitBps? } -- no eventId,
// userId, screen or any other key the shared notification router handled,
// so tapping one (in-app or as a native push) did nothing.
//
// Fix: pushActionRef.current (the one router both NotificationsScreen taps
// and native push taps go through) routes partnershipId to the existing
// Representatives screen with a { partnershipId, nonce } focus prop, which
// RepresentativesScreen resolves to the Invitations or My Team tab (covered
// by RepresentativesScreen.test.tsx).
//
// No React-render test harness exists for App.tsx, so this locks in the
// wiring statically, same convention as App.chatNavDefaultTab.security.test.ts.

let src: string;
let router: string;

beforeAll(() => {
  src = readFileSync(join(__dirname, 'App.tsx'), 'utf8');
  const start = src.indexOf('pushActionRef.current = (data: Record<string, any>) => {');
  const end = src.indexOf('const routeNotification = useCallback(', start);
  router = src.slice(start, end);
});

describe('partnership notifications route to Representatives', () => {
  it('the shared router has a partnershipId branch that opens the representatives screen with a focus', () => {
    expect(router.length).toBeGreaterThan(0);
    const branch = router.match(/if \(data\.partnershipId\) \{([\s\S]*?)\n    \}/)?.[1] ?? '';
    expect(branch).toMatch(/setRepresentativesFocus\(\{ partnershipId: data\.partnershipId, nonce: Date\.now\(\) \}\);/);
    expect(branch).toMatch(/setScreenStack\(\[\]\);/);
    expect(branch).toMatch(/setScreen\('representatives'\);/);
    expect(branch).toMatch(/return;/);
  });

  it('runs before the generic eventId/userId branches, so recruiterId is never treated as a profile link', () => {
    const partnership = router.indexOf('if (data.partnershipId)');
    const eventId = router.indexOf('if (data.eventId)');
    const userId = router.indexOf('if (data.userId)');
    expect(partnership).toBeGreaterThan(-1);
    expect(eventId).toBeGreaterThan(-1);
    expect(userId).toBeGreaterThan(-1);
    expect(partnership).toBeLessThan(eventId);
    expect(partnership).toBeLessThan(userId);
  });

  it('RepresentativesScreen receives the focus, and the focus is cleared when the user leaves the screen', () => {
    expect(src).toMatch(/<RepresentativesScreen onBack=\{goBack\} currentUser=\{currentUser\} focusPartnership=\{representativesFocus\} onOpenRewards=\{\(\) => navigateTo\('representative-rewards'\)\} \/>/);
    expect(src).toMatch(/if \(screen !== 'representatives'\) setRepresentativesFocus\(null\);/);
  });
});
