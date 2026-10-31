import { describe, it, expect } from 'vitest';
import { organizerRole, providerRole, representativeRole, claimStateView, formatNaira, toRequestStatus, REWARD_STAGES, isBackendUnavailable } from './workRoles';

// VENTS Work role rows: every state in approved mockup E, for all three roles.

describe('organizer role row', () => {
  const o = (x: Partial<Parameters<typeof organizerRole>[0]> = {}) =>
    organizerRole({ isOrganizer: false, isStaff: false, isVerified: false, request: 'none', ...x });
  it.each([
    [{}, 'Become an Organizer', 'Start', 'off'],
    [{ request: 'pending' as const }, 'Application submitted', 'In review', 'wait'],
    [{ request: 'rejected' as const }, 'Apply again', 'Retry', 'off'],
    [{ isOrganizer: true }, 'Get verified with CAC', 'Active', 'on'],
    [{ isOrganizer: true, isVerified: true }, 'Verified Organizer', 'Verified', 'on'],
  ])('%o -> %s / %s', (input, subtitle, pill, tone) => {
    const r = o(input);
    expect(r.subtitle).toBe(subtitle);
    expect(r.pill).toEqual({ label: pill, tone });
  });
});

describe('organizer role row for staff', () => {
  const o = (x: Partial<Parameters<typeof organizerRole>[0]>) =>
    organizerRole({ isOrganizer: false, isStaff: true, isVerified: false, request: 'none', ...x });
  it('an admin (isOrganizer) opens Creator Studio', () => {
    expect(o({ isOrganizer: true }).action).toBe('organizer-studio');
  });
  it('a sub-admin without the capability gets an inert row, not a dead "Active" one or the application', () => {
    for (const request of ['none', 'pending', 'rejected', 'approved'] as const) {
      const r = o({ request });
      expect(r.action).toBe('none');
      expect(r.pill).toEqual({ label: 'Staff', tone: 'off' });
    }
  });
});

describe('provider role row', () => {
  const p = (x: Partial<Parameters<typeof providerRole>[0]> = {}) =>
    providerRole({ isProvider: false, isStaff: false, request: 'none', profileStatus: null, ...x });
  it('covers start, review, retry, set up, active and paused', () => {
    expect(p().pill.label).toBe('Start');
    expect(p({ request: 'pending' }).pill.label).toBe('In review');
    expect(p({ request: 'rejected' }).pill.label).toBe('Retry');
    expect(p({ isProvider: true }).subtitle).toBe('Set up your service profile');
    expect(p({ isProvider: true, profileStatus: 'approved' }).subtitle).toBe('Manage your services');
    expect(p({ isProvider: true, profileStatus: 'suspended' }).pill.label).toBe('Paused');
  });
});

describe('representative role row', () => {
  it('join, active and paused', () => {
    expect(representativeRole('none').pill.label).toBe('Join');
    expect(representativeRole('active').pill.label).toBe('Active');
    expect(representativeRole('suspended').action).toBe('support');
  });
});

describe('reward claim states', () => {
  const v = (s: Parameters<typeof claimStateView>[0], payoutsEnabled = false, fundingAvailable = false) =>
    claimStateView(s, { payoutsEnabled, fundingAvailable });
  it('maps every server status to a clear earning state', () => {
    expect(v('pending_organizer').label).toBe('Pending');
    expect(v('pending_review').label).toBe('Awaiting approval');
    expect(v('approved').detail).toMatch(/Waiting for VENTS profit/);
    expect(v('approved', false, true).detail).toBe('Ready to claim');
    expect(v('funded').detail).toMatch(/once payouts start, come back and tap Add to earnings wallet/);
    expect(v('funded', true).detail).toMatch(/claim to add it/);
    // Historical: the reward may since have been withdrawn.
    expect(v('funded').label).toBe('Available');
    expect(v('credited').label).toBe('Paid');
    expect(v('credited').detail).toBe('Added to your earnings wallet');
    expect(v('rejected').label).toBe('Rejected');
    expect(v('reversed').label).toBe('Reversed');
  });
});

describe('reward lifecycle', () => {
  it('lists the approved stages in order, each a single server status', () => {
    expect(REWARD_STAGES.map((s) => s.label)).toEqual(['Pending', 'Awaiting approval', 'Approved', 'Available', 'Paid', 'Reversed']);
    expect(new Set(REWARD_STAGES.map((s) => s.status)).size).toBe(REWARD_STAGES.length);
  });
  it('labels match claimStateView for every stage', () => {
    for (const st of REWARD_STAGES) expect(claimStateView(st.status, { payoutsEnabled: true, fundingAvailable: true }).label).toBe(st.label);
  });
});

describe('isBackendUnavailable', () => {
  it('recognises a missing function and the read-only Preview, nothing else', () => {
    expect(isBackendUnavailable({ code: 'PGRST202', message: 'Could not find the function' })).toBe(true);
    expect(isBackendUnavailable({ code: 'PREVIEW_READ_ONLY' })).toBe(true);
    expect(isBackendUnavailable({ message: 'function public.x() does not exist' })).toBe(true);
    expect(isBackendUnavailable({ message: 'Not authenticated' })).toBe(false);
    expect(isBackendUnavailable(null)).toBe(false);
  });
});

describe('helpers', () => {
  it('formats kobo as whole naira', () => {
    expect(formatNaira(5000000)).toBe('₦50,000');
    expect(formatNaira(0)).toBe('₦0');
  });
  it('treats unknown request statuses as none', () => {
    expect(toRequestStatus('weird')).toBe('none');
    expect(toRequestStatus(null)).toBe('none');
  });
});
