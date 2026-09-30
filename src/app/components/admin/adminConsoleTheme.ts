// Palette + shared tokens for the VENTS Admin Console — now the sole Admin
// Console (AdminDashboardScreen has been fully retired; every function it
// exposed lives here). Source of truth: design-export/
// "VENTS Admin Console.dc.html" — values are copied verbatim from that
// export, not reinterpreted.
export const adminTheme = {
  bg: '#0a0810',
  panelSidebar: '#0d0a15',
  panelTopbar: '#0b0812',
  panel: '#120e1a',
  panelAlt: '#161020',
  border: '#221d2d',
  borderSoft: '#1c1726',
  borderChip: '#2a2438',
  accentFrom: '#a35cff',
  accentTo: '#6d3fb0',
  accentSoftBg: 'rgba(163,92,255,.14)',
  accentSoftBorder: 'rgba(163,92,255,.32)',
  accentText: '#d3b8ff',
  text: '#f2eff6',
  textStrong: '#f5f2f8',
  textMuted: '#a89db3',
  textFaint: '#786d87',
  textFainter: '#5e5470',
  green: '#34d399',
  amber: '#fbbf24',
  blue: '#60a5fa',
  red: '#f87171',
} as const;

export const accentGradient = `linear-gradient(135deg, ${adminTheme.accentFrom}, ${adminTheme.accentTo})`;

export type AdminConsoleViewKey =
  | 'overview'
  | 'users'
  | 'events'
  | 'organizers'
  | 'providers'
  | 'finance'
  | 'vcents'
  | 'reports'
  | 'analytics'
  | 'adminActions'
  | 'verification'
  | 'system'
  | 'auditLogs'
  | 'serviceBookings';

export interface AdminNavItemDef {
  key: AdminConsoleViewKey;
  label: string;
  mono: string;
}

// One nav item per REAL backend feature the legacy AdminDashboardScreen
// exposed -- no placeholder entries. The design export's mock IA had
// separate Wallet/Payments/Refunds/Communication/Referrals/Promotions/Admin
// Management entries; those were removed here because either (a) exactly
// one real feature (Payouts) backs all of Finance/Wallet/Payments/Refunds,
// so splitting them would mean three fake screens pointing at the same
// data, (b) Communication (Global Broadcast) is root-only in production --
// exposing it as a separate Admin+ nav item would widen access beyond what
// has ever been granted, so it stays inside System, or (c) no such feature
// exists anywhere in the codebase to migrate (Referrals, Promotions beyond
// event Featuring which already lives in Events, Admin Management beyond
// the Sub-Admin picker which already lives in Users) -- see the migration's
// reconciliation report for the full accounting.
export const ADMIN_NAV_ITEMS: AdminNavItemDef[] = [
  { key: 'overview', label: 'Dashboard', mono: 'OV' },
  { key: 'users', label: 'Users', mono: 'US' },
  { key: 'events', label: 'Events', mono: 'EV' },
  { key: 'organizers', label: 'Organizers', mono: 'OR' },
  { key: 'providers', label: 'Service Providers', mono: 'SP' },
  { key: 'serviceBookings', label: 'Bookings', mono: 'BK' },
  { key: 'finance', label: 'Payouts', mono: 'FN' },
  { key: 'vcents', label: 'VENTS Cents', mono: 'VC' },
  { key: 'reports', label: 'Reports & Safety', mono: 'RS' },
  { key: 'analytics', label: 'Analytics', mono: 'AN' },
  { key: 'adminActions', label: 'Admin Actions', mono: 'AA' },
  { key: 'verification', label: 'Verification', mono: 'VF' },
  { key: 'auditLogs', label: 'Audit Logs', mono: 'AL' },
  { key: 'system', label: 'System Config', mono: 'SY' },
];

// Root-only areas — shown to every admin tier (never silently hidden) but
// visibly locked (dimmed + "ROOT" badge) for non-root admins, matching the
// export's own `lockedKeys` treatment. System includes Global Broadcast,
// which has always been root-only in production.
export const ROOT_ONLY_KEYS: AdminConsoleViewKey[] = ['system'];

// No areas are currently Admin+-only-but-excluded-for-Sub-Admin at the nav
// level; Sub-Admin restrictions are enforced inside each screen/RPC
// (maker-checker, Super-Admin-gated RPCs) instead.
export const ADMIN_TIER_ONLY_KEYS: AdminConsoleViewKey[] = [];

// The export's mobile bottom-tab primary items.
export const MOBILE_PRIMARY_KEYS: AdminConsoleViewKey[] = ['overview', 'users', 'events', 'adminActions'];

export function visibleNavItems(isRoot: boolean, isSuperAdmin: boolean): AdminNavItemDef[] {
  return ADMIN_NAV_ITEMS.filter((item) => {
    if (ADMIN_TIER_ONLY_KEYS.includes(item.key) && !isSuperAdmin) return false;
    return true;
  });
}
