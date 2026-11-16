import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./supabase', () => ({ supabase: { rpc: vi.fn() } }));
import { resolveHasRealAiAccess, type AiEntitlementRow } from './aiEntitlementClient';

// resolveHasRealAiAccess() decides whether the client treats a VENTS AI
// entitlement as current (the server enforces access on its own; this only
// decides what the screens show). Every date here is relative to a PINNED
// clock, so the results never depend on the day the suite runs.
//
// The rule under test: period_end is "passed" only when it is strictly
// before now; at the exact instant it is still current. After period_end,
// access continues while grace_until is not before now.

const NOW = new Date('2030-03-15T12:00:00.000Z');
const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
const DAY = 24 * 60 * 60 * 1000;

const row = (over: Partial<AiEntitlementRow> = {}): AiEntitlementRow => ({
  plan_id: 'ai_plus', status: 'active', period_end: at(30 * DAY), grace_until: null, ...over,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('active / expired / expiring later', () => {
  it('active, period_end in the future -> access', () => {
    expect(resolveHasRealAiAccess(row({ period_end: at(30 * DAY) }))).toBe(true);
  });
  it('active, period_end in the past, no grace -> no access (even though status still says active)', () => {
    expect(resolveHasRealAiAccess(row({ period_end: at(-DAY) }))).toBe(false);
  });
  it('a subscription expiring later is current now and stops exactly when the clock passes its period_end', () => {
    const r = row({ period_end: at(7 * DAY) });
    expect(resolveHasRealAiAccess(r)).toBe(true);
    vi.setSystemTime(new Date(NOW.getTime() + 7 * DAY - 1));
    expect(resolveHasRealAiAccess(r)).toBe(true);
    vi.setSystemTime(new Date(NOW.getTime() + 7 * DAY + 1));
    expect(resolveHasRealAiAccess(r)).toBe(false);
  });
  it('trialing counts as current until its period_end', () => {
    expect(resolveHasRealAiAccess(row({ status: 'trialing', period_end: at(DAY) }))).toBe(true);
    expect(resolveHasRealAiAccess(row({ status: 'trialing', period_end: at(-DAY) }))).toBe(false);
  });
  it('an open-ended row (no period_end) is current while its status is', () => {
    expect(resolveHasRealAiAccess(row({ period_end: null }))).toBe(true);
  });
});

describe('the expiry boundary (period_end)', () => {
  it('1 ms before period_end -> access', () => {
    expect(resolveHasRealAiAccess(row({ period_end: at(1) }))).toBe(true);
  });
  it('exactly at period_end -> still access (strictly-before comparison)', () => {
    expect(resolveHasRealAiAccess(row({ period_end: at(0) }))).toBe(true);
  });
  it('1 ms after period_end -> no access', () => {
    expect(resolveHasRealAiAccess(row({ period_end: at(-1) }))).toBe(false);
  });
});

describe('grace period (grace_until)', () => {
  it('period_end passed but grace_until in the future -> access', () => {
    expect(resolveHasRealAiAccess(row({ status: 'grace', period_end: at(-DAY), grace_until: at(2 * DAY) }))).toBe(true);
  });
  it('exactly at grace_until -> still access; 1 ms after -> none', () => {
    expect(resolveHasRealAiAccess(row({ status: 'grace', period_end: at(-DAY), grace_until: at(0) }))).toBe(true);
    expect(resolveHasRealAiAccess(row({ status: 'grace', period_end: at(-DAY), grace_until: at(-1) }))).toBe(false);
  });
  it('grace_until also extends an "active" row whose period_end just passed', () => {
    expect(resolveHasRealAiAccess(row({ status: 'active', period_end: at(-1), grace_until: at(DAY) }))).toBe(true);
  });
  it('both period_end and grace_until passed -> no access', () => {
    expect(resolveHasRealAiAccess(row({ status: 'grace', period_end: at(-3 * DAY), grace_until: at(-DAY) }))).toBe(false);
  });
});

describe('status gates win over dates', () => {
  it.each(['expired', 'canceled', 'inactive', 'unknown_status'])('status %s -> no access even with a future period_end', (status) => {
    expect(resolveHasRealAiAccess(row({ status, period_end: at(30 * DAY), grace_until: at(60 * DAY) }))).toBe(false);
  });
  it('no row, or no plan -> no access', () => {
    expect(resolveHasRealAiAccess(null)).toBe(false);
    expect(resolveHasRealAiAccess(row({ plan_id: null }))).toBe(false);
  });
});
