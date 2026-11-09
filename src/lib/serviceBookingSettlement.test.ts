import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bookingScheduledStart, bookingDisputeDeadline, BOOKING_DISPUTE_WINDOW_MS } from './bookingSettlement';

const migration = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0203_earnings_policies.sql'), 'utf8');

describe('booking completion and dispute window (0203 mirrors)', () => {
  it('reads scheduled_date/time as Lagos time, like booking_scheduled_start_at', () => {
    expect(bookingScheduledStart('2026-11-05', '18:00:00')?.toISOString()).toBe('2026-11-05T17:00:00.000Z');
    expect(bookingScheduledStart('2026-11-05', null)?.toISOString()).toBe('2026-11-04T23:00:00.000Z');
    expect(bookingScheduledStart(null, '10:00')).toBeNull();
    expect(migration).toMatch(/AT TIME ZONE 'Africa\/Lagos'/);
  });

  it('the dispute window is 48 hours from the later of completion and the scheduled start', () => {
    expect(BOOKING_DISPUTE_WINDOW_MS).toBe(48 * 3600 * 1000);
    expect(migration).toMatch(/FUNCTION public\.booking_dispute_window\(\)[\s\S]*?SELECT interval '48 hours';/);
    const early = bookingDisputeDeadline({ completedAt: '2026-11-01T10:00:00Z', serviceStartFloorAt: '2026-11-03T10:00:00Z' });
    expect(early?.toISOString()).toBe('2026-11-05T10:00:00.000Z');
    expect(bookingDisputeDeadline({ completedAt: null, serviceStartFloorAt: null })).toBeNull();
  });

  it('the database, not the screen, refuses early completion and keeps the start floor', () => {
    expect(migration).toMatch(/A booking cannot be marked complete before its scheduled time/);
    expect(migration).toMatch(/NEW\.service_start_floor_at := GREATEST\(OLD\.service_start_floor_at, v_start\);/);
    expect(migration).toMatch(/v_release := GREATEST\(b\.completed_at, b\.service_start_floor_at\) \+ public\.earnings_release_delay\(\);/);
  });

  it('ticket refunds hold only their own order; an unlinked refund holds the event', () => {
    expect(migration).toMatch(/t\.payment_ref = h\.source_key AND t\.payment_status = 'refund_pending'/);
    expect(migration).toMatch(/'refund_pending_unlinked'/);
    expect(migration).not.toMatch(/WHERE t\.event_id = h\.event_id AND t\.payment_status = 'refund_pending'\)/);
  });
});
