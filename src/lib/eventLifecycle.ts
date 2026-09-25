// Single client-side source of truth for "has this event ended", mirroring
// the server's canonical `event_effective_end_at` / `event_is_active` SQL
// functions (supabase/migrations/0051_event_lifecycle_single_source_of_truth.sql)
// EXACTLY. Any discovery surface (Home/Explore/Search/Trending/Featured/
// Related Events) or CTA-gating decision (EventDetailsScreen) must go
// through these helpers instead of re-deriving its own date check — that
// duplication (a different, mostly-wrong check on every screen) was the
// root cause of ended events staying purchasable/discoverable.
//
// Effective-end rule: end_date is authoritative when set (explicit
// multi-day events); otherwise a flat 24h window from event_date. See the
// migration's header comment for the full rationale (start_time/end_time
// are free-text display fields with no guaranteed parseable format, so
// they are deliberately not used here).
//
// The server is still the final authority for purchase eligibility (both
// purchase RPCs re-check this independently) — these helpers exist so the
// client can render the correct UI/discovery state without waiting on a
// round trip, not to replace the server-side guard.

export interface EventLifecycleFields {
  event_date: string;
  end_date?: string | null;
  status?: string | null;
  hidden_by_admin?: boolean | null;
  deleted_at?: string | null;
  archived_at?: string | null;
}

export function eventEffectiveEndAt(eventDate: string, endDate?: string | null): Date {
  if (endDate) return new Date(endDate);
  return new Date(new Date(eventDate).getTime() + 24 * 60 * 60 * 1000);
}

export function hasEventEnded(event: Pick<EventLifecycleFields, 'event_date' | 'end_date'>, now: Date = new Date()): boolean {
  return now >= eventEffectiveEndAt(event.event_date, event.end_date);
}

// Mirrors event_is_active(): the full "currently purchasable/discoverable"
// predicate, folding in status/hidden/deleted alongside the time check.
export function isEventActive(event: EventLifecycleFields, now: Date = new Date()): boolean {
  if (event.deleted_at) return false;
  if (event.hidden_by_admin) return false;
  const status = event.status ?? 'live';
  if (status !== 'live' && status !== 'published') return false;
  return !hasEventEnded(event, now);
}

// Discovery surfaces additionally exclude archived events even for the
// rare case an unarchived-at-query-time row briefly overlaps in a race —
// archived_at is a superset condition of "ended", so this is a no-op for
// any event that already fails isEventActive.
export function isEventDiscoverable(event: EventLifecycleFields, now: Date = new Date()): boolean {
  if (event.archived_at) return false;
  return isEventActive(event, now);
}
