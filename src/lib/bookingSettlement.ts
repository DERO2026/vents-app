// Pure helpers for the 0203 booking rules (no Supabase import, so screens
// and tests can use them freely). The database enforces every rule.

// The booking's scheduled start as an instant. scheduled_date/time carry no
// zone; VENTS reads them as Lagos time (UTC+1, no DST), exactly as
// public.booking_scheduled_start_at does. The database enforces the rule;
// this only decides what the screen offers.
export function bookingScheduledStart(date: string | null, time: string | null): Date | null {
  if (!date) return null;
  const hhmm = (time || '00:00').slice(0, 5);
  const t = new Date(`${date}T${hhmm}:00+01:00`);
  return Number.isNaN(t.getTime()) ? null : t;
}

// Same 48 hours as public.booking_dispute_window(), from the later of
// completion and the scheduled start.
export const BOOKING_DISPUTE_WINDOW_MS = 48 * 60 * 60 * 1000;
export function bookingDisputeDeadline(b: { completedAt?: string | null; serviceStartFloorAt?: string | null }): Date | null {
  if (!b.completedAt) return null;
  const from = Math.max(Date.parse(b.completedAt), b.serviceStartFloorAt ? Date.parse(b.serviceStartFloorAt) : 0);
  return new Date(from + BOOKING_DISPUTE_WINDOW_MS);
}

