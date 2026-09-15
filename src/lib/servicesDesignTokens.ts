// Reusable design tokens for the VENTS Services experience. Values now
// sourced from the codebase-wide token module (src/lib/ventsDesignTokens.ts,
// the approved VENTS Redesign artifact's §02) rather than a second,
// independently-drifting palette -- this was itself the exact
// "terminology/tokens drift across surfaces" finding (A11) the redesign
// audit flagged. Key NAMES kept unchanged (servicesColors.bg, .cardBg,
// etc.) so none of this module's ~9 consumer files need to change how they
// reference these tokens -- only the values moved.

import { ventsColors } from './ventsDesignTokens';

export const servicesColors = {
  bg: ventsColors.bg,
  cardBg: ventsColors.surface,
  cardBgAlt: ventsColors.elevated,
  border: ventsColors.border,
  borderSelected: 'rgba(142,92,247,0.55)',
  textPrimary: ventsColors.ink1,
  textSecondary: ventsColors.ink2,
  textTertiary: ventsColors.ink3,
  accentPurple: ventsColors.accent,
  success: ventsColors.success,
  warning: ventsColors.pending,
  error: ventsColors.error,
} as const;

export const servicesGradients = {
  // Solid accent fill per the redesign's button spec (no longer a
  // gradient) -- kept as a CSS `background` value either way, so every
  // consumer using `background: servicesGradients.primary` needs no change.
  primary: ventsColors.accent,
  // Reserved for the existing "Become a Service Provider" capability-request
  // card in ProfileScreen -- Services screens should NOT reuse this for
  // their own CTAs, to keep that capability affordance visually distinct.
  serviceProviderCapability: 'linear-gradient(135deg, #0891B2, #22D3EE)',
} as const;

// One accent hue per initial category, drawn from colors already in use
// elsewhere in the app (not new colors) -- the only genuinely new mapping
// in this token set is which hue represents which category.
export const categoryAccents: Record<string, string> = {
  'Beauty & Grooming': '#F107A3',
  'Weddings': '#EC4899',
  'Events': '#A855F7',
  'Photography': '#0EA5E9',
  'Fashion': '#4F46E5',
  'Home Services': '#06D6A0',
  'Catering & Food': '#F59E0B',
  'Entertainment': '#F97316',
  'Decor & Design': '#D946EF',
  'Transportation': '#3B82F6',
};

export const SERVICE_CATEGORIES = [
  'Beauty & Grooming',
  'Weddings',
  'Events',
  'Photography',
  'Fashion',
  'Home Services',
  'Catering & Food',
  'Entertainment',
  'Decor & Design',
  'Transportation',
] as const;

export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number];

export const servicesRadii = {
  sm: 12,
  md: 16,
  lg: 20,
  xl: 26,
  pill: 999,
} as const;

export const servicesSpacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
} as const;

export const servicesTypography = {
  screenTitle: { fontFamily: 'Space Grotesk', fontSize: 26, fontWeight: 800 },
  cardTitle: { fontFamily: 'Inter', fontSize: 14, fontWeight: 700 },
  body: { fontFamily: 'Inter', fontSize: 14, fontWeight: 400, color: servicesColors.textSecondary },
  meta: { fontFamily: 'Inter', fontSize: 12, fontWeight: 500, color: servicesColors.textSecondary },
  eyebrow: {
    fontFamily: 'Inter',
    fontSize: 11,
    fontWeight: 700,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.07em',
  },
} as const;
