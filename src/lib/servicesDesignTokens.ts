// Reusable design tokens for the VENTS Services experience (Stage 1: tokens
// only, no screens yet). Not new styles -- every value here is lifted
// directly from patterns already in production across ExploreScreen,
// ProfileScreen, EventDetailsScreen, and the Country/State picker screens,
// named once so Services components import from here instead of re-inlining
// the same hex strings a fifth time. Scoped to `services*` naming so this
// file can later be merged into a codebase-wide tokens module without a
// rename, if that's ever undertaken as a separate effort.

export const servicesColors = {
  bg: '#020005',
  cardBg: '#090514',
  cardBgAlt: '#131629',
  border: 'rgba(255,255,255,0.06)',
  borderSelected: 'rgba(168,85,247,0.45)',
  textPrimary: '#F0F0FF',
  textSecondary: '#8B8FA8',
  textTertiary: '#5A5A7A',
  accentPurple: '#A855F7',
  success: '#10B981',
  warning: '#F59E0B',
  error: '#EF4444',
} as const;

export const servicesGradients = {
  // Primary CTA / selected-state gradient, matches Country/State picker CTAs.
  primary: 'linear-gradient(135deg, #7B2FBE, #4F46E5)',
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
  'Events': '#A855F7',
  'Fashion': '#4F46E5',
  'Home Services': '#06D6A0',
};

export const SERVICE_CATEGORIES = [
  'Beauty & Grooming',
  'Events',
  'Fashion',
  'Home Services',
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
