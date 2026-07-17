// Capability-based permissions — the single source of truth for "who can do
// what" across organizer-tool surfaces (event creation, event management,
// ticket scanning, door management, promotion, sales analytics).
//
// Root cause this replaces: three call sites (App.tsx's screen nav gate,
// App.tsx's FAB/isOrganizerOrAdmin check, and CreateEventScreen's own guard)
// each hardcoded their own list of allowed role STRINGS, and the lists had
// already drifted out of sync with each other — CreateEventScreen's guard
// was missing 'sub-admin', which existed in the other two lists. Any admin
// tier not spelled out in every single list gets a false "Access Denied",
// and the only way to notice is a support ticket. A capability model fixes
// the class of bug, not just this one instance: every check goes through
// hasCapability(), so a role's permissions are defined in exactly ONE place.

export type Capability =
  | 'create_event'
  | 'manage_events'
  | 'scan_tickets'
  | 'door_management'
  | 'promote_events'
  | 'view_sales_analytics';

// Every organizer-tier role gets the full organizer-tool capability set.
// Attendees get none. Extending a role's access (or adding a new admin tier)
// means editing this map ONCE — never adding another scattered role check.
const ROLE_CAPABILITIES: Record<string, Capability[]> = {
  organizer: ['create_event', 'manage_events', 'scan_tickets', 'door_management', 'promote_events', 'view_sales_analytics'],
  organiser: ['create_event', 'manage_events', 'scan_tickets', 'door_management', 'promote_events', 'view_sales_analytics'],
  admin: ['create_event', 'manage_events', 'scan_tickets', 'door_management', 'promote_events', 'view_sales_analytics'],
  'sub-admin': ['create_event', 'manage_events', 'scan_tickets', 'door_management', 'promote_events', 'view_sales_analytics'],
};

// The platform root account always has every capability, independent of
// whatever role string happens to be on its row.
export const ROOT_UID = 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832';

export interface PermissionUser {
  id?: string | null;
  role?: string | null;
}

export function hasCapability(user: PermissionUser | null | undefined, capability: Capability): boolean {
  if (!user) return false;
  if (user.id === ROOT_UID) return true;
  const caps = ROLE_CAPABILITIES[user.role || ''];
  return !!caps?.includes(capability);
}

// True if the user holds ANY organizer-tool capability — used for coarse
// "is this an organizer-tool user at all" UI decisions (e.g. which bottom-nav
// FAB destination to route to), where a specific capability isn't the point.
export function hasAnyOrganizerCapability(user: PermissionUser | null | undefined): boolean {
  if (!user) return false;
  if (user.id === ROOT_UID) return true;
  return (ROLE_CAPABILITIES[user.role || '']?.length ?? 0) > 0;
}

// Screen → capability map, replacing the old ORGANIZER_ONLY_SCREENS string
// list. Screens not listed here are unrestricted by this module.
export const SCREEN_CAPABILITY: Record<string, Capability> = {
  'create-event': 'create_event',
  'promote-event': 'promote_events',
  'manage-events': 'manage_events',
  'sales-analytics': 'view_sales_analytics',
  'attendee-list': 'manage_events',
  'checkin-scanner': 'scan_tickets',
  'door-manager': 'door_management',
};
