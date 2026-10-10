// Reusable design tokens for the VENTS Services experience. Values now
// sourced from the codebase-wide token module (src/lib/ventsDesignTokens.ts,
// the approved VENTS Redesign artifact's §02) rather than a second,
// independently-drifting palette -- this was itself the exact
// "terminology/tokens drift across surfaces" finding (A11) the redesign
// audit flagged. Key NAMES kept unchanged (servicesColors.bg, .cardBg,
// etc.) so none of this module's ~9 consumer files need to change how they
// reference these tokens -- only the values moved.

import { ventsColors, ventsTypography } from './ventsDesignTokens';
import {
  Music, Camera, Scissors, PartyPopper, UtensilsCrossed, Zap, Landmark, Car, Shirt, Shield, Palette, Gift,
} from 'lucide-react';

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

// Approved redesign's 12-category taxonomy (Design Foundation, "V3
// update: Services taxonomy, 12 categories") -- replaces the earlier
// 10-category starting list below. One accent hue per category, drawn
// from colors already in use elsewhere in the app (not new colors).
export const categoryAccents: Record<string, string> = {
  'Entertainment & Talent': '#F97316',
  'Photography & Videography': '#0EA5E9',
  'Beauty & Styling': '#F107A3',
  'Event Planning & Decoration': '#D946EF',
  'Food, Drinks & Catering': '#F59E0B',
  'Event Equipment & Production': '#3B82F6',
  'Venues & Spaces': '#A855F7',
  'Transport & Logistics': '#06D6A0',
  'Fashion & Custom Design': '#4F46E5',
  'Event Support & Professional Services': '#EC4899',
  'Marketing & Creative Services': '#22D3EE',
  'Celebrations & Special Occasions': '#FB7185',
};

export const SERVICE_CATEGORIES = [
  'Entertainment & Talent',
  'Photography & Videography',
  'Beauty & Styling',
  'Event Planning & Decoration',
  'Food, Drinks & Catering',
  'Event Equipment & Production',
  'Venues & Spaces',
  'Transport & Logistics',
  'Fashion & Custom Design',
  'Event Support & Professional Services',
  'Marketing & Creative Services',
  'Celebrations & Special Occasions',
] as const;

export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number];

// Real providers registered under the EARLIER 10-category list still store
// those exact strings in service_providers.category /
// service_provider_categories (free text, no DB enum -- confirmed against
// the live table before writing this). Swapping the taxonomy string
// values must not silently hide them, so every new category also
// resolves the old category name(s) it absorbs -- see
// resolveCategoryAliases() in src/lib/serviceProviders.ts, which every
// category-scoped provider fetch now goes through. This is a pure
// client-side compatibility map: no migration, no backend change, and no
// existing provider needs to re-register to stay visible. "Home Services"
// has no equivalent among the 12 approved categories; its one real use
// (a provider offering home-based services generally) maps closest to
// Event Support & Professional Services.
export const LEGACY_CATEGORY_ALIASES: Record<string, string[]> = {
  'Beauty & Styling': ['Beauty & Grooming'],
  'Event Planning & Decoration': ['Weddings', 'Events', 'Decor & Design'],
  'Photography & Videography': ['Photography'],
  'Fashion & Custom Design': ['Fashion'],
  'Food, Drinks & Catering': ['Catering & Food'],
  'Entertainment & Talent': ['Entertainment'],
  'Transport & Logistics': ['Transportation'],
  'Event Support & Professional Services': ['Home Services'],
};

// One icon per category, shared across the category grid (Services home,
// provider registration) so it's defined in exactly one place instead of
// the 2-3 independently-drifting copies this redesign found.
export const CATEGORY_ICONS: Record<string, React.ElementType> = {
  'Entertainment & Talent': Music,
  'Photography & Videography': Camera,
  'Beauty & Styling': Scissors,
  'Event Planning & Decoration': PartyPopper,
  'Food, Drinks & Catering': UtensilsCrossed,
  'Event Equipment & Production': Zap,
  'Venues & Spaces': Landmark,
  'Transport & Logistics': Car,
  'Fashion & Custom Design': Shirt,
  'Event Support & Professional Services': Shield,
  'Marketing & Creative Services': Palette,
  'Celebrations & Special Occasions': Gift,
};

// Suggested specialty/service-type chips per category (Design Foundation's
// own "V3 update" taxonomy subcategory lists) -- tap-to-add shortcuts into
// the EXISTING services_offered text array during provider registration,
// not a new field. Purely a registration-UI convenience; nothing here is
// validated or enforced server-side.
export const CATEGORY_SPECIALTY_SUGGESTIONS: Record<string, string[]> = {
  'Entertainment & Talent': ['Master of Ceremonies (MC)', 'Host / Presenter', 'DJ', 'Musician', 'Band', 'Comedian', 'Dancer', 'Performer'],
  'Photography & Videography': ['Photographer', 'Videographer', 'Drone operator', 'Livestreaming', 'Content creator'],
  'Beauty & Styling': ['Makeup artist', 'Hairstylist', 'Barber', 'Nail technician', 'Fashion stylist'],
  'Event Planning & Decoration': ['Event planner', 'Decorator', 'Florist', 'Balloon artist', 'Usher', 'Event coordinator'],
  'Food, Drinks & Catering': ['Caterer', 'Private chef', 'Baker', 'Cake designer', 'Bartender', 'Food vendor'],
  'Event Equipment & Production': ['Sound', 'Lighting', 'Staging', 'Screens & LED walls', 'Generators & power', 'Technical crew'],
  'Venues & Spaces': ['Event hall', 'Studio', 'Rooftop', 'Garden', 'Private event space', 'Conference room'],
  'Transport & Logistics': ['Chauffeur', 'Luxury car hire', 'Bus hire', 'Guest shuttle', 'Event logistics'],
  'Fashion & Custom Design': ['Fashion designer', 'Tailor', 'Costume designer', 'Clothing rental'],
  'Event Support & Professional Services': ['Security', 'Bouncer', 'Protocol officer', 'Event staffing', 'Cleaning', 'First aid'],
  'Marketing & Creative Services': ['Promoter', 'Graphic designer', 'Social media manager', 'Printing', 'Signage'],
  'Celebrations & Special Occasions': ['Celebrant', 'Proposal service', 'Surprise setup', 'Personalised gifts', 'Party favours'],
};

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
  screenTitle: { fontFamily: ventsTypography.fontBody, fontSize: 26, fontWeight: 800 },
  cardTitle: { fontFamily: ventsTypography.fontBody, fontSize: 14, fontWeight: 700 },
  body: { fontFamily: ventsTypography.fontBody, fontSize: 14, fontWeight: 400, color: servicesColors.textSecondary },
  meta: { fontFamily: ventsTypography.fontBody, fontSize: 12, fontWeight: 500, color: servicesColors.textSecondary },
  eyebrow: {
    fontFamily: ventsTypography.fontMono,
    fontSize: 11,
    fontWeight: 700,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.07em',
  },
} as const;
