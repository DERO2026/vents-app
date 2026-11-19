// Event attendance visibility (migration 0221_event_attendance_visibility.sql).
//
// events.show_attendance_count is the organizer's choice of whether the public
// sees how many people are attending. The DATABASE enforces it:
// get_event_ticket_stats returns no row, get_event_ticket_type_availability a
// NULL sold_count and get_event_trending_scores no sales figures for a hidden
// event, to anyone but its organizer and admins. The app only mirrors that
// choice so it never renders a placeholder "0 attending" for a hidden count.

export const ATTENDANCE_SETTING_LABEL = 'Show attendance count publicly';
export const ATTENDANCE_SETTING_DESCRIPTION = 'Choose whether people can see how many attendees your event has.';

/** Default for new events and for rows from before 0221 (no column yet): shown. */
export const DEFAULT_SHOW_ATTENDANCE_COUNT = true;

/** A database event row's setting. Missing/null (pre-0221, or a partial select) means shown. */
export function rowShowsAttendanceCount(row: { show_attendance_count?: boolean | null } | null | undefined): boolean {
  return row?.show_attendance_count !== false;
}

/** May this viewer see an event's attendance count in the app? The organizer and admins always may. */
export function canViewAttendanceCount(
  showAttendanceCount: boolean | undefined,
  viewer: { isEventOwner?: boolean; isAdmin?: boolean },
): boolean {
  return showAttendanceCount !== false || !!viewer.isEventOwner || !!viewer.isAdmin;
}

/**
 * True when a write failed only because the database does not have
 * events.show_attendance_count yet (0221 not applied): PostgREST reports an
 * unknown column as PGRST204, Postgres as 42703.
 */
export function isMissingAttendanceColumnError(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  const mentions = (err.message || '').includes('show_attendance_count');
  return mentions && (err.code === 'PGRST204' || err.code === '42703' || /column/i.test(err.message || ''));
}

/** Shown if an organizer asks to hide the count before the database supports it (0221 not applied). */
export const ATTENDANCE_SETTING_UNAVAILABLE =
  "Hiding the attendance count isn't available yet. Turn \"Show attendance count publicly\" back on to save, or try again later.";
