import { describe, it, expect, beforeEach, vi } from 'vitest';
import { isMissingComingSoonSchemaError, publishErrorMessage, probeComingSoonSupport, markComingSoonUnsupported, resetComingSoonSupportCache, COMING_SOON_UNAVAILABLE } from './comingSoonSupport';

// P0 2026-11-27: production lacks 0224; these pin how "0224 is missing" is recognised.
const MISSING_COL = { code: 'PGRST204', message: "Could not find the 'sales_open_at' column of 'events' in the schema cache" };
const probeClient = (answer: any) => {
  const limit = vi.fn(() => (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)));
  const select = vi.fn(() => ({ limit }));
  return { client: { from: vi.fn(() => ({ select })) }, select, limit };
};

beforeEach(() => resetComingSoonSupportCache());

describe('isMissingComingSoonSchemaError', () => {
  it('recognises the production error and its Postgres / status / function forms', () => {
    expect(isMissingComingSoonSchemaError(MISSING_COL)).toBe(true);
    expect(isMissingComingSoonSchemaError({ code: '42703', message: 'column "sales_open_at" of relation "events" does not exist' })).toBe(true);
    expect(isMissingComingSoonSchemaError({ code: '23514', message: 'new row for relation "events" violates check constraint "events_status_check"' })).toBe(true);
    expect(isMissingComingSoonSchemaError({ code: 'PGRST202', message: 'Could not find the function public.open_event_sales(p_event_id) in the schema cache' })).toBe(true);
  });
  it('does not claim other errors', () => {
    expect(isMissingComingSoonSchemaError({ code: 'PGRST204', message: "Could not find the 'show_attendance_count' column of 'events' in the schema cache" })).toBe(false);
    expect(isMissingComingSoonSchemaError({ code: '23514', message: 'violates check constraint "events_ticket_goal_check"' })).toBe(false);
    expect(isMissingComingSoonSchemaError({ code: '42501', message: 'permission denied' })).toBe(false);
    expect(isMissingComingSoonSchemaError(null)).toBe(false);
    expect(isMissingComingSoonSchemaError(new Error('Failed to fetch'))).toBe(false);
  });
});

describe('publishErrorMessage', () => {
  it('never shows the raw schema message', () => {
    expect(publishErrorMessage(MISSING_COL, 'x')).toBe(COMING_SOON_UNAVAILABLE);
    const other = publishErrorMessage({ code: 'PGRST204', message: "Could not find the 'foo' column of 'events' in the schema cache" }, 'x');
    expect(other).not.toMatch(/schema cache|foo/);
    expect(other).toMatch(/Nothing was published/);
  });
  it('passes ordinary messages through and falls back when empty', () => {
    expect(publishErrorMessage({ message: 'Title is required' }, 'fallback')).toBe('Title is required');
    expect(publishErrorMessage({}, 'fallback')).toBe('fallback');
    expect(COMING_SOON_UNAVAILABLE).toMatch(/not published/);
  });
});

describe('probeComingSoonSupport', () => {
  it('a read of one column, one row; supported when it succeeds; cached', async () => {
    const p = probeClient({ data: [], error: null });
    expect(await probeComingSoonSupport(p.client)).toBe(true);
    expect(p.select).toHaveBeenCalledWith('sales_open_at');
    expect(p.limit).toHaveBeenCalledWith(1);
    expect(await probeComingSoonSupport(p.client)).toBe(true);
    expect(p.client.from).toHaveBeenCalledTimes(1);
  });
  it('unsupported on the missing-column error', async () => {
    expect(await probeComingSoonSupport(probeClient({ data: null, error: MISSING_COL }).client)).toBe(false);
  });
  it('unknown (null, not cached) on a network or unrelated error, so it is asked again', async () => {
    const net = probeClient(new Error('Failed to fetch'));
    expect(await probeComingSoonSupport(net.client)).toBeNull();
    const other = probeClient({ data: null, error: { code: '42501', message: 'permission denied' } });
    expect(await probeComingSoonSupport(other.client)).toBeNull();
    const ok = probeClient({ data: [], error: null });
    expect(await probeComingSoonSupport(ok.client)).toBe(true);
  });
  it('a failed publish marks it unsupported without another request', async () => {
    markComingSoonUnsupported();
    const p = probeClient({ data: [], error: null });
    expect(await probeComingSoonSupport(p.client)).toBe(false);
    expect(p.client.from).not.toHaveBeenCalled();
  });
});
