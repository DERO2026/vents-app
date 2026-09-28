// Palette + shared tokens for the VENTS Admin Console shell.
// Source of truth: design-export/"VENTS Admin Console.dc.html" — values are
// copied verbatim from that export, not reinterpreted. This console is
// intentionally visually distinct from the legacy AdminDashboardScreen
// (which still uses #A855F7 / #090514) per the Batch 1 spec.
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
  | 'wallet'
  | 'payments'
  | 'refunds'
  | 'vcents'
  | 'referrals'
  | 'promotions'
  | 'reports'
  | 'communication'
  | 'analytics'
  | 'adminActions'
  | 'verification'
  | 'system'
  | 'adminManagement'
  | 'auditLogs';

export interface AdminNavItemDef {
  key: AdminConsoleViewKey;
  label: string;
  mono: string;
}

// Mirrors the export's `navDefs` (line ~1168 of the .dc.html), extended with
// the additional nav areas the Batch-1 spec asks for links to (Wallet,
// Payments, Refunds, Audit Logs) which the export folds into "Finance" /
// leaves out of its own mock but the task explicitly lists as top-level.
export const ADMIN_NAV_ITEMS: AdminNavItemDef[] = [
  { key: 'overview', label: 'Dashboard', mono: 'OV' },
  { key: 'users', label: 'Users', mono: 'US' },
  { key: 'events', label: 'Events', mono: 'EV' },
  { key: 'organizers', label: 'Organizers', mono: 'OR' },
  { key: 'providers', label: 'Service Providers', mono: 'SP' },
  { key: 'finance', label: 'Finance', mono: 'FN' },
  { key: 'wallet', label: 'VENTS Wallet', mono: 'WL' },
  { key: 'payments', label: 'Payments', mono: 'PY' },
  { key: 'refunds', label: 'Refunds', mono: 'RF' },
  { key: 'vcents', label: 'VENTS Cents', mono: 'VC' },
  { key: 'referrals', label: 'Referrals', mono: 'RL' },
  { key: 'promotions', label: 'Promotions', mono: 'PR' },
  { key: 'reports', label: 'Reports & Safety', mono: 'RS' },
  { key: 'communication', label: 'Communication', mono: 'CM' },
  { key: 'analytics', label: 'Analytics', mono: 'AN' },
  { key: 'adminActions', label: 'Admin Actions', mono: 'AA' },
  { key: 'verification', label: 'Verification', mono: 'VF' },
  { key: 'system', label: 'System Config', mono: 'SY' },
  { key: 'adminManagement', label: 'Admin Management', mono: 'AM' },
  { key: 'auditLogs', label: 'Audit Logs', mono: 'AL' },
];

// Root-only areas — shown to every admin tier (never silently hidden) but
// visibly locked (dimmed + "ROOT" badge) for non-root admins, matching the
// export's own `lockedKeys` treatment.
export const ROOT_ONLY_KEYS: AdminConsoleViewKey[] = ['system', 'adminManagement'];

// ADMIN+ only area (excluded entirely for sub-admins, per the Batch-1 spec).
export const ADMIN_TIER_ONLY_KEYS: AdminConsoleViewKey[] = ['communication'];

// The export's mobile bottom-tab primary items.
export const MOBILE_PRIMARY_KEYS: AdminConsoleViewKey[] = ['overview', 'users', 'events', 'adminActions'];

export function visibleNavItems(isRoot: boolean, isSuperAdmin: boolean): AdminNavItemDef[] {
  return ADMIN_NAV_ITEMS.filter((item) => {
    if (ADMIN_TIER_ONLY_KEYS.includes(item.key) && !isSuperAdmin) return false;
    return true;
  });
}
